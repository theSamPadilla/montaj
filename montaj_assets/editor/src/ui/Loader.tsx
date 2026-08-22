/**
 * The editor's branded loading indicator: a miniature of the Montaj mark — a
 * film clapperboard (slate + play triangle) whose striped clapper claps open and
 * shut. Used for every in-editor loading state (cover/frame sampling, render
 * progress, overlay/schema fetches, engine warmup) so "loading" reads
 * consistently and on-brand. NOT for streaming agent-status text (that keeps its
 * own log/pending treatment).
 *
 * The slate uses the theme accent (with a literal fallback so it stays visible
 * even where `--editor-accent` is out of scope, e.g. a body-portaled modal). The
 * clap is a SMIL `animateTransform` rotating the clapper about its hinge — no
 * CSS transform-origin ambiguity, no keyframe injection.
 */

export interface LoaderProps {
  /** Rendered pixel size. sm 20 (inline/thumbnail), md 34, lg 56 (hero). */
  size?: 'sm' | 'md' | 'lg'
  /** Optional caption under the mark (e.g. "Loading cover"). */
  label?: string
  /** Extra classes on the wrapper (layout/positioning). */
  className?: string
}

const PX: Record<NonNullable<LoaderProps['size']>, number> = { sm: 20, md: 34, lg: 56 }

export function Loader({ size = 'md', label, className = '' }: LoaderProps) {
  const px = PX[size]
  return (
    <div
      role="status"
      aria-label={label ?? 'Loading'}
      className={`flex flex-col items-center justify-center gap-2 ${className}`}
    >
      <svg width={px} height={px} viewBox="0 0 64 56" fill="none" aria-hidden="true">
        {/* Slate (the board) + the Montaj play triangle. */}
        <rect x="8" y="24" width="48" height="24" rx="5" fill="var(--editor-accent, #38bdf8)" />
        <path d="M28 31 L41 36 L28 41 Z" fill="#ffffff" fillOpacity="0.92" />

        {/* Clapper stick — hinged at the slate's top-left (11,24). Rests open,
            snaps shut (the clap), reopens; repeat. */}
        <g>
          <animateTransform
            attributeName="transform"
            attributeType="XML"
            type="rotate"
            values="-32 11 24; -32 11 24; 0 11 24; -32 11 24"
            keyTimes="0; 0.32; 0.46; 1"
            dur="1.1s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0 0 1 1; 0.45 0 0.3 1; 0.4 0 0.2 1"
          />
          <rect x="8" y="14" width="48" height="10" rx="3" fill="#0b1220" />
          <path d="M15 14 l7 10 h7 l-7 -10 z" fill="#ec4899" />
          <path d="M29 14 l7 10 h7 l-7 -10 z" fill="#f97316" />
          <path d="M43 14 l7 10 h7 l-7 -10 z" fill="#facc15" />
        </g>
      </svg>
      {label && <span className="text-[11px] text-[var(--editor-text)]/50">{label}</span>}
    </div>
  )
}

export default Loader
