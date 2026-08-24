// montaj_assets/timeline-core/test/curves.test.mjs
//
// SP9b-T0.1 suite for curves.js — the keyframe curve solver.
//
// This module is the PARITY LINCHPIN of keyframed animation: the editor
// preview and the ffmpeg render must agree on the value of an animated
// property at every instant, so both read it from here and nothing else
// re-implements easing. That makes this file the contract, and it is written
// the way geometry.test.mjs is: the reference is INLINED from the definition
// (the parametric cubic bezier, plus a deliberately dumb bisection solver),
// never borrowed from the implementation under test. A test that re-used
// curves.js's own Newton-Raphson would prove nothing.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleTrack, normalizeTrack, easeProgress, EASING_NAMES } from '../index.js'

// ---------------------------------------------------------------------------
// Reference implementations, inlined (NOT imported — see header).
// ---------------------------------------------------------------------------

/**
 * The cubic bezier definition itself, on the unit square: P0=(0,0),
 * P1=(x1,y1), P2=(x2,y2), P3=(1,1), at curve PARAMETER s (which is NOT x).
 */
function bezierPoint(x1, y1, x2, y2, s) {
  const u = 1 - s
  const b1 = 3 * u * u * s
  const b2 = 3 * u * s * s
  const b3 = s * s * s
  return { x: b1 * x1 + b2 * x2 + b3, y: b1 * y1 + b2 * y2 + b3 }
}

/**
 * An INDEPENDENT solver: 200 rounds of plain bisection on the parameter,
 * which is far slower and far more accurate than the shipped Newton-Raphson.
 * Its only job is to be obviously correct.
 */
function referenceEase(x1, y1, x2, y2, x) {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (bezierPoint(x1, y1, x2, y2, mid).x < x) lo = mid
    else hi = mid
  }
  return bezierPoint(x1, y1, x2, y2, (lo + hi) / 2).y
}

/** The CSS-named presets' control points, pinned. `hold` is not a bezier and is absent. */
const CONTROL_POINTS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
}

/** The four non-trivial presets — `linear` is short-circuited and is checked separately. */
const BEZIER_NAMES = ['ease', 'ease-in', 'ease-out', 'ease-in-out']

