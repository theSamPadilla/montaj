import { describe, it, expect } from 'vitest'
import type { CaptionSegment, Captions } from '../../schema'
import {
  laneOf,
  maxCaptionLane,
  groupCaptionLanes,
  normalizeCaptionLanes,
  segmentsInLane,
  fitsInLane,
  sameLaneNeighbours,
  resolveDropLane,
} from '../captionLanes'

function seg(over: Partial<CaptionSegment> = {}): CaptionSegment {
  return { text: 'x', start: 0, end: 1, ...over }
}

function captions(segments: CaptionSegment[]): Captions {
  return { style: 'subtitle', segments }
}

describe('laneOf', () => {
  it('defaults an absent lane to 0', () => {
    expect(laneOf(seg())).toBe(0)
  })

  it('passes through a valid non-negative integer', () => {
    expect(laneOf(seg({ lane: 3 }))).toBe(3)
  })

  it('floors a negative lane at 0', () => {
    expect(laneOf(seg({ lane: -5 }))).toBe(0)
  })

  it('truncates a non-integer lane', () => {
    expect(laneOf(seg({ lane: 2.9 }))).toBe(2)
  })

  it('treats NaN/Infinity as absent', () => {
    expect(laneOf(seg({ lane: NaN }))).toBe(0)
    expect(laneOf(seg({ lane: Infinity }))).toBe(0)
    expect(laneOf(seg({ lane: -Infinity }))).toBe(0)
  })
})

describe('maxCaptionLane', () => {
  it('is 0 for an empty list', () => {
    expect(maxCaptionLane([])).toBe(0)
  })

  it('is 0 for an all-lane-less (legacy) track', () => {
    expect(maxCaptionLane([seg(), seg(), seg()])).toBe(0)
  })

  it('is the highest coerced lane present', () => {
    expect(maxCaptionLane([seg({ lane: 0 }), seg({ lane: 4 }), seg({ lane: 2 })])).toBe(4)
  })
})

describe('groupCaptionLanes', () => {
  it('puts a legacy all-lane-less track entirely in exactly one lane', () => {
    const groups = groupCaptionLanes([seg({ text: 'a' }), seg({ text: 'b' }), seg({ text: 'c' })])
    expect(groups).toHaveLength(1)
    expect(groups[0].lane).toBe(0)
    expect(groups[0].segments.map(s => s.text)).toEqual(['a', 'b', 'c'])
  })

  it('represents a hole between occupied lanes as an empty group', () => {
    const groups = groupCaptionLanes([seg({ lane: 0, text: 'bottom' }), seg({ lane: 3, text: 'top' })])
    expect(groups).toHaveLength(4)
    expect(groups.map(g => g.lane)).toEqual([0, 1, 2, 3])
    expect(groups[0].segments.map(s => s.text)).toEqual(['bottom'])
    expect(groups[1].segments).toEqual([])
    expect(groups[2].segments).toEqual([])
    expect(groups[3].segments.map(s => s.text)).toEqual(['top'])
  })
})

describe('segmentsInLane', () => {
  it('returns only the segments coerced to the given lane', () => {
    const a = seg({ lane: 0, text: 'a' })
    const b = seg({ lane: -9, text: 'b' }) // coerces to 0
    const c = seg({ lane: 1, text: 'c' })
    expect(segmentsInLane([a, b, c], 0).map(s => s.text)).toEqual(['a', 'b'])
    expect(segmentsInLane([a, b, c], 1).map(s => s.text)).toEqual(['c'])
    expect(segmentsInLane([a, b, c], 2)).toEqual([])
  })
})

