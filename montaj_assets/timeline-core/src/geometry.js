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
// `encode-segment.js:305` (image), `:375` (video), `:546` (overlay), and
// `transformStyle.ts:36` (editor, via `videoTransformBoxPct`). Equivalence
// was proven first by a switchover sweep (`test/geometry.test.mjs`) and the
// `geometry-non-identity` encode-args golden, before any call site moved —
// see KNOWN-DIVERGENCES.md D9 for the closure record.
//
// ── Naming (one primitive + three adapters) ─────────────────────────────────
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
//                                     sites (`encode-segment.js:305/375/546`
//                                     — image, video, overlay).
//   toRotatedPixelBox(g, vw, vh)   — the ROTATION-AWARE pixel adapter. A
//                                     SIBLING of `toPixelBox` that DELEGATES to
//                                     it for the unrotated numbers and adds the
//                                     grown bounding box plus the adjusted
//                                     top-left. See the rotation section below.
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
// the same `toPixelBox(geometryFor(item, 'video'), vw, vh)` call at `:375`.
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
// ── rotation — carried by geometryFor, applied by toRotatedPixelBox ──────────
//
// OverlayItemsLayer.tsx:423 reads `item.rotation ?? 0` and the PREVIEW applies
// it to the on-canvas transform. RENDER used to read `rotation` NOWHERE:
// buildImageItemFilterParts, buildVideoItemFilterParts and
// buildOverlayFilterParts (encode-segment.js) had no rotation handling at all,
// so an overlay rotated in the editor exported UN-ROTATED — KNOWN-DIVERGENCES.md
// entry 1, `rotation`.
//
// SP9a-2 closes the GEOMETRY half of that gap. `geometryFor` still CARRIES
// `item.rotation ?? 0` unchanged, and the two pre-existing adapters are
// unchanged too; the new numbers live in a fourth export.
//
//   `toPixelBox`        — the UNROTATED box. MUST NOT consume `rotation`.
//                         test/geometry.test.mjs pins that its output is
//                         identical for rotation 0 and rotation 90 and that it
//                         does not even expose a rotation field; SP9a-1's four
//                         switched-over call sites (encode-segment.js:305/375/546,
//                         transformStyle.ts:36) depend on exactly that contract,
//                         so it stays frozen. Do not "upgrade" it in place.
//   `toRotatedPixelBox` — the rotation-aware SIBLING. DELEGATES to `toPixelBox`
//                         for `scaledW`/`scaledH`/`xPx`/`yPx` — it never
//                         re-derives or duplicates that math, so both helpers
//                         produce the SAME integers from the SAME function —
//                         and adds the axis-aligned bounding box the rotated
//                         content grows into (`outW`/`outH`) plus the top-left
//                         that box must be composited at (`x`/`y`).
//
// The formula, verified empirically against ffmpeg 8.1.2 — do not re-derive:
//
//     rot  = ((r % 360) + 360) % 360        // 0 when r is not finite
//     a    = rot * PI / 180
//     outW = round((|scaledW*cos(a)| + |scaledH*sin(a)|) / 2) * 2
//     outH = round((|scaledW*sin(a)| + |scaledH*cos(a)|) / 2) * 2
//     x    = xPx - (outW - scaledW) / 2
//     y    = yPx - (outH - scaledH) / 2
//
// Three details that are load-bearing rather than incidental:
//
//   ROUND, NEVER CEIL, on the grown box. `Math.cos(PI/2)` is 6.1e-17, not 0, so
//   at r=90 a 180x320 box yields a raw height of 180.00000000000003. `ceil`
//   turns that float dust into a REAL 2px of padding (182); `round` gives the
//   exact 180. There is a named test for this.
//
//   The grown box is EVEN-rounded (`round(v/2)*2`, the same even-pixel discipline
//   `toPixelBox` applies, for the same x264/yuv420 reason) and `scaledW`/`scaledH`
//   are even by construction, so `(outW - scaledW)` is even and the halving in
//   `x`/`y` is an EXACT integer. That is the whole reason the grown box is
//   even-rounded — there is an invariant test pinning the integrality.
//
//   `x`/`y` are NOT even-rounded. Offsets carry no even-pixel requirement, and
//   quantizing them would both visibly snap position and break the
//   `rotation === 0 => x === toPixelBox().x` identity.
//
// At rotation 0 (and 360, and any non-finite value) the helper returns a FULL
// box, never `null`: `outW === scaledW`, `outH === scaledH`, `x === xPx`,
// `y === yPx`, `isIdentity === true`. Call sites read `.x`/`.y` unconditionally
// and branch only on whether to APPEND a rotate step. The identity falls out of
// the formula itself (`cos(0)` is exactly 1, `sin(0)` exactly 0, and an even
// `scaledW` survives `round(scaledW/2)*2` untouched) — there is no special case.
//
// Centre preservation is the point of the whole design: substituting `x` gives
// `x + outW/2 === xPx + scaledW/2` exactly, i.e. the box grows symmetrically
// around the centre the unrotated box already had, so rotation never translates
// the content. Pinned by a test.
//
// BOUNDARY: timeline-core owns the NUMBERS only. `rotationDeg` is emitted as the
// normalized [0,360) DEGREE value; turning it into an ffmpeg `rotate=` step
// (radians, `ow`/`oh`, `fillcolor`) is encode-segment.js's job. No ffmpeg filter
// syntax lives in this package.
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
// ── keyframes — geometryAt is the ANIMATED sibling of geometryFor (SP9b) ─────
//
// `geometryFor(item, kind)` answers "where is this item", full stop. SP9b adds
// keyframed properties, so the honest question becomes "where is this item AT
// THIS INSTANT" — and that is `geometryAt(item, kind, localT)`.
//
// `localT` is ITEM-RELATIVE seconds (0 = the item's own `start`), the same
// convention src/curves.js fixes and for the same reason: an item dragged
// along the timeline carries its animation with it, unchanged.
//
// The parity contract is the whole point. Curve evaluation lives ONLY in
// src/curves.js, and BOTH engines reach it through this ONE function — the
// editor preview samples `geometryAt` at the playhead, the render bake samples
// `geometryAt` per frame. Neither one interpolates anything itself. Any easing
// math that appears in the preview, the render shim or encode-segment.js is a
// PARITY BUG, not an optimization.
//
//   geometryFor(item, kind)          — the STATIC path. Its body is untouched
//                                      by SP9b, deliberately: see below.
//   geometryAt(item, kind, localT)   — the animated path. For each of the five
//                                      keyframeable props it prefers
//                                      `sampleTrack(track, localT)` and falls
//                                      back to the item's static scalar; every
//                                      other field is built exactly as
//                                      `geometryFor` builds it.
//
// NO-KEYFRAME IDENTITY, BY CONSTRUCTION. An item with no `keyframes` does not
// take a parallel code path through `geometryAt` — it is handed to
// `geometryFor` itself, the same function, so the two CANNOT drift. That
// matters beyond tidiness: a project without keyframes must produce a
// byte-identical ffmpeg filter graph, which is what keeps the render goldens
// valid. Do not "simplify" that short-circuit into a duplicated object
// literal, and do not reroute `geometryFor` through `geometryAt`.
//
// Only the five props src/curves.js names (`offsetX`, `offsetY`, `scale`,
// `rotation`, `opacity`) are animatable. `fit`, `sourceCrop`, `sourceWidth`
// and `sourceHeight` are NOT keyframeable and are forwarded exactly as the
// static path forwards them — `sourceCrop` still BY REFERENCE, never cloned.
// A track naming any other prop is simply never consulted.
//
// The fallback is `??`, never `||`: `sampleTrack` returns the `undefined`
// sentinel for "no track", and 0 is an ordinary sampled value (opacity 0,
// offset 0). `||` would silently discard a legitimately animated 0 and snap
// the item back to its static scalar — an animation that fades to invisible
// would flash fully opaque on the last frame instead.
//
// ── Purity ──────────────────────────────────────────────────────────────────
//
// No Date, no Math.random, no I/O, no globals, no mutation of the input item
// or of any `sourceCrop`/`resolution` array/object handed in. Same inputs
// always produce the same outputs.

