/**
 * Canvas filmstrip rendering (SP5 T7) — lazy tile-sheet fetch by visible
 * range, drawn as the UPPER BAND of each clip (`clip-bands.ts` splits it with
 * the waveform).
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
 *
 * ── Fetch policy (SP5 plan decision 6 + T7 task) ──────────────────────────
 * Proxy-only: input is `item.proxySrc` ONLY, never `item.src` — no proxy, no
 * filmstrip, no fallback decode of the original, no error, no spinner (same
 * shape as T6's clip waveforms). Fetch identity includes `proxySrc`, so an
 * SSE-delivered proxy arriving mid-session re-keys and fetches automatically.
 * On top of that, the index fetch is gated on the clip actually intersecting
 * the viewport's visible time range.
 *
 * There is no longer a ZOOM gate. Filmstrips used to fetch and draw only above
 * 160 px/s, because a cell was sized at one tile-interval and below that
 * threshold every tile rendered as a sliver of itself. Cells are now sized by
 * the frames band instead (see `clipTiles`), so zooming out yields fewer,
 * full-size frames rather than many squeezed ones and the threshold has
 * nothing left to protect. The cost this trades away is real: opening a
 * project now runs the `filmstrip` step for every visible clip instead of only
 * once someone zooms in. It is cached per proxy after the first run.
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
import { clipBands } from './clip-bands'
import type { DrawContext, Rect } from './draw'
import { timeToX, visibleRange, xToTime, type Viewport } from './viewport'
import { FETCH_RETRY_COOLDOWN_MS } from './waveforms'

// ── Cell sizing ──────────────────────────────────────────────────────────

/**
 * Aspect ratio of one filmstrip cell, width ÷ height. Square: the footage this
 * edits is 9:16, and a band-height-tall cell at the source's own aspect would
 * be a ~27px sliver at every zoom. A square cell center-cropped out of the
 * frame (see `centerCropTo`) trades the top and bottom of the picture for a
 * thumbnail wide enough to recognize a shot from.
 */
export const FILMSTRIP_CELL_ASPECT = 1

/** Floor on a cell's pixel width, so a degenerate (zero/negative) band height
 *  can't turn the draw loop into a huge iteration. Normal cells are sized from
 *  the frames band, which is tens of px tall. */
const MIN_CELL_PX = 4

// ── Source-time alignment ────────────────────────────────────────────────

/**
 * Map a timeline time within `item`'s span to the corresponding SOURCE-file
 * time. Filmstrip tiles are indexed by absolute source time (the whole proxy,
 * unwindowed), so — unlike `waveforms.ts`'s `clipSourceWindow`, which can
 * return "no window" — this is always defined: `item.inPoint ?? 0` anchors
 * the clip's own start, and the speed factor carries every other timeline time
 * out from there.
 *
 * `·(item.speed ?? 1)` converts elapsed TIMELINE-seconds into SOURCE-seconds:
 * a clip at speed S consumes S× the source per project second. This mirrors
 * `timeline-core`'s `seekTime`, the canonical form the playback engine and the
 * renderer both apply. Strict no-op at S=1, so a project with no speeds set
 * draws exactly as it did.
 *
 * It was 1:1 before, which was correct only while speed did not exist. Once it
 * did, the filmstrip and the per-clip waveform told two different stories
 * about the same clip: the waveform windows to `inPoint..outPoint`, which is
 * speed-correct by construction, while the frames marched through the source
 * at 1× — running off the end of a slowed clip and freezing on the last tile
 * it could find, or repeating themselves on a sped-up one.
 */
