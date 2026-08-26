/**
 * A controlled volume picker: a slider plus a row of clickable preset chips
 * snapping it to a common level. The audio twin of `SpeedControl` — same shape,
 * same look, so the two controls read as siblings wherever they sit together
 * (the track-wide settings popover and the per-clip inspect modal).
 *
 * Controlled, not stateful: the caller owns `value` and reacts to `onChange`,
 * exactly like the range inputs elsewhere in this rail. The two mount points
 * wire it up differently — the track popover previews into local state and
 * commits directly via `onCommit` (slider release and chip click); the clip
 * modal previews live and commits on an explicit Save button (so it omits
 * `onCommit` and just reads `onChange`).
 *
 * The slider itself is the shared `<Slider>` (ui/Slider.tsx): its own
 * `onCommit` already fires on gesture-end carrying the value, so this is a
 * direct rewiring rather than a reshaping. One behaviour change comes along
 * for free — `Slider` only commits when the gesture actually moved the value,
 * where the old bare `<input>` committed on every pointerup/keyup regardless.
 * That is strictly better (no more no-op undo entries) and no test here
 * depended on the old wart.
 */
import { Slider } from '../../ui'

/** `20·log10(v)` dB, matching the readout the volume faders used before this
 *  control existed. Escapes for U+2212 (minus) and U+221E (infinity) so the
 *  glyphs survive whatever transform sits between here and the DOM. */
function volumeToDb(v: number): string {
  if (v === 0) return '−∞ dB'
  return `${(20 * Math.log10(v)).toFixed(1)} dB`
}

export interface VolumeControlProps {
  value: number
  onChange: (v: number) => void
  /** Optional commit signal, fired on slider release (pointer/keyboard) and on
   *  a chip click, carrying the value to commit. Callers that commit on their
   *  own control (e.g. a Save button) omit it and just read `onChange`. */
  onCommit?: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** Levels the chips snap to, as raw multipliers (1 = unity / 0 dB). Rendered
   *  as whole-percent labels. */
  presets?: number[]
  label?: string
  /** Overrides the slider's `aria-label` — used where the accessible name must
   *  differ from the visible `label` (e.g. "Mute audio lane" vs "Volume"). */
  ariaLabel?: string
  /** Base id for the slider input, so a caller can wire a `<label htmlFor>`
   *  to it. Optional — the control is already self-labelled via `aria-label`. */
  idBase?: string
}

const DEFAULT_PRESETS = [0, 0.5, 1, 1.5, 2]

export default function VolumeControl({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 2,
  step = 0.01,
  presets = DEFAULT_PRESETS,
  label,
  ariaLabel,
  idBase,
}: VolumeControlProps) {
  const sliderId = idBase ? `${idBase}-volume-slider` : undefined

  return (
    <div className="flex flex-col gap-2">
      <div className={`flex items-center text-[11px] text-[var(--editor-text)]/70 ${label ? 'justify-between' : 'justify-end'}`}>
        {label && <span>{label}</span>}
        <span className="font-mono text-[10px] text-[var(--editor-text)]/50">
          {value.toFixed(2)} ({volumeToDb(value)})
        </span>
      </div>
      <Slider
        id={sliderId}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel ?? label ?? 'Volume'}
        onChange={onChange}
        onCommit={onCommit}
      />
      {/* Quick-set chips under the slider — a click snaps straight to that
          level rather than dragging for it. The active one is marked with
          `aria-pressed` and the accent fill, matching SpeedControl's chips. */}
      <div role="group" aria-label={label ? `${label} presets` : 'Volume presets'} className="flex flex-wrap gap-1">
        {presets.map(p => {
          const active = Math.abs(value - p) < 1e-6
          return (
            <button
              key={p}
              type="button"
              aria-pressed={active}
              onClick={() => { onChange(p); onCommit?.(p) }}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-mono transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)] ${
                active
                  ? 'border-[var(--editor-accent)] bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)]'
                  : 'border-[var(--editor-border)] bg-[var(--editor-surface)] text-[var(--editor-text)]/70 hover:text-[var(--editor-text)] hover:border-[var(--editor-accent)]'
              }`}
            >
              {Math.round(p * 100)}%
            </button>
          )
        })}
      </div>
    </div>
  )
}
