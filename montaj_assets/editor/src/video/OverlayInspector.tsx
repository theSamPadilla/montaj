import { useRef, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ChevronLeft,
  ChevronRight,
  Diamond,
  RotateCcw,
} from 'lucide-react'
import type { KeyframeProp, VisualItem } from '../schema'
import {
  canKeyframe,
  disableKeyframing,
  enableKeyframing,
  hasKeyframes,
  isUniformScale,
  removeKeyframe,
  setKeyframe,
  trackFor,
  transformProps,
  valueAt,
  canKeyframeProp,
} from './keyframeOps'
import { usePlaybackTime, type PlaybackClock } from './playback-clock'
import { NumberField, Slider, cn, stepValue } from '../ui'

/**
 * `<OverlayInspector>` — the editor's contextual right-hand **Transform**
 * properties panel for the selected overlay. One section holding the
 * keyframeable transform props as a scale slider + percent box, a
 * position pair, a rotation box with a circular dial, an opacity box, and a
 * six-button align row — plus a per-property keyframe unit (`‹ ◇ ›`) and an
 * all-properties one in the section header.
 *
 * WHICH props those are depends on the item: an overlay scaled uniformly
 * carries `scale`, one scaled per-axis carries `scaleX`/`scaleY` instead, and
 * the Uniform-scale toggle moves an item between the two. See `uniform` and
 * `allProps` below — that split runs through the header actions as well as
 * the Scale row itself.
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
   *  The same contract the Content tab's fields use (OverlayContentPanel) —
   *  both routed through VideoEditor's previewOverlayProps. */
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
  scaleX:   { prop: 'scaleX',   name: 'Scale X',  step: 0.01, min: 0.01 },
  scaleY:   { prop: 'scaleY',   name: 'Scale Y',  step: 0.01, min: 0.01 },
  rotation: { prop: 'rotation', name: 'Rotation', step: 1 },
  opacity:  { prop: 'opacity',  name: 'Opacity',  step: 0.01, min: 0, max: 1 },
}

/** Identity transform. Kept in step with `geometryAt`'s defaults in
 *  `@bycrux/timeline-core` — the same values `valueAt` falls back to when a
 *  prop has neither a track nor a static scalar. */
const DEFAULTS: Record<KeyframeProp, number> = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
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

/**
 * Remove one per-axis scale from `item` ENTIRELY — the static scalar AND any
 * keyframe track — so the resolver falls back to uniform `scale` again.
 *
 * The one write in this panel that does NOT go through {@link writeProp}, and
 * it cannot: `writeProp` writes VALUES, and no value of `scaleX` means
 * "absent" — 1 still shadows a `scale` of 1.2. `disableKeyframing` is no help
 * either despite dropping the track, because its whole job is to write the
 * sampled value into the static scalar so nothing jumps, and that scalar is
 * exactly the field that has to go.
 *
 * Peeling the points off with `removeKeyframe` IS the documented way to drop a
 * track without that scalar write: its last-point branch routes through
 * `withTrack`, which removes the track (and `item.keyframes` itself when it
 * was the last one). The `delete` then clears the scalar off a COPY — the
 * input item is never mutated, matching keyframeOps' contract.
 *
 * Returns the same item when there was nothing to clear, so reference equality
 * still tells a caller a no-op happened.
 */
function clearScaleAxis(item: VisualItem, prop: 'scaleX' | 'scaleY'): VisualItem {
  let next = item
  // Times read off the ORIGINAL track, which `removeKeyframe` never mutates;
  // each `t` is distinct (normalizeTrack's invariant) so one pass clears all.
  for (const point of trackFor(item, prop)?.points ?? []) next = removeKeyframe(next, prop, point.t)
  if (next[prop] === undefined) return next
  const stripped = { ...next }
  delete stripped[prop]
  return stripped
}

