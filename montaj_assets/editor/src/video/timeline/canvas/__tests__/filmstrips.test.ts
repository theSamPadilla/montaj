/**
 * SP5 T7 — canvas filmstrip rendering: the zoom/visibility fetch gate, the
 * ported sheet-index fetch-state store, tile selection + source-rect math,
 * the draw hooks wired into `drawClipRect`/`drawTimelineContent` (draw.ts,
 * composed with T6's waveform), and the hover-scrub thumb on the overlay
 * layer. Follows waveforms.test.ts's (T6) conventions throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, act, cleanup } from '@testing-library/react'
import type { VisualItem } from '../../../../schema'
import type { FilmstripIndex, FilmstripSheet, Project } from '../../../../types'
import {
  FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND,
  FilmstripStore,
  clipTimeToSourceTime,
  defaultSheetImageLoader,
  drawFilmstripHoverThumb,
  drawFilmstripTiles,
  flattenTiles,
  nearestTile,
  tileSourceRect,
  type FilmstripHoverThumb,
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
import type { Viewport } from '../viewport'
import { createViewportStore } from '../viewport'
import { createPlaybackClock } from '../../../playback-clock'
import TimelineCanvas from '../TimelineCanvas'

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
  return { x: 0, y: 0, width: 100, height: 40, ...over }
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

// ── Zoom threshold ─────────────────────────────────────────────────────────

describe('FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND', () => {
  it('is the filmstrip step\'s default tile width over its default min-interval (160 / 1.0)', () => {
    expect(FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND).toBe(160)
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

describe('drawFilmstripHoverThumb', () => {
  function thumb(over: Partial<FilmstripHoverThumb> = {}): FilmstripHoverThumb {
    return { image: {} as CanvasImageSource, sx: 0, sy: 0, sw: 160, sh: 90, x: 500, rowTop: 100, t: 12.3, ...over }
  }

  it('draws a card, the matched tile image, and a timecode label', () => {
    const r = recordingContext()
    drawFilmstripHoverThumb(r.ctx, thumb(), 1000)

    expect(r.of('drawImage')).toHaveLength(1)
    expect(r.of('fillText').some(c => String(c.args[0]).startsWith('0:12'))).toBe(true)
  })

  it('clamps horizontally so the card never starts left of the surface', () => {
    const r = recordingContext()
    drawFilmstripHoverThumb(r.ctx, thumb({ x: 0 }), 1000)
    const start = r.calls.find(c => c.method === 'moveTo')!.args as number[]
    expect(start[0]).toBeGreaterThanOrEqual(0)
  })

  it('clamps horizontally so the card never runs off the right of the surface', () => {
    const r = recordingContext()
    drawFilmstripHoverThumb(r.ctx, thumb({ x: 1000 }), 1000)
    const start = r.calls.find(c => c.method === 'moveTo')!.args as number[]
    expect(start[0]).toBeLessThanOrEqual(1000)
  })

  it('clamps to the surface top rather than skipping the draw when there is no room above the row', () => {
    const r = recordingContext()
    drawFilmstripHoverThumb(r.ctx, thumb({ rowTop: 0 }), 1000)
    expect(r.of('drawImage')).toHaveLength(1)
  })
})

// ── Fetch-state store: clipTiles fetch policy ─────────────────────────────

describe('FilmstripStore.clipTiles fetch policy', () => {
  const belowThreshold: Viewport = { pxPerSecond: FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND - 1, scrollSeconds: 0, widthPx: 1000 }
  const aboveThreshold: Viewport = { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 } // visible range [0, 5]

  it('does not fetch below the zoom threshold, even when the clip is visible', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: belowThreshold }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not fetch above the threshold when the clip is off the visible range', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 100, end: 105 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: aboveThreshold }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fetches once both the zoom and visibility conditions hold', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn().mockResolvedValue(filmstripIndexFixture())
    store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: aboveThreshold }))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('never fetches when the item has no proxySrc', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    store.clipTiles(clip({ start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: aboveThreshold }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never fetches for a non-video item even with a proxySrc set', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn()
    const imageItem = clip({ type: 'image', proxySrc: 'proxy.mp4', start: 0, end: 5 } as Partial<VisualItem> as VisualItem)
    store.clipTiles(imageItem, rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: aboveThreshold }))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fires a fetch once a proxySrc arrives (SSE import completion), since the key changes', () => {
    const store = new FilmstripStore()
    const fetcher = vi.fn().mockResolvedValue(filmstripIndexFixture())

    store.clipTiles(clip({ start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: aboveThreshold }))
    expect(fetcher).not.toHaveBeenCalled()

    store.clipTiles(clip({ start: 0, end: 5, proxySrc: 'proxy.mp4' }), rect({ width: 1000 }), queryCtx({ getFilmstrip: fetcher, viewport: aboveThreshold }))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('stays inert (never fetches, never throws) when the adapter has no getFilmstrip', () => {
    const store = new FilmstripStore()
    expect(() =>
      store.clipTiles(clip({ proxySrc: 'proxy.mp4', start: 0, end: 5 }), rect({ width: 1000 }), queryCtx({ getFilmstrip: undefined, viewport: aboveThreshold })),
    ).not.toThrow()
  })
})

// ── Sheet-load laziness ────────────────────────────────────────────────────

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

// ── hoverTile ────────────────────────────────────────────────────────────

describe('FilmstripStore.hoverTile', () => {
  const aboveThreshold: Viewport = { pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 }

  it('resolves the nearest tile for a hovered timeline time', async () => {
    const store = new FilmstripStore()
    const ctx = () => queryCtx({ viewport: aboveThreshold })
    const item = clip({ proxySrc: 'proxy.mp4', start: 0, end: 10 })

    store.hoverTile(item, 4.4, ctx()) // starts the index fetch
    await flush()
    store.hoverTile(item, 4.4, ctx()) // index ready — starts the sheet-image fetch
    await flush()
    const result = store.hoverTile(item, 4.4, ctx()) // sheet ready — returns the tile

    expect(result).not.toBeNull()
    expect(result!.t).toBe(4)
  })

  it('aligns a trimmed clip through inPoint before matching a tile', async () => {
    const store = new FilmstripStore()
    const index = filmstripIndexFixture({
      interval: 1,
      sheets: [{ path: 's0.jpg', cols: 20, rows: 1, tiles: Array.from({ length: 20 }, (_, i) => ({ t: i, row: 0, col: i })) }],
    })
    const ctx = () => queryCtx({ getFilmstrip: vi.fn().mockResolvedValue(index), viewport: aboveThreshold })
    // Trimmed clip: on-timeline [0,5) shows source [10,15).
    const item = clip({ start: 0, end: 5, inPoint: 10, proxySrc: 'proxy.mp4' })

    store.hoverTile(item, 2, ctx())
    await flush()
    store.hoverTile(item, 2, ctx())
    await flush()
    const result = store.hoverTile(item, 2, ctx())

    expect(result).not.toBeNull()
    expect(result!.t).toBe(12) // source time 10 + 2, not raw timeline time 2
  })

  it('returns null below the zoom threshold', () => {
    const store = new FilmstripStore()
    const item = clip({ proxySrc: 'proxy.mp4', start: 0, end: 10 })
    const result = store.hoverTile(item, 4, queryCtx({ viewport: { pxPerSecond: 10, scrollSeconds: 0, widthPx: 1000 } }))
    expect(result).toBeNull()
  })

  it('returns null for a non-video item, an item with no proxySrc, or an absent adapter method', () => {
    const store = new FilmstripStore()
    expect(store.hoverTile(clip({ proxySrc: undefined }), 4, queryCtx({ viewport: aboveThreshold }))).toBeNull()
    expect(store.hoverTile(clip({ type: 'image', proxySrc: 'p.mp4' } as Partial<VisualItem> as VisualItem), 4, queryCtx({ viewport: aboveThreshold }))).toBeNull()
    expect(store.hoverTile(clip({ proxySrc: 'p.mp4' }), 4, queryCtx({ getFilmstrip: undefined, viewport: aboveThreshold }))).toBeNull()
  })

  it('returns null while the index/sheet are still loading — never an empty placeholder, just no data yet', () => {
    const store = new FilmstripStore()
    const item = clip({ proxySrc: 'proxy.mp4', start: 0, end: 10 })
    // No `await flush()` — the fetch is still in flight.
    expect(store.hoverTile(item, 4, queryCtx({ viewport: aboveThreshold }))).toBeNull()
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
    markerSelection: null,
    markers: [null, null],
    surfaceWidth: 1000,
    surfaceHeight: 200,
    ...over,
  }
}

describe('drawTimelineContent filmstrip + waveform composition', () => {
  it('draws the filmstrip background and the waveform overlay together, in one drawContent hook', () => {
    const p = project({ tracks: [[clip({ id: 'c0', start: 0, end: 4, proxySrc: 'proxy.mp4' })]] })
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
    const p = project({ tracks: [[clip({ id: 'c0', start: 0, end: 4 })]] })
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

// ── TimelineCanvas hover-scrub integration (T7) ────────────────────────────
// The pure store/draw functions above are the unit coverage; this is the one
// thing only a mounted component can show — that an idle hover reaches the
// overlay layer as a drawImage call once data resolves, and that starting a
// gesture suppresses it even after the underlying data is ready. Harness
// mirrors TimelineCanvas.pointer.test.tsx / TimelineCanvas.test.tsx (jsdom
// has no 2D canvas and no real image decode, so both are stubbed).

describe('TimelineCanvas hover-scrub thumb', () => {
  let realGetContext: typeof HTMLCanvasElement.prototype.getContext
  let realGetRect: typeof Element.prototype.getBoundingClientRect
  let realImage: typeof Image
  const recorders = new Map<HTMLCanvasElement, RecordedCall[]>()

  function recorderFor(canvas: HTMLCanvasElement): RecordedCall[] {
    const existing = recorders.get(canvas)
    if (existing) return existing
    const calls: RecordedCall[] = []
    recorders.set(canvas, calls)
    return calls
  }

  function contextFor(canvas: HTMLCanvasElement) {
    const calls = recorderFor(canvas)
    const props: Record<string, unknown> = {}
    return new Proxy({}, {
      get(_t, prop: string) {
        if (prop in props) return props[prop]
        if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
        return (...args: unknown[]) => { calls.push({ method: prop, args }) }
      },
      set(_t, prop: string, value: unknown) {
        props[prop] = value
        calls.push({ method: `set:${prop}`, args: [value] })
        return true
      },
    })
  }

  /** A jsdom-safe `Image()` stand-in: `onload` fires on the next microtask
   *  after `src` is assigned, mimicking a real (fast) decode without needing
   *  jsdom to implement image loading at all. */
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 800
    naturalHeight = 320
    width = 800
    height = 320
    private _src = ''
    set src(v: string) {
      this._src = v
      Promise.resolve().then(() => this.onload?.())
    }
    get src() { return this._src }
  }

  beforeEach(() => {
    recorders.clear()
    realGetContext = HTMLCanvasElement.prototype.getContext
    realGetRect = Element.prototype.getBoundingClientRect
    realImage = globalThis.Image
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return contextFor(this)
    } as unknown as typeof HTMLCanvasElement.prototype.getContext
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 100, width: 1000, height: 100, toJSON: () => ({}) } as DOMRect
    }
    globalThis.Image = FakeImage as unknown as typeof Image
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    HTMLCanvasElement.prototype.getContext = realGetContext
    Element.prototype.getBoundingClientRect = realGetRect
    globalThis.Image = realImage
  })

  const hoverProject = {
    id: 'p1',
    tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', proxySrc: 'proxy.mp4', start: 0, end: 10 }]],
  } as unknown as Project

  function mount(overrides: { getFilmstrip?: FilmstripQueryContext['getFilmstrip']; resolveFilePath?: (p: string) => string } = {}) {
    const store = createViewportStore()
    const clock = createPlaybackClock()
    // Plain `.ts` (not `.tsx`) — no JSX here, so the element is built with
    // `createElement` directly.
    const utils = render(
      createElement(TimelineCanvas, {
        project: hoverProject,
        clock,
        store,
        totalDuration: 10,
        selectedIds: [],
        markers: [null, null],
        ...overrides,
      }),
    )
    act(() => { vi.advanceTimersByTime(32) })
    // Zoom above the filmstrip threshold (160px/s); the whole clip fits on screen.
    act(() => { store.set({ pxPerSecond: 200, scrollSeconds: 0, widthPx: 1000 }) })
    act(() => { vi.advanceTimersByTime(32) })
    const canvases = utils.container.querySelectorAll('canvas')
    return {
      ...utils,
      overlay: recorderFor(canvases[1] as HTMLCanvasElement),
      surface: utils.container.querySelector('[data-timeline-canvas]') as HTMLElement,
    }
  }

  function mouse(type: string, x: number, y: number, init: MouseEventInit = {}) {
    return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, ...init })
  }

  /** Flush the microtasks a fetch/decode round trip needs, then let a
   *  scheduled repaint run. */
  async function settle() {
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => { vi.advanceTimersByTime(32) })
  }

  it('shows the thumb once the index and sheet resolve, from an idle hover', async () => {
    const getFilmstrip = vi.fn().mockResolvedValue(filmstripIndexFixture())
    const resolveFilePath = (p: string) => `/files/${p}`
    const { surface, overlay } = mount({ getFilmstrip, resolveFilePath })

    act(() => { surface.dispatchEvent(mouse('mousemove', 500, 20)) }) // idle hover, over the clip
    act(() => { vi.advanceTimersByTime(32) }) // starts the index fetch
    await settle() // index resolves, starts the sheet-image fetch
    await settle() // sheet resolves, thumb draws

    expect(overlay.some(c => c.method === 'drawImage')).toBe(true)
  })

  it('suppresses the thumb once a gesture starts, even though the data is still cached and ready', async () => {
    const getFilmstrip = vi.fn().mockResolvedValue(filmstripIndexFixture())
    const resolveFilePath = (p: string) => `/files/${p}`
    const { surface, overlay } = mount({ getFilmstrip, resolveFilePath })

    act(() => { surface.dispatchEvent(mouse('mousemove', 500, 20)) })
    act(() => { vi.advanceTimersByTime(32) })
    await settle()
    await settle()
    expect(overlay.some(c => c.method === 'drawImage')).toBe(true) // baseline: the thumb is showing

    overlay.length = 0
    act(() => { surface.dispatchEvent(mouse('mousedown', 500, 20)) }) // gesture starts — clears the hover
    act(() => { document.dispatchEvent(mouse('mousemove', 520, 20)) }) // drag continues over the same clip
    act(() => { vi.advanceTimersByTime(32) })

    expect(overlay.some(c => c.method === 'drawImage')).toBe(false)
    act(() => { document.dispatchEvent(mouse('mouseup', 520, 20)) })
  })

  it('never draws a thumb when the host adapter has no getFilmstrip/resolveFilePath', async () => {
    const { surface, overlay } = mount()
    act(() => { surface.dispatchEvent(mouse('mousemove', 500, 20)) })
    await settle()
    await settle()

    expect(overlay.some(c => c.method === 'drawImage')).toBe(false)
  })
})
