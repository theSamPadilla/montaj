// Sub-frame motion blur: capture N evenly spaced sub-frames per output frame
// and average them. settings.motionBlur absent, 0 or 1 = off: 0 reads as "no
// blur" to anyone writing a project (some recipes said so, and saved projects
// carry it), so it renders as 1 rather than failing the render.
export const MOTION_BLUR_MAX = 8

export function resolveMotionBlur(value) {
  if (value === undefined || value === null || value === 0) return 1
  if (!Number.isInteger(value) || value < 1 || value > MOTION_BLUR_MAX) {
    throw new Error(`settings.motionBlur must be an integer from 0 to ${MOTION_BLUR_MAX} (0 or 1 is off), got ${JSON.stringify(value)}`)
  }
  return value
}

export function subframeTimes(frame, n) {
  return Array.from({ length: n }, (_, i) => frame + i / n)
}

// §390: a 3D overlay's shutter is centred on the frame and half a frame long (a
// 180-degree shutter): n samples at the midpoints of n equal parts of
// [frame - 1/4, frame + 1/4], so frame - 0.2 to frame + 0.2 for 5. The trailing
// shutter above runs 0.8 of a frame past the frame time, which on a 3D camera
// cut blended the next shot into the last frame before it. `cuts` are the
// frames at which the overlay's camera cuts (cameraCutFrames): the window is
// narrowed to the shot the frame is in, so no sub-frame shows another shot. It
// never starts before frame 0, the item's first frame. Midpoints keep every
// sample strictly inside the window, never on a cut.
export const SHUTTER_3D = 0.5

export function shutterTimes(frame, n, cuts = []) {
  if (n <= 1) return [frame]
  let lo = Math.max(0, frame - SHUTTER_3D / 2), hi = frame + SHUTTER_3D / 2
  for (const c of cuts) {
    if (c <= frame) lo = Math.max(lo, c)
    else { hi = Math.min(hi, c); break }
  }
  return Array.from({ length: n }, (_, i) => lo + ((i + 0.5) / n) * (hi - lo))
}

// The camera cuts a 3D page reports (__montajCameraCuts: segment frames,
// fractional) as shutterTimes takes them: finite, ascending, and a cut within
// 1e-6 of a whole frame on it, so the frame the engine draws as the new shot's
// first is the first frame of its span, not the last of the shot before.
export function cameraCutFrames(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(Number.isFinite).map(c => (Math.abs(c - Math.round(c)) < 1e-6 ? Math.round(c) : c)).sort((a, b) => a - b)
}

// Which shutter a render job's frames take: `job.shutter` when the job names
// one, else 'centred' for a 3D overlay (render.js scene3d) and 'trailing' for
// everything else. A 3D chunk restarted for sub-frame capture keeps its shutter.
export function shutterOf(job) {
  return job.shutter ?? (job.scene3d === true ? 'centred' : 'trailing')
}

// The sub-frame times of `frame` for `job` (its `subframes`), by its shutter.
export function frameTimes(job, frame, cuts = []) {
  const n = job.subframes ?? 1
  return shutterOf(job) === 'centred' ? shutterTimes(frame, n, cuts) : subframeTimes(frame, n)
}

// Input is the sub-frame PNG sequence read at fps*n. tmix averages the last n
// frames; select keeps the last of each group of n (so each kept frame is the
// mean of exactly one output frame's sub-frames). The kept frames are already
// 1/fps apart; setpts=PTS-STARTPTS only removes the (n-1)/(fps*n) start
// offset. Do NOT use setpts=N/FRAME_RATE/TB: FRAME_RATE is still the sub-frame
// rate there, which would shorten the clip n times.
//
// alpha: the capture has a transparent background. Averaging straight-alpha
// RGBA mixes the transparent pixels' black RGB into the edges (dark fringes on
// composite), so average premultiplied colour and unpremultiply afterwards.
// renderer.js runs the alpha graph with -reinit_filter 0, which is safe only
// while a converter heads the graph: premultiply's planar-only input puts one
// there. Keep one first if this changes.
export function motionBlurFilter(n, { alpha = false } = {}) {
  if (n <= 1) return null
  const select = `select='eq(mod(n\\,${n})\\,${n - 1})',setpts=PTS-STARTPTS`
  if (alpha) return `premultiply=inplace=1,tmix=frames=${n},unpremultiply=inplace=1,${select}`
  return `tmix=frames=${n},${select}`
}
