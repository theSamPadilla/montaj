import { useEffect, useRef, useState } from 'react'
import type { Slide, OverlayElement, ImageElement } from '@/lib/types/schema'
import type { OverlayFactory } from '@/editor-core/types'
import OverlayErrorBoundary from '@/components/OverlayErrorBoundary'
import { OverlayPreview } from '@/editor-core/preview/OverlayPreview'
import {
  useOverlayDrag,
  useOverlayResize,
  useOverlayRotate,
  buildElementTransform,
  type ResizeHandle as ResizeHandleId,
  type SnapGuide,
} from '@/editor-core/gestures'
import { CanvasCropOverlay } from '@/editor-core/crop/CanvasCropOverlay'
import { InlineTextEditor } from '@/editor-core/text/InlineTextEditor'

function resolveAssetDefault(src: string): string {
  if (!src) return src
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  return `/api/files?path=${encodeURIComponent(src)}`
}

// ── Resize / Rotate handle geometry ────────────────────────────────────────────

const HANDLE_SIZE = 8
const ROTATE_OFFSET = 20

const HANDLES: { id: ResizeHandleId; cursor: string; xPct: number; yPct: number }[] = [
  { id: 'nw', cursor: 'nwse-resize', xPct: 0,   yPct: 0   },
  { id: 'n',  cursor: 'ns-resize',   xPct: 0.5, yPct: 0   },
  { id: 'ne', cursor: 'nesw-resize', xPct: 1,   yPct: 0   },
  { id: 'e',  cursor: 'ew-resize',   xPct: 1,   yPct: 0.5 },
  { id: 'se', cursor: 'nwse-resize', xPct: 1,   yPct: 1   },
  { id: 's',  cursor: 'ns-resize',   xPct: 0.5, yPct: 1   },
  { id: 'sw', cursor: 'nesw-resize', xPct: 0,   yPct: 1   },
  { id: 'w',  cursor: 'ew-resize',   xPct: 0,   yPct: 0.5 },
]

// ── OverlayElementView — shared OverlayPreview wrapper ─────────────────────────

// Fallback compiler used when no compiler is injected (e.g. thumbnail previews
// that don't need live overlay rendering). Always rejects so OverlayPreview
// shows its errorState rather than a spinner that never resolves.
const noopCompiler = (): Promise<OverlayFactory> =>
  Promise.reject(new Error('No overlay compiler provided'))

function OverlayElementView({
  element,
  compileOverlay,
}: {
  element: OverlayElement
  compileOverlay?: (template: string) => Promise<OverlayFactory>
}) {
  const duration = (element.overlay.props.duration as number | undefined) ?? 60
  const mergedProps = { ...element.overlay.props, offsetX: 0, offsetY: 0, scale: 1 }
  return (
    <OverlayPreview
      compileOverlay={compileOverlay ?? noopCompiler}
      template={element.overlay.template}
      props={mergedProps}
      frame={element.frame}
      fps={30}
      duration={duration}
    />
  )
}

// ── SlideCanvas ───────────────────────────────────────────────────────────────

type CropMode = { elementId: string; localCrop: { x: number; y: number; w: number; h: number } } | null

interface Props {
  slide: Slide
  slideId?: string
  width: number
  height: number
  interactive?: boolean
  selectedElementId?: string | null
  onSelect?: (id: string | null) => void
  scale?: number
  resolveImageSrc?: (element: ImageElement) => string
  /**
   * Host-supplied overlay compiler. Injected from the adapter so SlideCanvas
   * (and OverlayPreview inside it) never import '@/lib/overlay-eval' directly.
   * When absent, overlay elements render nothing (thumbnail / read-only paths).
   */
  compileOverlay?: (template: string) => Promise<OverlayFactory>

  // Project-state mutators (editor-core). Required for the interactive path.
  moveElement?: (slideId: string, elementId: string, x: number, y: number) => Promise<void>
  resizeElement?: (slideId: string, elementId: string, box: { x: number; y: number; w: number; h: number }) => Promise<void>
  rotateElement?: (slideId: string, elementId: string, rotation: number) => Promise<void>
  commit?: () => Promise<void>
  updateOverlayProp?: (slideId: string, elementId: string, key: string, value: string) => Promise<void>
  updateImageCrop?: (slideId: string, elementId: string, crop: { x: number; y: number; w: number; h: number } | undefined) => Promise<void>

