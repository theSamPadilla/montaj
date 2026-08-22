/// <reference types="vitest/globals" />
/**
 * SP5 T5 — the one snapping model. At 100px/second the default radii convert to
 * round numbers, which is what makes the hysteresis assertions readable:
 *
 *   attract 20px → 0.20s     release 44px → 0.44s
 *
 * The gap between them is the feature, not an implementation detail: a magnet
 * you can leave as easily as you entered it reads as the timeline refusing to
 * go where you put it. Several assertions below exist purely to pin that gap,
 * so widening or narrowing it is always a deliberate edit.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SNAP_CONFIG,
  applySnap,
  createSnapState,
  snapPointsExcluding,
  snapPointsForSpan,
  type SnapPoint,
} from '../snap'
import type { Viewport } from '../viewport'

const VIEWPORT: Viewport = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }

/** Same-track boundaries — the full-strength magnet. */
const strong = (...times: number[]): SnapPoint[] => times.map(time => ({ time, strength: 'strong' }))
/** Boundaries on some other row: 6px in, 10px out. */
const weak = (...times: number[]): SnapPoint[] => times.map(time => ({ time, strength: 'weak' }))

const POINTS = strong(5)

describe('applySnap — attraction', () => {
  it('captures a candidate inside the attract radius', () => {
    const result = applySnap(5.1, POINTS, VIEWPORT, createSnapState())
    expect(result.time).toBe(5)
    expect(result.snappedTo).toBe(5)
  })

  it('leaves a candidate outside the attract radius alone', () => {
    const result = applySnap(5.25, POINTS, VIEWPORT, createSnapState())
    expect(result.time).toBe(5.25)
    expect(result.snappedTo).toBeNull()
    expect(result.state.snappedTo).toBeNull()
  })

  it('brackets the attract radius', () => {
    expect(applySnap(5.201, POINTS, VIEWPORT, createSnapState()).snappedTo).toBeNull()
    expect(applySnap(5.199, POINTS, VIEWPORT, createSnapState()).snappedTo).toBe(5)
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
    result = applySnap(5.439, POINTS, VIEWPORT, state)
    expect(result.time).toBe(5)
    state = result.state

    // Past release — free, and reporting the true candidate.
    result = applySnap(5.44, POINTS, VIEWPORT, state)
    expect(result.time).toBe(5.44)
    expect(result.snappedTo).toBeNull()
    state = result.state

    // Coming back inside attract re-captures.
    expect(applySnap(5.1, POINTS, VIEWPORT, state).time).toBe(5)
  })

  it('cannot immediately re-capture the point it just released', () => {
    const held = applySnap(5.05, POINTS, VIEWPORT, createSnapState()).state
    const released = applySnap(5.5, POINTS, VIEWPORT, held)
    expect(released.time).toBe(5.5)
    expect(released.snappedTo).toBeNull()
  })

  it('hands off to a different point when the escape lands near one', () => {
    const points = strong(5, 5.6)
    const held = applySnap(5.02, points, VIEWPORT, createSnapState()).state
    const moved = applySnap(5.5, points, VIEWPORT, held)
    // 0.50 from the held point clears release (0.44); 0.10 from the neighbour
    // is well inside attract.
    expect(moved.time).toBe(5.6)
    expect(moved.snappedTo).toBe(5.6)
  })
})

describe('applySnap — strength tiers', () => {
  it('reports which tier caught the gesture', () => {
    expect(applySnap(5.1, strong(5), VIEWPORT, createSnapState()).strength).toBe('strong')
    expect(applySnap(5.03, weak(5), VIEWPORT, createSnapState()).strength).toBe('weak')
    expect(applySnap(9, strong(5), VIEWPORT, createSnapState()).strength).toBeNull()
  })

  it('ignores a cross-track boundary that a same-track one would have caught', () => {
    // 0.1s is 10px: inside the 20px strong radius, well outside the 6px weak
    // one. This is the whole point of the split — an overlay row full of cuts
    // must not grab a clip being dragged on the row below.
    expect(applySnap(5.1, strong(5), VIEWPORT, createSnapState()).snappedTo).toBe(5)
    expect(applySnap(5.1, weak(5), VIEWPORT, createSnapState()).snappedTo).toBeNull()
  })

  it('lets a strong point beat a NEARER weak one', () => {
    // Nearest-wins holds within a tier, never across it: the same-track cut at
    // 0.15s out takes it, not the overlay edge 0.02s away.
    const points = [...weak(5.02), ...strong(5.15)]
    const result = applySnap(5, points, VIEWPORT, createSnapState())
    expect(result.snappedTo).toBe(5.15)
    expect(result.strength).toBe('strong')
  })

  it('falls back to a weak point when no strong one is in range', () => {
    const points = [...weak(5.02), ...strong(9)]
    expect(applySnap(5, points, VIEWPORT, createSnapState()).snappedTo).toBe(5.02)
  })

  it('lets a weak capture go on weak terms — 10px, not 44', () => {
    // A subtle magnet has to be subtle to LEAVE as well as to enter, or it is
    // just a strong magnet that was hard to trigger.
    const held = applySnap(5.02, weak(5), VIEWPORT, createSnapState()).state
    expect(applySnap(5.09, weak(5), VIEWPORT, held).snappedTo).toBe(5)
    expect(applySnap(5.11, weak(5), VIEWPORT, held).snappedTo).toBeNull()

    // The same distance would not have shaken off a strong one.
    const heldStrong = applySnap(5.02, strong(5), VIEWPORT, createSnapState()).state
    expect(applySnap(5.11, strong(5), VIEWPORT, heldStrong).snappedTo).toBe(5)
  })
})

