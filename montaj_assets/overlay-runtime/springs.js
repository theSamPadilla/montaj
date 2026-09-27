// montaj_assets/overlay-runtime/springs.js
//
// Closed-form damped springs, exposed to overlay JSX as the bare globals
// `springStep` and `springSum`.
//
// Why these exist beside `spring()` (helpers.js):
//   - `spring()` is semi-implicit Euler at dt = 1/fps, memoized per parameter
//     set, and indexed by Math.ceil(frame), so fractional frames quantize up.
//   - It cannot be retargeted: a value that springs to 1, then to 0.5, would
//     need a re-simulation from the retarget point.
//   - Existing overlays depend on its exact output, so it must stay
//     byte-identical and cannot be swapped for a closed form.
//
// These functions evaluate the analytic step response of a linear damped
// spring. They hold no module state and no cache: the value at a frame
// depends only on the arguments, never on which frames were evaluated
// before. Fractional frames are exact.
//
// A spring whose target changes several times is the sum of one step
// response per change (superposition of a linear system driven by a
// piecewise-constant target). That is what `springSum` computes, so a
// retargeting spring is still a pure function of frame.

const DEFAULTS = { mass: 1, stiffness: 100, damping: 10 }

function assertFinite(value, name, fn) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fn}: ${name} must be a finite number, got ${String(value)}`)
  }
}

function checkFrameFps(frame, fps, fn) {
  assertFinite(frame, 'frame', fn)
  assertFinite(fps, 'fps', fn)
  if (fps <= 0) throw new Error(`${fn}: fps must be > 0, got ${fps}`)
}

function checkPhysics(mass, stiffness, damping, initialVelocity, fn) {
  assertFinite(mass, 'mass', fn)
  assertFinite(stiffness, 'stiffness', fn)
  assertFinite(damping, 'damping', fn)
  assertFinite(initialVelocity, 'initialVelocity', fn)
  if (mass <= 0) throw new Error(`${fn}: mass must be > 0, got ${mass}`)
  if (stiffness <= 0) throw new Error(`${fn}: stiffness must be > 0, got ${stiffness}`)
  if (damping < 0) throw new Error(`${fn}: damping must be >= 0, got ${damping}`)
}

/**
 * Unit step response in seconds: position of a damped spring released from 0
 * toward 1 at t = 0 with starting velocity v0 (units per second). 0 for t <= 0.
 *
 * With y = x - 1, y(0) = -1, y'(0) = v0, w0 = sqrt(k/m), zeta = c / (2 sqrt(k m)):
 *   underdamped:  y = e^(-zeta w0 t) (-cos wd t + ((v0 - zeta w0) / wd) sin wd t)
 *   critical:     y = e^(-w0 t) (-1 + (v0 - w0) t)
 *   overdamped:   y = -e^(-zeta w0 t) cosh(b t) + (v0 - zeta w0) e^(-zeta w0 t) sinh(b t) / b
 * The overdamped branch is evaluated through its two real roots in a form
 * that neither cancels near zeta = 1 nor overflows for large t.
 */
function unitStep(t, mass, stiffness, damping, v0) {
  if (!(t > 0)) return 0
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  let y
  if (Math.abs(zeta - 1) < 1e-9) {
    y = Math.exp(-w0 * t) * (-1 + (v0 - w0) * t)
  } else if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    y = Math.exp(-zeta * w0 * t) * (-Math.cos(wd * t) + ((v0 - zeta * w0) / wd) * Math.sin(wd * t))
  } else {
    const s = Math.sqrt(zeta * zeta - 1)
    const b = w0 * s
    // Roots r1 (slow) and r2 (fast); r1 via r1 * r2 = w0^2 avoids cancellation.
    const r2 = -w0 * (zeta + s)
    const r1 = (w0 * w0) / r2
    const e1 = Math.exp(r1 * t)
    const e2 = Math.exp(r2 * t)
    const A = (e1 + e2) / 2 // e^(-zeta w0 t) cosh(b t)
    // e^(-zeta w0 t) sinh(b t) / b; expm1 keeps it exact when b t is small.
    const B = 2 * b * t < 1 ? (e2 * Math.expm1(2 * b * t)) / (2 * b) : (e1 - e2) / (2 * b)
    y = -A + (v0 - zeta * w0) * B
  }
  return 1 + y
}

/**
 * One closed-form spring from `from` to `to`, released at frame `at`.
 * Returns `from` for frame <= at. Same physics parameter names and defaults
 * as `spring()`, but a pure function of (fractional) frame: no memo, no
 * integration, no dependence on evaluation order.
 *
 * @param {number} frame  current frame (may be fractional)
 * @param {number} fps    frames per second, > 0
 * @param {Object} [opts]
 * @param {number} [opts.from=0]             value before release
 * @param {number} [opts.to=1]               target value
 * @param {number} [opts.at=0]               release frame (may be fractional)
 * @param {number} [opts.mass=1]
 * @param {number} [opts.stiffness=100]      higher = snappier
 * @param {number} [opts.damping=10]         higher = less bounce
 * @param {number} [opts.initialVelocity=0]  starting velocity, in (to - from) units per second
 * @returns {number}
 */
export function springStep(frame, fps, {
  from = 0,
  to = 1,
  at = 0,
  mass = DEFAULTS.mass,
  stiffness = DEFAULTS.stiffness,
  damping = DEFAULTS.damping,
  initialVelocity = 0,
} = {}) {
  checkFrameFps(frame, fps, 'springStep')
  assertFinite(from, 'from', 'springStep')
  assertFinite(to, 'to', 'springStep')
  assertFinite(at, 'at', 'springStep')
  checkPhysics(mass, stiffness, damping, initialVelocity, 'springStep')
  return from + (to - from) * unitStep((frame - at) / fps, mass, stiffness, damping, initialVelocity)
}

/**
 * A spring with many target changes, as a pure function of frame.
 *
 *   value = from + sum_i (to_i - to_(i-1)) * step((frame - at_i) / fps, params_i),  to_(-1) = from
 *
 * `changes` may be in any order; they are sorted by `at` (stable) so the
 * result does not depend on how the array was written. A change whose `at`
 * is still in the future contributes 0. Top-level mass/stiffness/damping are
 * the defaults for every change.
 *
 * With the same mass/stiffness/damping on every change this is the exact
 * response of one linear spring whose target jumps at each `at`. Per-change
 * overrides are allowed, but then the sum is a blend of different springs,
 * not one physical spring.
 *
 * @param {Object} params
 * @param {number} params.frame        current frame (may be fractional)
 * @param {number} params.fps          frames per second, > 0
 * @param {number} [params.from=0]     value before the first change
 * @param {Array<{at: number, to: number, mass?: number, stiffness?: number, damping?: number}>} [params.changes=[]]
 * @param {number} [params.mass=1]
 * @param {number} [params.stiffness=100]
 * @param {number} [params.damping=10]
 * @returns {number}
 */
export function springSum({
  frame,
  fps,
  from = 0,
  changes = [],
  mass = DEFAULTS.mass,
  stiffness = DEFAULTS.stiffness,
  damping = DEFAULTS.damping,
} = {}) {
  checkFrameFps(frame, fps, 'springSum')
  assertFinite(from, 'from', 'springSum')
  if (!Array.isArray(changes)) throw new Error('springSum: changes must be an array')
  checkPhysics(mass, stiffness, damping, 0, 'springSum')
  const sorted = changes.map((c, i) => {
    if (c === null || typeof c !== 'object') {
      throw new Error(`springSum: changes[${i}] must be an object with finite at and to`)
    }
    assertFinite(c.at, `changes[${i}].at`, 'springSum')
    assertFinite(c.to, `changes[${i}].to`, 'springSum')
    const m = c.mass ?? mass
    const k = c.stiffness ?? stiffness
    const d = c.damping ?? damping
    checkPhysics(m, k, d, 0, 'springSum')
    return { at: c.at, to: c.to, m, k, d, i }
  }).sort((a, b) => a.at - b.at || a.i - b.i)

  let value = from
  let prev = from
  for (const c of sorted) {
    const delta = c.to - prev
    prev = c.to
    if (delta !== 0) value += delta * unitStep((frame - c.at) / fps, c.m, c.k, c.d, 0)
  }
  return value
}
