import type { Ref } from 'react'
import type { SlidePin } from '../types'

// Note layers over the interactive slide canvas (PL70), passed to SlideCanvas
// as its children so they sit inside the slide box and position themselves in
// percentages of the slide. Deliberately plain: a host restyles pins later.

/** True when a pin carries a usable point (both coordinates finite). */
export function hasPoint(pin: SlidePin): pin is SlidePin & { x: number; y: number } {
  return typeof pin.x === 'number' && Number.isFinite(pin.x) && typeof pin.y === 'number' && Number.isFinite(pin.y)
}

const pct = (v: number) => `${Math.min(1, Math.max(0, v)) * 100}%`

/** The selected slide's pinned notes, as small circles. The layer lets the
 *  pointer through; only the pins take it. A pin click never reaches the
 *  canvas, so it neither deselects nor starts a drag. */
export function NotePinLayer({ pins, onPinClick }: { pins: Array<SlidePin & { x: number; y: number }>; onPinClick?: (id: string) => void }) {
  return (
    <div data-note-pins="" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }}>
      {pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          data-pin-id={pin.id}
          data-tone={pin.tone}
          aria-label={pin.label ?? 'Note'}
          title={pin.label ?? 'Note'}
          onClick={(e) => { e.stopPropagation(); onPinClick?.(pin.id) }}
          style={{
            position: 'absolute',
            left: pct(pin.x),
            top: pct(pin.y),
            width: 14,
            height: 14,
            padding: 0,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            border: '2px solid #fff',
            background: 'var(--editor-accent)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        />
      ))}
    </div>
  )
}

/** While a note is armed: a crosshair over the whole slide that takes the next
 *  click and reports it as fractions of the slide box (the slide is drawn at
 *  one uniform scale, so these are fractions of its design size too). */
export function NoteArmLayer({ onPlace, layerRef }: { onPlace: (point: { x: number; y: number }) => void; layerRef?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={layerRef}
      data-testid="note-arm-layer"
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: 'crosshair', zIndex: 30 }}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
      onClick={(e) => {
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onPlace({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
      }}
    />
  )
}
