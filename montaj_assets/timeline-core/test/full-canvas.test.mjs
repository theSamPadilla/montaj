// montaj_assets/timeline-core/test/full-canvas.test.mjs
//
// `opaque: true` replaces the picture only when the overlay covers the whole
// canvas. A scaled photo marked opaque used to black out the footage around it
// in preview and export alike.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFullCanvasPlacement, isOpaqueCover, opaqueReplacesPicture, opacityAt, fullOpacitySpans, geometryAt } from '../index.js'

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

// ── §309: the cull honours opacity ──────────────────────────────────────────
//
// An opaque item replaces the picture only where it is at full opacity. A
// crossfade from one opaque 3D item to another (two overlapping items, an
// opacity key on the top one) showed nothing of the lower one, in render,
// sample_frame and the editor preview alike.

const fadeOut = { prop: 'opacity', points: [{ t: 1, value: 1 }, { t: 2, value: 0 }] }
const fadeIn = { prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 0.5, value: 1 }] }

test('isOpaqueCover: the placement rule alone, a fade included', () => {
  assert.equal(isOpaqueCover({ ...full, opaque: true }), true)
  assert.equal(isOpaqueCover({ ...full, opaque: true, keyframes: [fadeOut] }), true)
  assert.equal(isOpaqueCover({ ...full, opaque: true, opacity: 0.4 }), true)
  assert.equal(isOpaqueCover({ ...full, opaque: true, scale: 0.5 }), false)
  assert.equal(isOpaqueCover({ ...full }), false)
})

test('opacityAt: the opacity geometryAt draws at that instant', () => {
  const items = [
    {},
    { opacity: 0.25 },
    { opacity: 0.25, keyframes: [fadeOut] },
    { keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }], opacity: 0.5 },
    { keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0.2, easing: 'ease-in' }, { t: 1, value: 0.9 }] }] },
  ]
  for (const item of items) {
    for (const t of [0, 0.3, 1, 1.5, 2, 9]) {
      assert.equal(opacityAt(item, t), geometryAt(item, 'overlay', t).opacity, `${JSON.stringify(item)} @ ${t}`)
    }
  }
})

test('fullOpacitySpans: where the curve is exactly 1, half-open, read off its keys', () => {
  const spans = (keyframes, extra = {}) => fullOpacitySpans({ ...extra, keyframes })
  assert.deepEqual(fullOpacitySpans({}), [[-Infinity, Infinity]], 'no opacity at all is 1 throughout')
  assert.deepEqual(fullOpacitySpans({ opacity: 1 }), [[-Infinity, Infinity]])
  assert.deepEqual(fullOpacitySpans({ opacity: 0.5 }), [], 'a static opacity below 1 is never full')
  assert.deepEqual(spans([fadeIn]), [[0.5, Infinity]], 'a fade in reaches 1 at its last key')
  assert.deepEqual(spans([fadeOut]), [[-Infinity, 1]], 'a fade out leaves 1 at its first key')
  assert.deepEqual(spans([fadeOut], { opacity: 0.3 }), [[-Infinity, 1]], 'the track wins over the static value')
  assert.deepEqual(
    spans([{ prop: 'opacity', points: [{ t: 0, value: 1 }, { t: 1, value: 0 }, { t: 2, value: 1 }] }]),
    [[-Infinity, 0], [2, Infinity]], 'a dip below 1 and back')
  assert.deepEqual(
    spans([{ prop: 'opacity', points: [{ t: 0, value: 1, easing: 'ease-in-out' }, { t: 1, value: 1 }, { t: 2, value: 0.5 }] }]),
    [[-Infinity, 1]], 'any easing between two 1s stays at 1')
  assert.deepEqual(
    spans([{ prop: 'opacity', points: [{ t: 0, value: 1, easing: 'hold' }, { t: 1, value: 0 }] }]),
    [[-Infinity, 1]], 'a hold keeps the 1 it leaves up to the next key')
  assert.deepEqual(
    spans([{ prop: 'opacity', points: [{ t: 0, value: 0, easing: 'hold' }, { t: 1, value: 1 }] }]),
    [[1, Infinity]], 'a hold onto 1 reaches it at the next key')
  assert.deepEqual(
    spans([{ prop: 'opacity', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }, { t: 2, value: 0.5 }] }]),
    [], 'touching 1 for one instant is not a span')
  assert.deepEqual(spans([{ prop: 'opacity', points: [{ t: 3, value: 1 }] }]), [[-Infinity, Infinity]], 'one key is a constant')
  assert.deepEqual(spans([{ prop: 'opacity', points: [{ t: 3, value: 0.7 }] }]), [])
  // The bake reads keys in stored order (sampleTrack); a track whose times do
  // not strictly increase claims no span, so it never culls.
  assert.deepEqual(spans([{ prop: 'opacity', points: [{ t: 2, value: 0 }, { t: 1, value: 1 }] }]), [], 'out of order never culls')
  assert.deepEqual(spans([{ prop: 'opacity', points: [{ t: 1, value: 1 }, { t: 0, value: 0 }] }]), [], 'a fade written newest-first never culls')
  assert.deepEqual(
    spans([{ prop: 'opacity', points: [{ t: 0, value: 1 }, { t: 1, value: 0 }, { t: 1, value: 1 }] }]), [], 'two keys at one time never cull')
  assert.deepEqual(
    spans([{ prop: 'opacity', points: [{ t: 0, value: 1 }, { t: NaN, value: 0 }, { t: 2, value: 1 }] }]),
    [[-Infinity, Infinity]], 'an unusable key is skipped, as sampleTrack skips it')
  assert.deepEqual(spans([{ prop: 'opacity', points: [{ t: NaN, value: 0 }] }], { opacity: 0.5 }), [],
    'a track with no usable key falls back to the static value')
  assert.deepEqual(spans([{ prop: 'scale', points: [{ t: 0, value: 2 }] }]), [[-Infinity, Infinity]], 'another prop\'s track is not opacity')
})

