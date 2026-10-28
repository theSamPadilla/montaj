import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MASK_SHAPES, BLEND_MODES, MASK_KEYFRAME_PROPS, maskAt, hasMaskKeyframes, maskSigmaPx,
  maskPolygon, rasterizeMask, maskSvg, blendModeOf, cssBlendMode, isPlainComposite,
} from '../index.js'

const ell = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5 }

test('constants', () => {
  assert.deepEqual([...MASK_SHAPES], ['ellipse', 'rect', 'wipe'])
  assert.deepEqual([...BLEND_MODES], ['normal', 'screen', 'multiply', 'add', 'lighten', 'darken', 'overlay'])
  assert.deepEqual([...MASK_KEYFRAME_PROPS], ['maskX', 'maskY', 'maskW', 'maskH', 'maskRotation', 'maskFeather'])
})

test('maskAt: defaults, tracks override, invalid is null', () => {
  assert.equal(maskAt({}, 0), null)
  assert.equal(maskAt({ mask: { shape: 'star' } }, 0), null)
  assert.deepEqual(maskAt({ mask: { shape: 'rect' } }, 0),
    { shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, radius: 0, feather: 0, invert: false })
  const item = { mask: { ...ell, feather: 0.1 }, keyframes: [
    { prop: 'maskW', points: [{ t: 0, value: 0.2 }, { t: 2, value: 1 }] },
    { prop: 'maskFeather', points: [{ t: 0, value: 0 }, { t: 2, value: 0.2 }] },
  ] }
  const m = maskAt(item, 1)
  assert.ok(Math.abs(m.w - 0.6) < 1e-9)
  assert.ok(Math.abs(m.feather - 0.1) < 1e-9)
  assert.equal(m.h, 0.5)
  assert.equal(hasMaskKeyframes(item), true)
  assert.equal(hasMaskKeyframes({ mask: ell }), false)
  assert.equal(hasMaskKeyframes({ keyframes: item.keyframes }), false) // no mask, tracks do nothing
})

test('maskAt clamps out-of-range values', () => {
  const m = maskAt({ mask: { shape: 'rect', w: -1, radius: 3, feather: 9 } }, 0)
  assert.ok(m.w > 0)
  assert.equal(m.radius, 1)
  assert.equal(m.feather, 0.5)
})

test('maskSigmaPx is feather x the shorter side', () => {
  assert.equal(maskSigmaPx({ ...ell, feather: 0.1 }, 1000, 500), 50)
  assert.equal(maskSigmaPx({ ...ell, feather: 0 }, 1000, 500), 0)
})

test('maskPolygon: ellipse is convex, centred, inside its radii', () => {
  const pts = maskPolygon(maskAt({ mask: ell }, 0), 200, 100)
  assert.ok(pts.length >= 128)
  for (const [x, y] of pts) {
    const r = Math.hypot((x - 100) / 50, (y - 50) / 25)
    assert.ok(Math.abs(r - 1) < 1e-9)
  }
})

test('maskPolygon: rect with radius 0 is its four corners, rotated about the centre', () => {
  const pts = maskPolygon(maskAt({ mask: { shape: 'rect', w: 0.5, h: 0.5, rotation: 90 } }, 0), 200, 200)
  const xs = pts.map(p => Math.round(p[0])), ys = pts.map(p => Math.round(p[1]))
  assert.equal(Math.min(...xs), 50); assert.equal(Math.max(...xs), 150)
  assert.equal(Math.min(...ys), 50); assert.equal(Math.max(...ys), 150)
})

test('rasterizeMask: coverage inside 255, outside 0, edge between; invert flips', () => {
  const m = maskAt({ mask: { shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }, 0)
  const { data, width, height, margin } = rasterizeMask(m, 100, 100, { margin: 0 })
  assert.equal(width, 100); assert.equal(height, 100); assert.equal(margin, 0)
  assert.equal(data[50 * 100 + 50], 255)
  assert.equal(data[5 * 100 + 5], 0)
  const inv = rasterizeMask({ ...m, invert: true }, 100, 100, { margin: 0 }).data
  assert.equal(inv[50 * 100 + 50], 0)
  assert.equal(inv[5 * 100 + 5], 255)
  // a half-covered edge pixel: a rect edge at x = 24.5 covers half of pixel 24
  const half = rasterizeMask({ ...m, w: 0.51 }, 100, 100, { margin: 0 }).data
  assert.ok(half[50 * 100 + 24] > 100 && half[50 * 100 + 24] < 160)
})

test('rasterizeMask: the margin extends the plane (default 3 sigma, ceil)', () => {
  const m = maskAt({ mask: { ...ell, feather: 0.1 } }, 0)
  const r = rasterizeMask(m, 100, 100)
  assert.equal(r.margin, 30)
  assert.equal(r.width, 160); assert.equal(r.height, 160)
})

test('rasterizeMask: wipe at rotation 0 shows the left side', () => {
  const m = maskAt({ mask: { shape: 'wipe', x: 0.5 } }, 0)
  const { data } = rasterizeMask(m, 100, 10, { margin: 0 })
  assert.equal(data[5 * 100 + 10], 255)
  assert.equal(data[5 * 100 + 90], 0)
})

test('maskSvg: same polygon, blur only when feathered, inverted colours', () => {
  const m = maskAt({ mask: { shape: 'rect' } }, 0)
  const svg = maskSvg(m, 200, 100)
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 200 100" preserveAspectRatio="none">/)
  assert.ok(!svg.includes('feGaussianBlur'))
  assert.match(svg, /<polygon points="[^"]+" fill="#fff"/)
  const soft = maskSvg({ ...m, feather: 0.1 }, 200, 100)
  assert.match(soft, /<feGaussianBlur stdDeviation="10"\/>/)
  // user-space filter region: the box plus 3 sigma, not a fraction of the shape's own box
  assert.match(soft, /<filter id="f" filterUnits="userSpaceOnUse" x="-30" y="-30" width="260" height="160">/)
  const inv = maskSvg({ ...m, invert: true }, 200, 100)
  assert.match(inv, /<rect [^>]*fill="#fff"/)
  assert.match(inv, /<polygon points="[^"]+" fill="#000"/)
})

test('maskSvg: the filter region holds the whole blur of a small shape (box +/- 3 sigma)', () => {
  const m = maskAt({ mask: { shape: 'ellipse', w: 0.1, h: 0.1, feather: 0.2 } }, 0)
  const svg = maskSvg(m, 400, 400)
  const f = svg.match(/<filter id="f" filterUnits="userSpaceOnUse" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/)
  assert.ok(f, svg)
  const [x, y, w, h] = f.slice(1).map(Number)
  const m3 = 3 * 0.2 * 400 - 0.01 // fmt rounds to 2 decimals
  assert.ok(x <= -m3 && y <= -m3 && x + w >= 400 + m3 && y + h >= 400 + m3)
})

test('blend modes', () => {
  assert.equal(blendModeOf({}), 'normal')
  assert.equal(blendModeOf({ blendMode: 'bogus' }), 'normal')
  assert.equal(blendModeOf({ blendMode: 'screen' }), 'screen')
  assert.equal(cssBlendMode('add'), 'plus-lighter')
  assert.equal(cssBlendMode('overlay'), 'overlay')
  assert.equal(isPlainComposite({ opacity: 1 }), true)
  assert.equal(isPlainComposite({ mask: ell }), false)
  assert.equal(isPlainComposite({ blendMode: 'multiply' }), false)
  assert.equal(isPlainComposite({ opacity: 0.5 }), false)
  assert.equal(isPlainComposite({ keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 1 }, { t: 1, value: 0 }] }] }), false)
})