import { sampleTrack } from './curves.js'

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
 * @property {number} [rotation]     Degrees. Carried by `geometryFor`, consumed
 *   ONLY by `toRotatedPixelBox` — see the module header.
 * @property {import('./curves.js').KeyframeTrack[]} [keyframes]
 *   Per-property animation, at most one track per prop. Read ONLY by
 *   `geometryAt`; `geometryFor` does not know this field exists. Absent (the
 *   overwhelmingly common case) means the item is static — see the module
 *   header's no-keyframe identity note.
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
 * @property {number} rotation Degrees, as authored (NOT normalized here).
 *   `toPixelBox` and `toCssBoxPct` MUST ignore it; `toRotatedPixelBox` is the
 *   one adapter that consumes it — see the module header.
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
 * The track driving `prop`, or `undefined` if the item does not animate it.
 *
 * FIRST wins if a malformed item somehow carries two tracks for one prop — the
 * `.find()` reading, which is what a reader expects. Written as a plain indexed
 * loop rather than `.find()` because this is called five times per item per
 * frame on both the preview and the bake path, and `.find()` allocates a
 * closure every call. Tracks are tiny (at most five, one per animatable prop),
 * so five scans of the array cost less than the closures would.
 *
 * @param {import('./curves.js').KeyframeTrack[]} tracks
 * @param {import('./curves.js').KeyframeProp} prop
 * @returns {import('./curves.js').KeyframeTrack | undefined}
 */
