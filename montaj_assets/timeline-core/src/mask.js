// @ts-check
// montaj_assets/timeline-core/src/mask.js
//
// Compositing primitives for clips (§616): an item's MASK (ellipse, rounded
// rect or wipe, feathered, invertible, keyframable) and its BLEND MODE.
//
// Two engines draw a mask, and they must draw the SAME shape:
//
//   - the editor preview, which paints it as an SVG (`maskSvg`) used as a CSS
//     mask image over the clip's box
//   - the render engine, which rasterizes it to an alpha plane
//     (`rasterizeMask`) and merges it into the clip's alpha in ffmpeg
//
// Both read ONE polygon, {@link maskPolygon}, so the outline is the same
// vertex list in both: the SVG fills it, the rasterizer scan-converts it. The
// feather is the WIDTH of the soft band, centred on the outline (half inside,
// half outside), as a fraction of the box's shorter side. It is drawn as a
// Gaussian blur whose sigma is a quarter of that width ({@link maskSigmaPx}),
// so the band holds the falloff from about 2% to 98%; `feGaussianBlur` on one
// side and the render's blur on the other.
//
// ── Conventions ─────────────────────────────────────────────────────────────
//
//   1. THE BOX is the clip's own box before rotation, in pixels: an image's
//      fitted box, a video's padded box. Every mask fraction (x, y, w, h) and
//      the feather are relative to it, so a mask follows the clip when the
//      clip moves, scales or rotates.
//
//   2. Y IS DOWN and rotation is DEGREES CLOCKWISE on screen, about the mask's
//      own (x, y): `x' = cx + dx·cos θ - dy·sin θ`, `y' = cy + dx·sin θ + dy·cos θ`.
//
//   3. A WIPE is the half-plane `(px - x)·cos θ + (py - y)·sin θ <= 0`: its edge
//      passes through (x, y) at angle θ, and at rotation 0 the LEFT side shows.
//
//   4. Mask keyframe tracks (`maskX` ... `maskFeather`) override the matching
//      static field, and do nothing on an item with no valid `mask`.
//
// Pure like the rest of the package: no DOM, no I/O, no dependency.
//
// geometry.js must never import this module: this one imports geometry.js
// (for `fullOpacitySpans`), and the reverse would be an ESM cycle.

import { sampleTrack } from './curves.js'
import { fullOpacitySpans } from './geometry.js'

/**
 * @typedef {'ellipse' | 'rect' | 'wipe'} MaskShape
 */

/**
 * @typedef {'normal' | 'screen' | 'multiply' | 'add' | 'lighten' | 'darken' | 'overlay'} BlendMode
 */

/**
 * A mask as stored on an item. Every field but `shape` is optional.
 *
 * @typedef {Object} ItemMask
 * @property {MaskShape} shape
 * @property {number} [x] Centre (ellipse, rect) or a point on the edge (wipe), fraction of box width. Default 0.5.
 * @property {number} [y] The same, fraction of box height. Default 0.5.
 * @property {number} [w] Ellipse diameter / rect side, fraction of box width, > 0. Default 0.5. Wipe ignores.
 * @property {number} [h] The same, fraction of box height. Default 0.5.
 * @property {number} [rotation] Degrees clockwise about (x, y). Default 0.
 * @property {number} [radius] Rect only: corner radius, fraction of half the rect's shorter side, 0-1. Default 0.
 * @property {number} [feather] Width of the soft band centred on the edge, fraction of the box's shorter side, 0-1. Default 0.
 * @property {boolean} [invert] Default false.
 * @property {boolean} [enabled] Default true. `false` turns the mask off and keeps its settings.
 */

/**
 * A mask with every field resolved, as {@link maskAt} returns it. No
 * `enabled`: a mask that is off resolves to null.
 *
 * @typedef {Required<Omit<ItemMask, 'enabled'>>} ResolvedMask
 */

/**
 * The fields of an item this module reads.
 *
 * @typedef {Object} CompositeItem
 * @property {ItemMask | null} [mask]
 * @property {string | null} [blendMode]
 * @property {number | null} [opacity]
 * @property {import('./curves.js').KeyframeTrack[] | null} [keyframes]
 */