describe('normalizeCaptionLanes', () => {
  it('passes undefined captions through unchanged', () => {
    expect(normalizeCaptionLanes(undefined)).toBeUndefined()
  })

  it('returns the SAME reference for empty captions', () => {
    const c = captions([])
    expect(normalizeCaptionLanes(c)).toBe(c)
  })

  it('returns the SAME reference when lanes are already dense from 0', () => {
    // Mix of absent (⇒ lane 0) and explicit values — both are already canonical.
    const c = captions([seg({ text: 'a' }), seg({ lane: 1, text: 'b' }), seg({ lane: 2, text: 'c' })])
    expect(normalizeCaptionLanes(c)).toBe(c)
  })

  it('collapses a hole (0, 3) down to dense (0, 1)', () => {
    const c = captions([seg({ lane: 0, text: 'bottom' }), seg({ lane: 3, text: 'top' })])
    const out = normalizeCaptionLanes(c)!
    expect(out).not.toBe(c)
    expect(out.segments.find(s => s.text === 'bottom')!.lane ?? 0).toBe(0)
    expect(out.segments.find(s => s.text === 'top')!.lane).toBe(1)
    expect(maxCaptionLane(out.segments)).toBe(1)
    // Fully dense now — a second pass changes nothing further.
    expect(normalizeCaptionLanes(out)).toBe(out)
  })

  it('normalizes sparse, negative, and non-integer lanes together to dense integers from 0', () => {
    const bottom = seg({ text: 'absent' })          // absent ⇒ 0
    const sparse = seg({ lane: 5, text: 'sparse' })   // sparse high lane
    const negative = seg({ lane: -3, text: 'negative' }) // coerces to 0, alongside `bottom`
    const fractional = seg({ lane: 2.7, text: 'fractional' }) // truncates to 2

    const out = normalizeCaptionLanes(captions([bottom, sparse, negative, fractional]))!
    const laneByText = Object.fromEntries(out.segments.map(s => [s.text, laneOf(s)]))

    // Present coerced lanes were {0, 5, 0, 2} → three distinct lanes, renumbered
    // in ascending order: 0→0, 2→1, 5→2.
    expect(laneByText).toEqual({ absent: 0, negative: 0, fractional: 1, sparse: 2 })
    expect(maxCaptionLane(out.segments)).toBe(2)

    // Idempotent: normalizing the already-normalized result is a true no-op.
    expect(normalizeCaptionLanes(out)).toBe(out)
  })
})

describe('fitsInLane', () => {
  const occupied = [seg({ id: 'a', lane: 0, start: 0, end: 5 }), seg({ id: 'b', lane: 0, start: 8, end: 10 })]

  it('fits in a free gap', () => {
    expect(fitsInLane(occupied, 'new', 0, 5, 8)).toBe(true)
  })

  it('does not fit when it overlaps an existing segment', () => {
    expect(fitsInLane(occupied, 'new', 0, 4, 6)).toBe(false)
  })

  it('touching edges are not a collision', () => {
    expect(fitsInLane(occupied, 'new', 0, 5, 8)).toBe(true) // butts both neighbors exactly
  })

  it('excludes the segment being placed from the collision check by id', () => {
    // 'a' checked against its own current window — must not collide with itself.
    expect(fitsInLane(occupied, 'a', 0, 0, 5)).toBe(true)
  })

  it('an empty lane always fits', () => {
    expect(fitsInLane(occupied, 'new', 7, 0, 100)).toBe(true)
  })
})

describe('sameLaneNeighbours', () => {
  it('finds the nearest prev/next in the same lane, ignoring other lanes', () => {
    const target = seg({ id: 'mid', lane: 0, start: 10, end: 12 })
    const segments = [
      seg({ id: 'far-prev', lane: 0, start: 0, end: 2 }),
      seg({ id: 'near-prev', lane: 0, start: 5, end: 8 }),
      seg({ id: 'other-lane', lane: 1, start: 8, end: 9 }),
      target,
      seg({ id: 'near-next', lane: 0, start: 14, end: 16 }),
      seg({ id: 'far-next', lane: 0, start: 20, end: 22 }),
    ]
    const { prev, next } = sameLaneNeighbours(segments, target)
    expect(prev?.id).toBe('near-prev')
    expect(next?.id).toBe('near-next')
  })

  it('returns nulls when alone in its lane', () => {
    const target = seg({ id: 'solo', lane: 2, start: 0, end: 1 })
    const { prev, next } = sameLaneNeighbours([target], target)
    expect(prev).toBeNull()
    expect(next).toBeNull()
  })
})

