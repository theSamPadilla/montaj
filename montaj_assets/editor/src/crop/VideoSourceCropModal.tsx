import * as React from 'react'
import { Crop, RectangleHorizontal, RectangleVertical, Square } from 'lucide-react'
import type { VisualItem } from '../schema'
import {
  renderedSourceRect,
  fractionToWrapperPx,
  applyCropHandleDrag,
  aspectLockedCornerResize,
  translateCropPx,
  type CropFraction,
  type CropHandle,
} from './crop-math'

// Crop-proper modal for a tracks[0] video item. Its ONLY job is choosing which
// rectangle of the SOURCE footage to keep (`sourceCrop`). Positioning and zoom of
// the clip on the output canvas are NOT here — those are direct-manipulation
// transforms on the preview (drag + resize handles), the same as overlays.
//
// Controls: drag the crop window to move it; drag handles to resize. "Free" gives
// 8-handle free-form resize; the aspect presets lock the crop's shape (corner
// handles only, aspect maintained). Commits `sourceCrop` on Apply; Cancel discards.

const FREE_HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']
const CORNER_HANDLES: CropHandle[] = ['nw', 'ne', 'sw', 'se']
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

// Shape locks for the crop rectangle (not output framing). `aspect` is the crop's
// pixel width/height; null = free-form.
type ShapeKey = 'free' | '1:1' | '16:9' | '9:16'
const SHAPES: { key: ShapeKey; label: string; aspect: number | null; Icon: typeof Crop }[] = [
  { key: 'free', label: 'Free', aspect: null,   Icon: Crop },
  { key: '1:1',  label: '1:1',  aspect: 1,      Icon: Square },
  { key: '16:9', label: '16:9', aspect: 16 / 9, Icon: RectangleHorizontal },
  { key: '9:16', label: '9:16', aspect: 9 / 16, Icon: RectangleVertical },
]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
function clampFraction(c: CropFraction): CropFraction {
  const x = clamp01(c.x)
  const y = clamp01(c.y)
  return { x, y, w: Math.min(1 - x, Math.max(0, c.w)), h: Math.min(1 - y, Math.max(0, c.h)) }
}
const cropCenter = (c: CropFraction) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 })

export type VideoSourceCropModalProps = {
  item: VisualItem
  /** Resolve the clip's preview URL — `(item) => adapter.fileUrl(item.nobg_preview_src ?? item.normalizedSrc ?? item.src)`. */
  resolveSrc: (item: VisualItem) => string
  /** Commit the final crop (source fractions). */
  onApply: (next: CropFraction) => void
  /** Persist source intrinsic dims once known (when the item doesn't carry them). */
  onSrcDimsLoaded: (dims: { width: number; height: number }) => void
  /** Close without committing. */
  onClose: () => void
}

