import { useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Diamond,
  Link2,
  RotateCcw,
} from 'lucide-react'
import type { KeyframeProp, VisualItem } from '../schema'
import {
  disableKeyframing,
  enableKeyframing,
  hasKeyframes,
  removeKeyframe,
  setKeyframe,
  trackFor,
  valueAt,
} from './keyframeOps'
import { usePlaybackTime, type PlaybackClock } from './playback-clock'
import { cn, inspectorInputClass } from '../ui'

/**
 * `<OverlayInspector>` — the editor's contextual right-hand **Transform**
 * properties panel for the selected overlay. One collapsible section holding
 * the five keyframeable transform props (offsetX/offsetY/scale/rotation/
 * opacity) as a scale slider + X/Y boxes, a position pair, a rotation box
 * with a circular dial, an opacity box, and a six-button align row — plus a
 * per-property keyframe unit (`‹ ◇ ›`) and an all-properties one in the
 * section header.
 *
 * Every control obeys the SAME CapCut-style auto-keyframe rule, factored into
 * {@link writeProp}: editing a prop that's already keyframed drops a keyframe
 * at the playhead instead of overwriting the static scalar; editing an
 * unkeyframed prop writes the scalar. Continuous gestures (typing, slider
 * drag, dial drag) preview per change and commit once when the gesture ends;
 * discrete actions (steppers, align, reset, diamonds) fire one `onChange`.
 *
 * Deliberately the ONLY place opacity is editable at all — the preview's drag
 * gestures (useDragOverlay) cover offset/scale/rotation but never opacity, so
 * without this panel opacity could never be keyframed either.
 *
 * Props-driven and host-agnostic, like the rest of this package: it never
 * reaches into a store. All persistence flows back through the three
 * callbacks, which the host (VideoEditor) wires to its own sync core.
 */
export interface OverlayInspectorProps {
  /** The single selected item, or null. Non-overlay items and null both
   *  render the empty state — the component enforces its own "overlay only"
   *  contract rather than trusting the caller to have already filtered. */
  item: VisualItem | null
  /** The shared playback clock. Subscribed HERE (usePlaybackTime), not by the
   *  caller — so a ~60Hz playhead tick re-renders only this small panel
   *  instead of the whole editor (see playback-clock.ts's doc comment). */
  clock: PlaybackClock
  /** Live-preview a continuously-typed edit: no undo entry, no save yet.
   *  Mirrors OverlayPropsModal's onPreview / VideoEditor's previewOverlayProps. */
  onPreview: (item: VisualItem) => void
  /** Commit the last previewed edit as one undo step + queued save. Fired on
   *  the number input's blur, closing the typing gesture. */
  onCommit: () => void
  /** A discrete, already-final edit — the keyframe diamond toggle. Persisted
   *  immediately; there is no separate blur to commit on. */
  onChange: (item: VisualItem) => void
  /** Move the playhead to an absolute timeline time. Used only by the keyframe
   *  navigation arrows. Optional: a host that hasn't wired seeking yet gets the
   *  arrows rendered but disabled, rather than arrows that silently do nothing. */
  onSeek?: (time: number) => void
}

interface RowSpec {
  prop: KeyframeProp
  /** The control's ACCESSIBLE name (`aria-label` on the number box, and the
   *  `${name}` in every diamond/arrow/stepper label built from this row).
   *  Deliberately separate from the VISIBLE label, which the redesign changed
   *  ("Offset X" is now shown as a `Position` row with an `X` prefix): the
   *  accessible names are the panel's behavioural contract and must not
   *  drift, so the visible chrome can be restyled freely without touching
   *  what assistive tech — or the behaviour tests — see. */
  name: string
  step: number
  min?: number
  max?: number
}

