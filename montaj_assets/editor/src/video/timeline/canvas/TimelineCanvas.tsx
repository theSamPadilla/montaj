/**
 * TimelineCanvas (SP5 T4) — the canvas track-row area, mounted by Timeline in
 * place of the DOM visual rows + audio lanes when `timeline.canvas` is on. The
 * caption row stays DOM and mounts below it (SP5 decision 3).
 *
 * ── How this stays fast ──────────────────────────────────────────────────
 * Three rules, all of them about NOT re-rendering React:
 *
 * 1. Two stacked canvases. Content (rows, clips, audio) on the lower
 *    one, the playhead alone on the upper one. Playback moves the playhead ~60
 *    times a second; on a single canvas each move would have to repaint every
 *    clip, which is precisely the cost this surface exists to avoid.
 * 2. The playhead subscribes to the playback clock directly, the way
 *    `PlayheadLine` does in the DOM path — except the subscription drives an
 *    imperative redraw instead of a React render, so nothing above it (and in
 *    particular not the caption row's hundreds of DOM nodes) re-renders.
 * 3. Zoom/scroll live in an external store (viewport.ts), not React state, so
 *    a wheel-zoom gesture never re-renders Timeline. Only the zoom badge
 *    subscribes for display.
 *
 * All redraws funnel through `requestRedraw`, which coalesces to one rAF and
 * repaints only the layers marked dirty.
 *
 * ── Pointer interaction (SP5 T5) ─────────────────────────────────────────
 * Every gesture — seek, select, move, trim, roll/slip/slide — is
 * decided by `pointer-machine.ts`, which is pure. This file does only the three
 * things a pure reducer cannot: it turns mouse events into surface-space
 * points, it hands the machine a fresh view of the world on each event, and it
 * performs the effects the machine returns. Listeners follow the same pattern
 * the wheel handler established (a ref to the latest closure, bound once on
 * mount) so a drag never re-binds anything; the document-level move/up pair is
 * attached for the duration of a gesture only, exactly as the DOM rows' drag
 * hook does it.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { GetFilmstripArgs, GetWaveformPeaksArgs, FilmstripIndex, PeaksData, Project } from '../../../types'
import type { PlaybackClock } from '../../playback-clock'
import type { ResolveFilePath } from '../AudioWaveformLayer'
import { VISUAL_ROW_RENDER_HEIGHT_PX } from '../timeline-model'
import { computeTimelineLayout, drawTimelineContent, drawTimelineOverlay } from './draw'
import type { Point } from './hit-test'
import {
  createPointerMachine,
  type Modifiers,
  type PointerContext,
  type PointerEffect,
} from './pointer-machine'
import { WaveformPeaksStore, type WaveformSceneLookup } from './waveforms'
import { FilmstripStore, type FilmstripSceneLookup } from './filmstrips'
import {
  ZOOM_BUTTON_FACTOR,
  applyWheelIntent,
  fitViewport,
  formatZoomMultiple,
  observeSurface,
  reclampForDuration,
  scaleContextToDpr,
  syncCanvasBackingStore,
  useViewportValue,
  wheelIntent,
  withSurfaceWidth,
  xToTime,
  zoomAtPivot,
  zoomMultiple,
  type SurfaceMetrics,
  type ViewportStore,
} from './viewport'

export interface TimelineCanvasProps {
  project: Project
  clock: PlaybackClock
  /** Shared with Timeline's zoom chrome — see `useCanvasZoomControls`. */
  store: ViewportStore
  /** Content duration plus the timeline's drag headroom (timeline-model). */
  totalDuration: number
  /** Unified selection: visual items and audio tracks alike. */
  selectedIds: string[]
  /** Clip and audio boundaries the gestures snap to — Timeline's existing
   *  `computeDerivedTiming` memo, shared with the DOM rows. Absent means no
   *  magnetism, which is the right degradation rather than an error. */
  snapBoundaries?: number[]
  /** Trims close the gap they open, as they do on the DOM rows. */
  rippleMode?: boolean
  /** CapCut's "preview axis", off by default. On, a yellow cursor line tracks
   *  the pointer across this surface and `onHoverScrub` reports the time under
   *  it, so the host can show that frame in the preview while the playhead
   *  stays where it is. Off, this surface behaves exactly as it always has:
   *  no cursor line, and clicking seeks as usual. Pointer gestures are
   *  identical either way — the toggle adds a hover affordance, it does not
   *  change what a click does. */
  previewAxis?: boolean
  /** The time under the pointer while the axis is on, or null when the pointer
   *  leaves or a gesture starts. Fires per mousemove, so the host must route it
   *  to an external store rather than React state. */
  onHoverScrub?: (time: number | null) => void
  /** Timeline's `handleSelectItem` — additive rules and the item↔caption
   *  exclusivity stay owned there, so both surfaces select identically. */
  onSelectItem?: (id: string | null, additive: boolean) => void
  /** Live, uncommitted edit — fires once per pointer move during a gesture. */
  onProjectChange?: (p: Project) => void
  /** Gesture finished; persist. Same split the DOM rows use. */
  onOverlayEdit?: (p: Project) => void
  onInspectClip?: (id: string) => void
  onInspectAudio?: (id: string) => void
  /** T6 — the host adapter's peaks fetcher, threaded from
   *  `adapter.getWaveformPeaks` via Timeline. Absent → no waveforms anywhere
   *  (graceful; the surface just never asks). Canvas-mode only: the DOM path
   *  never receives or calls this. */
  getWaveformPeaks?: (args: GetWaveformPeaksArgs) => Promise<PeaksData>
  /** T7 — the host adapter's filmstrip fetcher, threaded from
   *  `adapter.getFilmstrip` via Timeline. Absent → no filmstrips or
   *  hover-scrub thumbs anywhere (graceful). Canvas-mode only. */
  getFilmstrip?: (args: GetFilmstripArgs) => Promise<FilmstripIndex>
  /** T7 — resolves a filmstrip sheet's host path into a displayable URL, the
   *  SAME mechanism `WaveformChunk.path` uses for the DOM waveform PNGs
   *  (`adapter.fileUrl`). Threaded from Timeline's own `resolveFilePath`. */
  resolveFilePath?: ResolveFilePath
}

const requestFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? cb => requestAnimationFrame(() => cb())
    : cb => setTimeout(cb, 16) as unknown as number

const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout

/** Stable empty default so an omitted `snapBoundaries` doesn't churn the
 *  pointer layer's latest-props ref with a fresh array every render. */
const NO_SNAP_BOUNDARIES: number[] = []

export default function TimelineCanvas({
  project,
  clock,
  store,
  totalDuration,
  selectedIds,
  snapBoundaries = NO_SNAP_BOUNDARIES,
  rippleMode = false,
  previewAxis = false,
  onHoverScrub,
  onSelectItem,
  onProjectChange,
  onOverlayEdit,
  onInspectClip,
  onInspectAudio,
  getWaveformPeaks,
  getFilmstrip,
  resolveFilePath,
}: TimelineCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const metricsRef = useRef<SurfaceMetrics>({ cssWidth: 0, cssHeight: 0, dpr: 1 })

  // T6 — one fetch-state store for the lifetime of this mounted surface, so
  // in-flight/resolved peaks survive across redraws (pan, zoom, selection).
  const waveformStoreRef = useRef<WaveformPeaksStore | null>(null)
  if (waveformStoreRef.current === null) waveformStoreRef.current = new WaveformPeaksStore()

  // T7 — same lifetime rule as the waveform store, for filmstrip indexes and
  // decoded sheet images.
  const filmstripStoreRef = useRef<FilmstripStore | null>(null)
  if (filmstripStoreRef.current === null) filmstripStoreRef.current = new FilmstripStore()


  const layout = useMemo(() => computeTimelineLayout(project), [project.tracks, project.audio])
  const surfaceHeight = Math.max(layout.height, VISUAL_ROW_RENDER_HEIGHT_PX)

  // Latest draw inputs, readable from the imperative paint without making the
  // paint a dependency of every effect (the ref-to-latest pattern
  // `useTimelineZoom` uses for its wheel handler).
  const sceneRef = useRef({ project, layout, selectedIds, totalDuration })
  sceneRef.current = { project, layout, selectedIds, totalDuration }

  // The preview-axis cursor, tracked imperatively for the same reason the
  // filmstrip hover thumb is: it moves with every mousemove, and a React state
  // write per mouse position would re-render the caption row's hundreds of DOM
  // nodes to move a 2px line. Read fresh at overlay-paint time.
  const cursorTimeRef = useRef<number | null>(null)

  // Hover-scrub emissions, coalesced to one per animation frame.
  //
  // The LINE is cheap — `requestRedraw` already folds it into one rAF. The
  // EMISSION is not: each one asks the preview to show a different frame,
  // which means seeking the source. A trackpad sweep delivers 60-120
  // mousemoves a second, and on long-GOP media each seek cancels the decode
  // still in flight, so the picture can end up never landing a frame at all
  // (worst on un-proxied 4K HEVC, where a seek decodes up to a second of
  // frames). One emission per frame is all a display can show anyway; the
  // intermediate positions are dropped rather than queued, so the seek target
  // is always the pointer's CURRENT position and never a stale backlog.
  const hoverEmitRef = useRef<{ frame: number | null; pending: number | null }>({ frame: null, pending: null })

  const dirtyRef = useRef({ content: false, overlay: false })
  const frameRef = useRef<number | null>(null)

  const paintRef = useRef<() => void>(() => {})
  paintRef.current = () => {
    const { cssWidth, cssHeight, dpr } = metricsRef.current
    if (cssWidth <= 0 || cssHeight <= 0) return
    const dirty = dirtyRef.current
    const viewport = store.get()
    const scene = sceneRef.current

    if (dirty.content) {
      dirty.content = false
      const ctx = contentCanvasRef.current?.getContext('2d')
      if (ctx) {
        scaleContextToDpr(ctx, dpr)
        // T6 — one query context per paint (px/second and the project id can
        // both have moved since the last one); the store itself is what
        // persists across paints. `onReady` re-marks content dirty and
        // schedules a redraw once new data lands, the same way a project
        // edit does.
        const waveforms: WaveformSceneLookup | undefined = getWaveformPeaks
          ? {
              clipColumns: (item, rect) => waveformStoreRef.current!.clipColumns(item, rect, {
                projectId: scene.project.id,
                getWaveformPeaks,
                pxPerSecond: viewport.pxPerSecond,
                onReady: () => requestRedraw('content'),
              }),
              audioColumns: (track, rect) => waveformStoreRef.current!.audioColumns(track, rect, {
                projectId: scene.project.id,
                getWaveformPeaks,
                pxPerSecond: viewport.pxPerSecond,
                onReady: () => requestRedraw('content'),
              }),
            }
          : undefined
        // T7 — filmstrip data is shared with the overlay layer's hover thumb
        // (see filmstrips.ts's `FilmstripQueryContext.onReady` doc), so
        // whichever call resolves a fetch invalidates BOTH layers.
        const filmstrips: FilmstripSceneLookup | undefined = (getFilmstrip && resolveFilePath)
          ? {
              clipTiles: (item, rect) => filmstripStoreRef.current!.clipTiles(item, rect, {
                projectId: scene.project.id,
                getFilmstrip,
                fileUrl: resolveFilePath,
                viewport,
                onReady: () => requestRedraw('all'),
              }),
            }
          : undefined
        drawTimelineContent(ctx, {
          project: scene.project,
          viewport,
          layout: scene.layout,
          selectedIds: scene.selectedIds,
          surfaceWidth: cssWidth,
          surfaceHeight: cssHeight,
          waveforms,
          filmstrips,
        })
      }
    }

    if (dirty.overlay) {
      dirty.overlay = false
      const ctx = overlayCanvasRef.current?.getContext('2d')
      if (ctx) {
        scaleContextToDpr(ctx, dpr)
        drawTimelineOverlay(ctx, {
          viewport,
          currentTime: clock.get(),
          cursorTime: cursorTimeRef.current,
          surfaceWidth: cssWidth,
          surfaceHeight: cssHeight,
        })
      }
    }
  }

  const requestRedraw = useCallback((layer: 'content' | 'overlay' | 'all') => {
    const dirty = dirtyRef.current
    if (layer !== 'overlay') dirty.content = true
    if (layer !== 'content') dirty.overlay = true
    if (frameRef.current !== null) return
    frameRef.current = requestFrame(() => {
      frameRef.current = null
      paintRef.current()
    })
  }, [])

  // The latch must be reset here too, or a StrictMode remount (cleanup runs
  // on the same instance before the effect re-fires) deadlocks every future
  // `requestRedraw` behind a stale non-null handle.
  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current)
      frameRef.current = null
    }
    const emit = hoverEmitRef.current
    if (emit.frame !== null) cancelFrame(emit.frame)
    emit.frame = null
    emit.pending = null
  }, [])

  // ── Surface: CSS size, DPR, backing stores ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    return observeSurface(el, metrics => {
      metricsRef.current = metrics
      const content = contentCanvasRef.current
      const overlay = overlayCanvasRef.current
      if (content) syncCanvasBackingStore(content, metrics)
      if (overlay) syncCanvasBackingStore(overlay, metrics)
      store.set(vp => withSurfaceWidth(vp, metrics.cssWidth, sceneRef.current.totalDuration))
      // Unconditional: writing `canvas.width` clears the canvas, and a DPR
      // change invalidates the transform even when the CSS size is identical.
      requestRedraw('all')
    })
  }, [store, requestRedraw])

  // ── Turning the axis off with the pointer still over the surface takes the
  //    line and the host's override down with it: no further mousemove is
  //    coming to do it, and the preview would stay frozen on a hovered frame. ──
  useEffect(() => {
    if (previewAxis) return
    const emit = hoverEmitRef.current
    if (emit.frame !== null) cancelFrame(emit.frame)
    emit.frame = null
    emit.pending = null
    if (cursorTimeRef.current === null) return
    cursorTimeRef.current = null
    onHoverScrub?.(null)
    requestRedraw('overlay')
  }, [previewAxis, onHoverScrub, requestRedraw])

  // ── Viewport: pan/zoom moves everything, including the playhead ──
  useEffect(() => store.subscribe(() => requestRedraw('all')), [store, requestRedraw])

  // ── Playhead: the only per-tick subscriber, and it repaints one layer ──
  useEffect(() => clock.subscribe(() => requestRedraw('overlay')), [clock, requestRedraw])

  // ── Content: project/selection edits ──
  const selectionKey = selectedIds.join('\0')
  useEffect(() => { requestRedraw('content') }, [project, layout, selectionKey, requestRedraw])

  // ── Duration changes re-clamp scale and scroll ──
  useEffect(() => {
    store.set(vp => reclampForDuration(vp, totalDuration))
    requestRedraw('all')
  }, [totalDuration, store, requestRedraw])

  // ── Wheel: ⌘/Ctrl zoom at cursor, Alt (or horizontal) pan, plain wheel
  //    left alone so the page keeps scrolling. preventDefault only fires for
  //    intents we consume, which is why the listener must be non-passive —
  //    React's onWheel is registered passive at the root (same reason
  //    useTimelineZoom binds natively). ──
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {})
  wheelRef.current = (e: WheelEvent) => {
    const el = containerRef.current
    if (!el) return
    const intent = wheelIntent(e, e.clientX - el.getBoundingClientRect().left)
    if (intent.kind === 'none') return
    e.preventDefault()
    // The DOM path's wheel listener is still bound to the scroll container we
    // sit inside (Timeline keeps its chrome in both modes). Without this it
    // would zoom its own multiplier off the same gesture and widen the page
    // under the canvas.
    e.stopPropagation()
    store.set(vp => applyWheelIntent(vp, intent, sceneRef.current.totalDuration))
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => wheelRef.current(e)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Pointer: the gesture machine's DOM shell ──

  const machineRef = useRef<ReturnType<typeof createPointerMachine> | null>(null)
  if (machineRef.current === null) machineRef.current = createPointerMachine()
  const machine = machineRef.current

  // Everything the machine's context and effects need, refreshed each render so
  // handlers bound once on mount never read a stale project or callback.
  const pointerRef = useRef({
    project, layout, selectedIds, snapBoundaries, totalDuration, rippleMode, previewAxis,
    onSelectItem, onProjectChange, onOverlayEdit, onInspectClip, onInspectAudio, onHoverScrub,
  })
  pointerRef.current = {
    project, layout, selectedIds, snapBoundaries, totalDuration, rippleMode, previewAxis,
    onSelectItem, onProjectChange, onOverlayEdit, onInspectClip, onInspectAudio, onHoverScrub,
  }

  const buildContext = useCallback((): PointerContext => {
    const p = pointerRef.current
    return {
      project: p.project,
      layout: p.layout,
      viewport: store.get(),
      selectedIds: p.selectedIds,
      snapBoundaries: p.snapBoundaries,
      totalDuration: p.totalDuration,
      rippleMode: p.rippleMode,
      playheadTime: clock.get(),
    }
  }, [store, clock])

  const runEffects = useCallback((effects: PointerEffect[]) => {
    const p = pointerRef.current
    let edited = false
    for (const effect of effects) {
      switch (effect.type) {
        case 'seek':          clock.set(effect.time); break
        case 'select':        p.onSelectItem?.(effect.id, effect.additive); break
        case 'projectChange': p.onProjectChange?.(effect.project); edited = true; break
        case 'commit':        p.onOverlayEdit?.(effect.project); break
        case 'inspect':       (effect.target === 'visual' ? p.onInspectClip : p.onInspectAudio)?.(effect.id); break
        // Cursor is written straight to the node: an affordance that changes on
        // every hover must not cost a React render.
        case 'cursor':        if (containerRef.current) containerRef.current.style.cursor = effect.cursor; break
      }
    }
    // The edit reaches the surface as a new `project` prop, which schedules a
    // redraw on its own — but only once the host echoes it back. Marking the
    // content dirty here keeps a drag responsive under a host that defers.
    if (edited) requestRedraw('content')
  }, [clock, requestRedraw])

  // Document-level move/up, live only for the duration of a gesture (the DOM
  // drag hook's pattern) so ordinary mouse movement over the page costs nothing.
  const releaseGestureRef = useRef<(() => void) | null>(null)

  // The surface rect, frozen for the duration of a gesture — see
  // `surfacePoint`'s comment for why. Null while idle.
  const gestureRectRef = useRef<DOMRect | null>(null)

  const handlersRef = useRef({
    down: (_e: MouseEvent) => {},
    hover: (_e: MouseEvent) => {},
    move: (_e: MouseEvent) => {},
    up: (_e: MouseEvent) => {},
    doubleClick: (_e: MouseEvent) => {},
    leave: (_e: MouseEvent) => {},
  })

  function surfacePoint(e: MouseEvent): Point | null {
    const el = containerRef.current
    if (!el) return null
    // A gesture's own live edit can resize the surface and shift its rect mid-
    // drag (a cross-track move adds/removes a row under the moving cursor); the
    // press-time rect is that gesture's fixed frame of reference, matching the
    // DOM drag hooks' raw-delta math. Idle reads (hover, no gesture) stay live.
    const rect = gestureRectRef.current ?? el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function modifiersOf(e: MouseEvent): Modifiers {
    return { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey }
  }

  // ── Preview axis: the cursor line, and the frame it asks the host to show ──
  //
  // Both halves are driven from the same place so the line and the previewed
  // frame can never disagree. Time is taken raw from the x position — no
  // snapping, because a hover affordance that jumped to clip boundaries would
  // preview a frame other than the one the line is drawn at.

  function updateAxisCursor(point: Point) {
    const p = pointerRef.current
    if (!p.previewAxis) return
    const t = Math.max(0, Math.min(p.totalDuration, xToTime(point.x, store.get())))
    if (cursorTimeRef.current === t) return
    cursorTimeRef.current = t
    requestRedraw('overlay')
    // The line tracks the pointer exactly; the frame request is rate-limited.
    const emit = hoverEmitRef.current
    emit.pending = t
    if (emit.frame !== null) return
    emit.frame = requestFrame(() => {
      emit.frame = null
      const next = emit.pending
      emit.pending = null
      if (next !== null) pointerRef.current.onHoverScrub?.(next)
    })
  }

  /** Drop any frame request that hasn't fired yet, so a release can't be
   *  overtaken by a stale position arriving one frame later. */
  function cancelPendingHoverEmit() {
    const emit = hoverEmitRef.current
    if (emit.frame !== null) cancelFrame(emit.frame)
    emit.frame = null
    emit.pending = null
  }

  // Guarded on the ref, so the paths that call this speculatively (every
  // pointer-leave, every press, mount with the axis already off) stay silent
  // when there was no cursor up to take down.
  function clearAxisCursor() {
    cancelPendingHoverEmit()
    if (cursorTimeRef.current === null) return
    cursorTimeRef.current = null
    // Released synchronously, never deferred: the preview must be handed back
    // to the playhead the instant the pointer leaves or a gesture starts.
    pointerRef.current.onHoverScrub?.(null)
    requestRedraw('overlay')
  }

  handlersRef.current = {
    down(e) {
      if (e.button !== 0) return
      // A stale gesture whose mouseup never fired (focus loss, etc.) must not
      // leave its frozen rect and listeners behind for this new one.
      releaseGestureRef.current?.()
      gestureRectRef.current = containerRef.current?.getBoundingClientRect() ?? null
      const point = surfacePoint(e)
      if (!point) return
      // A gesture is starting — no axis cursor during a drag/trim. The gesture
      // itself owns the playhead from here, and a click seeks, so leaving the
      // cursor up would draw a second line the drag never moves.
      clearAxisCursor()
      // Suppress the native text-selection drag; the surface is `select-none`
      // but a press-and-drag still starts one in some browsers. That
      // preventDefault also suppresses the focus a plain click would give this
      // container, which Timeline's own Delete/Enter bindings depend on
      // (they only fire with focus inside Timeline's root — see Timeline.tsx)
      // — so focus it explicitly.
      containerRef.current?.focus({ preventScroll: true })
      e.preventDefault()
      runEffects(machine.dispatch({ type: 'pointerDown', point, modifiers: modifiersOf(e), ctx: buildContext() }))

      const onMove = (ev: MouseEvent) => handlersRef.current.move(ev)
      const onUp = (ev: MouseEvent) => handlersRef.current.up(ev)
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      releaseGestureRef.current = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        gestureRectRef.current = null
        releaseGestureRef.current = null
      }
    },
    // Hover only updates the cursor, and only while no gesture is running — the
    // document listener owns movement once a press is down, so without this
    // guard every mid-drag move would be dispatched twice.
    hover(e) {
      if (machine.state.kind !== 'idle') return
      const point = surfacePoint(e)
      if (!point) return
      runEffects(machine.dispatch({ type: 'pointerMove', point, modifiers: modifiersOf(e), ctx: buildContext() }))
      updateAxisCursor(point)
    },
    move(e) {
      const point = surfacePoint(e)
      if (!point) return
      runEffects(machine.dispatch({ type: 'pointerMove', point, modifiers: modifiersOf(e), ctx: buildContext() }))
    },
    up(e) {
      // Point first, then release — the point must still see this gesture's
      // frozen rect, not the live one the teardown below reverts to.
      const point = surfacePoint(e)
      releaseGestureRef.current?.()
      if (!point) { runEffects(machine.dispatch({ type: 'cancel' })); return }
      runEffects(machine.dispatch({ type: 'pointerUp', point, modifiers: modifiersOf(e), ctx: buildContext() }))
    },
    doubleClick(e) {
      const point = surfacePoint(e)
      if (!point) return
      e.preventDefault()
      runEffects(machine.dispatch({ type: 'doubleClick', point, modifiers: modifiersOf(e), ctx: buildContext() }))
    },
    // The pointer left the surface entirely; no more `mousemove` events will
    // arrive to naturally age the cursor out, so drop it explicitly.
    leave() {
      clearAxisCursor()
    },
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onDown = (e: MouseEvent) => handlersRef.current.down(e)
    const onHover = (e: MouseEvent) => handlersRef.current.hover(e)
    const onDoubleClick = (e: MouseEvent) => handlersRef.current.doubleClick(e)
    const onLeave = (e: MouseEvent) => handlersRef.current.leave(e)
    el.addEventListener('mousedown', onDown)
    el.addEventListener('mousemove', onHover)
    el.addEventListener('dblclick', onDoubleClick)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('mousemove', onHover)
      el.removeEventListener('dblclick', onDoubleClick)
      el.removeEventListener('mouseleave', onLeave)
      releaseGestureRef.current?.()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      data-timeline-canvas
      // Focusable (not tab-stoppable) so a pointer-down can focus it
      // programmatically — see the `down` handler above — satisfying
      // Timeline's root-focus guard for Delete/Enter without adding this
      // surface to the tab order.
      tabIndex={-1}
      className="relative w-full select-none"
      style={{ height: surfaceHeight, cursor: 'pointer' }}
      // Timeline's container click seeks by percentage of `totalDuration`,
      // which is only the canvas' own time axis at fit zoom. The pointer
      // machine has already seeked (on mousedown) by the time this fires, so
      // swallow it rather than let it re-seek to the wrong second.
      onClick={e => e.stopPropagation()}
    >
      <canvas ref={contentCanvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={overlayCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  )
}

// ── Zoom chrome adapter ──────────────────────────────────────────────────
// Timeline's zoom controls are shared chrome: the same three buttons drive the
// DOM path's zoom multiplier or the canvas' viewport depending on the flag.
// The canvas hands Timeline this adapter so the chrome itself doesn't branch
// beyond picking which one to call.

export interface ZoomControls {
  badge: ReactNode
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  showFit: boolean
}

export function useCanvasZoomControls(store: ViewportStore, totalDuration: number): ZoomControls {
  return useMemo(() => ({
    badge: <CanvasZoomBadge store={store} totalDuration={totalDuration} />,
    // Buttons zoom around the middle of the view, which is where the eye is
    // when there's no cursor to pivot on (the DOM path's `zoomTo` with no
    // pivot does the same).
    zoomIn:  () => store.set(vp => zoomAtPivot(vp, ZOOM_BUTTON_FACTOR, vp.widthPx / 2, totalDuration)),
    zoomOut: () => store.set(vp => zoomAtPivot(vp, 1 / ZOOM_BUTTON_FACTOR, vp.widthPx / 2, totalDuration)),
    fit:     () => store.set(vp => fitViewport(vp, totalDuration)),
    // Always offered: unlike the DOM model, canvas zoom can sit below 1×, so
    // "am I off fit?" is not simply "is zoom > 1". Keeping it unconditional
    // also keeps the badge the only part of the chrome that re-renders on zoom.
    showFit: true,
  }), [store, totalDuration])
}

/** The zoom readout, isolated so wheel-zoom re-renders this span and nothing
 *  else. Reports a fit-relative multiple for continuity with the DOM badge,
 *  where 1× also meant "the whole project fits". */
export function CanvasZoomBadge({ store, totalDuration }: { store: ViewportStore; totalDuration: number }) {
  const viewport = useViewportValue(store)
  return (
    <span className="text-[10px] font-mono text-gray-500 w-7 text-center tabular-nums select-none">
      {formatZoomMultiple(zoomMultiple(viewport, totalDuration))}×
    </span>
  )
}
