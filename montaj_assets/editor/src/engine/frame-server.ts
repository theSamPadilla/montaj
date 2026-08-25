/**
 * SP4 T3 — the frame server: main-side decode-ahead orchestration.
 *
 * Owns the decode worker's whole lifecycle (spawn from the inlined source
 * string via a Blob URL, the postMessage protocol below, and — critically —
 * `VideoFrame` ownership on every path) and drives it with the pure decisions
 * `batch-planner.ts` makes. One frame server serves exactly ONE demuxed source:
 * a clip-boundary swap terminates it and spawns another, which is the spike's
 * "never reconfigure a live decoder" rule (`player.ts`'s `load`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE DEMUX HAPPENS — and why
 * ─────────────────────────────────────────────────────────────────────────
 * **Main side**, exactly as the spike did it (`player.ts` calls `demux(url)`
 * and posts sample slices to the worker). It is also the only option here: the
 * worker ships as a source *string*, so it cannot `import` `demux.ts` or
 * `mp4box` — a worker-side demux would mean either bundling mp4box into the
 * string (which would blow up the "small enough for line review" constraint
 * decision 6 rests on) or a second, separately-loaded worker. T2 made
 * `demuxBytes` synchronous and worker-callable so that option stays open for a
 * later ranged-loading design; it is deliberately not exercised in v1.
 *
 * Consequence: sample bytes cross the boundary once per batch, by **structured
 * clone, never transfer**. mp4box allocates a dedicated `Uint8Array` per
 * sample (`ISOFile.getSample`: `sample.data = new Uint8Array(sample.size)`,
 * then a memcpy into it), so a clone copies exactly that sample's bytes — not
 * the whole file — while transferring would detach the buffer out of the
 * demuxed sample table and corrupt every later request that overlaps the same
 * GOP. Frames come back the other way *with* a transfer list, because a
 * `VideoFrame` must not be cloned.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FRAME OWNERSHIP (the leak contract)
 * ─────────────────────────────────────────────────────────────────────────
 * Every `VideoFrame` that reaches main is closed exactly once, by this module,
 * with one exception: the frame handed out by `seek()` or `nextFrameFor()`
 * becomes the CALLER's to close (T5 paints it via `drawImage` and closes it —
 * holding a reference past that point is what exhausts the decoder's surface
 * pool). Everything else — stale frames from a superseded request, frames
 * skipped because a newer one is already due, whatever is still buffered at
 * `stopStream()`/`dispose()` — is closed here.
 */
import {
  DEFAULT_DECODE_AHEAD_FRAMES,
  MAX_IN_FLIGHT_BATCHES,
  PRE_ROLL_EPSILON_US,
  isSuperseded,
  onFrameBuffered,
  onFramesConsumed,
  planNextBatches,
  planSeek,
  planStreamStart,
  reconcileOnBatchDone,
  type PipelineConfig,
  type PipelineState,
} from './batch-planner'
import { decodeWorkerSource } from './decode-worker-source'
import type { ChunkSource, DemuxedSource, SampleRef } from './demux'

/**
 * WebCodecs' `hardwareAcceleration` hint. The spike exposed only the two
 * extremes because Task 5 existed to compare them; production defaults to
 * `no-preference` (let the browser decide) — SP1 §6 measured the AV1 proxy
 * holding 30fps even under forced software decode, so there is nothing to win
 * by pinning it.
 */
export type HardwarePref = 'prefer-hardware' | 'prefer-software' | 'no-preference'

/**
 * One sample as the worker sees it. Deliberately narrower than T2's
 * `SampleRef`: `dtsUs` is dropped because `EncodedVideoChunk.timestamp` is a
 * *presentation* time (decode order is carried by the ORDER of the array, not
 * by a field), and shipping it would just be bytes on the wire.
 */
export interface WorkerSample {
  tsUs: number
  durUs: number
  isKey: boolean
  data: Uint8Array
}

/** main → worker. */
export type DecodeCmd =
  | {
      t: 'init'
      codec: string
      description?: Uint8Array
      hardwareAcceleration: HardwarePref
      /** SP1 §7.2's epsilon, owned by `batch-planner.ts` and injected so the worker string holds no planning constants. */
      preRollEpsilonUs: number
    }
  | { t: 'decodeRange'; samples: WorkerSample[]; targetTsUs: number; reqId: number }

