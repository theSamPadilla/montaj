/**
 * §190 T2: `MixClock`, the main-thread face of the preview mixer.
 *
 * It builds the three-party pipe (mix-protocol.ts has the diagram): the mix
 * `AudioWorkletNode`, the feeder Worker, and a `MessageChannel` between them
 * (one port posted to the worklet, the other transferred to the Worker). Then
 * it sends only the plan (to the Worker) and the transport and live
 * parameters (to the worklet). It never touches PCM, and uses no
 * SharedArrayBuffer.
 *
 * ## How it maps onto `MasterClock` (audio-clock.ts)
 *
 * `MixClock` is structurally a `MasterClock` (a type test pins that), so T3 can
 * hand it to anything that takes one. Member by member:
 *
 * | MasterClock                | MixClock                                                      |
 * |----------------------------|---------------------------------------------------------------|
 * | `kind` ('audio'/'fallback')| always `'audio'`; there is no wall-clock variant. `createMixClock` REJECTS when the worklet cannot be built (unlike `createMasterClock`, which never does), so the caller decides the fallback (`createWallClock`). |
 * | `reason`                   | never set                                                     |
 * | `playing`                  | same                                                          |
 * | `now()`                    | same meaning (project seconds, extrapolated from the last report, capped at 3 report intervals), but from ONE clock for the whole timeline, not one per clip. Small backward corrections within a transport generation are held, so `now()` never steps back during steady playback. |
 * | (none)                     | `displayNow()`: `now() − rate × (outputLatency + baseLatency)`, what is audible right now; the paint and playhead time. Held at the play/seek position until the first audio reaches the speaker, and after a pause it glides to the stop point over the latency. |
 * | `play()`                   | same; 5 ms fade-in. Resumes the same generation, so nothing is refetched. |
 * | `pause()`                  | freezes 5 ms later than MasterClock does: the clock runs through the 5 ms fade-out, and the worklet's final report pins the exact frozen time. |
 * | `seek(projectS, mediaS?)`  | same signature; `mediaS` is IGNORED: there is no per-clip media position, loop wraps become plan edits. Playing survives it (5 ms fade out, switch, fade in). |
 * | `setVolume(v)`             | the MASTER bus gain (MasterClock's was one clip's level; per-segment levels are `setParams`). Smoothed over 10 ms. |
 * | `setTransportRate(r)`      | same, alias of `setRate`. Clamped to ±[1/16, 16]; negative plays backwards. |
 * | `stats()`                  | a superset of `MasterClockStats`: `samplesConsumed` is `renderedFrames`, `underrunFrames` excludes the seek-to-sound wait (`primingFrames`), and `queuedFrames` is the smallest lead over the active segments. |
 * | `dispose()`                | same; never closes the shared AudioContext.                    |
 * | (none)                     | `setPlan`, `setParams`: the segments, and live mute and gain per segment. |
 *
 * The other structural difference T3 inherits: there is no clip-boundary clock
 * swap. Cuts, gaps and speed edits change the plan, never the clock.
 */
import type { MasterClockStats } from '../audio-clock'
import { getSharedAudioContext, latencySeconds } from '../../video/preview/audio-context'
import { mixProcessorSource } from './mix-processor-source'
import { mixWorkerSource } from './mix-worker-source'
import {
  MIX_AHEAD_S,
  MIX_CACHE_BYTES,
  MIX_MAX_EXTRAPOLATION_MS,
  MIX_MAX_INFLIGHT,
  MIX_MAX_POST_S,
  MIX_MAX_RATE,
  MIX_MIN_RATE,
  MIX_PROCESSOR_NAME,
  MIX_REFILL_S,
  MIX_REPORT_INTERVAL_S,
  MIX_SMOOTHING_S,
  MIX_SOURCE_BLOCK_S,
  MIX_TRANSPORT_FADE_S,
  type MixParam,
  type MixPlan,
  type MixReport,
  type MixSegment,
  type MixWorkerStats,
  type WorkerToMain,
} from './mix-protocol'

export type { MixParam, MixPlan, MixReport, MixSegment, MixWorkerStats } from './mix-protocol'

/** Reports kept for the arrival-offset filter (~1 s at 20 Hz). */
const OFFSET_WINDOW = 20
/** An arrival offset this far above the window's minimum is a discontinuity (a suspended context resumed). */
const OFFSET_RESET_MS = 50
/** `now()` holds a backward step smaller than this rather than going back. */
const HOLD_BACK_S = 0.05

