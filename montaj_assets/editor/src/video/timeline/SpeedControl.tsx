/**
 * A controlled speed picker: a slider plus a row of clickable preset chips
 * snapping it to a common value. Shared by the per-clip inspect modal (host
 * `montaj_assets/ui` package) and the track-wide settings popover
 * (TrackSettingsPopover.tsx) — one control, one look, wherever speed is set.
 *
 * Controlled, not stateful: the caller owns `value` and reacts to `onChange`,
 * exactly like the range inputs elsewhere in this rail (volume, fontsize).
 * That keeps the two mount points free to wire it up differently — the clip
 * modal previews live and commits on an explicit Save button; the track popover
 * previews into local state and commits directly via `onCommit` (on slider
 * release and on a chip click), so touching a track control just applies, no
 * button, the same live-preview-then-commit split the volume fader uses.
 *
 * The slider itself is the shared `<Slider>` (ui/Slider.tsx) — see
 * `VolumeControl`'s twin comment for the one behaviour change it brings
 * (commit only on an actual gesture change, not on every pointerup/keyup).
 */
import { Slider } from '../../ui'

export interface SpeedControlProps {
  value: number
  onChange: (v: number) => void
  /** Optional commit signal, fired on slider release (pointer/keyboard) and on
   *  a chip click, carrying the value to commit. Callers that commit on their
   *  own control (e.g. a Save button) omit it and just read `onChange`. */
  onCommit?: (v: number) => void
  min?: number
  max?: number
  step?: number
  presets?: number[]
  label?: string
  /** Base id for the slider input, so a caller can wire a `<label htmlFor>`
   *  to it. Optional — the control is already self-labelled via `aria-label`. */
  idBase?: string
}

const DEFAULT_PRESETS = [0.25, 0.5, 1, 2, 4]

export default function SpeedControl({
  value,
  onChange,
  onCommit,
  min = 0.25,
  max = 4,
  step = 0.05,
  presets = DEFAULT_PRESETS,
  label,
  idBase,
}: SpeedControlProps) {
  const sliderId = idBase ? `${idBase}-speed-slider` : undefined

  return (
    <div className="flex flex-col gap-2">
      <div className={`flex items-center text-[11px] text-[var(--editor-text)]/70 ${label ? 'justify-between' : 'justify-end'}`}>
        {label && <span>{label}</span>}
        <span className="font-mono text-[10px] text-[var(--editor-text)]/50">{value.toFixed(2)}×</span>
      </div>
      <Slider
        id={sliderId}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label ?? 'Speed'}
        onChange={onChange}
        onCommit={onCommit}
      />
      {/* Quick-set chips under the slider — a click snaps straight to that
          value rather than dragging for it. The active one is marked with
          `aria-pressed` and the accent fill, mirroring the toolbar's own
          bold/italic toggle buttons (TextFormattingToolbar.tsx). */}
      <div role="group" aria-label={label ? `${label} presets` : 'Speed presets'} className="flex flex-wrap gap-1">
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
              {p}×
            </button>
          )
        })}
      </div>
    </div>
  )
}
