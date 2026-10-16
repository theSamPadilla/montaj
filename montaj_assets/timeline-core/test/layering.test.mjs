// montaj_assets/timeline-core/test/layering.test.mjs (§308 P3)
//
// trackLayerPositions is the editor's canonical track order, which the export
// and sample_frame now stack by: every track holding video first, then the
// rest, each group in JSON order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trackLayerPositions } from '../index.js'

const v = { type: 'video' }, i = { type: 'image' }, o = { type: 'overlay' }

test('trackLayerPositions: a project already in canonical order keeps its indices', () => {
  assert.deepEqual(trackLayerPositions([[v], [o], [i], [o]]), [0, 1, 2, 3])
  assert.deepEqual(trackLayerPositions([[v], [v, i], [o]]), [0, 1, 2])
  assert.deepEqual(trackLayerPositions([[i], [o]]), [0, 1], 'no video: JSON order')
  assert.deepEqual(trackLayerPositions([]), [])
})

test('trackLayerPositions: every track holding video moves below the rest, each group stable', () => {
  // An image-only track listed below the footage draws over it, as the editor shows it.
  assert.deepEqual(trackLayerPositions([[i], [v], [o]]), [1, 0, 2])
  assert.deepEqual(trackLayerPositions([[v], [o], [v], [i]]), [0, 2, 1, 3])
  assert.deepEqual(trackLayerPositions([[o], [i, v], [i]]), [1, 0, 2], 'one video item makes a track a video track')
})

test('trackLayerPositions: empty, missing and malformed tracks are non-video tracks', () => {
  assert.deepEqual(trackLayerPositions([[], [v], null, [undefined, o]]), [1, 0, 2, 3])
  assert.deepEqual(trackLayerPositions(undefined), [])
})
