/**
 * Physics-based spring animation.
 * Mirrors render/core/spring.js — deterministic, same frame = same output.
 */
export function spring({
  frame,
  fps,
  mass = 1,
  stiffness = 100,
  damping = 10,
  initialVelocity = 0,
}: {
  frame: number
  fps: number
  mass?: number
  stiffness?: number
  damping?: number
  initialVelocity?: number
}): number {
  const dt = 1 / fps
  let x = 0
  let v = initialVelocity

  for (let f = 0; f < frame; f++) {
    const force = -stiffness * (x - 1) - damping * v
    const a = force / mass
    v += a * dt
    x += v * dt
  }

  return x
}
