/**
 * §190 T2: the preview mixer's message protocol and tuning constants.
 *
 * Three parties, three links, no SharedArrayBuffer:
 *
 *   main (MixClock) ──node.port──▶ worklet (mix-processor-source.ts)
 *   main (MixClock) ──postMessage─▶ Worker  (mix-worker-source.ts)
 *   Worker ◀──────MessageChannel──▶ worklet
 *
 * The main thread sends the plan (to the Worker) and the transport and live
 * parameters (to the worklet). It never touches PCM: the Worker fetches the
 * conformed audio, converts, stretches and resamples it, and posts blocks
 * straight to the worklet over the MessageChannel, with the buffers transferred.
 *
 * The worklet owns the ONE project clock: an output-frame counter `k`, mapped
 * to timeline time through the current transport generation,
 *
 *     timelineTime(k) = anchorTime + rate * k / sampleRate
 *
 * `k` counts frames the clock has advanced in this generation. It runs while
 * playing (including the 5 ms pause fade) and freezes while paused, so a pause
 * and a resume stay in one generation and keep every queued block. A seek or a
 * rate change starts a new generation at k = 0, and every block carries the
 * generation it was placed in: the worklet drops any block from another one.
 *
 * Both string modules hold their own copy of the placement rule
 * (`placeK` below is the reference the tests hold them to):
 *
 *     placeK(tl) = Math.round((tl - anchorTime) * sampleRate / rate)
 *
 * The constants here are the defaults. The strings cannot import, so MixClock
 * injects them (processorOptions for the worklet, the `init` message for the
 * Worker), the way audio-worklet-source.ts receives `reportIntervalS`.
 */

/** Processor name `mixProcessorSource` registers. */
export const MIX_PROCESSOR_NAME = 'montaj-mix'

/** Worklet report cadence: ~20 Hz, to main and (as `clock`) to the Worker. */
export const MIX_REPORT_INTERVAL_S = 0.05

/**
 * Ceiling on main's extrapolation past the last report: 3 report intervals.
 * A suspended context sends no reports, and an unbounded extrapolation would
 * run the playhead away and then snap it back (audio-clock.ts's
 * MAX_EXTRAPOLATION_MS, same reasoning).
 */
export const MIX_MAX_EXTRAPOLATION_MS = MIX_REPORT_INTERVAL_S * 1000 * 3

/** Live gain and mute changes ramp linearly over this long, so they never click. */
export const MIX_SMOOTHING_S = 0.01

/** Play, pause and seek fade the whole bus over this long. */
export const MIX_TRANSPORT_FADE_S = 0.005

/** The Worker keeps every active or upcoming segment fed this far ahead of the clock. */
export const MIX_AHEAD_S = 1.5

/** A segment is topped up only once its lead has fallen this far below `MIX_AHEAD_S`. */
export const MIX_REFILL_S = 0.25

/** Source block size for range requests and the cache, in source seconds. */
export const MIX_SOURCE_BLOCK_S = 0.25

/** The Worker's block cache cap. */
export const MIX_CACHE_BYTES = 64 * 1024 * 1024

/** Largest PCM block the Worker posts in one message, in output seconds. */
export const MIX_MAX_POST_S = 0.25

/** Range requests in flight at once, across all segments. */
export const MIX_MAX_INFLIGHT = 6

/** The transport rate is clamped to ±[1/16, 16]; |rate × speed| beyond WSOLA's 32× ceiling would drift. */
export const MIX_MIN_RATE = 1 / 16
export const MIX_MAX_RATE = 16

// ── The plan (main → Worker) ────────────────────────────────────────────────

/**
 * Fade shapes. `linear`, `exp` and `log` are the editor's names
 * (fade-curve.ts); the mixer shapes them with ffmpeg afade's formulas, which
 * is what the export applies (mix-audio.js maps linear → `tri`, exp → `exp`,
 * log → `log`). An absent curve means `exp`, the export's default.
 */
