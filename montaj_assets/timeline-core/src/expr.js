// timeline-core/src/expr.js
/**
 * Keyframe curve → ffmpeg filter expression.
 *
 * THE DESIGN DECISION, because it is the part a reader will want to check.
 *
 * The naive route is to translate each easing into an ffmpeg expression. This
 * module deliberately does NOT. `EASING_NAMES`' four `ease*` entries are cubic
 * Béziers inverted by `solveCurveX` (`curves.js`) — Newton-Raphson with a
 * 60-iteration bisection fallback. ffmpeg's expression language could express
 * that (it has `st()`/`ld()` registers and `while()`), but it would be an
 * iterative solver written twice, in two languages, that must agree forever;
 * any drift between them is precisely the preview/render divergence this
 * package exists to prevent.
 *
 * Instead the hard maths stays in JS, where it is already correct and already
 * tested: the curve is sampled HERE through the same {@link sampleTrack} the
 * preview uses, and ffmpeg is handed straight lines between those samples. So
 * there is exactly ONE implementation of easing in the system.
 *
 * Two properties make that exact where it matters:
 *   - The renderer only ever evaluates the expression at FRAME INSTANTS. A
 *     breakpoint on every frame boundary would be exact by construction.
 *   - Uniform per-frame breakpoints are wasteful, so subdivision is ADAPTIVE:
 *     an interval is bisected only while the true curve departs from the chord
 *     across it by more than the tolerance.
 *
 * TOLERANCE IS IN OUTPUT PIXELS, not curve units, because "visually identical"
 * is a statement about pixels. Callers pass `pixelTolerance` (default 0.25px)
 * and `unitsPerPixel`, the conversion into THIS property's own units. Derived
 * against the real geometry (`geometry.js` `toPixelBox`/`toRotatedPixelBox`):
 *
 *   - offsetX/offsetY — `x = round(vw*(0.5*(1-s) + ox/100))`, so one offset
 *     unit is exactly 1% of the frame's width. `unitsPerPixel = 100/vw`
 *     (equivalently `1/(vw/100)`). Linear and direct; the conversion is exact.
 *
 *   - scale / scaleX / scaleY — same formula. A scale error Δs produces a
 *     direct size error of `vw*Δs` but only `vw*Δs/2` of position error
 *     (centring halves it), so bounding the direct effect leaves margin on the
 *     indirect one. `unitsPerPixel = 1/vw`.
 *
 *   - rotation — the one that needs care. `outW = round((|scaledW·cosθ| +
 *     |scaledH·sinθ|)/2)*2` and `x = xPx - (outW-scaledW)/2`, so the pixel
 *     error produced by an angle error scales with the box's CURRENT size.
 *     Convert rotation's tolerance against the MAXIMUM `scaledW`/`scaledH` the
 *     item reaches across its whole span — its static scale, or the PEAK of its
 *     scale track when scale is co-animated. A fixed or first-frame reference
 *     under-subdivides rotation exactly when the item is largest, which is when
 *     the error is most visible. Over-subdividing costs a few expression arms;
 *     under-subdividing costs visible wobble, so this is conservative by design.
 *
 * `compileTrackExpr` compiles ONE track at a time and cannot see a sibling
 * scale track, so that peak-size-derived `unitsPerPixel` is an explicit
 * parameter rather than something inferred here.
 *
 * The emitted vocabulary is deliberately tiny — `if`, `between`, `+ - * /`,
 * `t`, numeric literals — which is what makes the test-side evaluator in
 * `test/helpers/eval-expr.mjs` honest rather than a mirror of this file's
 * logic: there is no easing logic left on the ffmpeg side to mirror.
 *
 * `t` is ITEM-RELATIVE seconds, the same base `Keyframe.t` uses. The render
 * caller is responsible for making ffmpeg's `t` mean that (see
 * `encode-segment.js` — `setpts` at the head of the chain already does).
 */

import { sampleTrack } from './curves.js'

/**
 * Ceiling on adaptive subdivision. 63 rather than 64 because the emitted form
 * spends one `between(...)` arm on the before-span guard on top of one per
 * segment, and the contract callers and tests rely on is that the whole
 * expression holds at most 64 `between(...)` calls — a number chosen so a
 * pathological curve cannot emit an unreadable thousand-arm string.
 *
 * Hitting this cap is REPORTED, never silent, but it is not an error: with
 * globally-greedy subdivision (see below) a starved budget degrades uniformly,
 * and refusing an export over a rare, still-visually-reasonable precision
 * shortfall is the worse trade.
 */
export const MAX_SEGMENTS = 63

/** How many interior probes decide an interval's chord error. */
const PROBES_PER_INTERVAL = 17

