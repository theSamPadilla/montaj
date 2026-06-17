import { cn } from './utils'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--editor-accent)] disabled:opacity-50 dark:border-[var(--editor-border)] dark:bg-[var(--editor-surface)] dark:text-[var(--editor-text)] dark:placeholder:text-[var(--editor-text)]/60',
        className,
      )}
      {...props}
    />
  )
}
