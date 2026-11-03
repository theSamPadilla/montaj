/**
 * §660: the preview's loudness level, asked of serve.
 *
 * The export levels its mix by ONE static master gain, `settings.loudness -
 * I` (§697), I the integrated loudness of the speech when the project has
 * speech, else of the whole mix. Serve measures I through the export's own
 * graph (`POST /api/projects/{id}/mix-loudness`, `serve/routes/audio.py` over
 * `serve/mix_loudness.py` and render/mix-loudness.js, the same function the
 * export takes its gain from), and the preview plays at `target - inputI` dB
 * (video/preview/master-bus.ts), so preview and export play at one level.
 *
 * What this module leans on from serve:
 *
 *  - The POST starts the measurement, joins it, or answers from serve's cache
 *    (keyed by everything that changes the mix), so the same request is also
 *    the poll. `status` is `running`, `ready` (with `inputI` and `targetI`),
 *    `silent`, `failed` or `off`.
 *  - Serve measures project.json as saved. The editor saves each edit as it
 *    lands, so the ask waits `LOUDNESS_DEBOUNCE_MS` after the mix last changed:
 *    long enough for the save, and one ask per settled edit rather than one per
 *    slider step.
 *
 * The level is 0 dB (play as today) for anything but a usable `ready`: no
 * target, a silent mix, a failure, a refused or missing route, a dead serve.
 * While a changed mix is measured, the previous level holds (no dip to 0 dB
 * between two answers); an answer for a mix that has since changed is dropped.
 *
 * A host that points elsewhere passes `apiBase`, or replaces the whole client
 * (EngineMixerDeps.loudness), as it can the conform client.
 */
import type { EditorProject } from '../../schema'
import { buildMixPlan, type ConformLookup } from './audio-plan'

/** How long the mix must stay unchanged before serve is asked. */
export const LOUDNESS_DEBOUNCE_MS = 1500
export const LOUDNESS_POLL_BASE_MS = 500
export const LOUDNESS_POLL_MAX_MS = 4000
/** Past serve's own 300 s job ceiling (`JOB_TIMEOUT_S`): a measurement still running is given up on. */
export const LOUDNESS_GIVE_UP_MS = 6 * 60_000
/** Consecutive transport failures before the level falls back to 0 dB. */
export const LOUDNESS_MAX_ERRORS = 5

/**
 * The clamp. Down: the loudest real mix sits near 0 LUFS and the quietest
 * target is -30 LUFS (render.js accepts -30..-5), so -30 dB covers every
 * honest cut, and a cut can never hurt. Up: +30 dB brings a whisper-quiet
 * -44 LUFS mix to -14. Past that the measurement sits near the -70 LUFS
 * gate, where the "mix" is mostly noise floor, and a wrong number would blast
 * it into the speakers; the limiter caps the peaks, not the hiss. The export
 * clamps its gain the same way (render/mix-audio.js `masterGainDb`).
 */
export const LOUDNESS_MIN_GAIN_DB = -30
export const LOUDNESS_MAX_GAIN_DB = 30

/** The gain (dB) an answer from serve asks for: `targetI - inputI`, clamped; 0 for anything else. */
export function mixGainDb(answer: unknown): number {
  const a = answer as { status?: unknown; inputI?: unknown; targetI?: unknown } | null
  if (!a || typeof a !== 'object' || a.status !== 'ready') return 0
  const { inputI, targetI } = a
  if (typeof inputI !== 'number' || typeof targetI !== 'number') return 0
  if (!Number.isFinite(inputI) || !Number.isFinite(targetI)) return 0
  return Math.min(LOUDNESS_MAX_GAIN_DB, Math.max(LOUDNESS_MIN_GAIN_DB, targetI - inputI))
}

/** Every source conformed: the plan then names every clip and lane, whatever has been fetched. */
const EVERY_SOURCE: ConformLookup = (src) => ({
  url: src,
  format: 'pcm_s16le',
  sampleRate: 48000,
  channels: 2,
  frames: Number.MAX_SAFE_INTEGER,
})

/**
 * What the level depends on, as one string: the target and the mix the
 * preview plays (audio-plan.ts's plan, which holds every rule the export
 * mixes by). Not the conform state: serve measures the sources themselves.
 */
export function mixSignature(project: EditorProject): string {
  const target = project.settings?.loudness ?? null
  let plan: unknown
  try {
    plan = buildMixPlan(project, EVERY_SOURCE).plan
  } catch {
    plan = { tracks: project.tracks, audio: project.audio }
  }
  return JSON.stringify([target, plan])
}

