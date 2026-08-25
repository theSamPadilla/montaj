import { cn } from './utils'

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string }>
}

export function Select({ className, options, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        'flex h-9 w-full rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] px-3 py-1 text-sm text-[var(--editor-text)] focus:outline-none focus:ring-2 focus:ring-[var(--editor-accent)] disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
