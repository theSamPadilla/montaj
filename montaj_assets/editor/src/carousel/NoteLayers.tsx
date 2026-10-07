import { useState, type CSSProperties, type RefObject } from 'react'
import type { SlidePin, SlidePinDisplay } from '../types'

// Note layers over the interactive slide canvas (PL70), passed to SlideCanvas
// as its children so they sit inside the slide box and position themselves in
// percentages of the slide. Sizes are display pixels: the layers are not
// scaled with the slide.

/** True when a pin carries a usable point (both coordinates finite). */
export function hasPoint(pin: SlidePin): pin is SlidePin & { x: number; y: number } {
  return typeof pin.x === 'number' && Number.isFinite(pin.x) && typeof pin.y === 'number' && Number.isFinite(pin.y)
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
// Rounded so 1 - 0.7 reads 30%, not 30.000000000000004%.
const pct = (v: number) => `${Math.round(clamp01(v) * 1e6) / 1e4}%`

const BADGE = 18
const PILL_PAD = 2
const PILL_BORDER = 1
/** From a pill's outer corner to its badge's centre, which sits on the point. */
const PILL_ANCHOR = PILL_BORDER + PILL_PAD + BADGE / 2
const DARK_TEXT = '#030712'
const REVIEW_AMBER = '#f5b544'
/** Past this x a pin opens to the left, so its text stays on the slide. */
const OPEN_LEFT_PAST = 0.6
/** Two points this close (fractions of the slide) would put their chips on top of each other. */
const CROWD_X = 0.12
const CROWD_Y = 0.06
/** Words a chip carries; it shows as many as fit and ends in an ellipsis. */
const CHIP_WORDS = 20
const CARET_CLASS = 'montaj-note-caret'
const CARET_CSS =
  `@keyframes montajNoteCaret{0%,49%{opacity:1}50%,100%{opacity:0}}` +
  `.${CARET_CLASS}{animation:montajNoteCaret 1.06s step-end infinite}` +
  `@media (prefers-reduced-motion: reduce){.${CARET_CLASS}{animation:none}}`

function badgeColor(tone: string | undefined): string {
  return tone === 'review' ? REVIEW_AMBER : 'var(--editor-accent)'
}

function pinName(pin: SlidePin): string {
  const text = pin.text?.trim()
  if (pin.label && text) return `${pin.label}: ${text}`
  return pin.label || text || 'Note'
}

/** Pins whose chips would overlap another pin's: a simple box around each point. */
function crowdedIds(pins: ReadonlyArray<SlidePin & { x: number; y: number }>): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i]
      const b = pins[j]
      if (Math.abs(a.x - b.x) < CROWD_X && Math.abs(a.y - b.y) < CROWD_Y) {
        out.add(a.id)
        out.add(b.id)
      }
    }
  }
  return out
}

type PinForm = 'badge' | 'chip' | 'full'

/**
 * The selected slide's pinned notes. At rest each is a badge, a circle with
 * the pin's `label`; with `pinDisplay="chip"` the badge carries the note's
 * first words in a pill; the host's `active` pin shows its whole text (a
 * caret while it is empty). Past x 0.6 a pin opens to the left. A chip
 * crowded by another pin shows its badge until hovered. The badge's centre
 * is the pin's point. The layer lets the pointer through; only the pins take
 * it. A pin click never reaches the canvas, so it neither deselects nor
 * starts a drag.
 */