/** worker → main. `frame` carries a transferred `VideoFrame`. */
export type DecodeEvt =
  | { t: 'frame'; frame: VideoFrame; reqId: number }
  | { t: 'done'; reqId: number; decoded: number; dropped: number }
  | { t: 'error'; message: string; reqId?: number }

/**
 * The slice of `Worker` this module uses. Injectable (`spawnWorker`) so tests
 * drive a fake port — jsdom has neither `Worker` nor `URL.createObjectURL`,
 * and there is no WebCodecs to decode with even if it did.
 */
export interface DecodeWorkerPort {
  postMessage(msg: DecodeCmd): void
  terminate(): void
  onmessage: ((ev: { data: DecodeEvt }) => void) | null
}

export interface FrameServerOptions {
  /** The single source this server decodes. There is no other input and no fallback path — proxy-only playback (SP1 requirement 4) is a structural property, not a runtime check. */
  source: DemuxedSource
  hardwareAcceleration?: HardwarePref
  /** Decode-ahead budget in frames (N). Also settable at runtime via the returned server. */
  decodeAheadFrames?: number
  /** Decoder/worker errors. T5 routes these to the same per-clip "Preparing preview…" state as a missing proxy — the engine never reverts the whole project to the legacy player. */
  onError?: (message: string) => void
  spawnWorker?: () => DecodeWorkerPort
}

export interface FrameServerStats {
  buffered: number
  inFlightFrames: number
  inFlightBatches: number
  /** Frames delivered to main since construction (buffered or handed to a seek). */
  received: number
  /** Frames closed here rather than handed out: superseded, or skipped as already-late. */
  dropped: number
  /** Every sample has been requested — nothing left to ask the worker for. */
  atEndOfSource: boolean
  /** At end of source with nothing buffered and nothing in flight: the stream is finished. */
  drained: boolean
  lastError: string | null
}

export interface FrameServer {
  /** The `src` this server decodes — the proxy path the caller demuxed. */
  readonly src: string
  readonly video: ChunkSource
  /** Runtime-settable N (SP1 §8's sweep knob; T7's HUD reads it back through `stats()`). */
  decodeAheadFrames: number
  /**
   * One-shot frame-accurate seek. `targetTsUs` is RAW CONTAINER time — the
   * caller maps project time through `video.firstPresentationTsUs`.
   *
   * `reqId` comes back synchronously so a caller can key latency
   * instrumentation to this exact seek before any round trip. `frame` always
   * settles (the worker's total `done` contract), with `null` when the seek
   * was superseded, produced nothing, or the source is empty. **The resolved
   * frame belongs to the caller** — close it after painting.
   *
   * Stops any streaming session first: the worker serves one intent at a time,
   * and buffered playback frames are worthless once the playhead jumps.
   */
  seek(targetTsUs: number): { reqId: number; frame: Promise<VideoFrame | null> }
  /**
   * Open a streaming decode-ahead session at `targetTsUs` (raw container
   * time). Returns the session's `reqId`. Frames land in the internal buffer;
   * the scheduler pulls them with `nextFrameFor`.
   */
  startStream(targetTsUs: number): number
  /** Close the session and every frame still buffered. Safe to call when nothing is streaming. */
  stopStream(): void
  /**
   * The frame due at `clockUs` (raw container time): the LATEST buffered frame
   * whose timestamp is at or before the clock, or `null` when nothing is due
   * yet. Any buffered frame older than the one returned became due and was
   * overtaken before this call — those are closed here and reported as
   * `dropped`, never leaked. Tops the pipeline up on every call, so the
   * scheduler's tick needs no separate pump. **The returned frame belongs to
   * the caller.**
   */
  nextFrameFor(clockUs: number): { frame: VideoFrame | null; dropped: number }
  stats(): FrameServerStats
  /** Terminate the worker, settle anything pending, close every frame still held. */
  dispose(): void
}