/**
 * The largest double strictly below `x` — a `hold` arm's upper bound.
 *
 * `between()` is inclusive at both ends, so a held segment would otherwise
 * still answer at `t === t1`, where step-end semantics require the FOLLOWING
 * keyframe's value. A fixed epsilon is not good enough: `sampleTrack` steps at
 * exactly `t1`, so anything below it — including `t1`'s own predecessor, which
 * is what a `t` accumulated by repeated addition actually lands on — must still
 * read as held. Shaving by the smallest representable amount is the only bound
 * that matches `sampleTrack` at every double.
 *
 * @param {number} x
 * @returns {number}
 */
function prevDouble(x) {
  if (!Number.isFinite(x)) return x
  if (x === 0) return -Number.MIN_VALUE
  const f = new Float64Array(1)
  const bits = new BigInt64Array(f.buffer)
  f[0] = x
  bits[0] += x > 0 ? -1n : 1n
  return f[0]
}

/**
 * Stands in for -infinity on the before-span guard. Keyframe times are
 * seconds within a clip, so nothing real comes within nine orders of
 * magnitude of this.
 */
const T_FLOOR = -1e9

/**
 * A keyframe `sampleTrack` would actually use. Mirrors its `isUsable`.
 *
 * @param {import('./curves.js').Keyframe | null | undefined} p
 * @returns {boolean}
 */
function isUsable(p) {
  return !!p && Number.isFinite(p.t) && Number.isFinite(p.value)
}

/**
 * Shortest string that parses back to the same double, with exponent notation
 * expanded. `String(x)` is already round-trip exact, but it reaches for `1e-9`
 * at small magnitudes and a fixed-point literal is the safer thing to hand a
 * filtergraph.
 *
 * @param {number} x
 * @returns {string}
 */
function num(x) {
  const s = String(x)
  if (!s.includes('e') && !s.includes('E')) return s
  // toFixed(20) is past a double's precision, so trimming the tail is lossless
  // for anything this module produces.
  return x.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * The track's usable points, in the order `sampleTrack` would read them.
 *
 * @param {import('./curves.js').KeyframeTrack | import('./curves.js').Keyframe[] | null | undefined} track
 * @returns {import('./curves.js').Keyframe[]}
 */
function usablePoints(track) {
  let points
  if (Array.isArray(track)) points = track
  else if (track && Array.isArray(track.points)) points = track.points
  if (!points) return []
  return points.filter(isUsable)
}

/**
 * Compile a keyframe track to an ffmpeg expression, with the diagnostics the
 * render path needs in order to warn a real operator.
 *
 * @param {import('./curves.js').KeyframeTrack | import('./curves.js').Keyframe[] | null | undefined} track
 * @param {{ pixelTolerance?: number, unitsPerPixel?: number }} [options]
 * @returns {{ expr: string | null, segments: number, capped: boolean, maxError: number, tolerance: number }}
 *   `expr` is `null` when the track carries nothing usable — the caller keeps
 *   its static value. `maxError` is in the property's own units.
 */
export function compileTrackExprInfo(track, options = {}) {
  const { pixelTolerance = 0.25, unitsPerPixel = 1 } = options
  const tolerance = Math.abs(pixelTolerance * unitsPerPixel)
  const points = usablePoints(track)

  if (points.length === 0) {
    return { expr: null, segments: 0, capped: false, maxError: 0, tolerance }
  }
  // A single keyframe is a constant everywhere — `sampleTrack` clamps on both
  // sides — so it compiles to the bare literal rather than a guarded chain.
  if (points.length === 1) {
    return { expr: num(points[0].value), segments: 0, capped: false, maxError: 0, tolerance }
  }

  // One segment per authored interval to begin with. `hold` segments are exact
  // by construction and are never subdivided: a step has no chord error, and
  // bisecting one would only smooth the thing that must not be smoothed.
  const segs = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    // Zero or negative span: `sampleTrack` resolves it by letting the later
    // keyframe win outright, so there is no interval to approximate.
    if (!(b.t > a.t)) continue
    segs.push(makeSegment(track, a.t, b.t, a.easing === 'hold'))
  }
  if (segs.length === 0) {
    return { expr: num(points[points.length - 1].value), segments: 0, capped: false, maxError: 0, tolerance }
  }

  // GLOBALLY GREEDY subdivision, and this is a correctness requirement rather
  // than a style preference. Always split the single worst-offending interval
  // next, wherever in the track it sits:
  //
  //   - Globally greedy, on hitting the cap, degrades UNIFORMLY — worst-case
  //     error rises a little everywhere and nothing looks broken.
  //   - Per-interval or in-order budgeting can STARVE a later interval
  //     completely, leaving one straight chord across what should be a full
  //     S-curve. That is not "coarse"; that is one stretch of the timeline
  //     visibly not animating the way the operator authored it while the rest
  //     looks fine.
  //
  // A linear scan for the worst segment is O(n) against a cap of 63, which is
  // not worth a heap.
  while (segs.length < MAX_SEGMENTS) {
    let worst = -1
    let worstErr = tolerance
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].err > worstErr) { worstErr = segs[i].err; worst = i }
    }
    if (worst < 0) break
    const s = segs[worst]
    const mid = (s.t0 + s.t1) / 2
    // A span too small to bisect in floating point would spin forever.
    if (!(mid > s.t0 && mid < s.t1)) { s.err = 0; continue }
    segs.splice(worst, 1, makeSegment(track, s.t0, mid, false), makeSegment(track, mid, s.t1, false))
  }

  let maxError = 0
  for (const s of segs) if (s.err > maxError) maxError = s.err

  return {
    expr: emit(segs),
    segments: segs.length,
    capped: segs.length >= MAX_SEGMENTS && maxError > tolerance,
    maxError,
    tolerance,
  }
}

