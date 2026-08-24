/**
 * Canvas timeline viewport (SP5 T4) — the scroll/zoom model the canvas surface
 * draws through, plus the DPR-crisp rendering plumbing.
 *
 * ── Why a new model ──────────────────────────────────────────────────────
 * The DOM timeline zooms by widening a container to `zoom × 100%` and letting
 * the browser scroll it, so its zoom is "multiples of container width" against
 * a content-dependent `totalDuration`. That model can't zoom out past fit, and
 * its px/second silently changes whenever a clip moves (totalDuration is
 * derived from content). The canvas uses the model every NLE uses instead:
 *
 *   pxPerSecond   how many CSS pixels one second occupies
 *   scrollSeconds the time at the left edge of the surface
 *
 * Time↔pixel conversion is then a pure affine map, independent of content.
 * The DOM path keeps its own model untouched (`useTimelineZoom`); the zoom
 * badge bridges the two by reporting a fit-relative multiple (`zoomMultiple`)
 * so the numbers users know stay recognizable.
 *
 * Everything above `createViewportStore` is pure math with no DOM access, so
 * it is unit-testable and reusable by hit-testing (T5) and the content layers
 * (T6/T7).
 */

import { useRef, useSyncExternalStore } from 'react'

export interface Viewport {
  /** CSS pixels per second of timeline. */
  pxPerSecond: number
  /** Time at x=0 of the drawing surface, in seconds. */
  scrollSeconds: number
  /** Width of the drawing surface in CSS pixels (0 before first layout). */
  widthPx: number
}

/** Absolute floor on zoom-out. One pixel per second is already an hour of
 *  timeline across a 3600px surface — further out is not a useful view. */
export const MIN_PX_PER_SECOND = 1

/** Absolute ceiling on zoom-in: ~66px per frame at 30fps, which is as far as
 *  any frame-accurate trim needs. */
export const MAX_PX_PER_SECOND = 2000

/** How far below "fit the whole project" zoom-out is allowed to go, as a
 *  fraction of the fit scale. The DOM model bottomed out AT fit; pulling back
 *  from the content is a deliberate improvement (it gives drop room past the
 *  last clip) — but only so far. At `0.5` the content bottoms out filling HALF
 *  the surface width (one content-length of drop room past the end), instead of
 *  shrinking to a sliver: CapCut caps its max zoom-out the same way, and a
 *  quarter-width timeline (the old `0.25`) is more empty canvas than anyone
 *  needs to reach the end. `MIN_PX_PER_SECOND` still floors this for a project
 *  long enough that half-width would fall below it. */
export const MIN_FIT_MULTIPLE = 0.5

/** Extra scroll past the end of the content, as a fraction of one screenful,
 *  so the rightmost item can always be dragged/trimmed further out. */
export const OVERSCROLL_FRACTION = 0.25

/** Multiplicative step for the chrome's +/− zoom buttons. */
export const ZOOM_BUTTON_FACTOR = 1.5

// ── Pure math ────────────────────────────────────────────────────────────

/** px/second at which `totalDuration` exactly fills `widthPx`. 0 when either
 *  is degenerate (no surface yet, or an empty project). */
export function fitPxPerSecond(widthPx: number, totalDuration: number): number {
  if (widthPx <= 0 || totalDuration <= 0) return 0
  return widthPx / totalDuration
}

export function clampPxPerSecond(pxPerSecond: number, widthPx: number, totalDuration: number): number {
  const fit = fitPxPerSecond(widthPx, totalDuration)
  const lower = Math.min(
    fit > 0 ? Math.max(MIN_PX_PER_SECOND, fit * MIN_FIT_MULTIPLE) : MIN_PX_PER_SECOND,
    MAX_PX_PER_SECOND,
  )
  if (!Number.isFinite(pxPerSecond)) return lower
  return Math.min(MAX_PX_PER_SECOND, Math.max(lower, pxPerSecond))
}

/** Seconds visible across the surface at the current scale. */
export function visibleDuration(vp: Viewport): number {
  return vp.pxPerSecond > 0 ? vp.widthPx / vp.pxPerSecond : 0
}

export function visibleRange(vp: Viewport): { start: number; end: number } {
  return { start: vp.scrollSeconds, end: vp.scrollSeconds + visibleDuration(vp) }
}

/** Surface x (CSS px) for a timeline time. */
export function timeToX(t: number, vp: Viewport): number {
  return (t - vp.scrollSeconds) * vp.pxPerSecond
}

/** Timeline time for a surface x (CSS px, relative to the surface's left). */
export function xToTime(x: number, vp: Viewport): number {
  return vp.pxPerSecond > 0 ? vp.scrollSeconds + x / vp.pxPerSecond : vp.scrollSeconds
}