/** Default spawn: inline source → Blob URL → classic `Worker`, per plan decision 6. */
function spawnBlobWorker(): DecodeWorkerPort {
  const url = URL.createObjectURL(new Blob([decodeWorkerSource], { type: 'text/javascript' }))
  const worker = new Worker(url)
  // Safe immediately: the worker has already been handed the URL, and holding
  // it would leak the blob for the page's lifetime.
  URL.revokeObjectURL(url)
  // The port is structurally narrower than `Worker` (a typed `onmessage`, no
  // transfer list on `postMessage` — this module never transfers TO the
  // worker, see the module doc). One honest cast rather than a wrapper object.
  return worker as unknown as DecodeWorkerPort
}

/** Insertion point that keeps the buffer ascending by timestamp. */
function insertByTimestamp(buffer: VideoFrame[], frame: VideoFrame): void {
  let i = buffer.length
  while (i > 0 && buffer[i - 1].timestamp > frame.timestamp) i--
  buffer.splice(i, 0, frame)
}

interface PendingSeek {
  targetTsUs: number
  /** Best candidate so far: the latest frame at-or-before the target. */
  best: VideoFrame | null
  superseded: boolean
  resolve: (frame: VideoFrame | null) => void
}

class FrameServerImpl implements FrameServer {
  readonly src: string
  readonly video: ChunkSource
  decodeAheadFrames: number

  private readonly worker: DecodeWorkerPort
  private readonly onError?: (message: string) => void

  private nextReqId = 0
  private latestReqId = -1

  private readonly pendingSeeks = new Map<number, PendingSeek>()

  private streaming = false
  private streamReqId = -1
  private pipeline: PipelineState = {
    nextSampleIdx: 0,
    buffered: 0,
    inFlightFrames: 0,
    inFlightBatches: 0,
    firstBatchTargetTsUs: 0,
  }
  /**
   * FIFO of per-batch expected frame counts. Pre-roll frames are dropped in the
   * worker and never arrive, so `inFlightFrames` is reconciled against this on
   * every `done` — without it the count drifts upward and permanently eats
   * decode-ahead capacity (SP1 §6.1).
   */
  private batchExpected: number[] = []
  /** Decoded, undelivered frames, ascending by timestamp. */
  private frameBuffer: VideoFrame[] = []
  /**
   * Serializes posts behind a ranged source's byte fetches. Idle (depth 0)
   * whenever nothing is waiting on bytes, which is when `postBatch` skips it
   * entirely and posts synchronously — see `postBatch`.
   */
  private postQueue: Promise<void> = Promise.resolve()
  private postDepth = 0
  /**
   * Which post chain is live. Bumped by `claimReqId`, i.e. every time
   * everything older is superseded: a scrub landing mid-fetch must not queue
   * behind the fetch it just made pointless, or the new frame would arrive no
   * sooner than the abandoned one would have. Steps from a retired generation
   * still run — they just settle their seek and return without posting.
   */
  private postGen = 0

  private received = 0
  private dropped = 0
  private lastError: string | null = null
  private disposed = false

  constructor(options: FrameServerOptions) {
    this.src = options.source.src
    this.video = options.source.video
    this.decodeAheadFrames = options.decodeAheadFrames ?? DEFAULT_DECODE_AHEAD_FRAMES
    this.onError = options.onError

    this.worker = (options.spawnWorker ?? spawnBlobWorker)()
    this.worker.onmessage = (ev) => this.onMessage(ev.data)
    this.worker.postMessage({
      t: 'init',
      // Verbatim from the container — normalization is not this layer's job,
      // and for video there is nothing to normalize (T2's note about `'Opus'`
      // vs `'opus'` is an AUDIO-side hazard, T4's).
      codec: this.video.codec,
      description: this.video.description,
      hardwareAcceleration: options.hardwareAcceleration ?? 'no-preference',
      preRollEpsilonUs: PRE_ROLL_EPSILON_US,
    })
  }

  private get config(): PipelineConfig {
    return {
      decodeAheadFrames: this.decodeAheadFrames,
      maxInFlightBatches: MAX_IN_FLIGHT_BATCHES,
    }
  }

