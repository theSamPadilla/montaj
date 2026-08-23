// @ts-check
// montaj_assets/timeline-core/src/captions.js
//
// activeCaptionSegment / activeCaptionSegments — frame-quantized caption
// segment selection. TWO functions, deliberately: the singular is the historic
// "first match wins" selector; the plural returns EVERY match, lane-ordered,
// for the multi-row caption feature. They MUST stay in lockstep on
// quantization and on the activation predicate — see the cross-reference note
// on each of them before touching either.
//
// Ports montaj_assets/editor/src/video/preview/CaptionPreview.tsx:187-194
// verbatim:
//
//     const frame = Math.round(currentTime * fps)
//     const lastSeg = track.segments[track.segments.length - 1]
//     // The segment the template is showing. Computed from `frame / fps` (not
//     // from currentTime) with the templates' own `>= start && < end`
//     // predicate, so the selection box can never address a different segment
//     // than the one on screen.
//     const t = fps > 0 ? frame / fps : 0
//     const activeSeg = track.segments.find(s => t >= s.start && t < s.end) ?? null
//
// WHY QUANTIZE: the template that actually PAINTS the caption is driven by
// the integer `frame` (CaptionPreview.tsx:225's `factory(frame, fps, ...)`),
// and every render-side caption template (render/templates/captions/*.jsx,
// e.g. karaoke.jsx:15-17) computes its own active segment from that same
// `t = frame / fps`. If the SELECTION logic instead used raw `currentTime`, a
// sub-frame `currentTime` that quantizes onto the NEXT segment's frame would
// select one segment while the template paints another. Quantizing here
// keeps selection and paint in lockstep by construction — this is the exact
// reasoning CaptionPreview.tsx carries at its own definition site, reproduced
// here in substance.
//
// RENDER-SIDE AGREEMENT: every caption template under
// montaj_assets/render/templates/captions/*.jsx (karaoke.jsx:15-17,
// clean.jsx:16-17, outline.jsx:17-18, highlight-box.jsx:17-18,
// word-by-word.jsx:14-15, subtitle.jsx:15-16, pop.jsx:15-16) computes
// `t = frame / fps` and does the identical `segments.find(s => t >= s.start
// && t < s.end)`. Render receives an already-integer `frame` from its own
// per-frame Puppeteer capture loop, so there is no `Math.round(currentTime *
// fps)` step there — but the underlying predicate is the same half-open
// `t >= start && t < end` this function reproduces. No render-side divergence
// to register for the ACTIVATION predicate itself.
//
// SEPARATE REGISTRY ENTRY — KNOWN-DIVERGENCES.md entry 5,
// `caption-1080x1920-hardcode`, owner SP5 — NOT fixed or reproduced here:
// CaptionPreview.tsx:40-41 hardcodes `RENDER_W = 1080` / `RENDER_H = 1920`
// for the caption layer's own render-resolution regardless of the project's
// actual `designCanvas`/`resolution` (a landscape or 4K project's caption
// preview is still measured against a fixed 1080×1920 layer). That is a
// SIZING concern of the caption PAINT layer, unrelated to
// `activeCaptionSegment`'s time-based SELECTION — noted here only so T5 does
// not have to re-discover it.
//
// ── Purity ──────────────────────────────────────────────────────────────────
// No Date, no Math.random, no I/O, no globals, no mutation.

/**
 * One caption segment, as far as activation is concerned. Deliberately
 * structural and minimal — the render/preview templates read many more
 * fields (text, words, style props) that this function does not need.
 *
 * @typedef {Object} CaptionSegment
 * @property {number} [start] Seconds.
 * @property {number} [end]   Seconds.
 * @property {number} [lane]  Vertical row. Absent ⇒ lane 0; higher paints on top.
 */

/**
 * A captions track, as far as activation is concerned.
 *
 * @typedef {Object} CaptionsTrack
 * @property {ReadonlyArray<CaptionSegment>} [segments]
 */

