// render/test/opaque-fade.test.mjs (§309)
//
// An opaque overlay replaces the picture beneath it only where it is at full
// opacity. A crossfade from one opaque 3D item to another (two overlapping
// items, an opacity key on the top one) showed nothing of the lower one: the
// top item's capture had no alpha, so its fade showed the page background, and
// the planner culled the footage for the item's whole span.
//
// Unit level: the segment plan, the spec's capture flag and captureOptionsFor.
// The rendered pixels are opaque-fade.integration.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundariesFrom, activeIn, captionsLast, byTrackIdx, isFullCanvasPlacement, opacityAt } from '@bycrux/timeline-core'
import { planSegments } from '../segment-plan.js'
import { collectPuppeteerSegments } from '../render.js'
import { captureOptionsFor } from '../renderer.js'

const FPS = 30
const clip = { id: 'c1', type: 'video', start: 0, end: 6, src: '/a.mp4', inPoint: 0, outPoint: 6, trackIdx: 0 }
const cover = (extra = {}) => ({
  id: 'ov', startSeconds: 0, endSeconds: 4, webmPath: '/ov.mkv', opaque: true, isCaption: false,
  scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 1, ...extra,
})
const opacity = (...points) => [{ prop: 'opacity', points: points.map(([t, value, easing]) => ({ t, value, ...(easing ? { easing } : {}) })) }]
const spans = segs => segs.map(s => [s.start, s.end, s.opaqueVideo])

