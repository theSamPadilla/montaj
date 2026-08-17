import type React from 'react'

export interface Draggable {
  id: string
  start: number
  end: number
  inPoint?: number
  outPoint?: number
  normalizedInPoint?: number
  type?: string
  sourceDuration?: number
}

export interface DragEventContext {
  /** The item with updated start/end (and inPoint/outPoint for resize) */
  item: Draggable
  /** Horizontal delta in timeline seconds from initial position */
  dx: number
  /** Vertical delta in raw pixels from initial position */
  dy: number
}

export interface UseItemDragDropConfig {
  totalDuration: number
  snapBoundaries: number[]
  snapThresholdPx?: number // default 8
  /** Element used for getBoundingClientRect() → pixel-to-time conversion */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Timeline zoom factor — content width is zoom × scrollRef.width. Required so
   *  pixel-to-time conversion matches the visible scale (without this, drag/resize
   *  is `zoom`× too sensitive when zoomed in). */
  zoomRef?: React.RefObject<number>
  draggedFlagRef?: React.MutableRefObject<boolean> // sets true during drag (click suppression)
}

/** A press must travel at least this many pixels before it becomes a drag.
 *  Below it the gesture stays a click. Without this threshold, a single pixel of
 *  pointer drift during a click flips the drag flag, and the timeline suppresses
 *  click-to-select — so clips/overlays can't be selected (or deleted), which
 *  bites constantly on trackpads and touchscreens where clicks always jitter.
 *
 *  Exported for the canvas pointer machine (SP5 T5), which has the same
 *  click-vs-drag decision to make and must make it at the same distance. */
export const DRAG_THRESHOLD_PX = 4

// ── Pure drag/resize math ────────────────────────────────────────────────
// Extracted from the hook body so the canvas timeline's pointer machine
// (SP5 T5) reuses the exact trim arithmetic rather than reimplementing it, and
// so the arithmetic is testable without a component. The hook below is now a
// DOM shell over these three functions and behaves exactly as it did: it still
// converts pixels through the zoom-container width, still snaps flat, and still
// drives the legacy rows. The canvas calls the same functions with times it
// derived from its own viewport and snapped with hysteresis (canvas/snap.ts).

/** Nearest boundary within `threshold` seconds of `raw`, else `raw` itself.
 *  Ties keep the earlier entry — `<` is strict, as in the original loop. */
export function snapToBoundaries(raw: number, boundaries: readonly number[], threshold: number): number {
  let t = raw
  let bestDist = threshold
  for (const b of boundaries) {
    const d = Math.abs(raw - b)
    if (d < bestDist) {
      bestDist = d
      t = b
    }
  }
  return t
}

/** Snap a moving span of length `duration` by either of its edges, nearest
 *  first. The end edge is tested before the start edge and both share one
 *  running best distance, so an exact tie is resolved in favour of the START
 *  edge — preserved verbatim from the hook's original loop. Returns the raw
 *  span unchanged when nothing is in range; the caller re-clamps. */
export function snapMovedSpan(
  rawStart: number,
  duration: number,
  boundaries: readonly number[],
  threshold: number,
): { start: number; end: number } {
  const rawEnd = rawStart + duration
  let start = rawStart
  let end = rawEnd
  let bestDist = threshold
  for (const b of boundaries) {
    const dEnd = Math.abs(rawEnd - b)
    if (dEnd < bestDist) {
      bestDist = dEnd
      start = b - duration
      end = b
    }
    const dStart = Math.abs(rawStart - b)
    if (dStart < bestDist) {
      bestDist = dStart
      start = b
      end = b + duration
    }
  }
  return { start, end }
}

/**
 * Move one edge of an item to time `t`, keeping its source window consistent.
 *
 * `t` is expected to be already clamped to the timeline and already snapped —
 * this function only enforces the item's own invariants: a minimum 0.1s
 * duration, and for video clips an in/outPoint that travels with the edge and
 * stays inside the source media. Non-video items (images, overlays) carry no
 * source window and only move their timeline edge.
 */
