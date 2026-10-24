import { describe, it, expect, vi, afterEach } from 'vitest'
import { coverCrop, loadImageNaturalSize } from '../imageGeometry'

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