describe('applySnap — multiple candidates', () => {
  it('takes the nearest point, not the first in range', () => {
    expect(applySnap(5, strong(4.9, 5.05), VIEWPORT, createSnapState()).time).toBe(5.05)
    expect(applySnap(5, strong(5.05, 4.9), VIEWPORT, createSnapState()).time).toBe(5.05)
  })

  it('breaks an exact tie in favour of the earlier entry', () => {
    expect(applySnap(5, strong(4.9, 5.1), VIEWPORT, createSnapState()).time).toBe(4.9)
    expect(applySnap(5, strong(5.1, 4.9), VIEWPORT, createSnapState()).time).toBe(5.1)
  })

  it('ignores points outside the radius entirely', () => {
    expect(applySnap(5, strong(1, 9), VIEWPORT, createSnapState()).snappedTo).toBeNull()
  })
})

describe('applySnap — configuration and degenerate viewports', () => {
  it('ships radii whose release is more than double its attract', () => {
    expect(DEFAULT_SNAP_CONFIG).toEqual({ attractPx: 20, releasePx: 44, weakAttractPx: 6, weakReleasePx: 10 })
    // The detent. Pinned as a ratio as well as absolutes so a future tweak to
    // either number has to keep the asymmetry that makes the magnet hold.
    expect(DEFAULT_SNAP_CONFIG.releasePx).toBeGreaterThan(DEFAULT_SNAP_CONFIG.attractPx * 2)
  })

  it('holds well past the distance that captured it', () => {
    // The user-facing promise: sliding a clip a little way past a cut does not
    // shake it off. 0.3s is 30px — half again the attract radius — and the
    // gesture is still pinned to the boundary.
    const held = applySnap(5.05, POINTS, VIEWPORT, createSnapState()).state
    expect(applySnap(5.3, POINTS, VIEWPORT, held).snappedTo).toBe(5)
  })

  it('honours a config override', () => {
    const tight = { attractPx: 4, releasePx: 6, weakAttractPx: 2, weakReleasePx: 3 }
    // 0.03s is 3px — inside a 4px magnet, and well inside the default 20px one.
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
    expect(snapPointsForSpan(strong(2, 8), 3)).toEqual(strong(2, 8, -1, 5))
  })

  it('carries each point\'s strength onto its trailing-edge twin', () => {
    // Otherwise a cross-track boundary would pull weakly on a clip's head and
    // at full strength on its tail, which is indefensible either way round.
    expect(snapPointsForSpan(weak(8), 3)).toEqual(weak(8, 5))
  })

  it('lets a moving item catch a boundary by its trailing edge', () => {
    // A 3s item whose end should land on t=8 must start at t=5.
    const points = snapPointsForSpan(strong(8), 3)
    expect(applySnap(5.1, points, VIEWPORT, createSnapState()).time).toBe(5)
  })
})

describe('snapPointsExcluding', () => {
  it('drops the values the gesture is itself moving', () => {
    expect(snapPointsExcluding(strong(0, 2, 5, 10), [2, 5])).toEqual(strong(0, 10))
  })

  it('de-duplicates and drops non-finite entries', () => {
    expect(snapPointsExcluding(strong(3, 3, Infinity, NaN, 7), [])).toEqual(strong(3, 7))
  })

  it('upgrades a duplicate to strong, whichever order the rows arrived in', () => {
    // A cut on this track that happens to line up with one two rows up is a
    // same-track boundary. Losing that to a weak twin would silently punch a
    // hole in the strong tier.
    expect(snapPointsExcluding([...weak(4), ...strong(4)], [])).toEqual(strong(4))
    expect(snapPointsExcluding([...strong(4), ...weak(4)], [])).toEqual(strong(4))
  })

  it('matches within a float epsilon, so recomputed times still cancel', () => {
    expect(snapPointsExcluding(strong(0.1 + 0.2), [0.3])).toEqual([])
  })

  it('keeps everything when nothing is excluded', () => {
    expect(snapPointsExcluding(strong(1, 2), [])).toEqual(strong(1, 2))
  })
})
