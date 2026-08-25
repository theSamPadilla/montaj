/**
 * Pure drag maths — and the one DOM measurement they depend on — for
 * caption-segment positioning in the preview. Everything here is React-free so
 * it can be unit-tested without mounting CaptionPreview.
 *
 * Why this is NOT `useDragOverlay` generalised
 * --------------------------------------------
 * The two gestures look alike but their coordinate models are different, and
 * the overlay hook is the highest-traffic drag path in the preview:
 *
 *  - `useDragOverlay` drives an element that is `inset-0` (frame-sized) and then
 *    scaled from its centre, so `scale` is a *box* scale. Its edge-snap geometry
 *    (`edgeX = (0.5 - s/2) * 100`) is derived from exactly that. A caption's
 *    `scale` is a font-size multiplier applied to a small, content-sized anchor
 *    box — the same formula would compute snap positions that mean nothing.
 *  - Overlays rotate; caption segments do not (no `rotation` on CaptionSegment).
 *  - Overlays commit through `onOverlayChange(id, changes)` into `project.tracks`;
 *    caption segments commit through `makeCaptionEdit` into `project.captions`.
 *
 * The only genuinely shared logic is "screen delta ÷ preview scale → percent of
 * frame", which is two divisions. Parameterising the overlay hook to switch off
 * rotation and edge snapping, and to swap its commit contract, would churn that
 * hook for no reuse worth having — so this duplicates the gesture maths
 * deliberately, as pure functions (no React), and keeps the overlay path
 * untouched.
 *
 * Coordinate convention
 * ---------------------
 * Offsets are **percent of frame** (`offsetX: 22` = 22% of frame width), the
 * same unit overlay and video items use, and the unit the caption render
 * templates consume via `captionOuterStyle`.
 *
 * Deltas **accumulate from the gesture start**: the segment's committed geometry
 * and the pointer position are both captured in `CaptionDragState` at mousedown,
 * and every subsequent move recomputes `initOffset + (pointer - initPointer)`.
 * Nothing is derived from an absolute cursor position, and no intermediate
 * result is fed back in — so a gesture is idempotent for a given pointer
 * position and cannot accumulate rounding drift over a long drag.
 */

import type { CaptionSegment } from '../../schema'

export type CaptionCorner = 'nw' | 'ne' | 'sw' | 'se'
export type CaptionDragType = 'move' | `resize-${CaptionCorner}`

/** Everything captured at mousedown. Immutable for the life of the gesture. */
export interface CaptionDragState {
  /** `CaptionSegment.id` of the segment being dragged. */
  id: string
  type: CaptionDragType
  /** Pointer position at gesture start, in client (screen) px. */
  initX: number
  initY: number
  /** The segment's committed geometry at gesture start. */
  initOffsetX: number
  initOffsetY: number
  initScale: number
}

/** A caption segment's positioning geometry, with schema defaults filled in. */
export interface CaptionGeometry {
  offsetX: number
  offsetY: number
  scale: number
  /** True while the move gesture is snapped to the frame's horizontal centre. */
  snapX?: boolean
  /** True while the move gesture is snapped to the frame's vertical middle. */
  snapY?: boolean
}

/**
 * Centre/middle snap radius, in percent of frame. Matches `SNAP_THRESHOLD` in
 * `useDragOverlay` so dragging a caption and dragging an overlay feel the same.
 */
export const CAPTION_SNAP_THRESHOLD = 2.5

/**
 * The preview's design-resolution mapping.
 *
 * `previewScale` is CaptionPreview's ResizeObserver value: on-screen frame width
 * ÷ `renderW`. Callers MUST pass the same `renderW` that produced `previewScale`
 * — the width terms then cancel exactly (`px / previewScale / renderW` ≡
 * `px / onScreenWidth`), which is what makes the conversion independent of
 * window size.
 */
export interface CaptionFrameMetrics {
  previewScale: number
  renderW: number
  renderH: number
}

// Bounds on the font-size multiplier. Below ~0.1 the caption is unreadable and
// its selection box becomes too small to grab back; above 5 it is larger than
// the frame in every template. Mirrors the overlay hook's `Math.max(0.1, …)`
// floor, with a ceiling added because a caption's scale grows text, not a box,
// so there is no self-limiting geometry.
export const CAPTION_MIN_SCALE = 0.1
export const CAPTION_MAX_SCALE = 5

