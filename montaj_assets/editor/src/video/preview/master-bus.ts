/**
 * §660: the preview's master bus, so the preview plays at the level the
 * export will.
 *
 * The export levels its mix by ONE static master gain (§697, "the way pro
 * editors do"): `settings.loudness - I`, where I is the integrated loudness
 * over the whole timeline, measured on the speech when the project has
 * speech, else on the whole mix (render/mix-loudness.js), then a peak limiter
 * at -1.5 dBFS (render/mix-audio.js `loudnessFilter`). Track and item volumes
 * are absolute: a fader is heard as set and never re-levelled. The preview
 * mixes the same sources by the same rules, then sends the result through ONE
 * chain on the shared context:
 *
 *     sources → gain → limiter → trim → destination
 *
 *  - **gain** is the level: `target - inputI` dB, the export's own number
 *    (engine/mix/loudness-client.ts asks serve for it). 0 dB until a number
 *    is known, and whenever there is no target.
 *  - **limiter** matches the export's (ffmpeg `alimiter`, limit -1.5 dBFS,
 *    no auto-level), so a raised quiet mix does not clip on its peaks: a
 *    compressor with a hard knee and a high ratio at -1.5 dBFS, with a fast
 *    attack. Its fixed look-ahead delays the preview's sound
 *    (`LIMITER_LOOKAHEAD_S`); the engine's clocks
 *    add it to the output latency they take off (`masterBusLatencyS`), so the
 *    picture stays with the sound.
 *  - **trim** takes off the makeup gain the Web Audio compressor adds on its
 *    own (`limiterMakeupDb`), so a signal under the ceiling comes out exactly
 *    as the gain set it.
 *
 * Every path that plays preview sound connects to `masterInput(ctx)` instead
 * of `ctx.destination`: the preview mixer (mix-clock.ts), the per-clip clocks
 * and scrub grains it falls back to (audio-clock.ts, scrub-source.ts) and the
 * engine's `<audio>` lanes (useEnginePlayback.ts). A context that cannot build
 * the chain (no compressor) plays straight to its destination, as before.
 *
 * A level change while sound plays is ramped (`setTargetAtTime`,
 * `MASTER_RAMP_TAU_S`), never jumped to.
 */
import { peekSharedAudioContext } from './audio-context'

/** The limiter: a hard ceiling at -1.5 dBFS, the export's alimiter limit. */
export const LIMITER = {
  thresholdDb: -1.5,
  kneeDb: 0,
  ratio: 20,
  attackS: 0.001,
  releaseS: 0.1,
} as const

/**
 * The limiter's look-ahead: every sample through the bus comes out this much
 * later. The Web Audio API exposes no node latency, so it is the compressor
 * kernel's fixed pre-delay, 6 ms, in Chromium and in WebKit, whose
 * DynamicsCompressorNode is the same kernel. It does not change with the
 * compressor's parameters.
 */
export const LIMITER_LOOKAHEAD_S = 0.006

/** A new level's time constant: 63% there in 0.25 s, 95% in 0.75 s. */
export const MASTER_RAMP_TAU_S = 0.25

export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

/**
 * The makeup gain the Web Audio compressor applies by itself, in dB: the
 * spec's `(1 / fullRangeGain) ^ 0.6`, where `fullRangeGain` is its curve at
 * 0 dBFS. With a hard knee that point comes out at `threshold * (1 - 1/ratio)`.
 */
export function limiterMakeupDb(threshold = LIMITER.thresholdDb, ratio = LIMITER.ratio): number {
  return -0.6 * threshold * (1 - 1 / ratio)
}

/** The slice of an AudioContext the bus uses. */
export interface MasterContextLike {
  readonly currentTime: number
  readonly destination: AudioNode
  createGain(): GainNode
  createDynamicsCompressor(): DynamicsCompressorNode
}

export interface MasterBus {
  /** Where every preview source connects. */
  readonly input: AudioNode
  /** The level now asked for, dB. */
  readonly gainDb: number
  /** Ramp to `db` (never a jump). */
  setGainDb(db: number): void
}

/** Build the chain on `ctx`, at `initialDb`. */
export function createMasterBus(ctx: MasterContextLike, initialDb = 0): MasterBus {
  const gain = ctx.createGain()
  gain.gain.value = dbToGain(initialDb)
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = LIMITER.thresholdDb
  limiter.knee.value = LIMITER.kneeDb
  limiter.ratio.value = LIMITER.ratio
  limiter.attack.value = LIMITER.attackS
  limiter.release.value = LIMITER.releaseS
  const trim = ctx.createGain()
  trim.gain.value = dbToGain(-limiterMakeupDb())
  gain.connect(limiter)
  limiter.connect(trim)
  trim.connect(ctx.destination)

  let current = initialDb
  return {
    input: gain,
    get gainDb() {
      return current
    },
    setGainDb(db: number) {
      if (db === current) return
      current = db
      gain.gain.setTargetAtTime(dbToGain(db), ctx.currentTime, MASTER_RAMP_TAU_S)
    },
  }
}

const buses = new WeakMap<object, MasterBus>()
/** The level, and who set it: only its owner's release puts it back to 0 dB. */
let level: { db: number; owner: object | null } = { db: 0, owner: null }

function canBuild(ctx: Partial<MasterContextLike>): ctx is MasterContextLike {
  return typeof ctx.createGain === 'function' && typeof ctx.createDynamicsCompressor === 'function'
}

/** Where a preview source on `ctx` connects: the context's bus, built once at the current level. */
export function masterInput(ctx: Pick<MasterContextLike, 'destination'> & Partial<MasterContextLike>): AudioNode {
  if (!canBuild(ctx)) return ctx.destination
  let bus = buses.get(ctx)
  if (!bus) {
    bus = createMasterBus(ctx, level.db)
    buses.set(ctx, bus)
  }
  return bus.input
}

/**
 * The delay the bus adds on `ctx`, in seconds: the limiter's look-ahead once
 * `ctx` has a bus (every engine source connects through `masterInput`), 0 for
 * a context that plays straight to its destination. A clock that takes the
 * output latency off its picture time adds this to it.
 */
export function masterBusLatencyS(ctx: object | null | undefined): number {
  return ctx && buses.has(ctx) ? LIMITER_LOOKAHEAD_S : 0
}

/** Set the preview's level (dB) on the shared context's bus, ramped. `owner` is whoever answers for it. */
export function setMasterLevel(owner: object | null, db: number): void {
  level = { db, owner }
  const ctx = peekSharedAudioContext()
  if (ctx) buses.get(ctx)?.setGainDb(db)
}

/** Back to 0 dB, if `owner` set the current level. */
export function releaseMasterLevel(owner: object): void {
  if (level.owner === owner) setMasterLevel(null, 0)
}

/** The level last asked for, dB. */
export function masterLevelDb(): number {
  return level.db
}
