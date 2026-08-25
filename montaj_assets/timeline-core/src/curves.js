// @ts-check
// montaj_assets/timeline-core/src/curves.js
//
// Keyframe curves: the ONE place easing math is allowed to live.
//
// SP9b introduces keyframed properties (offsetX/offsetY/scale/rotation/
// opacity animated over an item's own lifetime). Two engines have to agree on
// the value of an animated property at every instant:
//
//   - the editor preview, which paints a DOM/canvas frame at the playhead
//   - the render engine, which bakes the same motion into ffmpeg filter args
//
// If those two ever compute easing separately they WILL drift — the failure
// mode is the ugly kind, where the preview looks right and the exported file
// is subtly, unfixably wrong. So the binding rule for this feature is:
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ Curve evaluation lives ONLY in timeline-core. Any easing math that   │
//   │ appears in the preview, the render shim, or encode-segment.js is a   │
//   │ PARITY BUG — route it through this file.                             │
//   └──────────────────────────────────────────────────────────────────────┘
//
// That is why this module is deliberately self-contained: no DOM, no CSS, no
// `Element.animate`, no dependency, no import from anywhere. The named
// presets below are the CSS ones by NAME and by CONTROL POINTS, but the
// numbers are produced here, by this solver, for both engines — never by a
// browser. A browser-evaluated curve on one side and a solved curve on the
// other is exactly the drift this file exists to prevent.
//
// ── Conventions this module fixes (all three are silent-bug territory) ──────
//
//   1. TIME IS ITEM-RELATIVE. A keyframe's `t` is seconds from the item's own
//      `start`, NOT timeline seconds. An item that moves on the timeline
//      carries its animation with it, unchanged.
//
//   2. EASING IS OUTGOING, and belongs to the SEGMENT that leaves a keyframe.
//      The `easing` on keyframe i governs interpolation from i to i+1. The
//      LAST keyframe's `easing` is therefore never read — there is no segment
//      leaving it. Absent `easing` means `'linear'`. This is the convention
//      the UI's per-segment easing picker is built on, and reading it
//      backwards (treating easing as "how we arrive at this key") produces a
//      timeline that looks plausible and animates wrong.
//
//   3. `hold` IS STEP-END. A held segment keeps keyframe i's value for the
//      WHOLE segment and jumps to keyframe i+1's value exactly AT i+1's `t`.
//      It is not a bezier and never touches the solver.
//
// ── The "no track" sentinel ─────────────────────────────────────────────────
//
// `sampleTrack` returns `undefined`, not 0, for a missing/empty track, so the
// caller can write `sampleTrack(track, localT) ?? item.scale`. 0 is a
// perfectly ordinary keyframe value (opacity 0, offset 0), so the sentinel
// has to be outside the number line — see the test of the same name.
//
// ── Why a hand-rolled solver ────────────────────────────────────────────────
//
// `solveCurveX` is the classic WebKit `UnitBezier` algorithm: Newton-Raphson
// on x with a bisection fallback. It is iterative but fully deterministic —
// same input, same output, on every platform and every call — which is the
// SP2 package contract (no Date, no Math.random, no I/O, no globals) and also
// what makes preview/render parity checkable at all. There is deliberately no
// import-time lookup table: nothing here is memoized, so there is no cache to
// get stale and no first-call-vs-later-call difference.
//
// ── Hot path ────────────────────────────────────────────────────────────────
//
// `sampleTrack` runs per animated prop, per item, per frame. It ALLOCATES
// NOTHING: no `.sort()`, no `.map()`, no spread, no per-call closures, and it
// finds the bracketing pair with a plain forward scan rather than a binary
// search (tracks are tiny — a couple of dozen points at the very most — so the
// scan wins on both simplicity and constant factor). `normalizeTrack` is the
// opposite: it is the WRITE-time helper, called by the editor when a keyframe
// is added or dragged, and it may allocate freely because it runs once per
// edit, not once per frame.

/**
 * The supported easing names. The five bezier ones are the CSS keywords, by
 * name and by control points; `hold` is the step function CSS spells
 * `steps(1, end)` and has no bezier form.
 *
 * @typedef {'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'} EasingName
 */

