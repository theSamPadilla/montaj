// montaj_assets/timeline-core/test/durations.test.mjs
//
// T3 suite for the two project-duration functions. They are DIFFERENT
// functions with different answers, and that is the whole point of porting
// both under honest names:
//
//   visualDuration(project) — render.js:770-774 (`getTotalDurationSeconds`).
//                             max `end` over EVERY item in EVERY track.
//                             Audio is EXCLUDED.
//   projectEnd(project)     — useVideoPlayback.ts:154-159.
//                             max(videoEnd, overlayEnd, audioEnd), where
//                             videoEnd is the LAST video clip of track 0 by
//                             start order. Audio is INCLUDED.
//
// The audio difference is a registry entry: KNOWN-DIVERGENCES.md (created in
// T5) — "audio-duration mismatch", owner SP4.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { visualDuration, projectEnd } from '../index.js'

/** @type {Array<{name: string, project: object}>} */
const ALL_FIXTURES = []
function fixture(name, project) {
  ALL_FIXTURES.push({ name, project })
  return project
}

// ---------------------------------------------------------------------------
// 1. Empty and near-empty projects
// ---------------------------------------------------------------------------

const EMPTY = fixture('empty', {})
const EMPTY_TRACKS = fixture('empty-tracks', { tracks: [] })
const EMPTY_TRACK = fixture('one-empty-track', { tracks: [[]] })

