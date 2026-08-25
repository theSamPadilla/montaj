/// <reference types="vitest/globals" />
/**
 * `applyMoveDeltaToSelection` — the rigid group move behind every multi-select
 * drag, now that caption segments join clips and audio bars in the SAME
 * `selectedIds` array.
 *
 * The fixture keeps every kind at a different place on the timeline so a clamp
 * can be attributed to exactly one member:
 *
 *   clips    c0 0–5, c1 5–10
 *   audio    a0 1–6
 *   captions s0 1–2 (with word timings), s1 3–4, and one segment with no id
 *
 * Word timings are absolute seconds, which is the whole reason they have to
 * travel with the segment rather than being left to a respread.
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import { applyMoveDeltaToSelection, deleteSelection } from '../multiSelectOps'
import { trackItems } from '../timeline-model'

const TOTAL_DURATION = 20

function project(): Project {
  return {
    id: 'p',
    tracks: [{
      id: 'trk-0',
      items: [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 10 },
      ],
    }],
    audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 }] },
    captions: {
      style: 'pop',
      segments: [
        {
          id: 's0',
          text: 'hello there',
          start: 1,
          end: 2,
          words: [
            { word: 'hello', start: 1, end: 1.6 },
            { word: 'there', start: 1.6, end: 2 },
          ],
        },
        { id: 's1', text: 'second', start: 3, end: 4 },
        // No id yet — `backfillCaptionIds` has not run. Can never be selected.
        { text: 'unminted', start: 8, end: 9 },
      ],
    },
  } as unknown as Project
}

const segments = (p: Project) => p.captions!.segments
const seg = (p: Project, id: string) => segments(p).find(s => s.id === id)!
const visual = (p: Project, id: string) => trackItems(p).flat().find(i => i.id === id)!

describe('applyMoveDeltaToSelection — caption segments', () => {
  it('shifts start, end and every word by the same delta', () => {
    const before = project()
    const after = applyMoveDeltaToSelection(before, ['s0'], 0.5, TOTAL_DURATION)
    expect(seg(after, 's0')).toMatchObject({ start: 1.5, end: 2.5 })
    expect(seg(after, 's0').words).toEqual([
      { word: 'hello', start: 1.5, end: 2.1 },
      { word: 'there', start: 2.1, end: 2.5 },
    ])
  })

  it('leaves the text alone — a move is a retime, not an edit', () => {
    const after = applyMoveDeltaToSelection(project(), ['s0'], 0.5, TOTAL_DURATION)
    expect(seg(after, 's0').text).toBe('hello there')
  })

  it('leaves a segment with no words a segment with no words', () => {
    const after = applyMoveDeltaToSelection(project(), ['s1'], 0.5, TOTAL_DURATION)
    expect(seg(after, 's1')).toMatchObject({ start: 3.5, end: 4.5 })
    expect(seg(after, 's1').words).toBeUndefined()
  })

  it('does not touch an unselected segment, id-less or not', () => {
    const before = project()
    const after = applyMoveDeltaToSelection(before, ['s0'], 0.5, TOTAL_DURATION)
    // Same object references, not merely equal values.
    expect(segments(after)[1]).toBe(segments(before)[1])
    expect(segments(after)[2]).toBe(segments(before)[2])
  })

  it('moves captions and clips together under one delta', () => {
    const after = applyMoveDeltaToSelection(project(), ['c0', 's0'], 1, TOTAL_DURATION)
    expect(visual(after, 'c0')).toMatchObject({ start: 1, end: 6 })
    expect(seg(after, 's0')).toMatchObject({ start: 2, end: 3 })
    // Nothing outside the selection moves.
    expect(visual(after, 'c1')).toMatchObject({ start: 5, end: 10 })
  })

  it('counts a caption in the group extent, so one clamp holds the whole body', () => {
    // s0 starts at 1 and c1 at 5, so the CAPTION is the leftmost member: the
    // group can only travel 1s left. Without captions in the extent scan the
    // clamp would allow -5 and drag s0 to -4.
    const after = applyMoveDeltaToSelection(project(), ['c1', 's0'], -5, TOTAL_DURATION)
    expect(seg(after, 's0')).toMatchObject({ start: 0, end: 1 })
    expect(visual(after, 'c1')).toMatchObject({ start: 4, end: 9 })
  })

  it('counts a caption at the right-hand extreme too', () => {
    // Push s1's end (4) out to the horizon: the group may travel 16s. Isolated
    // to a project with only s1's caption present — `project()`'s own s0 and
    // id-less segment would otherwise trip the caption-neighbour clamp (see
    // the dedicated describe block below) before this ever reaches the
    // timeline edge under test here.
    const before = { ...project(), captions: { style: 'pop', segments: [{ id: 's1', text: 'second', start: 3, end: 4 }] } } as unknown as Project
    const after = applyMoveDeltaToSelection(before, ['s1'], 99, TOTAL_DURATION)
    expect(seg(after, 's1')).toMatchObject({ start: 19, end: 20 })
  })

  it('moves a caption whose id is the only one selected', () => {
    // The shape `applyCaptionMove` leans on when a drag starts on an
    // UNSELECTED caption: a one-id selection still moves. Isolated to a
    // project with only s0's caption present, for the same reason as above —
    // `project()`'s s1 sits only 1s away and would clamp this delta to 1
    // rather than the full 2 this test means to demonstrate.
    const before = { ...project(), captions: { style: 'pop', segments: [{ id: 's0', text: 'hello there', start: 1, end: 2 }] } } as unknown as Project
    const after = applyMoveDeltaToSelection(before, ['s0'], 2, TOTAL_DURATION)
    expect(seg(after, 's0')).toMatchObject({ start: 3, end: 4 })
  })

  it('returns the same project reference on a no-op', () => {
    const before = project()
    expect(applyMoveDeltaToSelection(before, ['s0'], 0, TOTAL_DURATION)).toBe(before)
    expect(applyMoveDeltaToSelection(before, [], 1, TOTAL_DURATION)).toBe(before)
    // A selection of ids that aren't in the project at all is also a no-op.
    expect(applyMoveDeltaToSelection(before, ['gone'], 1, TOTAL_DURATION)).toBe(before)
  })

  it('builds no new captions object when no caption moved', () => {
    const before = project()
    const after = applyMoveDeltaToSelection(before, ['c0'], 1, TOTAL_DURATION)
    expect(after).not.toBe(before)
    expect(after.captions).toBe(before.captions)
  })

  it('leaves captions undefined on a project that has none', () => {
    const before = { ...project(), captions: undefined } as unknown as Project
    const after = applyMoveDeltaToSelection(before, ['c0'], 1, TOTAL_DURATION)
    expect(after.captions).toBeUndefined()
    expect(visual(after, 'c0')).toMatchObject({ start: 1, end: 6 })
  })
})

// ── Caption-neighbour clamp ─────────────────────────────────────────────
//
// Captions may never overlap WITHIN A LANE: `activeCaptionSegments`
// (timeline-core) hands the preview and every render template EVERY live
// segment, lane-ascending, and a lane is a z-order with no vertical offset of
// its own — so two segments sharing a lane and an instant paint one straight
// over the other. A selected caption may therefore not cross a NON-selected
// SAME-LANE caption's edge, folded into the same lo/hi the timeline-edge clamp
// already uses (see `captionNeighbourBounds`). The per-lane half of that rule
// has its own describe block below.

function neighbourProject(): Project {
  return {
    id: 'p',
    captions: {
      style: 'pop',
      segments: [
        { id: 's0', text: 'hello there', start: 1, end: 2 },
        { id: 's1', text: 'second', start: 3, end: 4 },
      ],
    },
  } as unknown as Project
}

describe('applyMoveDeltaToSelection — caption-neighbour clamp', () => {
  it('does not let a single selected caption cross its previous (left) neighbour', () => {
    // s1 (3–4) may travel left only until its start meets s0's end (2) — a 1s
    // gap — not the -5 requested, and not the -3 a bare timeline-edge clamp
    // (t=0) alone would allow.
    const after = applyMoveDeltaToSelection(neighbourProject(), ['s1'], -5, TOTAL_DURATION)
    expect(seg(after, 's1')).toMatchObject({ start: 2, end: 3 })
  })

  it('does not let a single selected caption cross its next (right) neighbour', () => {
    // s0 (1–2) may travel right only until its end meets s1's start (3).
    const after = applyMoveDeltaToSelection(neighbourProject(), ['s0'], 5, TOTAL_DURATION)
    expect(seg(after, 's0')).toMatchObject({ start: 2, end: 3 })
  })

  it('preserves duration when the neighbour clamp bites', () => {
    // The clamp shifts the whole delta, not just one edge — a clamped move is
    // still a rigid shift, never a shrink. Pinned against the exact clamped
    // position (not just the duration, which a differently-clamped result —
    // e.g. the timeline-edge clamp alone — would also happen to preserve):
    // duration survives a clamp landing AT the neighbour bound specifically.
    const after = applyMoveDeltaToSelection(neighbourProject(), ['s0'], 5, TOTAL_DURATION)
    const clamped = seg(after, 's0')
    expect(clamped).toMatchObject({ start: 2, end: 3 })
    expect(clamped.end - clamped.start).toBe(1)
  })

  it('moves an adjacent run of selected captions rigidly, without clamping the pair against each other', () => {
    const before: Project = {
      id: 'p',
      captions: {
        style: 'pop',
        segments: [
          { id: 'a', text: 'a', start: 1, end: 2 },
          { id: 'b', text: 'b', start: 2, end: 3 },  // touches a — both selected
          { id: 'c', text: 'c', start: 4, end: 5 },  // NOT selected — the real stop
        ],
      },
    } as unknown as Project

    // Small delta, nowhere near c: both move by the full amount and stay
    // exactly as adjacent as they started. If the neighbour search didn't
    // exclude selected ids, b would see a as a "left neighbour" (or vice
    // versa) and refuse to move at all.
    const nudged = applyMoveDeltaToSelection(before, ['a', 'b'], 0.5, TOTAL_DURATION)
    expect(seg(nudged, 'a')).toMatchObject({ start: 1.5, end: 2.5 })
    expect(seg(nudged, 'b')).toMatchObject({ start: 2.5, end: 3.5 })

    // Large delta: the pair travels together and stops the instant b's end
    // reaches c's start (4) — 1s of the 5 requested — never crossing into c.
    const stopped = applyMoveDeltaToSelection(before, ['a', 'b'], 5, TOTAL_DURATION)
    expect(seg(stopped, 'a')).toMatchObject({ start: 2, end: 3 })
    expect(seg(stopped, 'b')).toMatchObject({ start: 3, end: 4 })
  })

  it('leaves a clips-only selection unaffected by any caption, however it overlaps in time', () => {
    const before: Project = {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5 }] }],
      captions: {
        style: 'pop',
        // Overlaps c0's whole span in time — irrelevant, since no caption is
        // selected, `captionNeighbourBounds` never even looks at it.
        segments: [{ id: 's0', text: 'hello', start: 0.5, end: 4.5 }],
      },
    } as unknown as Project
    const after = applyMoveDeltaToSelection(before, ['c0'], 10, TOTAL_DURATION)
    expect(visual(after, 'c0')).toMatchObject({ start: 10, end: 15 })
  })
})

// ── The neighbour clamp is PER LANE ────────────────────────────────────────
//
// Captions on different rows may overlap and all render — that is what caption
// rows are for — so only a segment sharing the dragged one's lane is a bound.
// A track-wide clamp (what this was before caption lanes existed) would stop a
// lane-0 caption dead at a lane-1 caption it can legally pass straight under.

describe('applyMoveDeltaToSelection — the caption-neighbour clamp is per lane', () => {
  function twoLanes(): Project {
    return {
      id: 'p',
      captions: {
        style: 'pop',
        segments: [
          { id: 'ground', text: 'ground', start: 1, end: 2 },                 // lane 0 (absent ⇒ 0)
          { id: 'upstairs', text: 'upstairs', start: 3, end: 4, lane: 1 },
        ],
      },
    } as unknown as Project
  }

  it('lets a caption pass clean under a caption on another lane', () => {
    // Track-wide, `upstairs` (3–4) would stop `ground` at a delta of 1. Per
    // lane it is not a neighbour at all, so the full 5s delta lands.
    const after = applyMoveDeltaToSelection(twoLanes(), ['ground'], 5, TOTAL_DURATION)
    expect(seg(after, 'ground')).toMatchObject({ start: 6, end: 7 })
  })

  it('still stops at a neighbour that DOES share the lane', () => {
    const sameLane = {
      ...twoLanes(),
      captions: {
        style: 'pop',
        segments: [
          { id: 'ground', text: 'ground', start: 1, end: 2 },
          { id: 'upstairs', text: 'upstairs', start: 3, end: 4 },   // now lane 0 too
        ],
      },
    } as unknown as Project
    const after = applyMoveDeltaToSelection(sameLane, ['ground'], 5, TOTAL_DURATION)
    expect(seg(after, 'ground')).toMatchObject({ start: 2, end: 3 })
  })

  it('treats an absent lane and an explicit `lane: 0` as the same row', () => {
    // `laneOf` collapses both to 0, so these two must clamp against each other.
    const mixed = {
      id: 'p',
      captions: {
        style: 'pop',
        segments: [
          { id: 'ground', text: 'ground', start: 1, end: 2 },
          { id: 'explicit', text: 'explicit', start: 3, end: 4, lane: 0 },
        ],
      },
    } as unknown as Project
    expect(seg(applyMoveDeltaToSelection(mixed, ['ground'], 5, TOTAL_DURATION), 'ground'))
      .toMatchObject({ start: 2, end: 3 })
  })

  it('takes the TIGHTEST bound across the lanes the selection actually occupies', () => {
    // Two selected captions, one per lane, each with its own unselected
    // same-lane neighbour: lane 0 leaves 3s of room, lane 1 leaves 4s. The
    // group moves by the tighter of the two, 3s, and both keep their lanes.
    //
    // `decoy` is the discriminating part: it sits 0.5s to the right of both
    // selected captions but on a lane NEITHER of them is on, so it bounds
    // nothing. Track-wide it was the tightest bound of all and pinned the
    // whole group to 0.5s.
    const before: Project = {
      id: 'p',
      captions: {
        style: 'pop',
        segments: [
          { id: 'a', text: 'a', start: 1, end: 2 },
          { id: 'blockA', text: 'blockA', start: 5, end: 6 },                 // 3s of room for a
          { id: 'b', text: 'b', start: 1, end: 2, lane: 1 },
          { id: 'blockB', text: 'blockB', start: 6, end: 7, lane: 1 },        // 4s of room for b
          { id: 'decoy', text: 'decoy', start: 2.5, end: 3.5, lane: 2 },
        ],
      },
    } as unknown as Project
    const after = applyMoveDeltaToSelection(before, ['a', 'b'], 5, TOTAL_DURATION)
    expect(seg(after, 'a')).toMatchObject({ start: 4, end: 5 })
    expect(seg(after, 'b')).toMatchObject({ start: 4, end: 5 })
    expect(seg(after, 'decoy')).toMatchObject({ start: 2.5, end: 3.5 })
  })

  it('carries `lane` through a group move untouched — a group move is horizontal only', () => {
    const after = applyMoveDeltaToSelection(twoLanes(), ['ground', 'upstairs'], 1, TOTAL_DURATION)
    expect(seg(after, 'ground').lane).toBeUndefined()   // absent stays absent, not written to 0
    expect(seg(after, 'upstairs').lane).toBe(1)
    expect(seg(after, 'upstairs')).toMatchObject({ start: 4, end: 5 })
  })
})

// ── A caption overhanging totalDuration ────────────────────────────────────
//
// `totalDuration` is derived from clips and audio only (timeline-model.ts), so
// a caption can legally end past it once clips are trimmed or deleted after
// captioning. Mirrors the overhang fixture in pointer-machine.test.ts's caption
// trim describe: `hi` must be floored at 0 so an already-overhanging member
// can't be pushed further out — an unfloored `hi` goes negative there and
// (via `Math.min(hi, requestedDelta)`) drags the whole group backwards on a
// RIGHTWARD drag instead of refusing to move it.

const OVERHANG_TOTAL_DURATION = 15

function overhangProject(): Project {
  return {
    id: 'p',
    tracks: [{
      id: 'trk-0',
      items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5 }],
    }],
    captions: {
      style: 'pop',
      segments: [{ id: 'over', text: 'trailing', start: 16, end: 18 }],
    },
  } as unknown as Project
}

describe('applyMoveDeltaToSelection — a caption overhanging totalDuration', () => {
  it('does not move a lone overhanging caption right, and does not teleport it either', () => {
    // Unfloored: lo=-16, hi=15-18=-3, lo>hi is false, so delta clamps to
    // min(-3, 0.5) = -3 — a 3s jump LEFT on a rightward drag. Floored: hi=0,
    // delta clamps to 0.
    const before = overhangProject()
    const after = applyMoveDeltaToSelection(before, ['over'], 0.5, OVERHANG_TOTAL_DURATION)
    expect(after).toBe(before)
  })

  it('still moves a lone overhanging caption left by the requested amount', () => {
    // hi=0 does not touch `lo`, so a leftward drag is unaffected by the floor.
    const after = applyMoveDeltaToSelection(overhangProject(), ['over'], -2, OVERHANG_TOTAL_DURATION)
    expect(seg(after, 'over')).toMatchObject({ start: 14, end: 16 })
  })

  it('leaves a clip mixed with an overhanging caption immovable, not dragged backwards', () => {
    // The clip pins lo at 0 (already at t=0) and the overhanging caption pins
    // hi at 0 (already past totalDuration), so the group cannot move either
    // way — a real "can't move" case, not the old sign-flip bug (which also
    // produced delta 0 here, via `lo > hi`, but for the wrong reason: `hi` was
    // -3, not 0).
    const before = overhangProject()
    const after = applyMoveDeltaToSelection(before, ['c0', 'over'], 0.5, OVERHANG_TOTAL_DURATION)
    expect(after).toBe(before)
  })
})

// ── deleteSelection — track grouping survives a prune (Part B) ─────────────
//
// `deleteSelection` re-groups its result (`normalizeTrackOrder`) after
// pruning emptied tracks, because a prune can change a SURVIVING track's
// coarse kind: a mixed track that loses its only video item becomes
// overlay-kind, and the canonical video-block/overlay-block stack has to
// re-absorb it rather than leave it stranded where it used to sit.

describe('deleteSelection', () => {
  function trackProject(
    tracks: Array<{ id: string; items: Array<{ id: string; type: string; start: number; end: number }> }>,
  ): Project {
    return { id: 'p', tracks } as unknown as Project
  }

  it('returns the project unchanged when nothing is selected', () => {
    const p = trackProject([{ id: 'trk-0', items: [{ id: 'v0', type: 'video', start: 0, end: 5 }] }])
    expect(deleteSelection(p, [])).toBe(p)
  })

  it('prunes a track left empty by the delete (baseline, unaffected by grouping)', () => {
    const p = trackProject([
      { id: 'trk-0', items: [{ id: 'v0', type: 'video', start: 0, end: 5 }] },
      { id: 'trk-1', items: [{ id: 'o0', type: 'overlay', start: 0, end: 5 }] },
    ])
    const next = deleteSelection(p, ['o0'])
    expect(next.tracks!.map(t => t.id)).toEqual(['trk-0'])
  })

  it('re-groups a track whose coarse kind changed after the prune — losing its only video item drops it out of the video block', () => {
    const p = trackProject([
      {
        id: 'trk-mixed',
        items: [
          { id: 'v-mixed', type: 'video', start: 0, end: 5 },
          { id: 'o-mixed', type: 'overlay', start: 0, end: 5 },
        ],
      }, // mixed — video-kind today (has a video item), so it's in the video
         // group AHEAD of trk-video, matching their raw array order.
      { id: 'trk-video', items: [{ id: 'v0', type: 'video', start: 0, end: 5 }] },
      { id: 'trk-overlay', items: [{ id: 'o0', type: 'overlay', start: 0, end: 5 }] },
    ])

    const next = deleteSelection(p, ['v-mixed'])

    // trk-mixed lost its only video item and is now overlay-kind, so it
    // drops OUT of the video block — trk-video (still video-kind) moves
    // ahead of it, even though trk-mixed came first in the raw array.
    expect(next.tracks!.map(t => t.id)).toEqual(['trk-video', 'trk-mixed', 'trk-overlay'])
    expect(next.tracks!.find(t => t.id === 'trk-mixed')!.items.map(i => i.id)).toEqual(['o-mixed'])
  })
})
