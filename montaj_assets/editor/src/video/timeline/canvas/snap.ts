/**
 * Canvas timeline snapping (SP5 T5) — ONE magnetic model for every gesture.
 *
 * The DOM timeline snapped in three different ways: the Scrubber's playhead
 * drag used attract/release hysteresis (18px in, 28px out), while clip drags
 * and edge trims used a flat 8px "nearest boundary wins" test with no memory.
 * The flat version has the classic problem — right at the threshold the value
 * flickers between snapped and free as the hand jitters — and the two radii
 * disagreed about how strong a magnet feels. Plan decision 7 keeps the good one
 * and retires the others, in canvas mode only (the DOM paths are untouched).
 *
 * The hysteresis is what makes it feel deliberate: a point attracts from 18px,
 * but once caught it holds until the cursor is 28px away. The asymmetry is the
 * whole trick — with one radius, "just past the edge of the magnet" is an
 * unstable place to stand.
 *
 * Pixels, not seconds, are the unit of feel: a magnet must cover the same
 * distance on screen whether the timeline shows ten seconds or ten minutes, so
 * the radii convert through `pxPerSecond` on every call.
 *
 * Pure and stateless-by-value: `applySnap` takes a state and returns the next
 * one, so a gesture threads it and a test drives a whole approach/release
 * sequence without a component.
 */

import type { Viewport } from './viewport'

export interface SnapConfig {
  /** Distance at which an unsnapped gesture is captured. */
  attractPx: number
  /** Distance a captured gesture must travel to break free. Must exceed
   *  `attractPx`, or the magnet has no hysteresis at all. */
  releasePx: number
}

/** Scrubber.tsx's numbers, verbatim — the one implementation worth keeping. */
export const DEFAULT_SNAP_CONFIG: SnapConfig = { attractPx: 18, releasePx: 28 }

export interface SnapState {
  /** The point currently held, or null when the gesture is running free. */
  readonly snappedTo: number | null
}

const FREE: SnapState = { snappedTo: null }

export function createSnapState(): SnapState {
  return FREE
}

export interface SnapResult {
  /** The value to use: the snap point when caught, the candidate otherwise. */
  time: number
  snappedTo: number | null
  /** Thread this into the next call of the same gesture. */
  state: SnapState
}

/**
 * Magnetize `candidateT` to the nearest snap point, with hysteresis.
 *
 * Tie-break is **nearest wins**, ties going to the earlier entry — deliberately
 * unlike the Scrubber, which took the first point in array order that happened
 * to be within range and so gave different answers for different orderings of
 * the same boundary set. Nearest is what the flat implementations already did
 * and what a user means by "it snapped to the cut".
 *
 * Snapping is off entirely when the viewport has no scale yet (before first
 * layout), since pixel radii are meaningless without one.
 */
export function applySnap(
  candidateT: number,
  snapPoints: readonly number[],
  viewport: Viewport,
  state: SnapState = FREE,
  config: SnapConfig = DEFAULT_SNAP_CONFIG,
): SnapResult {
  const pxPerSecond = viewport.pxPerSecond
  if (!(pxPerSecond > 0) || snapPoints.length === 0) {
    return { time: candidateT, snappedTo: null, state: FREE }
  }

  const attract = config.attractPx / pxPerSecond
  const release = config.releasePx / pxPerSecond

  // Held: stay put until the cursor escapes the (wider) release radius.
  if (state.snappedTo !== null) {
    if (Math.abs(candidateT - state.snappedTo) < release) {
      return { time: state.snappedTo, snappedTo: state.snappedTo, state }
    }
    // Broken free. Fall through to a fresh scan — the point just released is
    // by definition beyond `release` > `attract`, so it cannot re-capture.
  }

  let best: number | null = null
  let bestDist = attract
  for (const point of snapPoints) {
    const dist = Math.abs(candidateT - point)
    if (dist < bestDist) {
      bestDist = dist
      best = point
    }
  }

  if (best === null) return { time: candidateT, snappedTo: null, state: FREE }
  return { time: best, snappedTo: best, state: { snappedTo: best } }
}

/**
 * Snap points for dragging a whole item of length `duration`, expressed as
 * candidate START positions: a point can catch the item's leading edge (start
 * lands on it) or its trailing edge (start lands one duration earlier). Feeding
 * these to `applySnap` with the raw start makes both edges magnetic through the
 * same code path — and, because the state is a start position rather than an
 * "edge + point" pair, hysteresis works across the pair for free.
 */
export function snapPointsForSpan(points: readonly number[], duration: number): number[] {
  const out: number[] = []
  for (const p of points) out.push(p)
  for (const p of points) out.push(p - duration)
  return out
}

const EPSILON = 1e-6

/**
 * Drop points that coincide with values the gesture is itself moving, and
 * de-duplicate the rest.
 *
 * Every item's own start and end are in the boundary set, so without this an
 * edge trim (or a clip drag) would be captured by the position it started from
 * and refuse to move until the cursor cleared the 28px release radius. The DOM
 * paths lived with it because an 8px flat magnet is easy to pull out of; at
 * these radii it reads as a stuck gesture.
 */
export function snapPointsExcluding(points: readonly number[], exclude: readonly number[]): number[] {
  const out: number[] = []
  for (const p of points) {
    if (!Number.isFinite(p)) continue
    if (exclude.some(e => Math.abs(p - e) <= EPSILON)) continue
    if (out.some(kept => Math.abs(kept - p) <= EPSILON)) continue
    out.push(p)
  }
  return out
}
