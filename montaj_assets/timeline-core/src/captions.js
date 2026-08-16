// @ts-check
// montaj_assets/timeline-core/src/captions.js
//
// activeCaptionSegment — frame-quantized caption segment selection.
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