export interface MixClockStats extends MasterClockStats {
  kind: 'audio'
  renderedFrames: number
  primingFrames: number
  /** Segments that starved during the last report interval. */
  starving: string[]
  gen: number
  seq: number
  rate: number
  /** The last report's clock pair. */
  timelineTime: number
  contextTime: number
  /** outputLatency + baseLatency, live. */
  latencyS: number
  sampleRate: number
  /** The Worker's last stats (about once a second), or null before the first. */
  worker: MixWorkerStats | null
}

export interface MixClock {
  readonly kind: 'audio'
  readonly reason?: string
  readonly playing: boolean
  readonly sampleRate: number
  /** Timeline seconds the mixer is rendering now. */
  now(): number
  /** Timeline seconds audible now: `now() − rate × latency`. Paint the picture and the playhead at this. */
  displayNow(): number
  play(): void
  pause(): void
  /** `mediaS` is accepted for MasterClock compatibility and ignored. */
  seek(projectS: number, mediaS?: number): void
  setRate(rate: number): void
  /** MasterClock's name for `setRate`. */
  setTransportRate(rate: number): void
  /** Master bus gain, smoothed. */
  setVolume(volume: number): void
  setPlan(plan: MixPlan): void
  /** Live per-segment overrides, merged into what was set before; smoothed over 10 ms. */
  setParams(params: Record<string, MixParam>): void
  stats(): MixClockStats
  dispose(): void
}

// ── Seams (the real browser objects satisfy these) ──────────────────────────