/** The offset (percent of frame) that puts the overlay's edge on the frame's
 *  edge for `edge` = -1 (left/top), 0 (center/middle), +1 (right/bottom).
 *  Mirrors useDragOverlay's edge-snap: an overlay at scale >= 1 already covers
 *  the frame, so it has no edge to align to and every alignment collapses to
 *  centered rather than pushing it further off-frame.
 *
 *  PER-AXIS by the caller, not by this function: `scale` is whichever axis'
 *  scale the alignment being computed runs along — `scaleX` for the
 *  left/center/right buttons (which write `offsetX`, a percent of frame
 *  WIDTH), `scaleY` for top/middle/bottom. Keeping the signature one scalar
 *  rather than taking the whole geometry keeps this a self-contained bit of
 *  arithmetic the tests can drive directly; the axis choice lives at the one
 *  call site, in the align button map. */
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
// up from interpolation. Rounds only what's DISPLAYED — a typed edit is parsed
// from the operator's own text (NumberField), never from this rounded number.
// The steppers round their RESULT to the same 2dp, in `stepValue`: `1.2 + 0.01`
// lands on 1.2100000000000002 otherwise, and a stepper is supposed to be exact.
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
  /** Greys the diamond out — the property exists but cannot be keyframed here. */
  diamondDisabled?: boolean
  /** Tooltip explaining WHY, shown only when disabled. */
  diamondReason?: string
}

/** The `‹ ◇ ›` unit: step to the previous/next keyframe, and toggle the
 *  keyframe at the playhead. One component so every row — and the header's
 *  all-props variant — lays out and labels the three controls identically. */