/** The mask shapes, in picker order. */
export const MASK_SHAPES = Object.freeze(/** @type {const} */ (['ellipse', 'rect', 'wipe']))

/** The blend modes, in picker order. `normal` is the default. */
export const BLEND_MODES = Object.freeze(/** @type {const} */ (
  ['normal', 'screen', 'multiply', 'add', 'lighten', 'darken', 'overlay']))

/** The keyframeable mask props. Each overrides one field of `mask` ({@link MASK_FIELD_OF}). */
export const MASK_KEYFRAME_PROPS = Object.freeze(/** @type {const} */ (
  ['maskX', 'maskY', 'maskW', 'maskH', 'maskRotation', 'maskFeather']))

/** The `mask` field each mask keyframe prop drives. */
export const MASK_FIELD_OF = Object.freeze(/** @type {const} */ ({
  maskX: 'x', maskY: 'y', maskW: 'w', maskH: 'h', maskRotation: 'rotation', maskFeather: 'feather',
}))

/** The ellipse's vertex count. */
const ELLIPSE_POINTS = 256
/** Arc points per rounded rect corner, both ends included. */
const CORNER_POINTS = 16
/** The smallest mask side, as a fraction of the box: a mask never collapses to nothing. */
const MIN_SIDE = 1e-4
/** Anti-aliasing sub-rows per pixel row in {@link rasterizeMask}. */
const SUB_ROWS = 4

const SHAPE_SET = new Set(/** @type {readonly string[]} */ (MASK_SHAPES))
const BLEND_SET = new Set(/** @type {readonly string[]} */ (BLEND_MODES))
const MASK_PROP_SET = new Set(/** @type {readonly string[]} */ (MASK_KEYFRAME_PROPS))

/**
 * The item's `mask` when it is an object with a known shape and is not
 * switched off (`enabled: false`), else null. Every reader goes through here,
 * so a mask that is off draws nothing anywhere and its tracks do nothing.
 *
 * @param {CompositeItem | null | undefined} item
 * @returns {ItemMask | null}
 */
function validMask(item) {
  const mask = item?.mask
  if (!mask || typeof mask !== 'object' || !SHAPE_SET.has(mask.shape) || mask.enabled === false) return null
  return mask
}

/**
 * The first track in `tracks` driving `prop`, or undefined. A local copy of
 * geometry.js's private `trackFor`: a plain loop, no closure per call.
 *
 * @param {import('./curves.js').KeyframeTrack[]} tracks
 * @param {string} prop
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
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * The item's mask at item-relative time `localT`, every field resolved, or
 * null when the item has no valid mask (no `mask` object, an unknown
 * `shape`, or `enabled: false`).
 *
 * Starts from the defaults, takes each finite numeric field of `item.mask`,
 * then lets each mask keyframe track that samples to a finite number override
 * its field. Clamped last: `w`, `h` to at least 1e-4, `radius` to [0, 1],
 * `feather` to [0, MASK_FEATHER_MAX]. `invert` is true only when stored as `true`.
 *
 * @param {CompositeItem | null | undefined} item
 * @param {number} localT Seconds from the item's own `start`.
 * @returns {ResolvedMask | null}
 */
export function maskAt(item, localT) {
  const mask = validMask(item)
  if (!mask) return null
  /** @type {Record<string, number>} */
  const v = { x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, radius: 0, feather: 0 }
  for (const field of Object.keys(v)) {
    const stored = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (mask))[field]
    if (typeof stored === 'number' && Number.isFinite(stored)) v[field] = stored
  }
  const tracks = item?.keyframes
  if (Array.isArray(tracks)) {
    for (const prop of MASK_KEYFRAME_PROPS) {
      const sampled = sampleTrack(trackFor(tracks, prop), localT)
      if (typeof sampled === 'number' && Number.isFinite(sampled)) v[MASK_FIELD_OF[prop]] = sampled
    }
  }
  return {
    shape: mask.shape,
    x: v.x,
    y: v.y,
    w: Math.max(MIN_SIDE, v.w),
    h: Math.max(MIN_SIDE, v.h),
    rotation: v.rotation,
    radius: clamp(v.radius, 0, 1),
    feather: clamp(v.feather, 0, MASK_FEATHER_MAX),
    invert: mask.invert === true,
  }
}

