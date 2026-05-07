import { useEffect, useRef, useState } from 'react'
import type { Slide, CarouselElement, OverlayElement } from '@/lib/types/schema'
import { compileOverlay, type OverlayFactory } from '@/lib/overlay-eval'

function resolveAsset(src: string): string {
  if (!src) return src
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  return `/api/files?path=${encodeURIComponent(src)}`
}

// ── OverlayElementView ───────────────────────────────────────────────────────

interface OverlayElementViewProps {
  element: OverlayElement
}

function OverlayElementView({ element }: OverlayElementViewProps) {
  const [factory, setFactory] = useState<OverlayFactory | null>(null)
  const [compileError, setCompileError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setCompileError(null)
    compileOverlay(element.overlay.template).then(f => {
      if (!cancelled) setFactory(() => f)
    }).catch(err => {
      if (!cancelled) setCompileError(err instanceof Error ? err.message : String(err))
      console.warn('[SlideCanvas] overlay compile error:', err)
    })
    return () => { cancelled = true }
  }, [element.overlay.template])

  if (compileError) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          outline: '1px dashed red',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 4,
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: 11, color: 'red', wordBreak: 'break-word', textAlign: 'center' }}>
          {compileError.slice(0, 120)}
        </span>
      </div>
    )
  }

  if (!factory) return null

  const mergedProps = { ...element.overlay.props, offsetX: 0, offsetY: 0, scale: 1 }
  const duration = (element.overlay.props.duration as number | undefined) ?? 60

  try {
    return factory(element.frame, 30, duration, mergedProps) as React.ReactElement | null
  } catch {
    return null
  }
}

// ── Snap config ─────────────────────────────────────────────────────────────

// Position snap threshold = 2.5% of slide width (matches video preview's useDragOverlay).
// For a 1080-wide slide that's 27px in native coords.
const POSITION_SNAP_PCT = 0.025
// Rotation snap: 90° increments with attract/release hysteresis (matches useDragOverlay).
const ROT_SNAP_ANGLES = [0, 90, 180, 270]
const ROT_ATTRACT_DEG = 5
const ROT_RELEASE_DEG = 8

interface SnapState {
  centerX: boolean
  centerY: boolean
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}
const SNAP_OFF: SnapState = { centerX: false, centerY: false, left: false, right: false, top: false, bottom: false }

// ── Resize / Rotate handles ──────────────────────────────────────────────────

// 8 resize handle positions: corners + edge midpoints
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLE_SIZE = 8

const HANDLES: { id: HandleId; cursor: string; xPct: number; yPct: number }[] = [
  { id: 'nw', cursor: 'nwse-resize', xPct: 0,   yPct: 0   },
  { id: 'n',  cursor: 'ns-resize',   xPct: 0.5, yPct: 0   },
  { id: 'ne', cursor: 'nesw-resize', xPct: 1,   yPct: 0   },
  { id: 'e',  cursor: 'ew-resize',   xPct: 1,   yPct: 0.5 },
  { id: 'se', cursor: 'nwse-resize', xPct: 1,   yPct: 1   },
  { id: 's',  cursor: 'ns-resize',   xPct: 0.5, yPct: 1   },
  { id: 'sw', cursor: 'nesw-resize', xPct: 0,   yPct: 1   },
  { id: 'w',  cursor: 'ew-resize',   xPct: 0,   yPct: 0.5 },
]

interface HandleProps {
  handle: (typeof HANDLES)[number]
  element: CarouselElement
  scale: number
  onElementChange: (id: string, patch: Partial<CarouselElement>) => void
}