// Offsets/rotation are unbounded (percent of frame / degrees, can go negative
// or past 100/360 for effects); scale only needs a floor above zero; opacity
// is clamped to the 0–1 range the renderer expects.
const ROWS: Record<KeyframeProp, RowSpec> = {
  offsetX:  { prop: 'offsetX',  name: 'Offset X', step: 1 },
  offsetY:  { prop: 'offsetY',  name: 'Offset Y', step: 1 },
  scale:    { prop: 'scale',    name: 'Scale',    step: 0.01, min: 0.01 },
  rotation: { prop: 'rotation', name: 'Rotation', step: 1 },
  opacity:  { prop: 'opacity',  name: 'Opacity',  step: 0.01, min: 0, max: 1 },
}

/** Every prop this panel edits, in the order the header's all-props actions
 *  (reset, keyframe-all) walk them. */
const ALL_PROPS: KeyframeProp[] = ['offsetX', 'offsetY', 'scale', 'rotation', 'opacity']

/** Identity transform. Kept in step with `geometryAt`'s defaults in
 *  `@bycrux/timeline-core` — the same values `valueAt` falls back to when a
 *  prop has neither a track nor a static scalar. */
const DEFAULTS: Record<KeyframeProp, number> = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
}

/** Range the scale SLIDER spans. Wider than a sane layout needs on both ends
 *  so the handle never pins at an edge mid-animation; the number boxes stay
 *  the way to reach a value outside it (they only carry ROWS.scale's floor). */
const SCALE_SLIDER_MIN = 0.05
const SCALE_SLIDER_MAX = 4

/**
 * The single write rule this whole panel obeys. Auto-keyframe: a prop that is
 * already animated gets a NEW keyframe at the playhead, so editing it mid-
 * animation refines the curve instead of silently detaching the value from
 * it; a prop that isn't animated just takes the static scalar.
 *
 * Every control routes through here — typing, slider, dial, steppers, align,
 * reset — so there is exactly one place that decision is made and none of
 * them can drift from the others.
 */
function writeProp(item: VisualItem, prop: KeyframeProp, localT: number, value: number): VisualItem {
  return hasKeyframes(item, prop)
    ? setKeyframe(item, prop, localT, value)
    : { ...item, [prop]: value }
}

/** The offset (percent of frame) that puts the overlay's edge on the frame's
 *  edge for `edge` = -1 (left/top), 0 (center/middle), +1 (right/bottom).
 *  Mirrors useDragOverlay's edge-snap: an overlay at scale >= 1 already covers
 *  the frame, so it has no edge to align to and every alignment collapses to
 *  centered rather than pushing it further off-frame. */
export function alignedOffset(scale: number, edge: -1 | 0 | 1): number {
  const magnitude = Math.max(0, (0.5 - scale / 2) * 100)
  // The `+ 0` normalizes the NEGATIVE zero `-1 * 0` produces at scale >= 1.
  // It renders and serializes identically to 0, but it is not `Object.is`-
  // equal to it, so an item carrying `offsetX: -0` compares unequal to an
  // otherwise-identical one in any structural diff (version compare, undo
  // dedupe) that reaches for strict equality.
  return edge * magnitude + 0
}

// Curve-sampled values can carry float noise (e.g. 29.999999999999996) picked
// up from interpolation. Rounds only what's DISPLAYED — handleInput below
// always reads the raw text the operator typed, never this rounded number.
// The steppers round their RESULT through this too: `1.2 + 0.01` lands on
// 1.2100000000000002 otherwise, and a stepper is supposed to be exact.
function displayValue(value: number): number {
  return Math.round(value * 100) / 100
}

/** Normalize degrees into `[0, 360)`. Matches useDragOverlay's rotate handler
 *  so the dial and the preview's rotate handle agree on what "45 degrees" is. */
function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// ── Shared chrome ────────────────────────────────────────────────────────

const ROW_LABEL_CLASS = 'w-14 shrink-0 text-[11px] text-[var(--editor-text)]/55'
const ICON_BUTTON_CLASS =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--editor-text)]/45 transition-colors hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)] disabled:pointer-events-none disabled:opacity-25'

function IconButton({
  label,
  disabled,
  onClick,
  title,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  title?: string
  children: ReactNode
}) {
  return (
    <button type="button" aria-label={label} title={title} disabled={disabled} onClick={onClick} className={ICON_BUTTON_CLASS}>
      {children}
    </button>
  )
}

