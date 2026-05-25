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
 * @param {Object} params
 * @param {number}  params.frame               - Current frame number
 * @param {number}  params.fps                 - Frames per second of the output video
 * @param {number}  [params.mass=1]            - Spring mass
 * @param {number}  [params.stiffness=100]     - Spring stiffness (higher = snappier)
 * @param {number}  [params.damping=10]        - Damping (higher = less bounce)
 * @param {number}  [params.initialVelocity=0] - Starting velocity
 * @returns {number}
 */
export function spring({
  frame,
  fps,
  mass = 1,
  stiffness = 100,
  damping = 10,
  initialVelocity = 0,
}) {
  const dt = 1 / fps
  let x = 0
  let v = initialVelocity

  for (let f = 0; f < frame; f++) {
    // Spring force: pulls x toward equilibrium at 1
    const force = -stiffness * (x - 1) - damping * v
    const a = force / mass
    v += a * dt
    x += v * dt
  }

  return x
}
