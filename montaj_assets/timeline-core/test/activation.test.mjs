// montaj_assets/timeline-core/test/activation.test.mjs
//
// T3 suite for activation + boundaries. This is the fidelity contract for the
// port of three legacy implementations:
//
//   (1) render     — montaj_assets/render/segment-plan.js:29-133 (planSegments):
//                    the boundary pipeline (quantize → floor-at-0 → integer-frame
//                    dedupe) and the containment predicate. Its own suite is
//                    montaj_assets/render/test/segment-plan.test.mjs — ALL TEN of
//                    its scenarios are ported below with the SAME numbers.
//   (2) preview    — PreviewPlayer.tsx:117 and OverlayItemsLayer.tsx:412:
//                    the point-in-interval predicate `start <= t < end`.
//   (3) sample-frame — sample-frame.js:538, the same point predicate, with the
//                    "LATER clip wins" boundary tiebreak T9 depends on.
//
// Section 3 is the T3-scoped parity harness the plan asks for. It originally
// imported the real `planSegments` by relative path, which was safe only while
// `render/segment-plan.js` had zero imports. T7 made that file delegate to THIS
// package, so the import would now resolve `@bycrux/timeline-core` back through
// `render/node_modules` — a cycle, and a suite that silently depends on the
// render workspace being installed. Per the note this file used to carry at the
// bottom of section 3, the harness switched to an INLINED FROZEN REFERENCE
// implementation. This package's suite is hermetic: nothing under test/ reaches
// into render/, and the "hermetic" test at the end of section 3 enforces that.
//
// THE PARITY STORY NOW LIVES IN TWO PLACES, BY DESIGN:
//   • HERMETIC (here)      — resolver primitives vs. the frozen reference, with
//                            no cross-package dependency, so this package can be
//                            tested and published standalone.
//   • CROSS-ENGINE (there) — `render/test/resolver-parity.test.mjs` compares its
//                            OWN frozen copy of the same legacy algorithm against
//                            the SHIPPED `planSegments`, which is what keeps the
//                            real render code honest after the T7 swap.
// Neither subsumes the other: this one pins the primitives, that one pins the
// consumer. Both must stay green.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  frameGrid,
  boundariesFrom,
  coversSegment,
  containsTime,
  activeIn,
  captionsLast,
  byTrackIdx,
  planBoundaries,
  resolveSegment,
  resolveAt,
  sourceWindow,
  seekTime,
} from '../index.js'

const VARIANTS = ['preview', 'render']

/** Float compare — quantization is a divide, so 1e-9 is plenty. */
function closeTo(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}: expected a number, got ${typeof actual}`)
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ~${expected}, got ${actual}`)
}

/** `{start,end}` view of an item array, the shape `boundariesFrom` consumes. */
const asIntervals = (arr) => arr.map((i) => ({ start: i.start, end: i.end }))
/** `{start,end}` view of a Puppeteer overlay segment (startSeconds/endSeconds). */
const readPuppeteer = (s) => ({ start: s.startSeconds, end: s.endSeconds })
const puppeteerIntervals = (arr) => arr.map(readPuppeteer)

/** Recover the deduped boundary list from a legacy `planSegments` result. */
function boundariesOfLegacyPlan(segs) {
  if (segs.length === 0) return []
  return [...segs.map((s) => s.start), segs[segs.length - 1].end]
}

/** Build a project-shaped fixture from track arrays. */
function project(tracks, extra = {}) {
  return { tracks, ...extra }
}

// ---------------------------------------------------------------------------
// 1. frameGrid — the three verbatim primitives from segment-plan.js:44/60/85
// ---------------------------------------------------------------------------

describe('frameGrid', () => {
  test('quantize snaps a sub-frame time to the nearest frame boundary (segment-plan.js:44)', () => {
    const g = frameGrid(30)
    // 4.7177s = frame 141.531 → frame 142 → 142/30
    closeTo(g.quantize(4.7177), 142 / 30, 'quantize 4.7177')
    // 1.875s = frame 56.25 → frame 56 → 56/30
    closeTo(g.quantize(1.875), 56 / 30, 'quantize 1.875')
    // Already on the grid → unchanged, and idempotent.
    closeTo(g.quantize(5), 5, 'quantize 5')
    closeTo(g.quantize(g.quantize(4.7177)), 142 / 30, 'quantize is idempotent')
  })

  test('quantize is fps-relative', () => {
    closeTo(frameGrid(24).quantize(1 / 60), 0, '1/60s is under half a frame @24 → frame 0')
    closeTo(frameGrid(60).quantize(1 / 60), 1 / 60, 'the same time @60 is exactly frame 1')
  })

  test('boundary floors at 0 (segment-plan.js:60 — the "black top for the first ~0.3s" bug)', () => {
    const g = frameGrid(30)
    assert.equal(g.boundary(-0.5), 0)
    assert.equal(g.boundary(-0.0001), 0)
    assert.equal(g.boundary(-100), 0)
    assert.equal(g.boundary(0), 0)
    closeTo(g.boundary(4.7177), 142 / 30, 'positive times pass through quantized')
  })

  test('quantize accepts negatives (only `boundary` floors)', () => {
    const g = frameGrid(30)
    closeTo(g.quantize(-1.234), -37 / 30, 'quantize -1.234')
    assert.equal(g.frameOf(-1.234), -37)
    assert.equal(g.frameOf(-0.5), -15)
  })

  test('frameOf distinguishes adjacent grid points 143/30 and 144/30 where float subtraction does not', () => {
    const g = frameGrid(30)
    assert.equal(g.frameOf(143 / 30), 143)
    assert.equal(g.frameOf(144 / 30), 144)
    assert.notEqual(g.frameOf(143 / 30), g.frameOf(144 / 30))
    // Document the exact IEEE-754 trap the integer comparison exists to dodge:
    // the mathematical gap is exactly 1/30, but the float subtraction lands
    // ~1e-16 BELOW it, so a `gap < frameDur` test reads "duplicates, collapse".
    assert.ok(144 / 30 - 143 / 30 < 1 / 30, 'the float gap really is below 1/fps — this is the trap')
    assert.equal(g.frameOf(143 / 30) === g.frameOf(144 / 30), false, 'integer comparison is not fooled')
  })

  test('exposes fps and frameDur for callers that need the tolerance', () => {
    const g = frameGrid(30)
    assert.equal(g.fps, 30)
    closeTo(g.frameDur, 1 / 30, 'frameDur')
  })
})

// ---------------------------------------------------------------------------
// 2. The ten scenarios of render/test/segment-plan.test.mjs, ported with the
//    SAME numbers against planBoundaries / resolveSegment (and the flat
//    primitives where the scenario is item-array shaped).
// ---------------------------------------------------------------------------

describe('ported scenario 1: single clip fills timeline', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0, outPoint: 5, trackIdx: 0 },
  ]
  const p = project([items])

  test('boundaries are exactly [0, 5] → one segment', () => {
    assert.deepEqual(planBoundaries(p, 30), [0, 5])
    assert.deepEqual(boundariesFrom(asIntervals(items), 30), [0, 5])
  })

  test('the clip is the only item in [0, 5]', () => {
    const scene = resolveSegment(p, 0, 5, 30)
    assert.equal(scene.items.length, 1)
    assert.equal(scene.items[0].kind, 'video')
    assert.equal(scene.items[0].item.src, '/a.mp4')
    assert.equal(scene.items[0].trackIdx, 0)
    assert.equal(scene.t, 0, 'Scene.t for a segment is its start (the seek reference point)')
  })
})

