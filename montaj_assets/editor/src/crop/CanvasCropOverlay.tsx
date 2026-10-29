import * as React from 'react'
import type { ImageElement } from '../types'
import { isLayerPress } from '../carousel/hitTest'
import {
  renderedSourceRect,
  drawnSourceRect,
  fractionToWrapperPx,
  applyCropHandleDrag,
  translateCropPx,
  type CropFraction,
  type CropHandle,
} from './crop-math'

const CROP_HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']

const HANDLE_OFFSET: Record<CropHandle, { dx: 0 | 0.5 | 1; dy: 0 | 0.5 | 1; cursor: string }> = {
  nw: { dx: 0,   dy: 0,   cursor: 'nw-resize' },
  n:  { dx: 0.5, dy: 0,   cursor: 'n-resize'  },
  ne: { dx: 1,   dy: 0,   cursor: 'ne-resize' },
  w:  { dx: 0,   dy: 0.5, cursor: 'w-resize'  },
  e:  { dx: 1,   dy: 0.5, cursor: 'e-resize'  },
  sw: { dx: 0,   dy: 1,   cursor: 'sw-resize' },
  s:  { dx: 0.5, dy: 1,   cursor: 's-resize'  },
  se: { dx: 1,   dy: 1,   cursor: 'se-resize' },
}

export type CanvasCropOverlayProps = {
  /**
   * The image element being cropped. Passed to `resolveImageSrc` to obtain a
   * displayable URL — the overlay never constructs URLs itself.
   */
  element: ImageElement
  /**
   * Host-supplied resolver. Implement as `(el) => adapter.resolveImageSrc(el)`
   * on the caller side; the overlay stays host-agnostic.
   */
  resolveImageSrc: (element: ImageElement) => string
  /** Canvas scale factor (CSS pixels per logical element unit). */
  scale: number
  /** Current crop as source fractions. Controlled — caller owns the state. */
  localCrop: { x: number; y: number; w: number; h: number }
  /** Called on every pointer-move while a handle, or the window itself, is held. */
  onLocalCropChange: (next: { x: number; y: number; w: number; h: number }) => void
  /** Called once when the <img> fires onLoad with the source's natural dims. */
  onSrcDimsLoaded: (dims: { width: number; height: number }) => void
  /** Natural dimensions of the source image, if already known. */
  srcDims?: { width: number; height: number }
  /**
   * Called when a press on a handle or on the window is let go, so the host
   * can ignore the click the browser sends after it (§556 M4).
   */
  onDragEnd?: () => void
  /**
   * Draws the window's border and its eight handles inside the overlay. A host
   * that draws them apart, outside a clip the overlay sits in (§586 M4),
   * passes false and renders `CanvasCropHandles` there. Default true. The
   * slide canvas draws the whole overlay in its chrome layer (M3b).
   */
  handles?: boolean
  /**
   * Where the full source is drawn. 'contain' (default): contained in the
   * box. 'current' (M3b): where the picture is drawn on the slide now, at the
   * scale and place the element's crop gives it, past the box, so the window
   * on that crop sits on the box. Draws past the overlay: the host gives it
   * room.
   */
  fit?: 'contain' | 'current'
  /**
   * Called with a layer-reaching press (Cmd on a Mac, Ctrl elsewhere) on the
   * picture outside the window and handles, so the host can reach the layer
   * under it. Absent: such a press is swallowed like any other.
   */
  onLayerPress?: (e: React.PointerEvent<HTMLDivElement>) => void
}

/** What the window's border and handles need: the overlay's props bar the image's. */
export type CanvasCropHandlesProps = Pick<
  CanvasCropOverlayProps,
  'element' | 'scale' | 'localCrop' | 'onLocalCropChange' | 'srcDims' | 'onDragEnd' | 'fit'
>

// The window in box pixels and the press that drags it or one of its handles.
// The overlay and the handles each hold one, so a host may draw the handles
// apart from the image: each press is measured on its own from where it began.
function useCropWindow({ element, scale, localCrop, onLocalCropChange, srcDims, onDragEnd, fit = 'contain' }: CanvasCropHandlesProps) {
  const wrapperW = element.w * scale
  const wrapperH = element.h * scale

  // Where the full source is drawn, in box pixels.
  const rendered = !srcDims
    ? null
    : fit === 'current'
      ? drawnSourceRect({ w: wrapperW, h: wrapperH }, element.crop, srcDims)
      : renderedSourceRect({ wrapperW, wrapperH, srcWidth: srcDims.width, srcHeight: srcDims.height })
  const windowPx = rendered ? fractionToWrapperPx({ crop: localCrop, rendered }) : null

  // What is held: a handle (resizes the window) or the window itself ('move',
  // §556 M4: pans it at its size, kept inside the image). Every move is
  // measured from where the press began.
  const dragStateRef = React.useRef<{
    handle: CropHandle | 'move'
    startClient: { x: number; y: number }
    startCrop: CropFraction
  } | null>(null)

  const onPointerDown = (handle: CropHandle | 'move', e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStateRef.current = {
      handle,
      startClient: { x: e.clientX, y: e.clientY },
      startCrop: localCrop,
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag) return
    // A mouse that moves with no button held has lost its release (the window
    // lost the mouse mid-drag, as when the person switches apps). The drag ends
    // where it is, as a release would end it.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      onPointerUp()
      return
    }
    if (!srcDims || !rendered) return
    const deltaPx = { x: e.clientX - drag.startClient.x, y: e.clientY - drag.startClient.y }
    const geometry = { wrapperW, wrapperH, srcWidth: srcDims.width, srcHeight: srcDims.height, rendered }
    onLocalCropChange(
      drag.handle === 'move'
        ? translateCropPx({ crop: drag.startCrop, deltaPx, ...geometry })
        : applyCropHandleDrag({ handle: drag.handle, initialCrop: drag.startCrop, deltaPx, ...geometry }),
    )
  }

  const onPointerUp = () => {
    if (!dragStateRef.current) return
    dragStateRef.current = null
    onDragEnd?.()
  }

  /** The pointer handlers for a press on `handle`, or on the window ('move'). */
  const press = (handle: CropHandle | 'move') => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => onPointerDown(handle, e),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onLostPointerCapture: onPointerUp,
  })

  return { rendered, windowPx, press }
}

