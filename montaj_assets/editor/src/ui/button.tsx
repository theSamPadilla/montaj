import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:   'bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] hover:opacity-90',
        secondary: 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[var(--editor-surface)] dark:text-[var(--editor-text)] dark:hover:opacity-90',
        ghost:     'text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-[var(--editor-text)]/60 dark:hover:bg-[var(--editor-surface)] dark:hover:text-[var(--editor-text)]',
        danger:    'bg-red-600 text-white hover:bg-red-700',
        outline:   'border border-gray-300 dark:border-[var(--editor-border)] text-gray-700 dark:text-[var(--editor-text)] hover:bg-gray-100 dark:hover:bg-[var(--editor-surface)]',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm:      'h-7 px-3 text-xs',
        lg:      'h-11 px-6',
        icon:    'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