interface FieldProps {
  id: string
  /** Accessible name — see RowSpec.name. */
  name: string
  step: number
  min?: number
  max?: number
  /** The prop-derived value for the CURRENT playhead — recomputed on every
   *  ~60Hz tick (see the component doc). Only actually shown while the field
   *  is untouched; see `draft` below. */
  value: number
  onInput: (raw: string) => void
  onCommit: () => void
  className?: string
}

/**
 * One numeric box, split out of the parent so it can hold its OWN `useState`
 * — hooks can't live inside a loop, and each box in the panel needs
 * independent "am I mid-edit" state.
 *
 * `draft` is the fix for a real bug: this whole panel re-renders on every
 * `usePlaybackTime` tick (~60Hz) whether or not `item` is even the thing
 * being edited, and before this fix the input's `value` came straight from
 * the tick-recomputed prop — a CONTROLLED input with no memory of what was
 * mid-typed. Typing into the field while the timeline played back got
 * silently overwritten between keystrokes. `draft` breaks that link: it goes
 * non-null the moment the operator types (first `onChange`) and stays the
 * single source of truth for what's ON SCREEN until blur/Enter commits it,
 * so ticks arriving mid-edit change `value` underneath without ever touching
 * what's displayed. While `draft` is null (the common case — not currently
 * being typed into) the field tracks `value` live, exactly as it always did,
 * including the desired case of watching it animate during scrub/playback.
 *
 * EVERY number box in this panel goes through this component for exactly that
 * reason; a bare `<input>` anywhere here would reintroduce the bug.
 */
function OverlayInspectorField({ id, name, step, min, max, value, onInput, onCommit, className }: FieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(value)

  function commit() {
    setDraft(null)
    onCommit()
  }

  return (
    <input
      id={id}
      type="number"
      aria-label={name}
      step={step}
      min={min}
      max={max}
      value={shown}
      onChange={e => { setDraft(e.target.value); onInput(e.target.value) }}
      onBlur={commit}
      // Enter closes the typing gesture the same way blur does — it does not
      // duplicate the commit logic, just triggers the same onBlur path.
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className={cn(inspectorInputClass, 'text-right', className)}
    />
  )
}

/** Up/down nudge buttons for one number box. Each click is a DISCRETE edit —
 *  one `onChange`, one undo entry — not a preview/commit pair. */
function Stepper({ name, onStep }: { name: string; onStep: (direction: 1 | -1) => void }) {
  const btn =
    'flex h-3 w-4 items-center justify-center rounded-sm text-[var(--editor-text)]/45 transition-colors hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]'
  return (
    <div className="flex shrink-0 flex-col gap-px">
      <button type="button" aria-label={`Increase ${name}`} onClick={() => onStep(1)} className={btn}>
        <ChevronUp size={9} />
      </button>
      <button type="button" aria-label={`Decrease ${name}`} onClick={() => onStep(-1)} className={btn}>
        <ChevronDown size={9} />
      </button>
    </div>
  )
}

interface KeyframeNavProps {
  prevLabel: string
  nextLabel: string
  diamondLabel: string
  pressed: boolean
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
  onDiamond: () => void
}

/** The `‹ ◇ ›` unit: step to the previous/next keyframe, and toggle the
 *  keyframe at the playhead. One component so every row — and the header's
 *  all-props variant — lays out and labels the three controls identically. */
function KeyframeNav({
  prevLabel, nextLabel, diamondLabel, pressed, canPrev, canNext, onPrev, onNext, onDiamond,
}: KeyframeNavProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconButton label={prevLabel} disabled={!canPrev} onClick={onPrev}>
        <ChevronLeft size={11} />
      </IconButton>
      <button
        type="button"
        aria-label={diamondLabel}
        aria-pressed={pressed}
        onClick={onDiamond}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
          pressed
            ? 'text-[var(--editor-accent)]'
            : 'text-[var(--editor-text)]/40 hover:text-[var(--editor-text)]/70',
        )}
      >
        <Diamond size={11} fill={pressed ? 'currentColor' : 'none'} />
      </button>
      <IconButton label={nextLabel} disabled={!canNext} onClick={onNext}>
        <ChevronRight size={11} />
      </IconButton>
    </div>
  )
}

