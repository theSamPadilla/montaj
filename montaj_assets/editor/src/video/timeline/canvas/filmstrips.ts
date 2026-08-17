/**
 * Canvas filmstrip rendering (SP5 T7) — lazy tile-sheet fetch by zoom
 * threshold + visible range, tile draw as each clip's background content
 * layer, and the hover-scrub preview thumb on the overlay layer.
 *
 * Mirrors `waveforms.ts` (T6)'s shape and conventions throughout: a small
 * fetch-state store held for the lifetime of a mounted `TimelineCanvas`,
 * idle/loading/ready/error per key, quiet failure with retry-on-next-call,
 * `onReady` as the redraw signal. Two differences follow directly from what a
 * filmstrip actually is:
 *
 * - Peaks are one fetch per clip; a filmstrip is TWO fetch layers — the
 *   index (JSON: which sheets exist, which tile is at which `t`) and the
 *   sheet IMAGES themselves (JPEGs, decoded for `drawImage`). Both are
 *   cached here, independently, so a clip whose index is ready but whose
 *   sheet hasn't finished decoding degrades to "no tiles yet" rather than an
 *   error.
 * - Filmstrip data has TWO consumers on two different canvas layers: the
 *   content layer draws the background tile strip inside the clip rect
 *   (`clipTiles`), and the overlay layer draws the hover-scrub thumb
 *   (`hoverTile`) — see the `onReady` doc on `FilmstripQueryContext` for why
 *   that means always invalidating both layers, not just the caller's own.
 *
 * ── Fetch policy (SP5 plan decision 6 + T7 task) ──────────────────────────
 * Proxy-only: input is `item.proxySrc` ONLY, never `item.src` — no proxy, no
 * filmstrip, no fallback decode of the original, no error, no spinner (same
 * shape as T6's clip waveforms). Fetch identity includes `proxySrc`, so an
 * SSE-delivered proxy arriving mid-session re-keys and fetches automatically.
 * On top of that, the index fetch is gated on BOTH: the zoom crossing
 * `FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND`, and the clip actually
 * intersecting the viewport's visible time range — filmstrips are a
 * zoomed-in feature, not a background prefetch.
 *
 * ── Alignment ──────────────────────────────────────────────────────────
 * Filmstrip tiles are indexed by ABSOLUTE source-file time (the step tiles
 * the whole proxy, unwindowed — unlike peaks, `GetFilmstripArgs` has no
 * `start`/`duration`). A trimmed clip's timeline time is mapped to source
 * time via `clipTimeToSourceTime`, the same inPoint-anchored alignment T6's
 * `clipSourceWindow` uses, assuming the same 1:1 timeline-to-source rate T6
 * assumes (no speed ramps).
 */
import type { VisualItem } from '../../../schema'
import type { FilmstripIndex, FilmstripSheet, GetFilmstripArgs } from '../../../types'
import { roundRectPath, type DrawContext, type Rect } from './draw'
import { timeToX, visibleRange, xToTime, type Viewport } from './viewport'
import { formatTime } from '../utils'
import { FETCH_RETRY_COOLDOWN_MS } from './waveforms'

// ── Zoom threshold ───────────────────────────────────────────────────────

/** The `filmstrip` step's own default tile width (`filmstrip.py`'s
 *  `tile-width=160`). */
const DEFAULT_TILE_WIDTH_PX = 160

/** The step's own default `min-interval` (1.0s) — the shortest gap between
 *  tiles the step ever produces without an explicit override, so it's the
 *  right basis for a threshold computed before any real index has arrived. */
const DEFAULT_MIN_INTERVAL_S = 1.0

/**
 * Filmstrips fetch and draw only once the timeline is zoomed in to at least
 * this many px/second. Below it, a filmstrip's tile-interval cell (≥1s at the
 * step's default `min-interval`) would render narrower than a tile's own
 * pixel width — every tile squeezed into a sliver of itself, all cost and no
 * legibility. Pinning the threshold to `tileWidth / minInterval` (both step
 * defaults: 160 / 1.0 = 160) means "zoomed in enough" is defined by the same
 * numbers the step itself uses for a full-size tile, not an arbitrary pick.
 */
