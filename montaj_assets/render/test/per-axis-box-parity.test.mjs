// render/test/per-axis-box-parity.test.mjs
//
// PREVIEW / EXPORT PARITY for items placed with per-axis scale — the EXPORT half.
//
// The editor's `perAxisScale.parity.test.tsx` and `scheduler-perAxis.test.ts`
// hold the preview to a model of the export: the box is
// `toPixelBox(geometryFor(item))`, an image is fit INTO that box by its `fit`,
// and a video is `crop=`ped and then decrease-fit and padded to it. They cannot
// import this package, so this file pins that model against the filter chain
// encode-segment.js really emits. The numbers are the operator's 2026-09-28
// essay: photos and screen recordings in a 1032×1210 box on tracks[1], the
// presenter in a 1016×572 box on tracks[0], all on a 1080×1920 canvas.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geometryFor, toPixelBox } from '@bycrux/timeline-core'
import { buildImageItemFilterParts, buildVideoItemFilterParts } from '../encode-segment.js'

const VW = 1080
const VH = 1920
const SDR = { segStart: 0, duration: 4, projectColorSpace: 'sdr_bt709', zscaleAvailable: false }
const UPPER_BOX = { scale: 1, scaleX: 0.9555555556, scaleY: 0.6302083333, offsetX: 0, offsetY: -17.2395833333 }

/** The fit step's target box and the overlay position, read back out of the chain. */
function placed(filterParts) {
  const chain = filterParts.join(';')
  const fit = /scale=(\d+):(\d+):force_original_aspect_ratio=(increase|decrease)/.exec(chain)
  const at = /overlay=x=(-?\d+):y=(-?\d+)/.exec(chain)
  assert.ok(fit && at, `no fit/overlay step in ${chain}`)
  return { width: +fit[1], height: +fit[2], mode: fit[3], x: +at[1], y: +at[2], chain }
}

test('an upper-track cover image is fit into its per-axis box, not the frame', () => {
  const item = { type: 'image', src: '/hook.png', start: 0, end: 2.6238, fit: 'cover', ...UPPER_BOX }
  const p = placed(buildImageItemFilterParts(item, VW, VH, 1, '[base]', 2.6238, 0).filterParts)
  assert.deepEqual({ width: p.width, height: p.height, x: p.x, y: p.y }, toPixelBox(geometryFor(item, 'image'), VW, VH))
  assert.deepEqual([p.width, p.height, p.x, p.y], [1032, 1210, 24, 24])
  // cover: fill the box, crop the overflow to it.
  assert.equal(p.mode, 'increase')
  assert.match(p.chain, /force_original_aspect_ratio=increase,crop=1032:1210,/)
})

test('an upper-track video crops its source first, then contains it in its per-axis box', () => {
  const item = {
    type: 'video', src: '/screen.mp4', start: 0, end: 4, inPoint: 0,
    sourceCrop: { x: 0, y: 0, w: 1, h: 0.5393 }, sourceWidth: 1206, sourceHeight: 2622, ...UPPER_BOX,
  }
  const p = placed(buildVideoItemFilterParts(item, VW, VH, 1, '[base]', SDR).filterParts)
  assert.deepEqual({ width: p.width, height: p.height, x: p.x, y: p.y }, toPixelBox(geometryFor(item, 'video'), VW, VH))
  assert.equal(p.mode, 'decrease')
  // Even-rounded crop dims, origin as-is, AHEAD of the fit; centred pad after it.
  assert.match(p.chain, /crop=1206:1414:0:0,scale=1032:1210:force_original_aspect_ratio=decrease,pad=1032:1210:\(ow-iw\)\/2:\(oh-ih\)\/2/)
})

test('a tracks[0] presenter is contained in its per-axis box', () => {
  const item = {
    type: 'video', src: '/presenter.mp4', start: 0, end: 4, inPoint: 0, probedWidth: 1920, probedHeight: 1080,
    scale: 1, scaleX: 0.9407407407, scaleY: 0.2979166667, offsetX: 0, offsetY: 32.6041666667,
  }
  const p = placed(buildVideoItemFilterParts(item, VW, VH, 0, '[base]', SDR).filterParts)
  assert.deepEqual({ width: p.width, height: p.height, x: p.x, y: p.y }, toPixelBox(geometryFor(item, 'video'), VW, VH))
  assert.deepEqual([p.width, p.height, p.x, p.y], [1016, 572, 32, 1300])
  assert.equal(p.mode, 'decrease')
})
