// @ts-check
// montaj_assets/timeline-core/src/radialBlur.js
//
// SPIN AND ZOOM blurs (`blurType` 'spin' | 'zoom', src/blur.js): the shared
// sampling plan both renderers draw from, and a CPU reference sampler that
// says, pixel for pixel, what both must compute.
//
//   - the render engine (render item-blur.js): per pass, `split` into copies,
//     each moved about the centre by ffmpeg `perspective`, then `mix` with the
//     plan's weights
//   - the editor preview (editor src/video/preview/radialBlurGL.ts): a WebGL2
//     pass per plan pass, one bilinear read per tap
//
// ── What a spin or zoom blur is ─────────────────────────────────────────────
//
// The average of copies of the picture, each moved about the centre: turned
// (spin) or scaled (zoom), with Gaussian weights across the sweep so the
// streaks' ends are soft.
//
//   SPIN: `blur` is the sweep in degrees, centred on each pixel: the copies
//   turn from -sweep/2 to +sweep/2. A tap's `offset` is its angle in degrees,
//   positive clockwise on screen (y down), as a clip's rotation.
//
//   ZOOM: `blur` is a percent `a`. The copies scale about the centre from
//   1 / (1 + a/200) to 1 + a/200, spread evenly in log scale. A tap's
//   `offset` is its scale factor. The design (PL90) said "1 - a/200 to
//   1 + a/200"; the outward end is that, the inward end is its reciprocal, so
//   that scales compose exactly across passes (a scale of e^u then e^v is
//   e^(u+v), as angles add), the identity sits at the sweep's middle, and
//   a = 200 never reaches a scale of 0. Up to 20% the inward ends differ by
//   under 1% of the scale (0.909 against 0.9 at 20%, 0.5 against 0 at 200%).
//
//   THE WEIGHTS are a Gaussian across the sweep, in the offset's own unit
//   (degrees; log scale for zoom), centred on 0 with sigma a quarter of the
//   sweep: the ends sit at 2 sigma, a weight of e^-2 (0.135) of the middle's.
//
// ── The plan ────────────────────────────────────────────────────────────────
//
//   TRAVEL is the longest path any corner of the picture moves across the
//   whole sweep, in picture pixels: the arc r x sweep (radians) for spin, the
//   radial distance r x (hi - lo) for zoom, r the farthest corner's distance
//   from the centre. It sizes the taps only, so a plan at another resolution
//   draws the same distribution with more or fewer taps.
//
//   UP TO 12 PX of travel: one pass of min(12, ceil(travel) + 1) taps (one a
//   pixel of travel, and the end: a spacing of at most 1 px, 1.09 px between
//   11 and 12), evenly spread from end to end of the sweep, each weighted by
//   the Gaussian at its offset. Any travel above 0 takes at least 2.
//
//   BEYOND: P passes (2, else 3) of N taps each, N = clamp(ceil(travel^(1/P)),
//   2, 12). Pass k's taps sit at the spacing of pass k-1 divided by N, so
//   their sums land on a uniform grid of M = N^P offsets from end to end of
//   the sweep (mixed radix: offset = d x (index - (M - 1)/2), index's base-N
//   digits one a pass), with an effective spacing at the farthest corner of
//   travel / (M - 1) px. P is the fewest passes whose effective spacing is at
//   most 1.5 px; past 3 x 12 transforms (travel over about 2590 px) the
//   spacing grows instead. So travel up to 214.5 px takes 2 passes, more
//   takes 3.
//
//   MULTI-PASS WEIGHTS: pass 1 gives each of its taps the Gaussian's whole
//   mass over the M-grid offsets in its cell (the N^(P-1) fine offsets it
//   leads); later passes weigh their taps equally (1/N), which spreads that
//   mass evenly over the cell. Weights multiply across passes, so the result
//   is the single-pass Gaussian on the M grid held constant within each
//   coarse cell: the same mass per cell, a staircase of N steps inside it.
//   (Gaussian weights on the later passes would ripple at the coarse spacing:
//   their kernels are narrower than a cell.)
//
//   Every pass's weights sum to 1. amount 0 (or no picture) is no passes.
//
// ── What both renderers compute (the reference, radialBlurReference) ────────
//
//   Coordinates: picture pixels, (0, 0) the picture's top-left corner, a
//   pixel's centre at (i + 0.5, j + 0.5). A tap maps the picture by
//   T(p) = c + S(p - c) (S a turn by the offset, or a scale by it), so the
//   output at p reads the input at T^-1(p) ({@link radialTapInverse}).
//
//   1. The input of pass 1 is the picture, PREMULTIPLIED (colour x alpha, and
//      alpha), in [0, 1].
//   2. Each pass: out(p) = sum over taps of weight x bilinear(in, T^-1(p)).
//      Bilinear reads the four texels around the point (u = x - 0.5,
//      v = y - 0.5, weights from their fractions); a texel outside the
//      picture is 0 in colour and alpha. A pass reads the previous pass's
//      premultiplied output (passes compose), and every pass's domain is the
//      picture: what a pass would move outside the picture is not kept for
//      the next.
//   3. After the last pass, colour is divided by the summed alpha (the
//      renormalisation: an average over the picture's own pixels, so its
//      edges stay opaque and keep their colour) and the alpha is the source
//      pixel's own. Where the summed alpha is 0 (every tap fell outside),
//      the source pixel's colour. The summed alpha itself is returned as
//      `coverage` (how much of the average fell on the picture), so a
//      renderer that cannot carry tiny sums (the export's 8-bit transforms)
//      can be measured where they are meaningful.
//
// Pure like the rest of the package: no DOM, no I/O, no dependency.

