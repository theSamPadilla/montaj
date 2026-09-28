/**
 * Map a frame number to an output value across one or more input/output segments.
 * Supports multi-stop ranges: inputRange and outputRange must be equal length (>=2).
 *
 * @param {number}   frame
 * @param {number[]} inputRange   - e.g. [0, 15, 30]
 * @param {number[]} outputRange  - e.g. [0, 1, 0]
 * @param {{ extrapolate?: 'clamp' | 'extend' }} [options]
 * @returns {number}
 */
export function interpolate(frame, inputRange, outputRange, { extrapolate = 'clamp' } = {}) {
  if (inputRange.length < 2 || inputRange.length !== outputRange.length) {
    throw new Error(
      'interpolate: inputRange and outputRange must each have at least 2 values and be equal length'
    )
  }

  // Find the segment that contains `frame`
  let lo = 0
  for (let i = 0; i < inputRange.length - 2; i++) {
    if (frame >= inputRange[i + 1]) lo = i + 1
  }

  const inLo  = inputRange[lo]
  const inHi  = inputRange[lo + 1]
  const outLo = outputRange[lo]
  const outHi = outputRange[lo + 1]

  let t = inHi === inLo ? 1 : (frame - inLo) / (inHi - inLo)

  if (extrapolate === 'clamp') t = Math.max(0, Math.min(1, t))

  return outLo + t * (outHi - outLo)
}

/**
 * Physics-based spring animation.
 * Returns a value travelling from 0 toward 1 — overshoots and settles naturally.
 * Deterministic: same frame + same params = same output.
 *
 * Memoized damped-spring integration. Same Euler steps as always (bit-identical
 * output), but each parameter set caches its step history so per-frame calls
 * during playback/render are O(1) amortized instead of re-integrating from 0.
 *
 * @param {Object} params
 * @param {number}  params.frame               - Current frame number
 * @param {number}  params.fps                 - Frames per second of the output video
 * @param {number}  [params.mass=1]            - Spring mass
 * @param {number}  [params.stiffness=100]     - Spring stiffness (higher = snappier)
 * @param {number}  [params.damping=10]        - Damping (higher = less bounce)
 * @param {number}  [params.initialVelocity=0] - Starting velocity
 * @returns {number}
 */
const _springCache = new Map()

function springAt({
  frame,
  fps,
  mass = 1,
  stiffness = 100,
  damping = 10,
  initialVelocity = 0,
}) {
  const key = `${fps}|${mass}|${stiffness}|${damping}|${initialVelocity}`
  let s = _springCache.get(key)
  if (!s) {
    s = { hist: [0], v: initialVelocity }
    _springCache.set(key, s)
  }
  const n = Math.max(0, Math.ceil(frame))
  const dt = 1 / fps
  while (s.hist.length <= n) {
    let x = s.hist[s.hist.length - 1]
    // Spring force: pulls x toward equilibrium at 1
    const force = -stiffness * (x - 1) - damping * s.v
    s.v += (force / mass) * dt
    x += s.v * dt
    s.hist.push(x)
  }
  return s.hist[n]
}

/**
 * `spring()` itself, fractional-frame aware.
 *
 * `springAt` (above) is indexed by `Math.ceil(frame)`, so every fractional
 * frame used to quantize UP to the next whole frame's value. That's invisible
 * at integer frames (normal playback/render), but with `settings.motionBlur`
 * above 1 the renderer samples several fractional sub-frames per output frame
 * — e.g. frame 10.25, 10.5, 10.75 — and quantizing every one of them up to
 * frame 11's value collapses what should be 4 distinct positions into 2,
 * producing a double image when the sub-frames are averaged.
 *
 * Linear interpolation between the two neighbouring whole frames fixes that
 * while leaving every existing integer-frame call byte-identical — `spring()`
 * called at an integer frame still goes straight to `springAt` below, so
 * nothing about the memoized Euler integration changes for non-blurred
 * renders.
 */
export function spring(params) {
  const { frame } = params
  if (Number.isFinite(frame) && frame > 0 && !Number.isInteger(frame)) {
    const lo = Math.floor(frame)
    const a = springAt({ ...params, frame: lo })
    const b = springAt({ ...params, frame: lo + 1 })
    return a + (b - a) * (frame - lo)
  }
  return springAt(params)
}