export const FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND = DEFAULT_TILE_WIDTH_PX / DEFAULT_MIN_INTERVAL_S

/** Floor on a cell's pixel width so a degenerate (zero/negative) `interval`
 *  from a malformed index can't turn the draw loop into a huge iteration —
 *  `rect`/viewport bounds already cap total width, so this only matters for
 *  bad data, not normal zoom ranges. */
const MIN_CELL_PX = 4

// ── Source-time alignment ────────────────────────────────────────────────

/**
 * Map a timeline time within `item`'s span to the corresponding SOURCE-file
 * time. Filmstrip tiles are indexed by absolute source time (the whole proxy,
 * unwindowed), so — unlike `waveforms.ts`'s `clipSourceWindow`, which can
 * return "no window" — this is always defined: `item.inPoint ?? 0` anchors
 * the clip's own start, and every other timeline time offsets from it 1:1.
 */
export function clipTimeToSourceTime(item: VisualItem, timelineTime: number): number {
  const inPoint = item.inPoint ?? 0
  return inPoint + (timelineTime - item.start)
}

// ── Tile selection ───────────────────────────────────────────────────────

/** One tile, flattened out of its sheet with the sheet's index folded in —
 *  the shape `nearestTile`'s binary search and the draw loop both work over,
 *  independent of how many sheets an index actually has. */
export interface FlatTile {
  t: number
  sheetIdx: number
  row: number
  col: number
}

/** Flatten every sheet's tiles into one ascending-`t` list. Sheets and their
 *  tiles are already produced in time order by the uniform-grid `filmstrip`
 *  step, so concatenation in sheet order preserves the ordering
 *  `nearestTile`'s binary search relies on. */
export function flattenTiles(index: FilmstripIndex): FlatTile[] {
  const out: FlatTile[] = []
  index.sheets.forEach((sheet, sheetIdx) => {
    for (const tile of sheet.tiles) out.push({ t: tile.t, sheetIdx, row: tile.row, col: tile.col })
  })
  return out
}

/**
 * The tile whose `t` is closest to `sourceTime`, by binary search over the
 * ascending list `flattenTiles` produces. `null` only for an empty index.
 * Clamps naturally at both ends: a `sourceTime` before the first tile or
 * after the last returns that end tile, exactly like a scrub bar's nearest
 * frame at either edge of the source.
 */
export function nearestTile(tiles: readonly FlatTile[], sourceTime: number): FlatTile | null {
  if (tiles.length === 0) return null
  let lo = 0
  let hi = tiles.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tiles[mid].t < sourceTime) lo = mid + 1
    else hi = mid
  }
  if (lo > 0) {
    const prev = tiles[lo - 1]
    const curr = tiles[lo]
    if (Math.abs(prev.t - sourceTime) <= Math.abs(curr.t - sourceTime)) return prev
  }
  return tiles[lo]
}

// ── Source-rect math ─────────────────────────────────────────────────────

export interface TileSourceRect { sx: number; sy: number; sw: number; sh: number }

/**
 * The tile's sub-rect within its sheet IMAGE (not the nominal `tileWidth` —
 * the loaded image's own natural width/height divided by the grid, so
 * rounding in the step's actual output never drifts from what's drawn).
 */
export function tileSourceRect(
  sheet: FilmstripSheet,
  tile: { row: number; col: number },
  sheetImageWidth: number,
  sheetImageHeight: number,
): TileSourceRect {
  const sw = sheet.cols > 0 ? sheetImageWidth / sheet.cols : sheetImageWidth
  const sh = sheet.rows > 0 ? sheetImageHeight / sheet.rows : sheetImageHeight
  return { sx: tile.col * sw, sy: tile.row * sh, sw, sh }
}

// ── Injectable image loading ─────────────────────────────────────────────

export interface LoadedSheetImage {
  image: CanvasImageSource
  width: number
  height: number
}

export type SheetImageLoader = (url: string) => Promise<LoadedSheetImage>