export function NotePinLayer({
  pins,
  onPinClick,
  pinDisplay = 'badge',
}: {
  pins: Array<SlidePin & { x: number; y: number }>
  onPinClick?: (id: string) => void
  pinDisplay?: SlidePinDisplay
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const crowded = pinDisplay === 'chip' ? crowdedIds(pins) : new Set<string>()
  const anyActive = pins.some((p) => p.active)

  return (
    <div data-note-pins="" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }}>
      {anyActive && <style>{CARET_CSS}</style>}
      {pins.map((pin) => {
        const text = pin.text?.trim() ? pin.text : ''
        const form: PinForm = pin.active
          ? 'full'
          : pinDisplay === 'chip' && text && (!crowded.has(pin.id) || hoveredId === pin.id)
            ? 'chip'
            : 'badge'
        const opensLeft = pin.x > OPEN_LEFT_PAST
        const pill = form !== 'badge'
        const name = pinName(pin)
        const anchor = pill ? PILL_ANCHOR : BADGE / 2

        // Longhands only where a form changes them, so a hover that turns a
        // badge into a chip never mixes a shorthand with its own longhands.
        const pad = pill ? PILL_PAD : 0
        const style: CSSProperties = {
          position: 'absolute',
          top: pct(pin.y),
          marginTop: -anchor,
          ...(opensLeft ? { right: pct(1 - pin.x), marginRight: -anchor } : { left: pct(pin.x), marginLeft: -anchor }),
          display: 'flex',
          flexDirection: opensLeft ? 'row-reverse' : 'row',
          alignItems: 'flex-start',
          gap: 5,
          width: 'max-content',
          maxWidth: form === 'full' ? 220 : form === 'chip' ? 150 : undefined,
          paddingTop: pad,
          paddingBottom: pad,
          paddingLeft: pill && opensLeft ? 8 : pad,
          paddingRight: pill && !opensLeft ? 8 : pad,
          borderRadius: pill ? 12 : '50%',
          border: !pill ? 'none' : `${PILL_BORDER}px solid ${form === 'full' ? 'var(--editor-accent)' : 'rgba(255, 255, 255, 0.18)'}`,
          backgroundColor: pill ? 'rgba(3, 7, 18, 0.82)' : 'transparent',
          backdropFilter: pill ? 'blur(4px)' : undefined,
          WebkitBackdropFilter: pill ? 'blur(4px)' : undefined,
          boxShadow: pill ? '0 2px 8px rgba(0, 0, 0, 0.35)' : undefined,
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          pointerEvents: 'auto',
          userSelect: 'none',
          zIndex: form === 'full' ? 3 : hoveredId === pin.id ? 2 : 1,
        }

        return (
          <button
            key={pin.id}
            type="button"
            data-pin-id={pin.id}
            data-tone={pin.tone}
            data-pin-form={form}
            data-pin-opens={opensLeft ? 'left' : 'right'}
            aria-label={name}
            title={name}
            onClick={(e) => { e.stopPropagation(); onPinClick?.(pin.id) }}
            onPointerEnter={() => setHoveredId(pin.id)}
            onPointerLeave={() => setHoveredId((id) => (id === pin.id ? null : id))}
            onFocus={() => setHoveredId(pin.id)}
            onBlur={() => setHoveredId((id) => (id === pin.id ? null : id))}
            style={style}
          >
            <span
              data-pin-badge=""
              style={{
                flexShrink: 0,
                width: BADGE,
                height: BADGE,
                borderRadius: '50%',
                backgroundColor: badgeColor(pin.tone),
                color: DARK_TEXT,
                boxShadow: '0 0 0 1.5px #fff, 0 1px 3px rgba(0, 0, 0, 0.4)',
                fontSize: 10,
                fontWeight: 700,
                lineHeight: `${BADGE}px`,
                textAlign: 'center',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {pin.label}
            </span>
            {form === 'chip' && (
              <span
                data-pin-text=""
                style={{
                  minWidth: 0,
                  color: '#fff',
                  fontSize: 11.5,
                  lineHeight: `${BADGE}px`,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}
              >
                {text.trim().split(/\s+/).slice(0, CHIP_WORDS).join(' ')}
              </span>
            )}
            {form === 'full' && (
              text ? (
                <span
                  data-pin-text=""
                  style={{
                    minWidth: 0,
                    color: '#fff',
                    fontSize: 11.5,
                    lineHeight: `${BADGE}px`,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {text}
                </span>
              ) : (
                <span
                  data-pin-caret=""
                  aria-hidden="true"
                  className={CARET_CLASS}
                  style={{ alignSelf: 'center', width: 1.5, height: 13, backgroundColor: '#fff' }}
                />
              )
            )}
          </button>
        )
      })}
    </div>
  )
}

// The armed cursor: an arrow with a small note chip, hotspot at the arrow's
// tip. A browser that cannot draw it shows a crosshair.
const ARM_CURSOR_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>` +
  `<path d='M2 2 L2 18.5 L6.4 14.4 L9.4 21 L12.1 19.8 L9.2 13.4 L15 13.4 Z' fill='${DARK_TEXT}' stroke='#fff' stroke-width='1.5' stroke-linejoin='round'/>` +
  `<rect x='13.5' y='19.5' width='17' height='10' rx='5' fill='${DARK_TEXT}' stroke='#fff' stroke-width='1.2'/>` +
  `<circle cx='18.5' cy='24.5' r='2.6' fill='#fff'/>` +
  `<rect x='22.5' y='23.7' width='5.5' height='1.6' rx='0.8' fill='#fff'/>` +
  `</svg>`
const ARM_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ARM_CURSOR_SVG)}") 2 2, crosshair`

/** While a note is armed: the note cursor over the whole slide, taking the
 *  next click and reporting it as fractions of the slide box (the slide is
 *  drawn at one uniform scale, so these are fractions of its design size too). */
export function NoteArmLayer({ onPlace, layerRef }: { onPlace: (point: { x: number; y: number }) => void; layerRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={layerRef}
      data-testid="note-arm-layer"
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: ARM_CURSOR, zIndex: 30 }}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
      onClick={(e) => {
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onPlace({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
      }}
    />
  )
}
