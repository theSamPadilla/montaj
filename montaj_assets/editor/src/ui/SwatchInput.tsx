import { useContext, useRef } from 'react'
import { cn } from './utils'
import { ColourPanelContext } from './colourPanelContext'

// Color control that actually reads as one: a filled rounded swatch (the live
// value) with the native <input type="color"> overlaid transparently so the OS
// picker anchors on the swatch. Optionally shows the hex string beside it.
//
// `onChange` fires live on every pick (drive a cheap preview). `onCommit`, if
// given, fires on blur (when the OS picker closes) — use it to persist once
// instead of on every intermediate value, mirroring a slider's drag→commit.
//
// A blur also fires when nothing was picked (tabbing past the swatch, or
// opening the picker and closing it), and then the native input reports its
// own value, which is `#ffffff` when the `value` prop is not a colour it can
// show. So `onCommit` fires only when a pick actually changed the colour: a
// blur with no pick, or a pick that ended back on the colour it started from,
// commits nothing. Fixed here once for every caller.
export interface SwatchInputProps {
  value: string
  onChange: (v: string) => void
  /** Fired on blur (picker closed) — for callers that preview live via onChange
   *  and persist only on commit. Omit to treat every onChange as final. */
  onCommit?: (v: string) => void
  /** Fired on blur when a pick happened but ended on the colour it started
   *  from, so `onCommit` does not fire. A caller whose `onChange` preview
   *  changed more than this one value (several items at once) undoes it here. */
  onCancel?: () => void
  ariaLabel: string
  /** Render the hex string next to the swatch. Default true. */
  showValue?: boolean
  /** Swatch size. `sm` (h-5) suits compact toolbars; `md` (h-7) is the default. */
  size?: 'sm' | 'md'
  /** Tooltip on the row. */
  title?: string
  /** In the rail layout's colour panel: whether this colour takes an 8-digit hex (transparency). */
  alpha?: boolean
  /** Rail layout: what the colour panel colours (see `ColourRequest.target`). */
  target?: 'element' | 'slide'
  /** Rail layout: which element prop the panel colours (see `ColourRequest.prop`). */
  prop?: string
}

export function SwatchInput({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
  showValue = true,
  size = 'md',
  title,
  alpha,
  target,
  prop,
}: SwatchInputProps) {
  // In the rail layout the swatch opens the colour panel, not the OS picker.
  const openPanel = useContext(ColourPanelContext)
  // The current pick gesture: the colour on screen when it began (the first
  // onChange since the last blur) and the latest colour picked. null while no
  // pick is pending. Judged on what onChange reported, not on the input's
  // value at blur, so it does not depend on the host echoing the pick back.
  const pickRef = useRef<{ start: string; last: string } | null>(null)
  const box = size === 'sm' ? 'h-5 w-5' : 'h-7 w-7'
  if (openPanel) {
    return (
      <div className="flex items-center gap-2.5" title={title}>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn('relative shrink-0 cursor-pointer rounded-md border border-[var(--editor-border)] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] disabled:cursor-not-allowed disabled:opacity-40', box)}
          style={{ backgroundColor: value }}
          onClick={() => openPanel({
            label: ariaLabel,
            value,
            alpha,
            // A control with `onCommit` previews through `onChange` and writes
            // on `onCommit`; one without writes on `onChange` alone.
            preview: onCommit ? onChange : undefined,
            commit: onCommit ?? onChange,
            cancel: onCancel,
            target,
            prop,
          })}
        />
        {showValue && (
          <span className="font-mono text-sm uppercase text-[color-mix(in_srgb,var(--editor-text)_80%,transparent)]">{value}</span>
        )}
      </div>
    )
  }
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
          value={value.length === 9 ? value.slice(0, 7) : value}
          onChange={e => {
            pickRef.current = { start: pickRef.current?.start ?? value, last: e.target.value }
            onChange(e.target.value)
          }}
          onBlur={e => {
            const pick = pickRef.current
            pickRef.current = null
            if (!pick) return
            if (pick.start.toLowerCase() === pick.last.toLowerCase()) { onCancel?.(); return }
            onCommit?.(e.target.value)
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={ariaLabel}
        />
      </label>
      {showValue && (
        <span className="font-mono text-sm uppercase text-[color-mix(in_srgb,var(--editor-text)_80%,transparent)]">{value}</span>
      )}
    </div>
  )
}
