import { cn } from './utils'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        'flex w-full rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] px-3 py-2 text-sm text-[var(--editor-text)] placeholder:text-[var(--editor-text)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--editor-accent)] disabled:opacity-50 resize-none',
        className,
      )}
      {...props}
    />
  )
}
