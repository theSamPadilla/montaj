import { cn } from './utils'

// Color control that actually reads as one: a filled rounded swatch (the live
// value) with the native <input type="color"> overlaid transparently so the OS
// picker anchors on the swatch. Optionally shows the hex string beside it.
//
// `onChange` fires live on every pick (drive a cheap preview). `onCommit`, if
// given, fires on blur (when the OS picker closes) — use it to persist once
// instead of on every intermediate value, mirroring a slider's drag→commit.
export interface SwatchInputProps {
  value: string
  onChange: (v: string) => void
  /** Fired on blur (picker closed) — for callers that preview live via onChange
   *  and persist only on commit. Omit to treat every onChange as final. */
  onCommit?: (v: string) => void
  ariaLabel: string
  /** Render the hex string next to the swatch. Default true. */
  showValue?: boolean
  /** Swatch size. `sm` (h-5) suits compact toolbars; `md` (h-7) is the default. */
  size?: 'sm' | 'md'
  /** Tooltip on the row. */
  title?: string
}

export function SwatchInput({
  value,
  onChange,
  onCommit,
  ariaLabel,
  showValue = true,
  size = 'md',
  title,
}: SwatchInputProps) {
  const box = size === 'sm' ? 'h-5 w-5' : 'h-7 w-7'
  return (
    <div className="flex items-center gap-2.5" title={title}>
      <label className={cn('relative shrink-0 cursor-pointer', box)}>
        <span
          className="block h-full w-full rounded-md border border-[var(--editor-border)] shadow-sm"
          style={{ backgroundColor: value }}
          aria-hidden
        />
        <input
          type="color"
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={e => onCommit?.(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={ariaLabel}
        />
      </label>
      {showValue && (
        <span className="font-mono text-sm uppercase text-[var(--editor-text)]/80">{value}</span>
      )}
    </div>
  )
}
