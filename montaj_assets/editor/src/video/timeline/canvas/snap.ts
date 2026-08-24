/**
 * Canvas timeline snapping (SP5 T5) — ONE magnetic model for every gesture.
 *
 * The DOM timeline snapped in three different ways: the Scrubber's playhead
 * drag used attract/release hysteresis (18px in, 28px out), while clip drags
 * and edge trims used a flat 8px "nearest boundary wins" test with no memory.
 * The flat version has the classic problem — right at the threshold the value
 * flickers between snapped and free as the hand jitters — and the two radii
 * disagreed about how strong a magnet feels. Plan decision 7 keeps the good one
 * and retires the others. (It once applied to the canvas surface only, while
 * the DOM rows kept the flat test; those rows are gone, so this is simply how
 * snapping works.)
 *
 * The hysteresis is what makes it feel deliberate: a point attracts from one
 * radius but holds until the cursor clears a wider one. The asymmetry is the
 * whole trick — with one radius, "just past the edge of the magnet" is an
 * unstable place to stand. See `DEFAULT_SNAP_CONFIG` for the two numbers and
 * why they are as far apart as they are.
 *
 * Pixels, not seconds, are the unit of feel: a magnet must cover the same
 * distance on screen whether the timeline shows ten seconds or ten minutes, so
 * the radii convert through `pxPerSecond` on every call.
 *
 * Points come in two strengths. A boundary on the gesture's own track pulls
 * hard; a boundary on some other track barely pulls at all, and loses to a
 * same-track point outright when both are in range. Without that split, one
 * busy overlay row is enough to make the base video track undraggable — see
 * `SnapStrength`.
 *
 * Pure and stateless-by-value: `applySnap` takes a state and returns the next
 * one, so a gesture threads it and a test drives a whole approach/release
 * sequence without a component.
 */

import type { Viewport } from './viewport'

/**
 * How hard a given snap point pulls.
 *
 * `strong` is a boundary on the gesture's OWN track — the next clip along, the
 * cut you are butting up against. That is the alignment an editor actually
 * means, and it gets the full magnet.
 *
 * `weak` is everything on some other track: an overlay two rows up, an audio
 * bar below. Those alignments are occasionally useful and constantly in the
 * way — a busy overlay track puts a boundary every few pixels, and at full
 * strength they turn a simple drag into a fight. They keep a radius small
 * enough to catch a deliberate aim and too small to catch a passing one.
 */
export type SnapStrength = 'strong' | 'weak'

export interface SnapPoint {
  time: number
  strength: SnapStrength
}

export interface SnapConfig {
  /** Distance at which an unsnapped gesture is captured by a strong point. */
  attractPx: number
  /** Distance a captured strong point must travel to break free. Must exceed
   *  `attractPx`, or the magnet has no hysteresis at all. */
  releasePx: number
  /** The same pair for weak points. */
  weakAttractPx: number
  weakReleasePx: number
}

/**
 * The magnet's strength.
 *
 * These started as Scrubber.tsx's numbers (18/28) and were widened after using
 * the canvas timeline in anger. Two separate complaints, one fix each:
 *
 * - `attractPx` 18 → 20. A cut you are aiming at should catch you slightly
 *   before you land on it, so the common case (butt this clip against that
 *   one) needs no precision at all.
 * - `releasePx` 28 → 44. This is the one that changes how the timeline FEELS.
 *   A 28px release meant a snapped gesture came free about as easily as it was
 *   caught, so dragging PAST a boundary — a deliberate act — was
 *   indistinguishable from drifting off one. At 44px breaking out is a
 *   decision: the guide holds, you push through it, it lets go. The ratio
 *   (2.2× attract) is what reads as a detent rather than as friction.
 *
 * Widening the release radius is only tolerable because the snap is now VISIBLE
 * — `drawSnapGuide` puts a line on the boundary you are held to. A strong
 * magnet with no indicator is just a timeline that refuses to go where you put
 * it; with the guide, the same magnet reads as help.
 */
export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  attractPx: 20,
  releasePx: 44,
  // A third of the strong radius, and barely wider than it is deep. A
  // cross-track boundary should be catchable when you aim at it and
  // effectively invisible when you don't — you can drag straight through one
  // without noticing, which is the point.
  weakAttractPx: 6,
  weakReleasePx: 10,
}

