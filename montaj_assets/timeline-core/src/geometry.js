// @ts-check
// montaj_assets/timeline-core/src/geometry.js
//
// geometryFor — the shared percent-of-frame geometry primitive, plus two
// adapters that derive engine-specific numbers from it. This is the module
// that absorbs the formula that shipped IDENTICALLY in two places:
//
//   (1) render (pixels) — montaj_assets/render/encode-segment.js:
//       buildImageItemFilterParts, buildVideoItemFilterParts and
//       buildOverlayFilterParts (three copies, not two — the overlay copy
//       went undocumented until SP9a-1 closed it) all USED TO carry the SAME
//       five lines inline:
//
//           const s       = item.scale ?? 1
//           const scaledW = Math.round(vw * s / 2) * 2
//           const scaledH = Math.round(vh * s / 2) * 2
//           const xPx     = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0) / 100))
//           const yPx     = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0) / 100))
//
//   (2) editor (CSS %) — montaj_assets/editor/src/video/preview/transformStyle.ts,
//       `videoTransformBoxPct`:
//
//           return {
//             width: s * 100, height: s * 100,
//             left: ((1 - s) / 2) * 100 + ox, top: ((1 - s) / 2) * 100 + oy,
//           }
//
// The two are the SAME box, expressed in different units: render's `xPx` is
// exactly `vw * videoTransformBoxPct(t).left / 100`, and `scaledW` is exactly
// `vw * videoTransformBoxPct(t).width / 100` BEFORE render's extra
// even-pixel-rounding step. That identity is the whole point of extracting
// this module — see test/geometry.test.mjs's cross-check table, which is
// this package's headline test.
//
// SWITCHED OVER (SP9a-1, 2026-08-23): all four call sites now route through
// `toPixelBox`/`toCssBoxPct` instead of carrying their own copy —
// `encode-segment.js:245` (image), `:305` (video), `:457` (overlay), and
// `transformStyle.ts:36` (editor, via `videoTransformBoxPct`). Equivalence
// was proven first by a switchover sweep (`test/geometry.test.mjs`) and the
// `geometry-non-identity` encode-args golden, before any call site moved —
// see KNOWN-DIVERGENCES.md D9 for the closure record.
//
// ── Naming (three exports, one primitive + two adapters) ────────────────────
//
//   geometryFor(item, kind)        — the primitive. Frame-relative, engine-
//                                     agnostic: percents and ratios, no pixels,
//                                     no CSS units.
//   toCssBoxPct(geometry)          — the CSS-percent adapter. Mirrors
//                                     `videoTransformBoxPct` exactly. Consumed
//                                     by `transformStyle.ts`'s own
//                                     `videoTransformBoxPct` (`:36`), which now
//                                     delegates here instead of carrying the
//                                     formula itself.
//   toPixelBox(geometry, vw, vh)   — the ffmpeg-pixel adapter, including the
//                                     even-pixel rounding on width/height.
//                                     Mirrors the shared five-line formula
//                                     above. Consumed by all three render call
//                                     sites (`encode-segment.js:245/305/457`
//                                     — image, video, overlay).
//
// `videoTransformContainerStyle` (the CSS `translate()/scale()` STRING, with
// its `s===1 && ox===0 && oy===0 -> {}` early return) is NOT ported as a
// third adapter: it is a presentation micro-optimization (skip an inert CSS
// transform) layered on top of the same box-pct numbers `toCssBoxPct` already
// produces, not a distinct geometric derivation. It stays its own untouched
// function in `transformStyle.ts` even though `videoTransformBoxPct` next to
// it now delegates to `toCssBoxPct`; see the cross-check test for how the
// "identity" case is asserted consistent between the two views within this
// module alone.
//
// ── fit ───────────────────────────────────────────────────────────────────
//
//   video   — ALWAYS 'contain', regardless of what `item.fit` says. The video
//             branch of both buildVideoItemFilterParts (render) and the
//             editor's <video object-fit> path use
//             `force_original_aspect_ratio=decrease` / `object-fit: contain`
//             unconditionally; `item.fit` is never read for a video item
//             anywhere in the render pipeline. Fabricating tri-state fit for
//             video would imply a knob that does not exist.
//   image   — tri-state 'cover' | 'contain' | 'fill', default 'cover'.
//             encode-segment.js:169 `const fit = item.fit ?? 'cover'`;
//             render.js:599 `imageItems.push({ ...base, fit: item.fit ?? 'cover' })`;
//             editor OverlayItemsLayer.tsx:399/403 `item.fit ?? 'cover'`.
//   overlay — `undefined`. A JSX overlay is not a raster image being fit into
//             a box; buildOverlayFilterParts (encode-segment.js:425-478) never
//             reads a `fit` field at all — the overlay is scaled by `ov.scale`
//             from its 1080-design canvas to the output canvas, which is a
//             completely different operation from cover/contain/fill. Any
//             other kind is treated the same way (no fit concept fabricated).
//
// ── sourceCrop — forwarded verbatim (Bug B) ─────────────────────────────────
//
// render.js:620-627 (inside collectAllItems), verbatim comment:
//
//     // Source crop (clips workflow vertical reframe) — applied at encode
//     // time by buildVideoItemFilterParts. normalizeIfNeeded/normalize_window
//     // does NOT bake the crop into normalizedSrc (the cache stays at full
//     // source dimensions), so these MUST be forwarded or the crop is lost
//     // and the full frame is letterboxed into the output canvas instead.
//     sourceCrop:   item.sourceCrop,
//     sourceWidth:  item.sourceWidth,
//     sourceHeight: item.sourceHeight,
//
// `geometryFor` forwards `sourceCrop`/`sourceWidth`/`sourceHeight` BY
// REFERENCE — the same object, never cloned — mirroring the package-wide
// policy already established for `ResolvedItem.item` ("the ORIGINAL item
// object ... a reference, never a copy"). `geometryFor` never reads into or
// mutates `sourceCrop`, so a copy would buy nothing but allocation.
//
// MISSING-DIMS SILENT DROP (do NOT fix here — registry entry for T5's
// KNOWN-DIVERGENCES.md, "sourceCrop-missing-dims silent drop", owner
// SP3/SP4): `geometryFor` forwards `sourceCrop` even when `sourceWidth`/
// `sourceHeight` are absent — it has no opinion on that combination, it just
// reports what the item carries. The DROP happens one layer downstream, in
// encode-segment.js's `buildVideoItemFilterParts`:343 gate:
//
//     const sc = item.sourceCrop
//     if (sc && item.sourceWidth && item.sourceHeight) { ...crop filter... }
//
// i.e. a crop with no dims is silently SKIPPED by the render pixel path, not
// by this module. `toPixelBox` in this file does not implement that crop
// filter step at all (it only derives the scale/offset overlay box, the part
// of the formula shared with images) — the crop-specific ffmpeg
// `crop=cw:ch:cx:cy` math stays render's own concern, applied downstream of
// the same `toPixelBox(geometryFor(item, 'video'), vw, vh)` call at `:305`.
// See test/geometry.test.mjs for the test that documents (not fixes) this
// boundary.
//
// ── (0,0,1,1) preview short-circuit ──────────────────────────────────────────
//
// Lives in montaj_assets/editor/src/video/preview/sourceCropStyle.ts:35,
// INSIDE `sourceCropVideoStyle` (the CSS-adapter function itself, called from
// PreviewPlayer.tsx:126) — not at that function's call site:
//
//     // A full-frame crop (the default) needs no special handling.
//     if (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) return null
//
// `isFullFrameCrop` reproduces ONLY that check. `geometryFor` does NOT apply
// it — it forwards `sourceCrop` verbatim regardless of whether it is
// (0,0,1,1), matching where legacy applies the short-circuit (inside the
// downstream adapter, not at forwarding time). No consumer today —
// `sourceCropStyle.ts:35` still holds its own copy of this exact check
// inline. Switching it over is a behavior-change risk SP2 declined; owned by
// SP3/SP4. `isFullFrameCrop` does NOT also reproduce sourceCropStyle.ts:33's
// SEPARATE `crop.w <= 0 || crop.h <= 0` invalid-crop guard — that is a
// different predicate (validity, not full-frame-ness) and is out of scope
// here.
//
// ── opacity ──────────────────────────────────────────────────────────────────
//
// `item.opacity ?? 1`, forwarded uniformly for every kind. For image and
// video items this is genuinely consumed downstream: both
// buildImageItemFilterParts and buildVideoItemFilterParts (encode-segment.js)
// apply a `colorchannelmixer=aa=<opacity>` step whenever `|opacity - 1| >
// 0.001`. For an 'overlay' item, note honestly that `buildOverlayFilterParts`
// (encode-segment.js:425-478) never reads an opacity field at all — a
// puppeteer-rendered overlay's transparency, if any, is baked into its own
// JSX/WebM alpha channel, not driven by this field. `geometryFor` still
// forwards it (an authored value should not be silently dropped at this
// layer), but it is inert for overlays under render today. Not registered as
// a KNOWN-DIVERGENCES.md entry: there is no PREVIEW/RENDER pair that
// disagrees here, just a field that is a no-op for one kind.
//
// ── rotation — carried, never applied ────────────────────────────────────────
//
// OverlayItemsLayer.tsx:423 reads `item.rotation ?? 0` and the PREVIEW applies
// it to the on-canvas transform. RENDER NEVER READS `rotation` ANYWHERE:
// buildImageItemFilterParts, buildVideoItemFilterParts and
// buildOverlayFilterParts (encode-segment.js) have no rotation handling at
// all. An overlay rotated in the editor exports UN-ROTATED today. This is a
// named registry entry — KNOWN-DIVERGENCES.md entry 1, `rotation`, owner
// backlog/SP7.
// `geometryFor` CARRIES `item.rotation ?? 0` on the geometry so a future fix
// has somewhere to read it from, but `toPixelBox` — the render pixel adapter
// — MUST NOT consume it; see the test asserting exactly that.
//
// ── z-order ──────────────────────────────────────────────────────────────────
//
// geometryFor does not compute a z-index. Ordering is entirely
// activation.js's concern: `Scene.items` is already sorted `trackIdx`
// ascending (`byTrackIdx`), captions are always the topmost conceptual layer
// (`captionsLast` at the boundary/overlay level), and the render encoder
// composites ALL video/image items before ALL overlays regardless of
// trackIdx — a consumer-side compositing rule documented on activation.js's
// `Scene` typedef, not something this module re-derives.
//
// ── designCanvas — the 1080-short-edge rule ─────────────────────────────────
//
// design-canvas.ts:5-11 (editor) and render.js:263-269 (render, inline in
// `render()`, no equivalent named export) implement the IDENTICAL formula —
// confirmed by direct comparison, not assumed:
//
//     editor:  ratio = 1080 / min(w, h); [round(w*ratio/2)*2, round(h*ratio/2)*2]
//     render:  aspectRatio = 1080 / min(aspectW, aspectH);
//              renderWidth  = round(aspectW*aspectRatio/2)*2
//              renderHeight = round(aspectH*aspectRatio/2)*2
//
// They agree. This is a POSITIVE finding (no divergence to register), unlike
// most of the pairs this package ports.
//
// ── Purity ──────────────────────────────────────────────────────────────────
//
// No Date, no Math.random, no I/O, no globals, no mutation of the input item
// or of any `sourceCrop`/`resolution` array/object handed in. Same inputs
// always produce the same outputs.

