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

// ── Keyframed per-axis items, through the export's own item collector ────────
//
// The operator's 2026-09-28 essay closer (`montaj_portrait_closer_preset.json`):
// a 16:9 presenter in a full-width band at the bottom (scaleX 1, scaleY
// 0.31640625 = 607.5/1920) that rises to centre on an `offsetY` curve, with a
// uniform `scale` curve on it too. The preview draws `geometryAt`: an authored
// scaleX/scaleY wins over the uniform `scale` track, so the band keeps its 16:9
// box. The export used to take the `scale` track for BOTH axes, a 9:16 box, and
// stretched the fitted 16:9 band 3.16x tall into it (only the eyes and nose
// showed through the closer's aperture).
//
// Routed through collectAllItems because that is the object the export really
// hands encode-segment.js; it used to stamp `scaleX ?? scale` onto every item,
// which erased whether a per-axis value was authored, the one thing
// geometryAt's fallback order depends on.

import { geometryAt } from '@bycrux/timeline-core'
import { collectAllItems } from '../render.js'

/** The emitted dialect (`if`, `between`, `round`) evaluated at ffmpeg's `t`. */
const ev = (src, t) => Function('t', `
  const round = Math.round
  const between = (x, a, b) => (x >= a && x <= b ? 1 : 0)
  const iff = (c, a, b) => (c ? a : b)
  return ${src.replace(/\bif\(/g, 'iff(')}
`)(t)

/** The export's fit box and its per-frame box, read out of the chain it emits for `item`. */
function exportedAnimation(item, duration) {
  const project = { tracks: [{ id: 'base', items: [] }, { id: 'band', items: [item] }] }
  const emitted = collectAllItems(project).videoItems[0]
  const { filterParts } = buildVideoItemFilterParts(emitted, VW, VH, 1, '[base]', { ...SDR, duration })
  const chain = filterParts.join(';')
  const fit = /scale=(\d+):(\d+):force_original_aspect_ratio=decrease/.exec(chain)
  const size = /scale=w='([^']*)':h='([^']*)':eval=frame/.exec(chain)
  const pos = /overlay=x='([^']*)':y='([^']*)'/.exec(chain)
  assert.ok(fit && size && pos, `not an animated chain: ${chain}`)
  return {
    chain,
    fit: { width: +fit[1], height: +fit[2] },
    at: (t) => ({ width: ev(size[1], t), height: ev(size[2], t), x: ev(pos[1], t), y: ev(pos[2], t) }),
  }
}

// 2 px on size: the export even-rounds an already-rounded size
// (`round(round(x)/2)*2`), toPixelBox the raw one (`round(x/2)*2`).
const near = (got, want, what) => {
  for (const [k, tol] of [['width', 2], ['height', 2], ['x', 1], ['y', 1]]) {
    assert.ok(Math.abs(got[k] - want[k]) <= tol, `${what}: ${k} ${got[k]} vs preview ${want[k]}`)
  }
}

for (const [label, sourceCrop, cropStep] of [
  ['the full frame', { x: 0, y: 0, w: 1, h: 1 }, 'crop=3840:2160:0:0,'],
  ['a centre crop', { x: 0.2, y: 0, w: 0.6, h: 1 }, 'crop=2304:2160:768:0,'],
]) {
  test(`a per-axis band with a keyframed uniform scale keeps the preview's box (sourceCrop: ${label})`, () => {
    const duration = 3
    const item = {
      id: 'closer', type: 'video', src: '/presenter.MOV', start: 0, end: duration, inPoint: 0,
      sourceWidth: 3840, sourceHeight: 2160, sourceCrop,
      scale: 1, scaleX: 1, scaleY: 0.31640625, offsetX: 0, offsetY: 34.1796875,
      keyframes: [
        { prop: 'scale', points: [{ t: 0, value: 1 }, { t: 0.9, value: 0.93 }, { t: 2.3, value: 0.465 }] },
        { prop: 'offsetY', points: [{ t: 0, value: 34.1796875 }, { t: 0.9, value: 18.75 }, { t: 2.3, value: 0 }] },
      ],
    }
    const exp = exportedAnimation(item, duration)
    // The crop still runs first, ahead of the fit into the box.
    assert.ok(exp.chain.includes(`${cropStep}scale=${exp.fit.width}:${exp.fit.height}:force_original_aspect_ratio=decrease`), exp.chain)
    for (let t = 0; t <= duration; t += 1 / 30) {
      const got = exp.at(t)
      near(got, toPixelBox(geometryAt(item, 'video', t), VW, VH), `t=${t.toFixed(3)}`)
      // And the per-frame resize after the fit is UNIFORM: the fitted footage
      // keeps its aspect instead of being stretched to a different box.
      assert.ok(Math.abs(got.width / got.height - exp.fit.width / exp.fit.height) < 0.01,
        `t=${t.toFixed(3)}: box ${got.width}x${got.height} vs fit ${exp.fit.width}x${exp.fit.height}`)
    }
    // The preview's box: 1080x608 all the way, rising from the bottom to centre.
    assert.deepEqual(exp.at(0), { width: 1080, height: 608, x: 0, y: 1313 })
    assert.deepEqual(exp.at(2.5), { width: 1080, height: 608, x: 0, y: 656 })
  })
}

test('a uniform clip keyframing only `scale` still animates, fitted at its peak', () => {
  // The other side of the same fallback: with no authored scaleX/scaleY, both
  // axes follow the animated `scale`, in the preview and in the export.
  const duration = 3
  const item = {
    id: 'zoom', type: 'video', src: '/clip.mp4', start: 0, end: duration, inPoint: 0,
    probedWidth: 1080, probedHeight: 1920, scale: 0.75, offsetX: 0, offsetY: 0,
    keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.6 }, { t: 3, value: 0.9 }] }],
  }
  const exp = exportedAnimation(item, duration)
  for (let t = 0; t <= duration; t += 1 / 30) {
    near(exp.at(t), toPixelBox(geometryAt(item, 'video', t), VW, VH), `t=${t.toFixed(3)}`)
  }
  // Fitted at the largest box it reaches, not at the static 0.75 box.
  const peak = toPixelBox({ scale: 0.9, offsetX: 0, offsetY: 0 }, VW, VH)
  assert.deepEqual(exp.fit, { width: peak.width, height: peak.height })
})