function KeyframeNav({
  prevLabel, nextLabel, diamondLabel, pressed, canPrev, canNext, onPrev, onNext, onDiamond,
  diamondDisabled = false, diamondReason,
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
        aria-disabled={diamondDisabled || undefined}
        disabled={diamondDisabled}
        title={diamondReason}
        onClick={onDiamond}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
          // DISABLED, not hidden. A control that vanishes reads as a bug and
          // invites a support question; one that is visibly unavailable and
          // says why reads as a limitation, which is what it is.
          diamondDisabled
            ? 'cursor-not-allowed text-[var(--editor-text)]/20'
            : pressed
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
  onPreview: (value: number) => void
  onCommit: () => void
  onStep: (direction: 1 | -1) => void
}

/** A number box with its axis prefix and stepper — the panel's repeating unit.
 *  A thin binding onto the shared {@link NumberField}: this component's job is
 *  only to translate a `RowSpec` into the field's props (and to build the
 *  stable per-row `id`), not to own any of the box's behaviour.
 *
 *  The `overlay-inspector-${name}` id it builds has no consumer today — no
 *  `<label htmlFor>` points at it, no test queries by it, nothing in
 *  `montaj_assets/ui` or `montaj_assets/render` reads it. That is deliberate,
 *  not dead code to prune: it is a stable, predictable hook for a future
 *  bound label, an automation script, or an external test harness to latch
 *  onto by row name, laid down now so it doesn't need inventing later. */
function NumberCell({ row, name = row.name, prefix, value, onPreview, onCommit, onStep }: NumberCellProps) {
  return (
    <NumberField
      id={`overlay-inspector-${name.replace(/\s+/g, '-').toLowerCase()}`}
      name={name}
      prefix={prefix}
      step={row.step}
      min={row.min}
      max={row.max}
      value={displayValue(value)}
      onPreview={onPreview}
      onCommit={onCommit}
      onStep={onStep}
      className="h-7 w-16 px-1.5 text-xs"
    />
  )
}

/** A scale number box with its `%` suffix and stepper. Scale is shown as a
 *  PERCENTAGE (CapCut: 1 => 100%) while the stored scalar stays a multiplier,
 *  so only what is typed and displayed converts — `value` and `onStep` are
 *  still multiplier-side, exactly as the slider and `handleStep` always were.
 *  One component rather than the inline markup this used to be, because the
 *  unlocked Scale X / Scale Y rows have to convert, bound and step identically
 *  to the locked `Scale` row; three copies of the `* 100` would drift. */
function ScalePercentCell({
  row, value, onPreview, onCommit, onStep,
}: {
  row: RowSpec
  value: number
  onPreview: (value: number) => void
  onCommit: () => void
  onStep: (direction: 1 | -1) => void
}) {
  return (
    <NumberField
      id={`overlay-inspector-${row.name.replace(/\s+/g, '-').toLowerCase()}`}
      name={row.name}
      // Percent-side bounds, matching the slider's span. Deliberately NOT
      // ROWS.scale*'s multiplier `step`/`min`, which are what the STEPPER
      // works in — hence `onStep` taking a direction rather than this
      // component's own bounds deciding the nudge (see stepValue).
      step={1}
      min={5}
      max={400}
      unit="%"
      value={Math.round(value * 100)}
      onPreview={onPreview}
      onCommit={onCommit}
      onStep={onStep}
      className="h-7 w-12 px-1.5 text-xs"
    />
  )
}

const SECTION_CLASS = 'shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden'

export default function OverlayInspector({ item, clock, onPreview, onCommit, onChange, onSeek }: OverlayInspectorProps) {
  // Subscribed unconditionally (hooks can't follow the early return below) —
  // cheap: this component renders nothing else, so a tick that turns out to
  // target a non-overlay/no selection still only re-runs this one function.
  const playhead = usePlaybackTime(clock)

  if (!canKeyframe(item)) {
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
  // The header's all-props actions thread five or six writes through one
  // another, so they must read from this snapshot rather than re-sampling a
  // partially written item — otherwise one prop's write could perturb
  // another's value. `scaleX`/`scaleY` are always populated even on a uniform
  // item: `geometryAt` resolves them through `scale`, so they read as the
  // overlay's actual per-axis size whether or not it carries the fields.
  const sampled: Record<KeyframeProp, number> = {
    offsetX: valueAt(target, 'offsetX', localT),
    offsetY: valueAt(target, 'offsetY', localT),
    scale: valueAt(target, 'scale', localT),
    scaleX: valueAt(target, 'scaleX', localT),
    scaleY: valueAt(target, 'scaleY', localT),
    rotation: valueAt(target, 'rotation', localT),
    opacity: valueAt(target, 'opacity', localT),
  }

  // Which scale the item is actually authored in, and therefore which prop
  // list every all-props action walks. Both are DERIVED from the item on each
  // render, never held in `useState`, like every other value this panel shows:
  // this component is reconciled in place across selection changes, so state
  // would keep answering for the previously selected overlay. The rule itself
  // lives in keyframeOps — the canvas timeline's double-click-to-key gesture
  // needs exactly the same answer, and two copies of it would drift.
  const uniform = isUniformScale(target)
  const allProps = transformProps(target)

  /** Continuous gesture step — no undo entry yet. */
  function preview(prop: KeyframeProp, value: number) {
    onPreview(writeProp(target, prop, localT, value))
  }

  /** A discrete, already-final edit — one undo entry, no separate commit. */
  function commitDiscrete(prop: KeyframeProp, value: number) {
    onChange(writeProp(target, prop, localT, value))
  }

  function handleToggle(prop: KeyframeProp) {
    const next = hasKeyframes(target, prop)
      ? disableKeyframing(target, prop, localT)
      : enableKeyframing(target, prop, localT)
    onChange(next)
  }

  function handleStep(row: RowSpec, direction: 1 | -1) {
    commitDiscrete(row.prop, stepValue(sampled[row.prop], direction, row))
  }

  /** Ascending, de-duplicated keyframe times across `props`. */
  function keyframeTimes(props: readonly KeyframeProp[]): number[] {
    const times = new Set<number>()
    for (const prop of props) for (const point of trackFor(target, prop)?.points ?? []) times.add(point.t)
    return [...times].sort((a, b) => a - b)
  }

  /** Nav-unit wiring for a set of props. The arrows seek the playhead to an
   *  ABSOLUTE timeline time (`item.start + t`) — keyframe `t` is item-relative
   *  (see Keyframe.t) and the clock is not. Without `onSeek` they render
   *  disabled rather than silently doing nothing. */
  function navFor(props: readonly KeyframeProp[]) {
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
  const allKeyed = allProps.every(prop => (trackFor(target, prop)?.points ?? []).some(p => p.t === localT))

  function handleKeyframeAll() {
    let next = target
    if (allKeyed) {
      for (const prop of allProps) {
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
      for (const prop of allProps) {
        // `enableKeyframing` is a documented NO-OP on an already-keyframed
        // prop, so it is safe to run across the whole list unconditionally; it
        // only seeds a track for the ones that had none. `setKeyframe` then pins
        // the CURRENT value at the playhead on every prop, animated or not.
        // Values come from `sampled` (read off the original item), so nothing
        // on screen moves and no write perturbs another's sample.
        next = setKeyframe(enableKeyframing(next, prop, localT), prop, localT, sampled[prop])
      }
    }
    onChange(next)
  }

  // Position (offsetX + offsetY) keyed as a pair — CapCut shows one diamond for
  // Position, so the row animates/toggles both axes together, with the same
  // enable/disable rule the per-row diamonds use (handleToggle). Kept separate
  // from handleKeyframeAll so that the all-props path (`transformProps(item)`,
  // which varies with the uniform-scale lock) is untouched.
  const positionProps: KeyframeProp[] = ['offsetX', 'offsetY']
  const positionKeyed = positionProps.every(prop => hasKeyframes(target, prop))

  function handlePositionToggle() {
    let next = target
    for (const prop of positionProps) {
      next = positionKeyed ? disableKeyframing(next, prop, localT) : enableKeyframing(next, prop, localT)
    }
    onChange(next)
  }

  // Scale is shown as a PERCENTAGE (CapCut: 1 => 100%). The box reports percent;
  // the stored scalar stays a multiplier, so convert on the way in. The slider
  // and stepper stay on the multiplier (the Slider below / handleStep). Takes
  // the prop so the unlocked per-axis boxes convert through the same path as
  // the locked one instead of a second copy of the `/ 100`. Unparseable and
  // mid-typing values never reach here — NumberField swallows those.
  function handleScalePercent(prop: 'scale' | 'scaleX' | 'scaleY', pct: number) {
    preview(prop, pct / 100)
  }

  /**
   * Move the item between uniform `scale` and per-axis `scaleX`/`scaleY`. One
   * discrete edit either way — one undo entry, no separate commit.
   *
   * Both directions route their VALUE write through `writeProp`, so the panel's
   * auto-keyframe rule applies here exactly as it does to typing in a box: a
   * prop that is already animated gets a keyframe at the playhead rather than a
   * silently-detaching static scalar.
   */
  function handleUniformToggle() {
    if (uniform) {
      // ON -> OFF (unlocking). Seed BOTH axes from `sampled.scale` — the scale
      // the overlay actually has at the playhead, animated value included, not
      // the raw `item.scale` — so the instant the lock opens nothing moves.
      // Once `scaleX`/`scaleY` exist they shadow `scale` entirely, which is
      // precisely why they have to be seeded rather than left absent.
      let next = writeProp(target, 'scaleX', localT, sampled.scale)
      next = writeProp(next, 'scaleY', localT, sampled.scale)
      onChange(next)
      return
    }
    // OFF -> ON (locking). Two numbers have to collapse into one and X WINS.
    // That is arbitrary — Y would have been just as defensible — but it is
    // CHOSEN and stable, not accidental: the operator can read the surviving
    // number off the Scale X box before clicking, and locking always means the
    // same thing. Then both per-axis fields are cleared outright, tracks and
    // all (see clearScaleAxis), because merely writing them equal would leave
    // them shadowing `scale` and the row would have nothing to lock TO.
    let next = writeProp(target, 'scale', localT, sampled.scaleX)
    next = clearScaleAxis(next, 'scaleX')
    next = clearScaleAxis(next, 'scaleY')
    onChange(next)
  }

  function handleReset() {
    let next = target
    // Deliberately does NOT delete keyframe tracks. On a keyframed prop this
    // drops a default-valued keyframe at the playhead — the same
    // non-destructive rule every other control in this panel follows, and it
    // keeps "reset" from silently discarding an animation the operator spent
    // real time on. Clearing a track is the per-row diamond's job.
    // Walks `allProps`, so an unlocked item resets `scaleX`/`scaleY` to 1 and
    // leaves the shadowed `scale` alone. Reset does not re-lock: the lock is
    // the operator's own choice about how this overlay is authored, not a
    // transform value with a default.
    for (const prop of allProps) next = writeProp(next, prop, localT, DEFAULTS[prop])
    onChange(next)
  }

  const headerNav = navFor(allProps)
  const positionNav = navFor(positionProps)

  /** The `‹ ◇ ›` unit for one row. */
  function rowNav(prop: KeyframeProp) {
    const row = ROWS[prop]
    const nav = navFor([prop])
    const keyframed = hasKeyframes(target, prop)
    // Per-property, per-kind: a clip animates position/scale/rotation but not
    // opacity, because ffmpeg's `colorchannelmixer aa` takes a <double> and no
    // expression. See canKeyframeProp for the full reason.
    const allowed = canKeyframeProp(target, prop)
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
        diamondDisabled={!allowed}
        diamondReason={allowed ? undefined
          : `${row.name} cannot be animated on a video or image clip. The export has no way to vary it over time. Overlays can.`}
      />
    )
  }

  const alignButtons: { label: string; icon: ComponentType<{ size?: number }>; prop: 'offsetX' | 'offsetY'; edge: -1 | 0 | 1 }[] = [
    { label: 'Align left',   icon: AlignStartVertical,    prop: 'offsetX', edge: -1 },
    { label: 'Align center', icon: AlignCenterVertical,   prop: 'offsetX', edge: 0 },
    { label: 'Align right',  icon: AlignEndVertical,      prop: 'offsetX', edge: 1 },
    { label: 'Align top',    icon: AlignStartHorizontal,  prop: 'offsetY', edge: -1 },
    { label: 'Align middle', icon: AlignCenterHorizontal, prop: 'offsetY', edge: 0 },
    { label: 'Align bottom', icon: AlignEndHorizontal,    prop: 'offsetY', edge: 1 },
  ]

  return (
    <div className={SECTION_CLASS}>
      {/* No section TITLE here — the CONTENT/TRANSFORM tab already names this
          pane, so a second "Transform" heading was redundant. This slim bar now
          only hosts the ALL-properties actions (reset-all + keyframe-all); the
          muted "All" scopes them apart from each row's own per-property unit. */}
      <div className="shrink-0 flex items-center gap-1 border-b border-[var(--editor-border)] px-2 py-1.5">
        <span className="px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--editor-text)]/40">
          All
        </span>
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

      <div className="flex flex-col gap-2 p-2">
        {/* ── Scale ─────────────────────────────────────────────────────
            LOCKED (the default, and every legacy overlay): one row (CapCut)
            — slider + a PERCENTAGE value (1 => 100%) + stepper + keyframe
            unit, all writing the uniform `scale`.

            UNLOCKED: that row splits per axis into Scale X / Scale Y, each
            writing its own prop and carrying its OWN keyframe unit (they
            animate independently, so one shared diamond would be a lie).
            Two rows rather than both boxes crammed into one: the Position
            row already fills the 300px default rail with two boxes and a
            SINGLE shared keyframe unit, and a second unit does not fit
            beside them. Each row is otherwise the Rotate/Opacity row
            verbatim — label, cell, keyframe unit pushed right. The slider
            is dropped while unlocked; it drives one number and there are
            two. */}
        {uniform ? (
          <div className="flex items-center gap-2">
            <span className={ROW_LABEL_CLASS}>Scale</span>
            <Slider
              aria-label="Scale slider"
              value={sampled.scale}
              min={SCALE_SLIDER_MIN}
              max={SCALE_SLIDER_MAX}
              step={0.01}
              onChange={v => preview('scale', v)}
              // Zero-arg: the panel commits whatever it last previewed, so it
              // has no use for the value the Slider offers.
              onCommit={onCommit}
              className="min-w-0 flex-1"
            />
            <ScalePercentCell
              row={ROWS.scale}
              value={sampled.scale}
              onPreview={pct => handleScalePercent('scale', pct)}
              onCommit={onCommit}
              onStep={d => handleStep(ROWS.scale, d)}
            />
            {rowNav('scale')}
          </div>
        ) : (
          (['scaleX', 'scaleY'] as const).map(prop => (
            <div key={prop} className="flex items-center gap-2">
              <span className={ROW_LABEL_CLASS}>{ROWS[prop].name}</span>
              <ScalePercentCell
                row={ROWS[prop]}
                value={sampled[prop]}
                onPreview={pct => handleScalePercent(prop, pct)}
                onCommit={onCommit}
                onStep={d => handleStep(ROWS[prop], d)}
              />
              <div className="ml-auto">{rowNav(prop)}</div>
            </div>
          ))
        )}

        {/* ── Uniform scale ─────────────────────────────────────────────
            Its own labelled toggle row (CapCut) instead of a bare link icon.
            ON means the item scales through one uniform `scale`; turning it
            off splits that into `scaleX`/`scaleY`, and back on collapses
            them again — see handleUniformToggle for both tiebreaks. The
            state is DERIVED from the item (isUniform), never held here, so
            selecting a different overlay shows that overlay's answer.
            `role="checkbox"` on a <button> is keyboard-operable natively
            (Space/Enter both fire click), so it needs no key handler of its
            own — only a visible focus ring. */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-[var(--editor-text)]/55">Uniform scale</span>
          <button
            type="button"
            role="checkbox"
            aria-checked={uniform}
            aria-label="Uniform scale"
            title={uniform ? 'Width and height scale together' : 'Width and height scale independently'}
            onClick={handleUniformToggle}
            className={cn(
              'ml-auto relative h-4 w-7 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--editor-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--editor-surface)]',
              uniform ? 'bg-[var(--editor-accent)]' : 'bg-[var(--editor-border)]',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all',
                uniform ? 'right-0.5' : 'left-0.5',
              )}
            />
          </button>
        </div>

        {/* ── Position ───────────────────────────────────────────────────
            X and Y with ONE keyframe unit for the pair on the right (CapCut),
            not a diamond crammed in after each axis. */}
        <div className="flex items-center gap-2">
          <span className={ROW_LABEL_CLASS}>Position</span>
          <NumberCell
            row={ROWS.offsetX}
            prefix="X"
            value={sampled.offsetX}
            onPreview={v => preview('offsetX', v)}
            onCommit={onCommit}
            onStep={d => handleStep(ROWS.offsetX, d)}
          />
          <NumberCell
            row={ROWS.offsetY}
            prefix="Y"
            value={sampled.offsetY}
            onPreview={v => preview('offsetY', v)}
            onCommit={onCommit}
            onStep={d => handleStep(ROWS.offsetY, d)}
          />
          <div className="ml-auto">
            <KeyframeNav
              prevLabel="Previous Position keyframe"
              nextLabel="Next Position keyframe"
              diamondLabel={positionKeyed ? 'Remove Position keyframe at playhead' : 'Add Position keyframe at playhead'}
              pressed={positionKeyed}
              canPrev={positionNav.canPrev}
              canNext={positionNav.canNext}
              onPrev={positionNav.onPrev}
              onNext={positionNav.onNext}
              onDiamond={handlePositionToggle}
            />
          </div>
        </div>

        {/* ── Rotate ───────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2">
          <span className={ROW_LABEL_CLASS}>Rotate</span>
          <NumberCell
            row={ROWS.rotation}
            value={sampled.rotation}
            onPreview={v => preview('rotation', v)}
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
            onPreview={v => preview('opacity', v)}
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
                  // The CURRENT sampled scale, not the raw scalar, so
                  // aligning mid-animation snaps to the edge the overlay
                  // actually has at the playhead — and the scale of the axis
                  // being aligned, since a non-uniform overlay's left edge is
                  // set by its WIDTH and its top edge by its HEIGHT. On a
                  // uniform item both sample back to `scale`, so legacy
                  // overlays align exactly as before.
                  onClick={() => commitDiscrete(prop, alignedOffset(prop === 'offsetX' ? sampled.scaleX : sampled.scaleY, edge))}
                >
                  <Icon size={12} />
                </IconButton>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