/**
 * Default loader: a plain `Image()` element. Kept deliberately simple (no
 * `fetch`+`createImageBitmap` round trip) since `img.src` already handles
 * the host's URL scheme (auth cookies, relative paths) the same way every
 * other image in the editor loads. Tests inject a fake via
 * `FilmstripQueryContext.loader` — jsdom never fires a real `load` event.
 */
export const defaultSheetImageLoader: SheetImageLoader = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ image: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height })
    img.onerror = () => reject(new Error(`filmstrip sheet failed to load: ${url}`))
    img.src = url
  })

// ── Draw primitives ──────────────────────────────────────────────────────

/** One tile positioned at its destination rect, ready for `ctx.drawImage`. */
export interface FilmstripTileDraw {
  image: CanvasImageSource
  sx: number
  sy: number
  sw: number
  sh: number
  rect: Rect
}

/** Paint the background tile strip inside a clip rect. Composed with T6's
 *  waveform inside `drawTimelineContent`'s single `drawContent` hook (see
 *  draw.ts): filmstrip tiles first (the background fill), waveform bars
 *  after (the subtle bottom-band overlay). */
export function drawFilmstripTiles(ctx: DrawContext, tiles: readonly FilmstripTileDraw[]): void {
  for (const tile of tiles) {
    if (tile.rect.width <= 0 || tile.rect.height <= 0) continue
    ctx.drawImage(tile.image, tile.sx, tile.sy, tile.sw, tile.sh, tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height)
  }
}

// ── Hover-scrub preview thumb ────────────────────────────────────────────
// Drawn on the OVERLAY layer only (never forces a content redraw) when the
// pointer rests over a clip with no gesture running — "moving along the clip
// flips through frames." Styled to match the canvas' existing chrome: a
// small rounded card (draw.ts's `roundRectPath`) with a hairline border and
// a small mono timecode label, echoing the clip labels' `LABEL_FONT`.

export const HOVER_THUMB_WIDTH_PX = 128
export const HOVER_THUMB_IMAGE_HEIGHT_PX = 72
export const HOVER_THUMB_LABEL_HEIGHT_PX = 16
export const HOVER_THUMB_HEIGHT_PX = HOVER_THUMB_IMAGE_HEIGHT_PX + HOVER_THUMB_LABEL_HEIGHT_PX
export const HOVER_THUMB_GAP_ABOVE_ROW_PX = 8
export const HOVER_THUMB_RADIUS_PX = 6
export const HOVER_THUMB_PAD_PX = 4
export const HOVER_THUMB_LABEL_FONT = '9px ui-monospace, SFMono-Regular, Menlo, monospace'

export const HOVER_THUMB_COLORS = {
  /** Near `TIMELINE_COLORS.rowBackground`, opaque enough to read the frame
   *  clearly over any of `TRACK_PALETTE`'s six clip hues underneath it. */
  card: 'rgba(15,23,42,0.95)',
  border: 'rgba(226,232,240,0.25)',
  label: '#e2e8f0',
} as const

/** A tile resolved for the hovered time, plus its screen anchor — everything
 *  `drawFilmstripHoverThumb` needs to paint. */
export interface FilmstripHoverThumb {
  image: CanvasImageSource
  sx: number
  sy: number
  sw: number
  sh: number
  /** Horizontal CENTER of the thumb, in surface px — the hovered x. */
  x: number
  /** Top of the hovered row; the thumb floats above it. */
  rowTop: number
  /** The matched tile's own source-file time, for the label. */
  t: number
}

function clampThumbLeft(left: number, surfaceWidth: number): number {
  return Math.max(0, Math.min(left, surfaceWidth - HOVER_THUMB_WIDTH_PX))
}

/**
 * Paint the hover-scrub thumb: a rounded card, the matched tile, and its
 * timecode. Floats above `rowTop` with a small gap; when there's no room
 * above (the hovered row sits at the very top of the surface — the common
 * single-track-project case) it clamps to the surface top rather than
 * skipping the draw, so the feature isn't silently unavailable on the most
 * common project shape. Horizontally clamped so it never draws off either
 * edge of the surface.
 */
