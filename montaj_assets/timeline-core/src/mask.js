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

import { sampleTrack, easeProgress } from './curves.js'
import { fullOpacitySpans } from './geometry.js'

/**
 * @typedef {'ellipse' | 'rect' | 'wipe' | 'path'} MaskShape
 */

/**
 * @typedef {'normal' | 'screen' | 'multiply' | 'add' | 'lighten' | 'darken' | 'overlay'} BlendMode
 */

/**
 * A mask as stored on an item. Every field but `shape` is optional.
 *
 * @typedef {Object} ItemMask
 * @property {MaskShape} shape
 * @property {number} [x] Centre (ellipse, rect, path) or a point on the edge (wipe), fraction of box width. Default 0.5.
 * @property {number} [y] The same, fraction of box height. Default 0.5.
 * @property {number} [w] Ellipse diameter / rect side / a path's box, fraction of box width, > 0. Default 0.5. Wipe ignores.
 * @property {number} [h] The same, fraction of box height. Default 0.5.
 * @property {number} [rotation] Degrees clockwise about (x, y). Default 0.
 * @property {number} [radius] Rect only: corner radius, fraction of half the rect's shorter side, 0-1. Default 0.
 * @property {number} [feather] Width of the soft band centred on the edge, fraction of the box's shorter side, 0-1. Default 0.
 * @property {boolean} [invert] Default false.
 * @property {boolean} [enabled] Default true. `false` turns the mask off and keeps its settings.
 * @property {Array<[number, number]>} [points] Path only, and required there: 3 to {@link MASK_POINTS_MAX} [x, y] in 0-1 of the mask's own box (`x`, `y`, `w`, `h`, `rotation` place that box).
 * @property {boolean} [smooth] Path only: a closed Catmull-Rom curve through the points instead of straight segments. Default false.
 */

/**
 * A mask with every field resolved, as {@link maskAt} returns it. No
 * `enabled`: a mask that is off resolves to null.
 *
 * @typedef {Required<Omit<ItemMask, 'enabled' | 'points' | 'smooth'>> & { points?: Array<[number, number]>, smooth?: boolean }} ResolvedMask
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
export const MASK_SHAPES = Object.freeze(/** @type {const} */ (['ellipse', 'rect', 'wipe', 'path']))

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

/**
 * The keyframe prop that morphs a path: each point's value is a `points` array
 * of the mask's own length, interpolated point by point. Not in
 * {@link MASK_KEYFRAME_PROPS}, whose values are numbers.
 */
export const MASK_POINTS_PROP = 'maskPoints'
/** A path's point count: at least 3, at most this. */
export const MASK_POINTS_MIN = 3
export const MASK_POINTS_MAX = 64

/** The ellipse's vertex count. */
const ELLIPSE_POINTS = 256
/** Arc points per rounded rect corner, both ends included. */
const CORNER_POINTS = 16
/** The smallest mask side, as a fraction of the box: a mask never collapses to nothing. */
const MIN_SIDE = 1e-4
/** Curve points per segment of a smooth path. */
const SMOOTH_STEPS = 12
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
  if (mask.shape === 'path' && !validPoints(mask.points)) return null
  return mask
}

/**
 * Whether `points` is a path's point list: an array of MASK_POINTS_MIN to
 * MASK_POINTS_MAX pairs of finite numbers in 0-1 (and, given `n`, exactly n).
 *
 * @param {unknown} points
 * @param {number} [n]
 * @returns {points is Array<[number, number]>}
 */
export function validPoints(points, n) {
  if (!Array.isArray(points) || points.length < MASK_POINTS_MIN || points.length > MASK_POINTS_MAX) return false
  if (n !== undefined && points.length !== n) return false
  return points.every(p => Array.isArray(p) && p.length === 2
    && p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))
}

/**
 * A `maskPoints` track at item-relative `localT`: the points of the keyframes
 * either side, interpolated point by point with the earlier one's easing, as
 * {@link sampleTrack} does for a number. Keyframes whose value is not a valid
 * point list of length `n` are skipped. Undefined with no usable keyframe.
 *
 * @param {import('./curves.js').KeyframeTrack | undefined} track
 * @param {number} localT
 * @param {number} n
 * @returns {Array<[number, number]> | undefined}
 */
export function samplePointsTrack(track, localT, n) {
  const all = Array.isArray(track?.points) ? track.points : []
  const pts = all.filter(k => k && Number.isFinite(k.t) && validPoints(k.value, n))
  if (pts.length === 0) return undefined
  let prev = pts[0]
  const t = Number.isFinite(localT) ? localT : prev.t
  const copy = (v) => v.map(([x, y]) => /** @type {[number, number]} */ ([x, y]))
  if (t < prev.t) return copy(prev.value)
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i]
    if (t < cur.t) {
      const span = cur.t - prev.t
      if (!(span > 0)) return copy(cur.value)
      const e = easeProgress(prev.easing, (t - prev.t) / span)
      return prev.value.map(([x0, y0], j) => /** @type {[number, number]} */ ([x0 + (cur.value[j][0] - x0) * e, y0 + (cur.value[j][1] - y0) * e]))
    }
    prev = cur
  }
  return copy(prev.value)
}