describe('ported scenario 2: gap between clips produces an empty-items segment', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 3, src: '/a.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
    { id: 'c2', type: 'video', start: 5, end: 8, src: '/b.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
  ]
  const p = project([items])

  test('boundaries [0, 3, 5, 8] → three segments, the middle one empty', () => {
    assert.deepEqual(planBoundaries(p, 30), [0, 3, 5, 8])
    assert.equal(resolveSegment(p, 3, 5, 30).items.length, 0, 'black — no active items')
    assert.equal(resolveSegment(p, 0, 3, 30).items[0].item.id, 'c1')
    assert.equal(resolveSegment(p, 5, 8, 30).items[0].item.id, 'c2')
  })
})

describe('ported scenario 3: image item produces a looped-image segment', () => {
  // T3 owns activation + kind. The `-loop 1` ffmpeg input flag the original test
  // name alludes to is an ENCODER concern (encode-segment.js), not the resolver's:
  // all T3 promises is that the item is active and carries kind 'image'.
  const items = [{ id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', trackIdx: 0 }]
  const p = project([items])

  test('the image is active across [0, 10] with kind "image"', () => {
    assert.deepEqual(planBoundaries(p, 30), [0, 10])
    const scene = resolveSegment(p, 0, 10, 30)
    assert.equal(scene.items.length, 1)
    assert.equal(scene.items[0].kind, 'image')
    assert.equal(scene.items[0].item.src, '/bg.jpg')
  })
})

describe('ported scenario 4: overlays attached to overlapping segments', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'ov1', startSeconds: 2, endSeconds: 5, webmPath: '/ov.mkv', opaque: false, isCaption: false },
  ]
  // Project-shaped equivalent: the overlay lives on track 1.
  const p = project([
    [{ id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10 }],
    [{ id: 'ov1', type: 'overlay', start: 2, end: 5, src: '/ov.jsx' }],
  ])

  test('boundaries [0, 2, 5, 10] from both the flat and the project-shaped input', () => {
    assert.deepEqual(planBoundaries(p, 30), [0, 2, 5, 10])
    assert.deepEqual(
      boundariesFrom([...asIntervals(items), ...puppeteerIntervals(puppeteerSegs)], 30),
      [0, 2, 5, 10],
    )
  })

  test('the overlay is active only in [2, 5]', () => {
    assert.deepEqual(
      activeIn(puppeteerSegs, 2, 5, 30, readPuppeteer).map((s) => s.id),
      ['ov1'],
    )
    assert.deepEqual(activeIn(puppeteerSegs, 0, 2, 30, readPuppeteer), [])
    assert.deepEqual(activeIn(puppeteerSegs, 5, 10, 30, readPuppeteer), [])

    const scene = resolveSegment(p, 2, 5, 30)
    assert.deepEqual(
      scene.items.map((r) => [r.item.id, r.kind, r.trackIdx]),
      [
        ['c1', 'video', 0],
        ['ov1', 'overlay', 1],
      ],
    )
    assert.deepEqual(
      resolveSegment(p, 0, 2, 30).items.map((r) => r.item.id),
      ['c1'],
    )
  })
})

describe('ported scenario 5: opaque overlay keeps items (for audio) and flags opaqueVideo', () => {
  // Regression: opaque overlays must NOT drop the underlying footage's audio.
  // T3 owns the "items are kept" half and carries `opaque` through on the
  // resolved item; the `opaqueVideo` boolean is the CONSUMER's one-liner over
  // the Scene (derived below exactly as segment-plan.js:122 derives it).
  const p = project([
    [{ id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10 }],
    [{ id: 'ov1', type: 'overlay', start: 0, end: 3, src: '/ov.jsx', opaque: true }],
  ])
  const opaqueVideo = (scene) => scene.items.some((r) => r.kind === 'overlay' && r.item.opaque)

  test('the footage item survives under an opaque overlay so its audio survives', () => {
    const covered = resolveSegment(p, 0, 3, 30)
    const video = covered.items.filter((r) => r.kind === 'video')
    assert.equal(video.length, 1, 'items kept under opaque overlay so audio survives')
    assert.equal(video[0].item.src, '/a.mp4')
    assert.equal(opaqueVideo(covered), true, 'segment derives opaqueVideo = true')
  })

  test('a segment with no opaque overlay is not flagged', () => {
    const uncovered = resolveSegment(p, 3, 10, 30)
    assert.equal(uncovered.items.length, 1)
    assert.equal(opaqueVideo(uncovered), false, 'uncovered segment is not opaqueVideo')
  })
})

describe('ported scenario 6: multi-track items all included, sorted by trackIdx', () => {
  const p = project([
    [{ id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }],
    [{ id: 'pip', type: 'video', start: 2, end: 8, src: '/pip.mp4', inPoint: 0, outPoint: 6, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 0.9 }],
  ])

  test('[0-2] bg only, [2-8] bg + pip (trackIdx order), [8-10] bg only', () => {
    assert.deepEqual(planBoundaries(p, 30), [0, 2, 8, 10])
    assert.deepEqual(
      resolveSegment(p, 0, 2, 30).items.map((r) => r.item.id),
      ['bg'],
    )
    const middle = resolveSegment(p, 2, 8, 30)
    assert.deepEqual(
      middle.items.map((r) => r.item.id),
      ['bg', 'pip'],
      'trackIdx 0 first (background), trackIdx 1 on top',
    )
    assert.deepEqual(
      middle.items.map((r) => r.trackIdx),
      [0, 1],
    )
    assert.deepEqual(
      resolveSegment(p, 8, 10, 30).items.map((r) => r.item.id),
      ['bg'],
    )
  })

  test('byTrackIdx is a stable comparator — ties keep document order', () => {
    const rows = [
      { id: 'a', trackIdx: 1 },
      { id: 'b', trackIdx: 0 },
      { id: 'c', trackIdx: 1 },
      { id: 'd', trackIdx: 0 },
    ]
    assert.deepEqual(
      [...rows].sort(byTrackIdx).map((r) => r.id),
      ['b', 'd', 'a', 'c'],
    )
  })
})

