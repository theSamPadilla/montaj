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
 * Proxy first for VIDEO: input is `item.proxySrc` when there is one, else
 * `item.src`, so a clip with no proxy (yet, or ever) still shows its frames.
 * Fetch identity is that input, so an SSE-delivered proxy arriving mid-session
 * re-keys onto the proxy and fetches automatically. On top of that, the index fetch is gated on the clip
 * actually intersecting the viewport's visible time range.
 *
 * An IMAGE item has no proxy and no per-frame step to fetch from — a still is
 * already exactly one frame. It reads `item.src` directly (the same field and
 * the same `fileUrl` path `OverlayItemsLayer.tsx` uses to draw it in the
 * preview) and repeats that one decoded image across every cell; see
 * `clipTiles` below.
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
import { isScene3dItem } from '../../scene3d'

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
  // An overlay strip is rendered from the overlay itself, so its tiles sit on
  // the item's own clock (0 = its start), not on a source in-point.
  if (item.type === 'overlay') return timelineTime - item.start
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
  /** Project frame rate, sent with an overlay strip request. Default 30. */
  fps?: number
  /** Project canvas [width, height]; default 1080x1920. */
  resolution?: [number, number]
  /** The adapter's `watchFile`; a change to an overlay's src bumps its strip
   *  revision so the next paint requests fresh frames. Absent → never bumps. */
  watchFile?: (path: string, onChange: () => void, projectId?: string) => () => void
  /** True while a timeline gesture (trim, move) is running; an overlay strip is
   *  not requested then. Absent → the settle delay alone applies. */
  gestureActive?: () => boolean
  /** The base track's items (tracks[0]): an overlay's tiles are composed over
   *  the base footage's frame at the same timeline time. Absent → over the
   *  overlay's own fill. */
  baseItems?: readonly VisualItem[]
}

/** A caption template's overlay is never drawn as a strip. */
const CAPTION_TEMPLATE = /(^|[\\/])templates[\\/]captions[\\/]/

export function isCaptionOverlay(item: VisualItem): boolean {
  return item.type === 'overlay' && typeof item.src === 'string' && CAPTION_TEMPLATE.test(item.src)
}


/** An overlay's strip key must stay unchanged this long before a request is
 *  made, so a trim or prop drag does not render a strip per intermediate size. */
export const OVERLAY_SETTLE_MS = 400

/** The saved 3D file a 3D item draws, project-relative (render/scene3d.js):
 *  `models/scenes/<id>/active.json`, or the project's own `models/active.json`
 *  when it names none. Null for an id the engine would refuse. Watched, so a
 *  saved 3D re-renders its strip. */
export function scene3dWatchPath(props: Record<string, unknown> | undefined): string | null {
  const scene = props?.scene
  if (scene === undefined) return 'models/active.json'
  return typeof scene === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(scene) ? `models/scenes/${scene}/active.json` : null
}

/** A 3D item's props as its strip request carries them: which 3D and where in
 *  it, without what a stage derives from them (`sceneFile`, the whole
 *  `sceneJson`), which the engine reads afresh from the saved 3D. */
export function scene3dRequestProps(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k !== 'sceneFile' && k !== 'sceneJson') out[k] = v
  }
  return out
}