/**
 * The subset of a timeline item that geometry math reads. Deliberately
 * structural and minimal, same stance as source-window.js and activation.js.
 *
 * @typedef {Object} GeometryItem
 * @property {number} [scale]        Multiplier on the frame's own size. Default 1.
 * @property {number} [offsetX]      Percent of frame WIDTH. Default 0.
 * @property {number} [offsetY]      Percent of frame HEIGHT. Default 0.
 * @property {number} [opacity]      0-1. Default 1.
 * @property {'cover' | 'contain' | 'fill'} [fit] Images only; ignored for video.
 * @property {{x: number, y: number, w: number, h: number}} [sourceCrop]
 *   Sub-rect of the SOURCE, as ratios of the source's own dimensions.
 *   Forwarded verbatim — see the module header.
 * @property {number} [sourceWidth]  Source intrinsic pixel width. Forwarded verbatim.
 * @property {number} [sourceHeight] Source intrinsic pixel height. Forwarded verbatim.
 * @property {number} [rotation]     Degrees. Carried, never applied — see the module header.
 */

/**
 * Frame-relative geometry for one item: percents and ratios, no pixels, no
 * CSS units. `toCssBoxPct` and `toPixelBox` derive engine-specific numbers
 * from this.
 *
 * @typedef {Object} Geometry
 * @property {number} scale    Multiplier on the frame's own size.
 * @property {number} offsetX  Percent of frame width.
 * @property {number} offsetY  Percent of frame height.
 * @property {number} opacity  0-1.
 * @property {'cover' | 'contain' | 'fill' | undefined} fit
 *   'contain' ALWAYS for video (never `item.fit`); the item's own tri-state
 *   (default 'cover') for image; `undefined` for overlay and anything else —
 *   see the module header for why each of these is honest, not fabricated.
 * @property {{x: number, y: number, w: number, h: number} | undefined} sourceCrop Forwarded verbatim, by reference.
 * @property {number | undefined} sourceWidth  Forwarded verbatim.
 * @property {number | undefined} sourceHeight Forwarded verbatim.
 * @property {number} rotation Degrees. Carried; the pixel adapter MUST ignore it — see the module header.
 */

