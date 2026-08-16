/**
 * SP4 T3 — the decode planner.
 *
 * Every decision about *what to decode next* lives here, as pure functions
 * over a `SampleTable` (T2) and a small state record. Nothing in this file
 * touches the DOM, WebCodecs, workers or `postMessage`, which is the point:
 * the decode worker ships as an inlined source *string* (plan decision 6) and
 * a string cannot be unit tested the way a module can, so the architecture
 * pushes all planning main-side and leaves the string with nothing but decode
 * calls and supersession bookkeeping. `frame-server.ts` is the imperative
 * shell over these functions; `__tests__/batch-planner.test.ts` is where the
 * SP1 requirements are actually proven.
 *
 * Three of SP1's five engine requirements are decided here — each one is a
 * *fix* for a measured defect in `spikes/playback-engine/RESULTS.md`, not a
 * stylistic preference:
 *
 *  1. **Decode-order feed** (§7.1). Batches are contiguous slices of
 *     `samples`, which T2 guarantees is container/decode order. Time→index
 *     questions bisect `presIndex` (via T2's `sampleAtOrBefore` /
 *     `keyframeAtOrBefore`); the *slice* is never reordered. Feeding
 *     WebCodecs in presentation order kills the decoder on the first
 *     non-intra frame, and the bug is invisible on all-intra proxies — which
 *     is exactly how it survived to SP1's measurement stage.
 *  2. **Pipelined decode-ahead** (§6.1, the 4.5fps bug). Up to
 *     `MAX_IN_FLIGHT_BATCHES` requests may sit on the worker at once, and
 *     batches are floored at `minBatchFrames(N)`. The pre-fix planner allowed
 *     exactly one in flight and sized each batch to the current shortfall, so
 *     after the initial fill it asked for **one frame per batch** — and every
 *     batch ends in `decoder.flush()`, which drains the whole decoder
 *     pipeline. That configuration is still reachable through `PipelineConfig`
 *     (`maxInFlightBatches: 1, minBatchFrames: 1`) purely so the test can
 *     reproduce the degeneration against this same code.
 *  3. **Min-cts batch targets** (§6.1's second, latent bug). The worker drops
 *     frames below `targetTsUs` as pre-roll; in *decode* order `batch[0]` is
 *     not the earliest presentation time in the batch, so `batch[0].tsUs` as
 *     the target silently discards valid frames. The target is the MINIMUM
 *     cts in the batch, floored at the session's real first-wanted frame
 *     (the only legitimate pre-roll, i.e. keyframe → start).
 *
 * The fourth (`PRE_ROLL_EPSILON_US`, §7.2) is decided here and *applied*
 * inside the worker — it is handed over in the `init` command rather than
 * hardcoded in the worker string, so the constant has exactly one home.
 */
import { keyframeAtOrBefore, sampleAtOrBefore, type SampleRef, type SampleTable } from './demux'

/**
 * Tolerance for the worker's pre-roll comparison, in microseconds (SP1 §7.2).
 *
 * `EncodedVideoChunk.timestamp` is a `long long` — INTEGER microseconds —
 * while T2's `SampleRef.tsUs` is deliberately an un-rounded float
 * (`cts / timescale * 1e6`, e.g. `33333.333…`). A chunk fed in at `33333.333`
 * comes back off the decoder stamped `33333`, so a naive
 * `frame.timestamp < targetTsUs` test rejects **the very frame that was
 * requested** as pre-roll: SP1 measured ~2 of 3 seeks painting nothing, and
 * those seeks were silently excluded from the latency distribution rather
 * than failing loudly. Frames are ≥16000µs apart at any sane frame rate, so
 * 1µs of slack cannot admit a genuinely earlier frame.
 */
export const PRE_ROLL_EPSILON_US = 1

/**
 * How many `decodeRange` requests may sit on the worker at once. Two is
 * enough to hide the main-thread round trip: the worker starts the next batch
 * the instant it finishes flushing the previous one, instead of idling until
 * main notices and asks again (SP1 §6.1).
 */
export const MAX_IN_FLIGHT_BATCHES = 2

/** Default decode-ahead budget in frames — the N the spike measured at 30fps. */
export const DEFAULT_DECODE_AHEAD_FRAMES = 30

/** One contiguous run of DECODE indices to hand the worker. */
export interface DecodeBatch {
  /** First decode index, inclusive. */
  startIdx: number
  /** Last decode index, exclusive. */
  endIdx: number
  /** `endIdx - startIdx`; carried so callers don't recompute it for `batchExpected`. */
  count: number
  /**
   * Pre-roll floor for this batch: the worker emits frames with
   * `cts >= targetTsUs - PRE_ROLL_EPSILON_US` and closes everything below it.
   * Always the minimum cts in the batch (floored at the session's first
   * wanted frame) — never `samples[startIdx].tsUs`.
   */
  targetTsUs: number
}

