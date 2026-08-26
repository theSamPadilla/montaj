import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from './utils'
import { inspectorInputClass } from './input'

/**
 * `stepValue` — the arithmetic behind ONE stepper click: nudge `value` by one
 * `step` in `direction`, clamp to `[min, max]`, then round away the float noise
 * the nudge itself introduces (`1.2 + 0.01` is `1.2100000000000002`, and a
 * stepper is supposed to be exact).
 *
 * Exported and separate from the component because a stepper's arithmetic is
 * NOT always the input's own `step`/`min`/`max`: the Transform panel's Scale
 * box displays a PERCENTAGE (bounded 5–400) while its stepper nudges the
 * stored multiplier (`0.01`, floored at `0.01`). The component therefore
 * delegates stepping to its caller (see {@link NumberFieldProps.onStep}) and
 * callers share this helper, rather than the component guessing which unit the
 * nudge is in and every call site re-deriving the same three lines.
 *
 * Rounds to 2 decimal places, matching what the panel DISPLAYS — a stepper that
 * lands on a value the box then rounds off would drift a little further from
 * the shown number on every click.
 */
export function stepValue(
  value: number,
  direction: 1 | -1,
  { step, min, max }: { step: number; min?: number; max?: number },
): number {
  let next = value + direction * step
  if (min !== undefined) next = Math.max(min, next)
  if (max !== undefined) next = Math.min(max, next)
  return Math.round(next * 100) / 100
}

export interface NumberFieldProps {
  /** The control's ACCESSIBLE name — the box's `aria-label`, and the stem of
   *  both stepper labels (`Increase ${name}` / `Decrease ${name}`). Kept
   *  deliberately separate from any visible label the caller renders beside
   *  the field: accessible names are a behavioural contract that tests and
   *  assistive tech both depend on, so visible chrome can be restyled without
   *  touching them. */
  name: string
  /** The live value. Owned by the caller — this component is controlled and
   *  holds no value state of its own beyond the mid-typing `draft` below.
   *
   *  A STRING is allowed, and `''` specifically means "no explicit value": the
   *  box reads blank and its {@link NumberFieldProps.placeholder} reports
   *  whatever default is actually in force. That is not the same as zero, and
   *  a field that showed the default as a real value would invite the operator
   *  to save a value they never chose. */
  value: number | string
  /** Live-preview a typed edit: fired on EVERY keystroke that parses to a
   *  finite number. Empty, a lone `-`, and anything else unparseable are
   *  swallowed here rather than by each caller — mid-typing states are not
   *  edits and must not reach an undo stack or a save. */
  onPreview: (value: number) => void
  /** Close the typing gesture — ONE undo entry for the whole run of keystrokes,
   *  carrying the last value {@link NumberFieldProps.onPreview} emitted.
   *
   *  Fired on blur, and on Enter via that same blur, but ONLY when the gesture
   *  actually previewed something: focusing a field and leaving it untouched
   *  writes nothing, because that would be a pointless save and an undo entry
   *  for a no-op. That guard is also what stops Enter-then-blur from
   *  committing twice.
   *
   *  Takes the value even though some callers ignore it: a zero-argument
   *  handler is assignable to this signature, so the wider shape serves both
   *  the callers that close over their own last-previewed value and the ones
   *  that want the number handed to them. */
  onCommit: (value: number) => void
  /** One DISCRETE nudge — the caller is expected to emit one final edit (one
   *  undo entry), NOT a preview/commit pair. Omit to render no steppers.
   *  Takes a direction rather than a value because the nudge's unit is the
   *  caller's business; see {@link stepValue}. */
  onStep?: (direction: 1 | -1) => void
  /** Native `step`/`min`/`max` for the box.
   *
   *  These drive the browser's own validation and native spinner ONLY. A TYPED
   *  value is deliberately NOT clamped against them, for two reasons: clamping
   *  between keystrokes fights the operator (typing `0.5` into a `min={1}` box
   *  passes through `0`, and `5` into a `max={400}` one passes through `5` on
   *  the way to `500`), and the two call sites disagree about whether a typed
   *  value should be bounded at all — the Transform panel's opacity row lets a
   *  typed `5` through where the caption panel's line height clamps `9` to
   *  `2.5`. So the component stays dumb and emits the raw parsed number; a
   *  caller that wants a bounded write clamps inside its own `onPreview`.
   *  The STEPPERS always clamp — that arithmetic is {@link stepValue}'s. */
  step?: number
  min?: number
  max?: number
  /** Shown when the box is blank. An empty string is meaningful and is
   *  rendered as a real empty `placeholder` attribute — a caller whose default
   *  has no value to report needs the attribute present and empty, not absent. */
  placeholder?: string
  /** Visible leading axis marker (`X`, `Y`). Purely decorative and hidden from
   *  assistive tech — the accessible name already carries the axis. */
  prefix?: string
  /** Visible trailing unit (`%`, `px`, `em`). Decorative, same reasoning. */
  unit?: string
  /** Passed through so a caller can wire a `<label htmlFor>` to the box. */
  id?: string
  /** Sizing/alignment override for the `<input>` itself (the wrapper's layout
   *  is fixed). Merged over {@link inspectorInputClass} via `cn`. */
  className?: string
  /** Disables the box AND its steppers together — a caller never wants one
   *  live while the other is dead (e.g. ClipPropertiesPanel's ducking
   *  depth/attack/release, inert until the Ducking switch is on). Styled the
   *  same `opacity-50 cursor-not-allowed` treatment ClipPropertiesPanel's
   *  `DraftField` already uses for its own disabled fields, so a disabled
   *  number box reads identically wherever it appears. */
  disabled?: boolean
}