/**
 * @param {GeometryItem} item
 * @param {import('./activation.js').ItemKind} kind
 * @returns {'cover' | 'contain' | 'fill' | undefined}
 */
function fitFor(item, kind) {
  if (kind === 'video') return 'contain'
  if (kind === 'image') return item.fit ?? 'cover'
  return undefined
}

/**
 * The shared percent-of-frame geometry for one item.
 *
 * WARNING for a future reader: `kind` currently affects only `fit` (via
 * `fitFor`), and `toPixelBox` ignores `fit` entirely, so passing the wrong
 * `kind` is undetectable on the pixel path today — swapping a call site from
 * `'image'` to `'video'` would leave all 364 render tests green. Every call
 * site passes the correct kind today, so this is not a defect, but it
 * becomes a live hazard the moment SP9b makes any geometry output
 * kind-dependent.
 *
 * @param {GeometryItem} item
 * @param {import('./activation.js').ItemKind} kind
 * @returns {Geometry}
 */
export function geometryFor(item, kind) {
  return {
    scale: item.scale ?? 1,
    offsetX: item.offsetX ?? 0,
    offsetY: item.offsetY ?? 0,
    opacity: item.opacity ?? 1,
    fit: fitFor(item, kind),
    sourceCrop: item.sourceCrop,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    rotation: item.rotation ?? 0,
  }
}