/** Decode-ahead bookkeeping for one streaming session. Immutable; every transition returns a new record. */
export interface PipelineState {
  /** Next decode index to request. Advances monotonically through `samples`. */
  nextSampleIdx: number
  /** Frames decoded, delivered to main, and not yet consumed by the painter. */
  buffered: number
  /** Frames requested but not yet delivered (or accounted for by a batch's `done`). */
  inFlightFrames: number
  /** `decodeRange` requests posted but not yet `done`. */
  inFlightBatches: number
  /**
   * The session's genuine first wanted frame. Only the first batch of a
   * session has real pre-roll (keyframe → start sample); every later batch
   * floors above this anyway, so applying it unconditionally is a no-op after
   * the first batch and keeps the rule in one place.
   */
  firstBatchTargetTsUs: number
}

export interface PipelineConfig {
  /**
   * Decode-ahead budget in frames. `buffered + inFlightFrames` never exceeds
   * it, so N keeps meaning "at most N frames alive at once" — the property
   * SP1 §8's N sweep is measured against.
   */
  decodeAheadFrames: number
  /** See `MAX_IN_FLIGHT_BATCHES`. */
  maxInFlightBatches: number
  /**
   * Batch floor. Defaults to `minBatchFrames(decodeAheadFrames)`; overridable
   * ONLY so the test can rebuild SP1's pre-fix (4.5fps) configuration against
   * this same planner. Production never sets it.
   */
  minBatchFrames?: number
}

/**
 * Don't pay a worker round trip plus a full `decoder.flush()` for a handful of
 * frames: floor each batch at a quarter of the decode-ahead budget (minimum
 * 4), so flush cost amortizes over many frames instead of one (SP1 §6.1).
 */
export function minBatchFrames(decodeAheadFrames: number): number {
  return Math.max(4, Math.floor(decodeAheadFrames / 4))
}

/**
 * The pre-roll predicate, shared by the worker (which receives
 * `PRE_ROLL_EPSILON_US` via its `init` command) and by anything main-side that
 * needs to reason about the same boundary. See `PRE_ROLL_EPSILON_US`.
 */
export function shouldEmitFrame(
  frameTsUs: number,
  targetTsUs: number,
  epsilonUs: number = PRE_ROLL_EPSILON_US,
): boolean {
  return frameTsUs >= targetTsUs - epsilonUs
}

/**
 * The supersession rule, stated once. A request is superseded the moment a
 * strictly newer request id exists; the worker applies it to decide whether to
 * transfer or close a frame, and `frame-server.ts` applies it again main-side
 * to stragglers that were already in flight when the newer request went out.
 */
export function isSuperseded(reqId: number, latestReqId: number): boolean {
  return reqId < latestReqId
}

/**
 * Minimum presentation time across a decode-order slice.
 *
 * The whole reason this function exists: in decode order the timestamps
 * zig-zag whenever B-frames are present, so the first sample of a slice is not
 * its earliest presentation time (SP1 §6.1). Latent on SP3's all-intra
 * proxies, live the moment a reordered source shows up.
 */
export function minCtsUs(samples: readonly SampleRef[], startIdx: number, endIdx: number): number {
  let min = Infinity
  for (let i = startIdx; i < endIdx; i++) {
    if (samples[i].tsUs < min) min = samples[i].tsUs
  }
  return min
}

/**
 * Plan a one-shot seek: the decode run needed to produce the frame displayed
 * at `targetTsUs` (raw container microseconds — the caller maps project time
 * through `firstPresentationTsUs`).
 *
 * The run is `samples.slice(keyframeAtOrBefore, sampleAtOrBefore + 1)`, both
 * of which are DECODE indices from T2, and `targetTsUs` on the returned batch
 * is the exact cts of the requested frame — so the worker emits that frame and
 * anything at-or-after it in the run, and closes the keyframe→target pre-roll.
 * Returns `null` for an empty table.
 */
export function planSeek(table: SampleTable, targetTsUs: number): DecodeBatch | null {
  if (table.samples.length === 0) return null
  const startIdx = keyframeAtOrBefore(table, targetTsUs)
  const targetIdx = sampleAtOrBefore(table, targetTsUs)
  const endIdx = targetIdx + 1
  return {
    startIdx,
    endIdx,
    count: endIdx - startIdx,
    targetTsUs: table.samples[targetIdx].tsUs,
  }
}

