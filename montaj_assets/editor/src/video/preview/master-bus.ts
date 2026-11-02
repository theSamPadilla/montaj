/**
 * §660: the preview's master bus, so the preview plays at the level the
 * export will.
 *
 * The export levels its whole mix with one loudnorm to `settings.loudness`
 * (render/mix-audio.js `loudnessFilter`: `loudnorm=I=<target>:TP=-1:LRA=11`).
 * The preview mixes the same sources by the same rules, then sends the result
 * through ONE chain on the shared context:
 *
 *     sources → gain → limiter → trim → destination
 *
 *  - **gain** is the level: `target - inputI` dB, where `inputI` is the mix's
 *    integrated loudness measured through the export's own graph
 *    (engine/mix/loudness-client.ts asks serve for it). A static gain is the
 *    part of loudnorm's work that matters for loudness: its dynamic gain
 *    settles on exactly that offset for a mix within its LRA. 0 dB until a
 *    number is known, and whenever there is no target.
 *  - **limiter** stands in for loudnorm's -1 dBTP ceiling, so a raised quiet
 *    mix does not clip on its peaks: a compressor with a hard knee and a high
 *    ratio, just under -1 dBFS, with a fast attack. Its fixed 6 ms look-ahead
 *    (the Web Audio compressor's pre-delay) delays the preview's sound by that
 *    much, well inside lip-sync tolerance.
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

/** The limiter: a hard ceiling just under the export's -1 dBTP. */
export const LIMITER = {
  thresholdDb: -1.5,
  kneeDb: 0,
  ratio: 20,
  attackS: 0.001,
  releaseS: 0.1,
} as const

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
