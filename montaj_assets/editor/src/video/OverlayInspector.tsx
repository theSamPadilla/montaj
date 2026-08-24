import { useState } from 'react'
import { Diamond } from 'lucide-react'
import type { KeyframeProp, VisualItem } from '../schema'
import { hasKeyframes, valueAt, setKeyframe, enableKeyframing, disableKeyframing } from './keyframeOps'
import { usePlaybackTime, type PlaybackClock } from './playback-clock'
import { cn, inspectorInputClass } from '../ui'

/**
 * `<OverlayInspector>` — T3.2's minimal numeric-field panel for the selected
 * overlay's five transform props (offsetX/offsetY/scale/rotation/opacity),
 * with a per-property keyframe diamond and CapCut-style auto-keyframe-on-
 * change: editing a prop that's already keyframed drops a new keyframe at the
 * playhead instead of overwriting the static scalar.
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
   *  render nothing — the component enforces its own "overlay only" contract
   *  rather than trusting the caller to have already filtered. */
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
}

interface RowSpec {
  prop: KeyframeProp
  label: string
  step: number
  min?: number
  max?: number
}

// Offsets/rotation are unbounded (percent of frame / degrees, can go negative
// or past 100/360 for effects); scale only needs a floor above zero; opacity
// is clamped to the 0–1 range the renderer expects.
const ROWS: RowSpec[] = [
  { prop: 'offsetX',  label: 'Offset X', step: 1 },
  { prop: 'offsetY',  label: 'Offset Y', step: 1 },
  { prop: 'scale',    label: 'Scale',    step: 0.01, min: 0.01 },
  { prop: 'rotation', label: 'Rotation', step: 1 },
  { prop: 'opacity',  label: 'Opacity',  step: 0.01, min: 0, max: 1 },
]

// Curve-sampled values can carry float noise (e.g. 29.999999999999996) picked
// up from interpolation. Rounds only what's DISPLAYED — handleInput below
// always reads the raw text the operator typed, never this rounded number.
function displayValue(value: number): number {
  return Math.round(value * 100) / 100
}

interface FieldProps {
  id: string
  label: string
  step: number
  min?: number
  max?: number
  /** The prop-derived value for the CURRENT playhead — recomputed on every
   *  ~60Hz tick (see the component doc). Only actually shown while the field
   *  is untouched; see `draft` below. */
  value: number
  keyframed: boolean
  onInput: (raw: string) => void
  onCommit: () => void
  onToggle: () => void
}

/**
 * One numeric row, split out of the parent `.map` so it can hold its OWN
 * `useState` — hooks can't live inside a loop, and each of the five rows
 * needs independent "am I mid-edit" state.
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
 */
function OverlayInspectorField({ id, label, step, min, max, value, keyframed, onInput, onCommit, onToggle }: FieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(value)

  function commit() {
    setDraft(null)
    onCommit()
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-14 shrink-0 text-[11px] text-[var(--editor-text)]/55">
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={shown}
        onChange={e => { setDraft(e.target.value); onInput(e.target.value) }}
        onBlur={commit}
        // Enter closes the typing gesture the same way blur does — it does not
        // duplicate the commit logic, just triggers the same onBlur path.
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className={cn(inspectorInputClass, 'text-right')}
      />
      <button
        type="button"
        aria-label={keyframed ? `Remove ${label} keyframe at playhead` : `Add ${label} keyframe at playhead`}
        aria-pressed={keyframed}
        onClick={onToggle}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
          keyframed
            ? 'text-[var(--editor-accent)]'
            : 'text-[var(--editor-text)]/40 hover:text-[var(--editor-text)]/70',
        )}
      >
        <Diamond size={11} fill={keyframed ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

export default function OverlayInspector({ item, clock, onPreview, onCommit, onChange }: OverlayInspectorProps) {
  // Subscribed unconditionally (hooks can't follow the early return below) —
  // cheap: this component renders nothing else, so a tick that turns out to
  // target a non-overlay/no selection still only re-runs this one function.
  const playhead = usePlaybackTime(clock)

  if (!item || item.type !== 'overlay') return null

  // Clamped to the item's own span, matching `applyKeyframeMove`'s clamp in
  // pointer-machine.ts. This panel renders whenever an overlay is SELECTED,
  // and selecting an item does not move the playhead — so a playhead sitting
  // outside the item's [start, end] (e.g. the overlay was selected while
  // parked elsewhere on the timeline) would otherwise hand `setKeyframe`/
  // `enableKeyframing` a negative or over-long `t`, writing a keyframe
  // outside the span every OTHER keyframe consumer (draw, hit-test,
  // keyframeOps) assumes points stay within.
  const localT = Math.min(Math.max(0, playhead - item.start), Math.max(0, item.end - item.start))

  function handleInput(prop: KeyframeProp, raw: string) {
    if (raw === '' || raw === '-') return // mid-typing (empty field, lone minus) — nothing finite to write yet
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const next = hasKeyframes(item!, prop)
      ? setKeyframe(item!, prop, localT, value)
      : { ...item!, [prop]: value }
    onPreview(next)
  }

  function handleToggle(prop: KeyframeProp) {
    const next = hasKeyframes(item!, prop)
      ? disableKeyframing(item!, prop, localT)
      : enableKeyframing(item!, prop, localT)
    onChange(next)
  }

  return (
    <div className="shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden">
      <div className="shrink-0 px-3 py-2 border-b border-[var(--editor-border)]">
        <span className="text-xs font-medium text-[var(--editor-text)]/60 uppercase tracking-wide">
          Overlay
        </span>
      </div>
      <div className="p-2 flex flex-col gap-1.5">
        {ROWS.map(row => (
          <OverlayInspectorField
            key={row.prop}
            id={`overlay-inspector-${row.prop}`}
            label={row.label}
            step={row.step}
            min={row.min}
            max={row.max}
            value={displayValue(valueAt(item, row.prop, localT))}
            keyframed={hasKeyframes(item, row.prop)}
            onInput={raw => handleInput(row.prop, raw)}
            onCommit={onCommit}
            onToggle={() => handleToggle(row.prop)}
          />
        ))}
      </div>
    </div>
  )
}