test('planSegments: an opaque overlay fading out stops culling the footage where it leaves 1', () => {
  const segs = planSegments([clip], [cover({ keyframes: opacity([1, 1], [2, 0]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(segs), [[0, 1, true], [1, 4, false], [4, 6, false]])
})

test('planSegments: a dip below 1 and back culls only the stretches at 1', () => {
  const segs = planSegments([clip], [cover({ keyframes: opacity([1, 1], [2, 0.3], [3, 1]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(segs), [[0, 1, true], [1, 3, false], [3, 4, true], [4, 6, false]])
})

test('planSegments: a static opacity below 1 never culls, and adds no edge', () => {
  const segs = planSegments([clip], [cover({ opacity: 0.5 })], 1080, 1920, FPS)
  assert.deepEqual(spans(segs), [[0, 4, false], [4, 6, false]])
})

test('planSegments: an edge between frames lands on the first frame drawn at 1', () => {
  // 1.01 s is frame 30.3: frame 30 is still fading in (0.99), frame 31 is at 1.
  const segs = planSegments([clip], [cover({ keyframes: opacity([0, 0], [1.01, 1]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(segs).slice(0, 2), [[0, 31 / FPS, false], [31 / FPS, 4, true]])
  // A fade out leaving 1 at frame 45.6: frame 45 is drawn at 1, but its
  // stretch to frame 46 is not (a motion-blur sub-frame reaches past 1.52), so
  // it is the first not culled.
  const out = planSegments([clip], [cover({ keyframes: opacity([1.52, 1], [2, 0]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(out).slice(0, 2), [[0, 45 / FPS, true], [45 / FPS, 4, false]])
})

test('planSegments: a key a hair after a frame does not claim that frame (the bake\'s own float division)', () => {
  // 3/30 - 1/30 is 0.06666666666666668, just past frame 2 (2/30 is
  // 0.06666666666666667). The bake samples frame 2 before the key, at 0: culling
  // the footage there drew a black frame.
  const key = 3 / 30 - 1 / 30
  const o = cover({ endSeconds: 3, keyframes: opacity([0, 0, 'hold'], [key, 1]) })
  assert.equal(opacityAt(o, 2 / FPS), 0, 'frame 2 is drawn at 0')
  const segs = planSegments([clip], [o], 1080, 1920, FPS)
  assert.deepEqual(spans(segs).slice(0, 2), [[0, 3 / FPS, false], [3 / FPS, 3, true]])
})

test('planSegments: the end of a stretch at 1 is the last frame whose motion-blur sub-frames all stay at 1', () => {
  // A hold 1 -> 0 at 2.25 s is frame 67.5: frame 67 is drawn at 1, but with
  // motion blur x4 its sub-frames at 67.5 and 67.75 are at 0, over the footage.
  const o = cover({ keyframes: opacity([0, 1, 'hold'], [2.25, 0]) })
  assert.deepEqual([0, 1, 2, 3].map(k => opacityAt(o, (67 + k / 4) / FPS)), [1, 1, 0, 0])
  const segs = planSegments([clip], [o], 1080, 1920, FPS)
  assert.deepEqual(spans(segs).slice(0, 2), [[0, 67 / FPS, true], [67 / FPS, 4, false]])
})

test('planSegments: stretches at 1 shorter than a second are read as not full, so a flicker plans no segments', () => {
  // 60 s flickering between 1 and 0.85 every 0.1 s: 600 segments before.
  const points = []
  for (let k = 0; k < 600; k++) points.push([k * 0.1, k % 2 ? 0.85 : 1, 'hold'])
  const long = { ...clip, end: 60, outPoint: 60 }
  const flicker = cover({ endSeconds: 60, keyframes: opacity(...points) })
  const segs = planSegments([long], [flicker], 1080, 1920, FPS)
  assert.ok(segs.length <= 3, `${segs.length} segments`)
  assert.ok(segs.every(s => !s.opaqueVideo), 'never culls: it is never at 1 for a second')
  // A steady 1 is unchanged, however short.
  const steady = planSegments([long], [cover({ endSeconds: 0.5 })], 1080, 1920, FPS)
  assert.deepEqual(spans(steady), [[0, 0.5, true], [0.5, 60, false]])
  // A key-bounded stretch of exactly a second still counts.
  const second = planSegments([clip], [cover({ keyframes: opacity([0, 0], [1, 1], [2, 1], [2.5, 0]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(second), [[0, 1, false], [1, 2, true], [2, 4, false], [4, 6, false]])
  const short = planSegments([clip], [cover({ keyframes: opacity([0, 0], [1, 1], [1.9, 1], [2.5, 0]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(short), [[0, 4, false], [4, 6, false]])
})

test('planSegments: an opacity track whose times do not increase never culls', () => {
  // A fade in written newest-first: the bake reads it in stored order, at 0
  // throughout, so nothing beneath may be culled.
  const segs = planSegments([clip], [cover({ keyframes: opacity([1, 1], [0, 0]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(segs), [[0, 4, false], [4, 6, false]])
})

test('planSegments: keys are item-relative, from the overlay\'s own start', () => {
  const segs = planSegments([clip], [cover({ startSeconds: 2, endSeconds: 5, keyframes: opacity([1, 1], [2, 0]) })], 1080, 1920, FPS)
  assert.deepEqual(spans(segs), [[0, 2, false], [2, 3, true], [3, 5, false], [5, 6, false]])
})

test('planSegments: a 3D crossfade, the top item fading over a lower opaque one, keeps culling under the lower one', () => {
  // The lower item covers the canvas at 1 throughout, so the footage stays
  // hidden; only the top item's own capture had to change (fades, below).
  const lower = cover({ id: 'lower', startSeconds: 0, endSeconds: 4 })
  const upper = cover({ id: 'upper', startSeconds: 2, endSeconds: 4, keyframes: opacity([0, 1], [1, 0]) })
  const segs = planSegments([clip], [lower, upper], 1080, 1920, FPS)
  assert.deepEqual(spans(segs), [[0, 2, true], [2, 4, true], [4, 6, false]])
})

// The pre-§309 planner, frozen: the same boundary pipeline and containment,
// and the cull of every opaque overlay over the whole canvas, whatever its
// opacity.
function planSegmentsBefore(allItems, puppeteerSegs, vw, vh, fps) {
  const readPuppeteer = s => ({ start: s.startSeconds, end: s.endSeconds })
  const snapped = boundariesFrom([...allItems.map(i => ({ start: i.start, end: i.end })), ...puppeteerSegs.map(readPuppeteer)], fps)
  const segments = []
  for (let i = 0; i < snapped.length - 1; i++) {
    const start = snapped[i]
    const end = snapped[i + 1]
    const items = activeIn(allItems, start, end, fps).sort(byTrackIdx)
    const overlays = captionsLast(activeIn(puppeteerSegs, start, end, fps, readPuppeteer))
    const opaqueVideo = overlays.some(o => o.opaque === true && isFullCanvasPlacement(o))
    segments.push({ start, end, items, opaqueVideo, overlays, vw, vh, fps })
  }
  return segments
}

test('planSegments: byte-identical plans for projects with no opacity keys on an opaque overlay', () => {
  const caption = { id: 'captions', startSeconds: 0, endSeconds: 6, webmPath: '/c.mkv', isCaption: true }
  const plans = [
    [cover()],
    [cover({ opacity: undefined })],
    [cover({ startSeconds: 1.017, endSeconds: 3.49 }), caption],
    // A non-opaque overlay's keys, and a scaled opaque one's, never cull.
    [cover({ opaque: false, keyframes: opacity([0, 0], [1, 1]) })],
    [cover({ scale: 0.4, keyframes: opacity([0, 0], [1, 1]) })],
    [cover({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 1, value: 2 }] }] })],
    // Opacity keys that never leave 1 add no edge and cull throughout.
    [cover({ keyframes: opacity([0, 1], [2, 1, 'ease']) })],
    // An editor-derived opaque crossfade on one track: the outgoing side holds
    // at 1 (no track), the incoming fades in and reaches 1 where the outgoing
    // ends, which is already an edge.
    [cover({ id: 'a', startSeconds: 0, endSeconds: 3 }), cover({ id: 'b', startSeconds: 2, endSeconds: 5, keyframes: opacity([0, 0], [1, 1]) })],
  ]
  for (const overlays of plans) {
    for (const fps of [24, 30, 60]) {
      const items = [clip, { ...clip, id: 'c2', start: 6, end: 9 }]
      assert.equal(
        JSON.stringify(planSegments(items, overlays, 1080, 1920, fps)),
        JSON.stringify(planSegmentsBefore(items, overlays, 1080, 1920, fps)),
        `${JSON.stringify(overlays.map(o => o.id + (o.keyframes ? '+keys' : '')))} @ ${fps}`,
      )
    }
  }
})

test('collectPuppeteerSegments: an opaque overlay that is not at 1 for its whole life is marked to fade', () => {
  const project = {
    settings: { fps: FPS },
    tracks: [
      [],
      [
        { id: 'steady', type: 'overlay', src: '/abs/a.jsx', start: 0, end: 2, opaque: true },
        { id: 'fading', type: 'overlay', src: '/abs/b.jsx', start: 2, end: 4, opaque: true, keyframes: opacity([0, 1], [1, 0]) },
        { id: 'dim', type: 'overlay', src: '/abs/c.jsx', start: 4, end: 6, opaque: true, opacity: 0.5 },
        { id: 'keyedAtOne', type: 'overlay', src: '/abs/d.jsx', start: 6, end: 8, opaque: true, keyframes: opacity([0, 1], [1, 1]) },
        { id: 'plain', type: 'overlay', src: '/abs/e.jsx', start: 8, end: 10, keyframes: opacity([0, 1], [1, 0]) },
      ],
    ],
  }
  const specs = collectPuppeteerSegments(project, FPS, 1080, 1920, '/tmp/seg')
  const byId = Object.fromEntries(specs.map(s => [s.id.split('--')[1], s]))
  assert.equal('fades' in byId.steady, false, 'a steady opaque overlay is captured as before')
  assert.equal('fades' in byId.keyedAtOne, false)
  assert.equal('fades' in byId.plain, false, 'a transparent overlay already has alpha')
  assert.equal(byId.fading.fades, true)
  assert.equal(byId.dim.fades, true)
  for (const id of ['steady', 'fading', 'dim', 'keyedAtOne']) assert.equal(byId[id].opaque, true, `${id} stays an opaque cover (HDR card, capture base)`)
})

test('captureOptionsFor: an opaque overlay that fades is captured WITH alpha, a steady one is not', () => {
  const fading = captureOptionsFor({ id: 'seg', opaque: true, fades: true, sdrMaster: true })
  assert.deepEqual(fading, { omitBackground: true, pixFmt: 'yuva420p', format: 'png' })
  const steady = captureOptionsFor({ id: 'seg', opaque: true, sdrMaster: true })
  assert.deepEqual(steady, { omitBackground: false, pixFmt: 'yuv420p', format: 'jpeg' })
})
