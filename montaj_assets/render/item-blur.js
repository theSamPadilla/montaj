// montaj_assets/render/item-blur.js
//
// A clip's blur: a Gaussian blur over a video or image item's picture, the
// `blur` field (timeline-core src/blur.js, the sigma on the 1080-short-edge
// design canvas). Emitted only when the item has a blur, so every graph
// without one stays byte-identical.
//
// WHAT it computes: a blur that averages only the picture's own pixels. Near
// an edge the Gaussian's weights that fall outside the picture are dropped and
// the rest renormalised, so the picture's edges stay opaque and keep their own
// colour: a blurred clip that fills the frame never gets dark or see-through
// edges. And the clip's alpha is restored after, so the blur never makes it
// more or less see-through.
//
// HOW: the picture is padded with a transparent margin (3 sigma, plus one),
// blurred with its alpha (`gblur` on every plane, so colour and alpha are
// blurred alike and the transparent margin weighs 0), and `unpremultiply`
// divides the colour by the blurred alpha: that is exactly sum(w * c) / sum(w)
// over the picture's pixels. The margin is cropped off and the original alpha
// put back (`mergeplanes`, the blurred frame FIRST: with the cropped frame as
// its second input mergeplanes read the wrong pixels, measured on ffmpeg 8.1.2),
// or, for an opaque clip, dropped.
//
// The editor preview computes the same thing with SVG (editor
// src/video/preview/itemBlur.tsx): the source cut to the picture's rect,
// `feGaussianBlur` on premultiplied pixels, `feColorMatrix` (which works on
// unpremultiplied colour, so it divides by the blurred alpha) setting alpha to
// 1, `feComposite in` the cut source putting the alpha back. Measured in
// Chromium against this graph: within 9 codes, mean under 2, edge rows equal
// (render/test/item-blur-preview-parity.test.mjs). `edgeMode="duplicate"` on
// feGaussianBlur (repeat the edge pixel, which is what plain `gblur` does at a
// frame edge) is ignored by Chromium (measured: identical to "none"), hence
// the renormalised blur in both engines.
//
// RELIANCE (ffmpeg 8.1, measured): a straight-alpha source (PNG, ProRes 4444)
// keeps whatever colour sits under alpha 0, often white. The straight ->
// premultiplied conversion happens IMPLICITLY, ahead of `unpremultiply`, when
// ffmpeg wires the format filters, so that colour is zeroed before the blur
// and does not bleed into the opaque side. Nothing here asks for it. The test
// "transparent white under a clip's alpha does not halo" in
// test/item-blur.test.mjs fails if a build stops doing so.
//
// WHERE (encode-segment.js): on the fitted picture, before the box's
// transparent padding (a video's `pad`, an image's `contain` pad), so the
// picture's edges are the edges it renormalises at.
//
// FORMAT: 4:4:4 with an alpha plane, 16 bits (yuva444p16le for a video,
// gbrap16le for an image). 4:4:4 because `gblur` blurs every plane with one
// sigma in that plane's own pixels, so on 4:2:0 the chroma would blur twice as
// far as the luma (measured: a chroma edge 40 luma px wide against the luma's
// 18 at sigma 10). 16 bits because the division by the blurred alpha
// magnifies the rounding of the premultiplied colour: in 8 bits a corner
// (alpha 1/4) came out 5 codes off; gblur works in float, so 16 bits costs
// nothing (measured at 1080x1920: 2.4 s for 60 frames either way).
// `unpremultiply` handles YUV's offsets itself (measured: the YUV graph lands
// within 10 codes of the RGB one, corners included).
//
// STEPS: `gblur` runs that many recursive passes. 3 is within 2 codes of a
// true Gaussian inside the picture on a hard step and within 6 of the
// preview's (6 is within 1 and 6, at twice the cost: 75 ms against 140 ms a
// frame at 3456x1944 4:4:4, 12 cores, loaded).
//
// LINEAR (`blurType: 'linear'`, timeline-core blurAngleOf): a Gaussian along
// one direction only. gblur blurs along x alone with `sigmaV=0` (measured on
// 8.1: no vertical change at all), so the picture is turned by -angle
// (`rotate`, into a larger canvas filled transparent, after two pixels of
// transparent pad), blurred along x with the same transparent margin, turned
// back by +angle onto its own size, and then unpremultiplied. Every step is linear on premultiplied pixels (rotate
// takes any alpha mode, so ffmpeg premultiplies once at the head, as above),
// so the division still gives the average over the picture's own pixels. The
// canvas is sized from the picture's size where the caller knows it (o.picture
// `exact`), else from the largest picture its box can hold; turning back by
// the same amounts gives the input size exactly, so a loose canvas only costs
// time. At 0 and 90 degrees there is no turn: gblur's own axis, padded along
// it. rotate takes no gbrap16le (ffmpeg would convert around it), so a turned
// image blurs in yuva444p16le. A pre-scale (o.unitX, o.unitY) stretches the
// direction: the angle and sigma on the footage are the canvas's mapped
// through it, which is exact for an axis-aligned scale.
//
// A box whose SIZE animates is fitted at its peak and resized after
// (encode-segment.js `animatedGeometry`), so a blur on the peak box would
// shrink with the box. Its sigma is sampled per frame, scaled by peak / box,
// and sent with `sendcmd`, as a keyframed opacity is (item-opacity.js).
import { blurAngleOf, blurSigmaCapPx, blurSigmaPx, blurTypeOf, geometryAt, toPixelBox } from '@bycrux/timeline-core'