export function VideoSourceCropModal({
  item,
  resolveSrc,
  onApply,
  onSrcDimsLoaded,
  onClose,
}: VideoSourceCropModalProps) {
  const srcUrl = resolveSrc(item)

  const [loadedDims, setLoadedDims] = React.useState<{ width: number; height: number } | null>(null)
  const srcDims =
    item.sourceWidth && item.sourceHeight
      ? { width: item.sourceWidth, height: item.sourceHeight }
      : loadedDims

  const [crop, setCrop] = React.useState<CropFraction>(item.sourceCrop ?? DEFAULT_CROP)
  const [shape, setShape] = React.useState<ShapeKey>('free')

  const frameRef = React.useRef<HTMLDivElement>(null)
  const [frameBox, setFrameBox] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 })
  React.useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => setFrameBox({ w: entry.contentRect.width, h: entry.contentRect.height }))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const rendered =
    srcDims && frameBox.w > 0 && frameBox.h > 0
      ? renderedSourceRect({ wrapperW: frameBox.w, wrapperH: frameBox.h, srcWidth: srcDims.width, srcHeight: srcDims.height })
      : null
  const windowPx = rendered ? fractionToWrapperPx({ crop, rendered }) : null

  const aspectOf = (k: ShapeKey) => SHAPES.find(s => s.key === k)?.aspect ?? null
  const lockedAspect = aspectOf(shape)

  function selectShape(key: ShapeKey) {
    const aspect = aspectOf(key)
    setShape(key)
    if (aspect == null || !srcDims) return // free: keep current crop
    // Snap the current crop to the locked aspect, keeping its center; derive height
    // from width so the crop's pixel aspect matches, then clamp into bounds.
    const srcAspect = srcDims.width / srcDims.height
    const center = cropCenter(crop)
    let w = crop.w
    let h = (w * srcAspect) / aspect
    if (h > 1) { h = 1; w = (aspect * h) / srcAspect }
    if (w > 1) { w = 1; h = (w * srcAspect) / aspect }
    const x = Math.min(1 - w, Math.max(0, center.x - w / 2))
    const y = Math.min(1 - h, Math.max(0, center.y - h / 2))
    setCrop({ x, y, w, h })
  }

  // ── Pointer drag: pan (inside window) + resize (handles) ──
  const drag = React.useRef<
    | { kind: 'pan'; startClient: { x: number; y: number }; startCrop: CropFraction }
    | { kind: 'handle'; handle: CropHandle; startClient: { x: number; y: number }; startCrop: CropFraction }
    | null
  >(null)

  const onPanDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { kind: 'pan', startClient: { x: e.clientX, y: e.clientY }, startCrop: crop }
  }
  const onHandleDown = (handle: CropHandle) => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { kind: 'handle', handle, startClient: { x: e.clientX, y: e.clientY }, startCrop: crop }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || !srcDims) return
    const deltaPx = { x: e.clientX - d.startClient.x, y: e.clientY - d.startClient.y }
    const common = { wrapperW: frameBox.w, wrapperH: frameBox.h, srcWidth: srcDims.width, srcHeight: srcDims.height }
    if (d.kind === 'pan') {
      setCrop(translateCropPx({ crop: d.startCrop, deltaPx, ...common }))
    } else if (lockedAspect != null && (d.handle === 'nw' || d.handle === 'ne' || d.handle === 'sw' || d.handle === 'se')) {
      setCrop(aspectLockedCornerResize({ handle: d.handle, initialCrop: d.startCrop, deltaPx, aspect: lockedAspect, ...common }))
    } else {
      setCrop(clampFraction(applyCropHandleDrag({ handle: d.handle, initialCrop: d.startCrop, deltaPx, ...common })))
    }
  }
  const onPointerUp = () => { drag.current = null }

  const handles = lockedAspect != null ? CORNER_HANDLES : FREE_HANDLES
  const ready = !!rendered && !!windowPx

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-6"
      onPointerDown={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col gap-4 rounded-xl border border-[var(--editor-border)] bg-[var(--editor-surface)] p-5 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--editor-text)]">Crop source</h2>
          <span className="text-xs text-[var(--editor-text)]/50">Pick the part of the footage to keep — position &amp; zoom live on the canvas</span>
        </div>

        {/* Source frame + crop window */}
        <div
          ref={frameRef}
          className="relative w-full overflow-hidden rounded-lg bg-black"
          style={{ height: '56vh' }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <video
            src={srcUrl}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              const dims = { width: v.videoWidth, height: v.videoHeight }
              setLoadedDims(dims)
              onSrcDimsLoaded(dims)
            }}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
          />

          {ready && windowPx && (
            <>
              <div
                style={{
                  position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', pointerEvents: 'none',
                  clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                    ${windowPx.x}px ${windowPx.y}px,
                    ${windowPx.x}px ${windowPx.y + windowPx.h}px,
                    ${windowPx.x + windowPx.w}px ${windowPx.y + windowPx.h}px,
                    ${windowPx.x + windowPx.w}px ${windowPx.y}px,
                    ${windowPx.x}px ${windowPx.y}px)`,
                }}
              />
              <div
                onPointerDown={onPanDown}
                style={{
                  position: 'absolute', left: windowPx.x, top: windowPx.y, width: windowPx.w, height: windowPx.h,
                  outline: '2px solid var(--editor-selection)', cursor: 'move', touchAction: 'none',
                }}
              />
              {handles.map((handle) => {
                const o = HANDLE_OFFSET[handle]
                return (
                  <div
                    key={handle}
                    data-testid={`crop-handle-${handle}`}
                    onPointerDown={onHandleDown(handle)}
                    style={{
                      position: 'absolute',
                      left: windowPx.x + o.dx * windowPx.w - 6,
                      top: windowPx.y + o.dy * windowPx.h - 6,
                      width: 12, height: 12, backgroundColor: '#fff',
                      border: '1.5px solid var(--editor-selection)', borderRadius: 2,
                      cursor: o.cursor, zIndex: 10, touchAction: 'none',
                    }}
                  />
                )
              })}
            </>
          )}
        </div>

        {/* Shape locks (constrain the crop rectangle; not output framing) */}
        <div className="flex items-center gap-2">
          {SHAPES.map(({ key, label, Icon }) => {
            const active = shape === key
            return (
              <button
                key={key}
                onClick={() => selectShape(key)}
                title={key === 'free' ? 'Free-form crop' : `Lock crop to ${label}`}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'border-[var(--editor-selection)] bg-[var(--editor-selection)]/15 text-[var(--editor-text)]'
                    : 'border-[var(--editor-border)] text-[var(--editor-text)]/70 hover:text-[var(--editor-text)]'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            )
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--editor-text)]/70 hover:text-[var(--editor-text)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { onApply(clampFraction(crop)); onClose() }}
            disabled={!ready}
            className="rounded-md bg-[var(--editor-accent)] px-3.5 py-1.5 text-xs font-medium text-[var(--editor-accent-foreground)] hover:opacity-90 disabled:opacity-40 transition-colors"
          >
            Apply crop
          </button>
        </div>
      </div>
    </div>
  )
}
