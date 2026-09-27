// montaj_assets/overlay-runtime/springs.test.js
//
// Tests for springStep / springSum (springs.js). Run through `npm test`
// (test.js imports this file) or directly via `node springs.test.js`.
import assert from 'node:assert/strict'
import { springStep, springSum } from './springs.js'

// With fps = 1, frame is seconds: step(t) is the unit response at t seconds.
const step = (t, p = {}) => springStep(t, 1, p)

// ── springStep basics ────────────────────────────────────────────────────────
assert.equal(step(0), 0, 'step(0) must be 0')
assert.equal(step(-1), 0, 'step(-1) must be 0')
assert.ok(Math.abs(step(10) - 1) < 1e-6, `step(10) must settle at 1, got ${step(10)}`)
assert.equal(springStep(5, 30, { from: 3, to: 7, at: 5 }), 3, 'value at the release frame is `from`')
assert.equal(springStep(2, 30, { from: 3, to: 7, at: 5 }), 3, 'value before the release frame is `from`')
assert.ok(Math.abs(springStep(30 * 10, 30, { from: 3, to: 7 }) - 7) < 1e-5, 'settles to `to`')
{
  const f = 17.25, fps = 60
  const want = 3 + (7 - 3) * springStep(f - 4, fps)
  const got = springStep(f, fps, { from: 3, to: 7, at: 4 })
  assert.ok(Math.abs(got - want) < 1e-12, 'from/to/at are an affine map of the unit step')
}

// Underdamped defaults (zeta = 0.5): peak 1 + e^(-pi zeta / sqrt(1 - zeta^2)) at t = pi / wd.
{
  const zeta = 0.5, w0 = 10
  const wd = w0 * Math.sqrt(1 - zeta * zeta)
  const peak = 1 + Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta))
  assert.ok(Math.abs(peak - 1.1630) < 1e-3)
  assert.ok(Math.abs(step(Math.PI / wd) - peak) < 1e-9, `peak mismatch: ${step(Math.PI / wd)} vs ${peak}`)
}

// Critical (damping 20) and overdamped (damping 40): monotonic, never above 1.
for (const damping of [20, 40]) {
  let prev = -Infinity
  for (let i = 0; i <= 3000; i++) {
    const v = step(i / 1000, { damping })
    assert.ok(v >= prev - 1e-15, `damping ${damping}: not monotonic at t=${i / 1000}`)
    assert.ok(v <= 1 + 1e-9, `damping ${damping}: overshoot ${v} at t=${i / 1000}`)
    prev = v
  }
}

// Continuity across zeta = 1.
for (const t of [0.05, 0.1, 0.3, 1]) {
  const c = step(t, { damping: 20 })
  for (const damping of [19.999, 20.001]) {
    assert.ok(Math.abs(step(t, { damping }) - c) < 1e-4, `discontinuity at zeta=1, damping ${damping}, t=${t}`)
  }
  // Extremely close to critical on both sides: no cancellation blow-up.
  for (const damping of [20 - 1e-7, 20 + 1e-7]) {
    assert.ok(Math.abs(step(t, { damping }) - c) < 1e-6, `near-critical instability, damping ${damping}, t=${t}`)
  }
}

// Heavily overdamped for a long time: finite, not NaN (no cosh/sinh overflow).
{
  const v = step(100, { damping: 400, stiffness: 100 })
  assert.ok(Number.isFinite(v) && v > 0 && v <= 1, `heavy overdamping must stay finite, got ${v}`)
}

// Against an RK4 reference integration (dt = 1e-5), all regimes, v0 = 0 and 5.
function rk4Reference(tEnd, { mass = 1, stiffness = 100, damping = 10, initialVelocity = 0 }) {
  const dt = 1e-5
  const n = Math.round(tEnd / dt)
  let x = 0, v = initialVelocity
  const acc = (x, v) => (-stiffness * (x - 1) - damping * v) / mass
  for (let i = 0; i < n; i++) {
    const k1x = v,                  k1v = acc(x, v)
    const k2x = v + k1v * dt / 2,   k2v = acc(x + k1x * dt / 2, v + k1v * dt / 2)
    const k3x = v + k2v * dt / 2,   k3v = acc(x + k2x * dt / 2, v + k2v * dt / 2)
    const k4x = v + k3v * dt,       k4v = acc(x + k3x * dt, v + k3v * dt)
    x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x)
    v += (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)
  }
  return x
}
for (const damping of [10, 20, 40]) {
  for (const initialVelocity of [0, 5]) {
    for (const t of [0.01, 0.1, 0.25, 0.5, 1, 2]) {
      const p = { damping, initialVelocity }
      const got = step(t, p)
      const want = rk4Reference(t, p)
      assert.ok(Math.abs(got - want) < 1e-5, `RK4 mismatch ${JSON.stringify(p)} t=${t}: ${got} vs ${want}`)
    }
  }
}