/**
 * The crop window's border and its eight handles, in pixels of the image's box:
 * draw them in a box of the image's size and place. They take the pointer
 * themselves; the rest lets it through.
 */
export function CanvasCropHandles(props: CanvasCropHandlesProps) {
  const { windowPx, press } = useCropWindow(props)
  if (!windowPx) return null
  return (
    <>
      {/* Crop window border */}
      <div
        data-testid="crop-window"
        style={{
          position: 'absolute',
          left: windowPx.x,
          top: windowPx.y,
          width: windowPx.w,
          height: windowPx.h,
          outline: '2px solid var(--editor-selection)',
          pointerEvents: 'none',
        }}
      />

      {/* 8 resize handles */}
      {CROP_HANDLES.map((handle) => {
        const o = HANDLE_OFFSET[handle]
        return (
          <div
            key={handle}
            data-testid={`crop-handle-${handle}`}
            {...press(handle)}
            style={{
              position: 'absolute',
              left: windowPx.x + o.dx * windowPx.w - 6,
              top: windowPx.y + o.dy * windowPx.h - 6,
              width: 12,
              height: 12,
              backgroundColor: '#fff',
              border: '2px solid var(--editor-selection)',
              borderRadius: 2,
              boxShadow: '0 1px 3px rgba(0,0,0,0.45)',
              boxSizing: 'border-box',
              cursor: o.cursor,
              zIndex: 10,
              pointerEvents: 'auto',
              touchAction: 'none',
            }}
          />
        )
      })}
    </>
  )
}

export function CanvasCropOverlay({
  element,
  resolveImageSrc,
  scale,
  localCrop,
  onLocalCropChange,
  onSrcDimsLoaded,
  srcDims,
  onDragEnd,
  handles = true,
  fit = 'contain',
  onLayerPress,
}: CanvasCropOverlayProps) {
  const srcUrl = resolveImageSrc(element)
  const windowProps = { element, scale, localCrop, onLocalCropChange, srcDims, onDragEnd, fit }
  const { rendered, windowPx, press } = useCropWindow(windowProps)
  // 'current' draws the image area over the whole picture as drawn (M3b); it
  // loads unseen, filling the box, until its size is known.
  const at = fit === 'current' ? rendered : null
  const areaStyle: React.CSSProperties = at
    ? { left: at.offsetX, top: at.offsetY, width: at.width, height: at.height }
    : { inset: 0 }
  // The window's corners in pixels of the image area.
  const hole = windowPx && { x: windowPx.x - (at?.offsetX ?? 0), y: windowPx.y - (at?.offsetY ?? 0), w: windowPx.w, h: windowPx.h }

  // Only the image area clips: the handles at its edge stay whole (§586 M4).
  return (
    <div
      style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}
      onPointerDown={(e) => {
        e.stopPropagation()
        if (onLayerPress && e.target === e.currentTarget && isLayerPress(e)) {
          e.preventDefault()
          onLayerPress(e)
        }
      }}
    >
      <div data-testid="crop-image-area" style={{ position: 'absolute', ...areaStyle, overflow: 'hidden', pointerEvents: 'none' }}>
        {/* Letterbox preview of the full source image, or the picture as drawn */}
        <img
          src={srcUrl}
          alt="Crop source"
          onLoad={(e) => {
            const img = e.currentTarget
            onSrcDimsLoaded({ width: img.naturalWidth, height: img.naturalHeight })
          }}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            visibility: fit === 'current' && !at ? 'hidden' : undefined,
            pointerEvents: 'none',
          }}
        />

        {hole && (
          /* Dark dimming mask outside the crop window */
          <div
            data-testid="crop-dim"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.55)',
              clipPath: `polygon(
                0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                ${hole.x}px ${hole.y}px,
                ${hole.x}px ${hole.y + hole.h}px,
                ${hole.x + hole.w}px ${hole.y + hole.h}px,
                ${hole.x + hole.w}px ${hole.y}px,
                ${hole.x}px ${hole.y}px
              )`,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {windowPx && (
        /* The window itself: drag it to move it. Under the handles. */
        <div
          data-testid="crop-move"
          {...press('move')}
          style={{
            position: 'absolute',
            left: windowPx.x,
            top: windowPx.y,
            width: windowPx.w,
            height: windowPx.h,
            cursor: 'move',
            zIndex: 5,
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
        />
      )}

      {handles && <CanvasCropHandles {...windowProps} />}
    </div>
  )
}
