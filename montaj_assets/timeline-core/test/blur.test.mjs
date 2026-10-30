import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLUR_MAX, BLUR_SPIN_MAX, BLUR_TYPES, BLUR_ZOOM_MAX, blurAngleOf, blurCenterOf, blurMaxOf, blurOf, blurSigmaPx, blurTypeOf, pictureRectInBox } from '../index.js'

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

test('blurTypeOf: one of the four when it says so; uniform otherwise', () => {
  assert.deepEqual(BLUR_TYPES, ['uniform', 'linear', 'spin', 'zoom'])
  assert.equal(blurTypeOf(null), 'uniform')
  assert.equal(blurTypeOf({}), 'uniform')
  assert.equal(blurTypeOf({ blurType: 'uniform' }), 'uniform')
  assert.equal(blurTypeOf({ blurType: 'Linear' }), 'uniform')
  assert.equal(blurTypeOf({ blurType: 'radial' }), 'uniform')
  for (const t of ['linear', 'spin', 'zoom']) assert.equal(blurTypeOf({ blurType: t }), t)
})

test('the amount\'s ceiling follows the type: 200 px, 180 degrees, 200 percent', () => {
  assert.equal(BLUR_SPIN_MAX, 180)
  assert.equal(BLUR_ZOOM_MAX, 200)
  assert.deepEqual(BLUR_TYPES.map(blurMaxOf), [200, 200, 180, 200])
  assert.equal(blurOf({ blur: 190, blurType: 'spin' }), 180)
  assert.equal(blurOf({ blur: 190, blurType: 'zoom' }), 190)
  assert.equal(blurOf({ blur: 190, blurType: 'linear' }), 190)
})

test('blurCenterOf: blurX and blurY as fractions of the box, 0.5 (the centre) by default', () => {
  assert.deepEqual(blurCenterOf(null), { x: 0.5, y: 0.5 })
  assert.deepEqual(blurCenterOf({}), { x: 0.5, y: 0.5 })
  assert.deepEqual(blurCenterOf({ blurX: 0.25, blurY: 1.2 }), { x: 0.25, y: 1.2 })
  // Held to ten boxes either side (validation refuses beyond).
  assert.deepEqual(blurCenterOf({ blurX: 1e22, blurY: -40 }), { x: 10, y: -10 })
  assert.deepEqual(blurCenterOf({ blurX: '0.25', blurY: NaN }), { x: 0.5, y: 0.5 })
  assert.deepEqual(blurCenterOf({ blurX: 0 }), { x: 0, y: 0.5 })
})

test('blurAngleOf: degrees mod 180, in [0, 180); not a finite number is 0', () => {
  assert.equal(blurAngleOf(null), 0)
  assert.equal(blurAngleOf({}), 0)
  assert.equal(blurAngleOf({ blurAngle: '30' }), 0)
  assert.equal(blurAngleOf({ blurAngle: NaN }), 0)
  assert.equal(blurAngleOf({ blurAngle: Infinity }), 0)
  assert.equal(blurAngleOf({ blurAngle: 30 }), 30)
  assert.equal(blurAngleOf({ blurAngle: 180 }), 0)
  assert.equal(blurAngleOf({ blurAngle: 210 }), 30)
  assert.equal(blurAngleOf({ blurAngle: -30 }), 150)
  assert.equal(blurAngleOf({ blurAngle: -180 }), 0)
  assert.equal(blurAngleOf({ blurAngle: -1e-17 }), 0)
  assert.equal(blurAngleOf({ blurAngle: 719.5 }), 179.5)
})
