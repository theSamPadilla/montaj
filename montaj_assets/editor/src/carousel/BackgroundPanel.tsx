import { useState } from 'react'
import { SwatchInput } from '../ui'

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
}

/** The Background rail panel (§587 M4): the active slide's colour and "Set image as background". */
export default function BackgroundPanel({ color, onColorPreview, onColorChange, onColorCancel, canSetImage, onSetImage }: BackgroundPanelProps) {
  // The swatch shows the pick as it moves; nothing is written until it commits.
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-4 p-4 text-[var(--editor-text)]">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]">Color</span>
        <SwatchInput
          value={draft ?? color}
          onChange={(v) => { setDraft(v); onColorPreview?.(v) }}
          onCommit={(v) => { setDraft(null); onColorChange(v) }}
          onCancel={() => { setDraft(null); onColorCancel?.() }}
          ariaLabel="Background color"
        />
      </div>
      <button
        type="button"
        disabled={!canSetImage}
        onClick={onSetImage}
        className="h-8 px-3 rounded-md text-xs border border-[var(--editor-border)] hover:bg-[var(--editor-surface)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]"
      >
        Set image as background
      </button>
    </div>
  )
}
