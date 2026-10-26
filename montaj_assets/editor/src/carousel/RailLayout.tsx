import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Images, Shapes, Type, Palette, Sparkles, Layers, PaintBucket, StickyNote, LayoutGrid, Undo2, Redo2, X, type LucideIcon } from 'lucide-react'
import type { CarouselRailItemId } from '../types'
import { shortcutText } from '../ui/modifierKeys'

/** The rail's items, in order. Later tasks fill panels through `CarouselEditorProps.railPanels`. */
export const CAROUSEL_RAIL_ITEMS: ReadonlyArray<{ id: CarouselRailItemId; label: string; icon: LucideIcon }> = [
  { id: 'media', label: 'Media', icon: Images },
  { id: 'elements', label: 'Elements', icon: Shapes },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'brand', label: 'Brand', icon: Palette },
  { id: 'ai-image', label: 'AI image', icon: Sparkles },
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'background', label: 'Background', icon: PaintBucket },
  { id: 'notes', label: 'Notes', icon: StickyNote },
]

/** A panel nothing fills yet: its title. */
export function RailPanelPlaceholder({ title }: { title: string }) {
  return <div className="p-4 text-sm font-semibold text-[var(--editor-text)]">{title}</div>
}

const barBtn =
  'flex items-center justify-center h-8 min-w-8 px-2 rounded-md text-xs text-[var(--editor-text)] hover:bg-[var(--editor-surface)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]'

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a }

/** "1080 × 1350" for the top bar's read-only size label. */
export function sizeLabel(w: number, h: number): string {
  return `${w} × ${h}`
}

export interface RailLayoutProps {
  topLeft?: ReactNode
  topRight?: ReactNode
  size: [number, number]
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  /** The canvas area (centred, scrolls on its own). */
  canvas: ReactNode
  /** Panel content per item; a missing one shows the placeholder. */
  panels: Partial<Record<CarouselRailItemId, ReactNode>>
  /** Called before any panel opens or closes (the editor applies a pending crop). */
  onBeforeToggle: () => void
  slideIds: string[]
  selectedSlideId: string | null
  onSelectSlide: (id: string) => void
  onOpenControls: () => void
}

