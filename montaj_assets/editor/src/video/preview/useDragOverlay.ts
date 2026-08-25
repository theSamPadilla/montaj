import { useEffect, useRef, useState } from 'react'
import type { VisualItem } from '../../schema'

export type Corner = 'nw' | 'ne' | 'sw' | 'se'
/**
 * Single-axis resize handles. A corner drag scales BOTH axes together (the
 * legacy uniform gesture); an edge drag scales exactly one — `e`/`w` the X
 * axis, `n`/`s` the Y axis. The handles themselves are drawn by a later slice;
 * the hook understands the gesture already so the two can land independently.
 */
export type Edge = 'n' | 's' | 'e' | 'w'
export type DragType = 'move' | `resize-${Corner}` | `resize-${Edge}` | 'rotate'

// Shared shape for `onOverlayChange` across the preview layer: drag/resize/rotate
// gestures (useDragOverlay) only ever populate the geometric subset; content-editing
// callers (crop modal, future props/text editors) populate the rest. Callers pass a
// partial — VideoEditor.handleOverlayChange merges whatever arrives into the item.
export interface OverlayChanges {
  offsetX?: number
  offsetY?: number
  /** The legacy UNIFORM scale. Still written by every corner drag. */
  scale?: number
  /** Per-axis width multiplier. Absent ⇒ the item keeps falling back to `scale`. */
  scaleX?: number
  /** Per-axis height multiplier. Absent ⇒ the item keeps falling back to `scale`. */
  scaleY?: number
  rotation?: number
  fit?: 'cover' | 'contain' | 'fill'
  sourceCrop?: VisualItem['sourceCrop']
  sourceWidth?: number
  sourceHeight?: number
  /** Full replacement for item.props (content editing). */
  props?: Record<string, unknown>
  /** Legacy text overlay items only. */
  text?: string
}

const SNAP_THRESHOLD = 2.5  // % of container
const ROT_SNAP_ANGLES = [0, 90, 180, 270]
const ROT_ATTRACT_DEG = 5   // snap in within ±5°
const ROT_RELEASE_DEG = 8   // break free after ±8°

interface DragState {
  id: string
  type: DragType
  initX: number
  initY: number
  initOffsetX: number
  initOffsetY: number
  /** The RESOLVED uniform scale at gesture start. */
  initScale: number
  /**
   * The RESOLVED per-axis scales at gesture start. Both equal `initScale` on a
   * uniform item, so omitting them (they default to `initScale`) is always the
   * legacy behavior.
   */
  initScaleX?: number
  initScaleY?: number
  /**
   * Whether the ITEM ITSELF carries `scaleX`/`scaleY`, as opposed to inheriting
   * both from the legacy uniform `scale`. Decides the commit shape — see `onUp`.
   */
  initHasPerAxis?: boolean
  initRotation: number
  // rotate-specific: center of element in page coords and initial angle
  cx?: number
  cy?: number
  initAngle?: number
}