  /**
   * Claim a new request id, superseding everything older. Any pending seek
   * left behind is settled here (with its held frame closed) rather than
   * waiting for its `done` — the caller asked for something else, so its
   * answer can only be `null`.
   */
  private claimReqId(): number {
    const reqId = this.nextReqId++
    this.latestReqId = reqId
    this.retirePostQueue()
    for (const [id, pending] of this.pendingSeeks) {
      if (isSuperseded(id, this.latestReqId) && !pending.superseded) {
        pending.superseded = true
        if (pending.best) {
          pending.best.close()
          pending.best = null
          this.dropped++
        }
      }
    }
    return reqId
  }

  seek(targetTsUs: number): { reqId: number; frame: Promise<VideoFrame | null> } {
    this.stopStream()
    const reqId = this.claimReqId()
    const batch = planSeek(this.video, targetTsUs)

    let resolveFrame: (frame: VideoFrame | null) => void = () => {}
    const frame = new Promise<VideoFrame | null>((resolve) => {
      resolveFrame = resolve
    })

    if (!batch || this.disposed) {
      resolveFrame(null)
      return { reqId, frame }
    }

    this.pendingSeeks.set(reqId, {
      targetTsUs: batch.targetTsUs,
      best: null,
      superseded: false,
      resolve: resolveFrame,
    })
    this.postBatch(batch.startIdx, batch.endIdx, batch.targetTsUs, reqId)
    return { reqId, frame }
  }

  startStream(targetTsUs: number): number {
    this.stopStream()
    if (this.disposed) return -1
    this.streamReqId = this.claimReqId()
    this.streaming = true
    this.pipeline = planStreamStart(this.video, targetTsUs)
    this.batchExpected = []
    this.pump()
    return this.streamReqId
  }

  stopStream(): void {
    for (const frame of this.frameBuffer) frame.close()
    this.dropped += this.frameBuffer.length
    this.frameBuffer = []
    this.batchExpected = []
    this.pipeline = { ...this.pipeline, buffered: 0, inFlightFrames: 0, inFlightBatches: 0 }
    if (!this.streaming) return
    this.streaming = false
    // Burn a request id so straggling frames from the session just retired are
    // recognized as stale by `onMessage` and closed rather than buffered.
    this.claimReqId()
  }

  nextFrameFor(clockUs: number): { frame: VideoFrame | null; dropped: number } {
    let dueIdx = -1
    for (let i = 0; i < this.frameBuffer.length; i++) {
      if (this.frameBuffer[i].timestamp <= clockUs) dueIdx = i
      else break
    }

    if (dueIdx < 0) {
      // Nothing due: hold what's on screen, close nothing, but keep the
      // pipeline fed (a starving buffer is exactly when a top-up matters).
      this.pump()
      return { frame: null, dropped: 0 }
    }

    // Everything before the due frame became due and was overtaken before this
    // call — a drop, counted and closed, never silent loss.
    let droppedNow = 0
    for (let i = 0; i < dueIdx; i++) {
      this.frameBuffer[i].close()
      droppedNow++
    }
    const frame = this.frameBuffer[dueIdx]
    this.frameBuffer.splice(0, dueIdx + 1)
    this.dropped += droppedNow
    this.pipeline = onFramesConsumed(this.pipeline, droppedNow + 1)
    this.pump()
    return { frame, dropped: droppedNow }
  }