test('fullOpacitySpans agrees with opacityAt on a fine grid', () => {
  const tracks = [
    fadeIn, fadeOut,
    { prop: 'opacity', points: [{ t: 0, value: 1 }, { t: 1, value: 0, easing: 'ease' }, { t: 2, value: 1 }, { t: 3, value: 1, easing: 'hold' }, { t: 4, value: 0.2 }] },
  ]
  for (const track of tracks) {
    const item = { keyframes: [track] }
    const spans = fullOpacitySpans(item)
    for (let i = 0; i <= 500; i++) {
      const t = i / 100
      const inSpan = spans.some(([a, b]) => a <= t && t < b)
      // In a span means exactly 1. Out of one means below 1, except at the one
      // instant a span ends (the half-open edge, read as a fade).
      if (inSpan) assert.equal(opacityAt(item, t), 1, `${t}`)
      else if (!spans.some(([, b]) => b === t)) assert.notEqual(opacityAt(item, t), 1, `${t}`)
    }
  }
})

test('opaqueReplacesPicture: an instant counts only at full opacity', () => {
  const fading = { ...full, opaque: true, keyframes: [fadeOut] }
  assert.equal(opaqueReplacesPicture(fading, 0.5), true, 'before the fade')
  assert.equal(opaqueReplacesPicture(fading, 1), true, 'at the key, still 1')
  assert.equal(opaqueReplacesPicture(fading, 1.5), false, 'mid-fade the item beneath shows through')
  assert.equal(opaqueReplacesPicture(fading, 2), false, 'at 0')
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true }, 7), true, 'a steady 1 still replaces it')
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true, opacity: 0.6 }, 0), false, 'a static opacity below 1 never does')
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true, scale: 0.5 }, 0), false, 'placement still rules')
  assert.equal(opaqueReplacesPicture({ ...full, keyframes: [fadeOut] }, 0.5), false, 'not opaque')
})

test('opaqueReplacesPicture with no instant: full opacity for the whole life', () => {
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true }), true)
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true, opacity: 1 }), true)
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true, keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 1 }, { t: 2, value: 1 }] }] }), true)
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true, keyframes: [fadeIn] }), false, 'a fade')
  assert.equal(opaqueReplacesPicture({ ...full, opaque: true, opacity: 0.6 }), false, 'static below 1')
})
