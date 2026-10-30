import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLUR_MAX, blurOf, blurSigmaPx, pictureRectInBox } from '../index.js'

test('blurOf: a finite number above 0, held to BLUR_MAX; anything else is 0', () => {
  assert.equal(BLUR_MAX, 200)
  assert.equal(blurOf(null), 0)
  assert.equal(blurOf({}), 0)
  assert.equal(blurOf({ blur: 0 }), 0)
  assert.equal(blurOf({ blur: -3 }), 0)
  assert.equal(blurOf({ blur: '12' }), 0)
  assert.equal(blurOf({ blur: NaN }), 0)
  assert.equal(blurOf({ blur: Infinity }), 0)
  assert.equal(blurOf({ blur: 12.5 }), 12.5)
  assert.equal(blurOf({ blur: 500 }), 200)
})

test('blurSigmaPx: design pixels on the 1080 short edge, scaled to the canvas', () => {
  assert.equal(blurSigmaPx({ blur: 40 }, 1080, 1920), 40)
  assert.equal(blurSigmaPx({ blur: 40 }, 2160, 3840), 80)
  assert.equal(blurSigmaPx({ blur: 40 }, 1920, 1080), 40)
  assert.equal(blurSigmaPx({ blur: 40 }, 720, 1280), 40 * 720 / 1080)
  assert.equal(blurSigmaPx({ blur: 0 }, 1080, 1920), 0)
  assert.equal(blurSigmaPx({ blur: 40 }, 0, 1920), 0)
})

test('pictureRectInBox: contain-fit, centred, as fractions of the box', () => {
  // 16:9 into a 9:16 box: full width, a centred band.
  const r = pictureRectInBox(1080, 1920, 1920, 1080)
  assert.equal(r.x, 0)
  assert.equal(r.w, 1)
  assert.ok(Math.abs(r.h - (1080 / 1920) / (1920 / 1080)) < 1e-12)
  assert.ok(Math.abs(r.y - (1 - r.h) / 2) < 1e-12)
  // 9:16 into a 16:9 box: full height, a centred column.
  const c = pictureRectInBox(1920, 1080, 1080, 1920)
  assert.equal(c.y, 0)
  assert.equal(c.h, 1)
  assert.ok(Math.abs(c.x - (1 - c.w) / 2) < 1e-12)
  // The box's own aspect, and unknown sizes: the whole box.
  assert.deepEqual(pictureRectInBox(1080, 1920, 540, 960), { x: 0, y: 0, w: 1, h: 1 })
  assert.deepEqual(pictureRectInBox(1080, 1920, null, 960), { x: 0, y: 0, w: 1, h: 1 })
  assert.deepEqual(pictureRectInBox(0, 1920, 100, 100), { x: 0, y: 0, w: 1, h: 1 })
})