export type MixCurve = 'linear' | 'exp' | 'log'

export type MixPcmFormat = 'pcm_s16le' | 'pcm_f32le'

/** One stretch of one source on the timeline. */
export interface MixSegment {
  /** Unique within a plan. Live overrides (`setParams`) are keyed by it. */
  id: string
  /** Absolute or page-relative URL of the conformed raw PCM; MixClock resolves it to absolute. */
  url: string
  /** Default `pcm_s16le`. */
  format?: MixPcmFormat
  /** The conformed file's rate. Default 48000. */
  sampleRate?: number
  /** The conformed file's channels (1 or 2; more keeps the first two). Default 2. */
  channels?: number
  /** Byte offset of frame 0 in the file. Default 0 (raw PCM). */
  dataOffset?: number
  /** Total frames in the file, when known. Reads past it are silence and fetch nothing. */
  frames?: number
  /** Timeline start, seconds. */
  tlStart: number
  /** Timeline end, seconds. `null`/absent: plays to the end of time (the file's end is silence). */
  tlEnd?: number | null
  /** Source position at `tlStart`, seconds. Default 0. */
  srcIn?: number
  /** Per-clip speed: source seconds per timeline second. Default 1. */
  speed?: number
  /** Base gain (1 = unity; above 1 amplifies). Default 1. */
  gain?: number
  /** Fade-in length, seconds, anchored at `tlStart`. Default 0. */
  fadeIn?: number
  /** Fade-out length, seconds, ending at `tlEnd`. Default 0 (and none without a `tlEnd`). */
  fadeOut?: number
  /** Both fades' shape. Default `exp` (the export's default). */
  curve?: MixCurve
  /** Overrides `curve` for the fade-in. */
  curveIn?: MixCurve
  /** Overrides `curve` for the fade-out. */
  curveOut?: MixCurve
}

export interface MixPlan {
  segments: MixSegment[]
}

/** Live per-segment overrides, multiplied onto the plan's base gain. Smoothed over 10 ms. */
export interface MixParam {
  mute?: boolean
  gain?: number
}

// ── Messages ────────────────────────────────────────────────────────────────

/** main → worklet. `seq` increments on every transport op and is echoed in reports. */
export type MainToWorklet =
  | { t: 'connect'; port: MessagePort }
  | { t: 'play'; seq: number }
  | { t: 'pause'; seq: number }
  | { t: 'seek'; seq: number; gen: number; time: number }
  | { t: 'rate'; seq: number; gen: number; rate: number }
  | { t: 'params'; segments?: Record<string, MixParam>; master?: number }
  | { t: 'report' }
  | { t: 'dispose' }

/** Worklet → main, ~20 Hz and on every transport change. */
export interface MixReport {
  t: 'report'
  /** Last transport op the worklet applied. */
  seq: number
  /** Transport generation in force. */
  gen: number
  /** The clock is advancing (playing, or inside the pause fade). */
  playing: boolean
  rate: number
  /** Frames the clock has advanced in this generation. */
  k: number
  /** Frames rendered while the clock ran, since the node was created. Monotonic. */
  renderedFrames: number
  /** `anchorTime + rate * k / sampleRate`, at `contextTime`. */
  timelineTime: number
  /** The context time `timelineTime` holds at (the end of the last rendered quantum). */
  contextTime: number
  /** Segment-frames of starvation after a segment had been fed (summed over segments). */
  underrunFrames: number
  /** Segment-frames of starvation before a segment's first block in a generation (seek-to-sound wait). */
  primingFrames: number
  /** Segments that starved at any frame since the previous report. */
  starving: string[]
  /** Smallest lead (queued frames past `k`) over the segments active at `k`; 0 when none is active. */
  queuedFrames: number
}