/**
 * Whether the item's mask moves: it has a valid mask and a mask keyframe track
 * with at least one point. Mask tracks on an item with no mask do nothing, so
 * they do not count.
 *
 * @param {CompositeItem | null | undefined} item
 * @returns {boolean}
 */
export function hasMaskKeyframes(item) {
  if (!validMask(item)) return false
  const tracks = item?.keyframes
  if (!Array.isArray(tracks)) return false
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    if (track && MASK_PROP_SET.has(track.prop) && Array.isArray(track.points) && track.points.length > 0) return true
  }
  return false
}

/** The largest `feather`: a soft band as wide as the box's shorter side. */
export const MASK_FEATHER_MAX = 1

/**
 * How many sigmas wide the feather's band is: the band runs from 2 sigma
 * inside the outline to 2 sigma outside, about 98% to 2% of the falloff.
 */
export const FEATHER_BAND_SIGMAS = 4

/**
 * The feather's Gaussian sigma in box pixels: the band's width (`feather`
 * times the box's shorter side) over {@link FEATHER_BAND_SIGMAS}.
 *
 * @param {ResolvedMask} mask
 * @param {number} boxW
 * @param {number} boxH
 * @returns {number}
 */
export function maskSigmaPx(mask, boxW, boxH) {
  return (mask.feather * Math.min(boxW, boxH)) / FEATHER_BAND_SIGMAS
}

/**
 * The hard (unfeathered, uninverted) mask outline as a convex polygon in box
 * pixels, y down, clockwise on screen. THE outline both engines draw: the SVG
 * fills it, the rasterizer scan-converts it.
 *
 * - ellipse: 256 points, rotated about its centre.
 * - rect: its 4 corners, or 16 arc points per corner when `radius > 0`,
 *   rotated about its centre.
 * - wipe: the visible half-plane clipped to a square of half side
 *   `4·max(boxW, boxH)` around the box centre; empty when that square lies
 *   wholly on the hidden side.
 *
 * @param {ResolvedMask} mask
 * @param {number} boxW
 * @param {number} boxH
 * @returns {Array<[number, number]>}
 */
export function maskPolygon(mask, boxW, boxH) {
  const cx = mask.x * boxW
  const cy = mask.y * boxH
  const theta = (mask.rotation * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)

  if (mask.shape === 'wipe') return wipePolygon(cx, cy, cos, sin, boxW, boxH)

  /** @type {Array<[number, number]>} */
  const local = []
  if (mask.shape === 'ellipse') {
    const rx = (mask.w * boxW) / 2
    const ry = (mask.h * boxH) / 2
    for (let i = 0; i < ELLIPSE_POINTS; i++) {
      const a = (2 * Math.PI * i) / ELLIPSE_POINTS
      local.push([rx * Math.cos(a), ry * Math.sin(a)])
    }
  } else {
    const hw = (mask.w * boxW) / 2
    const hh = (mask.h * boxH) / 2
    const r = mask.radius * Math.min(hw, hh)
    if (r === 0) {
      local.push([-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh])
    } else {
      // Corner arc centres, clockwise from top-left, each with its start angle
      // (y down, so increasing angle runs clockwise on screen).
      /** @type {Array<[number, number, number]>} */
      const corners = [
        [-hw + r, -hh + r, Math.PI],
        [hw - r, -hh + r, 1.5 * Math.PI],
        [hw - r, hh - r, 0],
        [-hw + r, hh - r, 0.5 * Math.PI],
      ]
      for (const [ax, ay, a0] of corners) {
        for (let j = 0; j < CORNER_POINTS; j++) {
          const a = a0 + ((Math.PI / 2) * j) / (CORNER_POINTS - 1)
          local.push([ax + r * Math.cos(a), ay + r * Math.sin(a)])
        }
      }
    }
  }
  return local.map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos])
}