/**
 * Open a streaming session at `fromTsUs`: decoding starts at the enclosing
 * keyframe, and everything between that keyframe and the first wanted frame is
 * this session's only genuine pre-roll.
 */
export function planStreamStart(table: SampleTable, fromTsUs: number): PipelineState {
  const samples = table.samples
  const keyIdx = samples.length === 0 ? 0 : keyframeAtOrBefore(table, fromTsUs)
  const startIdx = samples.length === 0 ? 0 : sampleAtOrBefore(table, fromTsUs)
  return {
    nextSampleIdx: keyIdx,
    buffered: 0,
    inFlightFrames: 0,
    inFlightBatches: 0,
    firstBatchTargetTsUs: samples.length === 0 ? 0 : samples[startIdx].tsUs,
  }
}

/**
 * Top up the decode-ahead pipeline: the batches to post right now, plus the
 * state that results from posting them (the caller posts them and keeps the
 * state; nothing is mutated in place).
 *
 * Loop conditions, in order, and why each one is there:
 *  - `inFlightBatches < maxInFlightBatches` — keep the worker fed so it never
 *    idles waiting for a main-thread round trip (SP1 §6.1).
 *  - end of source — nothing left to ask for.
 *  - `capacity = N - buffered - inFlightFrames` — the frame budget. Holding
 *    `buffered + inFlight ≤ N` is what keeps N meaning "at most N frames alive
 *    at once", which SP1 §8's memory sweep depends on.
 *  - `capacity < minBatch` while not starving — amortize the flush. "Starving"
 *    (nothing buffered, nothing coming) overrides it: any batch beats a stall.
 */
export function planNextBatches(
  table: SampleTable,
  state: PipelineState,
  config: PipelineConfig,
): { batches: DecodeBatch[]; state: PipelineState } {
  const samples = table.samples
  const minBatch = config.minBatchFrames ?? minBatchFrames(config.decodeAheadFrames)
  const batches: DecodeBatch[] = []
  let next = { ...state }

  while (next.inFlightBatches < config.maxInFlightBatches) {
    if (next.nextSampleIdx >= samples.length) break

    const capacity = config.decodeAheadFrames - next.buffered - next.inFlightFrames
    if (capacity <= 0) break
    const starving = next.buffered === 0 && next.inFlightFrames === 0
    if (!starving && capacity < minBatch) break

    const startIdx = next.nextSampleIdx
    const endIdx = Math.min(startIdx + capacity, samples.length)
    const count = endIdx - startIdx
    if (count <= 0) break

    batches.push({
      startIdx,
      endIdx,
      count,
      // Min cts, never samples[startIdx].tsUs — see `minCtsUs`. The floor is
      // the session's real first wanted frame, which is what legitimately
      // discards the keyframe→start pre-roll on the first batch only.
      targetTsUs: Math.max(next.firstBatchTargetTsUs, minCtsUs(samples, startIdx, endIdx)),
    })

    next = {
      ...next,
      nextSampleIdx: endIdx,
      inFlightFrames: next.inFlightFrames + count,
      inFlightBatches: next.inFlightBatches + 1,
    }
  }

  return { batches, state: next }
}

/** A frame arrived from the worker and joined the main-side buffer. */
export function onFrameBuffered(state: PipelineState): PipelineState {
  return {
    ...state,
    buffered: state.buffered + 1,
    inFlightFrames: Math.max(0, state.inFlightFrames - 1),
  }
}

/** `n` buffered frames left the buffer (painted, dropped as late, or closed on teardown). */
export function onFramesConsumed(state: PipelineState, n = 1): PipelineState {
  return { ...state, buffered: Math.max(0, state.buffered - n) }
}

/**
 * A batch reported `done`. Reconciliation, not just a decrement: frames the
 * worker dropped as pre-roll never arrive, so the per-frame decrement in
 * `onFrameBuffered` under-counts and `inFlightFrames` would drift upward,
 * permanently eating decode-ahead capacity until the pipeline wedged.
 * `expected` is the batch's `count`; `decoded` is what the worker actually
 * emitted.
 */
export function reconcileOnBatchDone(
  state: PipelineState,
  expected: number,
  decoded: number,
): PipelineState {
  const missing = Math.max(0, expected - decoded)
  return {
    ...state,
    inFlightBatches: Math.max(0, state.inFlightBatches - 1),
    inFlightFrames: Math.max(0, state.inFlightFrames - missing),
  }
}