/** JSON with object keys sorted, so equal props always make equal keys. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
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
  /** Per `${projectId}|${src}`: bumped when the host reports the file changed. */
  private revisions = new Map<string, number>()
  private unwatchers = new Map<string, () => void>()
  /** Per `${projectId}|${item id}`: the strip key it is waiting on and since when. */
  private settling = new Map<string, { key: string; since: number; timer: ReturnType<typeof setTimeout> | null }>()
  /** Per `${projectId}|${item id}`: the last strip that was ready, drawn while a new key waits. */
  private lastReady = new Map<string, { src: string; key: string }>()

  /** Stop every overlay file watch and settle timer. Call on unmount. */
  dispose(): void {
    for (const off of this.unwatchers.values()) off()
    this.unwatchers.clear()
    for (const s of this.settling.values()) if (s.timer) clearTimeout(s.timer)
    this.settling.clear()
  }

  /**
   * Background tile strip for a clip's rect. `null` whenever there's nothing
   * to draw: an item that is neither a video with a proxy nor an image with a
   * source, no adapter support, off the visible range, a zero-height frames
   * band, or the image/sheets not decoded yet — all graceful, never an error
   * state the caller has to handle specially.
   *
   * Video and image items share the same cell grid (sized off the frames
   * band, aligned to the clip's own start — see below) and the same
   * center-crop math, but differ in what fills a cell: a video walks its
   * fetched sheet index for the tile nearest each cell's source time, while a
   * still has no per-frame step at all — every cell repeats the SAME decoded
   * image (`resolveSheetImage`, keyed by `item.src` exactly as a video sheet
   * is keyed by its path), loaded the same way the preview draws it
   * (`OverlayItemsLayer.tsx`'s `fileUrl(item.src)`). One decode serves every
   * cell and every future repaint, never one decode per tile.
   */
  clipTiles(item: VisualItem, rect: Rect, ctx: FilmstripQueryContext): FilmstripTileDraw[] | null {
    const videoSrc = item.type === 'video' ? (item.proxySrc ?? item.src) : undefined
    const original = item.type === 'video' && !item.proxySrc
    const isVideo = !!videoSrc && !!ctx.getFilmstrip
    const isImage = item.type === 'image' && !!item.src
    const isOverlay = item.type === 'overlay' && !!item.src && !!ctx.getFilmstrip && !isCaptionOverlay(item)
    if ((!isVideo && !isImage && !isOverlay) || !ctx.fileUrl) return null
    if (rect.width <= 0 || rect.height <= 0) return null
    const range = visibleRange(ctx.viewport)
    if (item.end < range.start || item.start > range.end) return null

    // An overlay's frames fill the whole item; a clip's sit in the top band.
    const band = item.type === 'overlay' ? rect : clipBands(rect).frames
    if (band.height <= 0) return null

    // For a video, no sheet index yet means nothing to draw at all — bail
    // before doing any cell-grid work. An image has no index to wait on.
    const resolved = isVideo ? this.resolveIndex(videoSrc!, ctx, original)
      : isOverlay ? this.resolveOverlayIndex(item, ctx) : null
    if ((isVideo || isOverlay) && (!resolved || resolved.tiles.length === 0)) return null
    // An overlay that covers too little of its frame to read (the engine's
    // `visual: false`) draws as the plain box.
    if (isOverlay && resolved!.data.visual === false) return null

    // An image's one photo, decoded once and reused for every cell below.
    const stillImage = isImage ? this.resolveSheetImage(item.src!, ctx) : null
    if (isImage && !stillImage) return null // not decoded yet — cells stay blank until onReady fires

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
      const dest: Rect = { x: cellLeft, y: band.y, width: cellRight - cellLeft, height: band.height }

      if (stillImage) {
        // The same photo in every cell — there is only ever one frame.
        const full: TileSourceRect = { sx: 0, sy: 0, sw: stillImage.width, sh: stillImage.height }
        const src = centerCropTo(full, dest.width / dest.height)
        out.push({ image: stillImage.image, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, rect: dest })
        continue
      }

      const { data: index, tiles } = resolved!
      const cellCenterTime = xToTime((cellLeft + cellRight) / 2, ctx.viewport)
      const sourceTime = clipTimeToSourceTime(item, cellCenterTime)
      const tile = nearestTile(tiles, sourceTime)
      if (!tile) continue

      const sheet = index.sheets[tile.sheetIdx]
      const img = this.resolveSheetImage(sheet.path, ctx)
      if (!img) continue // sheet not decoded yet — this cell just stays blank until onReady fires

      const src = centerCropTo(tileSourceRect(sheet, tile, img.width, img.height), dest.width / dest.height)
      // An overlay's tile keeps its transparency: the base footage's frame at
      // this time goes under it, so a mask or a card reads as it renders.
      if (isOverlay) {
        const under = this.baseTileAt(cellCenterTime, dest, ctx)
        if (under) out.push(under)
      }
      out.push({ image: img.image, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, rect: dest })
    }
    return out.length > 0 ? out : null
  }

  /** The base track's frame at timeline time `t`, cropped into `dest`: the
   *  video (or image) clip on tracks[0] covering `t`, its strip read the way
   *  its own clip reads it (`proxySrc ?? src`, mapped to source time). Null
   *  when nothing is under `t` or its frames are not loaded yet. */
  private baseTileAt(t: number, dest: Rect, ctx: FilmstripQueryContext): FilmstripTileDraw | null {
    const base = ctx.baseItems?.find(i => (i.type === 'video' || i.type === 'image') && i.start <= t && t < i.end)
    if (!base) return null
    if (base.type === 'image') {
      const img = base.src ? this.resolveSheetImage(base.src, ctx) : null
      if (!img) return null
      const src = centerCropTo({ sx: 0, sy: 0, sw: img.width, sh: img.height }, dest.width / dest.height)
      return { image: img.image, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, rect: dest }
    }
    const path = base.proxySrc ?? base.src
    if (!path || !ctx.getFilmstrip) return null
    const resolved = this.resolveIndex(path, ctx, !base.proxySrc)
    if (!resolved) return null
    const tile = nearestTile(resolved.tiles, clipTimeToSourceTime(base, t))
    if (!tile) return null
    const sheet = resolved.data.sheets[tile.sheetIdx]
    const img = this.resolveSheetImage(sheet.path, ctx)
    if (!img) return null
    const src = centerCropTo(tileSourceRect(sheet, tile, img.width, img.height), dest.width / dest.height)
    return { image: img.image, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, rect: dest }
  }


  /** Look up the index for `src`, kicking off a fetch when absent. Never
   *  re-fetches while loading or once ready; an errored entry is retried on
   *  the next call that needs it (same quiet-retry shape as T6), except an
   *  `original` (a clip with no proxy, read from its source file: slow, so a
   *  failure or timeout is not asked again). */
  private resolveIndex(src: string, ctx: FilmstripQueryContext, original = false): { data: FilmstripIndex; tiles: FlatTile[] } | null {
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
      && (original || Date.now() - (entry.erroredAt ?? 0) < FETCH_RETRY_COOLDOWN_MS)
    if (entry?.status !== 'loading' && !inCooldown) {
      const fetcher = ctx.getFilmstrip
      if (fetcher) {
        this.indexEntries.set(key, { status: 'loading', data: null, tiles: [] })
        fetcher({ projectId: ctx.projectId, src, maxTiles: ctx.maxTiles, minInterval: ctx.minInterval, tileWidth: ctx.tileWidth, ...(original ? { original: true } : {}) })
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

  /** Index for an overlay item's strip. Key = src + props + fonts + duration
   *  + fps + the src's revision. A key is requested only once it has been
   *  unchanged for `OVERLAY_SETTLE_MS` (and no gesture is running); until then
   *  the last ready strip for the item is drawn. One request in flight per key,
   *  a rejection is not retried until the cooldown or a new key. */
  private resolveOverlayIndex(item: VisualItem, ctx: FilmstripQueryContext): { data: FilmstripIndex; tiles: FlatTile[] } | null {
    const src = item.src!
    const owner = `${ctx.projectId}|${item.id}`
    // A 3D item's src is the reserved `engine:scene3d`: its props (which 3D,
    // where in it) tell two 3D strips apart, and its saved 3D file is what is
    // watched for a new revision.
    const scene3d = isScene3dItem(item)
    const scenePath = scene3d ? scene3dWatchPath(item.props) : null
    const rev = scene3d ? (scenePath ? this.watchOverlay(scenePath, ctx) : 0) : this.watchOverlay(src, ctx)
    const props = scene3d ? scene3dRequestProps(item.props) : item.props
    const fps = ctx.fps ?? 30
    const durationSec = item.end - item.start
    const [width, height] = ctx.resolution ?? [1080, 1920]
    const key = `ovl|${ctx.projectId}|${src}|${width}x${height}|${stableJson(props ?? {})}|${stableJson(item.googleFonts ?? [])}|${durationSec}|${fps}|${rev}|${ctx.tileWidth ?? ''}`
    const entry = this.indexEntries.get(key)
    if (entry?.status === 'ready' && entry.data) {
      const prev = this.lastReady.get(owner)
      this.lastReady.set(owner, { src, key })
      if (prev && prev.key !== key) this.releaseStrip(prev.key, entry.data)
      return { data: entry.data, tiles: entry.tiles }
    }
    const fallback = (): { data: FilmstripIndex; tiles: FlatTile[] } | null => {
      const last = this.lastReady.get(owner)
      const prev = last && last.src === src ? this.indexEntries.get(last.key) : undefined
      return prev?.status === 'ready' && prev.data ? { data: prev.data, tiles: prev.tiles } : null
    }
    if (entry?.status === 'loading') return fallback()

    // Settle: wait for the key to hold still before asking the host.
    let st = this.settling.get(owner)
    if (!st || st.key !== key) {
      if (st?.timer) clearTimeout(st.timer)
      st = { key, since: Date.now(), timer: null }
      this.settling.set(owner, st)
    }
    const waiting = Date.now() - st.since < OVERLAY_SETTLE_MS
    const gesture = !waiting && !!ctx.gestureActive?.()
    if (waiting || gesture) {
      if (!st.timer) {
        const onReady = ctx.onReady
        const mine = st
        st.timer = setTimeout(() => {
          mine.timer = null
          if (mine.key === key) onReady()
        }, OVERLAY_SETTLE_MS)
      }
      return fallback()
    }

    // A failed key is never asked again on its own (a strip that fails once
    // fails the same way); a new key or revision asks again.
    if (entry?.status !== 'error' && ctx.getFilmstrip) {
      this.indexEntries.set(key, { status: 'loading', data: null, tiles: [] })
      ctx.getFilmstrip({
        projectId: ctx.projectId,
        src,
        tileWidth: ctx.tileWidth,
        overlay: { props, googleFonts: item.googleFonts, fps, durationSec, width, height, revision: rev },
      })
        .then(data => {
          this.indexEntries.set(key, { status: 'ready', data, tiles: flattenTiles(data) })
          ctx.onReady()
        })
        .catch(() => {
          this.indexEntries.set(key, { status: 'error', data: null, tiles: [], erroredAt: Date.now() })
        })
    }
    return fallback()
  }

  /** An owner moved off strip `key`: unless another item still shows it, drop
   *  its index and its decoded sheets (bar any the new strip shares). */
  private releaseStrip(key: string, next: FilmstripIndex): void {
    for (const held of this.lastReady.values()) if (held.key === key) return
    const old = this.indexEntries.get(key)?.data
    this.indexEntries.delete(key)
    if (!old) return
    const keep = new Set(next.sheets.map(s => s.path))
    for (const sheet of old.sheets) if (!keep.has(sheet.path)) this.imageEntries.delete(sheet.path)
  }

  /** Start the file watch for an overlay src (once per project and src);
   *  returns the src's current revision. */
  private watchOverlay(src: string, ctx: FilmstripQueryContext): number {
    const k = `${ctx.projectId}|${src}`
    if (ctx.watchFile && !this.unwatchers.has(k)) {
      const onReady = ctx.onReady
      this.unwatchers.set(k, ctx.watchFile(src, () => {
        this.revisions.set(k, (this.revisions.get(k) ?? 0) + 1)
        onReady()
      }, ctx.projectId))
    }
    return this.revisions.get(k) ?? 0
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