export function clipTimeToSourceTime(item: VisualItem, timelineTime: number): number {
  const inPoint = item.inPoint ?? 0
  return inPoint + (item.speed ?? 1) * (timelineTime - item.start)
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

/**
 * Narrow `src` to the largest centered sub-rect matching `destAspect`
 * (width ÷ height), so a tile drawn into that destination fills it without
 * distortion. Vertical 9:16 footage into a square cell loses the top and
 * bottom; wide footage into the same cell loses the sides.
 *
 * Applied per CELL rather than once per tile because the cells at a clip's
 * left and right edges are clipped narrower than a full one — cropping to the
 * destination's actual aspect keeps those partial cells undistorted too,
 * which cropping to a fixed square would not.
 *
 * A non-positive aspect or a degenerate source returns `src` unchanged: the
 * caller's own `width <= 0` guards already skip those, and silently returning
 * the uncropped rect is safer than emitting NaNs into `drawImage`.
 */
export function centerCropTo(src: TileSourceRect, destAspect: number): TileSourceRect {
  if (!(destAspect > 0) || src.sw <= 0 || src.sh <= 0) return src
  const srcAspect = src.sw / src.sh
  if (srcAspect > destAspect) {
    const sw = src.sh * destAspect
    return { sx: src.sx + (src.sw - sw) / 2, sy: src.sy, sw, sh: src.sh }
  }
  const sh = src.sw / destAspect
  return { sx: src.sx, sy: src.sy + (src.sh - sh) / 2, sw: src.sw, sh }
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

/** Paint the tile strip. Destination rects already sit in the clip's frames
 *  band (`clipTiles` places them), so this just blits — composed with the
 *  waveform inside `drawTimelineContent`'s single `drawContent` hook (draw.ts),
 *  which paints the two bands into disjoint halves of the clip. */
export function drawFilmstripTiles(ctx: DrawContext, tiles: readonly FilmstripTileDraw[]): void {
  for (const tile of tiles) {
    if (tile.rect.width <= 0 || tile.rect.height <= 0) continue
    ctx.drawImage(tile.image, tile.sx, tile.sy, tile.sw, tile.sh, tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height)
  }
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
 * `onReady` invalidates the content layer, the only consumer of filmstrip
 * data. Note that only the call which ORIGINATES a fetch gets its `onReady`
 * attached to that fetch's promise (see `resolveIndex`/`resolveSheetImage`
 * below) — every other clip waiting on the same sheet is repainted by that one
 * callback, since a content redraw repaints them all.
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

export class FilmstripStore {
  private indexEntries = new Map<string, IndexEntry>()
  private imageEntries = new Map<string, ImageEntry>()

  /**
   * Background tile strip for a clip's rect. `null` whenever there's nothing
   * to draw: non-video items, no proxy yet, no adapter support, off the
   * visible range, a zero-height frames band, or the index/sheets not ready
   * yet — all graceful, never an error state the caller has to handle
   * specially.
   */
  clipTiles(item: VisualItem, rect: Rect, ctx: FilmstripQueryContext): FilmstripTileDraw[] | null {
    if (item.type !== 'video' || !item.proxySrc || !ctx.getFilmstrip || !ctx.fileUrl) return null
    if (rect.width <= 0 || rect.height <= 0) return null
    const range = visibleRange(ctx.viewport)
    if (item.end < range.start || item.start > range.end) return null

    const band = clipBands(rect).frames
    if (band.height <= 0) return null

    const resolved = this.resolveIndex(item.proxySrc, ctx)
    if (!resolved || resolved.tiles.length === 0) return null
    const { data: index, tiles } = resolved

    // Cell width comes from the BAND HEIGHT, not from the index's tile
    // interval — that is what makes the strip re-derive itself as you zoom.
    // Each cell is one fixed-aspect thumbnail, so the clip's pixel width alone
    // decides how many frames fit: zoom in and the same span grows more cells,
    // each landing on a nearer tile; zoom out and it collapses to a few
    // widely-spaced frames. Sizing cells by `interval * pxPerSecond` instead
    // (the original) pinned one cell per tile at every zoom, which meant cells
    // narrower than a tile when zoomed out and stretched frames when zoomed in.
    const cellPx = Math.max(MIN_CELL_PX, band.height * FILMSTRIP_CELL_ASPECT)

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

      const dest: Rect = { x: cellLeft, y: band.y, width: cellRight - cellLeft, height: band.height }
      const src = centerCropTo(tileSourceRect(sheet, tile, img.width, img.height), dest.width / dest.height)
      out.push({ image: img.image, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, rect: dest })
    }
    return out.length > 0 ? out : null
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
