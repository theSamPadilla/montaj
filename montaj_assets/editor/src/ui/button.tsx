import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:   'bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] hover:opacity-90',
        secondary: 'bg-[var(--editor-surface)] text-[var(--editor-text)] border border-[var(--editor-border)] hover:border-[var(--editor-accent)]',
        ghost:     'text-[var(--editor-text)] hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]',
        danger:    'bg-red-600 text-white hover:bg-red-700',
        outline:   'bg-[var(--editor-surface)] text-[var(--editor-text)] border border-[var(--editor-border)] hover:border-[var(--editor-accent)]',
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