/** Travel (px) up to which one pass does: one tap a pixel. */
export const RADIAL_SINGLE_PASS_TRAVEL = 12
/** The most taps a pass takes. */
export const RADIAL_MAX_TAPS = 12
/** The most passes a plan takes. */
export const RADIAL_MAX_PASSES = 3
/** The effective spacing (px, at the farthest corner) a multi-pass plan keeps to. */
export const RADIAL_TARGET_SPACING = 1.5

const finite = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isFinite(n)

/**
 * A zoom blur's scale range for `amount` percent: `hi` = 1 + amount/200,
 * `lo` = 1 / hi. `{1, 1}` for no amount.
 *
 * @param {number} amount
 * @returns {{ lo: number, hi: number }}
 */
export function zoomScaleRange(amount) {
  const a = finite(amount) && amount > 0 ? amount : 0
  const hi = 1 + a / 200
  return { lo: 1 / hi, hi }
}

/**
 * The sweep in the offset's own unit: degrees for spin, log scale for zoom.
 *
 * @param {'spin' | 'zoom'} type
 * @param {number} amount
 */
function sweepOf(type, amount) {
  if (!(finite(amount) && amount > 0)) return 0
  return type === 'spin' ? amount : 2 * Math.log(zoomScaleRange(amount).hi)
}

/**
 * The longest path (px) any corner of a `rect.w` x `rect.h` picture moves
 * across the whole sweep about `center` (picture pixels): an arc for spin, a
 * radial distance for zoom. 0 for no amount or no picture.
 *
 * @param {{ type: 'spin' | 'zoom', amount: number, center: [number, number], rect: { w: number, h: number } }} input
 * @returns {number}
 */
export function radialBlurTravel({ type, amount, center, rect }) {
  if (!(finite(amount) && amount > 0)) return 0
  const w = rect?.w
  const h = rect?.h
  if (!(finite(w) && finite(h) && w > 0 && h > 0)) return 0
  const cx = finite(center?.[0]) ? center[0] : w / 2
  const cy = finite(center?.[1]) ? center[1] : h / 2
  let r = 0
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) r = Math.max(r, Math.hypot(x - cx, y - cy))
  if (type === 'spin') return r * amount * Math.PI / 180
  const { lo, hi } = zoomScaleRange(amount)
  return r * (hi - lo)
}

/**
 * @typedef {{ offset: number, weight: number }} RadialTap
 * @typedef {{ taps: RadialTap[] }} RadialPass
 * @typedef {{ passes: RadialPass[], travel: number, samples: number, spacing: number }} RadialPlan
 */

