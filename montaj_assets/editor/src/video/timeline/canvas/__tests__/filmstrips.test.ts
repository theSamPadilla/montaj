/**
 * SP5 T7 — canvas filmstrip rendering: the visibility fetch gate, the
 * ported sheet-index fetch-state store, tile selection + source-rect math,
 * and the draw hooks wired into `drawClipRect`/`drawTimelineContent` (draw.ts,
 * composed with T6's waveform). Follows waveforms.test.ts's (T6) conventions
 * throughout.
 */
import { describe, it, expect, vi } from 'vitest'
import type { VisualItem } from '../../../../schema'
import type { FilmstripIndex, FilmstripSheet, Project } from '../../../../types'
import {
  FILMSTRIP_CELL_ASPECT,
  FilmstripStore,
  centerCropTo,
  clipTimeToSourceTime,
  defaultSheetImageLoader,
  drawFilmstripTiles,
  flattenTiles,
  nearestTile,
  tileSourceRect,
  type FilmstripQueryContext,
  type FilmstripTileDraw,
  type LoadedSheetImage,
  type SheetImageLoader,
} from '../filmstrips'
import {
  computeTimelineLayout,
  drawTimelineContent,
  type DrawContext,
  type Rect,
  type TimelineScene,
} from '../draw'
import { FETCH_RETRY_COOLDOWN_MS, type WaveformColumn } from '../waveforms'
import { clipBands } from '../clip-bands'
import { BASE_VISUAL_ROW_RENDER_HEIGHT_PX } from '../../timeline-model'
import type { Viewport } from '../viewport'

// ── Recording context (mirrors waveforms.test.ts's convention) ───────────

interface RecordedCall { method: string; args: unknown[] }

function recordingContext() {
  const calls: RecordedCall[] = []
  const props: Record<string, unknown> = {}
  const proxy = new Proxy({}, {
    get(_t, prop: string) {
      if (prop in props) return props[prop]
      if (prop === 'createLinearGradient') {
        return (...args: unknown[]) => {
          calls.push({ method: 'createLinearGradient', args })
          return { addColorStop: (...s: unknown[]) => calls.push({ method: 'addColorStop', args: s }) } as unknown as CanvasGradient
        }
      }
      return (...args: unknown[]) => { calls.push({ method: prop, args }) }
    },
    set(_t, prop: string, value: unknown) {
      props[prop] = value
      calls.push({ method: `set:${prop}`, args: [value] })
      return true
    },
  }) as unknown as DrawContext
  return { ctx: proxy, calls, of: (m: string) => calls.filter(c => c.method === m) }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, ...over }
}

function rect(over: Partial<Rect> = {}): Rect {
  return { x: 0, y: 0, width: 100, height: BASE_VISUAL_ROW_RENDER_HEIGHT_PX, ...over }
}

function filmstripIndexFixture(over: Partial<FilmstripIndex> = {}): FilmstripIndex {
  return {
    interval: 1,
    tileWidth: 160,
    sheets: [
      {
        path: 'sheet0.jpg',
        cols: 5,
        rows: 2,
        tiles: Array.from({ length: 10 }, (_, i) => ({ t: i, row: Math.floor(i / 5), col: i % 5 })),
      },
    ],
    ...over,
  }
}

function loadedImage(width = 800, height = 320): LoadedSheetImage {
  return { image: {} as CanvasImageSource, width, height }
}

function fakeLoader(image: LoadedSheetImage = loadedImage()): SheetImageLoader {
  return vi.fn().mockResolvedValue(image)
}

function queryCtx(over: Partial<FilmstripQueryContext> = {}): FilmstripQueryContext {
  return {
    projectId: 'p1',
    getFilmstrip: vi.fn().mockResolvedValue(filmstripIndexFixture()),
    fileUrl: (p: string) => `/files/${p}`,
    viewport: { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 },
    onReady: vi.fn(),
    loader: fakeLoader(),
    ...over,
  }
}

