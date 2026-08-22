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
  /** Per-clip playback speed S (video only). A clip at S consumes S source
   *  seconds per timeline second, so every timeline↔source conversion here
   *  carries it. Absent/1 is a strict no-op. */
  speed?: number
}

/** The floor on an item's timeline duration. At speed S the source window
 *  floor follows from it (`MIN_DURATION · S`), so only this one is needed. */
export const MIN_DURATION = 0.1

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

/** A clip's speed, defended against a project carrying 0, a negative, or a
 *  non-finite value — every conversion below divides by it. */
function speedOf(item: Draggable): number {
  const s = item.speed ?? 1
  return Number.isFinite(s) && s > 0 ? s : 1
}

function clamp(v: number, lo: number, hi: number): number {
  // `hi` last, so a degenerate lo > hi keeps the min-duration constraint
  // rather than inverting the item.
  return Math.min(Math.max(v, lo), hi)
}

/**
 * Move one edge of a source-windowed item to time `t`.
 *
 * THE INVARIANT: the timeline span and the source window stay in lockstep —
 * `outPoint − inPoint === (end − start) · speed` — for every input, always.
 * That is what lets the frames, the waveform, the preview and the export all
 * agree about what a clip is showing.
 *
 * The way it is kept is the whole point of this function. The timeline edge is
 * clamped FIRST, against every limit there is (the item's minimum duration and
 * the media actually available past the window), and the source window is then
 * DERIVED from how far the edge really travelled. There is exactly one clamp,
 * on one value.
 *
 * The previous version clamped the two independently — `newStart` against
 * `end − 0.1`, `inPoint` against `[0, outPoint − 0.1]` — and whichever limit
 * bit first left the other free to keep going. Drag the in edge of a clip that
 * already starts at the head of its media and `start` slid left while
 * `inPoint` stayed pinned at 0; drag the out edge of a clip that already runs
 * to the end of its media and `end` grew while `outPoint` stayed at
 * `sourceDuration`. Either way the clip ended up claiming more timeline than
 * it had source for, silently. Downstream, the filmstrip walked off the end of
 * the media and froze on the last frame it could find while the waveform,
 * which windows to inPoint..outPoint, drew the real (shorter) window stretched
 * across the whole clip — two halves of one clip disagreeing, with no error
 * anywhere. Trimming past the media now simply stops at the media.
 */
export function resizeWindowedItem<T extends Draggable>(item: T, edge: 'start' | 'end', t: number): T {
  const s = speedOf(item)
  const inPoint = item.inPoint ?? 0
  const outPoint = item.outPoint ?? inPoint + (item.end - item.start) * s

  // BOTH window bounds come back written out, even the one this edge did not
  // move. They were implicit before (an end-trim wrote `outPoint` and left
  // `inPoint` undefined), and an implicit half of the window is what made this
  // class of bug invisible: you cannot check `outPoint − inPoint === span · S`
  // against a field that isn't there.
  if (edge === 'start') {
    // Leftward travel is limited by the source ahead of `inPoint`: that is
    // `inPoint` seconds of media, which is `inPoint / s` of timeline.
    const newStart = clamp(t, item.start - inPoint / s, item.end - MIN_DURATION)
    return { ...item, start: newStart, inPoint: inPoint + (newStart - item.start) * s, outPoint }
  }

  // Rightward travel is limited by the source after `outPoint`. With no
  // `sourceDuration` there is no known tail, so the edge stays unbounded —
  // the same benefit of the doubt the old code gave it.
  const tail = item.sourceDuration == null ? Infinity : item.sourceDuration - outPoint
  const newEnd = clamp(t, item.start + MIN_DURATION, item.end + tail / s)
  return { ...item, end: newEnd, inPoint, outPoint: outPoint + (newEnd - item.end) * s }
}

/**
 * Move one edge of an item to time `t`, keeping its source window consistent.
 *
 * `t` is expected to be already clamped to the timeline and already snapped —
 * this function only enforces the item's own invariants. Non-video items
 * (images, overlays) carry no source window and only move their timeline edge;
 * video clips go through `resizeWindowedItem`, which holds the span/window
 * invariant documented there.
 */
export function computeResizedItem(item: Draggable, edge: 'start' | 'end', t: number): Draggable {
  if (item.type !== 'video') {
    return edge === 'start'
      ? { ...item, start: Math.min(t, item.end - MIN_DURATION) }
      : { ...item, end: Math.max(t, item.start + MIN_DURATION) }
  }
  return resizeWindowedItem(item, edge, t)
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