/**
 * The shared sampling plan for a spin or zoom blur (see the header for every
 * rule). `offset` is an angle in degrees (spin) or a scale factor (zoom);
 * each pass's weights sum to 1. `samples` is the effective number of copies
 * (N^passes), `spacing` their spacing at the farthest corner, px.
 *
 * @param {{ type: 'spin' | 'zoom', amount: number, center: [number, number], rect: { w: number, h: number } }} input
 *   `center` and `rect` in picture pixels (the picture's size; its top-left at 0, 0).
 * @returns {RadialPlan}
 */
export function radialBlurPlan({ type, amount, center, rect }) {
  const kind = type === 'zoom' ? 'zoom' : 'spin'
  const travel = radialBlurTravel({ type: kind, amount, center, rect })
  const sweep = sweepOf(kind, amount)
  if (!(travel > 0) || !(sweep > 0)) return { passes: [], travel, samples: 0, spacing: 0 }

  let passes = 1
  let n
  if (travel <= RADIAL_SINGLE_PASS_TRAVEL + 1e-9) {
    n = Math.min(RADIAL_MAX_TAPS, Math.ceil(travel - 1e-9) + 1)
  } else {
    for (passes = 2; ; passes++) {
      n = Math.min(RADIAL_MAX_TAPS, Math.max(2, Math.ceil(Math.pow(travel, 1 / passes) - 1e-9)))
      if (travel / (n ** passes - 1) <= RADIAL_TARGET_SPACING || passes === RADIAL_MAX_PASSES) break
    }
  }
  const m = n ** passes
  const d = sweep / (m - 1)
  const sigma = sweep / 4
  const toOffset = (/** @type {number} */ u) => (kind === 'spin' ? u : Math.exp(u))

  // The Gaussian on the M grid; pass 1 takes each cell's mass.
  const cell = m / n
  const mass = new Array(n).fill(0)
  for (let i = 0; i < m; i++) {
    const x = (i - (m - 1) / 2) * d
    mass[Math.floor(i / cell)] += Math.exp(-(x * x) / (2 * sigma * sigma))
  }
  const total = mass.reduce((s, v) => s + v, 0)

  /** @type {RadialPass[]} */
  const out = []
  for (let k = 1; k <= passes; k++) {
    const dk = d * n ** (passes - k)
    const taps = []
    for (let j = 0; j < n; j++) {
      const u = (j - (n - 1) / 2) * dk
      taps.push({ offset: toOffset(u), weight: k === 1 ? mass[j] / total : 1 / n })
    }
    out.push({ taps })
  }
  return { passes: out, travel, samples: m, spacing: travel / (m - 1) }
}

/**
 * A tap's inverse map as `[a, b]`: the output at p reads the input at
 * `c + [[a, -b], [b, a]] (p - c)` (picture pixels, y down). Spin: a turn by
 * -offset degrees (`a` = cos, `b` = -sin); zoom: a scale by 1 / offset (`b` = 0).
 *
 * @param {'spin' | 'zoom'} type
 * @param {number} offset
 * @returns {[number, number]}
 */
export function radialTapInverse(type, offset) {
  if (type === 'zoom') return [1 / offset, 0]
  const t = offset * Math.PI / 180
  return [Math.cos(t), -Math.sin(t)]
}

/**
 * Where a spin or zoom blur's centre falls in the picture, in picture pixels:
 * `center` as fractions of the clip's box ({@link import('./blur.js').blurCenterOf}),
 * `rect` the picture's rect in that box as fractions
 * ({@link import('./blur.js').pictureRectInBox}), `picW` x `picH` the picture's
 * size in the pixels the blur runs in. A centre outside the picture stays
 * outside.
 *
 * @param {{ x: number, y: number }} center
 * @param {{ x: number, y: number, w: number, h: number }} rect
 * @param {number} picW
 * @param {number} picH
 * @returns {[number, number]}
 */
export function radialCenterInPicture(center, rect, picW, picH) {
  const rw = rect.w > 0 ? rect.w : 1
  const rh = rect.h > 0 ? rect.h : 1
  return [((center.x - rect.x) / rw) * picW, ((center.y - rect.y) / rh) * picH]
}