/** The scale slider. Previews per change, commits ONCE per gesture: `dirty`
 *  arms on the first change and is disarmed by whichever gesture-end fires
 *  first, so a pointerup immediately followed by a blur can't stack two undo
 *  entries. `onKeyUp` is in that set so keyboard adjustment commits too. */
function ScaleSlider({ value, onPreview, onCommit }: { value: number; onPreview: (v: number) => void; onCommit: () => void }) {
  const dirty = useRef(false)

  function end() {
    if (!dirty.current) return
    dirty.current = false
    onCommit()
  }

  return (
    <input
      type="range"
      aria-label="Scale slider"
      min={SCALE_SLIDER_MIN}
      max={SCALE_SLIDER_MAX}
      step={0.01}
      value={value}
      onChange={e => { dirty.current = true; onPreview(Number(e.target.value)) }}
      onPointerUp={end}
      onKeyUp={end}
      onBlur={end}
      className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--editor-border)] accent-[var(--editor-accent)]"
    />
  )
}

const DIAL_SIZE_PX = 40
const DIAL_CENTER = DIAL_SIZE_PX / 2
const DIAL_RADIUS = 14

/**
 * A circular rotation dial. 0 degrees points UP and positive is clockwise,
 * matching `rotation`'s "degrees, clockwise" schema comment and the preview's
 * rotate handle.
 *
 * Pointer drags use `setPointerCapture` so a drag that leaves the little
 * 40px box still tracks. Keyboard is the accessible equivalent: arrows nudge
 * 1 degree, Shift+arrow 15.
 */
function RotationDial({
  rotation,
  onPreview,
  onCommit,
  onChange,
}: {
  rotation: number
  onPreview: (deg: number) => void
  onCommit: () => void
  onChange: (deg: number) => void
}) {
  const ref = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)
  const previewed = useRef(false)

  /** Degrees clockwise-from-up under the pointer, or null when the geometry
   *  can't support an angle. jsdom (and any `display:none` ancestor) hands
   *  back a 0x0 rect, and a pointer exactly on the centre has no direction —
   *  both bail rather than emitting a bogus angle. `setKeyframe`'s
   *  `Number.isFinite` guard would catch a NaN, but relying on a downstream
   *  guard to clean up after this one is how a NaN reaches the scalar path,
   *  which has no guard at all. */
  function angleFrom(e: ReactPointerEvent): number | null {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const dx = e.clientX - (rect.left + rect.width / 2)
    const dy = e.clientY - (rect.top + rect.height / 2)
    if (dx === 0 && dy === 0) return null
    const deg = Math.atan2(dx, -dy) * (180 / Math.PI)
    if (!Number.isFinite(deg)) return null
    return normalizeDegrees(deg)
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    dragging.current = true
    previewed.current = false
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const deg = angleFrom(e)
    if (deg === null) return
    previewed.current = true
    onPreview(deg)
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!dragging.current) return
    const deg = angleFrom(e)
    if (deg === null) return
    previewed.current = true
    onPreview(deg)
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    // Only close a gesture that actually previewed something — a click that
    // never produced an angle must not spend an undo entry on nothing.
    if (!previewed.current) return
    previewed.current = false
    onCommit()
  }

  function onKeyDown(e: ReactKeyboardEvent<SVGSVGElement>) {
    const step = e.shiftKey ? 15 : 1
    let delta = 0
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step
    else return
    e.preventDefault()
    onChange(normalizeDegrees(rotation + delta))
  }

  // -90 puts 0 degrees at the top of the SVG; +sin/+cos then sweeps clockwise.
  const rad = ((rotation - 90) * Math.PI) / 180
  const handleX = DIAL_CENTER + Math.cos(rad) * DIAL_RADIUS
  const handleY = DIAL_CENTER + Math.sin(rad) * DIAL_RADIUS

  return (
    <svg
      ref={ref}
      width={DIAL_SIZE_PX}
      height={DIAL_SIZE_PX}
      viewBox={`0 0 ${DIAL_SIZE_PX} ${DIAL_SIZE_PX}`}
      role="slider"
      aria-label="Rotation dial"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(rotation)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className="shrink-0 cursor-grab touch-none select-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-[var(--editor-accent)] active:cursor-grabbing"
    >
      <circle
        cx={DIAL_CENTER}
        cy={DIAL_CENTER}
        r={DIAL_RADIUS + 2}
        fill="var(--editor-surface)"
        stroke="var(--editor-border)"
        strokeWidth={1}
      />
      <line
        x1={DIAL_CENTER}
        y1={DIAL_CENTER}
        x2={handleX}
        y2={handleY}
        stroke="var(--editor-accent)"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <circle cx={handleX} cy={handleY} r={2.5} fill="var(--editor-accent)" />
    </svg>
  )
}

