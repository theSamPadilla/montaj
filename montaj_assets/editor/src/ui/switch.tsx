import { cn } from './utils'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  className?: string
  disabled?: boolean
  /** Passed straight through to the underlying button — this component has no
   *  visible text of its own, so a caller placing the switch beside a text
   *  label (rather than wrapping it in one) needs this for an accessible name. */
  'aria-label'?: string
}

export function Switch({ checked, onCheckedChange, className, disabled, 'aria-label': ariaLabel }: SwitchProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] disabled:opacity-50',
        checked ? 'bg-[var(--editor-accent)]' : 'bg-gray-300 dark:bg-[var(--editor-border)]',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-1',
        )}
      />
    </button>
  )
}
