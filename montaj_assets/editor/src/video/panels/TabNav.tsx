import { cn } from '../../ui'

export interface TabNavTab<T extends string = string> {
  value: T
  label: string
}

export interface TabNavProps<T extends string = string> {
  tabs: readonly TabNavTab<T>[]
  value: T
  onChange: (next: T) => void
  /** Accessible name for the group, e.g. "Overlay panel view". */
  ariaLabel: string
  /** Extra classes merged onto the wrapper, after the base `flex items-center`. */
  className?: string
}

/**
 * Shared underline tab strip used by the editor's small in-panel tab
 * switches (CaptionListPanel's Styles/Format/Captions switch, VideoEditor's
 * overlay Content/Transform pair, ClipPropertiesPanel's clip tabs):
 * uppercase labels, an accent underline under the active tab, muted
 * inactive — NOT a filled segmented control — so every panel that switches
 * between two or three views speaks the same tab language. Purely
 * presentational: the caller owns `value` and any persistence (e.g. via
 * `usePersistentState`), this component only renders the strip and reports
 * clicks.
 *
 * Deliberately NOT ARIA `role="tab"` / `role="tablist"`: the editor's LEFT
 * rail (`LeftPanelTabs`) already owns a real `role="tablist"`, and a second
 * tablist anywhere else in the same tree would put ambiguous `role="tab"`
 * nodes in the a11y tree and make `getByRole('tab', …)` ambiguous in the
 * host's own tests. A plain `role="group"` of `aria-pressed` buttons carries
 * the same "these are alternatives, one is active" meaning without the
 * collision — do not "fix" this back to `role="tab"`.
 */
export default function TabNav<T extends string>({ tabs, value, onChange, ariaLabel, className }: TabNavProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn('flex items-center', className)}>
      {tabs.map(tab => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.value)}
            className={`px-3 py-2 text-[11px] font-medium uppercase tracking-wide border-b-2 -mb-px transition-colors ${
              active
                ? 'border-[var(--editor-accent)] text-[var(--editor-text)]'
                : 'border-transparent text-[var(--editor-text)] opacity-50 hover:opacity-80'
            }`}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