/** Flush the microtask queue so a mocked fetcher's `.then()`/`.catch()` runs. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

// ── Cell sizing ────────────────────────────────────────────────────────────

describe('FILMSTRIP_CELL_ASPECT', () => {
  it('is square — the 9:16 footage this edits would otherwise draw as slivers', () => {
    expect(FILMSTRIP_CELL_ASPECT).toBe(1)
  })
})

describe('centerCropTo', () => {
  it('crops a tall tile top and bottom to fill a square cell', () => {
    // 9:16 source into a 1:1 destination: full width, a centered square of height.
    expect(centerCropTo({ sx: 0, sy: 0, sw: 90, sh: 160 }, 1)).toEqual({ sx: 0, sy: 35, sw: 90, sh: 90 })
  })

  it('crops a wide tile left and right to fill a square cell', () => {
    expect(centerCropTo({ sx: 0, sy: 0, sw: 160, sh: 90 }, 1)).toEqual({ sx: 35, sy: 0, sw: 90, sh: 90 })
  })

  it('keeps the tile\'s offset within its sheet, cropping relative to it', () => {
    // The crop must move the sub-rect INSIDE the tile, never back toward the
    // sheet origin, or every cell would show a slice of its neighbour.
    expect(centerCropTo({ sx: 320, sy: 90, sw: 160, sh: 90 }, 1)).toEqual({ sx: 355, sy: 90, sw: 90, sh: 90 })
  })

  it('leaves an already-matching aspect untouched', () => {
    const src = { sx: 10, sy: 20, sw: 80, sh: 40 }
    expect(centerCropTo(src, 2)).toEqual(src)
  })

  it('returns the source unchanged for a degenerate aspect or size, rather than emitting NaNs', () => {
    const src = { sx: 0, sy: 0, sw: 100, sh: 50 }
    expect(centerCropTo(src, 0)).toEqual(src)
    expect(centerCropTo(src, Number.NaN)).toEqual(src)
    expect(centerCropTo({ sx: 0, sy: 0, sw: 0, sh: 0 }, 1)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 })
  })
})

// ── Source-time alignment ────────────────────────────────────────────────

describe('clipTimeToSourceTime', () => {
  it('anchors the clip\'s own start at source time 0 when inPoint is absent', () => {
    expect(clipTimeToSourceTime(clip({ start: 2 }), 5)).toBe(3)
  })

  it('anchors at inPoint when present, offsetting 1:1 from there', () => {
    expect(clipTimeToSourceTime(clip({ start: 2, inPoint: 10 }), 5)).toBe(13)
  })

  // ── Per-clip speed ──
  //
  // A clip at speed S eats S× the source per project second. Without this the
  // frames and the per-clip waveform described the same clip differently: the
  // waveform windows to inPoint..outPoint, which is speed-correct by
  // construction, while the frames walked the source at 1×.

  it('eats source faster on a sped-up clip', () => {
    // 3s into a 2x clip is 6s into the source.
    expect(clipTimeToSourceTime(clip({ start: 2, inPoint: 10, speed: 2 }), 5)).toBe(16)
  })

  it('eats source slower on a slowed clip', () => {
    // 3s into a 0.5x clip is only 1.5s of source.
    expect(clipTimeToSourceTime(clip({ start: 2, inPoint: 10, speed: 0.5 }), 5)).toBe(11.5)
  })

  it('is a strict no-op at speed 1 and at no speed at all', () => {
    expect(clipTimeToSourceTime(clip({ start: 2, inPoint: 10, speed: 1 }), 5))
      .toBe(clipTimeToSourceTime(clip({ start: 2, inPoint: 10 }), 5))
  })

  it('lands on outPoint at the clip\'s end, which is what makes it agree with the waveform', () => {
    // The invariant the two renderers share: at the last frame of the clip,
    // the frames have consumed exactly the window the waveform drew. A clip
    // slowed to 0.5x runs 4s of timeline off 2s of source.
    const item = clip({ start: 2, end: 6, inPoint: 10, outPoint: 12, speed: 0.5 })
    expect(clipTimeToSourceTime(item, item.end)).toBe(item.outPoint)
  })
})

// ── Tile selection ───────────────────────────────────────────────────────

describe('flattenTiles', () => {
  it('flattens multiple sheets in order, tagging each tile with its sheet index', () => {
    const index = filmstripIndexFixture({
      sheets: [
        { path: 's0.jpg', cols: 2, rows: 1, tiles: [{ t: 0, row: 0, col: 0 }, { t: 1, row: 0, col: 1 }] },
        { path: 's1.jpg', cols: 2, rows: 1, tiles: [{ t: 2, row: 0, col: 0 }, { t: 3, row: 0, col: 1 }] },
      ],
    })
    expect(flattenTiles(index)).toEqual([
      { t: 0, sheetIdx: 0, row: 0, col: 0 },
      { t: 1, sheetIdx: 0, row: 0, col: 1 },
      { t: 2, sheetIdx: 1, row: 0, col: 0 },
      { t: 3, sheetIdx: 1, row: 0, col: 1 },
    ])
  })
})

describe('nearestTile', () => {
  const tiles = flattenTiles(filmstripIndexFixture({
    sheets: [{ path: 's0.jpg', cols: 3, rows: 1, tiles: [{ t: 0, row: 0, col: 0 }, { t: 2, row: 0, col: 1 }, { t: 4, row: 0, col: 2 }] }],
  }))

  it('returns null for an empty list', () => {
    expect(nearestTile([], 5)).toBeNull()
  })

  it('matches an exact t', () => {
    expect(nearestTile(tiles, 2)).toMatchObject({ t: 2 })
  })

  it('picks the nearer neighbour on either side', () => {
    expect(nearestTile(tiles, 2.9)).toMatchObject({ t: 2 })
    expect(nearestTile(tiles, 3.1)).toMatchObject({ t: 4 })
  })

  it('ties toward the earlier tile', () => {
    expect(nearestTile(tiles, 3)).toMatchObject({ t: 2 })
  })

  it('clamps to the end tiles before the first and after the last', () => {
    expect(nearestTile(tiles, -5)).toMatchObject({ t: 0 })
    expect(nearestTile(tiles, 100)).toMatchObject({ t: 4 })
  })
})

// ── Source-rect math ─────────────────────────────────────────────────────

describe('tileSourceRect', () => {
  it('divides the loaded sheet image evenly by the sheet\'s cols/rows', () => {
    const sheet: FilmstripSheet = { path: 's.jpg', cols: 5, rows: 2, tiles: [] }
    expect(tileSourceRect(sheet, { row: 1, col: 3 }, 800, 320)).toEqual({ sx: 480, sy: 160, sw: 160, sh: 160 })
  })

  it('uses the loaded image\'s own dimensions, not a nominal tileWidth', () => {
    const sheet: FilmstripSheet = { path: 's.jpg', cols: 4, rows: 1, tiles: [] }
    // A sheet whose actual pixels don't divide evenly by a nominal 160 tileWidth.
    expect(tileSourceRect(sheet, { row: 0, col: 2 }, 601, 150)).toEqual({ sx: 300.5, sy: 0, sw: 150.25, sh: 150 })
  })
})

// ── Default loader ───────────────────────────────────────────────────────

describe('defaultSheetImageLoader', () => {
  it('is exported as the store\'s default (injectable) loader', () => {
    expect(typeof defaultSheetImageLoader).toBe('function')
  })
})

// ── Draw primitives ──────────────────────────────────────────────────────

describe('drawFilmstripTiles', () => {
  it('emits one drawImage per tile at its own destination rect', () => {
    const r = recordingContext()
    const tiles: FilmstripTileDraw[] = [
      { image: {} as CanvasImageSource, sx: 0, sy: 0, sw: 160, sh: 90, rect: { x: 10, y: 5, width: 40, height: 56 } },
      { image: {} as CanvasImageSource, sx: 160, sy: 0, sw: 160, sh: 90, rect: { x: 50, y: 5, width: 40, height: 56 } },
    ]
    drawFilmstripTiles(r.ctx, tiles)

    const calls = r.of('drawImage')
    expect(calls).toHaveLength(2)
    expect(calls[0].args.slice(5)).toEqual([10, 5, 40, 56])
    expect(calls[1].args.slice(5)).toEqual([50, 5, 40, 56])
  })

  it('skips a degenerate destination rect (zero width or height)', () => {
    const r = recordingContext()
    drawFilmstripTiles(r.ctx, [
      { image: {} as CanvasImageSource, sx: 0, sy: 0, sw: 10, sh: 10, rect: { x: 0, y: 0, width: 0, height: 40 } },
      { image: {} as CanvasImageSource, sx: 0, sy: 0, sw: 10, sh: 10, rect: { x: 0, y: 0, width: 40, height: 0 } },
    ])
    expect(r.of('drawImage')).toHaveLength(0)
  })
})

describe('FilmstripStore.clipTiles fetch policy', () => {
  const zoomedOut: Viewport = { pxPerSecond: 12, scrollSeconds: 0, widthPx: 1000 }
  const zoomedIn: Viewport = { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 } // visible range [0, 5]

  it('fetches when zoomed out, where the old 160px/s threshold used to suppress it', () => {
    // The gate is gone on purpose: cells are sized by the frames band now, so
    // zooming out yields fewer full-size frames rather than a row of slivers.
    const store = new FilmstripStore()
    const fetcher = vi.fn().mockResolvedValue(filmstripIndexFixture())
    store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedOut }))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('still does not fetch when the clip is off the visible range', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 100, end: 105 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedIn }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fetches once the clip is visible', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn().mockResolvedValue(filmstripIndexFixture())
    store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedIn }))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not fetch for a clip whose frames band has no height', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 }), rect({ width: 1000, height: 0 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedIn }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never fetches when the item has no proxySrc', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    store.clipTiles(clip({ start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedIn }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never fetches for a non-video item even with a proxySrc set', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    const imageItem = clip({ type: 'image', proxySrc: 'proxy.mp4', start: 0, end: 5 } as Partial<VisualItem> as VisualItem)
    store.clipTiles(imageItem, rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedIn }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fires a fetch once a proxySrc arrives (SSE import completion), since the key changes', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn().mockResolvedValue(filmstripIndexFixture())

    store.clipTiles(clip({ start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedIn }))
    expect(fetcher).not.toHaveBeenCalled()

    store.clipTiles(clip({ start: 0, end: 5, proxySrc: 'proxy.mp4' }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: zoomedIn }))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('stays inert (never fetches, never throws) when the adapter has no getFilmstrip', () => {
    const store = new FilmstripStore()
    expect(() =>
      store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: undefined, viewport: zoomedIn })),
    ).not.toThrow()
  })
})

// ── Sheet-load laziness ────────────────────────────────────────────────────

describe('FilmstripStore.clipTiles geometry', () => {
  /** Drive the store to the point where its index AND sheet image are both
   *  resolved, then return the tiles it lays out for a clip drawn at `pxPerSecond`. */
  async function laidOut(pxPerSecond: number, image?: LoadedSheetImage) {
    const store = new FilmstripStore()
    const item = clip({ proxySrc: 'proxy.mp4', start: 0, end: 10 })
    const viewport: Viewport = { pxPerSecond, scrollSeconds: 0, widthPx: 1000 }
    // The rect the painter would compute: the clip's own on-screen width.
    const r = rect({ width: (item.end - item.start) * pxPerSecond })
    const ctx = () => queryCtx(image ? { viewport, loader: fakeLoader(image) } : { viewport })

    store.clipTiles(item, r, ctx())        // starts the index fetch
    await flush()
    store.clipTiles(item, r, ctx())        // index ready — starts the sheet fetch
    await flush()
    return { tiles: store.clipTiles(item, r, ctx()) ?? [], rect: r }
  }

  it('lays every tile inside the clip\'s frames band, never over the waveform half', async () => {
    const { tiles, rect: r } = await laidOut(60)
    const band = clipBands(r).frames

    expect(tiles.length).toBeGreaterThan(0)
    for (const tile of tiles) {
      expect(tile.rect.y).toBe(band.y)
      expect(tile.rect.height).toBe(band.height)
    }
  })

  it('sizes each full cell square to the band height, so frames are never stretched', async () => {
    const { tiles, rect: r } = await laidOut(60)
    const band = clipBands(r).frames

    // The final cell is clipped by the clip's right edge; every other one is a
    // full square.
    for (const tile of tiles.slice(0, -1)) expect(tile.rect.width).toBe(band.height)
    expect(tiles[tiles.length - 1].rect.width).toBeLessThanOrEqual(band.height)
  })

  it('crops each tile to its cell rather than squeezing a 9:16 frame into it', async () => {
    // A 450x1600 sheet over 5 cols x 2 rows gives 90x800 tiles — vertical
    // footage, the shape this editor actually cuts. Into a square cell the
    // crop must keep the full width and take a centered square of the height.
    const { tiles } = await laidOut(60, loadedImage(450, 1600))
    const first = tiles[0]

    expect(first.sw).toBe(90)   // full tile width, untouched
    expect(first.sh).toBe(90)   // 800 cropped down to a square
    expect(first.sy).toBe(355)  // centered: (800 - 90) / 2
  })

  it('walks further through the source per cell as you zoom out', async () => {
    // The point of sizing cells by the band instead of by the tile interval:
    // the same strip re-derives which frames it shows at every zoom. Zoomed
    // out, each cell spans seconds and lands on a different tile; zoomed in,
    // cells span fractions of a second and several share the nearest tile.
    const outCells = (await laidOut(12)).tiles
    const inCells = (await laidOut(200)).tiles
    const distinct = (tiles: typeof outCells) => new Set(tiles.map(t => `${t.sx},${t.sy}`)).size

    expect(distinct(outCells)).toBe(outCells.length)
    expect(distinct(inCells)).toBeLessThan(inCells.length)
  })
})