/**
 * The editor-CSS adapter. Verbatim port of `videoTransformBoxPct`
 * (transformStyle.ts): the frame-relative % rect the item's box occupies —
 * left/top/width/height, all as percentages of the frame's own dimensions.
 *
 * @param {Pick<Geometry, 'scale' | 'offsetX' | 'offsetY'>} geometry
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function toCssBoxPct(geometry) {
  const { scale: s, offsetX: ox, offsetY: oy } = geometry
  return {
    width: s * 100,
    height: s * 100,
    left: ((1 - s) / 2) * 100 + ox,
    top: ((1 - s) / 2) * 100 + oy,
  }
}

/**
 * The ffmpeg-pixel adapter. Verbatim port of the shared five-line formula in
 * buildImageItemFilterParts (encode-segment.js:154-159) and
 * buildVideoItemFilterParts (encode-segment.js:210-214), including the
 * even-pixel rounding on width/height — `Math.round(vw * s / 2) * 2` is NOT
 * the same as `Math.round(vw * s)`: the former always lands on an EVEN pixel
 * count (x264/yuv420 encoders reject odd dimensions), the latter does not.
 * See the cross-check table for a case where the two actually diverge.
 *
 * Does NOT include the `sourceCrop` ffmpeg `crop=cw:ch:cx:cy` step — that is
 * a separate filter-chain stage applied BEFORE this box's scale/pad step; see
 * the module header's "missing-dims silent drop" note for why it stays out
 * of scope here.
 *
 * @param {Pick<Geometry, 'scale' | 'offsetX' | 'offsetY'>} geometry
 * @param {number} vw Canvas width, pixels.
 * @param {number} vh Canvas height, pixels.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function toPixelBox(geometry, vw, vh) {
  const { scale: s, offsetX: ox, offsetY: oy } = geometry
  return {
    width: Math.round((vw * s) / 2) * 2,
    height: Math.round((vh * s) / 2) * 2,
    x: Math.round(vw * (0.5 * (1 - s) + ox / 100)),
    y: Math.round(vh * (0.5 * (1 - s) + oy / 100)),
  }
}

/**
 * Whether `crop` is the default full-frame crop, i.e. "no crop at all" —
 * verbatim port of sourceCropStyle.ts:35's check. See the module header for
 * exactly where legacy applies this (inside the CSS-adapter function, not at
 * its call site) and why the separate invalid-crop guard (`w <= 0 || h <= 0`)
 * is deliberately NOT folded into this predicate.
 *
 * @param {{x: number, y: number, w: number, h: number} | null | undefined} crop
 * @returns {boolean}
 */
export function isFullFrameCrop(crop) {
  return !!crop && crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1
}

/**
 * The 1080-short-edge overlay design canvas. Verbatim port of
 * design-canvas.ts:5-11 (`getOverlayDesignCanvas`), confirmed algebraically
 * identical to render.js:263-269's inline copy — see the module header.
 *
 * @param {readonly [number, number] | null | undefined} resolution
 * @returns {[number, number]}
 */
export function designCanvas(resolution) {
  const [w, h] = resolution ?? [1080, 1920]
  const ratio = 1080 / Math.min(w, h)
  return [Math.round((w * ratio) / 2) * 2, Math.round((h * ratio) / 2) * 2]
}
