import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, type LucideIcon } from 'lucide-react'
import type { CarouselElement, ImageElement, Slide } from '../types'
import type { ReorderDirection } from '../state/project-reducer'
import { NumberField, stepValue, SwatchInput } from '../ui'

// The element controls the classic SlidePropertyPanel and the rail layout's
// element toolbar (§587 M3) share: the typed transform fields, the image's
// Replace picker and Crop rule, the four layer-order buttons, and the slide's
// background colour (for the Background rail panel).

/** Small muted label above an inspector control. */
export const fieldLabelClass = 'text-[11px] uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]'

// `label` doubles as NumberField's accessible `name` — there is no separate
// visible `<label htmlFor>` wired to the box, just the wrapping `<label>`
// element below (which already associates the two natively), so reusing the
// same string keeps the accessible name identical to what a screen reader
// announced before this converted from a bare `<input>`.
//
// A typed number is ONE edit: `onPreview` shows it as it is typed (a transient,
// nothing recorded) and `onCommit` writes it once, on Enter or blur. A box with
// no `onPreview` shows nothing until then. `onCancel` (Esc) gives the typed
// value up: it drops the preview, then blurs so NumberField releases its draft
// and shows the value the project holds. A stepper click is its own discrete
// edit (`onStep`), one write per click.
export interface NumInputHandlers {
  onPreview?: (v: number) => void
  onCommit: (v: number) => void
  onCancel?: () => void
  onStep: (v: number) => void
}

export function numInput(
  label: string,
  value: number,
  h: NumInputHandlers,
  opts?: { min?: number; max?: number; step?: number; disabled?: boolean }
) {
  const step = opts?.step ?? 1
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <div
        onKeyDown={e => {
          if (e.key !== 'Escape' || !h.onCancel) return
          h.onCancel()
          e.stopPropagation()
          ;(e.target as HTMLElement).blur()
        }}
      >
        <NumberField
          name={label}
          value={value}
          disabled={opts?.disabled}
          onPreview={h.onPreview ?? (() => {})}
          onCommit={h.onCommit}
          min={opts?.min}
          max={opts?.max}
          step={step}
          onStep={d => h.onStep(stepValue(value, d, { step, min: opts?.min, max: opts?.max }))}
        />
      </div>
    </label>
  )
}

export interface TransformFieldsProps {
  element: CarouselElement
  /** The fields are off (a locked element). */
  disabled?: boolean
  /** A stepper click, or (without `onPreview`) a typed value on commit: one write. */
  onChange: (patch: Partial<CarouselElement>) => void
  /** A typed value as it is typed: a preview only. `onCommit` writes it once
   *  (Enter or blur) and `onCancel` (Esc) gives it up. */
  onPreview?: (patch: Partial<CarouselElement>) => void
  onCommit?: () => void
  onCancel?: () => void
}

/** X, Y, W, H and rotation: preview while typing, one write on Enter or blur.
 *  Without the preview hooks the write still happens once, on commit. */
export function TransformFields({ element, disabled, onChange, onPreview, onCommit, onCancel }: TransformFieldsProps) {
  const field = (
    label: string,
    value: number,
    key: 'x' | 'y' | 'w' | 'h' | 'rotation',
    opts?: { min?: number; max?: number },
  ) =>
    numInput(
      label,
      value,
      {
        onPreview: onPreview ? v => onPreview({ [key]: v }) : undefined,
        onCommit: onPreview ? () => onCommit?.() : v => onChange({ [key]: v }),
        onCancel: onPreview ? onCancel : undefined,
        onStep: v => onChange({ [key]: v }),
      },
      { ...opts, disabled },
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        {field('X', element.x, 'x')}
        {field('Y', element.y, 'y')}
        {field('W', element.w, 'w', { min: 1 })}
        {field('H', element.h, 'h', { min: 1 })}
      </div>
      {field('Rotation', element.rotation ?? 0, 'rotation', { min: -360, max: 360 })}
    </div>
  )
}

/** Why an image cannot be cropped now, or null when it can. */
export function cropBlockedReason(element: ImageElement): string | null {
  return (element.rotation ?? 0) !== 0 ? 'Reset rotation to 0 before cropping' : null
}

/**
 * Replace image (§556 M5): the hidden file input a Replace button opens, and
 * whether a replace is in flight (the button is off until it settles). The
 * host uploads the picked file and writes the element; its failures are its
 * own to report (a rejection is not caught here).
 */
export function useReplaceImagePicker(
  slideId: string | undefined,
  elementId: string | undefined,
  onReplaceImage?: (slideId: string, elementId: string, file: File) => void | Promise<void>,
): { replacing: boolean; open: () => void; input: ReactNode } {
  const inputRef = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState(false)
  async function picked(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    // Cleared so the same file can be picked again.
    input.value = ''
    if (!file || !slideId || !elementId || !onReplaceImage) return
    setReplacing(true)
    try {
      await onReplaceImage(slideId, elementId, file)
    } finally {
      setReplacing(false)
    }
  }
  return {
    replacing,
    open: () => inputRef.current?.click(),
    input: (
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="replace-image-input"
        onChange={picked}
      />
    ),
  }
}

const LAYER_BUTTONS: { direction: ReorderDirection; label: string; Icon: LucideIcon }[] = [
  { direction: 'front', label: 'Bring to front', Icon: ArrowUpToLine },
  { direction: 'forward', label: 'Bring forward', Icon: ArrowUp },
  { direction: 'backward', label: 'Send backward', Icon: ArrowDown },
  { direction: 'back', label: 'Send to back', Icon: ArrowDownToLine },
]

const layerButtonClass =
  'flex h-7 flex-1 items-center justify-center rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)] transition-colors hover:border-[var(--editor-accent)] hover:text-[var(--editor-text)] focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--editor-border)]'

/** Front, forward, backward, back: the layer-order keys' four moves. A locked element may still be layered. */
export function LayerOrderButtons({ onMove, disabled }: { onMove: (direction: ReorderDirection) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabelClass}>Layer</span>
      <div role="group" aria-label="Layer order" className="flex gap-1">
        {LAYER_BUTTONS.map(({ direction, label, Icon }) => (
          <button key={direction} type="button" aria-label={label} title={label} disabled={disabled} onClick={() => onMove(direction)} className={layerButtonClass}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  )
}

/** The slide's background colour. The classic panel's Slide section uses it;
 *  the rail layout's Background panel is its other home. */
export function SlideBackgroundField({ slide, onSlideChange }: { slide: Slide; onSlideChange: (patch: Partial<Slide>) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={fieldLabelClass}>Background color</span>
      <SwatchInput
        value={slide.base_color || '#ffffff'}
        onChange={v => onSlideChange({ base_color: v })}
        ariaLabel="Background color"
      />
    </div>
  )
}