describe('resolveDropLane', () => {
  it('lands directly on the wanted lane when it is free', () => {
    const dragged = seg({ id: 'd', lane: 0, start: 0, end: 2 })
    // A filler segment in lane 3 (elsewhere in time) just establishes maxLane
    // so the clamp doesn't itself cap `wanted` below 2 in this fixture.
    const filler = seg({ id: 'filler', lane: 3, start: 20, end: 22 })
    const lane = resolveDropLane({
      segments: [dragged, filler], seg: dragged, sourceLane: 0, laneDelta: -2, start: 0, end: 2,
    })
    expect(lane).toBe(2) // upward drag: sourceLane(0) - laneDelta(-2) = 2
  })

  it('a downward drag lowers the lane number (sign convention)', () => {
    const seg1 = seg({ id: 'd', lane: 3, start: 0, end: 2 })
    const lane = resolveDropLane({
      segments: [seg1], seg: seg1, sourceLane: 3, laneDelta: 2, start: 0, end: 2,
    })
    expect(lane).toBe(1)
  })

  it('floors the wanted lane at 0 — never goes negative', () => {
    const seg1 = seg({ id: 'd', lane: 1, start: 0, end: 2 })
    const lane = resolveDropLane({
      segments: [seg1], seg: seg1, sourceLane: 1, laneDelta: 10, start: 0, end: 2,
    })
    expect(lane).toBe(0)
  })

  it('fans out in order wanted, wanted-1, wanted+1: prefers wanted-1 when both are free', () => {
    // wanted = 2 is occupied by a colliding segment; lanes 1 and 3 are both
    // free at the drop window — order must pick 1 (wanted-1) over 3 (wanted+1).
    const dragged = seg({ id: 'd', lane: 2, start: 0, end: 2 })
    const blocker = seg({ id: 'blocker', lane: 2, start: 0, end: 2 })
    const lane = resolveDropLane({
      segments: [dragged, blocker], seg: dragged, sourceLane: 2, laneDelta: 0, start: 0, end: 2,
    })
    expect(lane).toBe(1)
  })

  it('falls through to wanted+1 when wanted-1 is also occupied', () => {
    const dragged = seg({ id: 'd', lane: 2, start: 0, end: 2 })
    const blockAt2 = seg({ id: 'b2', lane: 2, start: 0, end: 2 })
    const blockAt1 = seg({ id: 'b1', lane: 1, start: 0, end: 2 })
    const lane = resolveDropLane({
      segments: [dragged, blockAt2, blockAt1], seg: dragged, sourceLane: 2, laneDelta: 0, start: 0, end: 2,
    })
    expect(lane).toBe(3)
  })

  it('mints the maxLane+1 lane when every existing lane collides', () => {
    // Lanes 0, 1, 2 all carry a colliding segment at the drop window — the
    // dragged segment (currently in an unrelated, non-colliding position)
    // must land in the freshly minted lane 3.
    const dragged = seg({ id: 'd', lane: 0, start: 50, end: 52 }) // elsewhere in time, doesn't block itself
    const segments = [
      dragged,
      seg({ id: 'b0', lane: 0, start: 0, end: 2 }),
      seg({ id: 'b1', lane: 1, start: 0, end: 2 }),
      seg({ id: 'b2', lane: 2, start: 0, end: 2 }),
    ]
    const lane = resolveDropLane({
      segments, seg: dragged, sourceLane: 0, laneDelta: 0, start: 0, end: 2,
    })
    expect(lane).toBe(3) // maxLane(2) + 1
  })

  it('always terminates with an in-range lane even with many fully-occupied lanes', () => {
    const dragged = seg({ id: 'd', lane: 0, start: 100, end: 102 })
    const blockers = Array.from({ length: 30 }, (_, i) => seg({ id: `b${i}`, lane: i, start: 0, end: 2 }))
    const segments = [dragged, ...blockers]
    const lane = resolveDropLane({
      segments, seg: dragged, sourceLane: 15, laneDelta: 0, start: 0, end: 2,
    })
    expect(lane).toBe(30) // maxLane(29) + 1, guaranteed empty
    expect(Number.isInteger(lane)).toBe(true)
    expect(lane).toBeGreaterThanOrEqual(0)
  })
})
