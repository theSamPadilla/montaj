/**
 * A host that renders a 3D chunk itself (the app's path-traced look).
 *
 * The render stays the same up to the chunk's page: it is loaded, guarded and
 * ready (`window.__setFrame`) exactly as for a capture. For a job marked
 * `cinematic` (render.js: a full 3D shot, `settings.look3d === 'cinematic'`),
 * renderer.js hands that page to the host module named by MONTAJ_SCENE3D_NATIVE
 * instead of screenshotting it. The host steps the page itself, renders each
 * frame, and writes one PNG per output frame through `write`, in order; the
 * chunk encode is unchanged (one capture per frame, as a page that averages its
 * own motion blur).
 *
 * The host module's contract:
 *   export const version: string
 *   export function cacheKey(job): string
 *       Everything about the host that changes a cinematic chunk's pixels: its
 *       renderer and version, the samples the job's `look3dQuality` maps to,
 *       denoising, its look calibration. It is the job's `cinematicKey`
 *       (stampCinematic) and goes into the segment-cache key (segment-cache.js),
 *       so a chunk rendered at another quality or by another renderer is never
 *       reused.
 *   export async function captureChunk({ page, job, cuts, frameTimes, write, onFrame, log }): Promise<void>
 *       `onFrame(info?)` once per frame written. A frame the host rendered just now passes
 *       `{ frame, ms }`: its render time, without the chunk's one-off setup. That is what
 *       the 2-frame test (render.js --cinematic-test) multiplies out. A job marked
 *       `cinematicTest` is such a test: the host keeps nothing of it but the shot's own
 *       one-off state (a metered exposure, say), so a later render reuses that and nothing else.
 *
 * No host configured, or one that fails to load or lacks this contract, fails
 * the render with `cinematic_unavailable` before any chunk is drawn: a
 * cinematic render never falls back silently.
 */
export const SCENE3D_NATIVE_ENV = 'MONTAJ_SCENE3D_NATIVE'
export const LOOK3D_CINEMATIC = 'cinematic'

let hostPromise = null
let hostPath = null

export class CinematicUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.code = 'cinematic_unavailable'
  }
}

// Per-frame render times the host reports (onFrame's `{ frame, ms }`), for --cinematic-test.
const frameListeners = new Set()

/** Hear each cinematic frame's `{ id, frame, ms }`. Returns the unsubscribe. */
export function onCinematicFrame(cb) {
  frameListeners.add(cb)
  return () => frameListeners.delete(cb)
}

/** renderer.js: a host's onFrame info for chunk `id`. A listener that throws never fails the render. */
export function reportCinematicFrame(id, info) {
  if (!info || typeof info.ms !== 'number') return
  for (const cb of [...frameListeners]) {
    try { cb({ id, frame: info.frame, ms: info.ms }) } catch { /* a listener never fails the render */ }
  }
}

/** The project's 3D look: 'cinematic' when asked for, else 'standard'. */
export function look3dOf(settings) {
  return settings?.look3d === LOOK3D_CINEMATIC ? LOOK3D_CINEMATIC : 'standard'
}

/** The quality a cinematic job asks its host for: the project's `look3dQuality`, else 'standard'. The host maps it to samples. */
export function look3dQualityOf(settings) {
  const q = settings?.look3dQuality
  return typeof q === 'string' && /^[a-z0-9-]{1,32}$/.test(q) ? q : 'standard'
}

/** The host module, loaded once per process; null when none is configured. */
export async function scene3dHost(env = process.env) {
  const path = env[SCENE3D_NATIVE_ENV] || null
  if (!path) return null
  if (hostPromise && hostPath === path) return hostPromise
  hostPath = path
  hostPromise = import(path).then((host) => {
    if (typeof host.version !== 'string' || !host.version || typeof host.cacheKey !== 'function' || typeof host.captureChunk !== 'function') {
      throw new Error('it does not export version, cacheKey and captureChunk')
    }
    return host
  }).catch((err) => {
    hostPromise = null
    throw new CinematicUnavailableError(`The path-traced renderer could not be loaded: ${err?.message ?? err}`)
  })
  return hostPromise
}

/**
 * Stamps every cinematic spec with its host's `cinematicKey` before any chunk is
 * planned or looked up in the cache. Fails with cinematic_unavailable when a spec
 * is cinematic and no host can render it. Specs that are not cinematic are untouched.
 */
export async function stampCinematic(specs, env = process.env) {
  const cine = specs.filter((s) => s.cinematic === true)
  if (!cine.length) return specs
  const host = await scene3dHost(env)
  if (!host) throw new CinematicUnavailableError('The path-traced renderer is not available on this machine.')
  for (const spec of cine) {
    const key = host.cacheKey(spec)
    if (typeof key !== 'string' || !key) throw new CinematicUnavailableError('The path-traced renderer gave no cache key.')
    spec.cinematicKey = `${host.version}|${key}`
  }
  return specs
}