/**
 * A wipe's visible half-plane `(px - cx)·cos + (py - cy)·sin <= 0`, as the
 * clockwise square of half side `4·max(boxW, boxH)` around the box centre cut
 * by the edge line (one Sutherland-Hodgman pass), so the result is convex.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {number} cos
 * @param {number} sin
 * @param {number} boxW
 * @param {number} boxH
 * @returns {Array<[number, number]>}
 */
function wipePolygon(cx, cy, cos, sin, boxW, boxH) {
  const L = 4 * Math.max(boxW, boxH)
  const bx = boxW / 2
  const by = boxH / 2
  /** @type {Array<[number, number]>} */
  const square = [[bx - L, by - L], [bx + L, by - L], [bx + L, by + L], [bx - L, by + L]]
  /** @param {[number, number]} p */
  const side = (p) => (p[0] - cx) * cos + (p[1] - cy) * sin
  /** @type {Array<[number, number]>} */
  const out = []
  for (let i = 0; i < square.length; i++) {
    const a = square[i]
    const b = square[(i + 1) % square.length]
    const sa = side(a)
    const sb = side(b)
    if (sa <= 0) out.push(a)
    if ((sa <= 0) !== (sb <= 0)) {
      const k = sa / (sa - sb)
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k])
    }
  }
  return out
}

/**
 * The mask as an 8-bit alpha plane over the box plus a margin on every side
 * (room for the feather's blur to spread). The HARD shape only: the feather is
 * the caller's blur, with sigma {@link maskSigmaPx}.
 *
 * `w` and `h` are the box's integer pixel size. The margin defaults to
 * `ceil(3·sigma)`. The plane is `(w + 2·margin) x (h + 2·margin)`, row-major,
 * with the box at (margin, margin). Each value is the shape's coverage of that
 * pixel times 255, rounded; inverted, `255 - v`.
 *
 * Anti-aliased by 4 sub-rows per pixel row, each with exact horizontal
 * coverage between the polygon's two crossings (it is convex), so the cost is
 * O(rows × (edges + width)) with no per-pixel inside test.
 *
 * @param {ResolvedMask} mask
 * @param {number} w
 * @param {number} h
 * @param {{ margin?: number }} [options]
 * @returns {{ data: Uint8Array, width: number, height: number, margin: number }}
 */
export function rasterizeMask(mask, w, h, { margin } = {}) {
  const m = margin ?? Math.ceil(3 * maskSigmaPx(mask, w, h))
  const W = w + 2 * m
  const H = h + 2 * m
  const data = new Uint8Array(W * H)
  const pts = maskPolygon(mask, w, h)
  const n = pts.length
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i][0] + m
    ys[i] = pts[i][1] + m
    if (ys[i] < minY) minY = ys[i]
    if (ys[i] > maxY) maxY = ys[i]
  }
  const row = new Float32Array(W)
  const sub = 1 / SUB_ROWS

  for (let py = 0; py < H; py++) {
    row.fill(0)
    if (n >= 3 && py + 1 > minY && py < maxY) {
      for (let s = 0; s < SUB_ROWS; s++) {
        const sy = py + (s + 0.5) * sub
        let xl = Infinity
        let xr = -Infinity
        for (let i = 0; i < n; i++) {
          const j = i + 1 === n ? 0 : i + 1
          const y0 = ys[i]
          const y1 = ys[j]
          // Half-open in y, so a vertex on the sub-row counts once and a
          // horizontal edge never.
          if ((y0 <= sy && sy < y1) || (y1 <= sy && sy < y0)) {
            const x = xs[i] + ((sy - y0) * (xs[j] - xs[i])) / (y1 - y0)
            if (x < xl) xl = x
            if (x > xr) xr = x
          }
        }
        if (xl < 0) xl = 0
        if (xr > W) xr = W
        if (!(xr > xl)) continue
        const il = Math.floor(xl)
        const ir = Math.floor(xr)
        if (il === ir) {
          row[il] += sub * (xr - xl)
        } else {
          row[il] += sub * (il + 1 - xl)
          for (let k = il + 1; k < ir; k++) row[k] += sub
          if (ir < W) row[ir] += sub * (xr - ir)
        }
      }
    }
    const base = py * W
    for (let k = 0; k < W; k++) {
      const v = Math.min(255, Math.round(row[k] * 255))
      data[base + k] = mask.invert ? 255 - v : v
    }
  }
  return { data, width: W, height: H, margin: m }
}