export function useDragOverlay(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onOverlayChange?: (id: string, changes: OverlayChanges) => void,
) {
  const [dragState, setDragState] = useState<DragState | null>(null)

  const [liveOffset,   setLiveOffset]   = useState<{ id: string; x: number; y: number } | null>(null)
  // `scale` is the uniform value (only a CORNER drag moves it); `scaleX`/`scaleY`
  // are what the preview actually renders, so an edge drag can move one axis
  // without the other. On a uniform item all three stay equal.
  const [liveScale,    setLiveScale]    = useState<{ id: string; scale: number; scaleX: number; scaleY: number } | null>(null)
  const [liveRotation, setLiveRotation] = useState<{ id: string; rotation: number } | null>(null)
  const liveOffsetRef   = useRef<typeof liveOffset>(null)
  const liveScaleRef    = useRef<typeof liveScale>(null)
  const liveRotationRef = useRef<typeof liveRotation>(null)

  // Snap guide visibility
  const [snapGuides, setSnapGuides]     = useState({ x: false, y: false, left: false, right: false, top: false, bottom: false })
  const [snapRotation, setSnapRotation] = useState<number | null>(null)
  const prevSnapRef    = useRef({ x: false, y: false, left: false, right: false, top: false, bottom: false })
  const prevSnapRotRef = useRef<number | null>(null)

  useEffect(() => { liveOffsetRef.current   = liveOffset   }, [liveOffset])
  useEffect(() => { liveScaleRef.current    = liveScale    }, [liveScale])
  useEffect(() => { liveRotationRef.current = liveRotation }, [liveRotation])

  useEffect(() => {
    if (!dragState) return

    function onMove(e: MouseEvent) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || !dragState) return

      const dx = ((e.clientX - dragState.initX) / rect.width)  * 100  // %
      const dy = ((e.clientY - dragState.initY) / rect.height) * 100  // %

      if (dragState.type === 'move') {
        const rawX = dragState.initOffsetX + dx
        const rawY = dragState.initOffsetY + dy

        // Edge snap positions depend on scale, PER AXIS.
        // Element is inset-0 (fills container) then scaled from center, so its half-width is
        // sx/2 of the frame and its half-height sy/2.
        // Left edge hits screen left / right edge hits screen right when offsetX = ±(0.5 - sx/2)*100;
        // top/bottom likewise at ±(0.5 - sy/2)*100.
        // For a scale of 1 that is 0 (same as center snap), so edge snap only activates for an axis
        // that is scaled DOWN — and with a non-uniform item the axes decide independently, e.g. a
        // full-width-but-squat item gets top/bottom edge snap and no left/right snap at all.
        const sx = dragState.initScaleX ?? dragState.initScale
        const sy = dragState.initScaleY ?? dragState.initScale
        const edgeX = (0.5 - sx / 2) * 100   // offset where the element's left/right edge meets the frame's
        const edgeY = (0.5 - sy / 2) * 100   // offset where the element's top/bottom edge meets the frame's
        const hasEdgeX = edgeX > SNAP_THRESHOLD  // skip if too close to center snap
        const hasEdgeY = edgeY > SNAP_THRESHOLD

        const snapX      = Math.abs(rawX) < SNAP_THRESHOLD
        const snapY      = Math.abs(rawY) < SNAP_THRESHOLD
        const snapLeft   = hasEdgeX && !snapX && Math.abs(rawX - (-edgeX)) < SNAP_THRESHOLD
        const snapRight  = hasEdgeX && !snapX && Math.abs(rawX -   edgeX)  < SNAP_THRESHOLD
        const snapTop    = hasEdgeY && !snapY && Math.abs(rawY - (-edgeY)) < SNAP_THRESHOLD
        const snapBottom = hasEdgeY && !snapY && Math.abs(rawY -   edgeY)  < SNAP_THRESHOLD

        // Haptic on snap entry
        if (snapX      && !prevSnapRef.current.x)      navigator.vibrate?.(10)
        if (snapY      && !prevSnapRef.current.y)      navigator.vibrate?.(10)
        if (snapLeft   && !prevSnapRef.current.left)   navigator.vibrate?.(10)
        if (snapRight  && !prevSnapRef.current.right)  navigator.vibrate?.(10)
        if (snapTop    && !prevSnapRef.current.top)    navigator.vibrate?.(10)
        if (snapBottom && !prevSnapRef.current.bottom) navigator.vibrate?.(10)
        prevSnapRef.current = { x: snapX, y: snapY, left: snapLeft, right: snapRight, top: snapTop, bottom: snapBottom }

        setSnapGuides({ x: snapX, y: snapY, left: snapLeft, right: snapRight, top: snapTop, bottom: snapBottom })
        const finalX = snapX ? 0 : snapLeft ? -edgeX : snapRight ? edgeX : rawX
        const finalY = snapY ? 0 : snapTop  ? -edgeY : snapBottom ? edgeY : rawY
        const next = { id: dragState.id, x: finalX, y: finalY }
        setLiveOffset(next)
        liveOffsetRef.current = next
      } else if (dragState.type === 'rotate') {
        const curAngle = Math.atan2(e.clientY - dragState.cy!, e.clientX - dragState.cx!)
        const delta = (curAngle - dragState.initAngle!) * (180 / Math.PI)
        const raw = ((dragState.initRotation + delta) % 360 + 360) % 360

        // Snap to 90° increments with attract/release hysteresis
        let snapped: number | null = null
        if (prevSnapRotRef.current !== null) {
          const diff = Math.abs(((raw - prevSnapRotRef.current) + 180) % 360 - 180)
          if (diff < ROT_RELEASE_DEG) snapped = prevSnapRotRef.current
        }
        if (snapped === null) {
          for (const angle of ROT_SNAP_ANGLES) {
            const diff = Math.abs(((raw - angle) + 180) % 360 - 180)
            if (diff < ROT_ATTRACT_DEG) { snapped = angle; break }
          }
        }
        if (snapped !== prevSnapRotRef.current) {
          if (snapped !== null) navigator.vibrate?.(10)
          prevSnapRotRef.current = snapped
          setSnapRotation(snapped)
        }

        const finalRotation = snapped ?? raw
        const next = { id: dragState.id, rotation: finalRotation }
        setLiveRotation(next)
        liveRotationRef.current = next
      } else {
        // Resize from a corner ('resize-se' → 'se') or an edge ('resize-e' → 'e').
        const handle = dragState.type.slice(7) as Corner | Edge
        // dirX/dirY are DIRECTION SIGNS (+1/-1), never scales: dragging the east
        // side rightwards grows the item, dragging the west side rightwards
        // shrinks it. Deliberately NOT named sx/sy — those mean per-axis SCALE
        // everywhere else in this hook, and conflating the two silently inverts
        // the drag direction.
        const dirX = handle.includes('e') ? 1 : -1
        const dirY = handle.includes('s') ? 1 : -1

        const baseX = dragState.initScaleX ?? dragState.initScale
        const baseY = dragState.initScaleY ?? dragState.initScale
        const isCorner = handle.length === 2

        let nextScaleX = baseX
        let nextScaleY = baseY
        let nextScale  = dragState.initScale
        if (isCorner) {
          // Both axes by the SAME delta — identical to the pre-per-axis formula,
          // so a uniform item's corner drag feels exactly as it always did.
          const delta = (dx * dirX + dy * dirY) / 100
          nextScaleX = Math.max(0.1, baseX * (1 + delta))
          nextScaleY = Math.max(0.1, baseY * (1 + delta))
          nextScale  = Math.max(0.1, dragState.initScale * (1 + delta))
        } else if (handle === 'e' || handle === 'w') {
          nextScaleX = Math.max(0.1, baseX * (1 + (dx * dirX) / 100))
        } else {
          nextScaleY = Math.max(0.1, baseY * (1 + (dy * dirY) / 100))
        }

        const next = { id: dragState.id, scale: nextScale, scaleX: nextScaleX, scaleY: nextScaleY }
        setLiveScale(next)
        liveScaleRef.current = next
      }
    }

    function onUp() {
      const lo = liveOffsetRef.current
      const ls = liveScaleRef.current
      const lr = liveRotationRef.current
      const changes: OverlayChanges = {}
      if (lo) { changes.offsetX = lo.x; changes.offsetY = lo.y }
      if (ls) {
        changes.scale = ls.scale
        // Commit shape is deliberately asymmetric, to keep legacy projects legacy:
        // a CORNER drag of an item that has never carried scaleX/scaleY is the old
        // uniform gesture and writes ONLY `scale`. Writing per-axis fields there
        // would migrate every existing item to per-axis storage the first time
        // anyone nudged it — a silent schema change for zero user benefit, since
        // both axes would just hold the same number.
        // An EDGE drag is per-axis by definition, and an item that ALREADY carries
        // scaleX/scaleY is already per-axis (and would be corrupted by a
        // scale-only commit, because `scaleX ?? scale` means the stale scaleX
        // would keep winning). Both of those write both axes.
        const handle = dragState!.type.startsWith('resize-') ? dragState!.type.slice(7) : ''
        if (dragState!.initHasPerAxis || handle.length === 1) {
          changes.scaleX = ls.scaleX
          changes.scaleY = ls.scaleY
        }
      }
      if (lr) { changes.rotation = lr.rotation }
      if (Object.keys(changes).length) onOverlayChange?.(dragState!.id, changes)
      setDragState(null)
      setLiveOffset(null)
      setLiveScale(null)
      setLiveRotation(null)
      setSnapGuides({ x: false, y: false, left: false, right: false, top: false, bottom: false })
      setSnapRotation(null)
      prevSnapRef.current = { x: false, y: false, left: false, right: false, top: false, bottom: false }
      prevSnapRotRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [dragState])

  return {
    dragState, setDragState,
    liveOffset, liveScale, liveRotation,
    snapGuides, snapRotation,
  }
}
