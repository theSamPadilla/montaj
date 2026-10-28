// The on-canvas mask gizmo (§616 U2): a selected video or image clip's mask,
// drawn over the clip and edited by hand.
//
//   - the outline: timeline-core's `maskPolygon`, the export's own polygon
//     (a wipe: its edge line, clipped to the box);
//   - dashed rings 2 sigma outside and inside it when feathered (a wipe: two
//     lines parallel to its edge);
//   - crop-style squares on the mask box's corners and edge midpoints (resize
//     about the centre), a round handle above the top edge (rotate), and a
//     round handle on the outer ring (feather);
//   - the area inside the outline moves the mask (a wipe: its edge line).
//
// It draws in BOX PIXELS: the SVG's viewBox is the clip's box in preview
// pixels (`0 0 boxW boxH`, as `maskSvg` uses), laid over an element whose box
// is the clip's box. Strokes are non-scaling; the HTML handles counter-scale
// by the scale their parent draws them at, as the clip's own handles do, so
// they stay 12 px squares at any clip scale. The geometry is
// `maskGizmoMath.ts`.
//
// It holds no mask state. Each gesture reports its changes as it goes
// (`onPreview`, so the host can draw the clip's mask live) and once on release
// (`onCommit`), and the host commits that through `applyOverlayChanges`, the
// path every preview gesture takes: writeProp keys an animated prop at the
// playhead and writes the static `mask` field otherwise.
//
// Hit priority: every part that takes the pointer stops the press there, so a
// press inside the outline or on a handle never reaches the clip's own move.
// Outside the outline nothing here takes the pointer, and the clip moves.

import { useRef, type CSSProperties } from 'react'
import { maskPolygon } from '@bycrux/timeline-core'
import type { OverlayCommitOptions } from './useDragOverlay'
import {
  featherRings,
  maskGestureChanges,
  maskHandles,
  pointsAttr,
  wipeLine,
  type MaskChanges,
  type MaskGesture,
  type MaskHandle,
  type Pt,
  type ResolvedMask,
} from './maskGizmoMath'

// The selection token, as the clip's own outline and handles use it
// (OverlayItemsLayer's SELECTION, PreviewPlayer's base-clip box). Through the
// CSS `style` prop on SVG, never a presentation attribute: `var()` resolves
// only in the cascade.
const SELECTION = 'var(--editor-selection)'
const HANDLE_PX = 12

/** The crop handle's face: a white square with a selection-coloured border. */
const SQUARE_FACE: CSSProperties = {
  width: HANDLE_PX,
  height: HANDLE_PX,
  backgroundColor: '#fff',
  border: `1.5px solid ${SELECTION}`,
  borderRadius: 2,
}
/** The rotate handle: the same, round. */
const ROTATE_FACE: CSSProperties = { ...SQUARE_FACE, borderRadius: '50%' }
/** The feather handle: round, filled with the selection colour, a white rim. */
const FEATHER_FACE: CSSProperties = { ...SQUARE_FACE, backgroundColor: SELECTION, border: '1.5px solid #fff', borderRadius: '50%' }

const RESIZE_CURSOR: Record<MaskHandle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
}

/** The invisible grab width along a wipe's edge line, px. */
const WIPE_GRAB_PX = 16

export interface MaskGizmoProps {
  /** The mask at the playhead, every field resolved (`maskAt`), live changes included. */
  mask: ResolvedMask
  /** The clip's box in preview pixels. */
  boxW: number
  boxH: number
  /**
   * The scale the gizmo's parent draws it at: the clip wrapper's
   * `scale(scaleX, scaleY)` in OverlayItemsLayer, 1 where the parent is the
   * box at its own size (the base clip's box in PreviewPlayer). The handles
   * counter-scale by it.
   */
  scaleX: number
  scaleY: number
  /** A client point in box pixels (`clientToBox`), or null when the frame cannot be measured. */
  toBox: (client: Pt) => Pt | null
  /** Each pointer move of a gesture, with the changes so far. */
  onPreview: (changes: MaskChanges) => void
  /** Once, on release (or a lost pointer), with the gesture's changes. */
  onCommit: (changes: MaskChanges, options: OverlayCommitOptions) => void
}