/** gblur's passes. See the header. */
export const BLUR_STEPS = 3

/** gblur's own ceiling on sigma. */
const GBLUR_MAX_SIGMA = 1024

const clampSigma = (s, cap = GBLUR_MAX_SIGMA) => Math.min(GBLUR_MAX_SIGMA, cap, Math.max(0, s))

/** The same format without its alpha plane: yuva444p16le -> yuv444p16le, gbrap16le -> gbrp16le. */
function withoutAlpha(format) {
  return format.startsWith('yuva') ? 'yuv' + format.slice(4) : format.replace(/^gbrap/, 'gbrp')
}

/**
 * The filter-graph fragment for an item's blur, or '' when it has none. It is
 * a chain fragment: it continues the chain it is spliced into, with no
 * leading or trailing comma, and with `alpha` it holds its own `;` and labels.
 *
 * @param {object} item The timeline item (reads `blur`; `keyframes` when animated).
 * @param {object} o
 * @param {number} o.vw Canvas width.
 * @param {number} o.vh Canvas height.
 * @param {string} o.format A 4:4:4 pixel format with an alpha plane (VIDEO_BLUR_FORMAT, IMAGE_BLUR_FORMAT).
 * @param {boolean} [o.alpha] Put the stream's own alpha back after (an image, a clip with alpha); without it
 *   the result is opaque, in `format` without its alpha plane.
 * @param {string} o.name Unique in the graph: names the labels and the gblur instance.
 * @param {number} [o.unitX] Pixels where the blur runs per canvas pixel, across (below 1 when it runs on
 *   the footage before an upscale). 1 when absent.
 * @param {number} [o.unitY] The same, down.
 * @param {{ kind: 'video' | 'image', peakW: number, peakH: number, offset: number, duration: number,
 *   fps: number }} [o.animated] The box's size animates: the blur runs at the peak box, and its sigma follows
 *   the box frame by frame. `offset` is item-relative seconds at the graph's t = 0.
 * @param {{ w: number, h: number, exact?: boolean }} [o.picture] A linear blur's picture, in the pixels the
 *   blur runs in: its size (`exact`), or the box it is contain-fitted in. Sizes the turned canvas only.
 *   The canvas (vw x vh, times the units) when absent.
 * @returns {string}
 */
