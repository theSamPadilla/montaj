/// <reference types="vitest/globals" />
/**
 * The span/window invariant, which is the contract every renderer downstream
 * relies on:
 *
 *     outPoint − inPoint === (end − start) · speed
 *
 * Break it and nothing errors — the clip just quietly starts lying. The
 * filmstrip walks the source at its own rate and freezes on the last frame it
 * can find; the waveform windows to inPoint..outPoint and stretches that
 * across the clip; the preview and the export each pick one. One clip, four
 * different stories, no warning anywhere.
 *
 * It broke because the timeline edge and the source window used to be clamped
 * INDEPENDENTLY, so whichever limit bit first left the other free to keep
 * going. These tests drive the edge past every limit there is and assert the
 * invariant survives each one.
 */
import { describe, it, expect } from 'vitest'
import { computeResizedItem, resizeWindowedItem, type Draggable } from '../useItemDragDrop'

function clip(over: Partial<Draggable> = {}): Draggable {
  return { id: 'c', type: 'video', start: 5, end: 10, inPoint: 2, outPoint: 7, sourceDuration: 20, ...over }
}

/** outPoint − inPoint, which must equal (end − start) · speed. */
function windowOf(i: Draggable): number {
  return (i.outPoint ?? 0) - (i.inPoint ?? 0)
}
function spanOf(i: Draggable): number {
  return i.end - i.start
}
function expectCoherent(i: Draggable) {
  expect(windowOf(i)).toBeCloseTo(spanOf(i) * (i.speed ?? 1), 6)
}

describe('resizeWindowedItem — the span/window invariant', () => {
  it('holds when the in edge is dragged past the head of the media', () => {
    // THE BUG. inPoint is already 0, so there is no source left to reveal —
    // but `start` used to slide left anyway, inventing 3s of timeline with no
    // footage behind it.
    const r = resizeWindowedItem(clip({ inPoint: 0, outPoint: 5 }), 'start', 2)
    expectCoherent(r)
    expect(r.start).toBe(5)      // pinned at the media's head
    expect(r.inPoint).toBe(0)
  })

  it('holds when the out edge is dragged past the tail of the media', () => {
    // The mirror image: outPoint already at sourceDuration.
    const r = resizeWindowedItem(clip({ inPoint: 15, outPoint: 20, start: 0, end: 5 }), 'end', 9)
    expectCoherent(r)
    expect(r.end).toBe(5)
    expect(r.outPoint).toBe(20)
  })

  it('lets the edge travel exactly as far as there is source, and no further', () => {
    // 2s of source ahead of inPoint, so the edge stops 2s earlier.
    const r = resizeWindowedItem(clip(), 'start', -100)
    expect(r.start).toBeCloseTo(3)
    expect(r.inPoint).toBeCloseTo(0)
    expectCoherent(r)
  })

  it('holds for an ordinary trim well inside the media', () => {
    const inward = resizeWindowedItem(clip(), 'start', 6)
    expect(inward.start).toBe(6)
    expect(inward.inPoint).toBeCloseTo(3)
    expectCoherent(inward)

    const outward = resizeWindowedItem(clip(), 'end', 12)
    expect(outward.end).toBe(12)
    expect(outward.outPoint).toBeCloseTo(9)
    expectCoherent(outward)
  })

  it('holds at the minimum-duration floor, from either edge', () => {
    expectCoherent(resizeWindowedItem(clip(), 'start', 999))
    expectCoherent(resizeWindowedItem(clip(), 'end', -999))
  })

  it('leaves the tail unbounded when the media length is unknown', () => {
    // No sourceDuration means no known end to run past, so the edge keeps the
    // benefit of the doubt rather than being pinned at its current position.
    const r = resizeWindowedItem(clip({ sourceDuration: undefined }), 'end', 40)
    expect(r.end).toBe(40)
    expectCoherent(r)
  })

  it('writes BOTH window bounds, including the edge it did not move', () => {
    // An implicit half of the window is what made this invisible: you cannot
    // check the invariant against a field that isn't there.
    const r = resizeWindowedItem({ id: 'a', start: 1, end: 6 } as Draggable, 'end', 7)
    expect(r.inPoint).toBe(0)
    expect(r.outPoint).toBeCloseTo(6)
    expectCoherent(r)
  })

  // ── Per-clip speed ──

  it('consumes source at the clip\'s speed, not 1:1', () => {
    const fast = resizeWindowedItem(clip({ speed: 2, outPoint: 12 }), 'end', 12)
    // 2 extra timeline seconds at 2x is 4 extra source seconds.
    expect(fast.outPoint).toBeCloseTo(16)
    expectCoherent(fast)

    const slow = resizeWindowedItem(clip({ speed: 0.5, outPoint: 4.5 }), 'end', 12)
    expect(slow.outPoint).toBeCloseTo(5.5)
    expectCoherent(slow)
  })

  it('measures the media limit in timeline seconds, which speed scales', () => {
    // 2s of source ahead of inPoint at 0.5x is FOUR seconds of timeline.
    const r = resizeWindowedItem(clip({ speed: 0.5, outPoint: 4.5 }), 'start', -100)
    expect(r.start).toBeCloseTo(1)
    expect(r.inPoint).toBeCloseTo(0)
    expectCoherent(r)
  })

  it('shrugs off a project carrying a nonsense speed', () => {
    for (const speed of [0, -1, NaN, Infinity]) {
      const r = resizeWindowedItem(clip({ speed }), 'end', 12)
      expect(Number.isFinite(r.end)).toBe(true)
      expect(Number.isFinite(r.outPoint ?? 0)).toBe(true)
    }
  })
})

describe('computeResizedItem — the non-video branch', () => {
  it('moves an overlay\'s edge without inventing a source window', () => {
    const overlay = { id: 'o', type: 'overlay', start: 2, end: 4 } as Draggable
    expect(computeResizedItem(overlay, 'end', 9)).toMatchObject({ start: 2, end: 9 })
    expect(computeResizedItem(overlay, 'end', 9).outPoint).toBeUndefined()
  })

  it('still enforces the minimum duration on both edges', () => {
    const overlay = { id: 'o', type: 'overlay', start: 2, end: 4 } as Draggable
    expect(computeResizedItem(overlay, 'start', 99).start).toBeCloseTo(3.9)
    expect(computeResizedItem(overlay, 'end', -99).end).toBeCloseTo(2.1)
  })
})
