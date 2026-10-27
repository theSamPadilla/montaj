import { useState, type ReactNode } from 'react'
import { cn, SwatchInput } from '../ui'
import { railEyebrow, railSecondaryBtn, railSwatch } from './railStyles'

export interface BackgroundPanelProps {
  color: string
  /** The colour as it is picked: a preview only. */
  onColorPreview?: (color: string) => void
  /** The pick is final (the picker closed on a new colour): one write. */
  onColorChange: (color: string) => void
  /** The pick ended where it started. */
  onColorCancel?: () => void
  /** Whether "Set image as background" can run: one unlocked image selected, and the project editable. */
  canSetImage: boolean
  onSetImage: () => void
  /** The brand palette (hex): its swatches lead the colours. */
  brandColours?: string[]
  /** The host's images row (Library, brand kit), under the colours. */
  images?: ReactNode
}

/** The Background rail panel (§587 M4): the active slide's colour and "Set image as background". */
export default function BackgroundPanel({ color, onColorPreview, onColorChange, onColorCancel, canSetImage, onSetImage, brandColours = [], images }: BackgroundPanelProps) {
  // The swatch shows the pick as it moves; nothing is written until it commits.
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-4 p-4 text-[var(--editor-text)]">
      <div className="flex flex-col gap-2">
        <span className={railEyebrow}>Color</span>
        {brandColours.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {brandColours.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Brand color ${c}`}
                title={c}
                onClick={() => { setDraft(null); onColorChange(c) }}
                className={cn(railSwatch, 'h-7 w-7', c.toLowerCase() === color.toLowerCase() && 'ring-2 ring-[var(--editor-accent)]')}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        )}
        <SwatchInput
          value={draft ?? color}
          onChange={(v) => { setDraft(v); onColorPreview?.(v) }}
          onCommit={(v) => { setDraft(null); onColorChange(v) }}
          onCancel={() => { setDraft(null); onColorCancel?.() }}
          ariaLabel="Background color"
          target="slide"
        />
      </div>
      {images}
      <button
        type="button"
        disabled={!canSetImage}
        onClick={onSetImage}
        className={railSecondaryBtn}
      >
        Set image as background
      </button>
    </div>
  )
}