interface NumberCellProps {
  row: RowSpec
  /** Accessible-name override for the second box of a paired row (Scale Y). */
  name?: string
  /** Visible axis prefix. Purely decorative — the accessible name already
   *  carries the axis ("Offset X"), so this is hidden from assistive tech to
   *  avoid reading it twice. */
  prefix?: string
  value: number
  onInput: (raw: string) => void
  onCommit: () => void
  onStep: (direction: 1 | -1) => void
}

/** A number box with its axis prefix and stepper — the panel's repeating unit. */
function NumberCell({ row, name = row.name, prefix, value, onInput, onCommit, onStep }: NumberCellProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {prefix && (
        <span aria-hidden="true" className="w-2 shrink-0 text-[10px] text-[var(--editor-text)]/40">
          {prefix}
        </span>
      )}
      <OverlayInspectorField
        id={`overlay-inspector-${name.replace(/\s+/g, '-').toLowerCase()}`}
        name={name}
        step={row.step}
        min={row.min}
        max={row.max}
        value={displayValue(value)}
        onInput={onInput}
        onCommit={onCommit}
        className="h-7 w-16 px-1.5 text-xs"
      />
      <Stepper name={name} onStep={onStep} />
    </div>
  )
}

const SECTION_CLASS = 'shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden'