describe('FilmstripStore sheet-load laziness', () => {
  it('only requests the sheet(s) whose tiles are needed for the visible range', async () => {
    const store = new FilmstripStore()
    const index = filmstripIndexFixture({
      interval: 1,
      sheets: [
        { path: 'sheet0.jpg', cols: 5, rows: 2, tiles: Array.from({ length: 10 }, (_, i) => ({ t: i, row: Math.floor(i / 5), col: i % 5 })) },
        { path: 'sheet1.jpg', cols: 5, rows: 2, tiles: Array.from({ length: 10 }, (_, i) => ({ t: 10 + i, row: Math.floor(i / 5), col: i % 5 })) },
      ],
    })
    const urls: string[] = []
    const loader: SheetImageLoader = vi.fn((url: string) => { urls.push(url); return Promise.resolve(loadedImage()) })
    const item = clip({ start: 0, end: 20, proxySrc: 'proxy.mp4' })
    // Only the first 1000px (5s at 200px/s) of the 20s clip is "on screen" —
    // the shape a `clampRectToSurface`d rect has for a clip scrolled partly
    // off the right edge.
    const onScreenRect = rect({ x: 0, width: 1000, height: 56 })
    const ctx = queryCtx({ getFilmstrip: vi.fn().mockResolvedValue(index), loader, viewport: { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 } })

    store.clipTiles(item, onScreenRect, ctx)
    await flush()
    store.clipTiles(item, onScreenRect, ctx) // index now ready — this call requests the needed sheet(s)

    expect(urls.some(u => u.includes('sheet0'))).toBe(true)
    expect(urls.some(u => u.includes('sheet1'))).toBe(false)
  })
})

