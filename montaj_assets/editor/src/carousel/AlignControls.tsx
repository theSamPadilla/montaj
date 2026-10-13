import { useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
} from 'lucide-react'
import { cn, inspectorInputClass } from '../ui'
import type { LucideIcon } from 'lucide-react'

// Align the selected element to the slide: its edges or its center. A rotated
// element aligns by the box it covers on the slide, so its corners land on the
// edge, not its unrotated frame. With several elements selected, each aligns
// to the box the selection covers instead (§156). With three or more they can
// also be distributed along an axis: an even gap between the outermost, or an
// exact gap in px from the first (§156).

export type AlignTo = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

export interface Box {
  x: number
  y: number
  w: number
  h: number
  rotation?: number
}

export type AlignPatch = { x: number } | { y: number }

/** Half the box an element covers on the slide, around its center (rotation pivots there). */
function coveredHalf(box: Box): { halfW: number; halfH: number } {
  const rad = ((box.rotation ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return {
    halfW: (box.w * cos + box.h * sin) / 2,
    halfH: (box.w * sin + box.h * cos) / 2,
  }
}

/** The box an element covers on the slide, rotation included. */
export function coveredBox(box: Box): { left: number; top: number; right: number; bottom: number } {
  const { halfW, halfH } = coveredHalf(box)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return { left: cx - halfW, top: cy - halfH, right: cx + halfW, bottom: cy + halfH }
}

/** The union of the boxes `boxes` cover. */
export function coveredUnion(boxes: readonly Box[]): { left: number; top: number; right: number; bottom: number } {
  const covered = boxes.map(coveredBox)
  return {
    left: Math.min(...covered.map((c) => c.left)),
    top: Math.min(...covered.map((c) => c.top)),
    right: Math.max(...covered.map((c) => c.right)),
    bottom: Math.max(...covered.map((c) => c.bottom)),
  }
}

/** The x or y that puts the element's covered box where `to` says inside `bounds`. */
function alignWithin(
  box: Box,
  to: AlignTo,
  bounds: { left: number; top: number; right: number; bottom: number },
): AlignPatch {
  const { halfW, halfH } = coveredHalf(box)
  if (to === 'left' || to === 'center' || to === 'right') {
    const cx = to === 'left' ? bounds.left + halfW : to === 'right' ? bounds.right - halfW : (bounds.left + bounds.right) / 2
    return { x: Math.round(cx - box.w / 2) }
  }
  const cy = to === 'top' ? bounds.top + halfH : to === 'bottom' ? bounds.bottom - halfH : (bounds.top + bounds.bottom) / 2
  return { y: Math.round(cy - box.h / 2) }
}

/** The x or y that puts the element's covered box where `to` says on a `width` x `height` slide. */
export function alignedPosition(box: Box, to: AlignTo, width: number, height: number): AlignPatch {
  return alignWithin(box, to, { left: 0, top: 0, right: width, bottom: height })
}

/**
 * One patch per box, in order. A single box aligns to the slide
 * (`alignedPosition`); two or more align to the box the selection covers.
 */
export function alignedPositions(boxes: readonly Box[], to: AlignTo, width: number, height: number): AlignPatch[] {
  if (boxes.length < 2) return boxes.map((box) => alignedPosition(box, to, width, height))
  const bounds = coveredUnion(boxes)
  return boxes.map((box) => alignWithin(box, to, bounds))
}

export type DistributeAxis = 'horizontal' | 'vertical'

/**
 * One patch per box, in order, spacing the boxes along `axis` by the boxes
 * they cover (a rotated one counts by its covered box). They are taken in
 * order of position along the axis; the first stays where it is. With no `gap`
 * the gaps between neighbours come out equal and the last one ends where the
 * selection already ended (an even spread between the outermost); with a
 * `gap` (px) every neighbour is exactly that far from the one before. Fewer
 * than three boxes are left where they are.
 */
export function distributedPositions(boxes: readonly Box[], axis: DistributeAxis, gap?: number): AlignPatch[] {
  const horizontal = axis === 'horizontal'
  const stay = (box: Box): AlignPatch => (horizontal ? { x: box.x } : { y: box.y })
  if (boxes.length < 3) return boxes.map(stay)
  const items = boxes.map((box, index) => {
    const c = coveredBox(box)
    const start = horizontal ? c.left : c.top
    const end = horizontal ? c.right : c.bottom
    return { box, index, start, size: end - start }
  })
  const order = [...items].sort((a, b) => a.start - b.start || a.start + a.size - (b.start + b.size) || a.index - b.index)
  const first = order[0]
  const spanEnd = Math.max(...items.map((it) => it.start + it.size))
  const sizes = order.reduce((sum, it) => sum + it.size, 0)
  const g = gap === undefined ? (spanEnd - first.start - sizes) / (order.length - 1) : gap
  const patches: AlignPatch[] = new Array(boxes.length)
  let at = first.start
  for (const it of order) {
    const lead = it.size / 2 - (horizontal ? it.box.w : it.box.h) / 2   // the covered box's start to the frame's start
    patches[it.index] = horizontal ? { x: Math.round(at + lead) } : { y: Math.round(at + lead) }
    at += it.size + g
  }
  return patches
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

export type AlignControlsProps = {
  /** The slide's size, in the same units as the element's box. */
  width: number
  height: number
} & (
  | { element: Box; onChange: (patch: AlignPatch) => void }
  /** Several selected elements: each patch is one element's, by id. */
  | { elements: ReadonlyArray<Box & { id: string }>; onChange: (patches: Array<{ id: string } & AlignPatch>) => void }
)

const iconButtonClass =
  'flex h-7 w-9 items-center justify-center rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)] transition-colors hover:border-[var(--editor-accent)] hover:text-[var(--editor-text)] focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--editor-border)]'

export function AlignControls(props: AlignControlsProps) {
  const { width, height } = props
  const many = 'elements' in props && props.elements.length > 1
  // Distribute: the Gap field (blank is an even spread) and the buttons, live with three or more.
  const [gap, setGap] = useState('')
  const canDistribute = 'elements' in props && props.elements.length >= 3
  const distribute = (axis: DistributeAxis) => {
    if (!('elements' in props) || !canDistribute) return
    const n = gap.trim() === '' ? undefined : Number(gap)
    const patches = distributedPositions(props.elements, axis, n !== undefined && Number.isFinite(n) ? n : undefined)
    props.onChange(props.elements.map((el, i) => ({ id: el.id, ...patches[i] })))
  }
  const align = (to: AlignTo) => {
    if ('elements' in props) {
      const patches = alignedPositions(props.elements, to, width, height)
      props.onChange(props.elements.map((el, i) => ({ id: el.id, ...patches[i] })))
    } else {
      props.onChange(alignedPosition(props.element, to, width, height))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabelClass}>Align</span>
      <div role="group" aria-label={many ? 'Align' : 'Align to slide'} className="flex gap-1">
        {BUTTONS.map(({ to, label, Icon }) => (
          <button
            key={to}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => align(to)}
            className="flex h-7 flex-1 items-center justify-center rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)] transition-colors hover:border-[var(--editor-accent)] hover:text-[var(--editor-text)] focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)]"
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        ))}
      </div>
      {many && (
        <>
          <span className={fieldLabelClass}>Distribute</span>
          <div role="group" aria-label="Distribute" className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Distribute horizontally"
              title="Distribute horizontally"
              disabled={!canDistribute}
              onClick={() => distribute('horizontal')}
              className={iconButtonClass}
            >
              <AlignHorizontalDistributeCenter className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Distribute vertically"
              title="Distribute vertically"
              disabled={!canDistribute}
              onClick={() => distribute('vertical')}
              className={iconButtonClass}
            >
              <AlignVerticalDistributeCenter className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="ml-2 text-xs text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)]">Gap</span>
            <input
              type="number"
              inputMode="numeric"
              aria-label="Gap"
              value={gap}
              disabled={!canDistribute}
              onChange={(e) => setGap(e.target.value)}
              className={cn(inspectorInputClass, 'w-16 flex-none')}
            />
            <span className="text-xs text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]">px</span>
          </div>
        </>
      )}
    </div>
  )
}