/**
 * Click slop, in screen px. The same mousedown both selects a segment and arms
 * a move, so a click that wobbles a couple of pixels must not nudge the caption
 * (and must not push an undo step). Until the pointer travels this far the
 * gesture is treated as a click, and returning inside the radius cancels it
 * again — so a drag that comes back to where it started commits nothing.
 */
export const CAPTION_DRAG_SLOP_PX = 3

/** Has the pointer moved far enough from the mousedown to count as a drag? */
export function hasEscapedClickSlop(drag: CaptionDragState, clientX: number, clientY: number): boolean {
  return Math.hypot(clientX - drag.initX, clientY - drag.initY) > CAPTION_DRAG_SLOP_PX
}

/** Read a segment's geometry, applying the schema defaults (0 / 0 / 1). */
export function readCaptionGeometry(seg: Pick<CaptionSegment, 'offsetX' | 'offsetY' | 'scale'> | null | undefined): CaptionGeometry {
  return {
    offsetX: seg?.offsetX ?? 0,
    offsetY: seg?.offsetY ?? 0,
    scale:   seg?.scale   ?? 1,
  }
}

/**
 * Convert a screen-pixel delta to percent of frame.
 *
 *   screen px → design px:  px / previewScale
 *   design px → percent:    designPx / renderW * 100   (renderH for Y)
 *
 * Returns a zero delta for degenerate metrics (scale not measured yet, zero-size
 * canvas) rather than NaN/Infinity, so a drag that starts before the first
 * ResizeObserver callback is inert instead of catapulting the segment offscreen.
 */
export function screenDeltaToFramePercent(
  dxPx: number,
  dyPx: number,
  { previewScale, renderW, renderH }: CaptionFrameMetrics,
): { dx: number; dy: number } {
  if (!(previewScale > 0) || !(renderW > 0) || !(renderH > 0)) return { dx: 0, dy: 0 }
  return {
    dx: (dxPx / previewScale) / renderW * 100,
    dy: (dyPx / previewScale) / renderH * 100,
  }
}

/**
 * Geometry for the current pointer position, given the gesture captured at
 * mousedown. `move` translates; `resize-<corner>` scales and leaves the offsets
 * alone (the inner anchor box scales around its own centre, so a scaled caption
 * stays put — see captionInnerStyle in overlay-runtime/position.js).
 */
export function captionDragGeometry(
  drag: CaptionDragState,
  clientX: number,
  clientY: number,
  metrics: CaptionFrameMetrics,
): CaptionGeometry {
  const { dx, dy } = screenDeltaToFramePercent(clientX - drag.initX, clientY - drag.initY, metrics)

  if (drag.type === 'move') {
    // Centre/middle snap. Unlike the overlay hook's EDGE snap — whose
    // `(0.5 - s/2) * 100` geometry genuinely does not transfer to a caption's
    // content-sized anchor box (see the file header) — the centre snap is
    // geometry-independent: offsetX 0 is the frame's horizontal centre and
    // offsetY 0 its vertical middle, for a caption exactly as for an overlay.
    // Same threshold as useDragOverlay so both gestures feel identical.
    const rawX = drag.initOffsetX + dx
    const rawY = drag.initOffsetY + dy
    const snapX = Math.abs(rawX) < CAPTION_SNAP_THRESHOLD
    const snapY = Math.abs(rawY) < CAPTION_SNAP_THRESHOLD
    return {
      offsetX: snapX ? 0 : rawX,
      offsetY: snapY ? 0 : rawY,
      scale: drag.initScale,
      snapX,
      snapY,
    }
  }

  // Resize from a corner: project the pointer delta onto the corner's outward
  // diagonal so dragging away from the box grows it and toward it shrinks it.
  // Percent-of-frame ÷ 100 = fraction of frame, used as a proportional nudge on
  // the starting scale — same shape as the overlay hook's corner resize.
  const corner = drag.type.slice('resize-'.length) as CaptionCorner
  const sx = corner.includes('e') ? 1 : -1
  const sy = corner.includes('s') ? 1 : -1
  const delta = (dx * sx + dy * sy) / 100
  const scale = Math.min(CAPTION_MAX_SCALE, Math.max(CAPTION_MIN_SCALE, drag.initScale * (1 + delta)))
  return { offsetX: drag.initOffsetX, offsetY: drag.initOffsetY, scale }
}