export default function MaskGizmo({ mask, boxW, boxH, scaleX, scaleY, toBox, onPreview, onCommit }: MaskGizmoProps) {
  // The press in flight: what is held, the mask when it began, where it began
  // (box pixels), and the last changes it reported.
  const pressRef = useRef<{ gesture: MaskGesture; start: ResolvedMask; from: Pt; last: MaskChanges | null } | null>(null)

  const end = (changes: MaskChanges | null, altKey: boolean) => {
    pressRef.current = null
    if (changes) onCommit(changes, { shiftAnimation: altKey })
  }

  /** The pointer handlers for a press on `gesture`'s part. */
  const press = (gesture: MaskGesture) => ({
    onPointerDown: (e: React.PointerEvent<Element>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const from = toBox({ x: e.clientX, y: e.clientY })
      if (!from) return
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      pressRef.current = { gesture, start: mask, from, last: null }
    },
    onPointerMove: (e: React.PointerEvent<Element>) => {
      const p = pressRef.current
      if (!p) return
      const to = toBox({ x: e.clientX, y: e.clientY })
      if (!to) return
      p.last = maskGestureChanges(p.gesture, p.start, p.from, to, boxW, boxH)
      onPreview(p.last)
    },
    onPointerUp: (e: React.PointerEvent<Element>) => {
      const p = pressRef.current
      if (!p) return
      // A press that never moved changes nothing and commits nothing.
      const to = p.last && toBox({ x: e.clientX, y: e.clientY })
      end(to ? maskGestureChanges(p.gesture, p.start, p.from, to, boxW, boxH) : p.last, e.altKey)
    },
    // The pointer went away mid-drag: the gesture ends where it is.
    onPointerCancel: () => { if (pressRef.current) end(pressRef.current.last, false) },
    onLostPointerCapture: () => { if (pressRef.current) end(pressRef.current.last, false) },
    // The clip's own move listens for mousedown on its wrapper.
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  })

  const wipe = mask.shape === 'wipe'
  const outline = wipe ? wipeLine(mask, boxW, boxH) : maskPolygon(mask, boxW, boxH)
  const rings = featherRings(mask, boxW, boxH)
  const handles = maskHandles(mask, boxW, boxH)

  // A handle centred on box point `at`. `left`/`top` are % of the box; the
  // origin is pinned there, and `scale` is outside `translate` so the parent's
  // scale cancels out of both the size and the centring (see OverlayItemsLayer's
  // ResizeHandle). It turns with the mask.
  const placed = (at: [number, number], face: CSSProperties, cursor: string): CSSProperties => ({
    ...face,
    position: 'absolute',
    left: `${(at[0] / boxW) * 100}%`,
    top: `${(at[1] / boxH) * 100}%`,
    padding: 0,
    margin: 0,
    transformOrigin: '0 0',
    transform: `scale(${1 / scaleX}, ${1 / scaleY}) rotate(${mask.rotation}deg) translate(-50%, -50%)`,
    cursor,
    pointerEvents: 'auto',
    touchAction: 'none',
  })

  const line = (seg: Array<[number, number]>) => ({ x1: seg[0][0], y1: seg[0][1], x2: seg[1][0], y2: seg[1][1] })
  const stroke = { stroke: SELECTION }

  return (
    <div data-mask-gizmo="" className="absolute inset-0 pointer-events-none">
      {/* The outline, the rings and the move area: under the clip's own
          handles (z 50), so they stay reachable where the two overlap. */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 40 }}>
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${boxW} ${boxH}`}
          preserveAspectRatio="none"
          overflow="visible"
          style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}
        >
          {outline && (wipe ? (
            <line
              {...line(outline)}
              role="button"
              aria-label="Move mask"
              stroke="transparent"
              strokeWidth={WIPE_GRAB_PX}
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: 'stroke', cursor: 'move', touchAction: 'none' }}
              {...press('move')}
            />
          ) : (
            <polygon
              points={pointsAttr(outline)}
              role="button"
              aria-label="Move mask"
              fill="transparent"
              style={{ pointerEvents: 'fill', cursor: 'move', touchAction: 'none' }}
              {...press('move')}
            />
          ))}
          {rings.map((ring, i) => (wipe ? (
            <line key={i} data-testid="mask-feather-ring" {...line(ring)} fill="none" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} vectorEffect="non-scaling-stroke" style={stroke} />
          ) : (
            <polygon key={i} data-testid="mask-feather-ring" points={pointsAttr(ring)} fill="none" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} vectorEffect="non-scaling-stroke" style={stroke} />
          )))}
          {outline && (wipe ? (
            <line data-testid="mask-outline" {...line(outline)} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={stroke} />
          ) : (
            <polygon data-testid="mask-outline" points={pointsAttr(outline)} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={stroke} />
          ))}
          {handles.rotate.stalkFrom && (
            <line {...line([handles.rotate.stalkFrom, handles.rotate.at])} strokeWidth={1} vectorEffect="non-scaling-stroke" style={stroke} />
          )}
        </svg>
      </div>
      {/* The handles: above the clip's own, so the mask's win where they meet. */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 60 }}>
        {handles.resize.map(({ handle, at }) => (
          <button
            key={handle}
            type="button"
            aria-label="Resize mask"
            data-mask-handle={handle}
            style={placed(at, SQUARE_FACE, RESIZE_CURSOR[handle])}
            {...press(`resize-${handle}`)}
          />
        ))}
        <button type="button" aria-label="Rotate mask" data-mask-handle="rotate" style={placed(handles.rotate.at, ROTATE_FACE, 'grab')} {...press('rotate')} />
        <button type="button" aria-label="Mask feather" data-mask-handle="feather" style={placed(handles.feather.at, FEATHER_FACE, 'ew-resize')} {...press('feather')} />
      </div>
    </div>
  )
}
