import { useEffect, useRef, useState } from 'react'

export type Corner = 'nw' | 'ne' | 'sw' | 'se'
export type DragType = 'move' | `resize-${Corner}` | 'rotate'

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
  initScale: number
  initRotation: number
  // rotate-specific: center of element in page coords and initial angle
  cx?: number
  cy?: number
  initAngle?: number
}

export function useDragOverlay(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onOverlayChange?: (id: string, changes: { offsetX?: number; offsetY?: number; scale?: number; rotation?: number }) => void,
) {
  const [dragState, setDragState] = useState<DragState | null>(null)

  const [liveOffset,   setLiveOffset]   = useState<{ id: string; x: number; y: number } | null>(null)
  const [liveScale,    setLiveScale]    = useState<{ id: string; scale: number } | null>(null)
  const [liveRotation, setLiveRotation] = useState<{ id: string; rotation: number } | null>(null)
  const liveOffsetRef   = useRef<typeof liveOffset>(null)
  const liveScaleRef    = useRef<typeof liveScale>(null)
  const liveRotationRef = useRef<typeof liveRotation>(null)

  // Snap guide visibility
  const [snapGuides, setSnapGuides]     = useState({ x: false, y: false })
  const [snapRotation, setSnapRotation] = useState<number | null>(null)
  const prevSnapRef    = useRef({ x: false, y: false })
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
        const snapX = Math.abs(rawX) < SNAP_THRESHOLD
        const snapY = Math.abs(rawY) < SNAP_THRESHOLD

        // Haptic on snap entry
        if (snapX && !prevSnapRef.current.x) navigator.vibrate?.(10)
        if (snapY && !prevSnapRef.current.y) navigator.vibrate?.(10)
        prevSnapRef.current = { x: snapX, y: snapY }

        setSnapGuides({ x: snapX, y: snapY })
        const next = { id: dragState.id, x: snapX ? 0 : rawX, y: snapY ? 0 : rawY }
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
        // Resize from corner
        const corner = dragState.type.slice(7) as Corner  // 'resize-se' → 'se'
        const sx = corner.includes('e') ? 1 : -1
        const sy = corner.includes('s') ? 1 : -1
        const delta = (dx * sx + dy * sy) / 100
        const newScale = Math.max(0.1, dragState.initScale * (1 + delta))
        const next = { id: dragState.id, scale: newScale }
        setLiveScale(next)
        liveScaleRef.current = next
      }
    }

    function onUp() {
      const lo = liveOffsetRef.current
      const ls = liveScaleRef.current
      const lr = liveRotationRef.current
      const changes: { offsetX?: number; offsetY?: number; scale?: number; rotation?: number } = {}
      if (lo) { changes.offsetX = lo.x; changes.offsetY = lo.y }
      if (ls) { changes.scale = ls.scale }
      if (lr) { changes.rotation = lr.rotation }
      if (Object.keys(changes).length) onOverlayChange?.(dragState!.id, changes)
      setDragState(null)
      setLiveOffset(null)
      setLiveScale(null)
      setLiveRotation(null)
      setSnapGuides({ x: false, y: false })
      setSnapRotation(null)
      prevSnapRef.current = { x: false, y: false }
      prevSnapRotRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState])

  return {
    dragState, setDragState,
    liveOffset, liveScale, liveRotation,
    snapGuides, snapRotation,
  }
}