/** The slice of a fetch `Response` this reads. */
export interface LoudnessResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface LoudnessClientOptions {
  projectId: string
  /** Default: the page's `fetch`, same origin. */
  fetch?: (url: string, init: RequestInit) => Promise<LoudnessResponse>
  /** Prefixed to the route. Default `''`. */
  apiBase?: string
  /** Timer seams, for tests. Default `setTimeout`/`clearTimeout`. */
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  debounceMs?: number
  pollBaseMs?: number
  pollMaxMs?: number
  giveUpMs?: number
  maxErrors?: number
}

export interface LoudnessClient {
  /** The project changed. Cheap: nothing is asked unless the mix did. */
  update(project: EditorProject): void
  /** The level now, dB. */
  readonly gainDb: number
  /** Fires on every change of the level. Returns the unsubscribe. */
  onGain(listener: (db: number) => void): () => void
  dispose(): void
}

export function createLoudnessClient(options: LoudnessClientOptions): LoudnessClient {
  const doFetch =
    options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init) as Promise<LoudnessResponse>)
  const url = `${options.apiBase ?? ''}/api/projects/${encodeURIComponent(options.projectId)}/mix-loudness`
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer =
    options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const debounceMs = options.debounceMs ?? LOUDNESS_DEBOUNCE_MS
  const pollBaseMs = options.pollBaseMs ?? LOUDNESS_POLL_BASE_MS
  const pollMaxMs = options.pollMaxMs ?? LOUDNESS_POLL_MAX_MS
  const giveUpMs = options.giveUpMs ?? LOUDNESS_GIVE_UP_MS
  const maxErrors = options.maxErrors ?? LOUDNESS_MAX_ERRORS

  const listeners = new Set<(db: number) => void>()
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let gainDb = 0
  let signature: string | null = null
  /** Bumped on every change of the mix: an answer for an older one is dropped. */
  let gen = 0
  let timer: unknown
  let disposed = false

  const setGain = (db: number) => {
    if (db === gainDb) return
    gainDb = db
    for (const listener of [...listeners]) {
      try {
        listener(db)
      } catch {
        // a listener's failure is its own
      }
    }
  }

  const cancel = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
  }

  const later = (fn: () => void, ms: number) => {
    cancel()
    timer = setTimer(() => {
      timer = undefined
      fn()
    }, ms)
  }

  const ask = async (g: number, delayMs: number, waitedMs: number, errors: number): Promise<void> => {
    if (disposed || g !== gen) return
    let res: LoudnessResponse
    let body: unknown
    try {
      res = await doFetch(url, { method: 'POST', signal: controller?.signal })
      body = res.ok ? await res.json() : undefined
    } catch {
      if (disposed || g !== gen) return
      // A network error, or a 2xx whose body is not JSON (not serve answering).
      if (errors + 1 >= maxErrors) setGain(0)
      else later(() => void ask(g, Math.min(pollMaxMs, delayMs * 2), waitedMs + delayMs, errors + 1), delayMs)
      return
    }
    if (disposed || g !== gen) return
    if (!res.ok) {
      // 4xx: no such route (an older serve) or no such project. 5xx: may clear up.
      if (res.status >= 500 && errors + 1 < maxErrors) {
        later(() => void ask(g, Math.min(pollMaxMs, delayMs * 2), waitedMs + delayMs, errors + 1), delayMs)
      } else {
        setGain(0)
      }
      return
    }
    if ((body as { status?: unknown } | null)?.status === 'running') {
      if (waitedMs >= giveUpMs) setGain(0)
      else later(() => void ask(g, Math.min(pollMaxMs, delayMs * 2), waitedMs + delayMs, 0), delayMs)
      return
    }
    setGain(mixGainDb(body))
  }

  return {
    update(project) {
      if (disposed) return
      const target = project.settings?.loudness
      if (typeof target !== 'number' || !Number.isFinite(target)) {
        // No target: the export applies none, so neither does the preview.
        signature = null
        gen += 1
        cancel()
        setGain(0)
        return
      }
      const next = mixSignature(project)
      if (next === signature) return
      signature = next
      gen += 1
      const g = gen
      later(() => void ask(g, pollBaseMs, 0, 0), debounceMs)
    },
    get gainDb() {
      return gainDb
    },
    onGain(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancel()
      controller?.abort()
      listeners.clear()
    },
  }
}