// ── Quiet retry ──────────────────────────────────────────────────────────

describe('FilmstripStore quiet retry', () => {
  it('swallows a rejected index fetch quietly and retries on the next call once cooldown elapses', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0)
    const store = new FilmstripStore()
    const onReady = vi.fn()
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(filmstripIndexFixture())
    const item = clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 })
    const ctx = () => queryCtx({ getFilmstrip: fetcher, onReady, viewport: { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 } })

    expect(() => store.clipTiles(item, rect({ width: 1000 }), ctx())).not.toThrow()
    await flush()
    expect(onReady).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)

    nowSpy.mockReturnValue(FETCH_RETRY_COOLDOWN_MS + 1)
    store.clipTiles(item, rect({ width: 1000 }), ctx())
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onReady).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
  })

  it('does not retry a still-cooling-down error on the very next call (paint-rate request storm)', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0)
    const store = new FilmstripStore()
    const onReady = vi.fn()
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const item = clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 })
    const ctx = () => queryCtx({ getFilmstrip: fetcher, onReady, viewport: { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 } })

    store.clipTiles(item, rect({ width: 1000 }), ctx())
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Same mocked Date.now() as the error — still in cooldown, no refetch.
    store.clipTiles(item, rect({ width: 1000 }), ctx())
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
  })
})

