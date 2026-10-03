import { useEffect, type ComponentType } from 'react'
import {
  ChevronsLeftRight,
  Clapperboard,
  Command,
  Crop,
  Keyboard,
  LayoutPanelTop,
  Magnet,
  Maximize2,
  MousePointer2,
  MousePointerClick,
  Move,
  MoveHorizontal,
  RotateCw,
  SeparatorVertical,
  SlidersHorizontal,
  Timer,
  X,
  type LucideProps,
} from 'lucide-react'
import { version } from '../package.json'
import { isApplePlatform, modifierKeys, modifierLabel } from './ui/modifierKeys'
import type { ControlSection, ControlsWindowSection } from './types'

export type { ControlEntry, ControlSection } from './types'

export interface ControlsInfoModalProps {
  title: string
  sections: ControlSection[]
  onClose: () => void
}

/** Heading → icon. Lives here rather than on `ControlSection` so the content
 *  arrays below stay pure data (a heading and some labels) and a host passing
 *  its own sections doesn't have to know about lucide. Unknown headings fall
 *  back to the neutral slider glyph rather than rendering a hole. */
const SECTION_ICONS: Record<string, ComponentType<LucideProps>> = {
  Mouse: MousePointer2,
  Canvas: MousePointer2,
  Toolbar: SlidersHorizontal,
  Keyboard: Keyboard,
  // Not used by the two content arrays below any more (Preview and Timeline
  // merged into Mouse), but kept for a host passing sections of its own.
  Preview: Clapperboard,
  Timeline: LayoutPanelTop,
}

/** `sections` as this modal shows them: each entry's `keys` and `label` in the
 *  platform's form (⌘ ⌥ ⇧ become Ctrl Alt Shift off Apple) and each section
 *  with its card icon. The modal renders through this, and a host's
 *  `renderControls` is handed its result, so the two cannot drift. Pure. */
export function platformSections(
  sections: readonly ControlSection[],
  apple: boolean = isApplePlatform(),
): ControlsWindowSection[] {
  return sections.map((section) => ({
    ...section,
    icon: SECTION_ICONS[section.heading] ?? SlidersHorizontal,
    entries: section.entries.map((entry) => ({
      ...entry,
      label: modifierLabel(entry.label, apple),
      ...(entry.keys && { keys: modifierKeys(entry.keys, apple) }),
    })),
  }))
}