/** Float compare, same helper shape as geometry.test.mjs. */
function closeTo(actual, expected, tolerance, message) {
  assert.equal(typeof actual, 'number', `${message}: expected a number, got ${typeof actual}`)
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ~${expected} (±${tolerance}), got ${actual}`,
  )
}

// ---------------------------------------------------------------------------
// 1. easeProgress — the bezier solver. This is the headline test.
// ---------------------------------------------------------------------------

describe('easeProgress: accuracy against the bezier definition (independent bisection reference)', () => {
  test('every preset matches the reference to 1e-6 across a dense sweep of p', () => {
    for (const name of BEZIER_NAMES) {
      const [x1, y1, x2, y2] = CONTROL_POINTS[name]
      for (let i = 1; i < 200; i++) {
        const p = i / 200
        closeTo(easeProgress(name, p), referenceEase(x1, y1, x2, y2, p), 1e-6, `${name} at p=${p}`)
      }
    }
  })

  test('and it lands ON the curve: (p, easeProgress(p)) satisfies the parametric definition', () => {
    // Walk the curve by its PARAMETER s, which sidesteps the inversion
    // entirely: (X(s), Y(s)) is on the curve by construction, so feeding X(s)
    // in must give Y(s) back.
    for (const name of BEZIER_NAMES) {
      const [x1, y1, x2, y2] = CONTROL_POINTS[name]
      for (let i = 1; i < 100; i++) {
        const s = i / 100
        const { x, y } = bezierPoint(x1, y1, x2, y2, s)
        closeTo(easeProgress(name, x), y, 1e-6, `${name} at curve parameter s=${s} (x=${x})`)
      }
    }
  })

  // Pinned literals so a solver regression is visible in the diff itself.
  // Computed by the bisection reference above, NOT by curves.js. The tolerance
  // is 1e-6 rather than something absurd because the shipped solver stops at
  // |Δx| < 1e-7 by design, which the segment slope can turn into a few parts
  // in 1e7 of y — well inside a pixel, and pinned as such.
  for (const [name, p, expected] of [
    ['ease', 0.25, 0.4085105913553958],
    ['ease', 0.5, 0.802403387584857],
    ['ease', 0.75, 0.960458978348974],
    ['ease-in', 0.25, 0.09346465071882484],
    ['ease-in', 0.5, 0.31535681257253945],
    ['ease-in', 0.75, 0.6218618691748899],
    ['ease-out', 0.25, 0.37813813082510966],
    ['ease-out', 0.5, 0.6846431874274606],
    ['ease-out', 0.75, 0.9065353492811752],
    ['ease-in-out', 0.25, 0.1291619310473198],
    ['ease-in-out', 0.5, 0.5],
    ['ease-in-out', 0.75, 0.8708380689526802],
  ]) {
    test(`pinned: ${name} at p=${p} -> ${expected}`, () => {
      closeTo(easeProgress(name, p), expected, 1e-6, `${name} at p=${p}`)
    })
  }

  test('ease-in and ease-out are exact mirrors of each other (a property of their control points)', () => {
    for (let i = 0; i <= 100; i++) {
      const p = i / 100
      closeTo(
        easeProgress('ease-in', p),
        1 - easeProgress('ease-out', 1 - p),
        1e-6,
        `ease-in(${p}) should mirror 1 - ease-out(1 - ${p})`,
      )
    }
  })

  test('ease-in-out is symmetric about (0.5, 0.5)', () => {
    for (let i = 0; i <= 100; i++) {
      const p = i / 100
      closeTo(easeProgress('ease-in-out', p), 1 - easeProgress('ease-in-out', 1 - p), 1e-6, `at p=${p}`)
    }
  })
})

describe('easeProgress: the anchors are EXACT, not approximate', () => {
  for (const name of EASING_NAMES) {
    test(`${name}: p=0 -> exactly 0, p=1 -> exactly 1`, () => {
      assert.equal(easeProgress(name, 0), 0, 'p=0 must be exactly 0, with no solver round-trip')
      assert.equal(easeProgress(name, 1), 1, 'p=1 must be exactly 1, with no solver round-trip')
    })
  }

  test('linear is short-circuited: it returns p itself, bit-for-bit, never a solved approximation', () => {
    for (const p of [0, 0.1, 1 / 3, 0.25, 0.5, 0.7000000000000001, 0.9999999, 1]) {
      assert.equal(easeProgress('linear', p), p, `linear(${p}) must be exactly ${p}`)
    }
  })
})

describe('easeProgress: clamping and malformed input', () => {
  test('p outside [0, 1] clamps to the endpoints for every easing', () => {
    for (const name of EASING_NAMES) {
      for (const p of [-1, -0.0001, -Infinity]) assert.equal(easeProgress(name, p), 0, `${name} at p=${p}`)
      for (const p of [1.0001, 2, 1e9, Infinity]) assert.equal(easeProgress(name, p), 1, `${name} at p=${p}`)
    }
  })

  test('a non-finite p is treated as 0 rather than poisoning the result with NaN', () => {
    for (const name of EASING_NAMES) {
      assert.equal(easeProgress(name, NaN), 0, `${name} at NaN`)
      assert.equal(easeProgress(name, undefined), 0, `${name} at undefined`)
    }
  })

  test('an unknown / misspelled easing falls back to linear — a malformed project must still render', () => {
    for (const bogus of ['ease-in-ou', 'EASE', 'cubic-bezier(0,0,1,1)', '', 'spring', null, undefined, 42, {}]) {
      for (const p of [0.1, 0.25, 0.5, 0.9]) {
        assert.equal(easeProgress(bogus, p), p, `easing ${JSON.stringify(bogus)} at p=${p} must behave as linear`)
      }
    }
  })

  test('every preset is monotonically non-decreasing across the segment', () => {
    for (const name of EASING_NAMES) {
      let prev = -Infinity
      for (let i = 0; i <= 500; i++) {
        const y = easeProgress(name, i / 500)
        assert.ok(y >= prev, `${name} went backwards at p=${i / 500}: ${y} < ${prev}`)
        assert.ok(y >= 0 && y <= 1, `${name} left [0,1] at p=${i / 500}: ${y}`)
        prev = y
      }
    }
  })
})

describe('easeProgress: hold is step-END, not step-start', () => {
  test('hold is 0 for every p < 1 and 1 only at p === 1', () => {
    for (const p of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 0.9999999999]) {
      assert.equal(easeProgress('hold', p), 0, `hold(${p}) must still be 0 — the value jumps only AT the next key`)
    }
    assert.equal(easeProgress('hold', 1), 1)
  })
})

describe('EASING_NAMES', () => {
  test('is exactly the six supported names', () => {
    assert.deepEqual([...EASING_NAMES], ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'hold'])
  })

  test('is frozen — the UI picker reads it, it never edits it', () => {
    assert.ok(Object.isFrozen(EASING_NAMES))
  })
})

// ---------------------------------------------------------------------------
// 2. sampleTrack — the sentinel, the clamps, and the outgoing-easing convention.
// ---------------------------------------------------------------------------

/** @returns a track in the shape the project schema stores. */
function track(points, prop = 'opacity') {
  return { prop, points }
}

describe('sampleTrack: an absent or empty track returns the undefined SENTINEL, not 0', () => {
  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['a track with no points field', { prop: 'scale' }],
    ['a track whose points is not an array', { prop: 'scale', points: 'nope' }],
    ['a track with an empty points array', track([])],
    ['a bare empty array', []],
    ['a track whose points are ALL malformed', track([{ t: NaN, value: 1 }, { t: 0, value: Infinity }, null])],
  ]) {
    test(`${label} -> undefined at every t`, () => {
      for (const t of [-1, 0, 0.5, 10]) {
        assert.equal(sampleTrack(value, t), undefined, `${label} at t=${t}`)
      }
    })
  }

  test('0 is a legitimate keyframe value, so the sentinel must be distinguishable from it', () => {
    assert.equal(sampleTrack(track([{ t: 0, value: 0 }]), 0), 0)
    assert.notEqual(sampleTrack(track([{ t: 0, value: 0 }]), 0), undefined)
  })
})

describe('sampleTrack: a single keyframe is a constant', () => {
  test('one keyframe returns its value at every localT, before, at and after', () => {
    const one = track([{ t: 2, value: 0.42 }])
    for (const t of [-1000, -1, 0, 1.999, 2, 2.001, 3, 1e6]) {
      assert.equal(sampleTrack(one, t), 0.42, `at t=${t}`)
    }
  })

  test('and its easing is irrelevant — there is no segment for it to govern', () => {
    for (const easing of EASING_NAMES) {
      assert.equal(sampleTrack(track([{ t: 2, value: 0.42, easing }]), 5), 0.42, `easing=${easing}`)
    }
  })
})

describe('sampleTrack: clamping outside the track', () => {
  const t3 = track([
    { t: 1, value: 10 },
    { t: 2, value: 20 },
    { t: 3, value: 30 },
  ])

  test('before the first keyframe clamps to the first value', () => {
    for (const t of [-1e6, -1, 0, 0.5, 0.999]) assert.equal(sampleTrack(t3, t), 10, `at t=${t}`)
  })

  test('after the last keyframe clamps to the last value', () => {
    for (const t of [3.001, 4, 100, 1e6]) assert.equal(sampleTrack(t3, t), 30, `at t=${t}`)
  })

  test('the clamp is inclusive at both ends', () => {
    assert.equal(sampleTrack(t3, 1), 10)
    assert.equal(sampleTrack(t3, 3), 30)
  })

  test('negative keyframe times are ordinary times, not an error', () => {
    const neg = track([
      { t: -2, value: 0 },
      { t: 2, value: 4 },
    ])
    assert.equal(sampleTrack(neg, -3), 0)
    assert.equal(sampleTrack(neg, 0), 2)
    assert.equal(sampleTrack(neg, 3), 4)
  })
})

describe('sampleTrack: endpoint exactness — at a keyframe`s own t you get that keyframe`s value back', () => {
  for (const easing of EASING_NAMES) {
    test(`easing=${easing}: every keyframe reads back exactly, with no float drift`, () => {
      const points = [
        { t: 0, value: 0.13, easing },
        { t: 0.5, value: -7.25, easing },
        { t: 1.75, value: 100, easing },
        { t: 4, value: 0, easing },
      ]
      for (const kf of points) {
        assert.equal(sampleTrack(track(points), kf.t), kf.value, `at t=${kf.t}`)
      }
    })
  }

  test('exactness holds for awkward float times too', () => {
    const points = [
      { t: 0.1 + 0.2, value: 1, easing: 'ease-in-out' },
      { t: 1 / 3, value: 2, easing: 'ease' },
      { t: 2.6666666666666665, value: 3 },
    ]
    for (const kf of points) assert.equal(sampleTrack(track(points), kf.t), kf.value, `at t=${kf.t}`)
  })
})

describe('sampleTrack: linear interpolation between two keyframes', () => {
  const ramp = track([
    { t: 0, value: 0 },
    { t: 4, value: 100 },
  ])

  test('absent easing IS linear', () => {
    assert.equal(sampleTrack(ramp, 1), 25)
    assert.equal(sampleTrack(ramp, 2), 50)
    assert.equal(sampleTrack(ramp, 3), 75)
  })

  test('an explicit `linear` matches an absent one exactly', () => {
    const explicit = track([
      { t: 0, value: 0, easing: 'linear' },
      { t: 4, value: 100 },
    ])
    for (let i = 0; i <= 40; i++) {
      const t = i / 10
      assert.equal(sampleTrack(explicit, t), sampleTrack(ramp, t), `at t=${t}`)
    }
  })

  test('a descending segment interpolates downward just as happily', () => {
    const down = track([
      { t: 0, value: 1 },
      { t: 2, value: 0 },
    ])
    assert.equal(sampleTrack(down, 0.5), 0.75)
    assert.equal(sampleTrack(down, 1), 0.5)
    assert.equal(sampleTrack(down, 1.5), 0.25)
  })

  test('a flat segment (equal values) stays flat under every easing', () => {
    for (const easing of EASING_NAMES) {
      const flat = track([
        { t: 0, value: 7, easing },
        { t: 3, value: 7 },
      ])
      for (const t of [0, 0.5, 1, 2, 2.9, 3]) assert.equal(sampleTrack(flat, t), 7, `easing=${easing} at t=${t}`)
    }
  })
})

describe('sampleTrack: easing is OUTGOING — it belongs to keyframe i, governing the segment i -> i+1', () => {
  const eased = track([
    { t: 0, value: 0, easing: 'ease-in' },
    { t: 1, value: 1 },
  ])
  const linear = track([
    { t: 0, value: 0 },
    { t: 1, value: 1 },
  ])

  test('easing on the FIRST keyframe shapes the segment', () => {
    for (const p of [0.25, 0.5, 0.75]) {
      closeTo(sampleTrack(eased, p), easeProgress('ease-in', p), 1e-12, `at t=${p}`)
      assert.notEqual(sampleTrack(eased, p), sampleTrack(linear, p), `ease-in must differ from linear at t=${p}`)
    }
  })

  test('easing on the LAST keyframe has NO effect — its outgoing segment does not exist', () => {
    for (const easing of EASING_NAMES) {
      const trailing = track([
        { t: 0, value: 0 },
        { t: 1, value: 1, easing },
      ])
      for (let i = 0; i <= 20; i++) {
        const t = i / 20
        assert.equal(sampleTrack(trailing, t), sampleTrack(linear, t), `easing=${easing} at t=${t}`)
      }
    }
  })

  test('getting the convention backwards is detectable: ease-in on key 0 is NOT ease-in on key 1', () => {
    const onFirst = track([
      { t: 0, value: 0, easing: 'ease-in' },
      { t: 1, value: 1 },
    ])
    const onSecond = track([
      { t: 0, value: 0 },
      { t: 1, value: 1, easing: 'ease-in' },
    ])
    assert.notEqual(sampleTrack(onFirst, 0.5), sampleTrack(onSecond, 0.5))
  })

  test('each segment carries its OWN easing, independently of its neighbours', () => {
    const mixed = track([
      { t: 0, value: 0, easing: 'hold' },
      { t: 1, value: 10, easing: 'linear' },
      { t: 2, value: 20, easing: 'ease-in' },
      { t: 3, value: 30 },
    ])
    assert.equal(sampleTrack(mixed, 0.5), 0, 'segment 0 holds')
    assert.equal(sampleTrack(mixed, 1.5), 15, 'segment 1 is linear')
    closeTo(sampleTrack(mixed, 2.5), 20 + 10 * easeProgress('ease-in', 0.5), 1e-12, 'segment 2 is ease-in')
  })

  test('an eased segment still spans exactly the two keyframe values, never overshooting', () => {
    for (const easing of EASING_NAMES) {
      const seg = track([
        { t: 1, value: -5, easing },
        { t: 3, value: 5 },
      ])
      for (let i = 0; i <= 100; i++) {
        const t = 1 + (i / 100) * 2
        const v = sampleTrack(seg, t)
        assert.ok(v >= -5 && v <= 5, `easing=${easing} at t=${t}: ${v} escaped [-5, 5]`)
      }
    }
  })

  test('every preset is monotonic across an ascending segment', () => {
    for (const easing of EASING_NAMES) {
      const seg = track([
        { t: 0, value: 0, easing },
        { t: 2, value: 100 },
      ])
      let prev = -Infinity
      for (let i = 0; i <= 400; i++) {
        const v = sampleTrack(seg, (i / 400) * 2)
        assert.ok(v >= prev, `easing=${easing} went backwards at i=${i}: ${v} < ${prev}`)
        prev = v
      }
    }
  })
})

describe('sampleTrack: hold holds keyframe i, then jumps AT keyframe i+1', () => {
  const held = track([
    { t: 0, value: 0, easing: 'hold' },
    { t: 2, value: 1, easing: 'hold' },
    { t: 4, value: 0 },
  ])

  test('the value does not move at all inside a held segment', () => {
    for (const t of [0, 0.5, 1, 1.5, 1.9999999]) assert.equal(sampleTrack(held, t), 0, `at t=${t}`)
  })

  test('the jump lands exactly on the next keyframe`s t, not before and not after', () => {
    assert.equal(sampleTrack(held, 2), 1, 'jumps AT t=2')
    assert.equal(sampleTrack(held, 2.0000001), 1)
    assert.equal(sampleTrack(held, 3.9999999), 1, 'and then holds again')
    assert.equal(sampleTrack(held, 4), 0)
  })

  test('a hold on the last keyframe changes nothing (it has no outgoing segment)', () => {
    const trailingHold = track([
      { t: 0, value: 5 },
      { t: 1, value: 9, easing: 'hold' },
    ])
    assert.equal(sampleTrack(trailingHold, 0.5), 7)
    assert.equal(sampleTrack(trailingHold, 2), 9)
  })
})