export function drawFilmstripHoverThumb(ctx: DrawContext, thumb: FilmstripHoverThumb, surfaceWidth: number): void {
  const left = clampThumbLeft(thumb.x - HOVER_THUMB_WIDTH_PX / 2, surfaceWidth)
  const top = Math.max(0, thumb.rowTop - HOVER_THUMB_GAP_ABOVE_ROW_PX - HOVER_THUMB_HEIGHT_PX)

  ctx.save()
  roundRectPath(ctx, left, top, HOVER_THUMB_WIDTH_PX, HOVER_THUMB_HEIGHT_PX, HOVER_THUMB_RADIUS_PX)
  ctx.fillStyle = HOVER_THUMB_COLORS.card
  ctx.fill()
  ctx.strokeStyle = HOVER_THUMB_COLORS.border
  ctx.lineWidth = 1
  ctx.stroke()

  const imgLeft = left + HOVER_THUMB_PAD_PX
  const imgTop = top + HOVER_THUMB_PAD_PX
  const imgWidth = HOVER_THUMB_WIDTH_PX - HOVER_THUMB_PAD_PX * 2
  const imgHeight = HOVER_THUMB_IMAGE_HEIGHT_PX - HOVER_THUMB_PAD_PX
  ctx.drawImage(thumb.image, thumb.sx, thumb.sy, thumb.sw, thumb.sh, imgLeft, imgTop, imgWidth, imgHeight)

  ctx.fillStyle = HOVER_THUMB_COLORS.label
  ctx.font = HOVER_THUMB_LABEL_FONT
  ctx.textBaseline = 'middle'
  ctx.fillText(
    formatTime(thumb.t),
    left + HOVER_THUMB_PAD_PX,
    top + HOVER_THUMB_IMAGE_HEIGHT_PX + HOVER_THUMB_LABEL_HEIGHT_PX / 2,
  )
  ctx.restore()
}

// ── Fetch-state store ─────────────────────────────────────────────────────

type EntryStatus = 'loading' | 'ready' | 'error'

interface IndexEntry {
  status: EntryStatus
  data: FilmstripIndex | null
  tiles: FlatTile[]
  erroredAt?: number
}

interface ImageEntry {
  status: EntryStatus
  image: LoadedSheetImage | null
  erroredAt?: number
}

/**
 * Everything a lookup needs for one call. One instance is built per paint
 * (viewport/onReady can both have moved since the last one); the store
 * itself is what persists across paints.
 *
 * `onReady` deliberately invalidates BOTH canvas layers (callers pass
 * `() => requestRedraw('all')`), not just the caller's own layer. Filmstrip
 * data has two independent consumers — `clipTiles` (content) and `hoverTile`
 * (overlay) — that can both resolve the SAME underlying index/sheet cache
 * entry. Only the call that actually ORIGINATES a fetch gets its `onReady`
 * attached to that fetch's promise (see `resolveIndex`/`resolveSheetImage`
 * below); if content happens to win that race, a `requestRedraw('content')`
 * would resolve the data but never tell the overlay layer it's ready for the
 * hover thumb, and vice versa. Redrawing both sidesteps the race entirely at
 * the cost of one extra (cheap) layer repaint per resolution.
 */
export interface FilmstripQueryContext {
  projectId: string
  /** Absent → no filmstrips anywhere (host adapter doesn't implement it). */
  getFilmstrip?: (args: GetFilmstripArgs) => Promise<FilmstripIndex>
  /** Resolves a sheet's host path to a displayable URL — the SAME mechanism
   *  `WaveformChunk.path` uses (`adapter.fileUrl`, threaded through Timeline
   *  as `resolveFilePath`). Absent → no filmstrips (nothing to load images
   *  through). */
  fileUrl?: (path: string) => string
  viewport: Viewport
  onReady: () => void
  /** Injectable image decoder; defaults to `defaultSheetImageLoader`. */
  loader?: SheetImageLoader
  /** Grid params passed straight through to `getFilmstrip` and folded into
   *  the fetch/cache key — omit to use the step's own defaults. */
  maxTiles?: number
  minInterval?: number
  tileWidth?: number
}

