// render/test/short-segments.test.mjs
//
// No segment shorter than MIN_SEGMENT_FRAMES reaches the video encoder.
//
// The shape is Sam's 2026-10-01 export (robotics-decomission), scaled down: an
// agent built a "zoom" as 12 CONSECUTIVE 2-frame b-roll clips with contiguous
// inPoints, over a talking-head clip that is cut in the middle of the run. The
// planner turned that into 2-frame and 1-frame segments, and libx265 reads an
// uninitialised value for its DTS on any encode of 2 frames or fewer
// (x265 encoder.cpp:1765, see MIN_SEGMENT_FRAMES). seg-0017 came out with no
// video stream and the export died.
//
// Pure planning, no ffmpeg. short-segments.integration.test.mjs encodes it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSegments, groupShortSegments, MIN_SEGMENT_FRAMES } from '../segment-plan.js'
import { samShape } from './fixtures/short-segment-run.mjs'

const FPS = 30
const frameOf = t => Math.round(t * FPS)
const framesIn = s => frameOf(s.end) - frameOf(s.start)

function assertGrouping(segments, groups, minFrames = MIN_SEGMENT_FRAMES) {
  // Every group is long enough (only a timeline shorter than that may not be).
  const total = frameOf(segments.at(-1).end) - frameOf(segments[0].start)
  for (const g of groups) {
    if (total >= minFrames) assert.ok(framesIn(g) >= minFrames, `group ${g.start}-${g.end} is ${framesIn(g)} frame(s)`)
  }
  // The groups tile the timeline exactly, with no gap and no overlap.
  assert.equal(groups[0].start, segments[0].start)
  assert.equal(groups.at(-1).end, segments.at(-1).end)
  for (let i = 1; i < groups.length; i++) assert.equal(groups[i].start, groups[i - 1].end)
  // So do the parts, and each part shows exactly what the planner said to show
  // over its frames: the same items, the same overlays, the same opaque flag.
  const parts = groups.flatMap(g => g.parts)
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end)
  for (const g of groups) {
    assert.equal(g.parts[0].start, g.start)
    assert.equal(g.parts.at(-1).end, g.end)
  }
  for (const p of parts) {
    assert.ok(framesIn(p) >= 1, 'no empty part')
    const owner = segments.find(s => frameOf(s.start) <= frameOf(p.start) && frameOf(p.end) <= frameOf(s.end))
    assert.ok(owner, `part ${p.start}-${p.end} lies inside one planned segment`)
    assert.equal(p.items, owner.items)
    assert.equal(p.overlays, owner.overlays)
    assert.equal(p.opaqueVideo, owner.opaqueVideo)
  }
}

test('MIN_SEGMENT_FRAMES is 3: x265 sets its DTS offset only once frame 3 arrives', () => {
  assert.equal(MIN_SEGMENT_FRAMES, 3)
})

test("Sam's shape plans 2-frame and 1-frame segments (the input this guards)", () => {
  const segs = planSegments(samShape(), [], 180, 320, FPS)
  const short = segs.filter(s => framesIn(s) < 3)
  assert.ok(short.length >= 12, `expected the zoom run to plan short segments, got ${short.length}`)
  assert.ok(segs.some(s => framesIn(s) === 1), 'the cut inside the run splits one zoom into 1-frame segments')
})

test("groupShortSegments: Sam's run of 12 two-frame clips, no group under 3 frames, every clip still shown", () => {
  const segs = planSegments(samShape(), [], 180, 320, FPS)
  const groups = groupShortSegments(segs, FPS)
  assertGrouping(segs, groups)
  const shown = new Set(groups.flatMap(g => g.parts.flatMap(p => p.items.map(i => i.id))))
  for (let k = 1; k <= 12; k++) assert.ok(shown.has(`broll-zoom-${String(k).padStart(2, '0')}`), `zoom ${k} is still in a part`)
  // The first segment needs no help, so it is handed over untouched.
  assert.equal(groups[0].parts.length, 1)
  assert.equal(groups[0].parts[0], segs[0])
  assert.ok(groups.length < segs.length, 'the short run was grouped')
})

