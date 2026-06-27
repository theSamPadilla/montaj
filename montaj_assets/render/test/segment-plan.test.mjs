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

test('planSegments: adjacent grid boundaries survive the proximity-snap pass', () => {
  // Regression: the proximity-snap pass that runs AFTER quantization used to
  // compare `boundary[i] - boundary[i-1]` against `1/fps` with float
  // subtraction. For two adjacent grid points like 143/30 and 144/30 the
  // mathematical gap is exactly 1/30, but IEEE 754 cancellation made the
  // subtraction return ~1e-16 below 1/30 — which the `gap < frameDur` test
  // misread as "duplicates, collapse them." The later boundary was silently
  // dropped, leaving a segment with empty items between two clips that the
  // editor renders continuously. Result: a black canvas frame at every clip
  // change whose quantized end happened to land exactly one frame after
  // another item's quantized boundary.
  //
  // This is the exact configuration from the original bug report
  // (project 2026-06-03-how-to-edit-videos-with-ai, ~4.8s):
  //   - clip-1 raw end / clip-2 raw start = 4.8061s → quantize → 4.8s (144/30)
  //   - ov-url raw end = 4.75s              → quantize → 4.7667s (143/30)
  //   - 4.8 - 4.7667 in IEEE 754 = 0.033333333333333215 ( < 1/30 by ~1e-16 )
  // Pre-fix, the segment [4.7667, 5.0] had neither clip and rendered black
  // for 7 frames.
  const items = [
    { id: 'c1', type: 'video', start: 0,       end: 4.8061, src: '/a.mp4', inPoint: 0, outPoint: 4.8061, trackIdx: 0 },
    { id: 'c2', type: 'video', start: 4.8061,  end: 8.0,    src: '/b.mp4', inPoint: 0, outPoint: 3.1939, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'ov-url',   startSeconds: 2.7, endSeconds: 4.75, webmPath: '/ov.mkv', isCaption: false, opaque: false },
    { id: 'ov-term1', startSeconds: 5.0, endSeconds: 7.0,  webmPath: '/ov.mkv', isCaption: false, opaque: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  // No segment in the rendered timeline may have empty items — both clips
  // span the entire [0, 8.0] window between them with no gap.
  for (const seg of segs) {
    assert.ok(seg.items.length > 0,
      `segment [${seg.start}, ${seg.end}] has empty items — proximity-snap dropped a clip boundary`)
  }
  // And specifically the segment that previously rendered black ([4.7667, 5.0])
  // must now exist as TWO segments split at 4.8 (the clip-1 → clip-2 boundary),
  // each with the correct clip active.
  const seg47 = segs.find(s => Math.abs(s.start - 143/30) < 1e-9)
  const seg48 = segs.find(s => Math.abs(s.start - 144/30) < 1e-9)
  assert.ok(seg47, 'segment starting at 143/30 (4.7667s) must exist')
  assert.ok(seg48, 'segment starting at 144/30 (4.8s) must exist')
  assert.equal(seg47.items[0].id, 'c1', 'segment at 4.7667s must contain clip-1')
  assert.equal(seg48.items[0].id, 'c2', 'segment at 4.8s must contain clip-2')
})

test('planSegments: negative item start is floored to 0 (no pre-zero black gap)', () => {
  // Regression (project 2026-06-26-cruces-objetivo-ultimo-dia): a full-source
  // background reel overlay was authored at start = -(firstClipInPoint) = -0.5,
  // while the video clip is correctly anchored at 0. Pre-fix, the earliest
  // boundary was -0.5, so the whole output shifted +0.5s and the video track
  // rendered BLACK for the first 0.5s (the overlay filled from frame 0). The
  // timeline origin must be floored at 0 so the video is active from frame 0
  // and there is no leading black segment.
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0.5, outPoint: 5.5, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'reel', startSeconds: -0.5, endSeconds: 5, webmPath: '/reel.mkv', isCaption: false, opaque: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  // No segment may begin before 0.
  for (const seg of segs) {
    assert.ok(seg.start >= 0, `segment start ${seg.start} precedes the timeline origin`)
  }
  // The first segment starts exactly at 0 and the video clip is active in it —
  // i.e. no black head gap.
  assert.equal(segs[0].start, 0)
  assert.equal(segs[0].items.length, 1, 'video clip active from frame 0 (no black gap)')
  assert.equal(segs[0].items[0].id, 'c1')
  // The negative-start overlay is also active in the first segment.
  assert.equal(segs[0].overlays.length, 1)
  assert.equal(segs[0].overlays[0].id, 'reel')
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