/**
 * `<NumberField>` — the editor's ONE compact number control: a typeable box
 * with up/down steppers, an optional axis prefix and unit, and the two-phase
 * preview/commit typing gesture.
 *
 * `draft` is the fix for a real bug, and the main reason this is a component
 * rather than a bare `<input>`. Panels that host these fields re-render on
 * every playback tick (~60Hz) whether or not the thing being edited is even
 * involved, and a CONTROLLED input whose `value` comes straight from the
 * tick-recomputed prop has no memory of what is mid-typed — typing into a
 * field while the timeline played back got silently overwritten between
 * keystrokes. `draft` breaks that link: it goes non-null the moment the
 * operator types (first `onChange`) and stays the single source of truth for
 * what is ON SCREEN until blur/Enter commits it, so ticks arriving mid-edit
 * change `value` underneath without ever touching what is displayed. While
 * `draft` is null (the common case — not currently being typed into) the field
 * tracks `value` live, exactly as an uncontrolled-feeling box should,
 * including the desired case of watching it animate during scrub/playback.
 *
 * Purely presentational and controlled: it never parses meaning out of the
 * number, never decides what a step is worth, never bounds what is typed, and
 * never reaches into a store. Keyframe diamonds, align buttons and row labels
 * belong to the caller.
 */
export function NumberField({
  name,
  value,
  onPreview,
  onCommit,
  onStep,
  step,
  min,
  max,
  placeholder,
  prefix,
  unit,
  id,
  className,
  disabled,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  // Whether this typing gesture previewed anything worth committing, and what
  // the last such preview was. A ref, not state: neither changes what is
  // rendered, and a re-render between the keystroke and the blur would be the
  // very tick `draft` exists to survive.
  //
  // Dirty-based rather than comparing the incoming `value` prop against
  // `last.current`: live preview has ALREADY written the pending number into
  // the project by the time blur fires (that is the whole point of
  // `onPreview`), so by blur `value` typically equals the pending value
  // anyway. A value-comparison guard ("only commit if it changed") would read
  // that as nothing to do and skip the commit entirely — silently losing an
  // edit that every caller believes it already made. `dirty` asks the
  // question this component can actually answer honestly: did a keystroke
  // happen, not does the prop look different yet.
  const dirty = useRef(false)
  const last = useRef(0)
  const shown = draft ?? String(value)

  function handleChange(raw: string) {
    setDraft(raw)
    // Mid-typing states (empty field, a lone minus, an unparseable fragment)
    // are not edits — hold the draft on screen but emit nothing, and leave the
    // gesture un-armed so blurring out of one commits nothing either.
    if (raw.trim() === '') return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    dirty.current = true
    last.current = parsed
    onPreview(parsed)
  }

  function commit() {
    // Releasing the draft is unconditional — a box left blank or unparseable
    // has to snap back to the value the project actually holds rather than sit
    // there misreporting it. Committing is not: see `onCommit`'s contract.
    setDraft(null)
    if (!dirty.current) return
    dirty.current = false
    onCommit(last.current)
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {prefix && (
        <span aria-hidden="true" className="w-2 shrink-0 text-[10px] text-[var(--editor-text)]/40">
          {prefix}
        </span>
      )}
      <input
        id={id}
        type="number"
        aria-label={name}
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        value={shown}
        disabled={disabled}
        onChange={e => handleChange(e.target.value)}
        onBlur={commit}
        // Enter closes the typing gesture the same way blur does — it does not
        // duplicate the commit logic, just triggers the same onBlur path.
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className={cn(inspectorInputClass, 'text-right disabled:opacity-50 disabled:cursor-not-allowed', className)}
      />
      {unit && (
        <span aria-hidden="true" className="text-[10px] text-[var(--editor-text)]/40">
          {unit}
        </span>
      )}
      {onStep && <Stepper name={name} onStep={onStep} disabled={disabled} />}
    </div>
  )
}

/** Up/down nudge buttons for one number box. Each click is a DISCRETE edit —
 *  one final change, one undo entry — not a preview/commit pair.
 *
 *  `disabled` rides along from the box: a disabled input with live arrows
 *  next to it would let the operator nudge a value the box itself refuses to
 *  show as editable, so the buttons carry the SAME native `disabled`
 *  attribute (which already blocks both the click and any keyboard
 *  activation — no separate pointer-events/aria bookkeeping needed) rather
 *  than only being dimmed for show. */
function Stepper({ name, onStep, disabled }: { name: string; onStep: (direction: 1 | -1) => void; disabled?: boolean }) {
  const btn = cn(
    'flex h-3 w-4 items-center justify-center rounded-sm text-[var(--editor-text)]/45 transition-colors',
    disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]',
  )
  return (
    <div className="flex shrink-0 flex-col gap-px">
      <button type="button" aria-label={`Increase ${name}`} onClick={() => onStep(1)} disabled={disabled} className={btn}>
        <ChevronUp size={9} />
      </button>
      <button type="button" aria-label={`Decrease ${name}`} onClick={() => onStep(-1)} disabled={disabled} className={btn}>
        <ChevronDown size={9} />
      </button>
    </div>
  )
}
