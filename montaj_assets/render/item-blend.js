// montaj_assets/render/item-blend.js
//
// A clip's blend mode (§616): screen, multiply, add, lighten, darken or
// overlay, in place of the plain `overlay` that composites a normal clip.
//
// The blend runs in RGB, where the CSS formulas are defined, and is merged
// back by the clip's alpha IN THE CANVAS'S OWN FORMAT. The obvious graph
// converts the whole running composite to gbrp, blends, `maskedmerge`s by the
// alpha and converts back, and that moves every pixel of the backdrop, not
// just the ones under the clip: a 4:2:0 canvas loses chroma detail on the way
// up and back (measured on testsrc2, ffmpeg 8.1.2, 2026-10-28: max 23 code
// values on the 8-bit canvas, 183 on the 10-bit one, at colour edges; a flat
// colour survives exactly, which is why a grey test would not see it). Here
// the blended frame becomes the colour of a canvas-sized layer whose alpha is
// the clip's, and that layer goes onto the untouched backdrop with the same
// `overlay` a normal clip uses. Outside the clip the alpha is 0 and `overlay`
// leaves the backdrop's samples as they were, bit for bit, in either canvas;
// inside, `overlay` gives backdrop + alpha·(blend - backdrop), the CSS
// composite, with a clip's opacity already in its alpha.
//
// The clip is placed on a transparent canvas the size of the frame with the
// same `overlay=x=…:y=…` the plain composite would have used (expressions
// included, so an animated position moves identically). That canvas is in
// YUV and tagged like the real one, so the clip reaches it converted exactly
// as it reaches the real canvas; only then does the placed frame go to RGB.
// The placement is 8-bit on either canvas. ffmpeg 8.1.2's `overlay` onto a
// main with alpha unpremultiplies in 8-bit arithmetic, so on a 10-bit
// transparent main every partly transparent pixel came out at a quarter of
// its colour (measured: #c04020 at alpha 0.5 placed as 48,15,8). The plain
// composite already brings a 10-bit canvas and its clip to 8 bits
// (`overlay=format=yuv420`, measured: a 10-bit ramp leaves it in steps of 4),
// so an 8-bit placement loses nothing the plain composite keeps. Revisit both
// together if the plain composite ever goes 10-bit.
// Every YUV <-> RGB step names its matrix (BT.709, or BT.2020 on an HDR
// canvas) and range rather than leaving it to negotiation.
//
// The clip's alpha rides through `blend` itself rather than being split off
// and merged back: `alphamerge` has no 10-bit format (ffmpeg 8.1.2 narrows
// yuva444p10le to yuva444p and gbrap10le to argb, and argb -> yuva420p10le
// with BT.2020 came out 5 luma codes off, measured). So the backdrop goes to
// gbrap with an opaque alpha, the colour planes take the mode, and the alpha
// plane takes `darken`: min(opaque, clip alpha) is the clip's alpha exactly.
// The modes are named per plane because `all_mode` overrides `c3_mode`.
//
// Cost: every step works on the whole frame. At 3840x2160, 30 frames over a
// testsrc2 backdrop, the plain overlay ran 6.6 ms a frame and a screen-blended
// clip 52 ms (8-bit) / 55 ms (10-bit), sources included (ffmpeg 8.1.2,
// 2026-10-28). A still clip's work could be cropped to its box; not done here.
//
// `blend`'s FIRST input is its "top" (A). The backdrop goes first because
// ffmpeg's `overlay` mode conditions on A (A < 128 ? 2AB : screen) while CSS's
// conditions on the backdrop; every other mode here is symmetric.

/** The `blend` filter's name for each mode. */
const FFMPEG_MODE = Object.freeze({
  screen: 'screen', multiply: 'multiply', add: 'addition',
  lighten: 'lighten', darken: 'darken', overlay: 'overlay',
})

/** The `setparams` colorspace tag of each matrix the canvas can carry. */
const COLORSPACE_TAG = Object.freeze({ bt709: 'bt709', bt2020: 'bt2020nc' })

/**
 * The filter-graph parts that composite `item` over `backdrop` with a blend
 * mode, ending at `out`.
 *
 * @param {object} o
 * @param {string} o.backdrop Bracketed label of the running composite.
 * @param {string} o.item Bracketed label of the clip, opacity and mask applied.
 * @param {string} o.x The overlay's x, as the plain composite writes it (a number, or a quoted expression).
 * @param {string} o.y Likewise y.
 * @param {number} o.vw Canvas width.
 * @param {number} o.vh Canvas height.
 * @param {'screen'|'multiply'|'add'|'lighten'|'darken'|'overlay'} o.mode
 * @param {number} o.idx The clip's input index (the label suffix).
 * @param {boolean} o.tenBit A 10-bit canvas: blend in gbrap10le.
 * @param {'bt709'|'bt2020'} o.matrix The canvas's YUV matrix.
 * @param {string} o.canvasPixFmt The canvas pixel format (the segment's `outputPixFmt`).
 * @param {number|string} o.fps The canvas frame rate.
 * @param {number|string} o.duration The canvas duration, seconds.
 * @param {string} [o.overlayFormat] The `:format=…` the plain composite's overlay carries ('' for none).
 * @param {string} o.out Bracketed label for the result.
 * @returns {string[]}
 */
export function blendCompositeParts({ backdrop, item, x, y, vw, vh, mode, idx, tenBit, matrix, canvasPixFmt,
  fps, duration, overlayFormat = '', out }) {
  const ff = FFMPEG_MODE[mode]
  if (!ff) throw new Error(`blendCompositeParts: no blend mode "${mode}"`)
  const tag = COLORSPACE_TAG[matrix]
  if (!tag) throw new Error(`blendCompositeParts: no colour matrix "${matrix}"`)
  const n = idx
  const rgba = tenBit ? 'gbrap10le' : 'gbrap'
  // yuv420p -> yuva420p, yuv420p10le -> yuva420p10le: the canvas's own format with an alpha plane.
  const layerFmt = canvasPixFmt.replace(/^yuv/, 'yuva')
  const toRgb = `scale=in_color_matrix=${matrix}:out_color_matrix=${matrix}:in_range=tv`
  const toYuv = `scale=in_color_matrix=${matrix}:out_color_matrix=${matrix}:out_range=tv`
  return [
    `${backdrop}split=2[blk${n}][blb${n}]`,
    `[blb${n}]${toRgb},format=${rgba}[blg${n}]`,
    `color=c=black@0:s=${vw}x${vh}:r=${fps}:d=${duration},format=yuva444p,setparams=colorspace=${tag}:range=tv[blt${n}]`,
    `[blt${n}]${item}overlay=x=${x}:y=${y}:format=yuv444:shortest=0,${toRgb},format=${rgba}[blr${n}]`,
    `[blg${n}][blr${n}]blend=c0_mode=${ff}:c1_mode=${ff}:c2_mode=${ff}:c3_mode=darken,${toYuv},format=${layerFmt}[blx${n}]`,
    `[blk${n}][blx${n}]overlay=x=0:y=0${overlayFormat}:shortest=0${out}`,
  ]
}