/**
 * A closed uniform Catmull-Rom curve through `points`, SMOOTH_STEPS points per
 * segment, starting at the first point.
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>}
 */
function smoothPath(points) {
  const n = points.length
  /** @type {Array<[number, number]>} */
  const out = []
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    for (let s = 0; s < SMOOTH_STEPS; s++) {
      const t = s / SMOOTH_STEPS
      const t2 = t * t
      const t3 = t2 * t
      const at = (/** @type {number} */ k) => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t
        + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3)
      out.push([at(0), at(1)])
    }
  }
  return out
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
  /** @type {ResolvedMask} */
  const out = {
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
  if (mask.shape === 'path') {
    const stored = /** @type {Array<[number, number]>} */ (mask.points)
    const sampled = Array.isArray(tracks)
      ? samplePointsTrack(trackFor(tracks, MASK_POINTS_PROP), localT, stored.length)
      : undefined
    out.points = sampled ?? stored.map(([x, y]) => /** @type {[number, number]} */ ([x, y]))
    out.smooth = mask.smooth === true
  }
  return out
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
  const mask = validMask(item)
  if (!mask) return false
  const tracks = item?.keyframes
  if (!Array.isArray(tracks)) return false
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    if (!track || !Array.isArray(track.points) || track.points.length === 0) continue
    if (MASK_PROP_SET.has(track.prop) || (track.prop === MASK_POINTS_PROP && mask.shape === 'path')) return true
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
 * The hard (unfeathered, uninverted) mask outline as a polygon in box pixels,
 * y down: convex and clockwise on screen for every shape but a path, which is
 * as its points run. THE outline both engines draw: the SVG fills it, the
 * rasterizer scan-converts it, both even-odd.
 *
 * - ellipse: 256 points, rotated about its centre.
 * - rect: its 4 corners, or 16 arc points per corner when `radius > 0`,
 *   rotated about its centre.
 * - wipe: the visible half-plane clipped to a square of half side
 *   `4·max(boxW, boxH)` around the box centre; empty when that square lies
 *   wholly on the hidden side.
 * - path: its points (or, smooth, 12 curve points per segment) placed in the
 *   mask's box (`w` x `h` about (x, y)) and rotated about its centre.
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
  } else if (mask.shape === 'path') {
    // The points are fractions of the mask's own box, centred on (x, y).
    const bw = mask.w * boxW
    const bh = mask.h * boxH
    const pts = mask.points ?? []
    for (const [px, py] of mask.smooth ? smoothPath(pts) : pts) local.push([(px - 0.5) * bw, (py - 0.5) * bh])
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
 * coverage between pairs of the polygon's sorted crossings (even-odd: a convex
 * shape has two, a path may have more), so the cost is
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
  /** @type {number[]} */
  const cross = []
  /** Adds exact coverage of [xl, xr) on one sub-row. */
  const span = (/** @type {number} */ xl, /** @type {number} */ xr) => {
    if (xl < 0) xl = 0
    if (xr > W) xr = W
    if (!(xr > xl)) return
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

  for (let py = 0; py < H; py++) {
    row.fill(0)
    if (n >= 3 && py + 1 > minY && py < maxY) {
      for (let s = 0; s < SUB_ROWS; s++) {
        const sy = py + (s + 0.5) * sub
        cross.length = 0
        for (let i = 0; i < n; i++) {
          const j = i + 1 === n ? 0 : i + 1
          const y0 = ys[i]
          const y1 = ys[j]
          // Half-open in y, so a vertex on the sub-row counts once and a
          // horizontal edge never.
          if ((y0 <= sy && sy < y1) || (y1 <= sy && sy < y0)) {
            cross.push(xs[i] + ((sy - y0) * (xs[j] - xs[i])) / (y1 - y0))
          }
        }
        if (cross.length > 2) cross.sort((a, b) => a - b)
        else if (cross.length === 2 && cross[0] > cross[1]) cross.reverse()
        for (let c = 0; c + 1 < cross.length; c += 2) span(cross[c], cross[c + 1])
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
    + `<polygon points="${pts}" fill="${mask.invert ? '#000' : '#fff'}"${mask.shape === 'path' ? ' fill-rule="evenodd"' : ''}${sigma > 0 ? ' filter="url(#f)"' : ''}/>`
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
