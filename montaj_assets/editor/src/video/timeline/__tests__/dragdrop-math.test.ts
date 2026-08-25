/// <reference types="vitest/globals" />
/**
 * SP5 T5 — the drag/resize arithmetic extracted out of `useItemDragDrop` so the
 * canvas pointer machine can reuse it instead of reimplementing trims.
 *
 * The hook's own suite (`useItemDragDrop.test.ts`), which drove the DOM shell,
 * is retired along with that shell — this file is now the only coverage for
 * this arithmetic, including the cases the shell couldn't easily reach
 * (source-media clamps, tie-breaks).
 */
import { describe, it, expect } from 'vitest'
import {
  DRAG_THRESHOLD_PX,
  computeResizedItem,
  snapMovedSpan,
  snapToBoundaries,
  type Draggable,
} from '../useItemDragDrop'

describe('DRAG_THRESHOLD_PX', () => {
  it('is the value both surfaces use to tell a click from a drag', () => {
    expect(DRAG_THRESHOLD_PX).toBe(4)
  })
})

describe('snapToBoundaries', () => {
  it('takes the nearest boundary inside the threshold', () => {
    expect(snapToBoundaries(5.1, [3, 5, 8], 0.5)).toBe(5)
  })

  it('leaves a value with nothing in range alone', () => {
    expect(snapToBoundaries(5.1, [3, 8], 0.5)).toBe(5.1)
  })

  it('prefers the nearer of two candidates', () => {
    expect(snapToBoundaries(5, [4.6, 5.2], 1)).toBe(5.2)
  })

  it('keeps the earlier entry on an exact tie', () => {
    expect(snapToBoundaries(5, [4.5, 5.5], 1)).toBe(4.5)
  })

  it('does not snap at exactly the threshold', () => {
    expect(snapToBoundaries(5.5, [5], 0.5)).toBe(5.5)
  })

  it('is a no-op with no boundaries or a zero threshold', () => {
    expect(snapToBoundaries(5.1, [], 0.5)).toBe(5.1)
    expect(snapToBoundaries(5.1, [5], 0)).toBe(5.1)
  })
})

describe('snapMovedSpan', () => {
  it('snaps the leading edge to a boundary', () => {
    expect(snapMovedSpan(4.9, 2, [5], 0.5)).toEqual({ start: 5, end: 7 })
  })

  it('snaps the trailing edge to a boundary', () => {
    expect(snapMovedSpan(2.9, 2, [5], 0.5)).toEqual({ start: 3, end: 5 })
  })

  it('picks whichever edge is closer', () => {
    // start 4.8 is 0.2 from 5; end 6.8 is 0.8 from 6 — the start edge wins.
    expect(snapMovedSpan(4.8, 2, [5, 6], 1)).toEqual({ start: 5, end: 7 })
  })

  it('resolves an exact tie in favour of the start edge', () => {
    // Both edges are 0.5 away from their nearest boundary.
    expect(snapMovedSpan(4.5, 2, [4, 7], 1)).toEqual({ start: 4, end: 6 })
  })

  it('returns the raw span when nothing is in range', () => {
    expect(snapMovedSpan(4.9, 2, [1, 9], 0.05)).toEqual({ start: 4.9, end: 6.9 })
  })
})

describe('computeResizedItem — non-video items', () => {
  const overlay: Draggable = { id: 'o', type: 'overlay', start: 2, end: 6 }

  it('moves the start edge only', () => {
    expect(computeResizedItem(overlay, 'start', 3)).toEqual({ ...overlay, start: 3 })
  })

  it('moves the end edge only', () => {
    expect(computeResizedItem(overlay, 'end', 5)).toEqual({ ...overlay, end: 5 })
  })

  it('keeps at least 0.1s from either edge', () => {
    expect(computeResizedItem(overlay, 'start', 99).start).toBeCloseTo(5.9)
    expect(computeResizedItem(overlay, 'end', -99).end).toBeCloseTo(2.1)
  })
})

describe('computeResizedItem — video clips', () => {
  const clip: Draggable = { id: 'c', type: 'video', start: 10, end: 20, inPoint: 5, outPoint: 15, sourceDuration: 30 }

  it('walks the inPoint with the start edge', () => {
    const trimmed = computeResizedItem(clip, 'start', 12)
    expect(trimmed.start).toBe(12)
    expect(trimmed.inPoint).toBeCloseTo(7)
    expect(trimmed.outPoint).toBe(15)
  })

  it('walks the outPoint with the end edge', () => {
    const trimmed = computeResizedItem(clip, 'end', 18)
    expect(trimmed.end).toBe(18)
    expect(trimmed.outPoint).toBeCloseTo(13)
    expect(trimmed.inPoint).toBe(5)
  })

  it('never pulls the inPoint before the start of the source', () => {
    expect(computeResizedItem(clip, 'start', -99).inPoint).toBe(0)
  })

  it('never pushes the outPoint past the end of the source', () => {
    expect(computeResizedItem(clip, 'end', 999).outPoint).toBe(30)
  })

  it('keeps the source window at least 0.1s wide', () => {
    expect(computeResizedItem(clip, 'start', 19.99).inPoint).toBeCloseTo(14.9)
    expect(computeResizedItem(clip, 'end', 10.01).outPoint).toBeCloseTo(5.1)
  })

  it('treats a missing source window as starting at zero', () => {
    const bare: Draggable = { id: 'b', type: 'video', start: 0, end: 4 }
    const trimmed = computeResizedItem(bare, 'end', 3)
    expect(trimmed.end).toBe(3)
    expect(trimmed.outPoint).toBeCloseTo(3)
  })

  it('lets an unbounded source extend freely', () => {
    const unbounded: Draggable = { id: 'u', type: 'video', start: 0, end: 4, inPoint: 0, outPoint: 4 }
    expect(computeResizedItem(unbounded, 'end', 100).outPoint).toBe(100)
  })
})