/**
 * The item properties that can be keyframed. Deliberately the seven that
 * `geometryFor` already understands — animating anything else is out of
 * scope, and a track naming an unknown prop is simply never consulted.
 *
 * `scale` is the legacy UNIFORM knob and `scaleX`/`scaleY` are its per-axis
 * siblings; an item with no per-axis track follows the `scale` one on both
 * axes, so adding these two did not change what a `scale`-only track does.
 *
 * @typedef {'offsetX' | 'offsetY' | 'scale' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity'} KeyframeProp
 */

/**
 * One keyframe.
 *
 * @typedef {Object} Keyframe
 * @property {number} t Seconds from the ITEM's own `start` — item-relative,
 *   never timeline time. See convention 1 in the module header.
 * @property {number} value The property's value at `t`, in the property's own
 *   units (percent of frame for offsets, a multiplier for scale, degrees for
 *   rotation, 0-1 for opacity) — this module never interprets them.
 * @property {EasingName} [easing] How the segment LEAVING this keyframe is
 *   shaped — outgoing, not incoming. Absent means `'linear'`; unrecognized
 *   also means `'linear'`. Ignored on the last keyframe, which has no
 *   outgoing segment. See convention 2 in the module header.
 */

/**
 * One animated property's keyframes. `points` MUST be ascending by `t` —
 * {@link sampleTrack} assumes it and does not re-sort (it must not allocate).
 * {@link normalizeTrack} is how the editor establishes that invariant at
 * write time, so it holds by construction rather than by hope.
 *
 * @typedef {Object} KeyframeTrack
 * @property {KeyframeProp} prop Which property these keyframes drive.
 * @property {Keyframe[]} points Ascending by `t`, no duplicate `t`.
 */

/**
 * Every supported easing, in picker order: the CSS beziers from least to most
 * shaped, then the odd one out. Frozen — the UI reads it, it never edits it.
 *
 * @type {ReadonlyArray<EasingName>}
 */
export const EASING_NAMES = Object.freeze(
  /** @type {EasingName[]} */ (['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'hold']),
)

/** How close in x the solver has to land before it stops. */
const EPSILON = 1e-7

/** WebKit's iteration count. Quadratic convergence: eight is generous. */
const NEWTON_ITERATIONS = 8

/**
 * Hard cap on the bisection fallback. WebKit loops `while (t0 < t1)`, which
 * relies on float64 collapsing the interval; a fixed cap is the same thing
 * with a guarantee attached, and 60 halvings exhaust a double's mantissa
 * several times over.
 */
const BISECTION_ITERATIONS = 60

/**
 * Invert x on a cubic bezier through (0,0) and (1,1): given the polynomial
 * coefficients of X and a target `x`, find the curve PARAMETER s with
 * X(s) ≈ x. Newton-Raphson first, plain bisection when the derivative goes
 * flat enough to make Newton unsafe.
 *
 * @param {number} ax
 * @param {number} bx
 * @param {number} cx
 * @param {number} x Target, already known to be strictly inside (0, 1).
 * @returns {number} The curve parameter, in [0, 1].
 */
function solveCurveX(ax, bx, cx, x) {
  let s = x

  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const dx = ((ax * s + bx) * s + cx) * s - x
    if (Math.abs(dx) < EPSILON) return s
    const slope = (3 * ax * s + 2 * bx) * s + cx
    // A near-flat slope would send Newton off to infinity; hand over instead.
    if (Math.abs(slope) < 1e-6) break
    s -= dx / slope
  }

  // Bisection fallback. Restart from the (bracketed) initial guess rather
  // than from wherever Newton wandered off to.
  let lo = 0
  let hi = 1
  s = x
  for (let i = 0; i < BISECTION_ITERATIONS && lo < hi; i++) {
    const at = ((ax * s + bx) * s + cx) * s
    if (Math.abs(at - x) < EPSILON) return s
    if (x > at) lo = s
    else hi = s
    s = (hi - lo) * 0.5 + lo
  }
  return s
}

/**
 * Evaluate the cubic bezier through (0,0), (x1,y1), (x2,y2), (1,1) at x.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} x Strictly inside (0, 1) — the endpoints are short-circuited
 *   by {@link easeProgress} so they stay bit-exact.
 * @returns {number}
 */
function cubicBezier(x1, y1, x2, y2, x) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const s = solveCurveX(ax, bx, cx, x)
  return ((ay * s + by) * s + cy) * s
}

