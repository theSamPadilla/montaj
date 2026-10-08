import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Align the selected element to the slide: its edges or its center. A rotated
// element aligns by the box it covers on the slide, so its corners land on the
// edge, not its unrotated frame.

export type AlignTo = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

interface Box {
  x: number
  y: number
  w: number
  h: number
  rotation?: number
}

/** The x or y that puts the element's covered box where `to` says on a `width` x `height` slide. */
export function alignedPosition(box: Box, to: AlignTo, width: number, height: number): { x: number } | { y: number } {
  const rad = ((box.rotation ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  // Half the covered box, around the element's center (rotation pivots there).
  const halfW = (box.w * cos + box.h * sin) / 2
  const halfH = (box.w * sin + box.h * cos) / 2
  if (to === 'left' || to === 'center' || to === 'right') {
    const cx = to === 'left' ? halfW : to === 'right' ? width - halfW : width / 2
    return { x: Math.round(cx - box.w / 2) }
  }
  const cy = to === 'top' ? halfH : to === 'bottom' ? height - halfH : height / 2
  return { y: Math.round(cy - box.h / 2) }
}

const BUTTONS: { to: AlignTo; label: string; Icon: LucideIcon }[] = [
  { to: 'left', label: 'Align left', Icon: AlignStartVertical },
  { to: 'center', label: 'Align center', Icon: AlignCenterVertical },
  { to: 'right', label: 'Align right', Icon: AlignEndVertical },
  { to: 'top', label: 'Align top', Icon: AlignStartHorizontal },
  { to: 'middle', label: 'Align middle', Icon: AlignCenterHorizontal },
  { to: 'bottom', label: 'Align bottom', Icon: AlignEndHorizontal },
]

const fieldLabelClass = 'text-[11px] uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]'

export interface AlignControlsProps {
  element: Box
  /** The slide's size, in the same units as the element's box. */
  width: number
  height: number
  onChange: (patch: { x: number } | { y: number }) => void
}

export function AlignControls({ element, width, height, onChange }: AlignControlsProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabelClass}>Align</span>
      <div role="group" aria-label="Align to slide" className="flex gap-1">
        {BUTTONS.map(({ to, label, Icon }) => (
          <button
            key={to}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => onChange(alignedPosition(element, to, width, height))}
            className="flex h-7 flex-1 items-center justify-center rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)] transition-colors hover:border-[var(--editor-accent)] hover:text-[var(--editor-text)] focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)]"
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  )
}