export interface MixPortLike {
  onmessage: ((ev: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

export interface MixNodeLike {
  readonly port: MixPortLike
  connect(destination: AudioNode): unknown
  disconnect(): void
}

export interface MixWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
}

export interface MixChannelLike {
  port1: unknown
  port2: unknown
}

/** The slice of an AudioContext MixClock reads. */
export type MixContextLike = Pick<BaseAudioContext, 'sampleRate' | 'destination'> &
  Partial<Pick<AudioContext, 'outputLatency' | 'baseLatency' | 'state' | 'resume'>> & {
    audioWorklet?: { addModule(url: string): Promise<void> }
  }

export interface MixClockOptions {
  /** Default: the page's shared context. Never closed. */
  context?: MixContextLike
  /** Where the mix goes. Default `context.destination`; `null` leaves it unconnected. */
  destination?: AudioNode | null
  /** Timeline seconds the clock starts at, paused. Default 0. */
  startTime?: number
  /** Resolves relative segment URLs (a blob Worker cannot). Default `location.href`. */
  baseUrl?: string
  onError?: (message: string) => void
  /** Every report the worklet sends, stale or not. */
  onReport?: (report: MixReport) => void
  aheadS?: number
  cacheBytes?: number
  /** Test seams. */
  nowMs?: () => number
  loadModule?: (ctx: MixContextLike) => Promise<void>
  createNode?: (ctx: MixContextLike, options: AudioWorkletNodeOptions) => MixNodeLike
  spawnWorker?: () => MixWorkerLike
  createChannel?: () => MixChannelLike
}

const moduleLoaded = new WeakSet<object>()

/** `addModule` once per context; the string guards against a second registration too. */
async function ensureMixModule(ctx: MixContextLike): Promise<void> {
  if (moduleLoaded.has(ctx)) return
  if (!ctx.audioWorklet) throw new Error('AudioWorklet unavailable')
  const url = URL.createObjectURL(new Blob([mixProcessorSource], { type: 'text/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
    moduleLoaded.add(ctx)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function createWorkletNode(ctx: MixContextLike, options: AudioWorkletNodeOptions): MixNodeLike {
  return new AudioWorkletNode(ctx as BaseAudioContext, MIX_PROCESSOR_NAME, options) as unknown as MixNodeLike
}

function spawnBlobWorker(): MixWorkerLike {
  const url = URL.createObjectURL(new Blob([mixWorkerSource], { type: 'text/javascript' }))
  const worker = new Worker(url)
  URL.revokeObjectURL(url)
  return worker as unknown as MixWorkerLike
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate === 0) return 1
  const mag = Math.min(MIX_MAX_RATE, Math.max(MIX_MIN_RATE, Math.abs(rate)))
  return rate < 0 ? -mag : mag
}

function absoluteUrl(url: string, base: string | undefined): string {
  try {
    return base ? new URL(url, base).href : new URL(url).href
  } catch {
    return url
  }
}

/**
 * Build the mixer and its clock, paused at `startTime`. Rejects when the
 * environment cannot run it (no AudioWorklet, the module fails to load, no
 * Worker): the caller picks the fallback.
 */
export async function createMixClock(options: MixClockOptions = {}): Promise<MixClock> {
  const ctx: MixContextLike = options.context ?? getSharedAudioContext()
  const nowMs = options.nowMs ?? (() => performance.now())
  const sampleRate = ctx.sampleRate
  const startTime = options.startTime ?? 0
  const fadeMs = MIX_TRANSPORT_FADE_S * 1000

  await (options.loadModule ?? ensureMixModule)(ctx)

  const node = (options.createNode ?? createWorkletNode)(ctx, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      sampleRate,
      reportIntervalS: MIX_REPORT_INTERVAL_S,
      smoothingS: MIX_SMOOTHING_S,
      transportFadeS: MIX_TRANSPORT_FADE_S,
      startTime,
    },
  })
  const destination = options.destination === undefined ? ctx.destination : options.destination
  let worker: MixWorkerLike
  try {
    if (destination) node.connect(destination)
    worker = (options.spawnWorker ?? spawnBlobWorker)()
  } catch (err) {
    try {
      node.disconnect()
    } catch {
      // never connected
    }
    throw err
  }
  const channel = (options.createChannel ?? (() => new MessageChannel()))()
  node.port.postMessage({ t: 'connect', port: channel.port1 }, [channel.port1 as Transferable])
  worker.postMessage(
    {
      t: 'init',
      port: channel.port2,
      sampleRate,
      aheadS: options.aheadS ?? MIX_AHEAD_S,
      refillS: MIX_REFILL_S,
      blockS: MIX_SOURCE_BLOCK_S,
      maxPostS: MIX_MAX_POST_S,
      cacheBytes: options.cacheBytes ?? MIX_CACHE_BYTES,
      maxInflight: MIX_MAX_INFLIGHT,
    },
    [channel.port2 as Transferable],
  )

  if (ctx.state === 'suspended' && ctx.resume) {
    // Best effort, as audio-clock.ts: a resume off the gesture stack usually
    // stays suspended, and the caller's gesture anchor is what really resumes.
    void ctx.resume().catch(() => {})
  }

  // ── transport state ───────────────────────────────────────────────────────
  let seq = 0
  let gen = 0
  let playing = false
  let rate = 1
  let frozen = startTime
  /** The estimate before a report for the current op arrives: anchorT, advancing from anchorPerf. */
  let anchorT = startTime
  let anchorPerf = nowMs()
  /** displayNow() never goes below (rate > 0) or above (rate < 0) this while playing. */
  let displayFloor = startTime
  let pauseGlide: { perf: number; display: number; rate: number } | null = null

  // ── reports ───────────────────────────────────────────────────────────────
  /** The latest report of any op, for stats. */
  let latest: MixReport | null = null
  /** The latest report for the current op, and the performance time its contextTime maps to. */
  let trusted: MixReport | null = null
  let trustedPerf = 0
  const offsets: number[] = []
  let offsetMin = 0
  let workerStats: MixWorkerStats | null = null

  let lastReadGen = -1
  let lastReadSeq = -1
  let lastRead = 0

  let planGen = 0
  let disposed = false

  const baseUrl =
    options.baseUrl ?? (typeof location !== 'undefined' && location.href ? location.href : undefined)

  node.port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as MixReport
    if (!m || m.t !== 'report') return
    const arrival = nowMs()
    // Map the report's contextTime onto performance time. Arrival lags it by
    // the message delay, which is never negative, so the window's smallest
    // offset is the truest; a jump far above it is a resumed context.
    const off = arrival - m.contextTime * 1000
    if (offsets.length > 0 && off - offsetMin > OFFSET_RESET_MS) offsets.length = 0
    offsets.push(off)
    if (offsets.length > OFFSET_WINDOW) offsets.shift()
    offsetMin = Math.min(...offsets)
    latest = m
    options.onReport?.(m)
    if (m.seq !== seq || m.gen !== gen) return
    trusted = m
    trustedPerf = m.contextTime * 1000 + offsetMin
    if (!playing && !m.playing) frozen = m.timelineTime
  }

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as WorkerToMain
    if (!m) return
    if (m.t === 'stats') workerStats = m
    else if (m.t === 'error') options.onError?.(m.message)
  }

  const read = (): number => {
    if (!playing) return frozen
    let v: number
    if (trusted !== null && trusted.seq === seq && trusted.gen === gen && trusted.playing) {
      const el = Math.min(Math.max(nowMs() - trustedPerf, 0), MIX_MAX_EXTRAPOLATION_MS)
      v = trusted.timelineTime + (trusted.rate * el) / 1000
    } else {
      const el = Math.min(Math.max(nowMs() - anchorPerf, 0), MIX_MAX_EXTRAPOLATION_MS)
      v = anchorT + (rate * el) / 1000
    }
    if (lastReadGen === gen && lastReadSeq === seq) {
      const back = rate > 0 ? lastRead - v : v - lastRead
      if (back > 0 && back < HOLD_BACK_S) v = lastRead
    }
    lastReadGen = gen
    lastReadSeq = seq
    lastRead = v
    return v
  }

  const latency = (): number =>
    latencySeconds({ outputLatency: ctx.outputLatency ?? 0, baseLatency: ctx.baseLatency ?? 0 })

  const displayNow = (): number => {
    if (!playing) {
      if (pauseGlide) {
        const d = pauseGlide.display + (pauseGlide.rate * (nowMs() - pauseGlide.perf)) / 1000
        return pauseGlide.rate > 0 ? Math.min(frozen, d) : Math.max(frozen, d)
      }
      return frozen
    }
    const v = read() - rate * latency()
    return rate > 0 ? Math.max(v, displayFloor) : Math.min(v, displayFloor)
  }

  const post = (msg: unknown) => {
    if (disposed) return
    node.port.postMessage(msg)
  }

  const setRate = (next: number) => {
    if (disposed) return
    const r = clampRate(next)
    if (r === rate) return
    if (playing) {
      const t = read()
      displayFloor = displayNow()
      // The worklet switches when its 5 ms fade-out ends, at t + rate × fade.
      anchorT = t + (rate * fadeMs) / 1000
      anchorPerf = nowMs() + fadeMs
    }
    seq += 1
    gen += 1
    rate = r
    post({ t: 'rate', seq, gen, rate: r })
  }

  return {
    kind: 'audio',
    sampleRate,
    get playing() {
      return playing
    },
    now: read,
    displayNow,
    play() {
      if (playing || disposed) return
      seq += 1
      playing = true
      anchorT = frozen
      anchorPerf = nowMs()
      displayFloor = frozen
      pauseGlide = null
      post({ t: 'play', seq })
    },
    pause() {
      if (!playing || disposed) return
      const v = read()
      const display = displayNow()
      seq += 1
      // The clock runs on through the fade-out; the final report pins it exactly.
      frozen = v + (rate * fadeMs) / 1000
      pauseGlide = { perf: nowMs(), display, rate }
      playing = false
      post({ t: 'pause', seq })
    },
    seek(projectS: number, _mediaS?: number) {
      if (disposed || !Number.isFinite(projectS)) return
      seq += 1
      gen += 1
      frozen = projectS
      anchorT = projectS
      // Playing, the worklet reaches the new position after its 5 ms fade-out.
      anchorPerf = nowMs() + (playing ? fadeMs : 0)
      displayFloor = projectS
      pauseGlide = null
      post({ t: 'seek', seq, gen, time: projectS })
    },
    setRate,
    setTransportRate: setRate,
    setVolume(volume: number) {
      if (!Number.isFinite(volume)) return
      post({ t: 'params', master: volume })
    },
    setPlan(plan: MixPlan) {
      if (disposed) return
      planGen += 1
      const segments: MixSegment[] = plan.segments.map((s) => ({ ...s, url: absoluteUrl(s.url, baseUrl) }))
      worker.postMessage({ t: 'plan', planGen, segments })
    },
    setParams(params: Record<string, MixParam>) {
      post({ t: 'params', segments: params })
    },
    stats(): MixClockStats {
      const r = latest
      const queued = r?.queuedFrames ?? 0
      return {
        kind: 'audio',
        playing,
        samplesConsumed: r?.renderedFrames ?? 0,
        underrunFrames: r?.underrunFrames ?? 0,
        queuedFrames: queued,
        queuedSeconds: queued / sampleRate,
        renderedFrames: r?.renderedFrames ?? 0,
        primingFrames: r?.primingFrames ?? 0,
        starving: r ? [...r.starving] : [],
        gen,
        seq,
        rate,
        timelineTime: r?.timelineTime ?? frozen,
        contextTime: r?.contextTime ?? 0,
        latencyS: latency(),
        sampleRate,
        worker: workerStats,
      }
    },
    dispose() {
      if (disposed) return
      frozen = read()
      playing = false
      node.port.postMessage({ t: 'dispose' })
      disposed = true
      node.port.onmessage = null
      worker.onmessage = null
      try {
        worker.postMessage({ t: 'dispose' })
        worker.terminate()
      } catch {
        // already gone
      }
      try {
        node.disconnect()
      } catch {
        // already disconnected
      }
    },
  }
}
