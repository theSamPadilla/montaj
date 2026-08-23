/**
 * FilmstripScrubber — a self-contained hover-scrub thumbnail for one source
 * clip, built for the footage-bin media panel (`docs/plans/footage-bin-media-panel.md`,
 * Phase 2). Unlike the timeline's own `FilmstripStore` (`timeline/canvas/filmstrips.ts`),
 * which tiles the VISIBLE portion of a placed clip across the whole timeline
 * viewport, this component draws exactly ONE tile at a time into a single
 * `<canvas>` sized to its container: the poster frame (source time 0) at rest,
 * and whichever tile is nearest the pointer's horizontal fraction while
 * hovering. It reuses that module's pure tile-selection and blit primitives
 * (`flattenTiles`, `nearestTile`, `tileSourceRect`, `centerCropTo`,
 * `drawFilmstripTiles`, `defaultSheetImageLoader`) rather than duplicating them.
 *
 * `getFilmstrip` is proxy-only and tiles the WHOLE source (no time window), so
 * the index is fetched exactly once per `(projectId, proxySrc)` pair — never
 * re-fetched on hover. Decoded sheet images are cached in a ref, keyed by
 * sheet path, so scrubbing across many tiles from the same sheet never
 * re-decodes it.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { FilmstripIndex, FilmstripSheet, GetFilmstripArgs } from '../types'
import {
  centerCropTo,
  defaultSheetImageLoader,
  drawFilmstripTiles,
  flattenTiles,
  nearestTile,
  tileSourceRect,
  type FlatTile,
  type LoadedSheetImage,
} from '../video/timeline/canvas/filmstrips'
import { Loader } from '../ui/Loader'

export interface FilmstripScrubberProps {
  projectId: string
  /** The source's proxySrc — `getFilmstrip` is proxy-only, per the timeline's
   *  own filmstrip fetch policy (see `filmstrips.ts`'s module doc). */
  proxySrc: string
  /** Seconds, for mapping a hover fraction to a source-file time. */
  sourceDuration: number
  getFilmstrip: (args: GetFilmstripArgs) => Promise<FilmstripIndex>
  fileUrl: (path: string) => string
  className?: string
  ariaLabel?: string
  /**
   * Whether hovering scrubs. Default `true` (the footage-bin thumbnail). When
   * `false`, no pointer-move handler is attached and only the static poster
   * frame (source time 0) is drawn — for a card that owns its own hover
   * handling and drives the main preview instead.
   */
  interactive?: boolean
  /**
   * How the tile fills the canvas. Default `'cover'` (center-crop, unchanged for
   * existing callers). `'contain'` letterboxes the whole tile — preserving its
   * aspect ratio, centered, the remaining area left to the container's neutral
   * background — for an aspect-correct poster.
   */
  fit?: 'cover' | 'contain'
}

type Phase = 'loading' | 'ready' | 'error'

