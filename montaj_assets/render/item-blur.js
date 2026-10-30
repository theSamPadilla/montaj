// montaj_assets/render/item-blur.js
//
// A clip's blur: a Gaussian blur over a video or image item's picture, the
// `blur` field (timeline-core src/blur.js, the sigma on the 1080-short-edge
// design canvas). One `gblur` step, emitted only when the item has a blur, so
// every graph without one stays byte-identical.
//
// WHERE it goes (encode-segment.js): on the fitted picture, before the box's
// transparent padding (a video's `pad`, an image's `contain` pad). `gblur`
// reads past the frame's edge as the edge pixel again (measured on ffmpeg
// 8.1.2: within 5 codes of a clamped Gaussian on a hard step, 125 off a
// zero-padded one), so the picture's edges stay hard and opaque. Blurring the
// padded box instead would pull the transparent pad into the picture, and a
// blurred clip filling the frame would get see-through edges. The preview
// clamps at the same rect (`feGaussianBlur edgeMode="duplicate"`, its filter
// region the picture's rect in the box: timeline-core `pictureRectInBox`).
//
// FORMAT: `gblur` blurs every plane with one sigma in that plane's own pixels,
// so on 4:2:0 the chroma is blurred twice as far as the luma (measured: a
// chroma edge came out 40 luma px wide against the luma's 18 at sigma 10). The
// caller pins a 4:4:4 or RGB format first.
//
// STEPS: `gblur` runs that many recursive passes. 3 is within 2 codes of a
// true Gaussian inside the picture on a hard step (6 is within 1, at twice the
// cost: 75 ms against 140 ms a frame at 3456x1944 4:4:4, 12 cores, loaded).
// A picture blur, unlike the mask's feather band on a small shape (item-mask.js
// uses 6), has no thin feature for the passes to get wrong.
//
// A box whose SIZE animates is fitted at its peak and resized after
// (encode-segment.js `animatedGeometry`), so a blur on the peak box would
// shrink with the box. Its sigma is sampled per frame, scaled by peak / box,
// and sent with `sendcmd`, as a keyframed opacity is (item-opacity.js).
import { blurSigmaPx, geometryAt, toPixelBox } from '@bycrux/timeline-core'

/** gblur's passes. See the header. */
export const BLUR_STEPS = 3

/** gblur's own ceiling on sigma. */
const GBLUR_MAX_SIGMA = 1024

const fmt = (s) => Math.min(GBLUR_MAX_SIGMA, Math.max(0, s)).toFixed(4)

/**
 * The `gblur` step for an item's blur, or '' when it has none. No trailing
 * comma; with `format` it starts with that pin.
 *
 * @param {object} item The timeline item (reads `blur`; `keyframes` when animated).
 * @param {object} o
 * @param {number} o.vw Canvas width.
 * @param {number} o.vh Canvas height.
 * @param {string | null} [o.format] A 4:4:4 or RGB pixel format to pin first; none when the stream already is one.
 * @param {number} [o.unitX] Pixels where the blur runs per canvas pixel, across (below 1 when it runs on
 *   the footage before an upscale). 1 when absent.
 * @param {number} [o.unitY] The same, down.
 * @param {{ kind: 'video' | 'image', peakW: number, peakH: number, offset: number, duration: number,
 *   fps: number, name: string }} [o.animated] The box's size animates: the blur runs at the peak box, and
 *   its sigma follows the box frame by frame. `offset` is item-relative seconds at the graph's t = 0;
 *   `name` is unique in the graph.
 * @returns {string}
 */
export function blurFilterStep(item, { vw, vh, format = null, unitX = 1, unitY = 1, animated } = {}) {
  const sigma = blurSigmaPx(item, vw, vh)
  if (!(sigma > 0)) return ''
  const pin = format ? `format=${format},` : ''
  if (!animated) {
    const sx = fmt(sigma * unitX)
    const sy = fmt(sigma * unitY)
    return `${pin}gblur=sigma=${sx}${sy !== sx ? `:sigmaV=${sy}` : ''}:steps=${BLUR_STEPS}`
  }
  const { kind, peakW, peakH, offset, duration, fps, name } = animated
  const target = `gblur@${name}`
  const at = (k) => {
    const b = toPixelBox(geometryAt(item, kind, offset + k / fps), vw, vh)
    return {
      sx: fmt(b.width > 0 ? sigma * unitX * peakW / b.width : sigma * unitX),
      sy: fmt(b.height > 0 ? sigma * unitY * peakH / b.height : sigma * unitY),
    }
  }
  const first = at(0)
  const cmds = []
  let last = first
  const frames = Math.max(0, Math.round(duration * fps))
  for (let k = 1; k <= frames; k++) {
    const v = at(k)
    if (v.sx === last.sx && v.sy === last.sy) continue
    cmds.push(`${(k / fps).toFixed(6)} ${target} sigma ${v.sx},${target} sigmaV ${v.sy}`)
    last = v
  }
  const head = cmds.length ? `sendcmd=c='${cmds.join(';')}',` : ''
  return `${pin}${head}${target}=sigma=${first.sx}:sigmaV=${first.sy}:steps=${BLUR_STEPS}`
}

/**
 * The 4:4:4 format a video item's blur pins before `gblur`: 10-bit when the
 * stream is (a colour conversion ran, or the canvas is HDR), with an alpha
 * plane when the item carries one.
 *
 * @param {{ tenBit: boolean, alpha: boolean }} o
 * @returns {string}
 */
export function blurPixelFormat({ tenBit, alpha }) {
  return `yuv${alpha ? 'a' : ''}444p${tenBit ? '10le' : ''}`
}
