import { useRef } from 'react'
import { cn } from './utils'

export interface SliderProps {
  /** The live value. Owned by the caller — this control is fully controlled. */
  value: number
  min: number
  max: number
  step?: number
  /** Live-preview a drag/keyboard adjustment: fired on EVERY change, no undo
   *  entry, no save. Named `onChange` rather than `onPreview` because a caller
   *  that wants no two-phase gesture at all (a local scrub, say) simply omits
   *  {@link SliderProps.onCommit} and this is its only callback. */
  onChange: (value: number) => void
  /** Close the gesture — one undo entry for the whole drag. Fired at most ONCE
   *  per gesture, and only when the gesture actually moved something; see the
   *  `dirty` ref below. Omit for a slider whose changes are already final (or
   *  are purely local view state).
   *
   *  Takes the value even though some callers ignore it: a zero-argument
   *  handler is assignable to this signature, so the wider shape serves both
   *  the callers that close over their own last-previewed value and the ones
   *  that want the number handed to them. */
  onCommit?: (value: number) => void
  /** Accessible name. Required — the control has no visible text of its own,
   *  and every call site sits beside a separate label element rather than
   *  inside one. */
  'aria-label': string
  /** Passed through so a caller can wire a `<label htmlFor>` to the input. */
  id?: string
  /** Sizing override. Defaults to full width; a flex-row caller typically
   *  passes `min-w-0 flex-1`. */
  className?: string
  disabled?: boolean
}

/**
 * Track + thumb chrome. Split out as a constant so the comment explaining WHY
 * it looks like this isn't wedged into the middle of the JSX.
 *
 * `appearance-none` strips the platform slider, after which Chrome/Safari take
 * the track styling off the INPUT itself (hence `h-1` + `bg-` + `rounded-full`
 * on the element) while Firefox needs `::-moz-range-track` said separately.
 * The thumb has to be restated per engine for the same reason — there is no
 * cross-engine selector for it, and a bare `accent-color` cannot produce the
 * thin-track/round-thumb pairing at all: it colors the platform widget, whose
 * track thickness and thumb shape are not ours to set.
 *
 * Every color is a `--editor-*` var, never a literal, so the control follows
 * the host's light/dark theme like the rest of the editor chrome. The accent
 * var is Montaj's indigo in both themes (see theme.ts), which is where the
 * indigo thumb comes from.
 */
const SLIDER_CLASS = cn(
  'h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--editor-border)] outline-none',
  'focus-visible:ring-1 focus-visible:ring-[var(--editor-accent)]',
  'disabled:cursor-not-allowed disabled:opacity-50',
  // WebKit/Blink: track is the element, thumb is the pseudo-element.
  '[&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0',
  '[&::-webkit-slider-thumb]:bg-[var(--editor-accent)] [&::-webkit-slider-thumb]:cursor-grab',
  // Gecko: both track and thumb are pseudo-elements.
  '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--editor-border)]',
  '[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full',
  '[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--editor-accent)] [&::-moz-range-thumb]:cursor-grab',
)

/**
 * `<Slider>` — the editor's ONE horizontal range control.
 *
 * Previews per change and commits ONCE per gesture: `dirty` arms on the first
 * change and is disarmed by whichever gesture-end fires first, so the pointerup
 * that is immediately followed by a blur cannot stack two undo entries onto the
 * same drag. `onKeyUp` is in that set so a keyboard adjustment commits too, and
 * a gesture that never changed anything commits nothing at all — a stray click
 * on the track's current position must not spend an undo entry on a no-op.
 *
 * Still a native `<input type="range">` underneath, deliberately: it is
 * keyboard-operable, exposes `role="slider"` with correct value semantics, and
 * handles pointer capture for free. Only its LOOK is replaced.
 */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  'aria-label': ariaLabel,
  id,
  className,
  disabled,
}: SliderProps) {
  const dirty = useRef(false)
  // The last value actually previewed, so `end` reports what the caller saw
  // rather than re-reading the DOM (blur's target is the input, but so is a
  // programmatic one — the ref is simply the value we know we emitted).
  const last = useRef(value)

  function end() {
    if (!dirty.current) return
    dirty.current = false
    onCommit?.(last.current)
  }

  return (
    <input
      id={id}
      type="range"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={e => {
        const next = Number(e.target.value)
        dirty.current = true
        last.current = next
        onChange(next)
      }}
      onPointerUp={end}
      onKeyUp={end}
      onBlur={end}
      className={cn(SLIDER_CLASS, className)}
    />
  )
}
