// render/test/segment-plan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSegments } from '../segment-plan.js'

test('planSegments: single clip fills timeline', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0, outPoint: 5, trackIdx: 0 }
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].start, 0)
  assert.equal(segs[0].end, 5)
  assert.equal(segs[0].items.length, 1)
  assert.equal(segs[0].items[0].src, '/a.mp4')
  assert.equal(segs[0].items[0].type, 'video')
})

test('planSegments: gap between clips produces empty-items segment', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 3, src: '/a.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
    { id: 'c2', type: 'video', start: 5, end: 8, src: '/b.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  assert.equal(segs.length, 3)
  assert.equal(segs[1].start, 3)
  assert.equal(segs[1].end, 5)
  assert.equal(segs[1].items.length, 0) // black — no active items
})

test('planSegments: image item produces looped-image segment', () => {
  const items = [
    { id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', trackIdx: 0 }
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].items[0].type, 'image')
  assert.equal(segs[0].items[0].src, '/bg.jpg')
})

test('planSegments: overlays attached to overlapping segments', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'ov1', startSeconds: 2, endSeconds: 5, webmPath: '/ov.mkv', opaque: false, isCaption: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  assert.equal(segs.length, 3)
  assert.equal(segs[1].overlays.length, 1)
  assert.equal(segs[1].overlays[0].id, 'ov1')
})

test('planSegments: opaque overlay keeps items (for audio) and flags opaqueVideo', () => {
  // Regression: opaque overlays must NOT drop the underlying footage's audio.
  // The items are retained so the encoder can still source their voiceover; the
  // opaqueVideo flag tells the encoder to skip only their VIDEO compositing.
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'ov1', startSeconds: 0, endSeconds: 3, webmPath: '/ov.mkv', opaque: true, isCaption: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  assert.equal(segs[0].items.length, 1, 'items kept under opaque overlay so audio survives')
  assert.equal(segs[0].items[0].src, '/a.mp4')
  assert.equal(segs[0].opaqueVideo, true, 'segment flagged opaqueVideo')
  assert.equal(segs[0].overlays[0].opaque, true)
  // A segment with no opaque overlay must not be flagged.
  assert.equal(segs[1].opaqueVideo, false, 'uncovered segment is not opaqueVideo')
})

test('planSegments: multi-track items all included, sorted by trackIdx', () => {
  const items = [
    { id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 },
    { id: 'pip', type: 'video', start: 2, end: 8, src: '/pip.mp4', trackIdx: 1, inPoint: 0, outPoint: 6, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 0.9 },
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  // [0-2]: bg only, [2-8]: bg + pip, [8-10]: bg only
  assert.equal(segs.length, 3)
  assert.equal(segs[0].items.length, 1)
  assert.equal(segs[0].items[0].id, 'bg')
  assert.equal(segs[1].items.length, 2)
  assert.equal(segs[1].items[0].id, 'bg')   // trackIdx 0 first (background)
  assert.equal(segs[1].items[1].id, 'pip')   // trackIdx 1 on top
  assert.equal(segs[2].items.length, 1)
  assert.equal(segs[2].items[0].id, 'bg')
})

test('planSegments: sub-frame boundaries are quantized to the frame grid', () => {
  // Regression: project boundaries arrive as sub-frame floats (e.g. 1.875,
  // 4.7177, 5.4474 from the editor). Without quantization, segment
  // durations are not multiples of 1/fps — the encoder gets `-t 2.843`,
  // produces 85 frames @ 30fps (= 2.833s), but MP4 records 2.843s of track
  // duration. The trailing ~10ms hangs off the last frame, and stream-copy
  // concat preserves it. The visible effect is a sub-frame freeze-and-pop
  // at every overlay start/end and clip transition.
  const items = [
    { id: 'c1', type: 'video', start: 0,      end: 1.875,  src: '/a.mp4', inPoint: 0, outPoint: 1.875,   trackIdx: 0 },
    { id: 'c2', type: 'video', start: 1.875,  end: 4.7177, src: '/b.mp4', inPoint: 0, outPoint: 2.8427,  trackIdx: 0 },
    { id: 'c3', type: 'video', start: 4.7177, end: 8.0000, src: '/c.mp4', inPoint: 0, outPoint: 3.2823,  trackIdx: 0 },
  ]
  const fps = 30
  const segs = planSegments(items, [], 1920, 1080, fps)
  for (const seg of segs) {
    const startFrame = seg.start * fps
    const endFrame   = seg.end   * fps
    // Every boundary lands on an integer frame index (within float epsilon).
    assert.ok(Math.abs(startFrame - Math.round(startFrame)) < 1e-9,
      `seg.start ${seg.start} not on frame grid (${startFrame})`)
    assert.ok(Math.abs(endFrame - Math.round(endFrame)) < 1e-9,
      `seg.end ${seg.end} not on frame grid (${endFrame})`)
    // Duration is an exact integer multiple of 1/fps → encoder can produce
    // a clean integer frame count with no trailing remainder.
    const frames = (seg.end - seg.start) * fps
    assert.ok(Math.abs(frames - Math.round(frames)) < 1e-9,
      `seg duration ${seg.end - seg.start} is not a multiple of 1/fps (${frames} frames)`)
  }
})

test('planSegments: captions always sorted after overlays', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'cap', startSeconds: 0, endSeconds: 10, webmPath: '/cap.mkv', isCaption: true },
    { id: 'ov',  startSeconds: 0, endSeconds: 10, webmPath: '/ov.mkv',  isCaption: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  assert.equal(segs[0].overlays.length, 2)
  assert.equal(segs[0].overlays[0].id, 'ov')   // non-caption first
  assert.equal(segs[0].overlays[1].id, 'cap')   // caption last (on top)
})
