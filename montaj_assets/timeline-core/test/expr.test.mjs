import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compileTrackExpr, compileTrackExprInfo, sampleTrack, EASING_NAMES, MAX_SEGMENTS } from '../index.js'

/** Evaluate a compiled expression at `t`. See the helper's header on why this is real. */
import { evalExpr } from './helpers/eval-expr.mjs'

describe('compileTrackExpr — parity with sampleTrack', () => {
  const track = (points) => ({ prop: 'offsetX', points })

  test('every easing stays within tolerance across the whole span', () => {
    for (const easing of EASING_NAMES) {
      const tr = track([{ t: 0, value: 0, easing }, { t: 3, value: 25 }])
      const expr = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 / 19.2 })
      for (let t = 0; t <= 3; t += 1 / 120) {
        const want = sampleTrack(tr, t)
        const got = evalExpr(expr, t)
        assert.ok(Math.abs(got - want) <= 0.02,
          `${easing} @ t=${t.toFixed(3)}: expr ${got} vs curve ${want}`)
      }
    }
  })

  test('holds the first and last value outside the span, like sampleTrack', () => {
    const tr = track([{ t: 1, value: 4 }, { t: 2, value: 8 }])
    const expr = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 })
    assert.equal(evalExpr(expr, 0), 4)
    assert.equal(evalExpr(expr, 0.5), 4)
    assert.equal(evalExpr(expr, 3), 8)
  })

  test('a single point compiles to that constant', () => {
    const expr = compileTrackExpr(track([{ t: 1, value: 5 }]), { pixelTolerance: 0.25, unitsPerPixel: 1 })
    assert.equal(evalExpr(expr, 0), 5)
    assert.equal(evalExpr(expr, 9), 5)
  })

  test("'hold' produces a genuine step, not a ramp", () => {
    const tr = track([{ t: 0, value: 0, easing: 'hold' }, { t: 2, value: 10 }])
    const expr = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 })
    assert.equal(evalExpr(expr, 1.99), 0)
    assert.equal(evalExpr(expr, 2), 10)
  })

  test('a tighter tolerance costs more segments, and both stay in tolerance', () => {
    const tr = track([{ t: 0, value: 0, easing: 'ease-in-out' }, { t: 3, value: 100 }])
    const coarse = compileTrackExpr(tr, { pixelTolerance: 2, unitsPerPixel: 1 })
    const fine = compileTrackExpr(tr, { pixelTolerance: 0.05, unitsPerPixel: 1 })
    assert.ok(fine.length > coarse.length)
    for (const [label, expr, tol] of [['coarse', coarse, 2], ['fine', fine, 0.05]]) {
      for (let t = 0; t <= 3; t += 1 / 120) {
        assert.ok(Math.abs(evalExpr(expr, t) - sampleTrack(tr, t)) <= tol * 1.05,
          `${label} @ t=${t.toFixed(3)} outside its own tolerance`)
      }
    }
  })

  test('emits nothing that would break a filtergraph', () => {
    const expr = compileTrackExpr(track([{ t: 0, value: 0 }, { t: 1, value: 10 }]), { pixelTolerance: 0.25, unitsPerPixel: 1 })
    assert.ok(!/[\n\r ]/.test(expr), 'no whitespace or newlines')
  })

  test('segment count stays bounded on a pathological curve', () => {
    // Guards against an adaptive subdivider that runs away and emits a
    // thousand-arm expression nobody can debug.
    const tr = track([{ t: 0, value: 0, easing: 'ease-in-out' }, { t: 30, value: 5000 }])
    const expr = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 })
    assert.ok((expr.match(/between/g) ?? []).length <= 64, 'subdivision must cap')
  })

  test('a starved budget degrades EVENLY, never abandoning a whole interval', () => {
    // The global-greedy guarantee. A track with many eased intervals, forced
    // well past MAX_SEGMENTS: every interval must still be approximated, none
    // left as a single straight chord. Per-interval budgeting would pass the
    // cap test above while failing this one — which is the whole point.
    const points = []
    for (let i = 0; i <= 20; i++) points.push({ t: i, value: i % 2 ? 100 : 0, easing: 'ease-in-out' })
    const expr = compileTrackExpr(track(points), { pixelTolerance: 0.001, unitsPerPixel: 1 })
    for (let t = 0.5; t < 20; t += 1) {
      const want = sampleTrack(track(points), t)
      assert.ok(Math.abs(evalExpr(expr, t) - want) < 25,
        `interval containing t=${t} looks abandoned, not merely coarse`)
    }
  })
})

describe('compileTrackExprInfo — the diagnostics the render path warns from', () => {
  const track = (points) => ({ prop: 'offsetX', points })

  test('an unreachable tolerance reports capped, and says how far off it landed', () => {
    const points = []
    for (let i = 0; i <= 20; i++) points.push({ t: i, value: i % 2 ? 100 : 0, easing: 'ease-in-out' })
    const info = compileTrackExprInfo(track(points), { pixelTolerance: 0.0001, unitsPerPixel: 1 })
    assert.equal(info.capped, true)
    assert.equal(info.segments, MAX_SEGMENTS)
    assert.ok(info.maxError > info.tolerance)
  })

  test('a tolerance it can meet reports NOT capped', () => {
    const tr = track([{ t: 0, value: 0, easing: 'ease-in-out' }, { t: 3, value: 100 }])
    const info = compileTrackExprInfo(tr, { pixelTolerance: 1, unitsPerPixel: 1 })
    assert.equal(info.capped, false)
    assert.ok(info.segments < MAX_SEGMENTS)
    assert.ok(info.maxError <= info.tolerance)
  })

  test('an empty or unusable track compiles to null, so the caller keeps its static value', () => {
    assert.equal(compileTrackExpr(null), null)
    assert.equal(compileTrackExpr(track([])), null)
    assert.equal(compileTrackExpr(track([{ t: NaN, value: 3 }, { t: 1, value: Infinity }])), null)
  })

  test('duplicate and out-of-order timestamps do not hang or emit a degenerate span', () => {
    // `sampleTrack` resolves a zero/negative span by letting the later keyframe
    // win; the compiler must skip that interval rather than divide by zero.
    const tr = track([{ t: 1, value: 0 }, { t: 1, value: 9 }, { t: 2, value: 20 }])
    const expr = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 })
    assert.ok(!/\/0(?![.0-9])/.test(expr), 'no division by a zero span')
    assert.equal(evalExpr(expr, 2), 20)
    assert.equal(Number.isFinite(evalExpr(expr, 1.5)), true)
  })

  test('a track that never moves still round-trips its constant', () => {
    const tr = track([{ t: 0, value: 7 }, { t: 4, value: 7 }])
    const expr = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 })
    for (const t of [-1, 0, 2, 4, 9]) assert.equal(evalExpr(expr, t), 7)
  })
})
