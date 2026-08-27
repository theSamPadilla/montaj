// render/test/capture-scale.test.mjs
//
// Unit coverage for captureScaleFor (render.js) — the derivation that decides
// what deviceScaleFactor the Puppeteer overlay capture runs at.
//
// The overlay design canvas is fixed at 1080 on the short edge so overlay JSX
// coordinates mean one thing at every output resolution. The capture used to be
// taken at an unconditional deviceScaleFactor 2 on top of that, which is an
// identity at 4K (1080x2 == 2160, the output's own short edge) but forced a
// lossy 2:1 downscale at 1080p. The scale is now derived from the output
// resolution so the capture lands on the output's own pixel grid.
//
// What these tests can and cannot prove: they cover the ARITHMETIC only. That
// the derived value actually reaches Chrome is proved end-to-end by
// overlay-cadence.integration.test.mjs case (b), and that Chrome honours a
// FRACTIONAL value by capture-scale-puppeteer.test.mjs. Neither is reachable
// from here — renderChunk is not exported.
//
// The malformed-input cases at the bottom are not defensive padding. The value
// comes from JSON.parse on a hand-editable project file, so it can be any JSON
// type; a non-iterable one used to throw at the destructure and abort the whole
// render on a field every other consumer tolerates.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureScaleFor } from '../render.js'

test('captureScaleFor: 4K ([3840,2160]) → exactly 2 — the 4K identity must stay untouched', () => {
  assert.equal(captureScaleFor([3840, 2160]), 2)
})

test('captureScaleFor: 1080p ([1920,1080]) → exactly 1 — the headline fix', () => {
  assert.equal(captureScaleFor([1920, 1080]), 1)
})

test('captureScaleFor: 1440p ([2560,1440]) → 4/3, fractional', () => {
  assert.equal(captureScaleFor([2560, 1440]), 1440 / 1080)
})

test('captureScaleFor: sub-1080 output ([1280,720]) clamps to 1, never below the design canvas', () => {
  assert.equal(captureScaleFor([1280, 720]), 1)
})

test('captureScaleFor: above-2x output ([7680,4320], 8K) clamps to 2, no runaway capture memory', () => {
  assert.equal(captureScaleFor([7680, 4320]), 2)
})

test('captureScaleFor: portrait [1080,1920] → 1 (keys off the SHORT edge, not width)', () => {
  assert.equal(captureScaleFor([1080, 1920]), 1)
})

test('captureScaleFor: portrait [2160,3840] → 2 (keys off the SHORT edge, not width)', () => {
  assert.equal(captureScaleFor([2160, 3840]), 2)
})

// The identity property is the actual point of the change: capture dimensions
// must land exactly on the output grid, so compose has nothing left to resample.
//
// Only the fractional case is worth asserting. At 1080p and 4K the arithmetic
// degenerates to 1920*1 and 1920*2 — restatements of the two tests above that
// cannot fail independently. A 1440p project is the real check: the design
// canvas is 1920x1080, captureScale is a non-integer 4/3, and 1920 * 4/3 must
// land on 2560 EXACTLY, with no floating-point drift and no rounding.
test('captureScaleFor: identity property — a fractional scale still lands the design canvas exactly on the output grid', () => {
  // 2560x1440 output -> aspectRatio 1080/1440 = 0.75 -> design canvas 1920x1080.
  const designW = 1920
  const designH = 1080
  const scale = captureScaleFor([2560, 1440])
  assert.equal(designW * scale, 2560, 'captured width must equal output width exactly')
  assert.equal(designH * scale, 1440, 'captured height must equal output height exactly')
})

test('captureScaleFor: undefined resolution → 2 (unresolved output size keeps today\'s unconditional 2x)', () => {
  assert.equal(captureScaleFor(undefined), 2)
})

test('captureScaleFor: null resolution → 2', () => {
  assert.equal(captureScaleFor(null), 2)
})

test('captureScaleFor: empty tuple → 2', () => {
  assert.equal(captureScaleFor([]), 2)
})

test('captureScaleFor: malformed tuple (non-numeric entry) → 2, never NaN', () => {
  const result = captureScaleFor(['1920', null])
  assert.ok(Number.isFinite(result), `expected a finite number, got ${result}`)
  assert.equal(result, 2)
})

// Numeric strings are the one malformed-looking shape that is NOT degraded: the
// design-canvas math in render.js reaches its numbers through Math.min/Math.round
// and so accepts them, building a real 1920x1080 canvas. Falling back to 2 here
// would make this function disagree with that canvas about the same project --
// exactly the "two places disagree about a dimension" defect this change fixes.
test('captureScaleFor: numeric strings are coerced, matching the design-canvas math', () => {
  assert.equal(captureScaleFor(['1920', '1080']), 1)
  assert.equal(captureScaleFor(['3840', '2160']), 2)
})

// settings.resolution comes from JSON.parse, so it can be any JSON type. A
// non-array is not nullish, so it reaches the destructure -- and a non-iterable
// one THROWS there, aborting the render on a field that render.js's other
// consumers (settings.resolution?.[0] ?? 1080) have always tolerated. These
// cases all threw TypeError before the Array.isArray guard.
test('captureScaleFor: a non-iterable resolution → 2, and never throws', () => {
  for (const bad of [{}, { width: 1920, height: 1080 }, 1920, true, ' 1920x1080']) {
    let result
    assert.doesNotThrow(() => { result = captureScaleFor(bad) },
      `captureScaleFor(${JSON.stringify(bad)}) must not throw`)
    assert.equal(result, 2, `captureScaleFor(${JSON.stringify(bad)}) must degrade to 2`)
  }
})

// Non-positive dimensions are malformed, not merely small. Without an explicit
// guard they pass Number.isFinite and the clamp floors them to 1 -- a silent
// contradiction of this function's own documented contract. Negatives are the
// reachable one: [-1920,-1080] yields a plausible-looking 1080x608 design canvas
// and renders all the way to compose before failing, so the scale IS consumed.
test('captureScaleFor: zero and negative dimensions → 2, not the clamp floor of 1', () => {
  assert.equal(captureScaleFor([0, 0]), 2)
  assert.equal(captureScaleFor([-1920, -1080]), 2)
  assert.equal(captureScaleFor([1920, 0]), 2)
})