export function blurFilterStep(item, { vw, vh, format, alpha = false, name, unitX = 1, unitY = 1, animated, picture } = {}) {
  const type = blurTypeOf(item)
  // SPIN AND ZOOM PLUG IN HERE. They are not drawn yet: until they are, a
  // spin or zoom clip renders as a uniform blur of sigma 0, i.e. sharp, and
  // the graph is the unblurred one (callers splice nothing for ''). Pinned by
  // test/item-blur.test.mjs "spin and zoom are not drawn yet".
  if (type === 'spin' || type === 'zoom') return ''
  const sigma = blurSigmaPx(item, vw, vh)
  if (!(sigma > 0)) return ''
  if (type === 'linear') {
    return linearBlurStep(item, sigma, { vw, vh, format, alpha, name, unitX, unitY, animated, picture })
  }

  // An animated box scales the sigma by peak / box, which blows up on a box
  // near 0 (a pop-in from scale 0.01): the margin below is 3 sigma, so an
  // uncapped sigma makes a frame several times the picture. A blur a third of
  // the picture's longer side wide is a flat average, so it is capped there,
  // in the pixel space the blur runs in (pre-scale footage is smaller).
  const capCanvas = blurSigmaCapPx(vw, vh)
  const capX = capCanvas * unitX
  const capY = capCanvas * unitY
  const fmtX = (s) => clampSigma(s, capX).toFixed(4)
  const fmtY = (s) => clampSigma(s, capY).toFixed(4)
  let blur
  let maxSigma
  if (!animated) {
    const sx = fmtX(sigma * unitX)
    const sy = fmtY(sigma * unitY)
    blur = `gblur=sigma=${sx}${sy !== sx ? `:sigmaV=${sy}` : ''}:steps=${BLUR_STEPS}`
    maxSigma = Math.max(clampSigma(sigma * unitX, capX), clampSigma(sigma * unitY, capY))
  } else {
    const { kind, peakW, peakH, offset, duration, fps } = animated
    const target = `gblur@${name}`
    const at = (k) => {
      const b = toPixelBox(geometryAt(item, kind, offset + k / fps), vw, vh)
      const x = clampSigma(b.width > 0 ? sigma * unitX * peakW / b.width : sigma * unitX, capX)
      const y = clampSigma(b.height > 0 ? sigma * unitY * peakH / b.height : sigma * unitY, capY)
      return { x, y, sx: x.toFixed(4), sy: y.toFixed(4) }
    }
    const first = at(0)
    maxSigma = Math.max(first.x, first.y)
    const cmds = []
    let last = first
    const frames = Math.max(0, Math.round(duration * fps))
    for (let k = 1; k <= frames; k++) {
      const v = at(k)
      maxSigma = Math.max(maxSigma, v.x, v.y)
      if (v.sx === last.sx && v.sy === last.sy) continue
      cmds.push(`${(k / fps).toFixed(6)} ${target} sigma ${v.sx},${target} sigmaV ${v.sy}`)
      last = v
    }
    const head = cmds.length ? `sendcmd=c='${cmds.join(';')}',` : ''
    blur = `${head}${target}=sigma=${first.sx}:sigmaV=${first.sy}:steps=${BLUR_STEPS}`
  }

  // A transparent margin past every edge, wide enough that the Gaussian's
  // weight beyond it is nothing; it weighs 0 in the average and is cropped off.
  const m = Math.ceil(3 * maxSigma) + 1
  const core = `pad=w=iw+${2 * m}:h=ih+${2 * m}:x=${m}:y=${m}:color=black@0,${blur},`
    + `unpremultiply=inplace=1,crop=w=iw-${2 * m}:h=ih-${2 * m}:x=${m}:y=${m}`
  return wrapCore(core, format, alpha, name)
}

/** The blur `core` in `format`, with the stream's own alpha put back (`alpha`) or dropped. */
function wrapCore(core, format, alpha, name) {
  if (!alpha) return `format=${format},${core},format=${withoutAlpha(format)}`
  const [orig, work, done] = [`[${name}a]`, `[${name}b]`, `[${name}c]`]
  return `format=${format},split=2${orig}${work};${work}${core}${done};`
    + `${done}${orig}mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=3:format=${format}`
}

/** The pixel formats rotate takes among the blur's (it takes no gbrap16le). */
const ROTATE_FORMATS = new Set(['yuva444p16le', 'yuva444p10le', 'yuva444p'])
/** What a turned linear blur runs in when `format` is not one rotate takes. */
const LINEAR_TURN_FORMAT = 'yuva444p16le'

/**
 * A linear blur (see the header): `blurFilterStep` for `blurType: 'linear'`.
 *
 * @param {object} item
 * @param {number} sigma The canvas sigma (blurSigmaPx).
 * @param {object} o blurFilterStep's options.
 * @returns {string}
 */