describe('empty projects', () => {
  for (const p of [EMPTY, EMPTY_TRACKS, EMPTY_TRACK]) {
    test(`both functions return 0 for ${JSON.stringify(p)}`, () => {
      assert.equal(visualDuration(p), 0)
      assert.equal(projectEnd(p), 0)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. The plain case — they agree
// ---------------------------------------------------------------------------

const PLAIN = fixture('plain-two-clips-no-audio', {
  tracks: [
    [
      { id: 'c1', type: 'video', start: 0, end: 4, src: '/a.mp4' },
      { id: 'c2', type: 'video', start: 4, end: 9.5, src: '/b.mp4' },
    ],
  ],
})

describe('a plain video-only project', () => {
  test('both functions return the end of the last clip', () => {
    assert.equal(visualDuration(PLAIN), 9.5)
    assert.equal(projectEnd(PLAIN), 9.5)
  })
})

const WITH_OVERLAY = fixture('overlay-outlasts-video', {
  tracks: [
    [{ id: 'c1', type: 'video', start: 0, end: 4, src: '/a.mp4' }],
    [{ id: 'ov', type: 'overlay', start: 3, end: 12, src: '/o.jsx' }],
  ],
})

describe('an overlay that outlasts the video', () => {
  test('both functions extend to the overlay end (visualDuration via the flat max, projectEnd via overlayEnd)', () => {
    assert.equal(visualDuration(WITH_OVERLAY), 12)
    assert.equal(projectEnd(WITH_OVERLAY), 12)
  })
})

// ---------------------------------------------------------------------------
// 3. THE REGISTRY ENTRY — audio outlasts video, and the two answers differ
// ---------------------------------------------------------------------------

const AUDIO_OUTLASTS = fixture('audio-outlasts-video', {
  tracks: [[{ id: 'c1', type: 'video', start: 0, end: 6, src: '/a.mp4' }]],
  audio: { tracks: [{ id: 'bed', src: '/music.mp3', start: 0, end: 20 }] },
})

const AUDIO_SHORTER = fixture('audio-shorter-than-video', {
  tracks: [[{ id: 'c1', type: 'video', start: 0, end: 6, src: '/a.mp4' }]],
  audio: { tracks: [{ id: 'bed', src: '/m.mp3', start: 0, end: 2 }] },
})

const AUDIO_ONLY = fixture('audio-only', {
  audio: { tracks: [{ id: 'a', src: '/m.mp3', start: 0, end: 8 }] },
})

const AUDIO_TRACK_NO_END = fixture('audio-track-without-end', {
  tracks: [[{ id: 'c1', type: 'video', start: 0, end: 6, src: '/a.mp4' }]],
  audio: { tracks: [{ id: 'a', src: '/m.mp3', start: 0 }] },
})

const MULTI_AUDIO = fixture('multi-audio', {
  tracks: [[{ id: 'c1', type: 'video', start: 0, end: 6, src: '/a.mp4' }]],
  audio: { tracks: [{ end: 3 }, { end: 31 }, { end: 12 }] },
})

describe('KNOWN-DIVERGENCES.md "audio-duration mismatch" (owner SP4)', () => {
  test('audio outlasting video: visualDuration EXCLUDES audio, projectEnd INCLUDES it — they differ', () => {
    assert.equal(visualDuration(AUDIO_OUTLASTS), 6, 'render.js:770 never looks at project.audio')
    assert.equal(projectEnd(AUDIO_OUTLASTS), 20, 'useVideoPlayback.ts:157 folds audioEnd into the max')
    assert.notEqual(
      visualDuration(AUDIO_OUTLASTS),
      projectEnd(AUDIO_OUTLASTS),
      'this difference is deliberate and documented, not a bug to unify here',
    )
  })

  test('the render engine therefore stops 14s before the editor preview does', () => {
    assert.equal(projectEnd(AUDIO_OUTLASTS) - visualDuration(AUDIO_OUTLASTS), 14)
  })

  test('audio SHORTER than video does not change either answer', () => {
    assert.equal(visualDuration(AUDIO_SHORTER), 6)
    assert.equal(projectEnd(AUDIO_SHORTER), 6)
  })

  test('an audio-only project: visualDuration is 0 while projectEnd is the audio end', () => {
    assert.equal(visualDuration(AUDIO_ONLY), 0)
    assert.equal(projectEnd(AUDIO_ONLY), 8)
  })

  test('an audio track with no `end` contributes 0 (the `?? 0` tail at useVideoPlayback.ts:157)', () => {
    assert.equal(projectEnd(AUDIO_TRACK_NO_END), 6)
  })

  test('multiple audio tracks take the max', () => {
    assert.equal(projectEnd(MULTI_AUDIO), 31)
    assert.equal(visualDuration(MULTI_AUDIO), 6)
  })
})

// ---------------------------------------------------------------------------
// 4. FAITHFULNESS SURPRISES in projectEnd's `videoEnd`.
//    Reproduced verbatim rather than "fixed" — these tests document what the
//    shipping editor actually does. Any change is a behavior change with its
//    own plan.
// ---------------------------------------------------------------------------

const OUT_OF_ORDER = fixture('track0-clips-out-of-order', {
  tracks: [
    [
      { id: 'long', type: 'video', start: 0, end: 10, src: '/a.mp4' },
      { id: 'short', type: 'video', start: 5, end: 6, src: '/b.mp4' },
    ],
  ],
})

describe('projectEnd surprise #1: videoEnd is the LAST clip by start, not the max end', () => {
  test('an overlapping short clip that starts later TRUNCATES projectEnd below the real last frame', () => {
    // useVideoPlayback.ts:155 is `clips[clips.length - 1].end` over a
    // start-sorted list — NOT `max(end)`. With a long clip [0,10] under a short
    // clip [5,6] on track 0, the "last" clip is the short one, so projectEnd is
    // 6 even though picture is still on screen until 10.
    assert.equal(projectEnd(OUT_OF_ORDER), 6, 'last-by-start wins, even though it is not the latest end')
    assert.equal(visualDuration(OUT_OF_ORDER), 10, 'the render engine correctly takes the max')
    assert.ok(projectEnd(OUT_OF_ORDER) < visualDuration(OUT_OF_ORDER))
  })

  test('array order does not matter — the clips are sorted by start first', () => {
    const reversed = {
      tracks: [
        [
          { id: 'short', type: 'video', start: 5, end: 6, src: '/b.mp4' },
          { id: 'long', type: 'video', start: 0, end: 10, src: '/a.mp4' },
        ],
      ],
    }
    assert.equal(projectEnd(reversed), 6, 'same answer as the other array order')
  })

  test('sorting by start does not mutate the caller\'s track array', () => {
    const track = [
      { id: 'short', type: 'video', start: 5, end: 6, src: '/b.mp4' },
      { id: 'long', type: 'video', start: 0, end: 10, src: '/a.mp4' },
    ]
    const p = { tracks: [track] }
    projectEnd(p)
    assert.deepEqual(
      track.map((c) => c.id),
      ['short', 'long'],
      'the sort must run on the filtered copy, never on the project',
    )
  })
})

const CANVAS = fixture('canvas-project-track0-image-only', {
  tracks: [[{ id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg' }]],
})

const CANVAS_ON_TRACK1 = fixture('canvas-image-on-track-1', {
  tracks: [[], [{ id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg' }]],
})

const TRACK0_MIXED = fixture('track0-mixed', {
  tracks: [
    [
      { id: 'c1', type: 'video', start: 0, end: 4, src: '/a.mp4' },
      { id: 'img', type: 'image', start: 4, end: 30, src: '/i.jpg' },
    ],
  ],
})

describe('projectEnd surprise #2: only `type === "video"` items of track 0 count toward videoEnd', () => {
  test('a canvas project (image-only track 0) has projectEnd 0 while visualDuration is 10', () => {
    // useVideoPlayback.ts:145 filters track 0 to `type === 'video'` before
    // taking the last end; a canvas project has no such clips, so videoEnd is 0.
    // The editor handles canvas projects through `isCanvasProject` elsewhere,
    // but projectEnd itself really does return 0 here.
    assert.equal(projectEnd(CANVAS), 0)
    assert.equal(visualDuration(CANVAS), 10)
  })

  test('the same image on track 1 DOES count, via overlayEnd', () => {
    assert.equal(projectEnd(CANVAS_ON_TRACK1), 10, 'tracks.slice(1) is not filtered by type')
    assert.equal(visualDuration(CANVAS_ON_TRACK1), 10)
  })

  test('a non-video item on track 0 is ignored by videoEnd but still counted by visualDuration', () => {
    assert.equal(projectEnd(TRACK0_MIXED), 4)
    assert.equal(visualDuration(TRACK0_MIXED), 30)
  })
})

// ---------------------------------------------------------------------------
// 5. visualDuration specifics
// ---------------------------------------------------------------------------

const MAX_ACROSS_TRACKS = fixture('max-across-tracks', {
  tracks: [
    [{ id: 'a', type: 'video', start: 0, end: 3, src: '/a.mp4' }],
    [{ id: 'b', type: 'overlay', start: 0, end: 17.25, src: '/o.jsx' }],
    [{ id: 'c', type: 'image', start: 0, end: 9, src: '/i.jpg' }],
  ],
})

const ITEM_WITHOUT_END = fixture('item-without-end', {
  tracks: [
    [
      { id: 'a', type: 'video', start: 0, src: '/a.mp4' },
      { id: 'b', type: 'video', start: 0, end: 2, src: '/b.mp4' },
    ],
  ],
})

const ALL_ITEMS_WITHOUT_END = fixture('all-items-without-end', {
  tracks: [[{ id: 'a', type: 'video', start: 0, src: '/a.mp4' }]],
})

const NEGATIVE_ENDS = fixture('negative-ends', {
  tracks: [[{ id: 'a', type: 'video', start: -5, end: -1, src: '/a.mp4' }]],
})

describe('visualDuration', () => {
  test('takes the max across ALL tracks, not just track 0', () => {
    assert.equal(visualDuration(MAX_ACROSS_TRACKS), 17.25)
  })

  test('an item with no `end` contributes 0 (render.js:773 `i.end ?? 0`)', () => {
    assert.equal(visualDuration(ITEM_WITHOUT_END), 2)
  })

  test('a project whose only item has no `end` at all returns 0, never NaN', () => {
    assert.equal(visualDuration(ALL_ITEMS_WITHOUT_END), 0)
    assert.equal(Number.isNaN(visualDuration(ALL_ITEMS_WITHOUT_END)), false)
  })

  test('negative ends still yield the max (which may be negative — nothing floors here)', () => {
    assert.equal(visualDuration(NEGATIVE_ENDS), -1, 'render.js:770 has no floor; only the boundary pipeline floors at 0')
  })
})

// ---------------------------------------------------------------------------
// 6. Purity, determinism, totality over every fixture registered above
// ---------------------------------------------------------------------------

describe('purity', () => {
  test('neither function mutates its input project', () => {
    for (const { name, project } of ALL_FIXTURES) {
      const before = structuredClone(project)
      visualDuration(project)
      projectEnd(project)
      assert.deepEqual(project, before, `fixture "${name}" was mutated`)
    }
  })

  test('two calls with the same input return the same answer', () => {
    for (const { name, project } of ALL_FIXTURES) {
      assert.equal(visualDuration(project), visualDuration(project), `"${name}" visualDuration not deterministic`)
      assert.equal(projectEnd(project), projectEnd(project), `"${name}" projectEnd not deterministic`)
    }
  })
})

describe('totality', () => {
  test('every fixture yields a finite number from both functions', () => {
    assert.ok(ALL_FIXTURES.length >= 15, `expected a broad fixture set, got ${ALL_FIXTURES.length}`)
    for (const { name, project } of ALL_FIXTURES) {
      assert.equal(Number.isFinite(visualDuration(project)), true, `"${name}": visualDuration not finite`)
      assert.equal(Number.isFinite(projectEnd(project)), true, `"${name}": projectEnd not finite`)
    }
  })
})
