/**
 * §190 T5: the preview mixer under the `<video>` path.
 *
 * Here the `<video>` stays the master clock and the MixClock FOLLOWS it: play,
 * pause and seek are forwarded, and while playing the mixer is re-seeked
 * whenever it drifts more than `MIX_DRIFT_S` from the video's project time.
 * Clip speed is not forwarded: it is already in the plan, so the mixer's own
 * rate stays 1, as the project's does in this path.
 *
 * Same rules as the engine's `createMixerControl` (engine/index.ts, which this
 * mirrors; keep the two in step): the mixer is built from the same conform
 * client and plan builder; a source's conform is admitted, and the mode
 * switches, only while paused or at a seek, never mid-play; a rejecting
 * `createMixClock` leaves the session on today's path for good. In mixer mode
 * (`unconformedMain` empty) the hook mutes the main-track `<video>`s and drops
 * the `<audio>` of every lane the plan covers (`MixerState`).
 */
import { MIX_DROP_DELAY_MS, NO_MIXER, type MixerState } from '../../engine'
import { audioSourcePaths, buildMixPlan, type ConformLookup, type ProjectMixPlan } from '../../engine/mix/audio-plan'
import { createConformClient, type ConformClient } from '../../engine/mix/conform-client'
import { createMixClock, type MixClock, type MixClockOptions, type MixParam, type MixPlan } from '../../engine/mix/mix-clock'
import type { EditorProject as Project } from '../../schema'

/** Re-sync the mixer to the video when they differ by more than this. */
export const MIX_DRIFT_S = 0.04

const EMPTY_PLAN: MixPlan = { segments: [] }

export interface LegacyMixerDeps {
  /** Default `createMixClock`. Rejecting keeps the session on today's path. */
  createMixClock?: (options: MixClockOptions) => Promise<MixClock>
  /** Default `buildMixPlan`. Throwing is "no plan", which is today's path. */
  buildMixPlan?: (project: Project, lookup: ConformLookup) => ProjectMixPlan
  audioSourcePaths?: (project: Project) => string[]
  /** Default a same-origin `createConformClient()`, which this disposes. An injected one is the caller's. */
  conform?: ConformClient
}

export interface LegacyMixerHost {
  /** The video transport. */
  playing(): boolean
  /** The video's project time. */
  time(): number
  project(): Project
  /** What the mixer carries, whenever that changes. */
  onChange(state: MixerState): void
  onError?(message: string): void
}