/** Rightmost legal `scrollSeconds`: the end of the content, less a screenful,
 *  plus overscroll headroom. Zero whenever the content already fits. */
export function maxScrollSeconds(vp: Viewport, totalDuration: number): number {
  const visible = visibleDuration(vp)
  return Math.max(0, totalDuration - visible + visible * OVERSCROLL_FRACTION)
}

/** Clamp to [0, maxScroll]. Scrolling left of t=0 is never allowed — blank
 *  space before the start of the timeline reads as a bug, not headroom. */
export function clampScrollSeconds(scrollSeconds: number, vp: Viewport, totalDuration: number): number {
  if (!Number.isFinite(scrollSeconds)) return 0
  return Math.max(0, Math.min(maxScrollSeconds(vp, totalDuration), scrollSeconds))
}

/** How close to the surface's left/right edge a drag's pointer must sit before
 *  edge auto-scroll starts panning the view to follow it (CSS px). */
export const EDGE_SCROLL_ZONE_PX = 40

/** Panning speed at the edge itself, in content CSS px/second — ramps linearly
 *  from 0 at the zone's outer boundary up to this at the surface edge. Fast
 *  enough to cross a long timeline without feeling like a jump, slow enough to
 *  stay controllable right at the zone's threshold. */
export const EDGE_SCROLL_MAX_PX_PER_SEC = 600

/**
 * How many seconds to pan the viewport for one animation frame of an active
 * drag whose pointer sits at `pointerX` (CSS px from the surface's left edge —
 * the same `Point.x` a gesture already works in). Zero outside the
 * `edgeZonePx` band at either edge; ramps linearly from 0 at the zone's outer
 * boundary to `maxPxPerSec` (content px/second) at the surface edge itself,
 * and holds at `maxPxPerSec` for a pointer that has travelled PAST the edge —
 * a drag driven by document-level listeners (not native pointer capture) can
 * report an x outside [0, canvasWidth] once the real cursor leaves the
 * surface.
 *
 * Negative = pan left/earlier, positive = pan right/later, 0 = the pointer is
 * not near either edge. Framerate-independent: the ramped speed is scaled by
 * `dtSeconds` and converted from content px/second to timeline seconds via
 * `pxPerSecond`, so callers can feed it a real frame delta and get a
 * consistent pan regardless of the display's refresh rate.
 */
export function edgeScrollDelta(
  pointerX: number,
  canvasWidth: number,
  pxPerSecond: number,
  dtSeconds: number,
  edgeZonePx: number,
  maxPxPerSec: number,
): number {
  if (canvasWidth <= 0 || pxPerSecond <= 0 || edgeZonePx <= 0 || dtSeconds <= 0) return 0

  const leftBoundary = edgeZonePx
  const rightBoundary = canvasWidth - edgeZonePx

  let depthPx: number
  let direction: -1 | 1
  if (pointerX < leftBoundary) {
    depthPx = leftBoundary - pointerX
    direction = -1
  } else if (pointerX > rightBoundary) {
    depthPx = pointerX - rightBoundary
    direction = 1
  } else {
    return 0
  }

  const ratio = Math.min(1, depthPx / edgeZonePx)
  const contentPxPerSecond = ratio * maxPxPerSec
  return (direction * contentPxPerSecond * dtSeconds) / pxPerSecond
}

/**
 * Zoom by `factor`, keeping the time under `pivotX` pinned to `pivotX`. Same
 * semantics as the DOM path's `useTimelineZoom.zoomTo` (which pins a pivot
 * percentage through a pending scrollLeft write) expressed directly in the
 * px/second model: solve `pivotTime = scroll' + pivotX / pps'` for `scroll'`.
 *
 * The pivot only drifts when the new scroll would leave the legal range —
 * i.e. at the ends of the timeline, exactly where the DOM path drifts too.
 */
export function zoomAtPivot(vp: Viewport, factor: number, pivotX: number, totalDuration: number): Viewport {
  const pivotTime = xToTime(pivotX, vp)
  const pxPerSecond = clampPxPerSecond(vp.pxPerSecond * factor, vp.widthPx, totalDuration)
  const zoomed: Viewport = { ...vp, pxPerSecond }
  return { ...zoomed, scrollSeconds: clampScrollSeconds(pivotTime - pivotX / pxPerSecond, zoomed, totalDuration) }
}

/** Horizontal pan by a pixel delta (positive = content moves left / later). */
export function panByPixels(vp: Viewport, deltaPx: number, totalDuration: number): Viewport {
  if (vp.pxPerSecond <= 0) return vp
  return { ...vp, scrollSeconds: clampScrollSeconds(vp.scrollSeconds + deltaPx / vp.pxPerSecond, vp, totalDuration) }
}