// ── springSum ────────────────────────────────────────────────────────────────
{
  const fps = 30
  // One change equals from + (to - from) * step.
  for (const frame of [0, 3, 10.5, 40, 200]) {
    const got = springSum({ frame, fps, from: 2, changes: [{ at: 3, to: 5 }] })
    const want = 2 + (5 - 2) * springStep(frame - 3, fps)
    assert.ok(Math.abs(got - want) < 1e-12, `single-change sum mismatch at ${frame}`)
  }

  // Two changes settle to the last `to`.
  const two = { fps, changes: [{ at: 0, to: 1 }, { at: 30, to: 0.5 }], stiffness: 300, damping: 18 }
  assert.ok(Math.abs(springSum({ frame: 600, ...two }) - 0.5) < 1e-9, 'two changes must settle at the last to')

  // Between changes equals the hand-computed two-term sum.
  {
    const frame = 37.5
    const p = { stiffness: 300, damping: 18 }
    const want = 0 + 1 * springStep(frame, fps, p) + (0.5 - 1) * springStep(frame - 30, fps, p)
    assert.ok(Math.abs(springSum({ frame, ...two }) - want) < 1e-12, 'two-term sum mismatch')
  }

  // Order of `changes` does not matter.
  {
    const changes = [{ at: 0, to: 1 }, { at: 20, to: 0.2 }, { at: 45, to: 0.8 }, { at: 70, to: 0 }]
    const shuffled = [changes[2], changes[0], changes[3], changes[1]]
    for (const frame of [0, 5, 21, 46.25, 71, 150]) {
      assert.ok(
        Object.is(springSum({ frame, fps, changes }), springSum({ frame, fps, changes: shuffled })),
        `shuffled changes differ at frame ${frame}`,
      )
    }
  }

  // Purity: evaluation order does not change any value.
  {
    const evalIn = (order) => Object.fromEntries(order.map((f) => [f, springSum({ frame: f, ...two })]))
    const a = evalIn([90, 10, 50])
    const b = evalIn([10, 50, 90])
    for (const f of [10, 50, 90]) assert.ok(Object.is(a[f], b[f]), `purity: frame ${f} depends on evaluation order`)
    assert.ok(Object.is(springStep(90, fps), (springStep(10, fps), springStep(90, fps))), 'springStep purity')
  }

  // Fractional frames: 10.5 lies strictly between 10 and 11 on a rising segment.
  {
    const p = { fps, changes: [{ at: 0, to: 1 }], stiffness: 100, damping: 20 }
    const v10 = springSum({ frame: 10, ...p })
    const v105 = springSum({ frame: 10.5, ...p })
    const v11 = springSum({ frame: 11, ...p })
    assert.ok(v10 < v105 && v105 < v11, `fractional frame not interpolated: ${v10} ${v105} ${v11}`)
  }

  // A change in the future contributes 0.
  {
    const now = springSum({ frame: 12, fps, changes: [{ at: 0, to: 1 }] })
    const withFuture = springSum({ frame: 12, fps, changes: [{ at: 0, to: 1 }, { at: 60, to: -5 }] })
    assert.ok(Object.is(now, withFuture), 'future change must contribute 0')
  }

  // Empty changes: constant `from`.
  assert.equal(springSum({ frame: 40, fps, from: 0.3 }), 0.3)

  // Per-change overrides fall back to the top-level defaults.
  {
    const got = springSum({ frame: 12, fps, changes: [{ at: 0, to: 1, damping: 40 }], stiffness: 200 })
    const want = springStep(12, fps, { stiffness: 200, damping: 40 })
    assert.ok(Math.abs(got - want) < 1e-12, 'per-change override mismatch')
  }
}

// ── Input validation ─────────────────────────────────────────────────────────
assert.throws(() => springStep(NaN, 30), /frame must be a finite number/)
assert.throws(() => springStep(1, 0), /fps must be > 0/)
assert.throws(() => springStep(1, Infinity), /fps must be a finite number/)
assert.throws(() => springStep(1, 30, { to: NaN }), /to must be a finite number/)
assert.throws(() => springStep(1, 30, { mass: 0 }), /mass must be > 0/)
assert.throws(() => springSum({ frame: 1 }), /fps must be a finite number/)
assert.throws(() => springSum({ frame: undefined, fps: 30 }), /frame must be a finite number/)
assert.throws(() => springSum({ frame: 1, fps: -1 }), /fps must be > 0/)
assert.throws(() => springSum({ frame: 1, fps: 30, changes: [{ to: 1 }] }), /changes\[0\]\.at/)
assert.throws(() => springSum({ frame: 1, fps: 30, changes: [{ at: 0, to: 'x' }] }), /changes\[0\]\.to/)
assert.throws(() => springSum({ frame: 1, fps: 30, changes: [null] }), /changes\[0\]/)

console.log('overlay-runtime: springStep / springSum OK')
