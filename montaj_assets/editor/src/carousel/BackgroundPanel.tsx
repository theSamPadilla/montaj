import { SwatchInput } from '../ui'

export interface BackgroundPanelProps {
  color: string
  onColorChange: (color: string) => void
  /** Whether "Set image as background" can run: one unlocked image selected, and the project editable. */
  canSetImage: boolean
  onSetImage: () => void
}

/** The Background rail panel (§587 M4): the active slide's colour and "Set image as background". */
export default function BackgroundPanel({ color, onColorChange, canSetImage, onSetImage }: BackgroundPanelProps) {
  return (
    <div className="flex flex-col gap-4 p-4 text-[var(--editor-text)]">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]">Color</span>
        <SwatchInput value={color} onChange={onColorChange} ariaLabel="Background color" />
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
