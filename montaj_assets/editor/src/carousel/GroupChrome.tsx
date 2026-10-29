import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { buildElementTransform, type ResizeHandle } from '../gestures'
import { HANDLE_LOOK, HANDLE_SIZE, HitPad, KNOB_LOOK, OUTLINE, ROTATE_KNOB, ROTATE_OFFSET } from './chromeStyle'

// A selected group's box on the canvas (§587): the box its members cover, with
// the resize and rotate handles one element has, in the same look. A locked
// group shows the lock badge instead. It lives in the slide's chrome layer;
// only the handles and the badge take the pointer.

const LOCK_BADGE_SIZE = 24

const HANDLES: { id: ResizeHandle; cursor: string; xPct: number; yPct: number }[] = [
  { id: 'nw', cursor: 'nwse-resize', xPct: 0, yPct: 0 },
  { id: 'n', cursor: 'ns-resize', xPct: 0.5, yPct: 0 },
  { id: 'ne', cursor: 'nesw-resize', xPct: 1, yPct: 0 },
  { id: 'e', cursor: 'ew-resize', xPct: 1, yPct: 0.5 },
  { id: 'se', cursor: 'nwse-resize', xPct: 1, yPct: 1 },
  { id: 's', cursor: 'ns-resize', xPct: 0.5, yPct: 1 },
  { id: 'sw', cursor: 'nesw-resize', xPct: 0, yPct: 1 },
  { id: 'w', cursor: 'ew-resize', xPct: 0, yPct: 0.5 },
]

export interface GroupChromeProps {
  box: { x: number; y: number; w: number; h: number }
  scale: number
  /** The box's own div: a gesture writes its place straight to it, as to an element's. */
  boxRef: RefObject<HTMLDivElement | null>
  locked: boolean
  /** Whether the group can be resized and turned here; false draws the box alone. */
  handles: boolean
  onResizeStart: (handle: ResizeHandle, e: ReactPointerEvent) => void
  onRotateStart: (e: ReactPointerEvent) => void
  /** The lock badge's click. Absent → no badge. */
  onUnlock?: () => void
  /** A right-press: it starts nothing here. */
  isMenuPress: (e: ReactPointerEvent) => boolean
  /** A click on the badge ends here (its press did what it does). */
  onBadgeClick?: () => void
}

export default function GroupChrome({ box, scale, boxRef, locked, handles, onResizeStart, onRotateStart, onUnlock, isMenuPress, onBadgeClick }: GroupChromeProps) {
  const press = (start: (e: ReactPointerEvent) => void) => (e: ReactPointerEvent) => {
    if (isMenuPress(e)) return
    e.preventDefault()
    e.stopPropagation()
    start(e)
  }
  return (
    <div
      ref={boxRef}
      data-group-chrome=""
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: box.w * scale,
        height: box.h * scale,
        transform: buildElementTransform(box.x, box.y, scale, 0),
        transformOrigin: 'center center',
        outline: `${OUTLINE} solid var(--editor-selection)`,
        pointerEvents: 'none',
      }}
    >
      {locked && onUnlock && (
        <button
          type="button"
          data-testid="lock-badge"
          aria-label="Unlock"
          title="Unlock"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onBadgeClick?.(); onUnlock() }}
          style={{
            position: 'absolute',
            top: -LOCK_BADGE_SIZE / 2 - 2,
            right: -LOCK_BADGE_SIZE / 2 - 2,
            width: LOCK_BADGE_SIZE,
            height: LOCK_BADGE_SIZE,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            background: 'var(--editor-surface)',
            border: '1.5px solid var(--editor-selection)',
            borderRadius: '50%',
            color: 'var(--editor-selection)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
            cursor: 'pointer',
            zIndex: 10,
            pointerEvents: 'auto',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </button>
      )}
      {!locked && handles && (
        <>
          {HANDLES.map((h) => (
            <div
              key={h.id}
              data-testid={`group-resize-handle-${h.id}`}
              onPointerDown={press((e) => onResizeStart(h.id, e))}
              style={{
                position: 'absolute',
                left: `${h.xPct * 100}%`,
                top: `${h.yPct * 100}%`,
                marginLeft: -HANDLE_SIZE / 2,
                marginTop: -HANDLE_SIZE / 2,
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                ...HANDLE_LOOK,
                cursor: h.cursor,
                zIndex: 10,
                pointerEvents: 'auto',
                touchAction: 'none',
              }}
            >
              <HitPad />
            </div>
          ))}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              marginLeft: -1,
              top: -ROTATE_OFFSET,
              width: 2,
              height: ROTATE_OFFSET,
              background: 'var(--editor-selection)',
              pointerEvents: 'none',
              zIndex: 9,
            }}
          />
          <div
            data-testid="group-rotate-handle"
            title="Drag to rotate"
            onPointerDown={press(onRotateStart)}
            style={{
              position: 'absolute',
              left: '50%',
              marginLeft: -ROTATE_KNOB / 2,
              top: -ROTATE_OFFSET - ROTATE_KNOB,
              width: ROTATE_KNOB,
              height: ROTATE_KNOB,
              ...KNOB_LOOK,
              cursor: 'crosshair',
              zIndex: 10,
              pointerEvents: 'auto',
              touchAction: 'none',
            }}
          />
        </>
      )}
    </div>
  )
}