function linearBlurStep(item, sigma, { vw, vh, format, alpha, name, unitX, unitY, animated, picture }) {
  // The direction on the canvas, then in the pixels the blur runs in: a
  // pre-scale's units map it (and stretch the sigma by its length).
  const deg = blurAngleOf(item)
  const rad = (deg * Math.PI) / 180
  const dx = Math.cos(rad) * unitX
  const dy = Math.sin(rad) * unitY
  const stretch = Math.hypot(dx, dy)
  // The angle in the blur's pixels, in [0, 180), on a 1e-9 degree grid so 0 and 90 stay exact.
  let a = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 1e9) / 1e9
  if (a < 0) a += 180
  if (a >= 180) a -= 180
  const axis = a === 0 ? 'x' : a === 90 ? 'y' : null

  const cap = blurSigmaCapPx(vw, vh) * stretch
  const fmt = (s) => clampSigma(s, cap).toFixed(4)
  // gblur's own two sigmas: the direction's on its axis, 0 across it.
  const opt = axis === 'y' ? 'sigmaV' : 'sigma'
  const gb = (s) => axis === 'y' ? `sigma=0:sigmaV=${s}` : `sigma=${s}:sigmaV=0`
  let blur
  let maxSigma
  if (!animated) {
    maxSigma = clampSigma(sigma * stretch, cap)
    blur = `gblur=${gb(fmt(sigma * stretch))}:steps=${BLUR_STEPS}`
  } else {
    // The box keeps the canvas's aspect as it animates (encode-segment.js
    // animatedGeometry), so the peak / box factor is one number and the
    // direction holds; the factor along it is used all the same.
    const { kind, peakW, peakH, offset, duration, fps } = animated
    const target = `gblur@${name}`
    const at = (k) => {
      const b = toPixelBox(geometryAt(item, kind, offset + k / fps), vw, vh)
      const fx = b.width > 0 ? peakW / b.width : 1
      const fy = b.height > 0 ? peakH / b.height : 1
      const v = clampSigma(sigma * Math.hypot(dx * fx, dy * fy), cap)
      return { v, s: v.toFixed(4) }
    }
    const first = at(0)
    maxSigma = first.v
    const cmds = []
    let last = first
    const frames = Math.max(0, Math.round(duration * fps))
    for (let k = 1; k <= frames; k++) {
      const v = at(k)
      maxSigma = Math.max(maxSigma, v.v)
      if (v.s === last.s) continue
      cmds.push(`${(k / fps).toFixed(6)} ${target} ${opt} ${v.s}`)
      last = v
    }
    const head = cmds.length ? `sendcmd=c='${cmds.join(';')}',` : ''
    blur = `${head}${target}=${gb(first.s)}:steps=${BLUR_STEPS}`
  }

  // The transparent margin, along the blur only.
  const m = Math.ceil(3 * maxSigma) + 1
  if (axis === 'x') {
    return wrapCore(`pad=w=iw+${2 * m}:h=ih:x=${m}:y=0:color=black@0,${blur},`
      + `unpremultiply=inplace=1,crop=w=iw-${2 * m}:h=ih:x=${m}:y=0`, format, alpha, name)
  }
  if (axis === 'y') {
    return wrapCore(`pad=w=iw:h=ih+${2 * m}:x=0:y=${m}:color=black@0,${blur},`
      + `unpremultiply=inplace=1,crop=w=iw:h=ih-${2 * m}:x=0:y=${m}`, format, alpha, name)
  }

  // Turned. The canvas grows by 2 dw across and 2 dh down, enough to hold the
  // picture turned by -a, plus the margin across; turning back shrinks it by
  // the same, which is the input size whatever the picture's size was.
  const r = (a * Math.PI) / 180
  const c = Math.abs(Math.cos(r))
  const sn = Math.abs(Math.sin(r))
  const pw = picture?.w > 0 ? picture.w : vw * unitX
  const ph = picture?.h > 0 ? picture.h : vh * unitY
  // A picture of known size needs its own turned bounds. One contain-fitted in
  // a pw x ph box spans the box one way and anything up to it the other, and
  // the thinnest such picture turned needs ph sin across and pw sin down.
  const growW = picture?.exact ? pw * c + ph * sn - pw : ph * sn
  const growH = picture?.exact ? pw * sn + ph * c - ph : pw * sn
  const dw = Math.max(0, Math.ceil(growW / 2)) + 2 + m
  const dh = Math.max(0, Math.ceil(growH / 2)) + 2
  const ang = r.toFixed(9)
  const turnFormat = ROTATE_FORMATS.has(format) ? format : LINEAR_TURN_FORMAT
  // Two pixels of transparent pad first. rotate's bilinear read clamps the
  // pixel index but not the fraction, so a sample within a pixel left of or
  // above the first one reads the first TWO pixels, and one past the last
  // row or column repeats it (vf_rotate.c, measured on 8.1): the picture's
  // edge moved, its edge rows 6 to 7 codes (mean) off a true directional
  // blur. Two transparent pixels on every side make both edges fade into
  // transparency alike: 3 at the top and left, 2 at the bottom and right.
  return wrapCore(`pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0,rotate=a=-${ang}:ow=iw+${2 * dw}:oh=ih+${2 * dh}:c=black@0,`
    + `${blur},rotate=a=${ang}:ow=iw-${2 * dw}:oh=ih-${2 * dh}:c=black@0,unpremultiply=inplace=1,crop=w=iw-4:h=ih-4:x=2:y=2`,
  turnFormat, alpha, name)
}

/** The format a video item's blur runs in. See the header. */
export const VIDEO_BLUR_FORMAT = 'yuva444p16le'

/** The format an image item's blur runs in (planar RGB: the image chain is RGBA). */
export const IMAGE_BLUR_FORMAT = 'gbrap16le'
