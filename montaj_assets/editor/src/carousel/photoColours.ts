import { normalizeHex } from './colours'

// The colour panel's photo colours (§587 R9): a few dominant colours per image
// on the slide, read in the browser from the image the slide already shows.
// A small downscale on a canvas, then a coarse colour histogram. An image the
// page cannot read (a cross-origin one without CORS, a broken one) gives none.

/** The side of the downscaled copy, in px: enough for a palette, cheap to read. */
const SAMPLE = 48
/** RGB distance under which two picks count as the same colour. */
const MIN_DISTANCE = 48
/** A colour must cover this share of the image to count: a speck is not a palette colour. */
const MIN_SHARE = 0.01

/**
 * The `count` most common colours in RGBA pixel data, most common first, as
 * `#rrggbb`. Pixels are grouped into 4-bit-per-channel buckets; each pick is its
 * bucket's average, and one too close to an earlier pick is skipped.
 * Mostly transparent pixels, and colours under 1% of the image, are ignored.
 */
export function dominantColours(data: ArrayLike<number>, count = 6): string[] {
  const sums = new Map<number, [number, number, number, number]>()
  let total = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    total++
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const s = sums.get(key)
    if (s) { s[0] += r; s[1] += g; s[2] += b; s[3] += 1 } else sums.set(key, [r, g, b, 1])
  }
  const buckets = [...sums.values()].sort((a, b) => b[3] - a[3])
  const picks: Array<[number, number, number]> = []
  for (const [r, g, b, n] of buckets) {
    if (picks.length >= count || n < total * MIN_SHARE) break
    const c: [number, number, number] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
    if (picks.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < MIN_DISTANCE)) continue
    picks.push(c)
  }
  return picks.map((c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // A CORS-enabled host can be read; any other cross-origin image fails here, and is skipped.
    if (!src.startsWith('data:') && !src.startsWith('blob:')) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image did not load'))
    img.src = src
  })
}

/** The dominant colours of the image at `src`. Throws when it cannot be read. */
async function sample(src: string): Promise<string[]> {
  const img = await loadImage(src)
  const w = img.naturalWidth, h = img.naturalHeight
  if (!w || !h) return []
  const k = SAMPLE / Math.max(w, h)
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []
  // Nearest-neighbour: the copy holds the image's own colours, not blends of neighbours at edges.
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, 0, 0, cw, ch)
  // A tainted canvas throws here.
  const colours = dominantColours(ctx.getImageData(0, 0, cw, ch).data)
  return colours.map((c) => normalizeHex(c) ?? c)
}

const cache = new Map<string, Promise<string[]>>()

/** The image's dominant colours, read once per `src`. Rejects when it cannot be read. */
export function photoColoursOf(src: string): Promise<string[]> {
  let p = cache.get(src)
  if (!p) {
    p = sample(src)
    cache.set(src, p)
    // A failure is not kept: the image may load later.
    p.catch(() => cache.delete(src))
  }
  return p
}
