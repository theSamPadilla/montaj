// montaj_assets/timeline-core/src/transitions.js
//
// What a crossfade IS — the one definition, shared by every engine that has to
// agree about one.
//
// Three consumers read this module and they must never diverge:
//   - the editor derives real `opacity` keyframes for an OVERLAY pair from
//     `fadeShape` (timeline-model.ts, `computeVisualCrossfade`);
//   - the resolver stamps `crossfade` onto CLIP items from `transitionPairs` /
//     `transitionProgress` (activation.js), which preview and sample_frame read;
//   - the segment encoder reads the same `p` at both ends of a segment to build
//     its `blend` expression (encode-segment.js).
//
// Pure. No project shape, no clock, no I/O — it takes a flat array of items
// that are already known to share one track.
//
// ── Why containment is NOT a transition ──────────────────────────────────────
//
// A transition needs a "from" and a "to". When one item's span swallows the
// other's there is no ordering to blend along — the inner item is simply buried
// for its whole life. `engine/validate.py` rejects that shape outright; this
// module skips it rather than inventing a blend for it, so a hand-authored
// project that slipped past the validator degrades to today's hard cut instead
// of producing something arbitrary.

/**
 * @typedef {object} TransitionItem
 * @property {string} [id]
 * @property {number} [start]
 * @property {number} [end]
 * @property {boolean} [opaque]  Overlay only. Drives {@link fadeShape}.
 */

/**
 * @typedef {object} TransitionPair
 * @property {TransitionItem} from  The earlier item — the one being left.
 * @property {TransitionItem} to    The later item — the one being entered.
 * @property {number} start  Timeline seconds the blend begins (`to.start`).
 * @property {number} end    Timeline seconds the blend ends (`from.end`).
 */

/**
 * A missing or non-finite endpoint reads as 0, which is what keeps every
 * function here TOTAL over a partial or hand-edited item rather than
 * propagating `NaN` into a blend factor.
 *
 * @param {unknown} v
 * @returns {number}
 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Every crossfade on one track's items, earliest first.
 *
 * Items are sorted by `start` (then `end`) first, so the caller may pass them
 * in any order. Only CONSECUTIVE pairs in that order are considered: a
 * three-way overlap is a validator error, and silently blending some subset of
 * it would hide the mistake.
 *
 * @param {ReadonlyArray<TransitionItem>} items
 * @returns {TransitionPair[]}
 */
export function transitionPairs(items) {
  const sorted = [...(items ?? [])].sort(
    (a, b) => num(a.start) - num(b.start) || num(a.end) - num(b.end),
  )
  const pairs = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]
    const to = sorted[i + 1]
    const start = num(to.start)
    const end = num(from.end)
    if (start >= end) continue                       // butt-joined or a gap
    if (num(to.end) <= end) continue                 // containment — see the header
    pairs.push({ from, to, start, end })
  }
  return pairs
}

/**
 * How far through the blend `t` is: 0 at the pair's start, 1 at its end,
 * clamped outside. A zero-length span returns 0 rather than NaN.
 *
 * @param {{start: number, end: number}} pair
 * @param {number} t  Timeline seconds.
 * @returns {number} 0-1.
 */
export function transitionProgress(pair, t) {
  const span = num(pair?.end) - num(pair?.start)
  if (!(span > 0)) return 0
  const p = (num(t) - num(pair.start)) / span
  return p < 0 ? 0 : p > 1 ? 1 : p
}

/**
 * The two alphas at progress `p` — the fade SHAPE, which is not the same for
 * every pair.
 *
 * SYMMETRIC (`from` 1→0, `to` 0→1) is the default and mirrors the shipped audio
 * crossfade: two partially-covering overlays each fade against whatever is
 * beneath them, which is what a viewer reads as a dissolve.
 *
 * HOLD (`from` stays 1) applies when the OUTGOING item is `opaque`. An opaque
 * overlay covers the whole frame and the renderer suppresses the picture under
 * it (`segment-plan.js`'s `opaqueVideo`), so fading it out reveals BLACK, not
 * the item beneath — the composite would dip dark through every transition.
 * Holding it and fading the incoming item in over it is a true linear dissolve
 * with no dip.
 *
 * Keyed off the OUTGOING side only. An opaque item fading IN over a transparent
 * one is fine — nothing is being revealed — so that case stays symmetric.
 *
 * @param {TransitionPair} pair
 * @param {number} p  0-1, from {@link transitionProgress}.
 * @returns {{from: number, to: number}}
 */
export function fadeShape(pair, p) {
  const holdOutgoing = pair?.from?.opaque === true
  return { from: holdOutgoing ? 1 : 1 - p, to: p }
}