describe('ported scenario 7: sub-frame boundaries are quantized to the frame grid', () => {
  // Regression: project boundaries arrive as sub-frame floats (1.875, 4.7177,
  // 5.4474 from the editor). Without quantization, segment durations are not
  // multiples of 1/fps — the encoder gets `-t 2.843`, produces 85 frames @30fps
  // (= 2.833s), but MP4 records 2.843s of track duration. The trailing ~10ms
  // hangs off the last frame and stream-copy concat preserves it: a sub-frame
  // freeze-and-pop at every transition, ~0.34s accumulated drift over 62s.
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 1.875, src: '/a.mp4', inPoint: 0, outPoint: 1.875, trackIdx: 0 },
    { id: 'c2', type: 'video', start: 1.875, end: 4.7177, src: '/b.mp4', inPoint: 0, outPoint: 2.8427, trackIdx: 0 },
    { id: 'c3', type: 'video', start: 4.7177, end: 8.0, src: '/c.mp4', inPoint: 0, outPoint: 3.2823, trackIdx: 0 },
  ]
  const fps = 30
  const p = project([items])

  test('every boundary lands on an integer frame index and every gap is a whole number of frames', () => {
    const bounds = planBoundaries(p, fps)
    assert.ok(bounds.length >= 2)
    for (const b of bounds) {
      const frame = b * fps
      assert.ok(Math.abs(frame - Math.round(frame)) < 1e-9, `boundary ${b} not on frame grid (${frame})`)
    }
    for (let i = 1; i < bounds.length; i++) {
      const frames = (bounds[i] - bounds[i - 1]) * fps
      assert.ok(
        Math.abs(frames - Math.round(frames)) < 1e-9,
        `segment duration ${bounds[i] - bounds[i - 1]} is not a multiple of 1/fps (${frames} frames)`,
      )
    }
  })

  test('the raw sub-frame values do NOT survive — 4.7177 becomes 142/30', () => {
    const bounds = planBoundaries(p, fps)
    assert.equal(bounds.includes(4.7177), false)
    assert.ok(bounds.some((b) => Math.abs(b - 142 / 30) < 1e-12), 'quantized 4.7177 → 142/30 is present')
    assert.ok(bounds.some((b) => Math.abs(b - 56 / 30) < 1e-12), 'quantized 1.875 → 56/30 is present')
  })
})

describe('ported scenario 8: adjacent grid boundaries survive the proximity-snap pass', () => {
  // The exact configuration from the original bug report
  // (project 2026-06-03-how-to-edit-videos-with-ai, ~4.8s):
  //   clip-1 raw end / clip-2 raw start = 4.8061 → quantize → 4.8      (144/30)
  //   ov-url raw end                    = 4.75   → quantize → 4.766…   (143/30)
  //   4.8 - 4.7667 in IEEE 754 = 0.033333333333333215 ( < 1/30 by ~1e-16 )
  // Pre-fix, the segment [4.7667, 5.0] had neither clip and rendered black.
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 4.8061, src: '/a.mp4', inPoint: 0, outPoint: 4.8061, trackIdx: 0 },
    { id: 'c2', type: 'video', start: 4.8061, end: 8.0, src: '/b.mp4', inPoint: 0, outPoint: 3.1939, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'ov-url', startSeconds: 2.7, endSeconds: 4.75, webmPath: '/ov.mkv', isCaption: false, opaque: false },
    { id: 'ov-term1', startSeconds: 5.0, endSeconds: 7.0, webmPath: '/ov.mkv', isCaption: false, opaque: false },
  ]
  const p = project([
    [
      { id: 'c1', type: 'video', start: 0, end: 4.8061, src: '/a.mp4', inPoint: 0, outPoint: 4.8061 },
      { id: 'c2', type: 'video', start: 4.8061, end: 8.0, src: '/b.mp4', inPoint: 0, outPoint: 3.1939 },
    ],
    [
      { id: 'ov-url', type: 'overlay', start: 2.7, end: 4.75, src: '/ov.jsx' },
      { id: 'ov-term1', type: 'overlay', start: 5.0, end: 7.0, src: '/ov.jsx' },
    ],
  ])

  test('both 143/30 and 144/30 survive the dedupe pass', () => {
    for (const bounds of [
      planBoundaries(p, 30),
      boundariesFrom([...asIntervals(items), ...puppeteerIntervals(puppeteerSegs)], 30),
    ]) {
      assert.ok(bounds.some((b) => Math.abs(b - 143 / 30) < 1e-9), 'boundary at 143/30 (4.7667s) must exist')
      assert.ok(bounds.some((b) => Math.abs(b - 144 / 30) < 1e-9), 'boundary at 144/30 (4.8s) must exist')
    }
  })

  test('no segment in the rendered timeline has empty items', () => {
    const bounds = planBoundaries(p, 30)
    for (let i = 0; i < bounds.length - 1; i++) {
      const scene = resolveSegment(p, bounds[i], bounds[i + 1], 30)
      const visual = scene.items.filter((r) => r.kind === 'video' || r.kind === 'image')
      assert.ok(
        visual.length > 0,
        `segment [${bounds[i]}, ${bounds[i + 1]}] has empty items — the dedupe pass dropped a clip boundary`,
      )
    }
  })

  test('the segment at 4.7667 holds clip-1 and the segment at 4.8 holds clip-2', () => {
    const bounds = planBoundaries(p, 30)
    const at = (t) => {
      const i = bounds.findIndex((b) => Math.abs(b - t) < 1e-9)
      assert.notEqual(i, -1, `no boundary at ${t}`)
      return resolveSegment(p, bounds[i], bounds[i + 1], 30)
    }
    const seg47 = at(143 / 30)
    const seg48 = at(144 / 30)
    assert.equal(seg47.items.filter((r) => r.kind === 'video')[0].item.id, 'c1')
    assert.equal(seg48.items.filter((r) => r.kind === 'video')[0].item.id, 'c2')
  })

  test('an epsilon-gap dedupe would have collapsed them (why the rule is integer-frame)', () => {
    // Not a test of the resolver — a guard on the reasoning. If this ever stops
    // being true the comment in activation.js needs revisiting, not the code.
    assert.ok(144 / 30 - 143 / 30 < 1 / 30)
  })
})

describe('ported scenario 9: negative item start is floored to 0 (no pre-zero black gap)', () => {
  // Regression (project 2026-06-26-cruces-objetivo-ultimo-dia): a full-source
  // background reel overlay authored at start = -(firstClipInPoint) = -0.5 while
  // the video clip is anchored at 0. Pre-fix the earliest boundary was -0.5, so
  // the whole output shifted +0.5s and the video track rendered BLACK for the
  // first 0.5s.
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0.5, outPoint: 5.5, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'reel', startSeconds: -0.5, endSeconds: 5, webmPath: '/reel.mkv', isCaption: false, opaque: false },
  ]
  const p = project([
    [{ id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0.5, outPoint: 5.5 }],
    [{ id: 'reel', type: 'overlay', start: -0.5, end: 5, src: '/reel.jsx' }],
  ])

  test('no boundary precedes the timeline origin, and the pre-0 boundary collapses onto 0', () => {
    assert.deepEqual(planBoundaries(p, 30), [0, 5])
    assert.deepEqual(boundariesFrom([...asIntervals(items), ...puppeteerIntervals(puppeteerSegs)], 30), [0, 5])
    for (const b of planBoundaries(p, 30)) {
      assert.ok(b >= 0, `boundary ${b} precedes the timeline origin`)
    }
  })

  test('the video clip is active from frame 0 (no black head gap), and so is the negative-start overlay', () => {
    const first = resolveSegment(p, 0, 5, 30)
    assert.deepEqual(
      first.items.map((r) => r.item.id),
      ['c1', 'reel'],
    )
    assert.equal(first.items[0].kind, 'video')
    assert.equal(first.items[1].kind, 'overlay')
  })

  test('a negative-start item seeks into its pre-0 portion, matching the preview convention', () => {
    // encode-segment.js's `max(0, segStart - item.start)` is exactly seekTime's
    // clamp; at segStart 0 the reel is already 0.5s into itself.
    const reel = resolveSegment(p, 0, 5, 30).items[1]
    closeTo(reel.seek, 0.5, 'reel seek at t=0')
  })
})