/**
 * Read-only "how to drive this editor" modal. Content is passed in per editor
 * (video vs carousel) so this component stays a dumb, themed renderer. Matches
 * the backdrop/Esc/close conventions of the other editor modals (RenderModal
 * et al.) and uses the shared `--editor-*` theme tokens.
 *
 * The layout is deliberately not a flat list: each section is its own card with
 * an icon and a heading, and each row is a hoverable line with the gesture or
 * shortcut right-aligned. A dense unbroken list of ~20 rows is technically the
 * same information, but nobody scans it — which is what made the old ⓘ feel
 * like fine print rather than help.
 *
 * Sizing: the panel is wide (max-w-4xl) and the cards flow into TWO columns from
 * `sm` up. At one narrow column the video reference ran past the viewport and
 * the Keyboard section — the half people actually come here for — sat below the
 * fold. Two columns put the whole thing on screen at once, which is also why the
 * body text is a full 14px rather than the 12px used elsewhere in the chrome:
 * this is a document you read, not a toolbar you glance at.
 *
 * Sections are cut by INPUT, not by surface: Mouse, Toolbar, Keyboard. "Where
 * does this apply" then lives on the row that needs it (`ControlEntry.where`)
 * instead of forcing a whole card per surface.
 *
 * Accent use is intentionally cheap to theme: everything tinted reads
 * `var(--editor-accent)` directly (section and toolbar icons, row dots, the
 * header wash), so a host theme re-skins the modal without touching this file.
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm text-[var(--editor-text)]"
      onClick={onClose}
    >
      <div
        className="relative mx-4 flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--editor-surface)',
          borderColor: 'var(--editor-border)',
          color: 'var(--editor-text)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="relative shrink-0 overflow-hidden border-b px-6 py-5"
          style={{ borderColor: 'var(--editor-border)' }}
        >
          {/* Accent wash. A gradient that fades the accent var straight to
              `transparent` needs no color-mix support, so it renders the same
              everywhere; the opacity keeps it a tint rather than a colour. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.13]"
            style={{
              background:
                'linear-gradient(105deg, var(--editor-accent), transparent 62%)',
            }}
          />
          <div className="relative flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-[color-mix(in_srgb,var(--editor-text)_6%,transparent)]"
                style={{ borderColor: 'var(--editor-border)' }}
              >
                <Command size={17} style={{ color: 'var(--editor-accent)' }} />
              </span>
              <div>
                <h2 className="text-lg font-semibold leading-tight tracking-tight">{title}</h2>
                <p className="mt-0.5 text-[13px] opacity-55">
                  Everything this editor responds to.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 shrink-0 cursor-pointer rounded-md p-1.5 opacity-55 transition-all hover:bg-[color-mix(in_srgb,var(--editor-text)_10%,transparent)] hover:opacity-100"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          {/* CSS columns rather than a grid: the sections are wildly uneven (a
              few gestures vs eight shortcuts) and columns balance the total
              height instead of pairing them row-by-row and leaving a tall
              gap. */}
          <div className="gap-5 sm:columns-2">
            {platformSections(sections).map((section) => {
              const Icon = section.icon
              return (
                <section
                  key={section.heading}
                  className="mb-5 break-inside-avoid rounded-lg border last:mb-0"
                  style={{ borderColor: 'var(--editor-border)', background: 'var(--editor-bg)' }}
                >
                  <div
                    className="flex items-center gap-2.5 border-b px-3.5 py-3"
                    style={{ borderColor: 'var(--editor-border)' }}
                  >
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--editor-text)_6%,transparent)]"
                    >
                      <Icon size={14} style={{ color: 'var(--editor-accent)' }} />
                    </span>
                    <h3 className="text-xs font-semibold uppercase tracking-[0.14em] opacity-70">
                      {section.heading}
                    </h3>
                  </div>
                  <ul className="p-2">
                    {section.entries.map((entry, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--editor-text)_6%,transparent)]"
                      >
                        <span className="flex items-start gap-2.5 opacity-90">
                          {/* A toolbar row shows that button's real glyph;
                              everything else gets a dot. Both occupy the same
                              width, so the labels stay on one left edge to scan
                              down, and the chip-less gesture rows don't read as
                              orphaned text beside the shortcut rows. */}
                          {entry.icon ? (
                            <entry.icon
                              size={14}
                              aria-hidden
                              className="mt-[1px] shrink-0"
                              style={{ color: 'var(--editor-accent)' }}
                            />
                          ) : (
                            <span
                              aria-hidden
                              className="mt-[7px] h-1 w-1 shrink-0 rounded-full opacity-50"
                              style={{ background: 'var(--editor-accent)' }}
                            />
                          )}
                          {entry.label}
                        </span>
                        {entry.where && (
                          /* Deliberately NOT a <kbd>: a surface name is not
                             something you press. Pill, not keycap. */
                          <span
                            className="shrink-0 rounded-full border px-1.5 py-[3px] text-[10px] uppercase opacity-55"
                            style={{
                              borderColor: 'var(--editor-border)',
                              background: 'var(--editor-surface)',
                            }}
                          >
                            {entry.where}
                          </span>
                        )}
                        {entry.keys && entry.keys.length > 0 && (
                          <span className="flex shrink-0 items-center gap-1">
                            {entry.keys.map((k, j) => (
                              <kbd
                                key={j}
                                className="rounded-md border border-b-2 px-2 py-1 font-mono text-[11px] leading-none shadow-sm"
                                style={{
                                  borderColor: 'var(--editor-border)',
                                  background: 'var(--editor-surface)',
                                }}
                              >
                                {k}
                              </kbd>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        </div>

        <div
          className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-3 text-[13px]"
          style={{ borderColor: 'var(--editor-border)' }}
        >
          <kbd
            className="rounded-md border border-b-2 px-2 py-1 font-mono text-[11px] leading-none shadow-sm"
            style={{ borderColor: 'var(--editor-border)', background: 'var(--editor-bg)' }}
          >
            Esc
          </kbd>
          <span className="opacity-55">to close</span>
          <span className="ml-3 opacity-55">v{version}</span>
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
    // One card for every mouse gesture, Preview and Timeline alike. They were
    // two cards, which read as two subjects when they are one — "what the
    // mouse does" — and split seven short rows across a column break. The
    // per-row `where` pill carries the surface the heading used to.
    heading: 'Mouse',
    entries: [
      { icon: Move, where: 'Preview', label: 'Drag to move the selected clip or overlay' },
      { icon: Maximize2, where: 'Preview', label: 'Corner-drag or scroll to scale it' },
      { icon: RotateCw, where: 'Preview', label: 'Drag the rotate handle to turn an overlay' },
      { icon: MoveHorizontal, where: 'Timeline', label: 'Drag a clip to reposition it' },
      { icon: ChevronsLeftRight, where: 'Timeline', label: "Drag a clip's edge to trim it" },
      { icon: MousePointerClick, where: 'Timeline', label: 'Double-click a clip to inspect it' },
      { icon: Timer, where: 'Timeline', label: 'Click the time readout to go to a timecode' },
    ],
  },
  {
    // Icons here are the very buttons in the track-controls bar, in the order
    // they sit there. Keep the two in step: a row whose glyph no longer matches
    // its button is worse than no glyph at all.
    heading: 'Toolbar',
    entries: [
      { icon: SeparatorVertical, label: 'Preview axis: hover the timeline to preview that frame' },
      { icon: Magnet, label: 'Ripple: edits close the gap instead of leaving it' },
      { icon: Crop, label: 'Crop source: non-destructively crop the selected clip (greyed out until you select one)' },
    ],
  },
  {
    heading: 'Keyboard',
    entries: [
      { keys: ['S'], label: 'Split at the playhead' },
      { keys: ['M'], label: 'Drop a marker at the playhead (or the preview axis)' },
      { keys: ['N'], label: 'Add a note' },
      { keys: ['A'], label: 'Toggle the preview axis' },
      { keys: ['⌘', 'A'], label: 'Select everything in the timeline' },
      { keys: ['⇧', 'Delete'], label: 'Ripple-delete the selection' },
      { keys: ['⌘', 'Z'], label: 'Undo' },
      { keys: ['⌘', '⇧', 'Z'], label: 'Redo' },
      { keys: ['⌘', 'C'], label: 'Copy the selection' },
      { keys: ['⌘', 'V'], label: 'Paste at the playhead' },
      { keys: ['⌘', 'D'], label: 'Duplicate the selection in place' },
      { keys: ['⌘', '⌥', 'V'], label: 'Paste attributes onto the selection' },
      { keys: ['⌘', 'K'], label: 'Command palette' },
      { keys: ['J', 'K', 'L'], label: 'Shuttle backward / stop / forward' },
      { keys: ['←', '→'], label: 'Step one frame (⇧ for ten frames)' },
      { keys: ['F'], label: 'Toggle fullscreen preview' },
    ],
  },
]

/** Controls reference for the carousel editor. Sourced from CarouselEditor's key
 *  handlers (undo/redo, Delete) and the canvas gesture hints. */
export const CAROUSEL_CONTROLS: ControlSection[] = [
  {
    heading: 'Canvas',
    entries: [
      { icon: Move, label: 'Drag an element to reposition it' },
      { icon: Maximize2, label: 'Resize or rotate it via the handles' },
      { icon: MousePointerClick, label: 'Double-click text to edit it' },
    ],
  },
  {
    heading: 'Keyboard',
    entries: [
      { keys: ['⌘', 'Z'], label: 'Undo' },
      { keys: ['⌘', '⇧', 'Z'], label: 'Redo' },
      { keys: ['Delete'], label: 'Remove the selected element' },
    ],
  },
]
