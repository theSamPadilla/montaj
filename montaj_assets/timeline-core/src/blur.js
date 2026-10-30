// @ts-check
// montaj_assets/timeline-core/src/blur.js
//
// A clip's BLUR: a Gaussian blur over a video or image item's picture, the
// `blur` field. Static (no keyframes). Two engines draw it and read it here:
//
//   - the render engine (montaj_assets/render/item-blur.js), as ffmpeg `gblur`
//     on the fitted picture, before the box is padded
//   - the editor preview, as an SVG filter (`feGaussianBlur` and a
//     renormalisation) on the clip's media box, cut to the picture's rect in
//     the box (`pictureRectInBox`)
//
// ── Conventions ─────────────────────────────────────────────────────────────
//
//   1. `blur` is the Gaussian's standard deviation in pixels of the DESIGN
//      canvas, which is 1080 on its short edge (`designCanvas`), so a blur
//      looks the same at 1080x1920 and 2160x3840: on a w x h canvas the sigma
//      is `blur * min(w, h) / 1080` ({@link blurSigmaPx}).
//
//   2. THE PICTURE is what is blurred: the item's footage or image after its
//      crop and fit, inside its box, before the box's transparent padding. The
//      blur averages only the picture's own pixels: near an edge the weights
//      that fall outside it are dropped and the rest renormalised. So its
//      edges stay opaque and keep their colour (a blurred clip that fills the
//      frame never gets dark or see-through edges), and the item's own alpha
//      is kept as it was.
//
//   3. 0, absent or anything that is not a finite number is no blur. Above
//      {@link BLUR_MAX} is held to it (save refuses it: lib/overlay_validation.py).
//
//   4. THE TYPE, `blurType` ({@link BLUR_TYPES}; absent or unknown is
//      `uniform`):
//        - `uniform` blurs every direction alike;
//        - `linear` blurs along one direction only, `blurAngle` degrees
//          ({@link blurAngleOf}): 0 runs along the picture's x axis
//          (horizontal streaks), positive turns it clockwise on screen, as a
//          clip's `rotation` does, taken mod 180. `blur` is then the sigma
//          along that direction and there is no blur across it. The angle is
//          the picture's own, so it turns with the clip's rotation;
//        - `spin` turns about a centre, `blur` the sweep in degrees (0 to 180);
//        - `zoom` streaks out from a centre, `blur` in percent (0 to 200).
//      Spin and zoom's centre is `blurX`, `blurY` ({@link blurCenterOf}),
//      fractions of the clip's box as a mask's `x`, `y` are: 0 its left (top)
//      edge, 0.5 its centre, the default. Every field is static. The amount's
//      ceiling follows the type ({@link blurMaxOf}). Spin and zoom are not
//      drawn yet (render item-blur.js, editor itemBlur.tsx): both engines
//      draw them sharp.
//
// Pure like the rest of the package: no DOM, no I/O, no dependency.

/** The largest blur, in design-canvas pixels. lib/overlay_validation.py mirrors it. */
export const BLUR_MAX = 200

/** The blur types, the default first. lib/overlay_validation.py mirrors them. */
export const BLUR_TYPES = /** @type {const} */ (['uniform', 'linear', 'spin', 'zoom'])

/** Spin's largest sweep, in degrees. lib/overlay_validation.py mirrors it. */
export const BLUR_SPIN_MAX = 180

/** Zoom's largest amount, in percent. lib/overlay_validation.py mirrors it. */
export const BLUR_ZOOM_MAX = 200

/** The short edge of the design canvas the blur is measured on. */
const DESIGN_SHORT_EDGE = 1080

/**
 * The item's blur amount: its `blur` when that is a finite number above 0,
 * held to its type's ceiling ({@link blurMaxOf}); else 0. Design-canvas
 * pixels for uniform and linear, degrees for spin, percent for zoom.
 *
 * @param {{ blur?: unknown, blurType?: unknown } | null | undefined} item
 * @returns {number}
 */
export function blurOf(item) {
  const b = item?.blur
  if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) return 0
  return Math.min(blurMaxOf(blurTypeOf(item)), b)
}

/**
 * The largest amount a blur type takes: {@link BLUR_MAX} design pixels for
 * uniform and linear, {@link BLUR_SPIN_MAX} degrees for spin,
 * {@link BLUR_ZOOM_MAX} percent for zoom.
 *
 * @param {'uniform' | 'linear' | 'spin' | 'zoom'} type
 * @returns {number}
 */
export function blurMaxOf(type) {
  return type === 'spin' ? BLUR_SPIN_MAX : type === 'zoom' ? BLUR_ZOOM_MAX : BLUR_MAX
}

/**
 * The item's blur type: its `blurType` when that is one of {@link BLUR_TYPES},
 * else `uniform`.
 *
 * @param {{ blurType?: unknown } | null | undefined} item
 * @returns {'uniform' | 'linear' | 'spin' | 'zoom'}
 */
export function blurTypeOf(item) {
  const t = item?.blurType
  return t === 'linear' || t === 'spin' || t === 'zoom' ? t : 'uniform'
}

/**
 * A spin or zoom blur's centre, as fractions of the clip's box (a mask's `x`,
 * `y` convention): its `blurX`, `blurY` where each is a finite number, else
 * 0.5, the box's centre.
 *
 * @param {{ blurX?: unknown, blurY?: unknown } | null | undefined} item
 * @returns {{ x: number, y: number }}
 */
export function blurCenterOf(item) {
  const f = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0.5)
  return { x: f(item?.blurX), y: f(item?.blurY) }
}

/**
 * A linear blur's direction in degrees, in [0, 180): its `blurAngle` mod 180
 * (0 along x, positive clockwise on screen); 0 when that is not a finite number.
 *
 * @param {{ blurAngle?: unknown } | null | undefined} item
 * @returns {number}
 */
export function blurAngleOf(item) {
  const a = item?.blurAngle
  if (typeof a !== 'number' || !Number.isFinite(a)) return 0
  const r = ((a % 180) + 180) % 180
  return r >= 180 ? 0 : r
}

/**
 * The item's blur as a Gaussian sigma in pixels of a `canvasW` x `canvasH`
 * canvas: {@link blurOf} scaled from the 1080-short-edge design canvas. 0 for
 * no blur or a canvas with no size.
 *
 * @param {{ blur?: unknown, blurType?: unknown } | null | undefined} item
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
 * The widest sigma worth drawing on a `canvasW` x `canvasH` canvas: a third of
 * its longer side. A Gaussian that wide is a flat average of the picture, and
 * the export pads the picture by 3 sigma on every side, so past this the
 * padded frame grows without the result changing. The held-to-{@link BLUR_MAX}
 * sigma of a still box is always under it (200/1080 of the short edge); only
 * an animated box's per-frame sigma (scaled up as the box shrinks) can reach it.
 *
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {number}
 */
export function blurSigmaCapPx(canvasW, canvasH) {
  const long = Math.max(canvasW, canvasH)
  return Number.isFinite(long) && long > 0 ? (long - 1) / 3 : 0
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