function ResizeHandle({ handle, element, scale, onElementChange }: HandleProps) {
  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    const startX = e.clientX
    const startY = e.clientY
    const startEl = { x: element.x, y: element.y, w: element.w, h: element.h }
    const shiftHeld = { current: e.shiftKey }

    const onMove = (ev: PointerEvent) => {
      shiftHeld.current = ev.shiftKey
      const dx = (ev.clientX - startX) / scale
      const dy = (ev.clientY - startY) / scale
      const { id } = handle
      let { x, y, w, h } = startEl

      // West handles move x and shrink/grow w
      if (id === 'nw' || id === 'w' || id === 'sw') {
        x = startEl.x + dx
        w = Math.max(10, startEl.w - dx)
      }
      // East handles grow w
      if (id === 'ne' || id === 'e' || id === 'se') {
        w = Math.max(10, startEl.w + dx)
      }
      // North handles move y and shrink/grow h
      if (id === 'nw' || id === 'n' || id === 'ne') {
        y = startEl.y + dy
        h = Math.max(10, startEl.h - dy)
      }
      // South handles grow h
      if (id === 'sw' || id === 's' || id === 'se') {
        h = Math.max(10, startEl.h + dy)
      }

      // Shift = preserve aspect ratio (corners only)
      if (shiftHeld.current && (id === 'nw' || id === 'ne' || id === 'se' || id === 'sw')) {
        const aspect = startEl.w / startEl.h
        if (Math.abs(dx) > Math.abs(dy)) {
          h = w / aspect
          if (id === 'nw' || id === 'sw') y = startEl.y + (startEl.h - h)
        } else {
          w = h * aspect
          if (id === 'nw' || id === 'ne') x = startEl.x + (startEl.w - w)
        }
      }

      onElementChange(element.id, {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
      })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Position handle centered on the corresponding point of the element border
  // Note: these are in native (pre-scale) element coords, inside the scaled inner div
  const left = handle.xPct * element.w - HANDLE_SIZE / 2
  const top  = handle.yPct * element.h - HANDLE_SIZE / 2

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        left,
        top,
        width:  HANDLE_SIZE,
        height: HANDLE_SIZE,
        background: '#3b82f6',
        border: '1px solid #fff',
        borderRadius: 1,
        cursor: handle.cursor,
        zIndex: 10,
        boxSizing: 'border-box',
      }}
    />
  )
}

interface RotateHandleProps {
  element: CarouselElement
  onElementChange: (id: string, patch: Partial<CarouselElement>) => void
}

