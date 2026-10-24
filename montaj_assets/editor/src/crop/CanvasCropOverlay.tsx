import * as React from 'react'
import type { ImageElement } from '../types'
import {
  renderedSourceRect,
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
}: CanvasCropOverlayProps) {
  const srcUrl = resolveImageSrc(element)

  const wrapperW = element.w * scale
  const wrapperH = element.h * scale

  const rendered = srcDims
    ? renderedSourceRect({ wrapperW, wrapperH, srcWidth: srcDims.width, srcHeight: srcDims.height })
    : null
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
    if (!srcDims) return
    const deltaPx = { x: e.clientX - drag.startClient.x, y: e.clientY - drag.startClient.y }
    const geometry = { wrapperW, wrapperH, srcWidth: srcDims.width, srcHeight: srcDims.height }
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

  return (
    <div
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'auto' }}
      onPointerDown={(e) => {
        e.stopPropagation()
      }}
    >
      {/* Letterbox preview of the full source image */}
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
          pointerEvents: 'none',
        }}
      />

      {windowPx && (
        <>
          {/* Dark dimming mask outside the crop window */}
          <div
            data-testid="crop-dim"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.55)',
              clipPath: `polygon(
                0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                ${windowPx.x}px ${windowPx.y}px,
                ${windowPx.x}px ${windowPx.y + windowPx.h}px,
                ${windowPx.x + windowPx.w}px ${windowPx.y + windowPx.h}px,
                ${windowPx.x + windowPx.w}px ${windowPx.y}px,
                ${windowPx.x}px ${windowPx.y}px
              )`,
              pointerEvents: 'none',
            }}
          />

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

          {/* The window itself: drag it to move it. Under the handles. */}
          <div
            data-testid="crop-move"
            onPointerDown={(e) => onPointerDown('move', e)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onLostPointerCapture={onPointerUp}
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

          {/* 8 resize handles */}
          {CROP_HANDLES.map((handle) => {
            const o = HANDLE_OFFSET[handle]
            return (
              <div
                key={handle}
                data-testid={`crop-handle-${handle}`}
                onPointerDown={(e) => onPointerDown(handle, e)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onLostPointerCapture={onPointerUp}
                style={{
                  position: 'absolute',
                  left: windowPx.x + o.dx * windowPx.w - 6,
                  top: windowPx.y + o.dy * windowPx.h - 6,
                  width: 12,
                  height: 12,
                  backgroundColor: '#fff',
                  border: '1.5px solid var(--editor-selection)',
                  borderRadius: 2,
                  cursor: o.cursor,
                  zIndex: 10,
                  pointerEvents: 'auto',
                  touchAction: 'none',
                }}
              />
            )
          })}
        </>
      )}
    </div>
  )
}