/** Clamp `v` into `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export default function FilmstripScrubber({
  projectId,
  proxySrc,
  sourceDuration,
  getFilmstrip,
  fileUrl,
  className = '',
  ariaLabel = 'Footage preview',
  interactive = true,
  fit = 'cover',
}: FilmstripScrubberProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Keep the injected callbacks in refs so the fetch effect below can depend
  // only on `[projectId, proxySrc]` — a fresh closure identity on every host
  // render (common for inline adapter callbacks) must not trigger a re-fetch.
  const getFilmstripRef = useRef(getFilmstrip)
  useEffect(() => { getFilmstripRef.current = getFilmstrip }, [getFilmstrip])
  const fileUrlRef = useRef(fileUrl)
  useEffect(() => { fileUrlRef.current = fileUrl }, [fileUrl])

  const [phase, setPhase] = useState<Phase>('loading')
  const indexRef = useRef<FilmstripIndex | null>(null)
  const tilesRef = useRef<FlatTile[]>([])
  const imageCacheRef = useRef(new Map<string, LoadedSheetImage>())
  const lastTileRef = useRef<FlatTile | null>(null)
  // Monotonic guard so a slow-resolving image load from an earlier hover
  // position can never paint over a newer one that already loaded/painted.
  const drawRequestIdRef = useRef(0)

  // ── Fetch the index once per (projectId, proxySrc) ──────────────────────
  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    indexRef.current = null
    tilesRef.current = []
    lastTileRef.current = null

    getFilmstripRef.current({ projectId, src: proxySrc })
      .then(index => {
        if (cancelled) return
        indexRef.current = index
        tilesRef.current = flattenTiles(index)
        setPhase('ready')
      })
      .catch(() => {
        if (cancelled) return
        setPhase('error')
      })

    return () => { cancelled = true }
  }, [projectId, proxySrc])

  // ── Canvas backing-store sizing (DPR-aware) ──────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width === width && canvas.height === height) return
      canvas.width = width
      canvas.height = height
      // Writing width/height clears the canvas; repaint whatever was showing.
      if (lastTileRef.current) drawTile(lastTileRef.current)
    }

    resize()

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => resize())
      ro.observe(canvas)
      return () => ro.disconnect()
    }
    return undefined
    // Runs once: the observer (where available) handles every subsequent
    // layout change itself, independent of `phase`.
  }, [])

  // ── Draw the poster frame once the index is ready ───────────────────────
  useEffect(() => {
    if (phase !== 'ready') return
    const tile = nearestTile(tilesRef.current, 0)
    if (tile) drawTile(tile)
  }, [phase])

  /** Paint one tile into the canvas — center-cropped to fill (`cover`), or
   *  letterboxed to preserve aspect (`contain`). */
  function paintTile(sheet: FilmstripSheet, tile: FlatTile, img: LoadedSheetImage) {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const destWidth = canvas.width
    const destHeight = canvas.height
    if (destWidth <= 0 || destHeight <= 0) return

    ctx.clearRect(0, 0, destWidth, destHeight)

    if (fit === 'contain') {
      // Whole tile, scaled to fit inside the canvas, centered. The remaining
      // area is left cleared (transparent) so the container's neutral surface
      // shows through as letterbox bars.
      const full = tileSourceRect(sheet, tile, img.width, img.height)
      if (full.sw > 0 && full.sh > 0) {
        const srcAspect = full.sw / full.sh
        const destAspect = destWidth / destHeight
        const dw = srcAspect > destAspect ? destWidth : destHeight * srcAspect
        const dh = srcAspect > destAspect ? destWidth / srcAspect : destHeight
        drawFilmstripTiles(ctx, [{
          image: img.image,
          sx: full.sx,
          sy: full.sy,
          sw: full.sw,
          sh: full.sh,
          rect: { x: (destWidth - dw) / 2, y: (destHeight - dh) / 2, width: dw, height: dh },
        }])
      }
      lastTileRef.current = tile
      return
    }

    const src = centerCropTo(
      tileSourceRect(sheet, tile, img.width, img.height),
      destWidth / destHeight,
    )
    drawFilmstripTiles(ctx, [{
      image: img.image,
      sx: src.sx,
      sy: src.sy,
      sw: src.sw,
      sh: src.sh,
      rect: { x: 0, y: 0, width: destWidth, height: destHeight },
    }])
    lastTileRef.current = tile
  }

  /** Resolve `tile`'s sheet image (cache or load) and paint it. Stale loads
   *  (superseded by a later call before they resolve) are dropped. */
  function drawTile(tile: FlatTile) {
    const index = indexRef.current
    if (!index) return
    const sheet = index.sheets[tile.sheetIdx]
    if (!sheet) return

    const cached = imageCacheRef.current.get(sheet.path)
    if (cached) {
      paintTile(sheet, tile, cached)
      return
    }

    const requestId = ++drawRequestIdRef.current
    defaultSheetImageLoader(fileUrlRef.current(sheet.path))
      .then(img => {
        imageCacheRef.current.set(sheet.path, img)
        if (drawRequestIdRef.current !== requestId) return
        paintTile(sheet, tile, img)
      })
      .catch(() => {
        // Quiet failure: the canvas keeps showing whatever it last painted
        // (or the neutral placeholder if nothing has painted yet).
      })
  }

  const posterTile = useMemo(() => nearestTile(tilesRef.current, 0), [phase])

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (phase !== 'ready' || tilesRef.current.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const fraction = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const sourceT = fraction * sourceDuration
    const tile = nearestTile(tilesRef.current, sourceT)
    if (tile) drawTile(tile)
  }

  function handlePointerLeave() {
    if (phase !== 'ready') return
    if (posterTile) drawTile(posterTile)
  }

  return (
    <div className={`relative overflow-hidden bg-[var(--editor-surface)] ${className}`}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={ariaLabel}
        className="block h-full w-full"
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerLeave={interactive ? handlePointerLeave : undefined}
      />
      {phase === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader size="sm" />
        </div>
      )}
      {phase === 'error' && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--editor-surface)] text-[10px] text-[var(--editor-text)]/40"
          role="status"
        >
          No preview
        </div>
      )}
    </div>
  )
}
