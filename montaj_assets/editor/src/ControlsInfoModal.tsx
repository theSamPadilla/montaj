import { useEffect } from 'react'
import { X } from 'lucide-react'

/** A single control/shortcut row. `keys` renders as <kbd> chips; omit for a pure gesture. */
export interface ControlEntry {
  keys?: string[]
  label: string
}

export interface ControlSection {
  heading: string
  entries: ControlEntry[]
}

export interface ControlsInfoModalProps {
  title: string
  sections: ControlSection[]
  onClose: () => void
}

/**
 * Read-only "how to drive this editor" modal. Content is passed in per editor
 * (video vs carousel) so this component stays a dumb, themed renderer. Matches
 * the backdrop/Esc/close conventions of the other editor modals (TranscriptModal
 * et al.) and uses the shared `--editor-*` theme tokens.
 */
export default function ControlsInfoModal({ title, sections, onClose }: ControlsInfoModalProps) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative mx-4 flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg border shadow-2xl"
        style={{
          background: 'var(--editor-surface)',
          borderColor: 'var(--editor-border)',
          color: 'var(--editor-text)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-4 py-3"
          style={{ borderColor: 'var(--editor-border)' }}
        >
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer opacity-60 transition-opacity hover:opacity-100"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-4 py-3">
          {sections.map((section) => (
            <div key={section.heading}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-50">
                {section.heading}
              </p>
              <ul className="space-y-1.5">
                {section.entries.map((entry, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 text-xs">
                    <span className="opacity-80">{entry.label}</span>
                    {entry.keys && entry.keys.length > 0 && (
                      <span className="flex shrink-0 items-center gap-1">
                        {entry.keys.map((k, j) => (
                          <kbd
                            key={j}
                            className="rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none"
                            style={{ borderColor: 'var(--editor-border)', background: 'var(--editor-bg)' }}
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Controls reference for the video/timeline editor. Sourced from the shared
 *  keymap (`video/keymap.ts`, mounted by VideoEditor's ReviewSurface and
 *  Timeline), the track-controls toolbar, and PreviewPlayer's on-canvas
 *  transform (drag / corner-drag / scroll / rotate). */
export const VIDEO_CONTROLS: ControlSection[] = [
  {
    heading: 'Preview',
    entries: [
      { label: 'Drag to move the selected clip or overlay' },
      { label: 'Corner-drag or scroll to scale it' },
      { label: 'Drag the rotate handle to turn an overlay' },
    ],
  },
  {
    heading: 'Timeline',
    entries: [
      { label: 'Drag a clip to reposition it' },
      { label: "Drag a clip's edge to trim it" },
      { label: 'Select a clip, then click ⓘ to inspect it' },
      { label: 'Click the time readout to go to a timecode' },
    ],
  },
  {
    heading: 'Toolbar',
    entries: [
      { label: 'Ripple: edits close the gap instead of leaving it' },
      { label: 'Crop source: non-destructively crop the selected clip' },
    ],
  },
  {
    heading: 'Keyboard',
    entries: [
      { keys: ['S'], label: 'Split at the playhead' },
      { keys: ['⇧', 'Delete'], label: 'Ripple-delete the selection' },
      { keys: ['⌘/Ctrl', 'Z'], label: 'Undo' },
      { keys: ['⌘/Ctrl', '⇧', 'Z'], label: 'Redo' },
      { keys: ['⌘/Ctrl', 'K'], label: 'Command palette' },
      { keys: ['J', 'K', 'L'], label: 'Shuttle backward / stop / forward' },
      { keys: ['←', '→'], label: 'Step one frame (⇧ for one second)' },
      { keys: ['Enter'], label: 'Set a marker at the playhead' },
      { keys: ['Esc'], label: 'Clear markers' },
    ],
  },
]

/** Controls reference for the carousel editor. Sourced from CarouselEditor's key
 *  handlers (undo/redo, Delete) and the canvas gesture hints. */
export const CAROUSEL_CONTROLS: ControlSection[] = [
  {
    heading: 'Canvas',
    entries: [
      { label: 'Drag an element to reposition it' },
      { label: 'Resize or rotate it via the handles' },
      { label: 'Double-click text to edit it' },
    ],
  },
  {
    heading: 'Keyboard',
    entries: [
      { keys: ['⌘/Ctrl', 'Z'], label: 'Undo' },
      { keys: ['⌘/Ctrl', '⇧', 'Z'], label: 'Redo' },
      { keys: ['Delete'], label: 'Remove the selected element' },
    ],
  },
]
