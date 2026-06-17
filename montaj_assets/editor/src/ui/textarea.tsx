import { cn } from './utils'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        'flex w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--editor-accent)] disabled:opacity-50 resize-none dark:border-[var(--editor-border)] dark:bg-[var(--editor-surface)] dark:text-[var(--editor-text)] dark:placeholder:text-[var(--editor-text)]/60',
        className,
      )}
      {...props}
    />
  )
}
