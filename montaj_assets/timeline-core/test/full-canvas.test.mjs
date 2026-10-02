// montaj_assets/timeline-core/test/full-canvas.test.mjs
//
// `opaque: true` replaces the picture only when the overlay covers the whole
// canvas. A scaled photo marked opaque used to black out the footage around it
// in preview and export alike.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFullCanvasPlacement, opaqueReplacesPicture } from '../index.js'

const full = { scale: 1, offsetX: 0, offsetY: 0, rotation: 0 }

const notFull = [
  ['scaled down', { scale: 0.38 }],
  ['scaled on one axis', { scaleX: 0.8 }],
  ['scaled up', { scaleY: 1.2 }],
  ['moved', { offsetX: 10 }],
  ['moved vertically', { offsetY: -4 }],
  ['rotated', { rotation: 3 }],
  ['a placement keyframe', { keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 1, value: 0.5 }] }] }],
  ['a keyframe track naming no prop', { keyframes: [{ t: 0 }] }],
]

test('isFullCanvasPlacement: identity geometry, absent or explicit, is full canvas', () => {
  assert.equal(isFullCanvasPlacement(full), true)
  assert.equal(isFullCanvasPlacement({}), true, 'defaults are full canvas')
  assert.equal(isFullCanvasPlacement({ scale: null, offsetX: null, rotation: undefined }), true)
})

test('isFullCanvasPlacement: anything scaled, moved, rotated or moved by a keyframe is not', () => {
  for (const [why, geo] of notFull) assert.equal(isFullCanvasPlacement({ ...full, ...geo }), false, why)
})

test('isFullCanvasPlacement: an opacity keyframe (a derived crossfade) does not move the item', () => {
  const fade = { prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 0.5, value: 1 }] }
  assert.equal(isFullCanvasPlacement({ ...full, keyframes: [fade] }), true)
  assert.equal(isFullCanvasPlacement({ ...full, keyframes: [] }), true)
})

test('isFullCanvasPlacement: total over a missing item', () => {
  assert.equal(isFullCanvasPlacement(null), false)
  assert.equal(isFullCanvasPlacement(undefined), false)
})

test('opaqueReplacesPicture: only an opaque overlay over the whole canvas replaces the picture', () => {
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true }), true)
  assert.equal(opaqueReplacesPicture({ opaque: true }), true)
  assert.equal(opaqueReplacesPicture({ ...full }), false, 'not opaque')
  assert.equal(opaqueReplacesPicture({ ...full, opaque: false }), false)
  assert.equal(opaqueReplacesPicture({ ...full, opaque: 'true' }), false, 'only the boolean')
  for (const [why, geo] of notFull) {
    assert.equal(opaqueReplacesPicture({ ...full, ...geo, opaque: true }), false, why)
  }
})