export default function OverlayInspector({ item, clock, onPreview, onCommit, onChange, onSeek }: OverlayInspectorProps) {
  // Subscribed unconditionally (hooks can't follow the early return below) —
  // cheap: this component renders nothing else, so a tick that turns out to
  // target a non-overlay/no selection still only re-runs this one function.
  const playhead = usePlaybackTime(clock)
  // Held on the OUTER component so collapsing the section survives a change
  // of selection — the operator's chrome preference, not the item's state.
  const [collapsed, setCollapsed] = useState(false)

  if (!item || item.type !== 'overlay') {
    return (
      <div className={SECTION_CLASS}>
        <div className="px-3 py-6 text-center text-[11px] text-[var(--editor-text)]/45">
          Select an overlay to edit its properties.
        </div>
      </div>
    )
  }

  // A `const` alias so every closure below is narrowed to a non-null overlay
  // without a `!` on each use (TypeScript does not carry a narrowing on a
  // reassignable parameter into a nested function).
  const target = item

  // Clamped to the item's own span, matching `applyKeyframeMove`'s clamp in
  // pointer-machine.ts. This panel renders whenever an overlay is SELECTED,
  // and selecting an item does not move the playhead — so a playhead sitting
  // outside the item's [start, end] (e.g. the overlay was selected while
  // parked elsewhere on the timeline) would otherwise hand `setKeyframe`/
  // `enableKeyframing` a negative or over-long `t`, writing a keyframe
  // outside the span every OTHER keyframe consumer (draw, hit-test,
  // keyframeOps) assumes points stay within.
  const localT = Math.min(Math.max(0, playhead - target.start), Math.max(0, target.end - target.start))

  // Every prop's value at the playhead, sampled ONCE off the incoming item.
  // The header's all-props actions thread five writes through one another, so
  // they must read from this snapshot rather than re-sampling a partially
  // written item — otherwise one prop's write could perturb another's value.
  const sampled: Record<KeyframeProp, number> = {
    offsetX: valueAt(target, 'offsetX', localT),
    offsetY: valueAt(target, 'offsetY', localT),
    scale: valueAt(target, 'scale', localT),
    rotation: valueAt(target, 'rotation', localT),
    opacity: valueAt(target, 'opacity', localT),
  }

  /** Continuous gesture step — no undo entry yet. */
  function preview(prop: KeyframeProp, value: number) {
    onPreview(writeProp(target, prop, localT, value))
  }

  /** A discrete, already-final edit — one undo entry, no separate commit. */
  function commitDiscrete(prop: KeyframeProp, value: number) {
    onChange(writeProp(target, prop, localT, value))
  }

  function handleInput(prop: KeyframeProp, raw: string) {
    if (raw === '' || raw === '-') return // mid-typing (empty field, lone minus) — nothing finite to write yet
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    preview(prop, value)
  }

  function handleToggle(prop: KeyframeProp) {
    const next = hasKeyframes(target, prop)
      ? disableKeyframing(target, prop, localT)
      : enableKeyframing(target, prop, localT)
    onChange(next)
  }

  function handleStep(row: RowSpec, direction: 1 | -1) {
    let next = sampled[row.prop] + direction * row.step
    if (row.min !== undefined) next = Math.max(row.min, next)
    if (row.max !== undefined) next = Math.min(row.max, next)
    commitDiscrete(row.prop, displayValue(next))
  }

  /** Ascending, de-duplicated keyframe times across `props`. */
  function keyframeTimes(props: KeyframeProp[]): number[] {
    const times = new Set<number>()
    for (const prop of props) for (const point of trackFor(target, prop)?.points ?? []) times.add(point.t)
    return [...times].sort((a, b) => a - b)
  }

  /** Nav-unit wiring for a set of props. The arrows seek the playhead to an
   *  ABSOLUTE timeline time (`item.start + t`) — keyframe `t` is item-relative
   *  (see Keyframe.t) and the clock is not. Without `onSeek` they render
   *  disabled rather than silently doing nothing. */
  function navFor(props: KeyframeProp[]) {
    const times = keyframeTimes(props)
    let prev: number | undefined
    for (const t of times) if (t < localT) prev = t // ascending, so the last one under localT wins
    const next = times.find(t => t > localT)
    return {
      canPrev: !!onSeek && prev !== undefined,
      canNext: !!onSeek && next !== undefined,
      onPrev: () => { if (prev !== undefined) onSeek?.(target.start + prev) },
      onNext: () => { if (next !== undefined) onSeek?.(target.start + next) },
    }
  }

  /** True when EVERY transform prop has a keyframe at exactly the playhead —
   *  what the header diamond reflects, and the branch its click takes. Note
   *  this is a stricter test than the per-row diamonds' `hasKeyframes`, which
   *  only asks whether the prop is animated at all. */
  const allKeyed = ALL_PROPS.every(prop => (trackFor(target, prop)?.points ?? []).some(p => p.t === localT))

  function handleKeyframeAll() {
    let next = target
    if (allKeyed) {
      for (const prop of ALL_PROPS) {
        const points = trackFor(next, prop)?.points ?? []
        // The distinction matters. `removeKeyframe` on a track's LAST point
        // drops the track WITHOUT writing the sampled value into the static
        // scalar, so the overlay would jump back to whatever stale
        // `item.scale`/`item.rotation`/… was left behind when keyframing was
        // first switched on. `disableKeyframing` writes that value first, so
        // nothing moves. Multi-point tracks keep animating, so they only lose
        // the one point.
        next = points.length > 1
          ? removeKeyframe(next, prop, localT)
          : disableKeyframing(next, prop, localT)
      }
    } else {
      for (const prop of ALL_PROPS) {
        // `enableKeyframing` is a documented NO-OP on an already-keyframed
        // prop, so it is safe to run across all five unconditionally; it only
        // seeds a track for the ones that had none. `setKeyframe` then pins
        // the CURRENT value at the playhead on every prop, animated or not.
        // Values come from `sampled` (read off the original item), so nothing
        // on screen moves and no write perturbs another's sample.
        next = setKeyframe(enableKeyframing(next, prop, localT), prop, localT, sampled[prop])
      }
    }
    onChange(next)
  }

  function handleReset() {
    let next = target
    // Deliberately does NOT delete keyframe tracks. On a keyframed prop this
    // drops a default-valued keyframe at the playhead — the same
    // non-destructive rule every other control in this panel follows, and it
    // keeps "reset" from silently discarding an animation the operator spent
    // real time on. Clearing a track is the per-row diamond's job.
    for (const prop of ALL_PROPS) next = writeProp(next, prop, localT, DEFAULTS[prop])
    onChange(next)
  }

  const headerNav = navFor(ALL_PROPS)

  /** The `‹ ◇ ›` unit for one row. */
  function rowNav(prop: KeyframeProp) {
    const row = ROWS[prop]
    const nav = navFor([prop])
    const keyframed = hasKeyframes(target, prop)
    return (
      <KeyframeNav
        prevLabel={`Previous ${row.name} keyframe`}
        nextLabel={`Next ${row.name} keyframe`}
        diamondLabel={keyframed ? `Remove ${row.name} keyframe at playhead` : `Add ${row.name} keyframe at playhead`}
        pressed={keyframed}
        canPrev={nav.canPrev}
        canNext={nav.canNext}
        onPrev={nav.onPrev}
        onNext={nav.onNext}
        onDiamond={() => handleToggle(prop)}
      />
    )
  }

  const alignButtons: { label: string; icon: ComponentType<{ size?: number }>; prop: KeyframeProp; edge: -1 | 0 | 1 }[] = [
    { label: 'Align left',   icon: AlignStartVertical,    prop: 'offsetX', edge: -1 },
    { label: 'Align center', icon: AlignCenterVertical,   prop: 'offsetX', edge: 0 },
    { label: 'Align right',  icon: AlignEndVertical,      prop: 'offsetX', edge: 1 },
    { label: 'Align top',    icon: AlignStartHorizontal,  prop: 'offsetY', edge: -1 },
    { label: 'Align middle', icon: AlignCenterHorizontal, prop: 'offsetY', edge: 0 },
    { label: 'Align bottom', icon: AlignEndHorizontal,    prop: 'offsetY', edge: 1 },
  ]

  return (
    <div className={SECTION_CLASS}>
      <div className="shrink-0 flex items-center gap-1 border-b border-[var(--editor-border)] px-2 py-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[var(--editor-text)]/60 transition-colors hover:text-[var(--editor-text)]"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="text-xs font-medium uppercase tracking-wide">Transform</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Reset transform" title="Reset every transform property to its default" onClick={handleReset}>
            <RotateCcw size={12} />
          </IconButton>
          <KeyframeNav
            prevLabel="Previous keyframe"
            nextLabel="Next keyframe"
            diamondLabel="Keyframe all transform properties at playhead"
            pressed={allKeyed}
            canPrev={headerNav.canPrev}
            canNext={headerNav.canNext}
            onPrev={headerNav.onPrev}
            onNext={headerNav.onNext}
            onDiamond={handleKeyframeAll}
          />
        </div>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-2 p-2">
          {/* ── Scale ─────────────────────────────────────────────────────
              The X and Y boxes both read from and write to the ONE uniform
              `scale` scalar the schema has today, which is why the link
              toggle renders permanently checked and disabled: with the lock
              on, editing either axis moving both is the literally correct
              behaviour of a uniform-locked scale control, so nothing on
              screen is a lie.

              Separate `scaleX`/`scaleY` is a follow-up plan, not an omission
              here: it needs `schema.ts`, timeline-core's `geometryAt` /
              `toPixelBox`, the preview transform, `useDragOverlay`'s
              edge-snap and the ffmpeg render bake all changed together, or
              the preview and the render drift. The row is deliberately built
              as an X/Y pair NOW so that lands as unlocking this toggle
              rather than as another redesign of this panel. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className={ROW_LABEL_CLASS}>Scale</span>
              <ScaleSlider
                value={sampled.scale}
                onPreview={v => preview('scale', v)}
                onCommit={onCommit}
              />
              <button
                type="button"
                role="checkbox"
                aria-checked="true"
                aria-disabled="true"
                aria-label="Uniform scale"
                title="Width and height scale together"
                disabled
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--editor-accent)]"
              >
                <Link2 size={12} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0" />
              <NumberCell
                row={ROWS.scale}
                prefix="X"
                value={sampled.scale}
                onInput={raw => handleInput('scale', raw)}
                onCommit={onCommit}
                onStep={d => handleStep(ROWS.scale, d)}
              />
              <NumberCell
                row={ROWS.scale}
                name="Scale Y"
                prefix="Y"
                value={sampled.scale}
                onInput={raw => handleInput('scale', raw)}
                onCommit={onCommit}
                onStep={d => handleStep(ROWS.scale, d)}
              />
              <div className="ml-auto">{rowNav('scale')}</div>
            </div>
          </div>

          {/* ── Position ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={ROW_LABEL_CLASS}>Position</span>
            <div className="flex items-center gap-1">
              <NumberCell
                row={ROWS.offsetX}
                prefix="X"
                value={sampled.offsetX}
                onInput={raw => handleInput('offsetX', raw)}
                onCommit={onCommit}
                onStep={d => handleStep(ROWS.offsetX, d)}
              />
              {rowNav('offsetX')}
            </div>
            <div className="flex items-center gap-1">
              <NumberCell
                row={ROWS.offsetY}
                prefix="Y"
                value={sampled.offsetY}
                onInput={raw => handleInput('offsetY', raw)}
                onCommit={onCommit}
                onStep={d => handleStep(ROWS.offsetY, d)}
              />
              {rowNav('offsetY')}
            </div>
          </div>

          {/* ── Rotate ───────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <span className={ROW_LABEL_CLASS}>Rotate</span>
            <NumberCell
              row={ROWS.rotation}
              value={sampled.rotation}
              onInput={raw => handleInput('rotation', raw)}
              onCommit={onCommit}
              onStep={d => handleStep(ROWS.rotation, d)}
            />
            <RotationDial
              rotation={sampled.rotation}
              onPreview={deg => preview('rotation', deg)}
              onCommit={onCommit}
              onChange={deg => commitDiscrete('rotation', deg)}
            />
            <div className="ml-auto">{rowNav('rotation')}</div>
          </div>

          {/* ── Opacity ──────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <span className={ROW_LABEL_CLASS}>Opacity</span>
            <NumberCell
              row={ROWS.opacity}
              value={sampled.opacity}
              onInput={raw => handleInput('opacity', raw)}
              onCommit={onCommit}
              onStep={d => handleStep(ROWS.opacity, d)}
            />
            <div className="ml-auto">{rowNav('opacity')}</div>
          </div>

          {/* ── Align ────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <span className={ROW_LABEL_CLASS}>Align</span>
            {[alignButtons.slice(0, 3), alignButtons.slice(3)].map((group, i) => (
              <div key={i} className="flex items-center gap-0.5">
                {group.map(({ label, icon: Icon, prop, edge }) => (
                  <IconButton
                    key={label}
                    label={label}
                    // The CURRENT sampled scale, not the raw `item.scale`, so
                    // aligning mid-animation snaps to the edge the overlay
                    // actually has at the playhead.
                    onClick={() => commitDiscrete(prop, alignedOffset(sampled.scale, edge))}
                  >
                    <Icon size={12} />
                  </IconButton>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