/**
 * The patch to commit on mouseup — only the fields the gesture actually
 * changed, so a move never rewrites `scale` (and vice versa) and the resulting
 * undo step reads as what the operator did.
 */
export function captionDragPatch(
  drag: CaptionDragState,
  geom: CaptionGeometry,
): Pick<CaptionSegment, 'offsetX' | 'offsetY' | 'scale'> {
  return drag.type === 'move'
    ? { offsetX: geom.offsetX, offsetY: geom.offsetY }
    : { scale: geom.scale }
}

// ── Measuring where a caption actually paints ───────────────────────────────

/** A rectangle in client (screen) coordinates. */
export interface CaptionContentRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The element a measurement should be scoped to: the subtree a caption
 * template marked with `data-caption-id="<segmentId>"`, or `root` itself when
 * no id was asked for or no marker was found.
 *
 * Matched by walking `[data-caption-id]` and comparing the attribute rather
 * than building a `[data-caption-id="…"]` selector, so a segment id containing
 * a quote or backslash (project.json is hand-editable) can't throw a selector
 * SyntaxError. The subtree is a handful of nodes, so the walk is free.
 */
function scopeForSegment(root: HTMLElement, segmentId?: string): HTMLElement {
  if (!segmentId) return root
  for (const el of root.querySelectorAll<HTMLElement>('[data-caption-id]')) {
    if (el.getAttribute('data-caption-id') === segmentId) return el
  }
  return root
}

/**
 * Union of the client rects of every painted text run (and replaced element)
 * under `root` — or, when `segmentId` is given, under just that segment's
 * marked subtree.
 *
 * Deliberately NOT `root.getBoundingClientRect()`: the template's own outermost
 * element is a frame-sized `position: fixed; inset: 0` box (captionOuterStyle),
 * so its rect — and the rect of any wrapper we put around it — is the entire
 * preview, which would put the selection box around the whole frame. Walking to
 * the text nodes is the only markup-agnostic way to find where the caption
 * actually paints, and it costs nothing on a subtree this small.
 *
 * WHY `segmentId`: the templates draw EVERY caption active at an instant now
 * that captions have lanes, so an unscoped walk would union two unrelated
 * captions into one selection box spanning both. Naming the target segment
 * narrows the walk to that caption alone.
 *
 * FALLBACK, deliberately: a template with no `data-caption-id` anywhere — one
 * written before the attribute existed, or supplied by a host — measures the
 * whole root, i.e. exactly the pre-lane behaviour. A missing marker degrades to
 * the old selection box, never to no selection box.
 *
 * Returns null when nothing is painted (e.g. `pop` renders no word between two
 * word windows), which is the signal to hide the selection box entirely.
 */
export function measureCaptionContentRect(
  root: HTMLElement,
  segmentId?: string,
): CaptionContentRect | null {
  const scope = scopeForSegment(root, segmentId)
  const doc = scope.ownerDocument
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const range = doc.createRange()
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let rect: DOMRect | null = null
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.nodeValue?.trim()) continue
      range.selectNodeContents(node)
      rect = range.getBoundingClientRect()
    } else {
      // Replaced elements paint without text nodes. Everything else is a
      // container whose box is either the frame-sized outer wrapper or a
      // full-width anchor box — including them would defeat the point.
      const tag = (node as Element).tagName?.toUpperCase()
      if (tag !== 'IMG' && tag !== 'SVG' && tag !== 'VIDEO' && tag !== 'CANVAS') continue
      rect = (node as Element).getBoundingClientRect()
    }
    if (!rect || (!rect.width && !rect.height)) continue
    left   = Math.min(left,   rect.left)
    top    = Math.min(top,    rect.top)
    right  = Math.max(right,  rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }

  if (!Number.isFinite(left)) return null
  return { left, top, width: right - left, height: bottom - top }
}
