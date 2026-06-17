import { cn } from './utils'

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-xs font-medium text-[var(--editor-text)]/60 leading-none', className)}
      {...props}
    />
  )
}