/** What `drawTimelineContent` (draw.ts) needs from T7, kept as an interface
 *  so draw.ts only takes a type-only dependency on this module — mirrors
 *  T6's `WaveformSceneLookup`. */
export interface FilmstripSceneLookup {
  clipTiles(item: VisualItem, rect: Rect): FilmstripTileDraw[] | null
}

/** A tile matched to a hovered time, before it's positioned on screen (that
 *  last step needs the hover point, which the store doesn't hold). */
export interface FilmstripHoverResult {
  image: CanvasImageSource
  sx: number
  sy: number
  sw: number
  sh: number
  t: number
}

export class FilmstripStore {
  private indexEntries = new Map<string, IndexEntry>()
  private imageEntries = new Map<string, ImageEntry>()

  /**
   * Background tile strip for a clip's rect. `null` whenever there's nothing
   * to draw: non-video items, no proxy yet, no adapter support, below the
   * zoom threshold, off the visible range, or the index/sheets not ready
   * yet — all graceful, never an error state the caller has to handle
   * specially.
   */
  clipTiles(item: VisualItem, rect: Rect, ctx: FilmstripQueryContext): FilmstripTileDraw[] | null {
    if (item.type !== 'video' || !item.proxySrc || !ctx.getFilmstrip || !ctx.fileUrl) return null
    if (rect.width <= 0 || rect.height <= 0) return null
    if (ctx.viewport.pxPerSecond < FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND) return null
    const range = visibleRange(ctx.viewport)
    if (item.end < range.start || item.start > range.end) return null

    const resolved = this.resolveIndex(item.proxySrc, ctx)
    if (!resolved || resolved.tiles.length === 0) return null
    const { data: index, tiles } = resolved

    const pxPerSecond = ctx.viewport.pxPerSecond
    const cellPx = Math.max(MIN_CELL_PX, index.interval * pxPerSecond)

    // Only the portion of the clip's cells actually on screen ever touches a
    // sheet — a long base-track clip can have hundreds of cells; a sliver of
    // it visible after a scroll should load one sheet, not all of them.
    const clipLeftX = timeToX(item.start, ctx.viewport)
    const clipRightX = timeToX(item.end, ctx.viewport)
    const drawLeft = Math.max(rect.x, clipLeftX)
    const drawRight = Math.min(rect.x + rect.width, clipRightX)
    if (drawRight <= drawLeft) return null

    // Cell grid aligned to the CLIP's own start (not the visible window), so
    // panning never shifts which frame lands in which cell.
    const firstCellIdx = Math.floor((drawLeft - clipLeftX) / cellPx)
    const out: FilmstripTileDraw[] = []
    for (let x = clipLeftX + firstCellIdx * cellPx; x < drawRight; x += cellPx) {
      const cellLeft = Math.max(x, drawLeft)
      const cellRight = Math.min(x + cellPx, drawRight)
      if (cellRight <= cellLeft) continue

      const cellCenterTime = xToTime((cellLeft + cellRight) / 2, ctx.viewport)
      const sourceTime = clipTimeToSourceTime(item, cellCenterTime)
      const tile = nearestTile(tiles, sourceTime)
      if (!tile) continue

      const sheet = index.sheets[tile.sheetIdx]
      const img = this.resolveSheetImage(sheet.path, ctx)
      if (!img) continue // sheet not decoded yet — this cell just stays blank until onReady fires

      const src = tileSourceRect(sheet, tile, img.width, img.height)
      out.push({
        image: img.image,
        sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh,
        rect: { x: cellLeft, y: rect.y, width: cellRight - cellLeft, height: rect.height },
      })
    }
    return out.length > 0 ? out : null
  }

