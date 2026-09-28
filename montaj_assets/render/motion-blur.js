// Sub-frame motion blur: capture N evenly spaced sub-frames per output frame
// and average them. settings.motionBlur absent or 1 = off.
export const MOTION_BLUR_MAX = 8

export function resolveMotionBlur(value) {
  if (value === undefined || value === null) return 1
  if (!Number.isInteger(value) || value < 1 || value > MOTION_BLUR_MAX) {
    throw new Error(`settings.motionBlur must be an integer from 1 to ${MOTION_BLUR_MAX}, got ${JSON.stringify(value)}`)
  }
  return value
}

export function subframeTimes(frame, n) {
  return Array.from({ length: n }, (_, i) => frame + i / n)
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
export function motionBlurFilter(n, { alpha = false } = {}) {
  if (n <= 1) return null
  const select = `select='eq(mod(n\\,${n})\\,${n - 1})',setpts=PTS-STARTPTS`
  if (alpha) return `premultiply=inplace=1,tmix=frames=${n},unpremultiply=inplace=1,${select}`
  return `tmix=frames=${n},${select}`
}