describe('sampleTrack: degenerate and malformed input never throws and never returns NaN', () => {
  test('two adjacent keyframes at the SAME t do not divide by zero', () => {
    const dup = track([
      { t: 0, value: 0 },
      { t: 1, value: 10 },
      { t: 1, value: 90 },
      { t: 2, value: 100 },
    ])
    for (let i = 0; i <= 40; i++) {
      const v = sampleTrack(dup, i / 20)
      assert.ok(Number.isFinite(v), `t=${i / 20} produced ${v}`)
    }
    assert.equal(sampleTrack(dup, 1), 90, 'at the shared t the LATER keyframe wins, matching normalizeTrack')
    assert.equal(sampleTrack(dup, 1.5), 95, 'the segment after the duplicate starts from the later value')
  })

  test('a whole track collapsed onto one t is just a constant', () => {
    const collapsed = track([
      { t: 1, value: 3 },
      { t: 1, value: 4 },
      { t: 1, value: 5 },
    ])
    assert.equal(sampleTrack(collapsed, 0), 3, 'before: the first keyframe')
    assert.equal(sampleTrack(collapsed, 1), 5, 'at: the last of the duplicates')
    assert.equal(sampleTrack(collapsed, 2), 5, 'after: the last keyframe')
  })

  test('a non-finite localT behaves as if clamped to the FIRST keyframe', () => {
    const t3 = track([
      { t: 1, value: 10 },
      { t: 5, value: 50 },
    ])
    for (const t of [NaN, undefined, null, Infinity, -Infinity, 'nope', {}]) {
      assert.equal(sampleTrack(t3, t), 10, `localT=${String(t)}`)
    }
  })

  test('malformed keyframes are SKIPPED, not thrown on — the good ones still animate', () => {
    const messy = track([
      { t: 0, value: 0 },
      null,
      { t: NaN, value: 999 },
      { t: 1, value: NaN },
      { t: 2, value: 20 },
      { value: 5 },
      { t: 3 },
      { t: 4, value: 40 },
    ])
    assert.equal(sampleTrack(messy, -1), 0)
    assert.equal(sampleTrack(messy, 1), 10, 'the NaN-valued key at t=1 is invisible; 0->20 interpolates through it')
    assert.equal(sampleTrack(messy, 2), 20)
    assert.equal(sampleTrack(messy, 3), 30)
    assert.equal(sampleTrack(messy, 99), 40)
  })

  test('a leading run of malformed keyframes does not break the before-first clamp', () => {
    const messy = track([null, { t: NaN, value: 1 }, { t: 2, value: 7 }, { t: 4, value: 9 }])
    assert.equal(sampleTrack(messy, -1), 7)
    assert.equal(sampleTrack(messy, 3), 8)
  })

  test('no input in this suite ever yields NaN', () => {
    const points = [
      { t: 0, value: 0, easing: 'ease' },
      { t: 1, value: 5, easing: 'bogus' },
      { t: 1, value: 6, easing: 'hold' },
      { t: 3, value: -2 },
    ]
    for (let i = -20; i <= 80; i++) {
      const v = sampleTrack(track(points), i / 20)
      assert.ok(Number.isFinite(v), `t=${i / 20} produced ${v}`)
    }
  })
})

