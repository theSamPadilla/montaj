import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold',
  {
    variants: {
      variant: {
        pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
        draft:   'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
        final:   'bg-emerald-100 text-emerald-700 dark:bg-green-900/50 dark:text-green-300',
        default: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
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

/**
 * Which recipe a project was created with.
 *
 * Deliberately the raw workflow name, not a prettified label: it is what the
 * picker lists, what `montaj init --workflow` takes, and what a custom
 * workflow's own filename is. Any mapping to friendlier text would cover the
 * built-ins and silently miss every workflow a user adds themselves.
 *
 * Always the neutral variant, so the coloured badge beside it stays the one
 * that means something — status changes as the project moves, the workflow
 * never does.
 */
export function WorkflowBadge({ workflow }: { workflow?: string | null }) {
  // Legacy projects predate the field; showing nothing beats showing "unknown".
  if (!workflow) return null
  // Capped because the name is user-supplied: a custom workflow file can be
  // called anything, and on the narrow mobile card an unbounded one would push
  // the status badge out of the row.
  return <Badge variant="default" className="max-w-[10rem] truncate" title={workflow}>{workflow}</Badge>
}
