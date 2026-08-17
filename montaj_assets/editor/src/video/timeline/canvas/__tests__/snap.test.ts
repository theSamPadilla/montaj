/// <reference types="vitest/globals" />
/**
 * SP5 T5 — the one snapping model. At 100px/second the default radii convert to
 * round numbers, which is what makes the hysteresis assertions readable:
 *
 *   attract 18px → 0.18s     release 28px → 0.28s
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SNAP_CONFIG,
  applySnap,
  createSnapState,
  snapPointsExcluding,
  snapPointsForSpan,
} from '../snap'
import type { Viewport } from '../viewport'

const VIEWPORT: Viewport = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }
const POINTS = [5]

describe('applySnap — attraction', () => {
  it('captures a candidate inside the attract radius', () => {
    const result = applySnap(5.1, POINTS, VIEWPORT, createSnapState())
    expect(result.time).toBe(5)
    expect(result.snappedTo).toBe(5)
  })

  it('leaves a candidate outside the attract radius alone', () => {
    const result = applySnap(5.2, POINTS, VIEWPORT, createSnapState())
    expect(result.time).toBe(5.2)
    expect(result.snappedTo).toBeNull()
    expect(result.state.snappedTo).toBeNull()
  })

  it('brackets the attract radius', () => {
    expect(applySnap(5.181, POINTS, VIEWPORT, createSnapState()).snappedTo).toBeNull()
    expect(applySnap(5.179, POINTS, VIEWPORT, createSnapState()).snappedTo).toBe(5)
  })

  it('attracts from either side', () => {
    expect(applySnap(4.9, POINTS, VIEWPORT, createSnapState()).time).toBe(5)
  })
})

describe('applySnap — hysteresis', () => {
  it('holds a captured point until the release radius is cleared', () => {
    let state = createSnapState()

    // Approach and stick.
    let result = applySnap(5.15, POINTS, VIEWPORT, state)
    expect(result.time).toBe(5)
    state = result.state

    // Pull past the ATTRACT radius — still held, because release is wider.
    result = applySnap(5.25, POINTS, VIEWPORT, state)
    expect(result.time).toBe(5)
    expect(result.snappedTo).toBe(5)
    state = result.state

    // Just short of release — still held.
    result = applySnap(5.279, POINTS, VIEWPORT, state)
    expect(result.time).toBe(5)
    state = result.state

    // Past release — free, and reporting the true candidate.
    result = applySnap(5.28, POINTS, VIEWPORT, state)
    expect(result.time).toBe(5.28)
    expect(result.snappedTo).toBeNull()
    state = result.state

    // Coming back inside attract re-captures.
    expect(applySnap(5.1, POINTS, VIEWPORT, state).time).toBe(5)
  })

  it('cannot immediately re-capture the point it just released', () => {
    const held = applySnap(5.05, POINTS, VIEWPORT, createSnapState()).state
    const released = applySnap(5.3, POINTS, VIEWPORT, held)
    expect(released.time).toBe(5.3)
    expect(released.snappedTo).toBeNull()
  })

  it('hands off to a different point when the escape lands near one', () => {
    const points = [5, 5.35]
    const held = applySnap(5.02, points, VIEWPORT, createSnapState()).state
    const moved = applySnap(5.3, points, VIEWPORT, held)
    // 0.30 from the held point clears release (0.28); 0.05 from the neighbour
    // is well inside attract.
    expect(moved.time).toBe(5.35)
    expect(moved.snappedTo).toBe(5.35)
  })
})

describe('applySnap — multiple candidates', () => {
  it('takes the nearest point, not the first in range', () => {
    expect(applySnap(5, [4.9, 5.05], VIEWPORT, createSnapState()).time).toBe(5.05)
    expect(applySnap(5, [5.05, 4.9], VIEWPORT, createSnapState()).time).toBe(5.05)
  })

  it('breaks an exact tie in favour of the earlier entry', () => {
    expect(applySnap(5, [4.9, 5.1], VIEWPORT, createSnapState()).time).toBe(4.9)
    expect(applySnap(5, [5.1, 4.9], VIEWPORT, createSnapState()).time).toBe(5.1)
  })

  it('ignores points outside the radius entirely', () => {
    expect(applySnap(5, [1, 9], VIEWPORT, createSnapState()).snappedTo).toBeNull()
  })
})

describe('applySnap — configuration and degenerate viewports', () => {
  it('ships the Scrubber radii as defaults', () => {
    expect(DEFAULT_SNAP_CONFIG).toEqual({ attractPx: 18, releasePx: 28 })
  })

  it('honours a config override', () => {
    const tight = { attractPx: 4, releasePx: 6 }
    // 0.03s is 3px — inside a 4px magnet, but well inside the default 18px one.
    expect(applySnap(5.03, POINTS, VIEWPORT, createSnapState(), tight).time).toBe(5)
    expect(applySnap(5.1, POINTS, VIEWPORT, createSnapState(), tight).snappedTo).toBeNull()
    expect(applySnap(5.1, POINTS, VIEWPORT, createSnapState()).snappedTo).toBe(5)
    // …and the tighter release lets go sooner.
    const held = applySnap(5.03, POINTS, VIEWPORT, createSnapState(), tight).state
    expect(applySnap(5.07, POINTS, VIEWPORT, held, tight).snappedTo).toBeNull()
  })

  it('scales the radii with zoom, so the magnet is the same size on screen', () => {
    const zoomedIn: Viewport = { ...VIEWPORT, pxPerSecond: 1000 }
    // 0.1s is 100px out at this scale — far outside the magnet.
    expect(applySnap(5.1, POINTS, zoomedIn, createSnapState()).snappedTo).toBeNull()
    // 0.01s is 10px — inside it.
    expect(applySnap(5.01, POINTS, zoomedIn, createSnapState()).time).toBe(5)
  })

  it('does not snap before the surface has a scale', () => {
    const unscaled: Viewport = { pxPerSecond: 0, scrollSeconds: 0, widthPx: 0 }
    const result = applySnap(5.0001, POINTS, unscaled, createSnapState())
    expect(result.time).toBe(5.0001)
    expect(result.snappedTo).toBeNull()
  })

  it('does not snap when there are no points', () => {
    expect(applySnap(5, [], VIEWPORT, createSnapState()).time).toBe(5)
  })

  it('defaults to a free state when none is threaded', () => {
    expect(applySnap(5.1, POINTS, VIEWPORT).time).toBe(5)
    expect(createSnapState().snappedTo).toBeNull()
  })
})

describe('snapPointsForSpan', () => {
  it('offers each point to both edges of the span', () => {
    expect(snapPointsForSpan([2, 8], 3)).toEqual([2, 8, -1, 5])
  })

  it('lets a moving item catch a boundary by its trailing edge', () => {
    // A 3s item whose end should land on t=8 must start at t=5.
    const points = snapPointsForSpan([8], 3)
    expect(applySnap(5.1, points, VIEWPORT, createSnapState()).time).toBe(5)
  })
})

describe('snapPointsExcluding', () => {
  it('drops the values the gesture is itself moving', () => {
    expect(snapPointsExcluding([0, 2, 5, 10], [2, 5])).toEqual([0, 10])
  })

  it('de-duplicates and drops non-finite entries', () => {
    expect(snapPointsExcluding([3, 3, Infinity, NaN, 7], [])).toEqual([3, 7])
  })

  it('matches within a float epsilon, so recomputed times still cancel', () => {
    expect(snapPointsExcluding([0.1 + 0.2], [0.3])).toEqual([])
  })

  it('keeps everything when nothing is excluded', () => {
    expect(snapPointsExcluding([1, 2], [])).toEqual([1, 2])
  })
})