  // Crop mode is owned here but the entry trigger lives in the property panel.
  cropElementId?: string | null
  onExitCrop?: () => void
}

export default function SlideCanvas({
  slide,
  slideId,
  width,
  height,
  interactive = false,
  selectedElementId,
  onSelect,
  scale = 1,
  resolveImageSrc,
  compileOverlay,
  moveElement,
  resizeElement,
  rotateElement,
  commit,
  updateOverlayProp,
  updateImageCrop,
  cropElementId,
  onExitCrop,
}: Props) {
  const sid = slideId ?? slide.id
  const resolveSrc = resolveImageSrc ?? ((el: ImageElement) => resolveAssetDefault(el.src))

  // Refs to each element wrapper so gesture previews can mutate DOM directly.
  const wrapperRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const setWrapperRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) wrapperRefs.current.set(id, el)
    else wrapperRefs.current.delete(id)
  }

  // Inline text edit state.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRect, setEditRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  // Crop mode local state — source fraction window + loaded natural dims.
  const [cropState, setCropState] = useState<CropMode>(null)
  const [cropSrcDims, setCropSrcDims] = useState<{ width: number; height: number } | undefined>(undefined)

  // ── Gesture preview helper: write transform/size directly to the wrapper ──
  const applyPreviewTransform = (id: string, x: number, y: number, rotation: number) => {
    const el = wrapperRefs.current.get(id)
    if (el) el.style.transform = buildElementTransform(x, y, scale, rotation)
  }
  const applyPreviewBox = (
    id: string,
    box: { x: number; y: number; w: number; h: number },
    rotation: number,
  ) => {
    const el = wrapperRefs.current.get(id)
    if (!el) return
    el.style.transform = buildElementTransform(box.x, box.y, scale, rotation)
    el.style.width = `${box.w * scale}px`
    el.style.height = `${box.h * scale}px`
  }

  // ── Gesture hooks ──
  const drag = useOverlayDrag({
    scale,
    slide: { w: width, h: height },
    onPreview: applyPreviewTransform,
    onCommit: async (id, x, y) => {
      await moveElement?.(sid, id, Math.round(x), Math.round(y))
      await commit?.()
    },
  })

  const resize = useOverlayResize({
    scale,
    onPreview: applyPreviewBox,
    onCommit: async (id, box) => {
      await resizeElement?.(sid, id, {
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.w),
        h: Math.round(box.h),
      })
      await commit?.()
    },
  })

  const rotate = useOverlayRotate({
    onPreview: (id, rotation, x, y) => applyPreviewTransform(id, x, y, rotation),
    onCommit: async (id, rotation) => {
      await rotateElement?.(sid, id, Math.round(rotation))
      await commit?.()
    },
  })

  // ── Enter / exit crop mode when cropElementId changes ──
  useEffect(() => {
    if (!cropElementId) {
      setCropState(null)
      setCropSrcDims(undefined)
      return
    }
    const el = slide.elements.find((e) => e.id === cropElementId)
    if (!el || el.type !== 'image') {
      setCropState(null)
      return
    }
    setCropState({ elementId: cropElementId, localCrop: el.crop ?? { x: 0, y: 0, w: 1, h: 1 } })
    setCropSrcDims(undefined)
  }, [cropElementId, slide.elements])

  // Commit crop (also resizes the element box to match the crop's aspect) and exit.
  const commitCrop = async () => {
    const cs = cropState
    if (!cs) return
    const el = slide.elements.find((e) => e.id === cs.elementId)
    if (el && el.type === 'image' && cropSrcDims) {
      // Resize the element box so the cropped pixel aspect matches the box aspect.
      // The crop window is a sub-rect of the source in fractions; convert its
      // pixel aspect into a new box height for the current box width.
      const croppedAspect =
        (cs.localCrop.w * cropSrcDims.width) / (cs.localCrop.h * cropSrcDims.height)
      if (Number.isFinite(croppedAspect) && croppedAspect > 0) {
        const newH = Math.round(el.w / croppedAspect)
        await resizeElement?.(sid, cs.elementId, { x: el.x, y: el.y, w: el.w, h: newH })
      }
      await updateImageCrop?.(sid, cs.elementId, cs.localCrop)
      await commit?.()
    }
    onExitCrop?.()
  }

  // Escape / click-outside commits the crop.
  useEffect(() => {
    if (!cropState) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void commitCrop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropState, cropSrcDims])

  // ── Inline text edit ──
  function beginTextEdit(element: OverlayElement) {
    if (!interactive || typeof element.overlay.props.text !== 'string') return
    setEditRect({
      left: element.x * scale,
      top: element.y * scale,
      width: element.w * scale,
      height: element.h * scale,
    })
    setEditingId(element.id)
  }

  function commitTextEdit(element: OverlayElement, value: string) {
    void updateOverlayProp?.(sid, element.id, 'text', value)
    setEditingId(null)
    setEditRect(null)
  }

  // ── Pointer wiring shared by drag/resize/rotate ──
  // We attach window-level move/up listeners while a gesture is active so the
  // gesture keeps tracking outside the element bounds.
  const activeGesture = useRef<'drag' | 'resize' | 'rotate' | null>(null)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cursor = { x: e.clientX, y: e.clientY }
      if (activeGesture.current === 'drag') drag.onPointerMove(cursor)
      else if (activeGesture.current === 'resize') resize.onPointerMove(cursor)
      else if (activeGesture.current === 'rotate') rotate.onPointerMove(cursor)
    }
    const onUp = () => {
      if (activeGesture.current === 'drag') drag.onPointerUp()
      else if (activeGesture.current === 'resize') resize.onPointerUp()
      else if (activeGesture.current === 'rotate') rotate.onPointerUp()
      activeGesture.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, resize, rotate])

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
      {/* Inner native-resolution layer. Elements are positioned at native coords
          and the wrapper transform applies translate(...*scale) so gesture
          previews can mutate the same transform string. */}
      <div
        style={{
          width: displayW,
          height: displayH,
          position: 'absolute',
          top: 0,
          left: 0,
          backgroundColor: slide.base_color || '#ffffff',
        }}
      >
        {/* Snap guides — drawn at the drag hook's reported guide axes. */}
        {interactive && drag.guides.map((g: SnapGuide, i) =>
          g.axis === 'x' ? (
            <div
              key={`gx-${i}`}
              data-testid="snap-guide-x"
              style={{
                position: 'absolute',
                left: g.at * scale - 0.5,
                top: 0,
                width: 1,
                height: displayH,
                background: '#ec4899',
                pointerEvents: 'none',
                zIndex: 999,
              }}
            />
          ) : (
            <div
              key={`gy-${i}`}
              data-testid="snap-guide-y"
              style={{
                position: 'absolute',
                left: 0,
                top: g.at * scale - 0.5,
                width: displayW,
                height: 1,
                background: '#ec4899',
                pointerEvents: 'none',
                zIndex: 999,
              }}
            />
          ),
        )}

        {slide.elements.map((element) => {
          const isSelected = selectedElementId === element.id
          const inCrop = cropState?.elementId === element.id
          const isRotated = (element.rotation ?? 0) !== 0

          const wrapperStyle: React.CSSProperties = {
            position: 'absolute',
            left: 0,
            top: 0,
            width: element.w * scale,
            height: element.h * scale,
            transform: buildElementTransform(element.x, element.y, scale, element.rotation),
            transformOrigin: 'center center',
            pointerEvents: interactive ? 'auto' : 'none',
            userSelect: 'none',
            outline: isSelected ? '1px solid #3b82f6' : 'none',
            cursor: interactive ? 'grab' : 'default',
          }

          const handlePointerDownDrag = (e: React.PointerEvent) => {
            if (!interactive || inCrop || editingId === element.id) return
            e.preventDefault()
            e.stopPropagation()
            onSelect?.(element.id)
            activeGesture.current = 'drag'
            drag.onPointerDown(
              element.id,
              { x: e.clientX, y: e.clientY },
              { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation },
            )
          }

          const innerContent =
            element.type === 'image' ? (
              <img
                src={resolveSrc(element)}
                draggable={false}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                alt=""
              />
            ) : (
              <OverlayErrorBoundary
                label={element.overlay.template.split('/').pop() ?? element.overlay.template}
                watchPath={element.overlay.template}
              >
                <OverlayElementView element={element} compileOverlay={compileOverlay} />
              </OverlayErrorBoundary>
            )

          return (
            <div
              key={element.id}
              ref={setWrapperRef(element.id)}
              data-element-wrapper
              data-element-id={element.id}
              style={wrapperStyle}
              onClick={interactive ? (e) => { e.stopPropagation(); onSelect?.(element.id) } : undefined}
              onPointerDown={handlePointerDownDrag}
              onDoubleClick={
                interactive && element.type === 'overlay'
                  ? (e) => { e.stopPropagation(); beginTextEdit(element) }
                  : undefined
              }
            >
              {innerContent}

              {/* In-canvas crop overlay for the image being cropped. */}
              {inCrop && element.type === 'image' && cropState && (
                <CanvasCropOverlay
                  element={element}
                  resolveImageSrc={resolveSrc}
                  scale={scale}
                  localCrop={cropState.localCrop}
                  onLocalCropChange={(next) =>
                    setCropState((cs) => (cs ? { ...cs, localCrop: next } : cs))
                  }
                  onSrcDimsLoaded={setCropSrcDims}
                  srcDims={cropSrcDims}
                />
              )}

              {/* Selection handles (hidden while cropping or rotated-crop guard). */}
              {isSelected && !inCrop && editingId !== element.id && interactive && (
                <>
                  {HANDLES.map((h) => {
                    const left = h.xPct * element.w * scale - HANDLE_SIZE / 2
                    const top = h.yPct * element.h * scale - HANDLE_SIZE / 2
                    return (
                      <div
                        key={h.id}
                        data-testid={`resize-handle-${h.id}`}
                        onPointerDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          activeGesture.current = 'resize'
                          resize.onPointerDown(
                            element.id,
                            h.id,
                            { x: e.clientX, y: e.clientY },
                            { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation },
                          )
                        }}
                        style={{
                          position: 'absolute',
                          left,
                          top,
                          width: HANDLE_SIZE,
                          height: HANDLE_SIZE,
                          background: '#3b82f6',
                          border: '1px solid #fff',
                          borderRadius: 1,
                          cursor: h.cursor,
                          zIndex: 10,
                          boxSizing: 'border-box',
                          touchAction: 'none',
                        }}
                      />
                    )
                  })}
                  {/* Rotate handle */}
                  <div
                    style={{
                      position: 'absolute',
                      left: (element.w * scale) / 2 - 0.5,
                      top: -ROTATE_OFFSET,
                      width: 1,
                      height: ROTATE_OFFSET,
                      background: '#3b82f6',
                      pointerEvents: 'none',
                      zIndex: 9,
                    }}
                  />
                  <div
                    data-testid="rotate-handle"
                    title="Drag to rotate"
                    onPointerDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const rect = (e.currentTarget as HTMLElement)
                        .closest('[data-element-wrapper]')!
                        .getBoundingClientRect()
                      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                      activeGesture.current = 'rotate'
                      rotate.onPointerDown(
                        element.id,
                        center,
                        { x: e.clientX, y: e.clientY },
                        element.rotation ?? 0,
                        { x: element.x, y: element.y },
                      )
                    }}
                    style={{
                      position: 'absolute',
                      left: (element.w * scale) / 2 - 7,
                      top: -ROTATE_OFFSET - 14,
                      width: 14,
                      height: 14,
                      background: '#3b82f6',
                      border: '2px solid #fff',
                      borderRadius: '50%',
                      cursor: 'crosshair',
                      zIndex: 10,
                      boxSizing: 'border-box',
                      touchAction: 'none',
                    }}
                  />
                  {element.type === 'overlay' && typeof element.overlay.props.text === 'string' && (
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
                  {/* Guard hint: crop disabled while rotated (enforced in panel). */}
                  {element.type === 'image' && isRotated && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: -20,
                        left: 0,
                        fontSize: 10,
                        color: '#fca5a5',
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      reset rotation to crop
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}

        {/* Inline text editor (positioned in display coords over the element). */}
        {interactive && editingId && editRect && (() => {
          const el = slide.elements.find((e) => e.id === editingId)
          if (!el || el.type !== 'overlay') return null
          const initial = typeof el.overlay.props.text === 'string' ? el.overlay.props.text : ''
          return (
            <InlineTextEditor
              key={editingId}
              initialValue={initial}
              rect={editRect}
              styleSnapshot={{
                color: '#ffffff',
                fontSize: '18px',
                fontFamily: 'system-ui, sans-serif',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
              onChange={() => {}}
              onCommit={(value) => commitTextEdit(el, value)}
              onCancel={() => { setEditingId(null); setEditRect(null) }}
            />
          )
        })()}
      </div>
    </div>
  )
}

// Re-export the default asset resolver so other modules can reuse it.
export { resolveAssetDefault as resolveAsset }