/** The rail layout's shell: top bar, rail + side panel, canvas, right panel, bottom bar. */
export default function RailLayout({
  topLeft, topRight, size, onUndo, onRedo, canUndo, canRedo, canvas, panels, onBeforeToggle,
  slideIds, selectedSlideId, onSelectSlide, onOpenControls,
}: RailLayoutProps) {
  const [side, setSide] = useState<Exclude<CarouselRailItemId, 'notes'> | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [slidesOpen, setSlidesOpen] = useState(false)

  function toggle(id: CarouselRailItemId) {
    onBeforeToggle()
    // Notes and the side panel are one "active rail item": opening either closes the other.
    if (id === 'notes') {
      setNotesOpen((o) => !o)
      setSide(null)
    } else {
      setSide((s) => (s === id ? null : id))
      setNotesOpen(false)
    }
  }
  function closeNotes() {
    onBeforeToggle()
    setNotesOpen(false)
  }
  function onPanelKey(e: KeyboardEvent, close: () => void) {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close()
  }

  const sideItem = CAROUSEL_RAIL_ITEMS.find((i) => i.id === side)
  const notesItem = CAROUSEL_RAIL_ITEMS.find((i) => i.id === 'notes')!
  const idx = Math.max(0, slideIds.indexOf(selectedSlideId ?? ''))
  const g = gcd(size[0], size[1]) || 1
  const ratio = `${size[0] / g}:${size[1] / g}`

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header aria-label="Top bar" className="flex-shrink-0 flex items-center justify-between gap-3 h-12 px-3 border-b border-[var(--editor-border)] bg-[var(--editor-bg)]">
        <div className="flex items-center gap-2 min-w-0">
          {topLeft}
          <span className="text-xs text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] whitespace-nowrap" title={`Aspect ${ratio}`}>{sizeLabel(size[0], size[1])}</span>
          <button type="button" className={barBtn} onClick={onUndo} disabled={!canUndo} aria-label="Undo" title={`Undo (${shortcutText(['⌘', 'Z'])})`}><Undo2 size={16} /></button>
          <button type="button" className={barBtn} onClick={onRedo} disabled={!canRedo} aria-label="Redo" title={`Redo (${shortcutText(['⌘', '⇧', 'Z'])})`}><Redo2 size={16} /></button>
        </div>
        <div className="flex items-center gap-2 min-w-0">{topRight}</div>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav aria-label="Editor rail" className="flex-shrink-0 w-[72px] flex flex-col items-stretch gap-1 py-2 border-r border-[var(--editor-border)] bg-[var(--editor-bg)] overflow-y-auto">
          {CAROUSEL_RAIL_ITEMS.map(({ id, label, icon: Icon }) => {
            const on = id === 'notes' ? notesOpen : side === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(id)}
                className={`mx-1 flex flex-col items-center justify-center gap-1 py-2 rounded-md text-[11px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] ${
                  on ? 'bg-[var(--editor-surface)] text-[var(--editor-accent-text,var(--editor-accent))]' : 'text-[var(--editor-text)] hover:bg-[var(--editor-surface)]'
                }`}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </button>
            )
          })}
        </nav>

        {sideItem && (
          <section
            aria-label={`${sideItem.label} panel`}
            tabIndex={-1}
            onKeyDown={(e) => onPanelKey(e, () => { onBeforeToggle(); setSide(null) })}
            className="flex-shrink-0 w-[320px] overflow-y-auto border-r border-[var(--editor-border)] bg-[var(--editor-bg)] text-[var(--editor-text)]"
          >
            {panels[sideItem.id] ?? <RailPanelPlaceholder title={sideItem.label} />}
          </section>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">{canvas}</div>

        {notesOpen && (
          <aside
            aria-label={`${notesItem.label} panel`}
            tabIndex={-1}
            onKeyDown={(e) => onPanelKey(e, closeNotes)}
            className="flex-shrink-0 w-[360px] flex flex-col min-h-0 border-l border-[var(--editor-border)] bg-[var(--editor-bg)] text-[var(--editor-text)]"
          >
            <div className="flex-shrink-0 flex items-center justify-between px-3 h-10 border-b border-[var(--editor-border)]">
              <span className="text-sm font-semibold">{notesItem.label}</span>
              <button type="button" className={barBtn} onClick={closeNotes} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">{panels.notes ?? <RailPanelPlaceholder title={notesItem.label} />}</div>
          </aside>
        )}
      </div>

      <footer aria-label="Bottom bar" className="relative flex-shrink-0 flex items-center justify-end gap-2 h-11 px-3 border-t border-[var(--editor-border)] bg-[var(--editor-bg)]">
        <button type="button" className={barBtn} disabled aria-label="Zoom">Fit</button>
        <button
          type="button"
          className={barBtn}
          aria-expanded={slidesOpen}
          aria-haspopup="listbox"
          aria-label={`Slides ${idx + 1} / ${slideIds.length}`}
          onClick={() => { onBeforeToggle(); setSlidesOpen((o) => !o) }}
        >
          Slides {idx + 1} / {slideIds.length}
        </button>
        <button type="button" className={barBtn} disabled aria-label="Grid view"><LayoutGrid size={16} /></button>
        <button type="button" className={barBtn} onClick={onOpenControls} aria-label="Controls" title="Editor controls & shortcuts">?</button>
        {slidesOpen && (
          <ul role="listbox" aria-label="Slides" className="absolute bottom-12 right-24 max-h-64 overflow-y-auto min-w-32 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] py-1 shadow-lg z-40">
            {slideIds.map((id, i) => (
              <li key={id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={id === selectedSlideId}
                  aria-label={`Slide ${i + 1}`}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--editor-bg)] ${id === selectedSlideId ? 'font-semibold text-[var(--editor-accent-text,var(--editor-accent))]' : 'text-[var(--editor-text)]'}`}
                  onClick={() => { onSelectSlide(id); setSlidesOpen(false) }}
                >
                  Slide {i + 1}
                </button>
              </li>
            ))}
          </ul>
        )}
      </footer>
    </div>
  )
}