describe('sampleTrack: it accepts either a track or a bare points array', () => {
  test('the two forms agree everywhere', () => {
    const points = [
      { t: 0, value: 0, easing: 'ease-in-out' },
      { t: 2, value: 8 },
    ]
    for (let i = -5; i <= 25; i++) {
      const t = i / 10
      assert.equal(sampleTrack(points, t), sampleTrack(track(points), t), `at t=${t}`)
    }
  })
})

describe('sampleTrack: purity (the same package contract as everything else here)', () => {
  test('it never mutates the track or its keyframes', () => {
    const t = track([
      { t: 3, value: 30, easing: 'ease' },
      { t: 1, value: 10, easing: 'hold' },
      { t: 1, value: 11 },
    ])
    const before = JSON.parse(JSON.stringify(t))
    for (let i = -10; i <= 40; i++) sampleTrack(t, i / 10)
    assert.deepEqual(JSON.parse(JSON.stringify(t)), before, 'the caller`s track came back untouched')
  })

  test('two calls with the same input return identical results', () => {
    const t = track([
      { t: 0, value: 0, easing: 'ease' },
      { t: 1, value: 1, easing: 'ease-out' },
      { t: 2, value: 0.5 },
    ])
    for (let i = 0; i <= 20; i++) {
      assert.equal(sampleTrack(t, i / 10), sampleTrack(t, i / 10), `at t=${i / 10}`)
    }
  })

  test('it always returns a number or undefined — never null, never a string, never an object', () => {
    const t = track([
      { t: 0, value: 0, easing: 'ease' },
      { t: 1, value: 1 },
    ])
    for (let i = -10; i <= 20; i++) {
      const v = sampleTrack(t, i / 10)
      assert.equal(typeof v, 'number', `at t=${i / 10}`)
    }
    assert.equal(sampleTrack(track([]), 0), undefined)
  })
})

