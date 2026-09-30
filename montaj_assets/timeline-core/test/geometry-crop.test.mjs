// PV55: an image's source crop, keyframed. geometryAt folds cropX/cropY/cropW/cropH
// back into ONE sourceCrop, so every reader keeps reading sourceCrop.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  geometryAt, geometryFor, toPixelBox, hasCropKeyframes, imageFitFor,
  CROP_KEYFRAME_PROPS, RESOLVER_VERSION,
} from '../index.js'

const lin = (prop, a, b, t1 = 2) => ({ prop, points: [{ t: 0, value: a }, { t: t1, value: b }] })
const PAN = [lin('cropX', 0, 0.6), lin('cropY', 0, 0), lin('cropW', 0.4, 0.4), lin('cropH', 1, 1)]

describe('PV55: crop keyframes in geometryAt', () => {
  test('the four crop props, in x, y, w, h order', () => {
    assert.deepEqual([...CROP_KEYFRAME_PROPS], ['cropX', 'cropY', 'cropW', 'cropH'])
  })

  test('an image samples its crop tracks into sourceCrop, clamping past the last key', () => {
    const item = { keyframes: PAN }
    assert.deepEqual(geometryAt(item, 'image', 0).sourceCrop, { x: 0, y: 0, w: 0.4, h: 1 })
    assert.ok(Math.abs(geometryAt(item, 'image', 1).sourceCrop.x - 0.3) < 1e-12)
    assert.deepEqual(geometryAt(item, 'image', 5).sourceCrop, { x: 0.6, y: 0, w: 0.4, h: 1 })
  })

  test('a crop prop with no track falls back to the static sourceCrop, then to the full frame', () => {
    const withStatic = { sourceCrop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, keyframes: [lin('cropX', 0, 0.4)] }
    assert.deepEqual(geometryAt(withStatic, 'image', 2).sourceCrop, { x: 0.4, y: 0.2, w: 0.5, h: 0.6 })
    const bare = { keyframes: [lin('cropW', 1, 0.5)] }
    assert.deepEqual(geometryAt(bare, 'image', 2).sourceCrop, { x: 0, y: 0, w: 0.5, h: 1 })
  })

  test('crop tracks never move the box', () => {
    const item = { scale: 0.8, offsetX: 5, keyframes: PAN }
    assert.deepEqual(toPixelBox(geometryAt(item, 'image', 1), 1080, 1920), toPixelBox(geometryFor(item, 'image'), 1080, 1920))
  })

  test("an image whose crop is keyframed resolves fit 'cover'; one without keeps its own fit", () => {
    assert.equal(geometryAt({ fit: 'contain', keyframes: PAN }, 'image', 1).fit, 'cover')
    assert.equal(geometryAt({ fit: 'contain', keyframes: [lin('scale', 1, 2)] }, 'image', 1).fit, 'contain')
  })

  test('phase 2: a video samples its crop tracks like an image, and its fit stays contain', () => {
    const item = { sourceCrop: { x: 0.1, y: 0, w: 0.5, h: 1 }, keyframes: PAN }
    assert.deepEqual(geometryAt(item, 'video', 0).sourceCrop, { x: 0, y: 0, w: 0.4, h: 1 })
    assert.ok(Math.abs(geometryAt(item, 'video', 1).sourceCrop.x - 0.3) < 1e-12)
    assert.deepEqual(geometryAt(item, 'video', 5).sourceCrop, { x: 0.6, y: 0, w: 0.4, h: 1 })
    assert.equal(geometryAt(item, 'video', 1).fit, 'contain')
    assert.equal(geometryAt({ keyframes: [lin('cropW', 1, 0.5)] }, 'video', 2).sourceCrop.h, 1)
  })

  test('an overlay still IGNORES crop tracks (sourceCrop by reference)', () => {
    const crop = { x: 0.1, y: 0, w: 0.5, h: 1 }
    assert.equal(geometryAt({ sourceCrop: crop, keyframes: PAN }, 'overlay', 1).sourceCrop, crop)
  })

  test('a video animating only its box forwards sourceCrop by reference', () => {
    const crop = { x: 0.1, y: 0, w: 0.5, h: 1 }
    assert.equal(geometryAt({ sourceCrop: crop, keyframes: [lin('scale', 1, 2)] }, 'video', 1).sourceCrop, crop)
  })

  test('an image animating only its box still forwards sourceCrop by reference', () => {
    const crop = { x: 0.1, y: 0, w: 0.5, h: 1 }
    assert.equal(geometryAt({ sourceCrop: crop, keyframes: [lin('scale', 1, 2)] }, 'image', 1).sourceCrop, crop)
  })

  test('hasCropKeyframes: any non-empty crop track, nothing else', () => {
    assert.equal(hasCropKeyframes({ keyframes: PAN }), true)
    assert.equal(hasCropKeyframes({ keyframes: [{ prop: 'cropX', points: [] }] }), false)
    assert.equal(hasCropKeyframes({ keyframes: [lin('scale', 1, 2)] }), false)
    assert.equal(hasCropKeyframes({}), false)
    assert.equal(hasCropKeyframes(null), false)
  })

  test("imageFitFor: 'cover' when the crop is keyframed, else the item's fit, default 'cover'", () => {
    assert.equal(imageFitFor({ fit: 'fill', keyframes: PAN }), 'cover')
    assert.equal(imageFitFor({ fit: 'fill' }), 'fill')
    assert.equal(imageFitFor({}), 'cover')
  })

  test('RESOLVER_VERSION was bumped: geometry output changed for the same input', () => {
    assert.equal(RESOLVER_VERSION, '6')
  })
})