/**
 * The caption segment active at `currentTime`, after quantizing to the frame
 * grid — exactly CaptionPreview.tsx:187-194's `frame = round(currentTime *
 * fps); t = fps > 0 ? frame / fps : 0; find(s => t >= s.start && t < s.end)`.
 *
 * Half-open, like every other activation predicate in this package: `start
 * <= t < end` (written here as `t >= start && t < end`, the original's own
 * order). Returns `null` when nothing matches (an empty track, a gap between
 * segments, or `t` past the last segment) — the `?? null` in the original.
 *
 * PAIRED WITH {@link activeCaptionSegments}. That one returns EVERY match
 * rather than the first, and is what the render templates and the preview
 * actually paint from now that captions have lanes. This singular one is still
 * the right answer wherever exactly one segment is wanted. If you change the
 * quantization or the predicate here, change it there too — the two are
 * required to agree, and a divergence would put the preview's selection box on
 * a different segment than the one on screen.
 *
 * @param {CaptionsTrack | null | undefined} captions
 * @param {number} currentTime Timeline time, seconds — UNQUANTIZED; quantization happens inside.
 * @param {number} fps
 * @returns {CaptionSegment | null}
 */
export function activeCaptionSegment(captions, currentTime, fps) {
  const frame = Math.round(currentTime * fps)
  const t = fps > 0 ? frame / fps : 0
  const segments = captions?.segments ?? []
  for (const s of segments) {
    // `?? NaN` satisfies strict-mode tsc without changing behavior: a missing
    // start/end already made the raw `undefined` comparison false at runtime
    // (mirrors the `orNaN` stance in activation.js), and `NaN` comparisons are
    // false too — same outcome, now provably total under `strict`.
    if (t >= (s.start ?? Number.NaN) && t < (s.end ?? Number.NaN)) return s
  }
  return null
}

/**
 * EVERY caption segment active at `currentTime`, ordered by lane ascending.
 *
 * PAIRED WITH {@link activeCaptionSegment} — same `Math.round(currentTime *
 * fps)` quantization, same `fps > 0 ? frame / fps : 0` guard, same half-open
 * `t >= start && t < end` predicate, same `?? NaN` totality trick. The ONLY
 * difference is that this one keeps collecting instead of returning on the
 * first hit. Neither may be "tidied" without the other; see the note on the
 * singular for why the two must agree.
 *
 * Lane ascending is the ONLY ordering rule, and it IS the z-order: a consumer
 * paints the returned segments in order, so a higher lane paints later and
 * therefore on top. `Array.prototype.sort` is required to be stable (ES2019),
 * so segments sharing a lane come back in the order they appear in
 * `captions.segments` — document order breaks ties. There is no vertical
 * offset per lane anywhere: two simultaneous captions draw at their own
 * `offsetX`/`offsetY` and may overlap, which is the intended behavior.
 *
 * DUPLICATED LANE DEFAULT — deliberate, not an oversight. `seg.lane ?? 0` is
 * read inline here rather than through the editor's `laneOf()`
 * (editor/src/video/captionLanes.ts), because timeline-core is a standalone
 * package and cannot import from the editor package. The caption templates
 * under render/templates/captions/*.jsx duplicate it for the same reason
 * (standalone JSX evaluated in a browser/Puppeteer context). Note the one
 * divergence: `laneOf()` additionally coerces negative / non-integer /
 * non-finite stored lanes to a safe array index, because it feeds array
 * indexing; here a lane is only ever a sort key, so a hand-edited bad value
 * degrades to an ordering quirk rather than a crash and needs no coercion.
 *
 * Returns a NEW array (never `captions.segments` itself, and never sorted in
 * place), holding the ORIGINAL segment objects by reference. `[]` when nothing
 * matches — the plural's counterpart to the singular's `null`.
 *
 * Generic in the segment type — unlike the singular, whose signature predates
 * this and is deliberately left alone. Consumers hold a far richer segment
 * than the `start`/`end`/`lane` read here and need `id`/`text`/`words` back
 * out; `T` carries their own type straight through.
 *
 * @template {CaptionSegment} T
 * @param {{ segments?: ReadonlyArray<T> } | null | undefined} captions
 * @param {number} currentTime Timeline time, seconds — UNQUANTIZED; quantization happens inside.
 * @param {number} fps
 * @returns {T[]}
 */
export function activeCaptionSegments(captions, currentTime, fps) {
  const frame = Math.round(currentTime * fps)
  const t = fps > 0 ? frame / fps : 0
  const segments = captions?.segments ?? []
  /** @type {T[]} */
  const active = []
  for (const s of segments) {
    if (t >= (s.start ?? Number.NaN) && t < (s.end ?? Number.NaN)) active.push(s)
  }
  return active.sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0))
}