describe('ported scenario 10: captions always sorted after overlays', () => {
  const puppeteerSegs = [
    { id: 'cap', startSeconds: 0, endSeconds: 10, webmPath: '/cap.mkv', isCaption: true },
    { id: 'ov', startSeconds: 0, endSeconds: 10, webmPath: '/ov.mkv', isCaption: false },
  ]

  test('captionsLast puts non-captions first and captions last (topmost z-layer)', () => {
    const active = activeIn(puppeteerSegs, 0, 10, 30, readPuppeteer)
    assert.deepEqual(
      captionsLast(active).map((o) => o.id),
      ['ov', 'cap'],
    )
  })

  test('captionsLast preserves relative order inside each group', () => {
    const rows = [
      { id: 'cap1', isCaption: true },
      { id: 'ov1' },
      { id: 'cap2', isCaption: true },
      { id: 'ov2', isCaption: false },
    ]
    assert.deepEqual(
      captionsLast(rows).map((o) => o.id),
      ['ov1', 'ov2', 'cap1', 'cap2'],
    )
  })

  test('a project-level caption track contributes the [0, visualDuration] boundary pair', () => {
    // collectPuppeteerSegments (render.js:534-568) emits ONE caption segment
    // spanning [0, quantize(getTotalDurationSeconds(project))].
    const p = project([[{ id: 'c1', type: 'video', start: 0, end: 4.7177, src: '/a.mp4' }]], {
      captions: { style: 'clean', segments: [{ text: 'hi', start: 0, end: 1 }] },
    })
    const bounds = planBoundaries(p, 30)
    assert.equal(bounds[0], 0, 'the caption segment starts at 0')
    closeTo(bounds[bounds.length - 1], 142 / 30, 'and ends at the quantized project duration')
  })

  test('a project with no captions contributes no caption boundary', () => {
    const p = project([[{ id: 'c1', type: 'video', start: 2, end: 5, src: '/a.mp4' }]])
    assert.deepEqual(planBoundaries(p, 30), [2, 5], 'no synthetic 0 boundary without captions')
  })
})

