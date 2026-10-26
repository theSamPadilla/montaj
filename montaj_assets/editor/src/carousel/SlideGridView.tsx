import { Plus } from 'lucide-react'
import type { ImageElement, OverlayFactory, Slide } from '../types'
import SlideCanvas from './SlideCanvas'
import { useSlideReorderDrag } from './slideReorderDrag'
import { Button } from '../ui'

// §587 M2 (P1): every slide at once, four to a row, numbered, with an add tile.
// Drag a slide onto another to move it there (one undo step per move); a click
// goes back to the stacked view on that slide.

const THUMB_W = 200

export interface SlideGridViewProps {
  slides: Slide[]
  width: number
  height: number
  activeSlideId: string | null
  onPick: (slideId: string) => void
  onAdd: () => void
  onReorder: (fromIdx: number, toIdx: number) => void
  canEdit: boolean
  resolveImageSrc?: (element: ImageElement) => string
  compileOverlay?: (template: string) => Promise<OverlayFactory>
}

export default function SlideGridView({
  slides, width, height, activeSlideId, onPick, onAdd, onReorder, canEdit, resolveImageSrc, compileOverlay,
}: SlideGridViewProps) {
  const scale = THUMB_W / width
  const thumbH = Math.round(height * scale)
  const { dragOverIdx, handleDragStart, handleDragOver, handleDrop, handleDragEnd } = useSlideReorderDrag(onReorder)

  return (
    <section aria-label="All slides" className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto grid grid-cols-[repeat(4,200px)] gap-x-9 gap-y-10 justify-center content-start py-12 px-4 w-max">
        {slides.map((slide, idx) => {
          const active = slide.id === activeSlideId
          return (
            <div key={slide.id} className="flex flex-col items-center gap-2">
              <div
                data-grid-slide={slide.id}
                role="button"
                tabIndex={0}
                aria-label={`Slide ${idx + 1}`}
                aria-current={active ? 'true' : undefined}
                draggable={canEdit}
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={(e) => { e.preventDefault(); handleDrop(idx) }}
                onDragEnd={handleDragEnd}
                onClick={() => onPick(slide.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(slide.id) }
                }}
                className={`relative cursor-pointer rounded-md overflow-hidden shadow-sm outline-offset-[3px] focus-visible:outline-2 focus-visible:outline-[var(--editor-accent)] ${
                  active ? 'outline outline-2 outline-[var(--editor-accent)]' : ''
                } ${dragOverIdx === idx ? 'opacity-50 ring-2 ring-[var(--editor-accent)]' : ''}`}
                style={{ width: THUMB_W, height: thumbH }}
              >
                <SlideCanvas slide={slide} width={width} height={height} interactive={false} scale={scale} resolveImageSrc={resolveImageSrc} compileOverlay={compileOverlay} />
              </div>
              <span data-grid-number="" className="text-xs font-semibold text-[var(--editor-text)]">{idx + 1}</span>
            </div>
          )
        })}
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="ghost"
            aria-label="Add slide"
            title="Add slide"
            disabled={!canEdit}
            onClick={onAdd}
            className="border-2 border-dashed border-[var(--editor-border)] text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] hover:border-[var(--editor-accent)]"
            style={{ width: THUMB_W, height: thumbH }}
          >
            <Plus size={28} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  )
}
