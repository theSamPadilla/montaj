import * as React from 'react'
import type { ImageElement } from '../types'
import {
  renderedSourceRect,
  fractionToWrapperPx,
  applyCropHandleDrag,
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
  /** Called on every pointer-move while a handle is held. */
  onLocalCropChange: (next: { x: number; y: number; w: number; h: number }) => void
  /** Called once when the <img> fires onLoad with the source's natural dims. */
  onSrcDimsLoaded: (dims: { width: number; height: number }) => void
  /** Natural dimensions of the source image, if already known. */
  srcDims?: { width: number; height: number }
}

export function CanvasCropOverlay({
  element,
  resolveImageSrc,
  scale,
  localCrop,
  onLocalCropChange,
  onSrcDimsLoaded,
  srcDims,
}: CanvasCropOverlayProps) {
  const srcUrl = resolveImageSrc(element)

  const wrapperW = element.w * scale
  const wrapperH = element.h * scale

  const rendered = srcDims
    ? renderedSourceRect({ wrapperW, wrapperH, srcWidth: srcDims.width, srcHeight: srcDims.height })
    : null
  const windowPx = rendered ? fractionToWrapperPx({ crop: localCrop, rendered }) : null

  const dragStateRef = React.useRef<{
    handle: CropHandle
    startClient: { x: number; y: number }
    startCrop: { x: number; y: number; w: number; h: number }
  } | null>(null)

  const onHandlePointerDown = (handle: CropHandle, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStateRef.current = {
      handle,
      startClient: { x: e.clientX, y: e.clientY },
      startCrop: localCrop,
    }
  }

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || !srcDims) return
    const dx = e.clientX - drag.startClient.x
    const dy = e.clientY - drag.startClient.y
    const next = applyCropHandleDrag({
      handle: drag.handle,
      initialCrop: drag.startCrop,
      deltaPx: { x: dx, y: dy },
      wrapperW,
      wrapperH,
      srcWidth: srcDims.width,
      srcHeight: srcDims.height,
    })
    onLocalCropChange(next)
  }

  const onHandlePointerUp = () => {
    dragStateRef.current = null
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
              outline: '2px solid var(--color-accent-pink)',
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
                onPointerDown={(e) => onHandlePointerDown(handle, e)}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                style={{
                  position: 'absolute',
                  left: windowPx.x + o.dx * windowPx.w - 6,
                  top: windowPx.y + o.dy * windowPx.h - 6,
                  width: 12,
                  height: 12,
                  backgroundColor: '#fff',
                  border: '1.5px solid var(--color-accent-pink)',
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