function RotateHandle({ element, onElementChange }: RotateHandleProps) {
  // The rotate handle sits ~20px above the top-center in scaled display coords.
  // Because the element div is inside the scaled inner container, we position it
  // relative to the element div (which is in native px coords already).
  // We use a small pseudo-line via border-top on the handle itself.

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    // Center of the element in display (scaled) coords
    const rect = (e.currentTarget as HTMLElement)
      .closest('[data-element-wrapper]')!
      .getBoundingClientRect()
    const cx = rect.left + rect.width  / 2
    const cy = rect.top  + rect.height / 2

    // Rotation snap with attract/release hysteresis (mirrors useDragOverlay).
    let snappedAngle: number | null = null

    const onMove = (ev: PointerEvent) => {
      const raw = ((Math.atan2(ev.clientY - cy, ev.clientX - cx) * (180 / Math.PI) + 90) % 360 + 360) % 360

      // If currently snapped, hold until raw escapes the release zone.
      if (snappedAngle !== null) {
        const diff = Math.abs(((raw - snappedAngle) + 180) % 360 - 180)
        if (diff < ROT_RELEASE_DEG) {
          onElementChange(element.id, { rotation: snappedAngle })
          return
        }
        snappedAngle = null
      }

      // Look for a new snap target within attract zone.
      for (const a of ROT_SNAP_ANGLES) {
        const diff = Math.abs(((raw - a) + 180) % 360 - 180)
        if (diff < ROT_ATTRACT_DEG) {
          snappedAngle = a
          onElementChange(element.id, { rotation: a })
          return
        }
      }

      onElementChange(element.id, { rotation: Math.round(raw) })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Position: centered horizontally above the element, 20px above top edge (in native px)
  const ROTATE_OFFSET = 20
  const left = element.w / 2 - 7
  const top  = -ROTATE_OFFSET - 14

  return (
    <>
      {/* Visual stem line */}
      <div
        style={{
          position: 'absolute',
          left: element.w / 2 - 0.5,
          top: -ROTATE_OFFSET,
          width: 1,
          height: ROTATE_OFFSET,
          background: '#3b82f6',
          pointerEvents: 'none',
          zIndex: 9,
        }}
      />
      {/* Circular handle */}
      <div
        onPointerDown={onPointerDown}
        title="Drag to rotate"
        style={{
          position: 'absolute',
          left,
          top,
          width: 14,
          height: 14,
          background: '#3b82f6',
          border: '2px solid #fff',
          borderRadius: '50%',
          cursor: 'crosshair',
          zIndex: 10,
          boxSizing: 'border-box',
        }}
      />
    </>
  )
}

// ── SlideCanvas ───────────────────────────────────────────────────────────────

interface Props {
  slide: Slide
  width: number
  height: number
  interactive?: boolean
  selectedElementId?: string | null
  onSelect?: (id: string | null) => void
  onElementChange?: (id: string, patch: Partial<CarouselElement>) => void
  scale?: number
}

export default function SlideCanvas({
  slide,
  width,
  height,
  interactive = false,
  selectedElementId,
  onSelect,
  onElementChange,
  scale = 1,
}: Props) {
  const isDragging = useRef(false)
  const dragElement = useRef<CarouselElement | null>(null)
  const dragStart = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)

  // Text editing state for overlay elements
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState<string>('')

  // Snap-guide visibility during drag. Re-rendered as overlays inside the slide.
  const [snap, setSnap] = useState<SnapState>(SNAP_OFF)

  function startDrag(e: React.PointerEvent, element: CarouselElement) {
    if (!interactive) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    isDragging.current = false
    dragElement.current = element
    dragStart.current = { px: e.clientX, py: e.clientY, ox: element.x, oy: element.y }

    const threshold = width * POSITION_SNAP_PCT  // native px

    const onMove = (ev: PointerEvent) => {
      if (!dragStart.current || !dragElement.current) return
      const dx = (ev.clientX - dragStart.current.px) / scale
      const dy = (ev.clientY - dragStart.current.py) / scale
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) isDragging.current = true

      const w = dragElement.current.w
      const h = dragElement.current.h
      const rawX = dragStart.current.ox + dx
      const rawY = dragStart.current.oy + dy

      // X-axis snap: prefer slide-center, then left/right edges.
      const centerXTarget = (width - w) / 2
      const rightXTarget  = width - w
      const snapCenterX = Math.abs(rawX - centerXTarget) < threshold
      const snapLeft    = !snapCenterX && Math.abs(rawX) < threshold
      const snapRight   = !snapCenterX && !snapLeft && Math.abs(rawX - rightXTarget) < threshold

      // Y-axis snap: prefer slide-center, then top/bottom edges.
      const centerYTarget = (height - h) / 2
      const bottomYTarget = height - h
      const snapCenterY = Math.abs(rawY - centerYTarget) < threshold
      const snapTop     = !snapCenterY && Math.abs(rawY) < threshold
      const snapBottom  = !snapCenterY && !snapTop && Math.abs(rawY - bottomYTarget) < threshold

      const finalX = snapCenterX ? centerXTarget : snapLeft ? 0 : snapRight  ? rightXTarget  : rawX
      const finalY = snapCenterY ? centerYTarget : snapTop  ? 0 : snapBottom ? bottomYTarget : rawY

      setSnap({
        centerX: snapCenterX,
        centerY: snapCenterY,
        left: snapLeft,
        right: snapRight,
        top: snapTop,
        bottom: snapBottom,
      })

      onElementChange?.(dragElement.current.id, {
        x: Math.round(finalX),
        y: Math.round(finalY),
      })
    }

    const onUp = () => {
      dragElement.current = null
      dragStart.current = null
      setSnap(SNAP_OFF)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function handleDoubleClick(element: CarouselElement) {
    if (!interactive || element.type !== 'overlay') return
    const textVal = element.overlay.props.text
    if (typeof textVal !== 'string') return // no text prop — no-op
    setEditingId(element.id)
    setEditingText(textVal)
  }

  function commitTextEdit(element: CarouselElement) {
    if (!onElementChange) return
    onElementChange(element.id, {
      overlay: {
        ...(element as OverlayElement).overlay,
        props: {
          ...(element as OverlayElement).overlay.props,
          text: editingText,
        },
      },
    } as Partial<CarouselElement>)
    setEditingId(null)
    setEditingText('')
  }

  const displayW = width * scale
  const displayH = height * scale

  return (
    <div
      style={{
        width: displayW,
        height: displayH,
        overflow: 'hidden',
        position: 'relative',
        flexShrink: 0,
      }}
      onClick={interactive ? () => onSelect?.(null) : undefined}
    >
      {/* Inner native-resolution div, scaled down via transform */}
      <div
        style={{
          width,
          height,
          position: 'absolute',
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          backgroundColor: slide.base_color || '#ffffff',
        }}
      >
        {/* Snap guides — full-slide lines at active snap targets. Native-coord px;
            rendered above slide bg, below elements is fine but we put above for visibility. */}
        {(() => {
          const lineColor = '#ec4899'  // pink-500
          const t = Math.max(1, 1 / scale)  // ~1px on screen regardless of scale
          const guides: React.ReactNode[] = []
          if (snap.centerX) guides.push(<div key="cx" style={{ position: 'absolute', left: width / 2 - t / 2, top: 0,            width: t,     height,        background: lineColor, pointerEvents: 'none', zIndex: 999 }} />)
          if (snap.left)    guides.push(<div key="lf" style={{ position: 'absolute', left: 0,                  top: 0,            width: t,     height,        background: lineColor, pointerEvents: 'none', zIndex: 999 }} />)
          if (snap.right)   guides.push(<div key="rt" style={{ position: 'absolute', left: width - t,          top: 0,            width: t,     height,        background: lineColor, pointerEvents: 'none', zIndex: 999 }} />)
          if (snap.centerY) guides.push(<div key="cy" style={{ position: 'absolute', left: 0,                  top: height / 2 - t / 2, width,  height: t,    background: lineColor, pointerEvents: 'none', zIndex: 999 }} />)
          if (snap.top)     guides.push(<div key="tp" style={{ position: 'absolute', left: 0,                  top: 0,            width,        height: t,    background: lineColor, pointerEvents: 'none', zIndex: 999 }} />)
          if (snap.bottom)  guides.push(<div key="bt" style={{ position: 'absolute', left: 0,                  top: height - t,   width,        height: t,    background: lineColor, pointerEvents: 'none', zIndex: 999 }} />)
          return guides
        })()}
        {slide.elements.map(element => {
          const isSelected = selectedElementId === element.id
          const isEditing  = editingId === element.id

          // NOTE (v2 limitation): when an element is rotated, the drag handler still moves
          // x/y in world (unrotated) coords. For small rotations the UX is fine, but for
          // large rotations the visual tracking is misaligned. Correct fix would be to
          // decompose pointer delta into the element's local coordinate frame.
          const commonStyle: React.CSSProperties = {
            position: 'absolute',
            left: element.x,
            top: element.y,
            width: element.w,
            height: element.h,
            transform: `rotate(${element.rotation}deg)`,
            transformOrigin: 'center center',
            pointerEvents: interactive ? 'auto' : 'none',
            userSelect: 'none',
            outline: isSelected ? '1px solid #3b82f6' : 'none',
            cursor: interactive ? 'grab' : 'default',
          }

          if (element.type === 'image') {
            return (
              <div
                key={element.id}
                data-element-wrapper
                style={commonStyle}
                onClick={interactive ? (e) => { e.stopPropagation(); onSelect?.(element.id) } : undefined}
                onPointerDown={interactive ? (e) => { onSelect?.(element.id); startDrag(e, element) } : undefined}
              >
                <img
                  src={resolveAsset(element.src)}
                  draggable={false}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  alt=""
                />
                {isSelected && interactive && onElementChange && (
                  <>
                    {HANDLES.map(h => (
                      <ResizeHandle
                        key={h.id}
                        handle={h}
                        element={element}
                        scale={scale}
                        onElementChange={onElementChange}
                      />
                    ))}
                    <RotateHandle element={element} onElementChange={onElementChange} />
                  </>
                )}
              </div>
            )
          }

          if (element.type === 'overlay') {
            const hasTextProp = typeof element.overlay.props.text === 'string'
            return (
              <div
                key={element.id}
                data-element-wrapper
                style={commonStyle}
                onClick={interactive ? (e) => { e.stopPropagation(); onSelect?.(element.id) } : undefined}
                onPointerDown={interactive ? (e) => {
                  if (isEditing) return
                  onSelect?.(element.id)
                  startDrag(e, element)
                } : undefined}
                onDoubleClick={interactive ? (e) => { e.stopPropagation(); handleDoubleClick(element) } : undefined}
              >
                {isEditing ? (
                  /* Double-click inline text editor */
                  <div
                    contentEditable
                    suppressContentEditableWarning
                    style={{
                      width: '100%',
                      height: '100%',
                      outline: '2px solid #3b82f6',
                      background: 'rgba(0,0,0,0.7)',
                      color: '#fff',
                      fontSize: 18,
                      padding: 4,
                      boxSizing: 'border-box',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      cursor: 'text',
                    }}
                    onInput={(e) => setEditingText((e.currentTarget as HTMLDivElement).innerText)}
                    onBlur={() => commitTextEdit(element)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setEditingId(null)
                        setEditingText('')
                      }
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        commitTextEdit(element)
                      }
                      e.stopPropagation()
                    }}
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    ref={(el) => {
                      if (el) {
                        el.focus()
                        // Place cursor at end
                        const range = document.createRange()
                        range.selectNodeContents(el)
                        range.collapse(false)
                        const sel = window.getSelection()
                        sel?.removeAllRanges()
                        sel?.addRange(range)
                      }
                    }}
                  >
                    {editingText}
                  </div>
                ) : (
                  <OverlayElementView element={element} />
                )}
                {isSelected && !isEditing && interactive && onElementChange && (
                  <>
                    {HANDLES.map(h => (
                      <ResizeHandle
                        key={h.id}
                        handle={h}
                        element={element}
                        scale={scale}
                        onElementChange={onElementChange}
                      />
                    ))}
                    <RotateHandle element={element} onElementChange={onElementChange} />
                    {hasTextProp && (
                      <div
                        style={{
                          position: 'absolute',
                          bottom: -20,
                          left: 0,
                          fontSize: 10,
                          color: '#93c5fd',
                          pointerEvents: 'none',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        double-click to edit text
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          }

          return null
        })}
      </div>
    </div>
  )
}