export function computeResizedItem(item: Draggable, edge: 'start' | 'end', t: number): Draggable {
  if (edge === 'start') {
    const newStart = Math.min(t, item.end - 0.1)
    if (item.type !== 'video') return { ...item, start: newStart }
    const dtActual = newStart - item.start
    return {
      ...item,
      start: newStart,
      inPoint: Math.min(
        Math.max(0, (item.inPoint ?? 0) + dtActual),
        (item.outPoint ?? (item.inPoint ?? 0) + (item.end - item.start)) - 0.1,
      ),
    }
  }
  const newEnd = Math.max(t, item.start + 0.1)
  if (item.type !== 'video') return { ...item, end: newEnd }
  const origOut = item.outPoint ?? (item.inPoint ?? 0) + (item.end - item.start)
  const dtActual = newEnd - item.end
  return {
    ...item,
    end: newEnd,
    outPoint: Math.max(
      (item.inPoint ?? 0) + 0.1,
      Math.min(origOut + dtActual, item.sourceDuration ?? Infinity),
    ),
  }
}

export function useItemDragDrop(config: UseItemDragDropConfig) {
  const {
    totalDuration,
    snapBoundaries,
    snapThresholdPx = 8,
    scrollRef,
    zoomRef,
    draggedFlagRef,
  } = config

  function beginResize(
    e: React.MouseEvent,
    item: Draggable,
    edge: 'start' | 'end',
    callbacks: {
      onLivePreview: (ctx: DragEventContext) => void
      onCommit: () => void
    },
  ): void {
    e.stopPropagation()
    e.preventDefault()

    const initX = e.clientX
    const initTime = edge === 'start' ? item.start : item.end

    function computeResized(moveE: MouseEvent): Draggable {
      if (!scrollRef.current) return item
      const rect = scrollRef.current.getBoundingClientRect()
      const contentWidth = rect.width * (zoomRef?.current ?? 1)
      const dt = ((moveE.clientX - initX) / contentWidth) * totalDuration
      const raw = Math.max(0, Math.min(totalDuration, initTime + dt))
      const snapThreshold = (snapThresholdPx / contentWidth) * totalDuration
      return computeResizedItem(item, edge, snapToBoundaries(raw, snapBoundaries, snapThreshold))
    }

    function onMove(moveE: MouseEvent) {
      const resized = computeResized(moveE)
      callbacks.onLivePreview({ item: resized, dx: 0, dy: 0 })
    }
    function onUp() {
      callbacks.onCommit()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function beginDrag(
    e: React.MouseEvent,
    item: Draggable,
    callbacks: {
      onLivePreview: (ctx: DragEventContext) => void
      onCommit: () => void
    },
  ): void {
    e.stopPropagation()

    const initX = e.clientX
    const initY = e.clientY
    const initStart = item.start
    const initEnd = item.end
    const duration = initEnd - initStart
    let dragStarted = false

    function onMove(moveE: MouseEvent) {
      // Ignore sub-threshold pointer drift — it's a click, not a drag. Only once
      // the press travels past DRAG_THRESHOLD_PX do we set the drag flag (which
      // suppresses click-to-select) and start moving the item.
      if (!dragStarted) {
        const moved = Math.hypot(moveE.clientX - initX, moveE.clientY - initY)
        if (moved < DRAG_THRESHOLD_PX) return
        dragStarted = true
      }
      if (draggedFlagRef) draggedFlagRef.current = true

      const rect = scrollRef.current?.getBoundingClientRect()
      const contentWidth = rect ? rect.width * (zoomRef?.current ?? 1) : 0
      const dx = contentWidth ? ((moveE.clientX - initX) / contentWidth) * totalDuration : 0
      const dy = moveE.clientY - initY

      const rawStart = Math.max(0, Math.min(totalDuration - duration, initStart + dx))

      // Snap leading/trailing edge to nearest item edge within threshold
      const snapThreshold = contentWidth ? (snapThresholdPx / contentWidth) * totalDuration : 0
      const snapped = snapMovedSpan(rawStart, duration, snapBoundaries, snapThreshold)
      const newStart = Math.max(0, Math.min(totalDuration - duration, snapped.start))
      const newEnd = newStart + duration

      const movedItem = { ...item, start: newStart, end: newEnd }
      callbacks.onLivePreview({ item: movedItem, dx, dy })
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (draggedFlagRef && draggedFlagRef.current) {
        callbacks.onCommit()
        // reset after click event fires
        setTimeout(() => {
          draggedFlagRef!.current = false
        }, 0)
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return { beginDrag, beginResize }
}