export interface SnapState {
  /** The point currently held, or null when the gesture is running free. */
  readonly snappedTo: number | null
  /** How hard the held point pulls — it decides which release radius applies,
   *  so a weak capture stays as easy to leave as it was to enter. */
  readonly strength: SnapStrength | null
}

const FREE: SnapState = { snappedTo: null, strength: null }

export function createSnapState(): SnapState {
  return FREE
}

export interface SnapResult {
  /** The value to use: the snap point when caught, the candidate otherwise. */
  time: number
  snappedTo: number | null
  /** Which tier caught it, so the caller can draw a guide that matches how
   *  hard it is holding. Null whenever `snappedTo` is. */
  strength: SnapStrength | null
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
  snapPoints: readonly SnapPoint[],
  viewport: Viewport,
  state: SnapState = FREE,
  config: SnapConfig = DEFAULT_SNAP_CONFIG,
): SnapResult {
  const pxPerSecond = viewport.pxPerSecond
  if (!(pxPerSecond > 0) || snapPoints.length === 0) {
    return { time: candidateT, snappedTo: null, strength: null, state: FREE }
  }

  const attract = { strong: config.attractPx / pxPerSecond, weak: config.weakAttractPx / pxPerSecond }
  const release = { strong: config.releasePx / pxPerSecond, weak: config.weakReleasePx / pxPerSecond }

  // Held: stay put until the cursor escapes the (wider) release radius of the
  // tier that caught it. A weak capture is let go of on weak terms.
  if (state.snappedTo !== null && state.strength !== null) {
    if (Math.abs(candidateT - state.snappedTo) < release[state.strength]) {
      return { time: state.snappedTo, snappedTo: state.snappedTo, strength: state.strength, state }
    }
    // Broken free. Fall through to a fresh scan — the point just released is
    // by definition beyond its own `release` > `attract`, so it cannot
    // re-capture at the same tier.
  }

  // Nearest wins WITHIN a tier; a strong point beats a weak one outright, even
  // a nearer weak one. That precedence is the whole feature: cross-track
  // boundaries must never steal a gesture away from the cut it is aiming at on
  // its own track, and with plain nearest-wins they routinely would.
  let bestStrong: number | null = null
  let bestStrongDist = attract.strong
  let bestWeak: number | null = null
  let bestWeakDist = attract.weak

  for (const point of snapPoints) {
    const dist = Math.abs(candidateT - point.time)
    if (point.strength === 'strong') {
      if (dist < bestStrongDist) { bestStrongDist = dist; bestStrong = point.time }
    } else if (dist < bestWeakDist) {
      bestWeakDist = dist
      bestWeak = point.time
    }
  }

  const best = bestStrong ?? bestWeak
  if (best === null) return { time: candidateT, snappedTo: null, strength: null, state: FREE }
  const strength: SnapStrength = bestStrong !== null ? 'strong' : 'weak'
  return { time: best, snappedTo: best, strength, state: { snappedTo: best, strength } }
}

/**
 * Snap points for dragging a whole item of length `duration`, expressed as
 * candidate START positions: a point can catch the item's leading edge (start
 * lands on it) or its trailing edge (start lands one duration earlier). Feeding
 * these to `applySnap` with the raw start makes both edges magnetic through the
 * same code path — and, because the state is a start position rather than an
 * "edge + point" pair, hysteresis works across the pair for free.
 */
export function snapPointsForSpan(points: readonly SnapPoint[], duration: number): SnapPoint[] {
  const out: SnapPoint[] = []
  for (const p of points) out.push(p)
  for (const p of points) out.push({ time: p.time - duration, strength: p.strength })
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
export function snapPointsExcluding(points: readonly SnapPoint[], exclude: readonly number[]): SnapPoint[] {
  const out: SnapPoint[] = []
  for (const p of points) {
    if (!Number.isFinite(p.time)) continue
    if (exclude.some(e => Math.abs(p.time - e) <= EPSILON)) continue
    const dupeAt = out.findIndex(kept => Math.abs(kept.time - p.time) <= EPSILON)
    if (dupeAt >= 0) {
      // One time, two tiers: a cut on this track that happens to line up with
      // one two rows up is a STRONG point, not a weak one. Upgrading on
      // collision keeps the strong tier complete no matter what order the
      // rows were walked in.
      if (p.strength === 'strong') out[dupeAt] = p
      continue
    }
    out.push(p)
  }
  return out
}
