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