export interface LegacyMixer {
  /** The video started or stopped. */
  setPlaying(playing: boolean, projectS: number): void
  /** The video was seeked (the other moment a switch may happen while playing). */
  seek(projectS: number): void
  /** While playing: re-sync the mixer if it drifted from the video's time. */
  follow(projectS: number): void
  setVolume(volume: number): void
  projectChanged(project: Project): void
  dispose(): void
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createLegacyMixer(deps: LegacyMixerDeps, host: LegacyMixerHost): LegacyMixer {
  const buildPlan = deps.buildMixPlan ?? buildMixPlan
  const sourcePaths = deps.audioSourcePaths ?? audioSourcePaths
  let clock: MixClock | null = null
  let conform: ConformClient | null = null
  let ownsConform = false
  let unsubscribe: (() => void) | null = null
  let disposed = false
  let built: ProjectMixPlan | null = null
  let inMixer = false
  let volume = 1
  let postedPlan: string | null = null
  let postedIds = new Set<string>()
  /** Segments muted on their way out; the worklet keeps an override across plans, so a return clears it. */
  const fadedOut = new Set<string>()
  let pendingPlan: { key: string; timer: ReturnType<typeof setTimeout> } | null = null
  let rebuildQueued = false
  let admitPending = false
  let published = 'off'
  const requested = new Set<string>()
  const admitted = new Set<string>()

  let lastFault = ''
  const fault = (what: string, err: unknown) => {
    const message = `preview mixer: ${what}: ${messageOf(err)}`
    if (message === lastFault) return
    lastFault = message
    host.onError?.(message)
  }

  const lookup: ConformLookup = (src) => (admitted.has(src) ? (conform?.lookup(src) ?? null) : null)

  const admit = () => {
    admitPending = false
    if (!conform) return
    for (const path of requested) if (conform.lookup(path)) admitted.add(path)
  }

  const request = (project: Project) => {
    if (!conform) return
    let paths: string[]
    try {
      paths = sourcePaths(project)
    } catch (err) {
      fault('audio sources', err)
      return
    }
    for (const path of paths) requested.add(path)
    conform.request(paths)
  }

  const sendPlan = (plan: MixPlan, key: string) => {
    pendingPlan = null
    if (!clock || disposed) return
    postedPlan = key
    postedIds = new Set(plan.segments.map((s) => s.id))
    clock.setPlan(plan)
  }

  /** A dropped segment is muted first (it ramps), then the plan follows. */
  const postPlan = (plan: MixPlan) => {
    if (!clock) return
    const key = JSON.stringify(plan)
    if (key === (pendingPlan?.key ?? postedPlan)) return
    if (pendingPlan) clearTimeout(pendingPlan.timer)
    pendingPlan = null
    const ids = new Set(plan.segments.map((s) => s.id))
    const params: Record<string, MixParam> = {}
    for (const id of fadedOut) {
      if (!ids.has(id)) continue
      params[id] = { mute: false }
      fadedOut.delete(id)
    }
    let dropping = false
    if (clock.playing) {
      for (const id of postedIds) {
        if (ids.has(id) || fadedOut.has(id)) continue
        params[id] = { mute: true }
        fadedOut.add(id)
        dropping = true
      }
    }
    if (Object.keys(params).length > 0) clock.setParams(params)
    if (!dropping) {
      sendPlan(plan, key)
      return
    }
    pendingPlan = { key, timer: setTimeout(() => sendPlan(plan, key), MIX_DROP_DELAY_MS) }
  }

  const publish = () => {
    const state: MixerState =
      inMixer && built
        ? {
            active: true,
            unconformedLanes: new Set(built.unconformedLanes),
            unconformedOverlays: new Set(built.unconformedOverlays),
          }
        : NO_MIXER
    const key = state.active
      ? JSON.stringify([[...state.unconformedLanes].sort(), [...state.unconformedOverlays].sort()])
      : 'off'
    if (key === published) return
    published = key
    host.onChange(state)
  }

  /** Into or out of mixer mode when the plan says so: while paused, or at a seek. */
  const settle = (atSeek: boolean) => {
    if (!clock) return
    const want = !!built && built.unconformedMain.length === 0
    if (want === inMixer || (!atSeek && host.playing())) return
    inMixer = want
    if (want) {
      postPlan(built!.plan)
      clock.setVolume(volume)
      clock.seek(host.time())
      if (host.playing()) clock.play()
    } else {
      clock.pause()
      postPlan(EMPTY_PLAN)
    }
    publish()
  }

  const rebuild = (atSeek = false) => {
    rebuildQueued = false
    if (disposed || !clock) return
    try {
      built = buildPlan(host.project(), lookup)
    } catch (err) {
      built = null
      fault('plan', err)
    }
    settle(atSeek)
    if (inMixer && built) postPlan(built.plan)
    publish()
  }

  const queueRebuild = () => {
    if (rebuildQueued || disposed) return
    rebuildQueued = true
    queueMicrotask(() => {
      if (rebuildQueued) rebuild()
    })
  }

  const onConform = () => {
    if (host.playing()) {
      admitPending = true
      return
    }
    admit()
    queueRebuild()
  }

  const create = deps.createMixClock ?? createMixClock
  void Promise.resolve()
    .then(() => create({ startTime: host.time(), onError: host.onError }))
    .then(
      (mix) => {
        if (disposed) {
          mix.dispose()
          return
        }
        clock = mix
        if (deps.conform) {
          conform = deps.conform
        } else {
          conform = createConformClient()
          ownsConform = true
        }
        unsubscribe = conform.onChange(onConform)
        request(host.project())
        admit()
        rebuild()
      },
      () => {
        // A capability the browser lacks, not a fault: today's path is the answer.
      },
    )

  return {
    setPlaying(playing, projectS) {
      if (playing) {
        if (rebuildQueued) rebuild()
        if (!inMixer || !clock) return
        if (Math.abs(clock.now() - projectS) > MIX_DRIFT_S) clock.seek(projectS)
        clock.play()
        return
      }
      if (inMixer) clock?.pause()
      if (admitPending) {
        admit()
        rebuild()
      } else {
        settle(false)
      }
    },
    seek(projectS) {
      const was = inMixer
      if (admitPending) {
        admit()
        rebuild(true)
      } else {
        settle(true)
      }
      // A switch in already seeked and started it.
      if (inMixer && was) clock?.seek(projectS)
    },
    follow(projectS) {
      if (!inMixer || !clock || !clock.playing) return
      if (Math.abs(clock.now() - projectS) > MIX_DRIFT_S) clock.seek(projectS)
    },
    setVolume(next) {
      volume = next
      if (inMixer) clock?.setVolume(next)
    },
    projectChanged(project) {
      if (!clock) return
      request(project)
      queueRebuild()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (pendingPlan) clearTimeout(pendingPlan.timer)
      pendingPlan = null
      unsubscribe?.()
      if (ownsConform) conform?.dispose()
      clock?.dispose()
      clock = null
    },
  }
}