/**
 * The CPU reference: a spin or zoom blur of a picture, exactly as the header
 * defines it. `image.data` is RGBA, straight alpha, 0..255 (a canvas's
 * ImageData, or any byte array); `rect` the picture within it, integer pixels
 * (the whole image by default); `center` in picture pixels (relative to
 * `rect`'s top-left). Returns the picture only, RGBA straight alpha as floats
 * in [0, 1] (multiply by 255 and round for codes), and `coverage`, the
 * summed alpha after the last pass, a pixel each.
 *
 * @param {{ data: ArrayLike<number>, width: number, height: number }} image
 * @param {{ type: 'spin' | 'zoom', plan: RadialPlan, center: [number, number],
 *   rect?: { x: number, y: number, w: number, h: number } }} options
 * @returns {{ data: Float32Array, width: number, height: number, coverage: Float32Array }}
 */
export function radialBlurReference(image, { type, plan, center, rect }) {
  const r = rect ?? { x: 0, y: 0, w: image.width, h: image.height }
  const w = r.w
  const h = r.h
  const n = w * h
  const src = new Float32Array(n * 4)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const s = ((r.y + j) * image.width + (r.x + i)) * 4
      const o = (j * w + i) * 4
      const a = image.data[s + 3] / 255
      src[o] = (image.data[s] / 255) * a
      src[o + 1] = (image.data[s + 1] / 255) * a
      src[o + 2] = (image.data[s + 2] / 255) * a
      src[o + 3] = a
    }
  }
  const [cx, cy] = center
  let cur = src
  for (const pass of plan.passes) {
    const taps = pass.taps.map((t) => [...radialTapInverse(type, t.offset), t.weight])
    const next = new Float32Array(n * 4)
    for (let j = 0; j < h; j++) {
      const py = j + 0.5 - cy
      for (let i = 0; i < w; i++) {
        const px = i + 0.5 - cx
        const o = (j * w + i) * 4
        for (const [a, b, wt] of taps) {
          bilinearAdd(cur, w, h, cx + a * px - b * py, cy + b * px + a * py, wt, next, o)
        }
      }
    }
    cur = next
  }
  const out = new Float32Array(n * 4)
  const coverage = new Float32Array(n)
  for (let o = 0; o < n * 4; o += 4) {
    const sa = src[o + 3]
    const A = cur[o + 3]
    coverage[o >> 2] = A
    for (let c = 0; c < 3; c++) {
      out[o + c] = A > 1e-7 ? Math.min(1, cur[o + c] / A) : sa > 0 ? src[o + c] / sa : 0
    }
    out[o + 3] = sa
  }
  return { data: out, width: w, height: h, coverage }
}

/**
 * Adds `weight` x the bilinear read of premultiplied `buf` (w x h) at (x, y)
 * into `out` at `o`; texels outside the buffer are 0.
 *
 * @param {Float32Array} buf
 * @param {number} w
 * @param {number} h
 * @param {number} x
 * @param {number} y
 * @param {number} weight
 * @param {Float32Array} out
 * @param {number} o
 */
function bilinearAdd(buf, w, h, x, y, weight, out, o) {
  const u = x - 0.5
  const v = y - 0.5
  if (!(u > -1 && u < w && v > -1 && v < h)) return
  const i0 = Math.floor(u)
  const j0 = Math.floor(v)
  const fx = u - i0
  const fy = v - j0
  for (let dj = 0; dj < 2; dj++) {
    const j = j0 + dj
    if (j < 0 || j >= h) continue
    const wy = dj ? fy : 1 - fy
    for (let di = 0; di < 2; di++) {
      const i = i0 + di
      if (i < 0 || i >= w) continue
      const k = weight * wy * (di ? fx : 1 - fx)
      if (k === 0) continue
      const s = (j * w + i) * 4
      out[o] += k * buf[s]
      out[o + 1] += k * buf[s + 1]
      out[o + 2] += k * buf[s + 2]
      out[o + 3] += k * buf[s + 3]
    }
  }
}