/** Worklet → Worker: the transport, on every change. */
export interface MixTransportMsg {
  t: 'transport'
  gen: number
  anchorTime: number
  rate: number
  k: number
  playing: boolean
}

/** Worklet → Worker: the clock, ~20 Hz. */
export interface MixClockMsg {
  t: 'clock'
  gen: number
  k: number
  playing: boolean
}

/** main → Worker. */
export type MainToWorker =
  | {
      t: 'init'
      port: MessagePort
      sampleRate: number
      aheadS?: number
      refillS?: number
      blockS?: number
      maxPostS?: number
      cacheBytes?: number
      maxInflight?: number
    }
  | { t: 'plan'; planGen: number; segments: MixSegment[] }
  | { t: 'stats' }
  | { t: 'dispose' }

/** The mix parameters the Worker forwards to the worklet (no URLs, no source mapping). */
export interface MixSegmentParams {
  id: string
  /** Bumped whenever the segment's audio mapping changes; blocks of an older version are dropped. */
  ver: number
  tlStart: number
  /** `Infinity` when open-ended. */
  tlEnd: number
  gain: number
  fadeIn: number
  fadeOut: number
  curveIn: MixCurve
  curveOut: MixCurve
}

/** Worker → worklet. */
export type WorkerToWorklet =
  | { t: 'segments'; planGen: number; segs: MixSegmentParams[] }
  | {
      t: 'block'
      gen: number
      id: string
      ver: number
      /** Output frame (clock `k`) of the block's first frame, in generation `gen`. */
      k0: number
      frames: number
      /** Interleaved stereo float32, `frames * 2` long. Transferred. */
      pcm: Float32Array
    }

/** Worker → main. */
export interface MixWorkerStats {
  t: 'stats'
  planGen: number
  gen: number
  cacheBytes: number
  cacheBlocks: number
  cacheEvictions: number
  fetches: number
  fetchBytes: number
  fetchErrors: number
  inflight: number
  blocksPosted: number
  framesPosted: number
  /** Cumulative milliseconds in each stage, for the CPU budget. */
  convertMs: number
  stretchMs: number
  resampleMs: number
  /** Output frames that went through the resampler / the stretcher. */
  resampledFrames: number
  stretchedFrames: number
}

export type WorkerToMain = MixWorkerStats | { t: 'error'; message: string; planGen: number }

// ── Reference math (the strings hold their own copies; tests pin them to these) ──

/** Output frame (clock `k`) at which timeline time `tl` falls in a generation. */
export function placeK(tl: number, anchorTime: number, rate: number, sampleRate: number): number {
  return Math.round(((tl - anchorTime) * sampleRate) / rate)
}

/** Timeline time of clock frame `k` in a generation. */
export function timelineTimeAt(k: number, anchorTime: number, rate: number, sampleRate: number): number {
  return anchorTime + (rate * k) / sampleRate
}

/**
 * ffmpeg afade's gain for a curve at `x` in [0, 1] (0 = the silent edge,
 * 1 = full level), as the export applies it. Formulas from libavfilter
 * af_afade.c `fade_gain`, and checked against the vendored ffmpeg 8.1.2 the
 * export runs (captured values in __tests__/mix-processor-source.test.ts).
 *
 *  - linear (`tri`): x
 *  - exp: exp(-11.5129... * (1 - x)), i.e. -100 dB at the silent edge
 *  - log: clip(1 + 0.2 * log10(x), 0, 1)
 *
 * NOT the editor's drawn shapes (fade-curve.ts's `t²` and `t(2-t)`): those
 * only read like these families, and the audio must match the export.
 */
export function exportFadeGain(curve: MixCurve, x: number): number {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x
  if (curve === 'linear') return c
  if (curve === 'log') {
    if (c <= 0) return 0
    const g = 1 + 0.2 * Math.log10(c)
    return g < 0 ? 0 : g > 1 ? 1 : g
  }
  return Math.exp(-11.512925464970227 * (1 - c))
}