/**
 * The eased progress along one segment: given linear progress `p` in [0, 1],
 * how far the VALUE has travelled. The whole easing vocabulary funnels through
 * here, so this is the function that has to be shared for preview and render
 * to agree — see the module header.
 *
 * Total by design: `p` is clamped to [0, 1] (a non-finite `p` reads as 0), and
 * an unrecognized `easing` falls back to `'linear'` rather than throwing. A
 * hand-edited or half-migrated project must still render, just unstyled.
 *
 * Both anchors are EXACT: `p === 0` returns 0 and `p === 1` returns 1 with no
 * solver round-trip, for every easing. `'linear'` is short-circuited entirely
 * and returns `p` bit-for-bit. `'hold'` is step-END (convention 3): 0 for all
 * `p < 1`, 1 only at `p === 1`.
 *
 * @param {EasingName | undefined} easing Outgoing easing of the segment.
 * @param {number} p Linear progress along the segment.
 * @returns {number} Eased progress, in [0, 1].
 */
export function easeProgress(easing, p) {
  // `!(p > 0)` rather than `p <= 0` so NaN lands here instead of falling
  // through and poisoning the caller's arithmetic.
  if (!(p > 0)) return 0
  if (p >= 1) return 1

  switch (easing) {
    // Step-end: nothing moves until the next keyframe's own instant, which is
    // the `p === 1` case already returned above.
    case 'hold':
      return 0
    case 'ease':
      return cubicBezier(0.25, 0.1, 0.25, 1, p)
    case 'ease-in':
      return cubicBezier(0.42, 0, 1, 1, p)
    case 'ease-out':
      return cubicBezier(0, 0, 0.58, 1, p)
    case 'ease-in-out':
      return cubicBezier(0.42, 0, 0.58, 1, p)
    // 'linear', absent, and anything unrecognized. Returned unsolved so it is
    // exact at every p, not just at the anchors.
    default:
      return p
  }
}

/**
 * Whether a keyframe is usable at all. A point with a non-finite `t` or
 * `value` (or that is not an object) is skipped rather than thrown on — same
 * defensive posture as `toRotatedPixelBox`'s rotation guard: unreadable input
 * means "not there", never NaN out the other side.
 *
 * @param {Keyframe | null | undefined} kf
 * @returns {boolean}
 */
function isUsable(kf) {
  return !!kf && Number.isFinite(kf.t) && Number.isFinite(kf.value)
}

/**
 * Index of the first usable keyframe, or -1 if there is none.
 *
 * @param {Keyframe[]} points
 * @returns {number}
 */
function firstUsableIndex(points) {
  for (let i = 0; i < points.length; i++) {
    if (isUsable(points[i])) return i
  }
  return -1
}

/**
 * The value of one keyframed property at item-relative time `localT`.
 *
 * Returns the `undefined` SENTINEL — never 0 — when there is nothing to
 * sample: `track` is null/undefined, has no `points` array, has an empty one,
 * or every point in it is malformed. Callers pair it with the static scalar:
 *
 *     const scale = sampleTrack(track, t - item.start) ?? item.scale ?? 1
 *
 * Rules, all pinned by test/curves.test.mjs:
 *   - `localT` at or before the first keyframe → that keyframe's value;
 *     at or after the last → that one's. No extrapolation, ever.
 *   - a single keyframe is a constant at every `localT`.
 *   - AT a keyframe's own `t` you get that keyframe's value back exactly, for
 *     every easing including `hold` — no float drift at the anchors.
 *   - easing is OUTGOING (convention 2): the segment is shaped by the easing
 *     of the keyframe it LEAVES.
 *   - a non-finite `localT` reads as "before the first keyframe".
 *   - two keyframes sharing a `t` do not divide by zero: the later one wins,
 *     matching {@link normalizeTrack}'s last-wins de-duplication.
 *
 * `points` is ASSUMED ascending by `t` ({@link normalizeTrack} is how the
 * editor guarantees that). Out-of-order points do not throw and do not
 * produce NaN; they just sample as whatever the forward scan finds.
 *
 * Allocates nothing — see the module header's hot-path note.
 *
 * @param {KeyframeTrack | Keyframe[] | null | undefined} track The track, or
 *   bare keyframes: both forms are accepted so a caller holding
 *   `track.points` need not re-wrap it.
 * @param {number} localT Seconds from the ITEM's own `start`, not timeline time.
 * @returns {number | undefined} The value, or `undefined` when there is no track.
 */