// ---------------------------------------------------------------------------
// 3. normalizeTrack — the write-time invariant sampleTrack ASSUMES.
// ---------------------------------------------------------------------------

describe('normalizeTrack: sorting', () => {
  test('points come back ascending by t', () => {
    const out = normalizeTrack(
      track([
        { t: 3, value: 30 },
        { t: 1, value: 10 },
        { t: 2, value: 20 },
        { t: -1, value: -10 },
      ]),
    )
    assert.deepEqual(
      out.points.map((k) => k.t),
      [-1, 1, 2, 3],
    )
    assert.deepEqual(
      out.points.map((k) => k.value),
      [-10, 10, 20, 30],
    )
  })

  test('an already-sorted track is unchanged in content', () => {
    const points = [
      { t: 0, value: 0, easing: 'ease' },
      { t: 1, value: 1 },
    ]
    assert.deepEqual(normalizeTrack(track(points)).points, points)
  })

  test('the other track fields survive', () => {
    const out = normalizeTrack({ prop: 'offsetX', points: [{ t: 0, value: 0 }] })
    assert.equal(out.prop, 'offsetX')
  })
})

describe('normalizeTrack: duplicate-t de-duplication is LAST WINS', () => {
  test('the last authored keyframe at a given t survives', () => {
    const out = normalizeTrack(
      track([
        { t: 1, value: 10 },
        { t: 1, value: 11 },
        { t: 1, value: 12 },
        { t: 2, value: 20 },
      ]),
    )
    assert.deepEqual(
      out.points.map((k) => [k.t, k.value]),
      [
        [1, 12],
        [2, 20],
      ],
    )
  })

  test('"last" means last in AUTHORING order, not last after sorting — the sort must be STABLE', () => {
    // The two t=2 keys straddle the t=1 key, so an unstable sort could easily
    // swap them and hand back 21 instead of 22.
    const out = normalizeTrack(
      track([
        { t: 2, value: 21 },
        { t: 1, value: 10 },
        { t: 2, value: 22 },
      ]),
    )
    assert.deepEqual(
      out.points.map((k) => [k.t, k.value]),
      [
        [1, 10],
        [2, 22],
      ],
    )
  })

  test('an unsorted, duplicated track normalizes to something that samples to hand-computed values', () => {
    // The full write-time journey in one test: authored out of order AND with
    // a duplicate `t`, normalized once, then sampled against numbers worked
    // out by hand rather than against the raw track (which, being unsorted,
    // has no contract to compare to — sampleTrack ASSUMES ascending `t`).
    // Default `linear` easing throughout, so every expectation below is
    // checkable by eye.
    const norm = normalizeTrack(
      track([
        { t: 2, value: 20 },
        { t: 0, value: 0 },
        { t: 2, value: 25 },
        { t: 4, value: 40 },
      ]),
    )
    assert.deepEqual(
      norm.points.map((k) => [k.t, k.value]),
      [
        [0, 0],
        [2, 25],
        [4, 40],
      ],
    )
    for (const [t, expected, why] of [
      [-1, 0, 'before the first keyframe: clamp'],
      [0, 0, 'the first keyframe itself'],
      [1, 12.5, 'halfway along 0 -> 25'],
      [2, 25, 'the surviving duplicate, exactly'],
      [3, 32.5, 'halfway along 25 -> 40'],
      [4, 40, 'the last keyframe itself'],
      [5, 40, 'after the last keyframe: clamp'],
    ]) {
      assert.equal(sampleTrack(norm, t), expected, `at t=${t} (${why})`)
    }
  })

  test('normalizing a track that ALREADY satisfies the invariant changes nothing about sampling', () => {
    const clean = track([
      { t: 0, value: 0, easing: 'ease-in' },
      { t: 2, value: 20, easing: 'hold' },
      { t: 4, value: 40 },
    ])
    const norm = normalizeTrack(clean)
    for (let i = -10; i <= 60; i++) {
      const t = i / 10
      assert.equal(sampleTrack(norm, t), sampleTrack(clean, t), `at t=${t}`)
    }
  })

  test('raw and normalized agree AT a duplicated t — both give the later value', () => {
    const raw = track([
      { t: 0, value: 0 },
      { t: 2, value: 20 },
      { t: 2, value: 25 },
      { t: 4, value: 40 },
    ])
    assert.equal(sampleTrack(raw, 2), 25)
    assert.equal(sampleTrack(normalizeTrack(raw), 2), 25)
  })

  test('but the RUN-UP segment does differ, which is exactly why the editor normalizes on write', () => {
    // Un-normalized, the incoming segment aims at the FIRST key at t=2 (20);
    // normalized, it aims at the surviving one (25). sampleTrack cannot
    // reconcile the two without a lookahead it is not allowed to pay for on a
    // per-frame path — so the invariant is established at write time instead.
    const raw = track([
      { t: 0, value: 0 },
      { t: 2, value: 20 },
      { t: 2, value: 25 },
      { t: 4, value: 40 },
    ])
    assert.equal(sampleTrack(raw, 1), 10)
    assert.equal(sampleTrack(normalizeTrack(raw), 1), 12.5)
  })
})

