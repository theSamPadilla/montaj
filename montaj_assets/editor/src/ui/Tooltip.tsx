import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A small dark pill that appears instantly on hover — the editor's replacement
 * for native `title=` on toolbar buttons, which browsers delay ~1s and render
 * in OS chrome nobody notices.
 *
 * ── Why a portal ─────────────────────────────────────────────────────────
 * The tool buttons live inside containers that clip: the timeline's zoom row
 * sits above an `overflow-x-auto` scroller (which computes `overflow-y` to
 * `auto`, so it clips vertically too), and the editor body is `overflow-hidden`.
 * An absolutely-positioned pill inside the trigger would be cut off by both.
 * Rendering into `document.body` at fixed coordinates measured from the
 * trigger sidesteps every ancestor's overflow.
 *
 * The trigger is wrapped in an `inline-flex` span rather than cloned, so the
 * wrapper becomes the flex item in the toolbar row and the button inside keeps
 * its own box untouched. Pass `className` to move layout utilities that used
 * to sit on the button (e.g. `mr-auto`) onto the wrapper.
 */
export interface TooltipProps {
  /** Terse label — "Undo", "Split at playhead". Not a sentence. */
  label: string
  /** Optional shortcut chips rendered after the label, e.g. `['⌘', 'Z']`. */
  keys?: string[]
  /** Which side of the trigger the pill sits on. */
  side?: 'top' | 'bottom'
  /** Layout classes for the wrapper span (it is the flex item, not the child). */
  className?: string
  children: ReactNode
}

/** Gap in px between the trigger's edge and the pill. */
const OFFSET_PX = 6
/** Keeps the pill from hanging off either edge of the window. */
const VIEWPORT_MARGIN_PX = 4

interface Position {
  x: number
  y: number
  side: 'top' | 'bottom'
}

export function Tooltip({ label, keys, side = 'top', className, children }: TooltipProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)

  const show = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      x: rect.left + rect.width / 2,
      y: side === 'top' ? rect.top - OFFSET_PX : rect.bottom + OFFSET_PX,
      side,
    })
  }, [side])

  const hide = useCallback(() => setPosition(null), [])

  // Measured after paint, once the pill has a width: a button near the right
  // edge of the window would otherwise render a centred pill that overflows.
  // Clamping here (rather than at `show`) is what lets it use the real width.
  useLayoutEffect(() => {
    if (!position) return
    const pill = pillRef.current
    if (!pill) return
    const half = pill.offsetWidth / 2
    const min = VIEWPORT_MARGIN_PX + half
    const max = window.innerWidth - VIEWPORT_MARGIN_PX - half
    if (max < min) return
    const clamped = Math.max(min, Math.min(max, position.x))
    if (clamped !== position.x) setPosition({ ...position, x: clamped })
  }, [position])

  return (
    <span
      ref={wrapperRef}
      className={className ? `inline-flex ${className}` : 'inline-flex'}
      onMouseEnter={show}
      onMouseLeave={hide}
      // A click that opens a modal (or disables the button) leaves the pill
      // orphaned with no `mouseleave` to follow, so dismiss on press too.
      onMouseDown={hide}
      // Keyboard users get the same affordance; `focusout` covers tabbing away.
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {position && typeof document !== 'undefined' && createPortal(
        <div
          ref={pillRef}
          role="tooltip"
          className="pointer-events-none fixed z-[100] flex items-center gap-1 whitespace-nowrap rounded border border-[var(--editor-border)] bg-[var(--editor-surface)] px-1.5 py-1 text-[10px] leading-none text-[var(--editor-text)] shadow-lg"
          style={{
            left: position.x,
            top: position.y,
            transform: `translate(-50%, ${position.side === 'top' ? '-100%' : '0'})`,
          }}
        >
          <span>{label}</span>
          {keys?.map((k, i) => (
            <kbd
              key={i}
              className="rounded border border-[var(--editor-border)] bg-[var(--editor-text)]/10 px-1 py-0.5 font-mono text-[9px] leading-none text-[var(--editor-text)]/70"
            >
              {k}
            </kbd>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
}

export default Tooltip
