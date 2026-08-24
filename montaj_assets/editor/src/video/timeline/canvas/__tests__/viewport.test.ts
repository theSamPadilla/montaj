/**
 * SP5 T4 — the canvas timeline's viewport math. Everything asserted here is
 * pure: the surface plumbing (ResizeObserver, matchMedia) is exercised only
 * through its size arithmetic, which is the part that can be wrong silently.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  EDGE_SCROLL_MAX_PX_PER_SEC,
  EDGE_SCROLL_ZONE_PX,
  MAX_PX_PER_SECOND,
  MIN_FIT_MULTIPLE,
  MIN_PX_PER_SECOND,
  OVERSCROLL_FRACTION,
  applyWheelIntent,
  backingStoreSize,
  clampPxPerSecond,
  clampScrollSeconds,
  createViewportStore,
  edgeScrollDelta,
  fitPxPerSecond,
  fitViewport,
  formatZoomMultiple,
  maxScrollSeconds,
  panByPixels,
  reclampForDuration,
  scaleContextToDpr,
  syncCanvasBackingStore,
  timeToX,
  visibleDuration,
  visibleRange,
  wheelIntent,
  withSurfaceWidth,
  xToTime,
  zoomAtPivot,
  zoomMultiple,
  type Viewport,
} from '../viewport'

function vp(overrides: Partial<Viewport> = {}): Viewport {
  return { pxPerSecond: 10, scrollSeconds: 0, widthPx: 1000, ...overrides }
}

describe('time ↔ pixel conversion', () => {
  it('maps time to x through scroll and scale', () => {
    const v = vp({ pxPerSecond: 20, scrollSeconds: 5 })
    expect(timeToX(5, v)).toBe(0)
    expect(timeToX(10, v)).toBe(100)
    expect(timeToX(0, v)).toBe(-100)
  })

  it('round-trips x → time → x', () => {
    const v = vp({ pxPerSecond: 37.5, scrollSeconds: 12.25 })
    for (const x of [0, 1, 250, 999.5]) {
      expect(xToTime(timeToX(xToTime(x, v), v), v)).toBeCloseTo(xToTime(x, v), 10)
    }
  })

  it('reports the visible window from width and scale', () => {
    const v = vp({ pxPerSecond: 50, scrollSeconds: 3, widthPx: 500 })
    expect(visibleDuration(v)).toBe(10)
    expect(visibleRange(v)).toEqual({ start: 3, end: 13 })
  })

  it('degrades safely before the first layout (no width, no scale)', () => {
    const v = vp({ pxPerSecond: 0, widthPx: 0 })
    expect(visibleDuration(v)).toBe(0)
    expect(xToTime(123, v)).toBe(v.scrollSeconds)
  })
})

describe('zoom clamping', () => {
  it('fits the project across the surface', () => {
    expect(fitPxPerSecond(1000, 50)).toBe(20)
    expect(fitPxPerSecond(0, 50)).toBe(0)
    expect(fitPxPerSecond(1000, 0)).toBe(0)
  })

  it('allows zooming out below fit — the DOM model could not', () => {
    const widthPx = 1000
    const totalDuration = 50
    const fit = fitPxPerSecond(widthPx, totalDuration) // 20 px/s
    expect(clampPxPerSecond(fit * 0.5, widthPx, totalDuration)).toBe(fit * 0.5)
    // …but not indefinitely: the floor is a quarter of fit.
    expect(clampPxPerSecond(0.001, widthPx, totalDuration)).toBe(fit * MIN_FIT_MULTIPLE)
  })

  it('never goes below the absolute floor on very long projects', () => {
    // fit here is 0.1 px/s; a quarter of that is unusable, so the floor wins.
    expect(clampPxPerSecond(0.0001, 1000, 10_000)).toBe(MIN_PX_PER_SECOND)
  })

  it('caps zoom-in', () => {
    expect(clampPxPerSecond(1e6, 1000, 50)).toBe(MAX_PX_PER_SECOND)
  })

  it('reports zoom as a fit-relative multiple, for continuity with the DOM badge', () => {
    expect(zoomMultiple(vp({ pxPerSecond: 20, widthPx: 1000 }), 50)).toBe(1)
    expect(zoomMultiple(vp({ pxPerSecond: 40, widthPx: 1000 }), 50)).toBe(2)
    expect(zoomMultiple(vp({ pxPerSecond: 5, widthPx: 1000 }), 50)).toBe(0.25)
    expect(zoomMultiple(vp({ widthPx: 0 }), 50)).toBe(1)
  })

  it('formats the badge with one decimal below 10×', () => {
    expect(formatZoomMultiple(1)).toBe('1.0')
    expect(formatZoomMultiple(2.34)).toBe('2.3')
    expect(formatZoomMultiple(12.4)).toBe('12')
    expect(formatZoomMultiple(Number.NaN)).toBe('1')
  })
})

describe('scroll clamping', () => {
  it('stops at the content end plus a fraction of a screenful', () => {
    const v = vp({ pxPerSecond: 10, widthPx: 1000 }) // 100s visible
    const totalDuration = 300
    expect(maxScrollSeconds(v, totalDuration)).toBe(300 - 100 + 100 * OVERSCROLL_FRACTION)
    expect(clampScrollSeconds(1e6, v, totalDuration)).toBe(maxScrollSeconds(v, totalDuration))
  })

  it('pins to zero when the whole project already fits', () => {
    const v = vp({ pxPerSecond: 10, widthPx: 1000 }) // 100s visible
    expect(maxScrollSeconds(v, 30)).toBe(0)
    expect(clampScrollSeconds(20, v, 30)).toBe(0)
  })

  it('never scrolls before t=0', () => {
    expect(clampScrollSeconds(-12, vp(), 500)).toBe(0)
  })

  it('pans by pixels in the current scale', () => {
    const v = vp({ pxPerSecond: 50, scrollSeconds: 10, widthPx: 500 })
    expect(panByPixels(v, 250, 1000).scrollSeconds).toBe(15)
    expect(panByPixels(v, -250, 1000).scrollSeconds).toBe(5)
    expect(panByPixels(v, -1e6, 1000).scrollSeconds).toBe(0)
  })
})

describe('edge auto-scroll delta', () => {
  // A round scale (100 px/s) keeps the arithmetic legible: 1 content px is
  // 0.01s, so a max speed of 600 px/s is 6 s/s.
  const pxPerSecond = 100
  const canvasWidth = 1000
  const zone = EDGE_SCROLL_ZONE_PX // 40
  const maxSpeed = EDGE_SCROLL_MAX_PX_PER_SEC // 600 px/s

  it('is zero for a pointer in the middle of the surface', () => {
    expect(edgeScrollDelta(500, canvasWidth, pxPerSecond, 1, zone, maxSpeed)).toBe(0)
  })

  it('is zero exactly at the zone boundary, on either side', () => {
    expect(edgeScrollDelta(zone, canvasWidth, pxPerSecond, 1, zone, maxSpeed)).toBe(0)
    expect(edgeScrollDelta(canvasWidth - zone, canvasWidth, pxPerSecond, 1, zone, maxSpeed)).toBe(0)
  })

  it('pans left (negative) inside the left zone, right (positive) inside the right zone', () => {
    expect(edgeScrollDelta(10, canvasWidth, pxPerSecond, 1, zone, maxSpeed)).toBeLessThan(0)
    expect(edgeScrollDelta(canvasWidth - 10, canvasWidth, pxPerSecond, 1, zone, maxSpeed)).toBeGreaterThan(0)
  })

  it('ramps linearly with how deep into the zone the pointer sits', () => {
    // Depth 10/40 = 25% of the way in → 25% of max speed either side.
    const shallow = edgeScrollDelta(zone - 10, canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    // Depth 30/40 = 75% of the way in → 3× the shallow pan.
    const deep = edgeScrollDelta(zone - 30, canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    expect(Math.abs(shallow)).toBeCloseTo((0.25 * maxSpeed * 1) / pxPerSecond, 10)
    expect(Math.abs(deep)).toBeCloseTo((0.75 * maxSpeed * 1) / pxPerSecond, 10)
    expect(Math.abs(deep)).toBeCloseTo(Math.abs(shallow) * 3, 10)

    const shallowRight = edgeScrollDelta(canvasWidth - (zone - 10), canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    const deepRight = edgeScrollDelta(canvasWidth - (zone - 30), canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    expect(shallowRight).toBeCloseTo(-shallow, 10) // mirror image of the left side
    expect(deepRight).toBeCloseTo(-deep, 10)
  })

  it('holds at max speed for a pointer that has travelled past the surface edge', () => {
    // The document-level drag listeners can report an x outside the surface
    // once the real cursor leaves it — depth must clamp, not keep growing.
    const atEdge = edgeScrollDelta(0, canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    const wayPast = edgeScrollDelta(-500, canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    expect(wayPast).toBe(atEdge)
    expect(atEdge).toBeCloseTo(-maxSpeed / pxPerSecond, 10)

    const atRightEdge = edgeScrollDelta(canvasWidth, canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    const wayPastRight = edgeScrollDelta(canvasWidth + 500, canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    expect(wayPastRight).toBe(atRightEdge)
    expect(atRightEdge).toBeCloseTo(maxSpeed / pxPerSecond, 10)
  })

  it('scales with the frame delta — framerate independent', () => {
    const oneFrame = edgeScrollDelta(10, canvasWidth, pxPerSecond, 1 / 60, zone, maxSpeed)
    const doubleFrame = edgeScrollDelta(10, canvasWidth, pxPerSecond, 2 / 60, zone, maxSpeed)
    expect(doubleFrame).toBeCloseTo(oneFrame * 2, 10)
  })

  it('is zero for a non-positive frame delta, px/second, zone, or surface width', () => {
    expect(edgeScrollDelta(10, canvasWidth, pxPerSecond, 0, zone, maxSpeed)).toBe(0)
    expect(edgeScrollDelta(10, canvasWidth, 0, 1, zone, maxSpeed)).toBe(0)
    expect(edgeScrollDelta(10, canvasWidth, pxPerSecond, 1, 0, maxSpeed)).toBe(0)
    expect(edgeScrollDelta(10, 0, pxPerSecond, 1, zone, maxSpeed)).toBe(0)
  })

  it('converts content px/second to timeline seconds through the current scale', () => {
    // At the edge itself (full ramp), a 200 px/s zoom halves the seconds
    // moved compared to the 100 px/s fixture above for the same content speed.
    const atZoomedIn = edgeScrollDelta(0, canvasWidth, 200, 1, zone, maxSpeed)
    const atFixtureScale = edgeScrollDelta(0, canvasWidth, pxPerSecond, 1, zone, maxSpeed)
    expect(atZoomedIn).toBeCloseTo(atFixtureScale / 2, 10)
  })
})

describe('pivot-preserving zoom', () => {
  it('keeps the time under the cursor stationary', () => {
    // Scrolled well into the timeline, so zooming out either way has room and
    // the clamps (covered separately below) never enter the picture.
    const v = vp({ pxPerSecond: 20, scrollSeconds: 100, widthPx: 1000 })
    const totalDuration = 600
    const pivotX = 320
    const pivotTime = xToTime(pivotX, v)

    for (const factor of [1.25, 0.8, 2, 0.5]) {
      const next = zoomAtPivot(v, factor, pivotX, totalDuration)
      expect(next.pxPerSecond).toBeCloseTo(v.pxPerSecond * factor, 10)
      expect(xToTime(pivotX, next)).toBeCloseTo(pivotTime, 10)
    }
  })

  it('holds the pivot across a chain of wheel ticks', () => {
    let v = vp({ pxPerSecond: 20, scrollSeconds: 30, widthPx: 1000 })
    const totalDuration = 600
    const pivotX = 640
    const pivotTime = xToTime(pivotX, v)
    for (let i = 0; i < 12; i++) {
      v = zoomAtPivot(v, Math.exp(-(-100) * 0.002), pivotX, totalDuration)
    }
    expect(xToTime(pivotX, v)).toBeCloseTo(pivotTime, 8)
  })

  it('gives up the pivot only where scroll would leave the legal range', () => {
    // Pivot near the left edge while already scrolled to 0: holding it would
    // require scrolling before t=0.
    const v = vp({ pxPerSecond: 20, scrollSeconds: 0, widthPx: 1000 })
    const next = zoomAtPivot(v, 0.5, 10, 600)
    expect(next.scrollSeconds).toBe(0)
  })

  it('clamps the scale, and keeps scroll legal when it does', () => {
    const v = vp({ pxPerSecond: 1900, scrollSeconds: 100, widthPx: 1000 })
    const next = zoomAtPivot(v, 4, 500, 600)
    expect(next.pxPerSecond).toBe(MAX_PX_PER_SECOND)
    expect(next.scrollSeconds).toBeGreaterThanOrEqual(0)
    expect(next.scrollSeconds).toBeLessThanOrEqual(maxScrollSeconds(next, 600))
  })

  it('fits to the surface and rewinds to the start', () => {
    const fitted = fitViewport(vp({ pxPerSecond: 900, scrollSeconds: 42 }), 50)
    expect(fitted.pxPerSecond).toBe(20)
    expect(fitted.scrollSeconds).toBe(0)
    expect(zoomMultiple(fitted, 50)).toBe(1)
  })
})

describe('wheel semantics (ported from useTimelineZoom)', () => {
  const at = (over: Partial<Parameters<typeof wheelIntent>[0]>) =>
    wheelIntent({ deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false, altKey: false, ...over }, 400)

  it('⌘/Ctrl-wheel zooms at the cursor with the DOM path exp() step', () => {
    const ctrl = at({ ctrlKey: true, deltaY: -100 })
    expect(ctrl).toEqual({ kind: 'zoom', factor: Math.exp(0.2), pivotX: 400 })
    const meta = at({ metaKey: true, deltaY: 100 })
    expect(meta).toEqual({ kind: 'zoom', factor: Math.exp(-0.2), pivotX: 400 })
  })

  it('Alt-wheel pans horizontally by deltaY', () => {
    expect(at({ altKey: true, deltaY: 60 })).toEqual({ kind: 'pan', deltaPx: 60 })
  })

  it('leaves a plain vertical wheel to the page', () => {
    expect(at({ deltaY: 120 })).toEqual({ kind: 'none' })
  })

  it('consumes a horizontally-dominant plain wheel (trackpad swipe)', () => {
    expect(at({ deltaX: 80, deltaY: 5 })).toEqual({ kind: 'pan', deltaPx: 80 })
  })

  it('applies an intent to the viewport', () => {
    const v = vp({ pxPerSecond: 20, scrollSeconds: 10, widthPx: 1000 })
    const zoomed = applyWheelIntent(v, { kind: 'zoom', factor: 2, pivotX: 0 }, 600)
    expect(zoomed.pxPerSecond).toBe(40)
    expect(zoomed.scrollSeconds).toBe(10) // pivot at x=0 is the left edge
    expect(applyWheelIntent(v, { kind: 'pan', deltaPx: 200 }, 600).scrollSeconds).toBe(20)
    expect(applyWheelIntent(v, { kind: 'none' }, 600)).toBe(v)
  })
})

describe('surface size changes', () => {
  it('starts fitted on the first layout', () => {
    const first = withSurfaceWidth({ pxPerSecond: 0, scrollSeconds: 0, widthPx: 0 }, 800, 40)
    expect(first.widthPx).toBe(800)
    expect(first.pxPerSecond).toBe(20)
  })

  it('preserves scale when the window is resized', () => {
    const v = vp({ pxPerSecond: 60, scrollSeconds: 5, widthPx: 1000 })
    const wider = withSurfaceWidth(v, 1400, 600)
    expect(wider.pxPerSecond).toBe(60)
    expect(wider.scrollSeconds).toBe(5)
  })

  it('re-clamps scroll when the project shrinks under the playhead', () => {
    const v = vp({ pxPerSecond: 10, scrollSeconds: 400, widthPx: 1000 })
    const shrunk = reclampForDuration(v, 60)
    expect(shrunk.scrollSeconds).toBe(0)
  })
})

describe('DPR-crisp sizing', () => {
  it('sizes the backing store in device pixels', () => {
    expect(backingStoreSize(800, 120, 2)).toEqual({ width: 1600, height: 240 })
    expect(backingStoreSize(800.4, 120.6, 1)).toEqual({ width: 800, height: 121 })
    expect(backingStoreSize(0, 0, 2)).toEqual({ width: 1, height: 1 })
    expect(backingStoreSize(800, 120, 0)).toEqual({ width: 800, height: 120 })
  })

  it('only rewrites canvas dimensions when they actually change', () => {
    const canvas = document.createElement('canvas')
    expect(syncCanvasBackingStore(canvas, { cssWidth: 400, cssHeight: 100, dpr: 2 })).toBe(true)
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(200)
    expect(syncCanvasBackingStore(canvas, { cssWidth: 400, cssHeight: 100, dpr: 2 })).toBe(false)
    // Same CSS box, new monitor: the backing store must follow the DPR.
    expect(syncCanvasBackingStore(canvas, { cssWidth: 400, cssHeight: 100, dpr: 1 })).toBe(true)
    expect(canvas.width).toBe(400)
  })

  it('puts the context in CSS-pixel space idempotently', () => {
    const setTransform = vi.fn()
    scaleContextToDpr({ setTransform } as unknown as CanvasRenderingContext2D, 3)
    scaleContextToDpr({ setTransform } as unknown as CanvasRenderingContext2D, 3)
    expect(setTransform).toHaveBeenNthCalledWith(1, 3, 0, 0, 3, 0, 0)
    expect(setTransform).toHaveBeenNthCalledWith(2, 3, 0, 0, 3, 0, 0)
  })
})

describe('viewport store', () => {
  it('notifies subscribers on change and skips no-op writes', () => {
    const store = createViewportStore(vp())
    const seen = vi.fn()
    const unsubscribe = store.subscribe(seen)

    store.set(v => ({ ...v, scrollSeconds: 4 }))
    expect(store.get().scrollSeconds).toBe(4)
    expect(seen).toHaveBeenCalledTimes(1)

    store.set(v => ({ ...v })) // same numbers, new object
    expect(seen).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.set(v => ({ ...v, scrollSeconds: 9 }))
    expect(seen).toHaveBeenCalledTimes(1)
    expect(store.get().scrollSeconds).toBe(9)
  })

  it('keeps snapshot identity stable so useSyncExternalStore does not loop', () => {
    const store = createViewportStore(vp())
    expect(store.get()).toBe(store.get())
  })
})