describe('normalizeTrack: malformed points are dropped', () => {
  test('non-finite t or value, and non-object entries, do not survive', () => {
    const out = normalizeTrack(
      track([{ t: 1, value: 1 }, null, undefined, { t: NaN, value: 2 }, { t: 3 }, { value: 4 }, { t: 5, value: Infinity }, { t: 2, value: 2 }]),
    )
    assert.deepEqual(
      out.points.map((k) => [k.t, k.value]),
      [
        [1, 1],
        [2, 2],
      ],
    )
  })

  test('a track whose points are all junk normalizes to an empty track, which then samples as undefined', () => {
    const out = normalizeTrack(track([null, { t: NaN, value: 0 }]))
    assert.deepEqual(out.points, [])
    assert.equal(sampleTrack(out, 0), undefined)
  })
})

describe('normalizeTrack: totality and purity', () => {
  test('null / undefined in, undefined out', () => {
    assert.equal(normalizeTrack(null), undefined)
    assert.equal(normalizeTrack(undefined), undefined)
  })

  test('a missing points field normalizes to an empty array rather than throwing', () => {
    assert.deepEqual(normalizeTrack({ prop: 'scale' }).points, [])
    assert.deepEqual(normalizeTrack({ prop: 'scale', points: 'nope' }).points, [])
  })

  test('it never mutates or re-orders the input array', () => {
    const points = [
      { t: 3, value: 30 },
      { t: 1, value: 10 },
      { t: 1, value: 11 },
    ]
    const input = track(points)
    const before = JSON.parse(JSON.stringify(input))
    normalizeTrack(input)
    assert.deepEqual(JSON.parse(JSON.stringify(input)), before)
    assert.equal(input.points, points, 'the caller keeps its own array identity')
  })

  test('it returns a NEW track and a NEW points array', () => {
    const input = track([{ t: 0, value: 0 }])
    const out = normalizeTrack(input)
    assert.notEqual(out, input)
    assert.notEqual(out.points, input.points)
  })

  test('it is idempotent', () => {
    const once = normalizeTrack(
      track([
        { t: 2, value: 20 },
        { t: 1, value: 10 },
        { t: 2, value: 22 },
      ]),
    )
    assert.deepEqual(normalizeTrack(once), once)
  })
})

// ---------------------------------------------------------------------------
// 4. Purity of the module as a whole — the SP2 package contract.
// ---------------------------------------------------------------------------

describe('curves.js: the package purity contract', () => {
  test('the solver is deterministic across a large sweep — no lookup-table seeding, no Math.random, no Date', () => {
    const points = [
      { t: 0, value: 0, easing: 'ease' },
      { t: 1, value: 100, easing: 'ease-in' },
      { t: 2, value: 50, easing: 'ease-out' },
      { t: 3, value: 75, easing: 'ease-in-out' },
      { t: 4, value: 0, easing: 'hold' },
      { t: 5, value: 10 },
    ]
    const first = []
    for (let i = 0; i <= 1000; i++) first.push(sampleTrack(track(points), i / 200))
    for (let i = 0; i <= 1000; i++) {
      assert.equal(sampleTrack(track(points), i / 200), first[i], `run 2 diverged at i=${i}`)
    }
  })
})