export function sampleTrack(track, localT) {
  /** @type {Keyframe[] | undefined} */
  let points
  if (Array.isArray(track)) points = track
  else if (track && Array.isArray(track.points)) points = track.points
  if (!points || points.length === 0) return undefined

  const firstIdx = firstUsableIndex(points)
  if (firstIdx < 0) return undefined

  let prev = points[firstIdx]
  // An unreadable localT is not "far future" — it is no information at all,
  // so it clamps to the start rather than to the end.
  const t = Number.isFinite(localT) ? localT : prev.t
  if (t < prev.t) return prev.value

  for (let i = firstIdx + 1; i < points.length; i++) {
    const cur = points[i]
    if (!isUsable(cur)) continue

    if (t < cur.t) {
      const span = cur.t - prev.t
      // Zero (duplicate `t`) or negative (authored out of order): there is no
      // segment to interpolate across, so the later keyframe wins outright.
      if (!(span > 0)) return cur.value
      // At p === 0 every easing returns exactly 0, so landing ON `prev`'s own
      // `t` gives back `prev.value` bit-for-bit — that is where the endpoint
      // exactness guarantee comes from.
      return prev.value + (cur.value - prev.value) * easeProgress(prev.easing, (t - prev.t) / span)
    }

    prev = cur
  }

  // Past the last usable keyframe: clamp.
  return prev.value
}

/** Ascending by time. Extracted so `normalizeTrack` allocates no closure. */
function byTime(/** @type {Keyframe} */ a, /** @type {Keyframe} */ b) {
  return a.t - b.t
}

/**
 * The WRITE-time normalizer: returns a NEW track whose `points` satisfy the
 * invariant {@link sampleTrack} assumes — ascending by `t`, at most one
 * keyframe per `t`, nothing malformed. The editor calls it whenever keyframes
 * are added, dragged or pasted, so the read path never has to sort.
 *
 * De-duplication is LAST WINS in AUTHORING order (the sort is stable, so a
 * key added later at an existing `t` replaces the one already there — which
 * is what dropping a new keyframe onto an existing one should do). Points
 * with a non-finite `t` or `value`, and non-object entries, are dropped
 * outright: they are unusable, and leaving them in would only make every
 * later read pay to skip them.
 *
 * Pure: the input track and its array are never mutated or re-ordered, and
 * the surviving keyframe OBJECTS are carried across by reference (not cloned)
 * — the same forwarding posture `geometryFor` takes with `sourceCrop`.
 *
 * @param {KeyframeTrack | null | undefined} track
 * @returns {KeyframeTrack | undefined} `undefined` for a null/undefined track;
 *   otherwise the same track with a normalized `points` array.
 */
export function normalizeTrack(track) {
  if (!track) return undefined

  const raw = Array.isArray(track.points) ? track.points : []
  // `filter` first, so `sort` works on our copy and never touches the
  // caller's array.
  const sorted = raw.filter(isUsable).sort(byTime)

  /** @type {Keyframe[]} */
  const points = []
  for (let i = 0; i < sorted.length; i++) {
    // A following key at the same `t` supersedes this one.
    if (i + 1 < sorted.length && sorted[i + 1].t === sorted[i].t) continue
    points.push(sorted[i])
  }

  return { ...track, points }
}