/** Scale so the whole project fills the surface, scrolled to the start. */
export function fitViewport(vp: Viewport, totalDuration: number): Viewport {
  return {
    ...vp,
    pxPerSecond: clampPxPerSecond(fitPxPerSecond(vp.widthPx, totalDuration), vp.widthPx, totalDuration),
    scrollSeconds: 0,
  }
}

/** The zoom number the chrome shows: 1× is fit, 2× is twice as close in. Keeps
 *  continuity with the DOM path's badge, whose 1× also meant fit. */
export function zoomMultiple(vp: Viewport, totalDuration: number): number {
  const fit = fitPxPerSecond(vp.widthPx, totalDuration)
  return fit > 0 ? vp.pxPerSecond / fit : 1
}

export function formatZoomMultiple(multiple: number): string {
  if (!Number.isFinite(multiple) || multiple <= 0) return '1'
  if (multiple >= 10) return String(Math.round(multiple))
  return multiple.toFixed(1)
}

/** Re-derive the viewport for a new surface width. Scale is preserved (a wider
 *  window shows more time, it does not rescale the content) except on the very
 *  first layout, where there is no scale yet and we start fitted. */
export function withSurfaceWidth(vp: Viewport, widthPx: number, totalDuration: number): Viewport {
  if (widthPx <= 0) return vp.widthPx === widthPx ? vp : { ...vp, widthPx }
  const sized: Viewport = { ...vp, widthPx }
  if (vp.pxPerSecond <= 0) return fitViewport(sized, totalDuration)
  const rescaled: Viewport = { ...sized, pxPerSecond: clampPxPerSecond(sized.pxPerSecond, widthPx, totalDuration) }
  return { ...rescaled, scrollSeconds: clampScrollSeconds(rescaled.scrollSeconds, rescaled, totalDuration) }
}

/** Re-clamp after the project's duration changed (clips added/moved/deleted). */
export function reclampForDuration(vp: Viewport, totalDuration: number): Viewport {
  if (vp.widthPx <= 0) return vp
  if (vp.pxPerSecond <= 0) return fitViewport(vp, totalDuration)
  const rescaled: Viewport = { ...vp, pxPerSecond: clampPxPerSecond(vp.pxPerSecond, vp.widthPx, totalDuration) }
  return { ...rescaled, scrollSeconds: clampScrollSeconds(rescaled.scrollSeconds, rescaled, totalDuration) }
}

export function viewportsEqual(a: Viewport, b: Viewport): boolean {
  return a.pxPerSecond === b.pxPerSecond && a.scrollSeconds === b.scrollSeconds && a.widthPx === b.widthPx
}

// ── Wheel semantics (ported from useTimelineZoom) ────────────────────────

export type WheelIntent =
  | { kind: 'zoom'; factor: number; pivotX: number }
  | { kind: 'pan'; deltaPx: number }
  | { kind: 'none' }

export interface WheelLike {
  deltaX: number
  deltaY: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * What a wheel event means to the canvas timeline. Ported from the DOM path:
 *
 *   ⌘/Ctrl + wheel  zoom, multiplicatively, pivoted at the cursor. The
 *                   `exp(-deltaY * 0.002)` step is the DOM path's verbatim, so
 *                   a wheel tick (deltaY ≈ 100) is the same ≈18% either side.
 *   Alt + wheel     horizontal pan by deltaY pixels.
 *   plain wheel     NOT intercepted — the page/container must keep scrolling
 *                   vertically. The one exception is a horizontally-dominant
 *                   plain wheel (trackpad two-finger swipe), which the DOM
 *                   path's `overflow-x: auto` container consumed for free and
 *                   the canvas must consume explicitly or lose the gesture.
 */
export function wheelIntent(e: WheelLike, pivotX: number): WheelIntent {
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-e.deltaY * 0.002), pivotX }
  if (e.altKey) return { kind: 'pan', deltaPx: e.deltaY }
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return { kind: 'pan', deltaPx: e.deltaX }
  return { kind: 'none' }
}

export function applyWheelIntent(vp: Viewport, intent: WheelIntent, totalDuration: number): Viewport {
  switch (intent.kind) {
    case 'zoom': return zoomAtPivot(vp, intent.factor, intent.pivotX, totalDuration)
    case 'pan':  return panByPixels(vp, intent.deltaPx, totalDuration)
    default:     return vp
  }
}

// ── DPR-crisp surface plumbing ───────────────────────────────────────────
// No precedent existed in this repo for a resolution-independent 2D canvas
// (the engine's painter draws into a fixed-size video canvas), so this is the
// one place that knows about devicePixelRatio. Everything else works in CSS
// pixels and never sees the backing store.

