import { cn } from './utils'

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-xs font-medium text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] leading-none', className)}
      {...props}
    />
  )
}