function trackFor(tracks, prop) {
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    if (track && track.prop === prop) return track
  }
  return undefined
}

/**
 * The shared percent-of-frame geometry for one item AT ONE INSTANT — the
 * animated sibling of {@link geometryFor}.
 *
 * WHY THIS EXISTS: keyframed properties have to move identically in the editor
 * preview and in the ffmpeg render, and the only way to guarantee that is for
 * both engines to ask the SAME function for the SAME instant. The preview
 * samples this at the playhead; the render bake samples it per frame. Curve
 * evaluation itself lives in src/curves.js and nowhere else — any easing math
 * that turns up in the preview, the render shim or encode-segment.js is a
 * PARITY BUG, not a local optimization. See the module header.
 *
 * `localT` is ITEM-RELATIVE seconds (0 = the item's own `start`), matching
 * src/curves.js's convention 1, so moving an item along the timeline carries
 * its animation with it unchanged. `resolveItem` (activation.js) already
 * computes exactly this quantity as `max(0, t - item.start)` and passes it
 * straight through.
 *
 * An item with no keyframes is handed to {@link geometryFor} ITSELF — the same
 * function, not a copy of its body — so the static path is identical BY
 * CONSTRUCTION and a keyframe-free project keeps producing a byte-identical
 * filter graph. Only the five props src/curves.js names can be animated;
 * `fit`/`sourceCrop`/`sourceWidth`/`sourceHeight` are forwarded exactly as the
 * static path forwards them (`sourceCrop` by reference, never cloned).
 *
 * @param {GeometryItem} item
 * @param {import('./activation.js').ItemKind} kind
 * @param {number} localT Seconds from the ITEM's own `start`, not timeline
 *   time. A non-finite value is not an error: `sampleTrack` reads it as
 *   "before the first keyframe".
 * @returns {Geometry}
 */
