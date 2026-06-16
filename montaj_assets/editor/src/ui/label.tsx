import { cn } from './utils'

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-xs font-medium text-gray-400 leading-none', className)}
      {...props}
    />
  )
}
