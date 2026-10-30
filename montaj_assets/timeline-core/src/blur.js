// @ts-check
// montaj_assets/timeline-core/src/blur.js
//
// A clip's BLUR: a Gaussian blur over a video or image item's picture, the
// `blur` field. Static (no keyframes). Two engines draw it and read it here:
//
//   - the render engine (montaj_assets/render/item-blur.js), as ffmpeg `gblur`
//     on the fitted picture, before the box is padded
//   - the editor preview, as an SVG `feGaussianBlur` with `edgeMode="duplicate"`
//     whose filter region is the picture's rect in its box
//
// ── Conventions ─────────────────────────────────────────────────────────────
//
//   1. `blur` is the Gaussian's standard deviation in pixels of the DESIGN
//      canvas, which is 1080 on its short edge (`designCanvas`), so a blur
//      looks the same at 1080x1920 and 2160x3840: on a w x h canvas the sigma
//      is `blur * min(w, h) / 1080` ({@link blurSigmaPx}).
//
//   2. THE PICTURE is what is blurred: the item's footage or image after its
//      crop and fit, inside its box, before the box's transparent padding. Its
//      edges stay hard and opaque: past an edge the blur reads the edge pixel
//      again (ffmpeg's `gblur` does, measured within 5 codes on a hard step;
//      the preview's `edgeMode="duplicate"` does by definition). So a blurred
//      clip that fills the frame never gets dark or see-through edges.
//
//   3. 0, absent or anything that is not a finite number is no blur. Above
//      {@link BLUR_MAX} is held to it (save refuses it: lib/overlay_validation.py).
//
// Pure like the rest of the package: no DOM, no I/O, no dependency.

/** The largest blur, in design-canvas pixels. lib/overlay_validation.py mirrors it. */
export const BLUR_MAX = 200

/** The short edge of the design canvas the blur is measured on. */
const DESIGN_SHORT_EDGE = 1080

/**
 * The item's blur in design-canvas pixels: its `blur` when that is a finite
 * number above 0, held to {@link BLUR_MAX}; else 0.
 *
 * @param {{ blur?: unknown } | null | undefined} item
 * @returns {number}
 */
export function blurOf(item) {
  const b = item?.blur
  if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) return 0
  return Math.min(BLUR_MAX, b)
}

/**
 * The item's blur as a Gaussian sigma in pixels of a `canvasW` x `canvasH`
 * canvas: {@link blurOf} scaled from the 1080-short-edge design canvas. 0 for
 * no blur or a canvas with no size.
 *
 * @param {{ blur?: unknown } | null | undefined} item
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {number}
 */
export function blurSigmaPx(item, canvasW, canvasH) {
  const b = blurOf(item)
  const short = Math.min(canvasW, canvasH)
  if (b === 0 || !(short > 0) || !Number.isFinite(short)) return 0
  return (b * short) / DESIGN_SHORT_EDGE
}

/**
 * The rect a `srcW` x `srcH` picture fills when it is contain-fitted, centred,
 * into a `boxW` x `boxH` box, as fractions of the box: the render's
 * `scale=…:force_original_aspect_ratio=decrease` then `pad` for a video, and an
 * image's `contain` fit. The whole box `{0, 0, 1, 1}` when either size is
 * unknown or not positive (and for a picture of the box's own aspect).
 *
 * @param {number} boxW
 * @param {number} boxH
 * @param {number | null | undefined} srcW
 * @param {number | null | undefined} srcH
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function pictureRectInBox(boxW, boxH, srcW, srcH) {
  const ok = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isFinite(n) && n > 0
  if (!ok(boxW) || !ok(boxH) || !ok(srcW) || !ok(srcH)) return { x: 0, y: 0, w: 1, h: 1 }
  const boxAspect = boxW / boxH
  const srcAspect = /** @type {number} */ (srcW) / /** @type {number} */ (srcH)
  if (srcAspect > boxAspect) {
    const h = boxAspect / srcAspect
    return { x: 0, y: (1 - h) / 2, w: 1, h }
  }
  const w = srcAspect / boxAspect
  return { x: (1 - w) / 2, y: 0, w, h: 1 }
}