  /**
   * The nearest tile to `timelineTime` on `item`, for the hover-scrub thumb.
   * Shares the same zoom-threshold gate and index/image cache as
   * `clipTiles` — the thumb is only ever available once the background
   * filmstrip feature itself would be active, never an independent fetch
   * trigger of its own.
   */
  hoverTile(item: VisualItem, timelineTime: number, ctx: FilmstripQueryContext): FilmstripHoverResult | null {
    if (item.type !== 'video' || !item.proxySrc || !ctx.getFilmstrip || !ctx.fileUrl) return null
    if (ctx.viewport.pxPerSecond < FILMSTRIP_ZOOM_THRESHOLD_PX_PER_SECOND) return null

    const resolved = this.resolveIndex(item.proxySrc, ctx)
    if (!resolved || resolved.tiles.length === 0) return null

    const sourceTime = clipTimeToSourceTime(item, timelineTime)
    const tile = nearestTile(resolved.tiles, sourceTime)
    if (!tile) return null

    const sheet = resolved.data.sheets[tile.sheetIdx]
    const img = this.resolveSheetImage(sheet.path, ctx)
    if (!img) return null

    const src = tileSourceRect(sheet, tile, img.width, img.height)
    return { image: img.image, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, t: tile.t }
  }

  /** Look up the index for `src`, kicking off a fetch when absent. Never
   *  re-fetches while loading or once ready; an errored entry is retried on
   *  the next call that needs it (same quiet-retry shape as T6). */
  private resolveIndex(src: string, ctx: FilmstripQueryContext): { data: FilmstripIndex; tiles: FlatTile[] } | null {
    const key = `${ctx.projectId}|${src}|${ctx.maxTiles ?? ''}|${ctx.minInterval ?? ''}|${ctx.tileWidth ?? ''}`
    const entry = this.indexEntries.get(key)
    if (entry?.status === 'ready' && entry.data) return { data: entry.data, tiles: entry.tiles }
    // Fetch when there's no entry yet OR the last attempt errored — an
    // 'error' entry is neither ready nor in flight, so (unlike a bare
    // `!entry` check) it must still be retriable on the next call.
    //
    // An errored entry stays retriable, but not on the very next paint: the
    // overlay layer repaints at ~60Hz during playback, which would turn a
    // persistently-failing fetch into a request storm.
    const inCooldown = entry?.status === 'error'
      && Date.now() - (entry.erroredAt ?? 0) < FETCH_RETRY_COOLDOWN_MS
    if (entry?.status !== 'loading' && !inCooldown) {
      const fetcher = ctx.getFilmstrip
      if (fetcher) {
        this.indexEntries.set(key, { status: 'loading', data: null, tiles: [] })
        fetcher({ projectId: ctx.projectId, src, maxTiles: ctx.maxTiles, minInterval: ctx.minInterval, tileWidth: ctx.tileWidth })
          .then(data => {
            this.indexEntries.set(key, { status: 'ready', data, tiles: flattenTiles(data) })
            ctx.onReady()
          })
          .catch(() => {
            this.indexEntries.set(key, { status: 'error', data: null, tiles: [], erroredAt: Date.now() })
          })
      }
    }
    return null
  }

  /** Look up a decoded sheet image by its host path, kicking off a load when
   *  absent. Same quiet-retry shape as `resolveIndex`. */
  private resolveSheetImage(path: string, ctx: FilmstripQueryContext): LoadedSheetImage | null {
    const entry = this.imageEntries.get(path)
    if (entry?.status === 'ready' && entry.image) return entry.image
    const inCooldown = entry?.status === 'error'
      && Date.now() - (entry.erroredAt ?? 0) < FETCH_RETRY_COOLDOWN_MS
    if (entry?.status !== 'loading' && !inCooldown) {
      const fileUrl = ctx.fileUrl
      if (fileUrl) {
        const loader = ctx.loader ?? defaultSheetImageLoader
        this.imageEntries.set(path, { status: 'loading', image: null })
        loader(fileUrl(path))
          .then(image => {
            this.imageEntries.set(path, { status: 'ready', image })
            ctx.onReady()
          })
          .catch(() => {
            this.imageEntries.set(path, { status: 'error', image: null, erroredAt: Date.now() })
          })
      }
    }
    return null
  }
}