/**
 * A number as the SVG prints it: at most 2 decimals.
 *
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return String(Math.round(n * 100) / 100)
}

/**
 * The mask as a one-line SVG over the box (`viewBox="0 0 boxW boxH"`,
 * stretched to whatever element it masks): white where the clip shows, black
 * where it does not. The outline is {@link maskPolygon}'s; a feathered mask
 * blurs it with `feGaussianBlur` at sigma {@link maskSigmaPx}. The background
 * rect extends one box past every side so the blur has black (or, inverted,
 * white) to pull in.
 *
 * @param {ResolvedMask} mask
 * @param {number} boxW
 * @param {number} boxH
 * @returns {string}
 */
export function maskSvg(mask, boxW, boxH) {
  const sigma = maskSigmaPx(mask, boxW, boxH)
  const pts = maskPolygon(mask, boxW, boxH).map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ')
  // The filter region is in user space and spans the box plus 3 sigma on every
  // side. A percentage-of-bounding-box region is cut at centre +/- the shape's
  // own width, which clips the blur of any shape narrower than half the box
  // into a hard square (a 0.25-wide ellipse at feather 0.2 read 0 where the
  // export reads 15).
  const pad = 3 * sigma
  const filter = sigma > 0
    ? `<defs><filter id="f" filterUnits="userSpaceOnUse" x="${fmt(-pad)}" y="${fmt(-pad)}" width="${fmt(boxW + 2 * pad)}" height="${fmt(boxH + 2 * pad)}"><feGaussianBlur stdDeviation="${fmt(sigma)}"/></filter></defs>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(boxW)} ${fmt(boxH)}" preserveAspectRatio="none">`
    + filter
    + `<rect x="${fmt(-boxW)}" y="${fmt(-boxH)}" width="${fmt(3 * boxW)}" height="${fmt(3 * boxH)}" fill="${mask.invert ? '#fff' : '#000'}"/>`
    + `<polygon points="${pts}" fill="${mask.invert ? '#000' : '#fff'}"${sigma > 0 ? ' filter="url(#f)"' : ''}/>`
    + '</svg>'
}

/**
 * The item's blend mode: its `blendMode` when that is one of
 * {@link BLEND_MODES}, else `'normal'`.
 *
 * @param {CompositeItem | null | undefined} item
 * @returns {BlendMode}
 */
export function blendModeOf(item) {
  const mode = item?.blendMode
  return typeof mode === 'string' && BLEND_SET.has(mode) ? /** @type {BlendMode} */ (mode) : 'normal'
}

/**
 * A blend mode's CSS `mix-blend-mode` name: `add` is `plus-lighter`, every
 * other mode is its own name.
 *
 * @param {BlendMode} mode
 * @returns {string}
 */
export function cssBlendMode(mode) {
  return mode === 'add' ? 'plus-lighter' : mode
}

/**
 * Whether the item composites as a plain opaque layer: no valid mask (one
 * that is off counts as none), blend
 * mode `normal`, and full opacity for its whole life (static opacity 1 and no
 * opacity track below 1 anywhere, as {@link fullOpacitySpans} reads it).
 *
 * @param {CompositeItem | null | undefined} item
 * @returns {boolean}
 */
export function isPlainComposite(item) {
  if (validMask(item) || blendModeOf(item) !== 'normal') return false
  const spans = fullOpacitySpans(item)
  return spans.length === 1 && spans[0][0] === -Infinity && spans[0][1] === Infinity
}