export function geometryAt(item, kind, localT) {
  const tracks = item.keyframes
  // The static path is `geometryFor` itself, not a re-implementation of it.
  if (!Array.isArray(tracks) || tracks.length === 0) return geometryFor(item, kind)

  // `??`, never `||`: `sampleTrack`'s "no track" sentinel is `undefined`, and a
  // sampled 0 (opacity 0, offset 0) is an ordinary value that must survive.
  return {
    scale: sampleTrack(trackFor(tracks, 'scale'), localT) ?? item.scale ?? 1,
    offsetX: sampleTrack(trackFor(tracks, 'offsetX'), localT) ?? item.offsetX ?? 0,
    offsetY: sampleTrack(trackFor(tracks, 'offsetY'), localT) ?? item.offsetY ?? 0,
    opacity: sampleTrack(trackFor(tracks, 'opacity'), localT) ?? item.opacity ?? 1,
    fit: fitFor(item, kind),
    sourceCrop: item.sourceCrop,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    rotation: sampleTrack(trackFor(tracks, 'rotation'), localT) ?? item.rotation ?? 0,
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
 * The rotated placement of one item, in pixels.
 *
 * `scaledW`/`scaledH`/`xPx`/`yPx` are exactly `toPixelBox`'s
 * `width`/`height`/`x`/`y` (this box DELEGATES, it does not re-derive them);
 * `outW`/`outH`/`x`/`y` describe the axis-aligned bounding box the rotated
 * content occupies and where that grown box is composited.
 *
 * @typedef {Object} RotatedPixelBox
 * @property {number} scaledW     Unrotated width, even. Straight from `toPixelBox`.
 * @property {number} scaledH     Unrotated height, even. Straight from `toPixelBox`.
 * @property {number} xPx         Unrotated left. Straight from `toPixelBox`.
 * @property {number} yPx         Unrotated top. Straight from `toPixelBox`.
 * @property {number} outW        Bounding-box width after rotation, even-rounded.
 * @property {number} outH        Bounding-box height after rotation, even-rounded.
 * @property {number} x           Left of the GROWN box. Exact integer; NOT even-rounded.
 * @property {number} y           Top of the GROWN box. Exact integer; NOT even-rounded.
 * @property {number} rotationDeg Normalized rotation in [0, 360) degrees. Not radians,
 *   not a filter string — the consumer formats it (see the module header's BOUNDARY note).
 * @property {boolean} isIdentity `rotationDeg === 0`, i.e. the grown box IS the
 *   unrotated box and no rotate step needs appending.
 */

/**
 * The rotation-aware sibling of {@link toPixelBox}: the same unrotated numbers
 * (obtained by DELEGATING to it — never by duplicating its math) plus the
 * grown bounding box and the adjusted top-left that keeps the CENTRE fixed.
 *
 * Always returns a full box, never `null`: at rotation 0/360/absent/non-finite
 * the grown box IS the unrotated box and `isIdentity` is true, so a call site
 * can read `.x`/`.y` unconditionally and branch only on whether to append a
 * rotate step.
 *
 * `toPixelBox` itself is deliberately left rotation-blind — see the module
 * header for why that contract is frozen, why the grown box is `round`ed and
 * never `ceil`ed, and why `x`/`y` are not even-rounded.
 *
 * @param {Pick<Geometry, 'scale' | 'offsetX' | 'offsetY'> & { rotation?: number }} geometry
 * @param {number} vw Canvas width, pixels.
 * @param {number} vh Canvas height, pixels.
 * @returns {RotatedPixelBox}
 */
export function toRotatedPixelBox(geometry, vw, vh) {
  // Delegate: the unrotated numbers come from the ONE function that owns them.
  const { width: scaledW, height: scaledH, x: xPx, y: yPx } = toPixelBox(geometry, vw, vh)

  const r = geometry.rotation
  // Non-finite (undefined/NaN/±Infinity) collapses to 0 rather than poisoning
  // the whole box with NaN — an unreadable rotation means "not rotated".
  const rot = Number.isFinite(r) ? ((/** @type {number} */ (r) % 360) + 360) % 360 : 0
  const a = (rot * Math.PI) / 180

  // Even-rounded so that (outW - scaledW) is even and the halving below is an
  // exact integer. `round`, NEVER `ceil` — see the module header.
  const outW = Math.round((Math.abs(scaledW * Math.cos(a)) + Math.abs(scaledH * Math.sin(a))) / 2) * 2
  const outH = Math.round((Math.abs(scaledW * Math.sin(a)) + Math.abs(scaledH * Math.cos(a))) / 2) * 2

  return {
    scaledW,
    scaledH,
    xPx,
    yPx,
    outW,
    outH,
    // Grow symmetrically about the unrotated centre: x + outW/2 === xPx + scaledW/2.
    x: xPx - (outW - scaledW) / 2,
    y: yPx - (outH - scaledH) / 2,
    rotationDeg: rot,
    isIdentity: rot === 0,
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