// ---------------------------------------------------------------------------
// 3. Parity harness — legacy planSegments vs the resolver's flat primitives.
//    The T3-scoped precursor to T7's full plan-level harness.
// ---------------------------------------------------------------------------

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LEGACY REFERENCE, FROZEN AT SP2 PRE-T7 — DO NOT "FIX" THIS FUNCTION.      │
 * │                                                                           │
 * │ A verbatim copy of `montaj_assets/render/segment-plan.js`'s algorithm as  │
 * │ it stood BEFORE T7 made that file delegate to this package. It is inlined │
 * │ rather than imported so this package's suite stays hermetic — importing   │
 * │ the post-T7 file would resolve `@bycrux/timeline-core` back through       │
 * │ `render/node_modules` and compare the resolver to itself.                 │
 * │                                                                           │
 * │ If a change to the resolver makes this disagree, fix the RESOLVER or      │
 * │ consciously record a new divergence in KNOWN-DIVERGENCES.md — never edit  │
 * │ this copy into agreement. Editing it deletes the contract.                │
 * │                                                                           │
 * │ The cross-engine gate that keeps the SHIPPED render code honest is        │
 * │ `montaj_assets/render/test/resolver-parity.test.mjs`, which holds its own │
 * │ independent frozen copy of this same algorithm. Both must stay green.     │
 * │                                                                           │
 * │ The three behaviors pinned here, each recording a real production bug     │
 * │ (full reasoning in src/activation.js's `frameGrid` / `boundariesFrom`):   │
 * │   • quantize to the frame grid  — the freeze-and-pop / drift bug          │
 * │   • floor every boundary at 0   — the "black top for the first ~0.3s" bug │
 * │   • dedupe by INTEGER FRAME     — the IEEE-754 cancellation bug (never an │
 * │                                   epsilon/gap test)                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function legacyPlanSegments(allItems, puppeteerSegs, vw, vh, fps) {
  const frameDur = 1 / fps
  const quantize = (t) => Math.round(t * fps) / fps
  const boundary = (t) => Math.max(0, quantize(t))

  const boundaries = new Set()
  for (const item of allItems) {
    boundaries.add(boundary(item.start))
    boundaries.add(boundary(item.end))
  }
  for (const seg of puppeteerSegs) {
    boundaries.add(boundary(seg.startSeconds))
    boundaries.add(boundary(seg.endSeconds))
  }

  if (boundaries.size === 0) return []

  const frameOf = (t) => Math.round(t * fps)
  const sorted = [...boundaries].sort((a, b) => a - b)
  const snapped = [sorted[0]]
  let lastFrame = frameOf(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const f = frameOf(sorted[i])
    if (f === lastFrame) continue
    snapped.push(sorted[i])
    lastFrame = f
  }

  const segments = []

  for (let i = 0; i < snapped.length - 1; i++) {
    const start = snapped[i]
    const end = snapped[i + 1]

    const items = allItems
      .filter((v) => v.start <= start + frameDur && v.end >= end - frameDur)
      .sort((a, b) => a.trackIdx - b.trackIdx)

    const activeOverlays = puppeteerSegs.filter(
      (s) => s.startSeconds <= start + frameDur && s.endSeconds >= end - frameDur,
    )
    const overlays = [
      ...activeOverlays.filter((o) => !o.isCaption),
      ...activeOverlays.filter((o) => o.isCaption),
    ]

    const hasOpaque = overlays.some((o) => o.opaque)

    segments.push({ start, end, items, opaqueVideo: hasOpaque, overlays, vw, vh, fps })
  }

  return segments
}

/** Every scenario above, in the flat (items, puppeteerSegs) shape planSegments takes. */
const PARITY_CORPUS = [
  {
    name: 'single clip fills timeline',
    items: [{ id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0, outPoint: 5, trackIdx: 0 }],
    puppeteerSegs: [],
  },
  {
    name: 'gap between clips',
    items: [
      { id: 'c1', type: 'video', start: 0, end: 3, src: '/a.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
      { id: 'c2', type: 'video', start: 5, end: 8, src: '/b.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
    ],
    puppeteerSegs: [],
  },
  {
    name: 'image item',
    items: [{ id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', trackIdx: 0 }],
    puppeteerSegs: [],
  },
  {
    name: 'overlays attached to overlapping segments',
    items: [{ id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 }],
    puppeteerSegs: [
      { id: 'ov1', startSeconds: 2, endSeconds: 5, webmPath: '/ov.mkv', opaque: false, isCaption: false },
    ],
  },
  {
    name: 'opaque overlay',
    items: [{ id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 }],
    puppeteerSegs: [
      { id: 'ov1', startSeconds: 0, endSeconds: 3, webmPath: '/ov.mkv', opaque: true, isCaption: false },
    ],
  },
  {
    name: 'multi-track items sorted by trackIdx',
    items: [
      { id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', trackIdx: 0 },
      { id: 'pip', type: 'video', start: 2, end: 8, src: '/pip.mp4', trackIdx: 1, inPoint: 0, outPoint: 6 },
    ],
    puppeteerSegs: [],
  },
  {
    name: 'sub-frame boundaries',
    items: [
      { id: 'c1', type: 'video', start: 0, end: 1.875, src: '/a.mp4', inPoint: 0, outPoint: 1.875, trackIdx: 0 },
      { id: 'c2', type: 'video', start: 1.875, end: 4.7177, src: '/b.mp4', inPoint: 0, outPoint: 2.8427, trackIdx: 0 },
      { id: 'c3', type: 'video', start: 4.7177, end: 8.0, src: '/c.mp4', inPoint: 0, outPoint: 3.2823, trackIdx: 0 },
    ],
    puppeteerSegs: [],
  },
  {
    name: 'adjacent grid boundaries',
    items: [
      { id: 'c1', type: 'video', start: 0, end: 4.8061, src: '/a.mp4', inPoint: 0, outPoint: 4.8061, trackIdx: 0 },
      { id: 'c2', type: 'video', start: 4.8061, end: 8.0, src: '/b.mp4', inPoint: 0, outPoint: 3.1939, trackIdx: 0 },
    ],
    puppeteerSegs: [
      { id: 'ov-url', startSeconds: 2.7, endSeconds: 4.75, webmPath: '/ov.mkv', isCaption: false, opaque: false },
      { id: 'ov-term1', startSeconds: 5.0, endSeconds: 7.0, webmPath: '/ov.mkv', isCaption: false, opaque: false },
    ],
  },
  {
    name: 'negative item start',
    items: [{ id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0.5, outPoint: 5.5, trackIdx: 0 }],
    puppeteerSegs: [
      { id: 'reel', startSeconds: -0.5, endSeconds: 5, webmPath: '/reel.mkv', isCaption: false, opaque: false },
    ],
  },
  {
    name: 'captions after overlays',
    items: [{ id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 }],
    puppeteerSegs: [
      { id: 'cap', startSeconds: 0, endSeconds: 10, webmPath: '/cap.mkv', isCaption: true },
      { id: 'ov', startSeconds: 0, endSeconds: 10, webmPath: '/ov.mkv', isCaption: false },
    ],
  },
  // Degenerate shapes the ten scenarios do not cover.
  { name: 'no items at all', items: [], puppeteerSegs: [] },
  {
    name: 'single zero-length item (one boundary, zero segments)',
    items: [{ id: 'z', type: 'video', start: 2, end: 2, src: '/z.mp4', trackIdx: 0 }],
    puppeteerSegs: [],
  },
  {
    name: 'everything before zero collapses onto a single 0 boundary',
    items: [{ id: 'past', type: 'video', start: -3, end: -1, src: '/p.mp4', trackIdx: 0 }],
    puppeteerSegs: [],
  },
  {
    name: 'three tracks, staggered, with a caption spanning everything',
    items: [
      { id: 'a', type: 'video', start: 0, end: 6.5, src: '/a.mp4', trackIdx: 0 },
      { id: 'b', type: 'image', start: 1.3333, end: 9.9, src: '/b.jpg', trackIdx: 1 },
      { id: 'c', type: 'video', start: 6.5, end: 12.25, src: '/c.mp4', trackIdx: 2 },
    ],
    puppeteerSegs: [
      { id: 'ov', startSeconds: 3.01, endSeconds: 7.99, webmPath: '/ov.mkv', isCaption: false, opaque: false },
      { id: 'cap', startSeconds: 0, endSeconds: 12.25, webmPath: '/cap.mkv', isCaption: true },
    ],
  },
]

describe('parity harness: legacy planSegments vs the resolver primitives', () => {
  for (const fps of [24, 30, 60]) {
    for (const { name, items, puppeteerSegs } of PARITY_CORPUS) {
      test(`fps ${fps} | ${name}: boundaries are byte-equal`, () => {
        const legacy = legacyPlanSegments(items, puppeteerSegs, 1920, 1080, fps)
        const mine = boundariesFrom(
          [...asIntervals(items), ...puppeteerIntervals(puppeteerSegs)],
          fps,
        )
        if (mine.length <= 1) {
          // A single boundary yields no segments, so the legacy plan carries no
          // recoverable boundary list — assert the segment count instead.
          assert.equal(legacy.length, 0, 'a single boundary must produce zero segments')
        } else {
          assert.deepEqual(boundariesOfLegacyPlan(legacy), mine)
        }
        assert.equal(legacy.length, Math.max(0, mine.length - 1), 'segment count = boundaries - 1')
      })

      test(`fps ${fps} | ${name}: per-segment item + overlay lists are byte-equal`, () => {
        const legacy = legacyPlanSegments(items, puppeteerSegs, 1920, 1080, fps)
        for (const seg of legacy) {
          assert.deepEqual(
            activeIn(items, seg.start, seg.end, fps).sort(byTrackIdx),
            seg.items,
            `${name} @${fps}: items differ in [${seg.start}, ${seg.end}]`,
          )
          assert.deepEqual(
            captionsLast(activeIn(puppeteerSegs, seg.start, seg.end, fps, readPuppeteer)),
            seg.overlays,
            `${name} @${fps}: overlays differ in [${seg.start}, ${seg.end}]`,
          )
        }
      })
    }
  }

  test('no test file reaches across the package boundary, TRANSITIVELY', async () => {
    // Replaces the old "the legacy module is dependency-free" guard, which
    // protected hermeticity indirectly by policing render/segment-plan.js's
    // import list. T7 made that file import THIS package, so the proxy became
    // both false and meaningless. This checks the invariant it actually stood
    // for: nothing a test pulls in may live outside the package.
    //
    // T7 could only assert the DIRECT form, because there was a known
    // transitive hole it was not in scope to close:
    //
    //     test/corpus.test.mjs
    //       -> ../scripts/regen-goldens.mjs
    //         -> ../../render/render.js, segment-plan.js, encode-segment.js
    //
    // so `npm test` pulled in the render toolchain (puppeteer, esbuild) and,
    // since T7, resolved @bycrux/timeline-core back through
    // render/node_modules via segment-plan.js — a genuine cycle.
    //
    // T8 (part 4A) closed it: the encode-args comparison moved to
    // render/test/encode-args-golden.test.mjs, where it belongs, and
    // scripts/regen-goldens.mjs is now pure resolver-only. So this test is now
    // the STRONGER, transitive assertion — it walks the whole static import
    // graph reachable from test/*.mjs and requires every node to resolve inside
    // the package root. Reintroducing the render import anywhere in that graph,
    // at any depth, fails here.
    //
    // Bare specifiers are offenders too, `node:` builtins excepted: this
    // package's contract is ZERO runtime dependencies, so a test that reaches
    // for one has broken the same promise by a different route.
    //
    // Dynamic `await import()` is out of scope — this is a static-graph check,
    // and a deliberate lazy import is exactly how a script legitimately talks to
    // render without infecting the suite. The isolated-copy run (see T8's
    // report) is the empirical backstop for the whole claim.
    const { readdirSync, readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve, relative, isAbsolute } = await import('node:path')

    const testDir = fileURLToPath(new URL('.', import.meta.url))
    const packageRoot = resolve(testDir, '..')

    const escapes = (absPath) => {
      const rel = relative(packageRoot, absPath)
      return rel.startsWith('..') || isAbsolute(rel)
    }

    const offenders = []
    const seen = new Set()
    const queue = readdirSync(testDir)
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => resolve(testDir, f))

    while (queue.length) {
      const file = queue.shift()
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      const from = relative(packageRoot, file)
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
        const spec = m[1]
        if (spec.startsWith('node:')) continue
        if (!spec.startsWith('.')) {
          offenders.push(`${from}: ${spec} (bare specifier — this package has zero runtime deps)`)
          continue
        }
        const target = resolve(dirname(file), spec)
        if (escapes(target)) {
          offenders.push(`${from}: ${spec} -> ${relative(packageRoot, target)}`)
          continue
        }
        queue.push(target)
      }
    }

    assert.deepEqual(offenders, [],
      'a test reached outside the package (directly or transitively) — inline a frozen reference instead')
    // Guard the walker itself: if the crawl silently stopped at the entry
    // files, the assertion above would pass vacuously. scripts/regen-goldens.mjs
    // is reached only via corpus.test.mjs, so seeing it proves depth > 1.
    assert.ok(
      [...seen].some((f) => relative(packageRoot, f) === 'scripts/regen-goldens.mjs'),
      'the import walk never left test/ — the crawler is broken, not the package',
    )
  })
})

// ---------------------------------------------------------------------------
// 4. resolveAt — the preview / sample-frame point-in-interval predicate
// ---------------------------------------------------------------------------

describe('resolveAt: point-in-interval activation (start <= t < end)', () => {
  const p = project([
    [
      { id: 'c1', type: 'video', start: 0, end: 3, src: '/a.mp4', inPoint: 0, outPoint: 3 },
      { id: 'c2', type: 'video', start: 5, end: 8, src: '/b.mp4', inPoint: 0, outPoint: 3 },
    ],
  ])

  for (const variant of VARIANTS) {
    test(`${variant}: a t inside a clip resolves that clip`, () => {
      const scene = resolveAt(p, 1.5, { variant })
      assert.equal(scene.t, 1.5)
      assert.deepEqual(
        scene.items.map((r) => r.item.id),
        ['c1'],
      )
    })

    test(`${variant}: a t inside a GAP resolves no video item — and specifically NOT the last clip`, () => {
      const scene = resolveAt(p, 4, { variant })
      assert.deepEqual(scene.items, [], 'a gap is empty; the resolver has no last-clip fallback')
      assert.equal(
        scene.items.some((r) => r.item.id === 'c2'),
        false,
        "PreviewPlayer.tsx:117's `?? clips[clips.length-1]` is editor-side PRESENTATION and stays there",
      )
    })

    test(`${variant}: t past the end of every clip resolves nothing`, () => {
      assert.deepEqual(resolveAt(p, 99, { variant }).items, [])
    })

    test(`${variant}: t before the first clip resolves nothing`, () => {
      assert.deepEqual(resolveAt(p, -1, { variant }).items, [])
    })
  }
})

describe('resolveAt: clip-boundary tiebreak — the LATER clip wins (sample-frame.js:530)', () => {
  const p = project([
    [
      { id: 'A', type: 'video', start: 0, end: 3, src: '/a.mp4', inPoint: 0, outPoint: 3 },
      { id: 'B', type: 'video', start: 3, end: 6, src: '/b.mp4', inPoint: 0, outPoint: 3 },
    ],
  ])

  for (const variant of VARIANTS) {
    test(`${variant}: at t = A.end = B.start exactly, B is active and A is not`, () => {
      const scene = resolveAt(p, 3, { variant })
      assert.deepEqual(
        scene.items.map((r) => r.item.id),
        ['B'],
        'T9 depends on this tiebreak',
      )
    })

    test(`${variant}: one frame before the boundary, A is still the active clip`, () => {
      assert.deepEqual(
        resolveAt(p, 3 - 1 / 30, { variant }).items.map((r) => r.item.id),
        ['A'],
      )
    })
  }

  test('the scalar predicate says the same thing', () => {
    assert.equal(containsTime(0, 3, 3), false, 'end is exclusive')
    assert.equal(containsTime(3, 6, 3), true, 'start is inclusive')
    assert.equal(containsTime(3, 6, 5.999999), true)
    assert.equal(containsTime(3, 6, 6), false)
    // A zero-length item is never active — `start <= t < start` is empty.
    assert.equal(containsTime(2, 2, 2), false)
  })
})

describe('resolveAt: window and seek', () => {
  const VIDEO = {
    id: 'v',
    type: 'video',
    src: '/orig.mov',
    normalizedSrc: '/cache/win.mp4',
    normalizedInPoint: 5,
    inPoint: 6,
    outPoint: 20,
    start: 10,
    end: 24,
  }
  const IMAGE = { id: 'i', type: 'image', src: '/bg.jpg', start: 0, end: 30 }
  const OVERLAY = { id: 'o', type: 'overlay', src: '/ov.jsx', start: 2, end: 30, props: { a: 1 } }
  const p = project([[IMAGE], [VIDEO], [OVERLAY]])

  for (const variant of VARIANTS) {
    test(`${variant}: a VIDEO item carries the full source window and a seek in that source's coordinates`, () => {
      const v = resolveAt(p, 12, { variant }).items.find((r) => r.kind === 'video')
      assert.deepEqual(v.window, sourceWindow(VIDEO, variant))
      assert.equal(v.window.src, '/cache/win.mp4')
      closeTo(v.window.inPoint, 1, 'rebased inPoint')
      closeTo(v.seek, seekTime(VIDEO, 12, variant), 'seek agrees with T2')
      closeTo(v.seek, 3, 'rebased inPoint 1 + elapsed 2')
    })

    test(`${variant}: an IMAGE item has NO source window (window === null) and seek is dwell time`, () => {
      const i = resolveAt(p, 12, { variant }).items.find((r) => r.kind === 'image')
      assert.equal(i.window, null, 'a still has no source timeline to seek in')
      closeTo(i.seek, 12, 'elapsed since the item started')
    })

    test(`${variant}: an OVERLAY item has NO source window and seek is elapsed time into its own timeline`, () => {
      const o = resolveAt(p, 12, { variant }).items.find((r) => r.kind === 'overlay')
      assert.equal(o.window, null, 'a JSX component is not a media file with in/out points')
      closeTo(o.seek, 10, 'overlay frame 0 is its own start (sample-frame.js:556)')
    })

    test(`${variant}: seek is clamped at 0 for a negative-start item`, () => {
      const neg = project([[{ id: 'n', type: 'overlay', src: '/n.jsx', start: -0.5, end: 5 }]])
      closeTo(resolveAt(neg, 0, { variant }).items[0].seek, 0.5, 'already 0.5s into itself at t=0')
      closeTo(resolveAt(neg, -0.4, { variant }).items[0].seek, 0.1, 'negative t still measures forward')
    })
  }

  test('the nobg headline divergence propagates into the Scene (registry: KNOWN-DIVERGENCES.md, "nobg precedence")', () => {
    const item = {
      id: 'v',
      type: 'video',
      src: '/orig.mov',
      normalizedSrc: '/cache/win.mp4',
      normalizedInPoint: 5,
      nobg_src: '/orig_nobg.mov',
      remove_bg: true,
      inPoint: 6,
      outPoint: 20,
      start: 0,
      end: 14,
    }
    const q = project([[item]])
    const preview = resolveAt(q, 2, { variant: 'preview' }).items[0]
    const render = resolveAt(q, 2, { variant: 'render' }).items[0]
    assert.equal(preview.window.src, '/cache/win.mp4')
    assert.equal(render.window.src, '/orig_nobg.mov')
    closeTo(preview.seek, 3, 'preview seek (rebased 1 + 2)')
    closeTo(render.seek, 8, 'render seek (raw 6 + 2)')
  })

  test('resolveSegment is render-only and uses the render source precedence', () => {
    const item = {
      id: 'v',
      type: 'video',
      src: '/orig.mov',
      normalizedSrc: '/cache/win.mp4',
      normalizedInPoint: 5,
      nobg_src: '/orig_nobg.mov',
      remove_bg: true,
      inPoint: 6,
      outPoint: 20,
      start: 0,
      end: 14,
    }
    const q = project([[item]])
    const scene = resolveSegment(q, 0, 14, 30)
    assert.equal(scene.items[0].window.src, '/orig_nobg.mov')
    assert.deepEqual(scene.items[0].window, sourceWindow(item, 'render'))
  })
})

describe('resolveAt: track walking follows the render / sample-frame model', () => {
  test('ALL tracks are walked with a trackIdx (sample-frame.js:535-545), not the editor partition', () => {
    // useVideoPlayback.ts:145-147 partitions into `clips` (tracks[0] video only),
    // `tracks0NonVideo` and `overlayTracks` (tracks.slice(1)). The resolver does
    // NOT do that: it walks every track with its index, which is the render /
    // sample-frame model. T6 maps the Scene back onto the editor's partition.
    const p = project([
      [
        { id: 't0-video', type: 'video', start: 0, end: 10, src: '/a.mp4' },
        { id: 't0-image', type: 'image', start: 0, end: 10, src: '/b.jpg' },
        { id: 't0-overlay', type: 'overlay', start: 0, end: 10, src: '/c.jsx' },
      ],
      [{ id: 't1-video', type: 'video', start: 0, end: 10, src: '/d.mp4' }],
    ])
    const scene = resolveAt(p, 5, { variant: 'preview' })
    assert.deepEqual(
      scene.items.map((r) => [r.item.id, r.trackIdx]),
      [
        ['t0-video', 0],
        ['t0-image', 0],
        ['t0-overlay', 0],
        ['t1-video', 1],
      ],
      'track-0 non-video items and a track-0 overlay are all first-class Scene items',
    )
  })

  test('an item with an unrecognised type is skipped (sample-frame.js:539-546 has no else branch)', () => {
    const p = project([
      [
        { id: 'ok', type: 'video', start: 0, end: 10, src: '/a.mp4' },
        { id: 'weird', type: 'sticker', start: 0, end: 10, src: '/s.png' },
        { id: 'typeless', start: 0, end: 10, src: '/x' },
      ],
    ])
    assert.deepEqual(
      resolveAt(p, 5, { variant: 'render' }).items.map((r) => r.item.id),
      ['ok'],
    )
  })

  test('a hole in tracks (undefined track) does not throw', () => {
    const p = { tracks: [undefined, [{ id: 'ov', type: 'overlay', start: 0, end: 5, src: '/o.jsx' }]] }
    assert.deepEqual(
      resolveAt(p, 1, { variant: 'render' }).items.map((r) => [r.item.id, r.trackIdx]),
      [['ov', 1]],
    )
  })
})

// ---------------------------------------------------------------------------
// 5. resolveSegment — the render containment predicate, with its frameDur slack
// ---------------------------------------------------------------------------

describe('resolveSegment: containment predicate (start <= segStart + frameDur && end >= segEnd - frameDur)', () => {
  test('an item exactly spanning the segment is contained', () => {
    assert.equal(coversSegment(0, 5, 0, 5, 30), true)
  })

  test('an item that only partially covers the segment is excluded', () => {
    assert.equal(coversSegment(0, 3, 0, 5, 30), false, 'ends too early')
    assert.equal(coversSegment(2, 8, 0, 5, 30), false, 'starts too late')
  })

  test('the tolerance is exactly one frame on each side', () => {
    // Starting up to a full frame AFTER the segment start still counts.
    assert.equal(coversSegment(1 / 30, 5, 0, 5, 30), true)
    assert.equal(coversSegment(1.0001 / 30, 5, 0, 5, 30), false)
    // Ending up to a full frame BEFORE the segment end still counts.
    assert.equal(coversSegment(0, 5 - 1 / 30, 0, 5, 30), true)
    assert.equal(coversSegment(0, 5 - 1.0001 / 30, 0, 5, 30), false)
    // And the tolerance shrinks with fps.
    assert.equal(coversSegment(1 / 30, 5, 0, 5, 60), false, 'a 30fps frame is two frames @60')
  })

  test('activeIn preserves input order and identity, and never mutates the input', () => {
    const rows = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 4, end: 6 },
      { id: 'c', start: 0, end: 10 },
    ]
    const before = structuredClone(rows)
    const out = activeIn(rows, 0, 3, 30)
    assert.deepEqual(
      out.map((r) => r.id),
      ['a', 'c'],
    )
    assert.equal(out[0], rows[0], 'identity preserved — the same object comes back')
    assert.deepEqual(rows, before)
  })

  test('activeIn accepts a custom interval accessor (the puppeteer-segment shape T7 needs)', () => {
    const segs = [
      { id: 'x', startSeconds: 0, endSeconds: 10 },
      { id: 'y', startSeconds: 8, endSeconds: 10 },
    ]
    assert.deepEqual(
      activeIn(segs, 0, 5, 30, readPuppeteer).map((s) => s.id),
      ['x'],
    )
  })

  test('resolveSegment carries t = segStart', () => {
    const p = project([[{ id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4' }]])
    assert.equal(resolveSegment(p, 1, 2, 30).t, 1)
  })
})

// ---------------------------------------------------------------------------
// 6. boundariesFrom edge cases
// ---------------------------------------------------------------------------

describe('boundariesFrom: edge cases', () => {
  test('no intervals → empty list (segment-plan.js:73)', () => {
    assert.deepEqual(boundariesFrom([], 30), [])
    assert.deepEqual(planBoundaries({}, 30), [])
    assert.deepEqual(planBoundaries({ tracks: [] }, 30), [])
    assert.deepEqual(planBoundaries({ tracks: [[]] }, 30), [])
  })

  test('duplicate boundaries collapse to one', () => {
    assert.deepEqual(
      boundariesFrom(
        [
          { start: 0, end: 5 },
          { start: 0, end: 5 },
          { start: 5, end: 5 },
        ],
        30,
      ),
      [0, 5],
    )
  })

  test('boundaries within the same frame collapse; the FIRST one is kept', () => {
    // 4.7666 and 4.7667 both quantize to 143/30 → one boundary.
    const out = boundariesFrom([{ start: 0, end: 4.76661 }, { start: 4.76669, end: 8 }], 30)
    assert.deepEqual(out, [0, 143 / 30, 8])
  })

  test('the output is sorted ascending and free of duplicates', () => {
    const out = boundariesFrom(
      [
        { start: 9, end: 1 },
        { start: 4, end: 4 },
        { start: 7, end: 2 },
      ],
      30,
    )
    assert.deepEqual(out, [1, 2, 4, 7, 9])
  })

  test('a single distinct boundary yields a one-element list (zero segments downstream)', () => {
    assert.deepEqual(boundariesFrom([{ start: 2, end: 2 }], 30), [2])
    assert.deepEqual(boundariesFrom([{ start: -3, end: -1 }], 30), [0], 'everything pre-zero collapses onto 0')
  })

  test('totality guard: a non-finite endpoint contributes the origin instead of poisoning the list', () => {
    // Legacy would emit NaN here and hand it to the encoder as a segment start.
    // The resolver contract requires every returned boundary to be finite.
    const out = boundariesFrom([{ start: undefined, end: 5 }, { start: NaN, end: Infinity }], 30)
    for (const b of out) assert.equal(Number.isFinite(b), true, `boundary ${b} is not finite`)
    assert.deepEqual(out, [0, 5])
  })
})

describe('planBoundaries: project-shaped collection', () => {
  test('walks every track, including overlays on track 0 (which legacy render skips)', () => {
    // DOCUMENTED DIVERGENCE from the legacy render pipeline: collectAllItems
    // (render.js:581-637) takes only image/video items and
    // collectPuppeteerSegments (render.js:502) slices tracks from 1, so an
    // OVERLAY item sitting on track 0 contributes no boundary and is never
    // rendered today. sample-frame.js:535-545 DOES honour it. The resolver
    // follows sample-frame. T7 delegates through the flat primitives, so render
    // parity is unaffected.
    const p = project([
      [
        { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4' },
        { id: 't0ov', type: 'overlay', start: 4, end: 6, src: '/o.jsx' },
      ],
    ])
    assert.deepEqual(planBoundaries(p, 30), [0, 4, 6, 10])
  })

  test('a missing start/end is treated as 0 so the function stays total', () => {
    const p = project([[{ id: 'broken', type: 'video', src: '/a.mp4' }]])
    assert.deepEqual(planBoundaries(p, 30), [0])
  })
})

// ---------------------------------------------------------------------------
// 7. Variant validation, purity, determinism, totality
// ---------------------------------------------------------------------------

const PURITY_PROJECTS = [
  {},
  { tracks: [] },
  project([[{ id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 1, outPoint: 6 }]]),
  project(
    [
      [
        { id: 'c1', type: 'video', start: 0, end: 4.8061, src: '/a.mp4', normalizedSrc: '/c.mp4', normalizedInPoint: 2, inPoint: 3, outPoint: 7 },
        { id: 'c2', type: 'video', start: 4.8061, end: 8, src: '/b.mp4' },
      ],
      [
        { id: 'img', type: 'image', start: 1, end: 9, src: '/i.jpg' },
        { id: 'ov', type: 'overlay', start: -0.5, end: 6, src: '/o.jsx', opaque: true },
      ],
    ],
    {
      captions: { style: 'clean', segments: [{ text: 'x', start: 0, end: 1 }] },
      audio: { tracks: [{ id: 'a1', src: '/m.mp3', start: 0, end: 30 }] },
    },
  ),
]

describe('variant validation (consistent with T2)', () => {
  for (const bad of ['Preview', 'RENDER', '', 'proxy', undefined, null, 0, {}]) {
    test(`resolveAt throws on variant ${JSON.stringify(bad) ?? String(bad)}`, () => {
      assert.throws(() => resolveAt(PURITY_PROJECTS[2], 1, { variant: bad }), TypeError)
    })
  }

  test('resolveAt with no options at all throws rather than defaulting', () => {
    assert.throws(() => resolveAt(PURITY_PROJECTS[2], 1), TypeError)
    assert.throws(() => resolveAt(PURITY_PROJECTS[2], 1, {}), TypeError)
  })
})

describe('purity', () => {
  test('resolveAt / resolveSegment / planBoundaries never mutate the project', () => {
    for (const [i, p] of PURITY_PROJECTS.entries()) {
      const before = structuredClone(p)
      planBoundaries(p, 30)
      resolveSegment(p, 0, 2, 30)
      for (const variant of VARIANTS) resolveAt(p, 1.5, { variant })
      assert.deepEqual(p, before, `project #${i} was mutated`)
    }
  })

  test('two identical calls return deep-equal results', () => {
    for (const [i, p] of PURITY_PROJECTS.entries()) {
      assert.deepEqual(planBoundaries(p, 30), planBoundaries(p, 30), `#${i} planBoundaries not deterministic`)
      assert.deepEqual(resolveSegment(p, 0, 2, 30), resolveSegment(p, 0, 2, 30), `#${i} resolveSegment not deterministic`)
      for (const variant of VARIANTS) {
        assert.deepEqual(
          resolveAt(p, 1.5, { variant }),
          resolveAt(p, 1.5, { variant }),
          `#${i} resolveAt (${variant}) not deterministic`,
        )
      }
    }
  })

  test('the returned Scene is a fresh value, not shared state', () => {
    const p = PURITY_PROJECTS[2]
    const a = resolveAt(p, 1, { variant: 'preview' })
    const b = resolveAt(p, 1, { variant: 'preview' })
    assert.notEqual(a, b)
    assert.notEqual(a.items, b.items)
    a.items.length = 0
    assert.equal(resolveAt(p, 1, { variant: 'preview' }).items.length, b.items.length)
  })

  test('the Scene references the original item object (no cloning)', () => {
    const item = { id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4' }
    const p = project([[item]])
    assert.equal(resolveAt(p, 1, { variant: 'render' }).items[0].item, item)
  })
})

describe('totality', () => {
  test('every boundary is a finite number, for every project and every fps', () => {
    for (const p of PURITY_PROJECTS) {
      for (const fps of [24, 30, 60]) {
        for (const b of planBoundaries(p, fps)) {
          assert.equal(Number.isFinite(b), true, `boundary ${b} is not finite`)
        }
      }
    }
  })

  test('resolveAt on an empty project returns { items: [], t } rather than throwing', () => {
    for (const variant of VARIANTS) {
      assert.deepEqual(resolveAt({}, 3, { variant }), { items: [], t: 3 })
      assert.deepEqual(resolveAt({ tracks: [] }, 0, { variant }), { items: [], t: 0 })
      assert.deepEqual(resolveAt({ tracks: [[]] }, -1, { variant }), { items: [], t: -1 })
    }
  })

  test('resolveSegment on an empty project returns { items: [], t: segStart }', () => {
    assert.deepEqual(resolveSegment({}, 2, 4, 30), { items: [], t: 2 })
  })

  test('every resolved item has a finite seek and a well-formed window', () => {
    for (const p of PURITY_PROJECTS) {
      for (const variant of VARIANTS) {
        for (const t of [-1, 0, 1.5, 4.8061, 100]) {
          for (const r of resolveAt(p, t, { variant }).items) {
            assert.ok(['video', 'image', 'overlay'].includes(r.kind), `bad kind ${r.kind}`)
            assert.equal(Number.isFinite(r.seek), true, `seek not finite for ${r.item.id} at ${t}`)
            assert.equal(Number.isInteger(r.trackIdx), true, `trackIdx not an integer for ${r.item.id}`)
            if (r.kind === 'video') {
              assert.notEqual(r.window, null, 'a video item must carry a source window')
              assert.equal(Number.isFinite(r.window.inPoint), true)
            } else {
              assert.equal(r.window, null, `${r.kind} items carry no source window`)
            }
          }
        }
      }
    }
  })
})
