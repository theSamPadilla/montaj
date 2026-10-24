import { describe, it, expect, vi, afterEach } from 'vitest'
import { coverCrop, loadImageNaturalSize, placeImageBox } from '../imageGeometry'

// ── coverCrop ────────────────────────────────────────────────────────────────

describe('coverCrop', () => {
  it('a wider image gives a horizontally centred crop with h = 1', () => {
    // 2:1 image in a square box: the middle half of the width.
    expect(coverCrop(200, 200, 2000, 1000)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 })
  })

  it('a taller image gives a vertically centred crop with w = 1', () => {
    // 1:2 image in a square box: the middle half of the height.
    expect(coverCrop(200, 200, 1000, 2000)).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 })
  })

  it('compares the image with the box shape, not with a square', () => {
    // 4:3 image in a 16:9 box is the taller of the two: full width, 3/4 of the height.
    const crop = coverCrop(1600, 900, 400, 300)!
    expect(crop.x).toBe(0)
    expect(crop.w).toBe(1)
    expect(crop.h).toBeCloseTo(0.75, 10)
    expect(crop.y).toBeCloseTo(0.125, 10)
    // 16:9 image in a 4:3 box is the wider of the two.
    const wide = coverCrop(400, 300, 1600, 900)!
    expect(wide.y).toBe(0)
    expect(wide.h).toBe(1)
    expect(wide.w).toBeCloseTo(0.75, 10)
    expect(wide.x).toBeCloseTo(0.125, 10)
  })

  it('equal aspect gives undefined, at any size', () => {
    expect(coverCrop(200, 200, 1000, 1000)).toBeUndefined()
    expect(coverCrop(1080, 1350, 800, 1000)).toBeUndefined()
    expect(coverCrop(300, 100, 3, 1)).toBeUndefined()
  })

  it('aspects within 0.5% count as equal; past it they do not', () => {
    // 0.4% off a square: matches.
    expect(coverCrop(200, 200, 1000, 1004)).toBeUndefined()
    expect(coverCrop(200, 200, 1004, 1000)).toBeUndefined()
    // 1% off: crops.
    expect(coverCrop(200, 200, 1000, 1010)).toBeDefined()
    expect(coverCrop(200, 200, 1010, 1000)).toBeDefined()
  })

  it('the crop has the box aspect in source pixels (the aspect-lock invariant)', () => {
    const cases: Array<[number, number, number, number]> = [
      [200, 200, 2000, 1000],
      [1080, 1350, 4000, 3000],
      [1080, 1350, 1000, 4000],
      [500, 100, 640, 480],
      [100, 500, 640, 480],
      [321, 777, 1234, 987],
    ]
    for (const [bw, bh, iw, ih] of cases) {
      const c = coverCrop(bw, bh, iw, ih)!
      expect((c.w * iw) / (c.h * ih)).toBeCloseTo(bw / bh, 9)
    }
  })

  it('keeps every value inside 0..1, and the region inside the image', () => {
    const sizes = [1, 3, 7, 100, 333, 1000, 4096, 100000]
    for (const bw of [1, 50, 1080]) {
      for (const bh of [1, 50, 1350]) {
        for (const iw of sizes) {
          for (const ih of sizes) {
            const c = coverCrop(bw, bh, iw, ih)
            if (!c) continue
            for (const v of [c.x, c.y, c.w, c.h]) {
              expect(v).toBeGreaterThanOrEqual(0)
              expect(v).toBeLessThanOrEqual(1)
            }
            expect(c.w).toBeGreaterThan(0)
            expect(c.h).toBeGreaterThan(0)
            expect(c.x + c.w).toBeLessThanOrEqual(1)
            expect(c.y + c.h).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })

  it('is centred: the margins on both sides are equal', () => {
    const c = coverCrop(200, 200, 3000, 1000)!
    expect(c.x).toBeCloseTo(1 - c.x - c.w, 12)
    const t = coverCrop(200, 200, 1000, 3000)!
    expect(t.y).toBeCloseTo(1 - t.y - t.h, 12)
  })

  it('gives undefined for a size it cannot use', () => {
    expect(coverCrop(0, 200, 100, 100)).toBeUndefined()
    expect(coverCrop(200, 0, 100, 100)).toBeUndefined()
    expect(coverCrop(200, 200, 0, 100)).toBeUndefined()
    expect(coverCrop(200, 200, 100, 0)).toBeUndefined()
    expect(coverCrop(-1, 200, 100, 50)).toBeUndefined()
    expect(coverCrop(200, 200, Number.NaN, 50)).toBeUndefined()
    expect(coverCrop(200, 200, 100, Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

// ── placeImageBox ────────────────────────────────────────────────────────────
//
// A new image keeps its own shape: the largest box of the image's aspect that
// fits inside 80% of the slide (width and height), centred on a point or on the
// slide. With no usable size it is the old centred square, 80% of the width.

describe('placeImageBox', () => {
  const portrait: [number, number] = [1080, 1350]

  it('a wide image is as wide as 80% of the slide and keeps its shape, centred on the slide', () => {
    // 2:1: the width is the limit (864 of 1080), so 864 x 432.
    expect(placeImageBox({ width: 2000, height: 1000 }, portrait)).toEqual({ x: 108, y: 459, w: 864, h: 432 })
  })

  it('a tall image is as tall as 80% of the slide', () => {
    // 1:2: the height is the limit (1080 of 1350), so 540 x 1080.
    expect(placeImageBox({ width: 1000, height: 2000 }, portrait)).toEqual({ x: 270, y: 135, w: 540, h: 1080 })
  })

  it('a square image is limited by the narrower side of the area, the width on a portrait slide', () => {
    expect(placeImageBox({ width: 500, height: 500 }, portrait)).toEqual({ x: 108, y: 243, w: 864, h: 864 })
  })

  it('on a landscape slide the height is the limit for a square', () => {
    // 1920 x 1080: 80% is 1536 x 864.
    expect(placeImageBox({ width: 700, height: 700 }, [1920, 1080])).toEqual({ x: 528, y: 108, w: 864, h: 864 })
  })

  it('a small image grows to the same fit; a large one shrinks to it', () => {
    expect(placeImageBox({ width: 100, height: 50 }, portrait)).toEqual({ x: 108, y: 459, w: 864, h: 432 })
    expect(placeImageBox({ width: 8000, height: 4000 }, portrait)).toEqual({ x: 108, y: 459, w: 864, h: 432 })
  })

  it('an unknown size is the old square: 80% of the slide width, centred', () => {
    expect(placeImageBox(null, portrait)).toEqual({ x: 108, y: 243, w: 864, h: 864 })
    expect(placeImageBox(null, [1080, 1080])).toEqual({ x: 108, y: 108, w: 864, h: 864 })
  })

  it('a size it cannot use counts as unknown', () => {
    const square = { x: 108, y: 243, w: 864, h: 864 }
    expect(placeImageBox({ width: 0, height: 100 }, portrait)).toEqual(square)
    expect(placeImageBox({ width: 100, height: 0 }, portrait)).toEqual(square)
    expect(placeImageBox({ width: -5, height: 100 }, portrait)).toEqual(square)
    expect(placeImageBox({ width: Number.NaN, height: 100 }, portrait)).toEqual(square)
    expect(placeImageBox({ width: 100, height: Number.POSITIVE_INFINITY }, portrait)).toEqual(square)
  })

  it('centres on the point it is given', () => {
    expect(placeImageBox({ width: 2000, height: 1000 }, portrait, { x: 600, y: 700 })).toEqual({ x: 168, y: 484, w: 864, h: 432 })
    // The unknown-size square too.
    expect(placeImageBox(null, portrait, { x: 600, y: 700 })).toEqual({ x: 168, y: 268, w: 864, h: 864 })
  })

  it('does not pull the box back inside the slide: it is centred where it was dropped', () => {
    expect(placeImageBox({ width: 2000, height: 1000 }, portrait, { x: 0, y: 0 })).toEqual({ x: -432, y: -216, w: 864, h: 432 })
  })

  it('a point that is not a number is no point: the slide centre', () => {
    const centred = { x: 108, y: 459, w: 864, h: 432 }
    expect(placeImageBox({ width: 2000, height: 1000 }, portrait, { x: Number.NaN, y: 5 })).toEqual(centred)
    expect(placeImageBox({ width: 2000, height: 1000 }, portrait, { x: 5, y: Number.POSITIVE_INFINITY })).toEqual(centred)
  })

  it('returns whole pixels', () => {
    const sizes = [{ width: 1000, height: 333 }, { width: 333, height: 1000 }, { width: 1921, height: 1081 }, { width: 7, height: 3 }]
    for (const size of sizes) {
      for (const at of [undefined, { x: 301.4, y: 77.7 }]) {
        const box = placeImageBox(size, [1080, 1350], at)
        for (const v of [box.x, box.y, box.w, box.h]) expect(Number.isInteger(v)).toBe(true)
      }
    }
  })

  it('keeps the image shape to within a pixel, and never leaves 80% of the slide', () => {
    const sizes = [{ width: 4000, height: 3000 }, { width: 3000, height: 4000 }, { width: 1600, height: 900 }, { width: 640, height: 480 }, { width: 333, height: 1000 }]
    for (const [sw, sh] of [[1080, 1350], [1080, 1080], [1920, 1080], [1080, 1920]] as Array<[number, number]>) {
      for (const size of sizes) {
        const { w, h } = placeImageBox(size, [sw, sh])
        expect(w).toBeLessThanOrEqual(Math.round(sw * 0.8))
        expect(h).toBeLessThanOrEqual(Math.round(sh * 0.8))
        // Rounding moves each side by at most half a pixel, which bounds how far
        // the ratio can drift from the image's: |w/h - a| <= 0.5 (1 + a) / h.
        const a = size.width / size.height
        expect(Math.abs(w / h - a)).toBeLessThanOrEqual((0.5 * (1 + a)) / h + 1e-9)
      }
    }
  })

  it('never returns an empty box, even for a very thin image', () => {
    const box = placeImageBox({ width: 100000, height: 10 }, [1080, 1350])
    expect(box.w).toBe(864)
    expect(box.h).toBe(1)
  })
})

// ── loadImageNaturalSize ─────────────────────────────────────────────────────
//
// jsdom never loads an image, so `Image` is a fake whose load the test drives.

type Outcome = { kind: 'load'; w: number; h: number } | { kind: 'error' } | { kind: 'never' }

let created: FakeImage[] = []

class FakeImage {
  static outcome: Outcome = { kind: 'never' }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  srcSet: string[] = []
  constructor() {
    created.push(this)
  }
  set src(url: string) {
    this.srcSet.push(url)
    if (url === '') return
    const o = FakeImage.outcome
    if (o.kind === 'load') {
      this.naturalWidth = o.w
      this.naturalHeight = o.h
      queueMicrotask(() => this.onload?.())
    } else if (o.kind === 'error') {
      queueMicrotask(() => this.onerror?.())
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  created = []
  FakeImage.outcome = { kind: 'never' }
})

describe('loadImageNaturalSize', () => {
  it('resolves the natural size once the image loads', async () => {
    vi.stubGlobal('Image', FakeImage)
    FakeImage.outcome = { kind: 'load', w: 640, h: 480 }
    await expect(loadImageNaturalSize('/a.png')).resolves.toEqual({ width: 640, height: 480 })
    expect(created).toHaveLength(1)
    expect(created[0].srcSet).toEqual(['/a.png'])
  })

  it('resolves null when the image fails to load', async () => {
    vi.stubGlobal('Image', FakeImage)
    FakeImage.outcome = { kind: 'error' }
    await expect(loadImageNaturalSize('/missing.png')).resolves.toBeNull()
  })

  it('resolves null when the image loads with no size (an SVG with no intrinsic size)', async () => {
    vi.stubGlobal('Image', FakeImage)
    FakeImage.outcome = { kind: 'load', w: 0, h: 0 }
    await expect(loadImageNaturalSize('/a.svg')).resolves.toBeNull()
  })

  it('resolves null after the timeout, default 5 s, and stops the download', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Image', FakeImage)
    FakeImage.outcome = { kind: 'never' }
    const done = vi.fn()
    void loadImageNaturalSize('/slow.png').then(done)

    await vi.advanceTimersByTimeAsync(4999)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalledWith(null)
    // The pending download is dropped by clearing the source.
    expect(created[0].srcSet).toEqual(['/slow.png', ''])
  })

  it('takes its own timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Image', FakeImage)
    const done = vi.fn()
    void loadImageNaturalSize('/slow.png', 100).then(done)
    await vi.advanceTimersByTimeAsync(99)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalledWith(null)
  })

  it('a load that lands first cancels the timer, and a late load changes nothing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Image', FakeImage)
    FakeImage.outcome = { kind: 'load', w: 10, h: 20 }
    const p = loadImageNaturalSize('/a.png', 1000)
    await vi.advanceTimersByTimeAsync(0)
    await expect(p).resolves.toEqual({ width: 10, height: 20 })
    // Nothing left to fire, and the source was never cleared.
    expect(vi.getTimerCount()).toBe(0)
    expect(created[0].srcSet).toEqual(['/a.png'])
  })
})
