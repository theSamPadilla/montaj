import * as React from 'react'
import type { VisualItem } from '../schema'
import {
  renderedSourceRect,
  fractionToWrapperPx,
  applyCropHandleDrag,
  type CropFraction,
  type CropHandle,
} from './crop-math'

// Sibling of CanvasCropOverlay, typed to a tracks[0] VisualItem (video) instead
// of an ImageElement. The full source clip is letterboxed into the preview via a
// muted <video>, an 8-handle free-form crop window is drawn on top, and handle
// drags emit the updated `sourceCrop` as source fractions clamped to [0, 1].
//
// Source dims come either from the item (sourceWidth/sourceHeight, set on a prior
// crop) or from the <video>'s videoWidth/videoHeight on loadedmetadata — exactly
// analogous to CanvasCropOverlay reading naturalWidth/Height from <img> onLoad.

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

const DEFAULT_CROP: CropFraction = { x: 0, y: 0, w: 1, h: 1 }

function clampFraction(c: CropFraction): CropFraction {
  const x = Math.min(1, Math.max(0, c.x))
  const y = Math.min(1, Math.max(0, c.y))
  return {
    x,
    y,
    w: Math.min(1 - x, Math.max(0, c.w)),
    h: Math.min(1 - y, Math.max(0, c.h)),
  }
}

export type VideoSourceCropOverlayProps = {
  /** The tracks[0] video item being cropped. */
  item: VisualItem
  /**
   * Host-supplied resolver for the clip's preview URL. Implement on the caller
   * side as `(item) => adapter.fileUrl(item.nobg_preview_src ?? item.src)`.
   */
  resolveSrc: (item: VisualItem) => string
  /** Wrapper width in CSS px (the rect the overlay fills — the preview area). */
  wrapperWidth: number
  /** Wrapper height in CSS px. */
  wrapperHeight: number
  /** Called once on pointer-up (drag end) with the final clamped [0,1] fractions. */
  onChange: (next: CropFraction) => void
  /** Called once when the <video> fires loadedmetadata with the source's intrinsic dims. */
  onSrcDimsLoaded: (dims: { width: number; height: number }) => void
}

export function VideoSourceCropOverlay({
  item,
  resolveSrc,
  wrapperWidth,
  wrapperHeight,
  onChange,
  onSrcDimsLoaded,
}: VideoSourceCropOverlayProps) {
  const srcUrl = resolveSrc(item)

  // Local mirror of dims loaded from the <video> when the item doesn't already
  // carry them, so the crop window renders as soon as metadata arrives.
  const [loadedDims, setLoadedDims] = React.useState<{ width: number; height: number } | null>(null)
  const srcDims =
    item.sourceWidth && item.sourceHeight
      ? { width: item.sourceWidth, height: item.sourceHeight }
      : loadedDims

  // Prop-driven crop (source of truth when not dragging)
  const propCrop = item.sourceCrop ?? DEFAULT_CROP

  // In-flight drag crop — non-null only during an active handle drag.
  // While dragging, the rendered window follows this local state for smoothness.
  // On pointer-up it's cleared after calling onChange once with the final value.
  const [liveCrop, setLiveCrop] = React.useState<CropFraction | null>(null)
  // Ref mirror so onHandlePointerUp always reads the latest value regardless of closure age.
  const liveCropRef = React.useRef<CropFraction | null>(null)

  // The crop we actually render: live state during drag, props otherwise.
  const localCrop = liveCrop ?? propCrop

  const rendered =
    srcDims && wrapperWidth > 0 && wrapperHeight > 0
      ? renderedSourceRect({
          wrapperW: wrapperWidth,
          wrapperH: wrapperHeight,
          srcWidth: srcDims.width,
          srcHeight: srcDims.height,
        })
      : null
  const windowPx = rendered ? fractionToWrapperPx({ crop: localCrop, rendered }) : null

  const dragStateRef = React.useRef<{
    handle: CropHandle
    startClient: { x: number; y: number }
    startCrop: CropFraction
  } | null>(null)

  const onHandlePointerDown = (handle: CropHandle, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragStateRef.current = {
      handle,
      startClient: { x: e.clientX, y: e.clientY },
      startCrop: propCrop,
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
      wrapperW: wrapperWidth,
      wrapperH: wrapperHeight,
      srcWidth: srcDims.width,
      srcHeight: srcDims.height,
    })
    // Accumulate in local state for smooth visual feedback — do NOT call onChange yet.
    const clamped = clampFraction(next)
    liveCropRef.current = clamped
    setLiveCrop(clamped)
  }

  const onHandlePointerUp = () => {
    const drag = dragStateRef.current
    dragStateRef.current = null
    const final = liveCropRef.current
    liveCropRef.current = null
    setLiveCrop(null)
    if (drag && final !== null) {
      // Call onChange exactly once with the final value.
      onChange(final)
    }
  }

  return (
    <div
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'auto' }}
      onPointerDown={(e) => {
        e.stopPropagation()
      }}
    >
      {/* Letterbox preview of the full source clip */}
      <video
        src={srcUrl}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          const dims = { width: v.videoWidth, height: v.videoHeight }
          setLoadedDims(dims)
          onSrcDimsLoaded(dims)
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