export interface SurfaceMetrics {
  cssWidth: number
  cssHeight: number
  dpr: number
}

/** Backing-store pixel size for a CSS box at a given DPR. Rounded, never 0 —
 *  a zero-sized canvas throws on some `getContext` paths. */
export function backingStoreSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  const scale = dpr > 0 ? dpr : 1
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  }
}

/** Size a canvas' backing store for its CSS box. Returns true when it changed
 *  (writing `canvas.width` clears the canvas, so callers redraw on true). */
export function syncCanvasBackingStore(canvas: HTMLCanvasElement, metrics: SurfaceMetrics): boolean {
  const { width, height } = backingStoreSize(metrics.cssWidth, metrics.cssHeight, metrics.dpr)
  if (canvas.width === width && canvas.height === height) return false
  canvas.width = width
  canvas.height = height
  return true
}

/** Put the context in CSS-pixel space. `setTransform` rather than `scale` so
 *  it is idempotent — a per-frame `scale(dpr, dpr)` would compound. */
export function scaleContextToDpr(ctx: CanvasRenderingContext2D, dpr: number): void {
  const scale = dpr > 0 ? dpr : 1
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
}

export function currentDpr(): number {
  if (typeof window === 'undefined') return 1
  return window.devicePixelRatio || 1
}

/**
 * Watch an element's CSS size AND the window's device-pixel ratio, calling
 * back with both. The DPR half matters when the window is dragged between a
 * Retina and a non-Retina display: no resize fires, but every backing store is
 * now the wrong size and text renders blurry (or over-sharp). `matchMedia` on
 * a `resolution` query is the only event-driven DPR signal browsers give, and
 * it must be re-armed after each change because the query pins the old value.
 *
 * Returns a disposer. Degrades to a window-resize fallback where
 * ResizeObserver is unavailable (jsdom), and to nothing where matchMedia is.
 */
export function observeSurface(el: HTMLElement, onChange: (metrics: SurfaceMetrics) => void): () => void {
  const emit = () => {
    const rect = el.getBoundingClientRect()
    onChange({ cssWidth: rect.width, cssHeight: rect.height, dpr: currentDpr() })
  }

  const disposers: Array<() => void> = []

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => emit())
    ro.observe(el)
    disposers.push(() => ro.disconnect())
  } else if (typeof window !== 'undefined') {
    const onResize = () => emit()
    window.addEventListener('resize', onResize)
    disposers.push(() => window.removeEventListener('resize', onResize))
  }

  disposers.push(watchDpr(emit))
  emit()

  return () => { for (const d of disposers) d() }
}

/** Fire `onChange` whenever devicePixelRatio changes, re-arming the query. */
export function watchDpr(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  let disposed = false
  let detach: () => void = () => {}

  const arm = () => {
    if (disposed) return
    const mql = window.matchMedia(`(resolution: ${currentDpr()}dppx)`)
    const handler = () => {
      detach()
      arm()
      onChange()
    }
    // Safari < 14 only has the deprecated addListener/removeListener pair.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      detach = () => mql.removeEventListener('change', handler)
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(handler)
      detach = () => mql.removeListener(handler)
    } else {
      detach = () => {}
    }
  }

  arm()
  return () => { disposed = true; detach() }
}

// ── Store ────────────────────────────────────────────────────────────────
// The viewport is an external store, not React state, for the same reason the
// playhead is (see playback-clock.ts): a wheel-zoom gesture fires dozens of
// updates a second, and re-rendering Timeline — which owns the caption row's
// hundreds of DOM nodes — on each one is exactly the cost the canvas exists to
// avoid. The canvas redraws imperatively from `get()`; only the zoom badge
// subscribes for rendering.

export interface ViewportStore {
  get(): Viewport
  set(next: Viewport | ((prev: Viewport) => Viewport)): void
  subscribe(cb: () => void): () => void
}

export const INITIAL_VIEWPORT: Viewport = { pxPerSecond: 0, scrollSeconds: 0, widthPx: 0 }

export function createViewportStore(initial: Viewport = INITIAL_VIEWPORT): ViewportStore {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next
      if (viewportsEqual(resolved, value)) return
      value = resolved
      subs.forEach(cb => cb())
    },
    subscribe(cb) {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
  }
}

/** A store whose identity is stable for the lifetime of the component. */
export function useViewportStore(): ViewportStore {
  const ref = useRef<ViewportStore | null>(null)
  if (ref.current === null) ref.current = createViewportStore()
  return ref.current
}

/** Subscribe a component to the viewport. Only display chrome (the zoom badge)
 *  should use this — the canvas itself reads `store.get()` inside its draw. */
export function useViewportValue(store: ViewportStore): Viewport {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
