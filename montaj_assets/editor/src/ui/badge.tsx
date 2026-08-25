import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

const badgeVariants = cva(
  'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold',
  {
    variants: {
      variant: {
        // Status hues are deliberately a single fixed appearance rather than
        // a `dark:`-split one: `dark:` here would follow the HOST page's
        // `<html class="dark">`, not the `theme` prop passed to this editor
        // instance — a host can pass `lightMontajTheme` while its own chrome
        // stays dark (or vice versa), so the two can disagree. A soft pastel
        // chip is legible on any editor ground (verified ~4.6:1+ on a light
        // surface, the new case this sweep adds; it simply pops as a bright
        // chip on a dark one, which reads fine for a status indicator).
        pending: 'bg-amber-100 text-amber-700',
        draft:   'bg-blue-100 text-blue-700',
        final:   'bg-emerald-100 text-emerald-700',
        default: 'bg-[var(--editor-surface)] text-[var(--editor-text)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export function StatusBadge({ status }: { status: string }) {
  const variant = ['pending', 'draft', 'final'].includes(status)
    ? (status as 'pending' | 'draft' | 'final')
    : 'default'
  return <Badge variant={variant}>{status}</Badge>
}