test('groupShortSegments: segments already long enough pass through as one-part groups, by identity', () => {
  const items = [
    { id: 'a', type: 'video', trackIdx: 0, src: '/a.mp4', start: 0, end: 1, inPoint: 0 },
    { id: 'b', type: 'video', trackIdx: 0, src: '/b.mp4', start: 1, end: 2, inPoint: 0 },
  ]
  const segs = planSegments(items, [], 180, 320, FPS)
  const groups = groupShortSegments(segs, FPS)
  assert.equal(groups.length, segs.length)
  groups.forEach((g, i) => { assert.equal(g.parts.length, 1); assert.equal(g.parts[0], segs[i]) })
})

test('groupShortSegments: a lone 2-frame segment takes 1 frame from the next one, which stays long', () => {
  const seg = (a, b, id) => ({ start: a / FPS, end: b / FPS, items: [{ id }], overlays: [], opaqueVideo: false, vw: 180, vh: 320, fps: FPS })
  const segs = [seg(0, 30, 'x'), seg(30, 32, 'tiny'), seg(32, 62, 'y')]
  const groups = groupShortSegments(segs, FPS)
  assertGrouping(segs, groups)
  assert.equal(groups.length, 3)
  assert.equal(groups[0].parts[0], segs[0])
  assert.deepEqual(groups[1].parts.map(framesIn), [2, 1])
  assert.equal(framesIn(groups[2]), 29)
})

test('groupShortSegments: a next segment too short to split is taken whole', () => {
  const seg = (a, b, id) => ({ start: a / FPS, end: b / FPS, items: [{ id }], overlays: [], opaqueVideo: false, vw: 180, vh: 320, fps: FPS })
  const segs = [seg(0, 1, 'tiny'), seg(1, 4, 'three'), seg(4, 40, 'z')]
  const groups = groupShortSegments(segs, FPS)
  assertGrouping(segs, groups)
  assert.deepEqual(groups[0].parts.map(framesIn), [1, 3])
})

test('groupShortSegments: a short run at the very end borrows from the segment before it', () => {
  const seg = (a, b, id) => ({ start: a / FPS, end: b / FPS, items: [{ id }], overlays: [], opaqueVideo: false, vw: 180, vh: 320, fps: FPS })
  const segs = [seg(0, 30, 'x'), seg(30, 31, 'one'), seg(31, 32, 'two')]
  const groups = groupShortSegments(segs, FPS)
  assertGrouping(segs, groups)
  assert.equal(groups.length, 2)
  assert.equal(framesIn(groups[0]), 29)
  assert.deepEqual(groups[1].parts.map(framesIn), [1, 1, 1])
})

test('groupShortSegments: a short run after a group that was already merged joins that group', () => {
  const seg = (a, b, id) => ({ start: a / FPS, end: b / FPS, items: [{ id }], overlays: [], opaqueVideo: false, vw: 180, vh: 320, fps: FPS })
  const segs = [seg(0, 1, 'a'), seg(1, 4, 'b'), seg(4, 5, 'c')]
  const groups = groupShortSegments(segs, FPS)
  assertGrouping(segs, groups)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].parts.map(framesIn), [1, 3, 1])
})

test('groupShortSegments: a whole timeline under 3 frames is one group, as long as it can be', () => {
  const seg = (a, b, id) => ({ start: a / FPS, end: b / FPS, items: [{ id }], overlays: [], opaqueVideo: false, vw: 180, vh: 320, fps: FPS })
  const segs = [seg(0, 1, 'a'), seg(1, 2, 'b')]
  const groups = groupShortSegments(segs, FPS)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].parts.length, 2)
  assert.deepEqual(groupShortSegments([], FPS), [])
})