/**
 * One approximation segment, carrying the true curve values at its ends and
 * how far the true curve strays from the chord between them.
 *
 * @param {import('./curves.js').KeyframeTrack | import('./curves.js').Keyframe[] | null | undefined} track
 * @param {number} t0
 * @param {number} t1
 * @param {boolean} hold
 * @returns {{t0: number, t1: number, v0: number, v1: number, hold: boolean, err: number}}
 */
function makeSegment(track, t0, t1, hold) {
  const v0 = /** @type {number} */ (sampleTrack(track, t0))
  const v1 = /** @type {number} */ (sampleTrack(track, t1))
  let err = 0
  if (!hold) {
    for (let i = 1; i < PROBES_PER_INTERVAL; i++) {
      const p = i / PROBES_PER_INTERVAL
      const t = t0 + (t1 - t0) * p
      const chord = v0 + (v1 - v0) * p
      const d = Math.abs(/** @type {number} */ (sampleTrack(track, t)) - chord)
      if (d > err) err = d
    }
  }
  return { t0, t1, v0, v1, hold, err }
}

/**
 * Emit the nested `if(between(...))` chain.
 *
 * Arms are tried in order and the first match wins, so adjacent arms may share
 * a boundary harmlessly: a linear arm's value at its own upper bound already
 * equals the next arm's value there. `hold` is the sole exception — its value
 * at the top of its span is the PREVIOUS keyframe's, not the next one's — so a
 * held arm's upper bound is {@link prevDouble} of its top and the step falls
 * through to the following arm exactly on the next keyframe's instant.
 *
 * The chain's final `else` holds the last value, matching `sampleTrack`'s
 * clamp past the final keyframe; the leading arm does the same before the
 * first one.
 *
 * @param {{t0: number, t1: number, v0: number, v1: number, hold: boolean, err: number}[]} segs
 * @returns {string}
 */
function emit(segs) {
  const first = segs[0]
  const lastValue = segs[segs.length - 1].v1

  let out = num(lastValue)
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]
    const hi = s.hold ? prevDouble(s.t1) : s.t1
    const arm = s.hold
      ? num(s.v0)
      // Written as v0 + dv*(t-t0)/dt rather than a precomputed slope so the
      // literals stay recognizable against the keyframes that produced them.
      : `${num(s.v0)}+${num(s.v1 - s.v0)}*(t-${num(s.t0)})/${num(s.t1 - s.t0)}`
    out = `if(between(t,${num(s.t0)},${num(hi)}),${arm},${out})`
  }
  // Before the first keyframe `sampleTrack` clamps to its value; without this
  // guard the leading arm's lerp would extrapolate backwards instead.
  return `if(between(t,${num(T_FLOOR)},${num(first.t0)}),${num(first.v0)},${out})`
}

/**
 * Compile a keyframe track into an ffmpeg filter expression in `t`
 * (ITEM-relative seconds).
 *
 * See the module header for why this emits a piecewise-LINEAR approximation
 * rather than a translation of the easing maths, and for how `pixelTolerance`
 * converts into each property's units.
 *
 * @param {import('./curves.js').KeyframeTrack | import('./curves.js').Keyframe[] | null | undefined} track
 * @param {{ pixelTolerance?: number, unitsPerPixel?: number }} [options]
 * @returns {string | null} `null` when the track carries no usable keyframe.
 */
export function compileTrackExpr(track, options) {
  return compileTrackExprInfo(track, options).expr
}