// ── Draw integration via drawTimelineContent (draw.ts) ────────────────────

function project(over: Partial<Project> = {}): Project {
  return { id: 'p1', ...over } as unknown as Project
}

function viewport(over: Partial<Viewport> = {}): Viewport {
  return { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000, ...over }
}

function scene(over: Partial<TimelineScene> = {}): TimelineScene {
  const p = over.project ?? project()
  return {
    project: p,
    viewport: viewport(),
    layout: computeTimelineLayout(p),
    selectedIds: [],
    surfaceWidth: 1000,
    surfaceHeight: 200,
    ...over,
  }
}

describe('drawTimelineContent filmstrip + waveform composition', () => {
  it('draws the filmstrip background and the waveform overlay together, in one drawContent hook', () => {
    const p = project({ tracks: [{ id: 'trk-0', items: [clip({ id: 'c0', start: 0, end: 4, proxySrc: 'proxy.mp4' })] }] })
    const r = recordingContext()
    const tiles: FilmstripTileDraw[] = [{ image: {} as CanvasImageSource, sx: 0, sy: 0, sw: 160, sh: 90, rect: { x: 0, y: 0, width: 800, height: 56 } }]
    const columns: WaveformColumn[] = [{ min: -1, max: 1 }, { min: -0.5, max: 0.5 }]

    drawTimelineContent(r.ctx, scene({
      project: p,
      layout: computeTimelineLayout(p),
      filmstrips: { clipTiles: (item) => (item.id === 'c0' ? tiles : null) },
      waveforms: { clipColumns: (item) => (item.id === 'c0' ? columns : null), audioColumns: () => null },
    }))

    expect(r.of('drawImage')).toHaveLength(1) // the filmstrip tile
    // fill + border + 2 waveform bars, at minimum.
    expect(r.of('fillRect').length).toBeGreaterThanOrEqual(4)
  })

  it('degrades to exactly T6\'s original waveform-only draw-call count when no filmstrip provider is set', () => {
    const p = project({ tracks: [{ id: 'trk-0', items: [clip({ id: 'c0', start: 0, end: 4 })] }] })
    const withScene = recordingContext()
    drawTimelineContent(withScene.ctx, scene({
      project: p,
      layout: computeTimelineLayout(p),
      waveforms: { clipColumns: () => null, audioColumns: () => null },
    }))
    const withoutFilmstripsKey = recordingContext()
    drawTimelineContent(withoutFilmstripsKey.ctx, scene({
      project: p,
      layout: computeTimelineLayout(p),
      filmstrips: undefined,
      waveforms: { clipColumns: () => null, audioColumns: () => null },
    }))
    expect(withScene.calls.length).toBe(withoutFilmstripsKey.calls.length)
    expect(withScene.of('drawImage')).toHaveLength(0)
  })
})
