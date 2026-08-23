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
import { applyMoveDeltaToSelection } from '../multiSelectOps'
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
    // Push s1's end (4) out to the horizon: the group may travel 16s.
    const after = applyMoveDeltaToSelection(project(), ['s1'], 99, TOTAL_DURATION)
    expect(seg(after, 's1')).toMatchObject({ start: 19, end: 20 })
  })

  it('moves a caption whose id is the only one selected', () => {
    // The shape `applyCaptionMove` leans on when a drag starts on an
    // UNSELECTED caption: a one-id selection still moves.
    const after = applyMoveDeltaToSelection(project(), ['s0'], 2, TOTAL_DURATION)
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