  stats(): FrameServerStats {
    const atEndOfSource = this.pipeline.nextSampleIdx >= this.video.samples.length
    return {
      buffered: this.frameBuffer.length,
      inFlightFrames: this.pipeline.inFlightFrames,
      inFlightBatches: this.pipeline.inFlightBatches,
      received: this.received,
      dropped: this.dropped,
      atEndOfSource,
      drained:
        atEndOfSource && this.frameBuffer.length === 0 && this.pipeline.inFlightBatches === 0,
      lastError: this.lastError,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopStream()
    for (const [, pending] of this.pendingSeeks) {
      if (pending.best) pending.best.close()
      pending.resolve(null)
    }
    this.pendingSeeks.clear()
    this.worker.onmessage = null
    this.worker.terminate()
  }

  // ── worker protocol ──────────────────────────────────────────────────────

  /**
   * Post one decode range. Samples are sliced out of the demuxed table in
   * DECODE order and mapped to the wire shape; no transfer list, on purpose —
   * see the module doc.
   *
   * ── Ranged sources ──
   * A ranged source (`demux.ts`) has the sample INDEX but not necessarily the
   * sample BYTES, so the range has to be `ensure`d first. `ensure` returns
   * `null` when the bytes are already there — which is always, on the
   * whole-file path, and usually, mid-stream — so the common case stays exactly
   * as synchronous as it was before ranged loading existed. That matters: a
   * seek that had to hop a microtask would be a seek that paints a frame late.
   *
   * When a fetch IS needed, every subsequent post queues behind it. Not an
   * optimization detail — `VideoDecoder` takes chunks in DECODE order and
   * throws on the first one out of sequence, so a later batch overtaking an
   * earlier one that is still fetching would kill the decoder for the rest of
   * the session (SP1 §7.1, from the other direction).
   */
  private postBatch(startIdx: number, endIdx: number, targetTsUs: number, reqId: number): void {
    if (this.postDepth === 0) {
      const pending = this.video.ensure?.(startIdx, endIdx)
      if (!pending) {
        this.sendBatch(startIdx, endIdx, targetTsUs, reqId)
        return
      }
      this.queuePost(pending, startIdx, endIdx, targetTsUs, reqId)
      return
    }
    this.queuePost(null, startIdx, endIdx, targetTsUs, reqId)
  }

  /** Chain a post behind whatever byte fetches are already queued. */
  private queuePost(
    started: Promise<void> | null,
    startIdx: number,
    endIdx: number,
    targetTsUs: number,
    reqId: number,
  ): void {
    const gen = this.postGen
    this.postDepth++
    this.postQueue = this.postQueue
      .then(async () => {
        if (this.disposed) return
        // A batch whose request was superseded while its bytes were in flight
        // has nothing to answer, so it is not sent: decoding it would only
        // produce frames `onFrameEvt` closes as stale. Its seek still has to be
        // settled here — `claimReqId` marks a superseded seek and closes the
        // frame it was holding, but the `null` normally arrives with the
        // worker's `done`, which is never coming for a batch that never went.
        if (this.retired(gen, reqId)) return
        await (started ?? this.video.ensure?.(startIdx, endIdx))
        if (this.disposed || this.retired(gen, reqId)) return
        this.sendBatch(startIdx, endIdx, targetTsUs, reqId)
      })
      .catch((err: unknown) => {
        this.failPost(reqId, err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (gen === this.postGen) this.postDepth--
      })
  }

  /** Superseded or from a retired chain: settle the seek and post nothing. */
  private retired(gen: number, reqId: number): boolean {
    if (gen === this.postGen && !isSuperseded(reqId, this.latestReqId)) return false
    this.dropSeek(reqId)
    return true
  }

  /**
   * Retire the current post chain so the next post starts from an empty queue.
   *
   * Called from `claimReqId`, where everything older has just been superseded
   * by definition — so nothing still queued can be wanted, and making the new
   * request wait behind an abandoned fetch would hand back exactly the latency
   * ranged loading exists to remove. No-op when nothing is queued, which is the
   * normal case and keeps `postBatch`'s synchronous path intact.
   */
  private retirePostQueue(): void {
    if (this.postDepth === 0) return
    this.postGen++
    this.postQueue = Promise.resolve()
    this.postDepth = 0
  }

  /** Settle a seek with `null` and release the frame it was holding. */
  private dropSeek(reqId: number): void {
    const pending = this.pendingSeeks.get(reqId)
    if (!pending) return
    this.pendingSeeks.delete(reqId)
    if (pending.best) {
      pending.best.close()
      this.dropped++
    }
    pending.resolve(null)
  }

  private sendBatch(startIdx: number, endIdx: number, targetTsUs: number, reqId: number): void {
    const samples: WorkerSample[] = []
    for (let i = startIdx; i < endIdx; i++) {
      const s: SampleRef = this.video.samples[i]
      samples.push({ tsUs: s.tsUs, durUs: s.durUs, isKey: s.isKey, data: s.data })
    }
    this.worker.postMessage({ t: 'decodeRange', samples, targetTsUs, reqId })
  }

  /**
   * A batch's bytes could not be fetched.
   *
   * Reported through the same `onError` a decode failure uses, so `index.ts`
   * fails the session and the clip lands on the Preparing placeholder with a
   * reason — the same outcome a proxy that never loaded produces. A seek
   * waiting on this batch is settled with `null` first: its frame promise is
   * contractually total, and leaving it pending would hang the scrub rather
   * than showing the failure.
   */
  private failPost(reqId: number, message: string): void {
    if (this.disposed) return
    this.lastError = message
    this.dropSeek(reqId)
    this.onError?.(message)
  }

  /** Top up decode-ahead from the planner's decisions. */
  private pump(): void {
    if (!this.streaming || this.disposed) return
    const { batches, state } = planNextBatches(this.video, this.pipeline, this.config)
    this.pipeline = state
    for (const batch of batches) {
      this.batchExpected.push(batch.count)
      this.postBatch(batch.startIdx, batch.endIdx, batch.targetTsUs, this.streamReqId)
    }
  }

  private onMessage(evt: DecodeEvt): void {
    if (this.disposed) {
      if (evt.t === 'frame') evt.frame.close()
      return
    }
    if (evt.t === 'error') {
      this.lastError = evt.message
      this.onError?.(evt.message)
      return
    }
    if (evt.t === 'frame') {
      this.onFrameEvt(evt.frame, evt.reqId)
      return
    }
    this.onDoneEvt(evt.reqId, evt.decoded)
  }

  private onFrameEvt(frame: VideoFrame, reqId: number): void {
    // Belt-and-suspenders for the worker's own supersession check: a frame can
    // already have been transferred when the newer request went out.
    if (isSuperseded(reqId, this.latestReqId)) {
      frame.close()
      this.dropped++
      return
    }
    this.received++

    if (this.streaming && reqId === this.streamReqId) {
      // Kept sorted rather than appended: VideoDecoder emits in PRESENTATION
      // order, which equals arrival order only for all-intra sources like
      // SP3's proxies. The spike appended and documented the assumption; one
      // insertion into a ≤N buffer costs nothing and removes it.
      insertByTimestamp(this.frameBuffer, frame)
      this.pipeline = onFrameBuffered(this.pipeline)
      return
    }

    const pending = this.pendingSeeks.get(reqId)
    if (!pending) {
      frame.close()
      this.dropped++
      return
    }
    // Keep the EARLIEST arriving frame and close the rest. The worker has
    // already dropped everything below `target - epsilon` as pre-roll, so the
    // lowest timestamp that survives is the requested frame itself; anything
    // later is a B-frame that precedes the target in DECODE order and follows
    // it in presentation order. The spike painted whatever arrived last, which
    // on a reordered source is the wrong frame — invisible on SP3's all-intra
    // proxies, so it is fixed here rather than left to be discovered later.
    if (!pending.best || frame.timestamp < pending.best.timestamp) {
      if (pending.best) {
        pending.best.close()
        this.dropped++
      }
      pending.best = frame
      return
    }
    frame.close()
    this.dropped++
  }

  private onDoneEvt(reqId: number, decoded: number): void {
    if (this.streaming && reqId === this.streamReqId) {
      const expected = this.batchExpected.shift() ?? 0
      this.pipeline = reconcileOnBatchDone(this.pipeline, expected, decoded)
      this.pump()
      return
    }
    const pending = this.pendingSeeks.get(reqId)
    if (!pending) return
    this.pendingSeeks.delete(reqId)
    const frame = pending.superseded ? null : pending.best
    if (pending.superseded && pending.best) {
      pending.best.close()
      this.dropped++
    }
    pending.resolve(frame)
  }
}

/**
 * Create a frame server for one demuxed source.
 *
 * T5 consumes this surface: `seek` for scrubbing, `startStream`/`nextFrameFor`
 * for the playback tick, `stats` for end-of-clip detection and the T7 HUD,
 * `dispose` for the clip-boundary swap.
 */
export function createFrameServer(options: FrameServerOptions): FrameServer {
  return new FrameServerImpl(options)
}
