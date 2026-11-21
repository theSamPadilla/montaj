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
 *   export const version: string          // goes into the segment-cache key
 *   export async function captureChunk({ page, job, cuts, frameTimes, write, onFrame, log }): Promise<void>
 *
 * No host configured, or one that fails to load, fails the chunk with
 * `cinematic_unavailable`: a cinematic render never falls back silently.
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

/** The project's 3D look: 'cinematic' when asked for, else 'standard'. */
export function look3dOf(settings) {
  return settings?.look3d === LOOK3D_CINEMATIC ? LOOK3D_CINEMATIC : 'standard'
}

/** The host module, loaded once per process; null when none is configured. */
export async function scene3dHost(env = process.env) {
  const path = env[SCENE3D_NATIVE_ENV] || null
  if (!path) return null
  if (hostPromise && hostPath === path) return hostPromise
  hostPath = path
  hostPromise = import(path).catch((err) => {
    hostPromise = null
    throw new CinematicUnavailableError(`The path-traced renderer could not be loaded: ${err?.message ?? err}`)
  })
  return hostPromise
}

/** The host's version for the segment-cache key, or null when none is set (sync: read from the env). */
export function scene3dHostKey(env = process.env) {
  const path = env[SCENE3D_NATIVE_ENV] || null
  return path ? `${path}#${env.MONTAJ_SCENE3D_NATIVE_KEY || ''}` : null
}
