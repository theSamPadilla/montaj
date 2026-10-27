import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Copy, Plus, Trash2 } from 'lucide-react'
import type { Slide } from '../types'
import { Button } from '../ui'

// §587 M2: the rail layout's canvas, every slide stacked in one vertical scroll.
//
// The ACTIVE slide is the editor's selected slide: the one last clicked, else
// the one most in view while scrolling. This component reports the second; the
// editor owns the first. Slides near the viewport (in view, one either side,
// and the active one) are live, interactive canvases; the rest draw as their
// static thumbnail, so a long carousel does not mount a live canvas per slide.
// The same SlideCanvas instance flips between the two, so a slide coming into
// view keeps what it has drawn and does not flicker.

/** The share of a slide in view is reported at every tenth. */
const THRESHOLDS = Array.from({ length: 11 }, (_, i) => i / 10)

/** The header's height above each slide, px. It sits in the slide's top margin. */
export const SLIDE_HEADER_H = 32

export interface StackedSlidesProps {
  slides: Slide[]
  activeSlideId: string | null
  /** While scrolling, another slide became the one most in view. */
  onScrollActivate: (slideId: string) => void
  /** Scrolls the stack to centre this slide; a new `seq` asks again. */
  scrollTarget: { id: string; seq: number } | null
  /** The scroll container, for the editor's size measure. */
  containerRef?: (el: HTMLDivElement | null) => void
  /** The space kept around each slide (the canvas margin), px. */
  margin: number
  /** The slide scale in effect: when it changes, the view stays centred on the same point of the active slide. */
  scale: number
  renderHeader: (slide: Slide, index: number) => ReactNode
  /** A slide's canvas: `live` asks for the interactive one, else the static thumbnail. */
  renderSlide: (slide: Slide, index: number, live: boolean) => ReactNode
}

export default function StackedSlides({
  slides, activeSlideId, onScrollActivate, scrollTarget, containerRef, margin, scale, renderHeader, renderSlide,
}: StackedSlidesProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    containerRef?.(el)
  }, [containerRef])

  const sectionEls = useRef(new Map<string, HTMLElement>())
  const sectionRef = (id: string) => (el: HTMLElement | null) => {
    if (el) sectionEls.current.set(id, el)
    else sectionEls.current.delete(id)
  }

  // Each slide's share in view, while it is in view at all.
  const ratiosRef = useRef(new Map<string, number>())
  const [inView, setInView] = useState<string[]>([])
  const activeRef = useRef(activeSlideId)
  activeRef.current = activeSlideId
  const onScrollActivateRef = useRef(onScrollActivate)
  onScrollActivateRef.current = onScrollActivate

  const idsKey = slides.map((s) => s.id).join('\n')
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const ratios = ratiosRef.current
    const ids = new Set(idsKey.split('\n'))
    for (const id of [...ratios.keys()]) if (!ids.has(id)) ratios.delete(id)
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.slideSection
        if (!id) continue
        if (e.isIntersecting) ratios.set(id, e.intersectionRatio)
        else ratios.delete(id)
      }
      const shown = [...ratios.keys()].sort()
      setInView((prev) => (prev.length === shown.length && prev.every((id, i) => id === shown[i]) ? prev : shown))
      // The one most in view takes over only when the active one is less so:
      // a tie keeps the slide last clicked.
      let best: string | null = null
      let bestRatio = 0
      for (const [id, r] of ratios) if (r > bestRatio) { best = id; bestRatio = r }
      const active = activeRef.current
      if (best && best !== active && (ratios.get(active ?? '') ?? 0) < bestRatio) onScrollActivateRef.current(best)
    }, { root, threshold: THRESHOLDS })
    for (const el of sectionEls.current.values()) io.observe(el)
    return () => io.disconnect()
  }, [idsKey])

  // Scroll to the slide asked for, before the browser paints and before the
  // observer next reports, so it lands in view as the active slide.
  const handledSeqRef = useRef(0)
  useLayoutEffect(() => {
    if (!scrollTarget || scrollTarget.seq === handledSeqRef.current) return
    const root = rootRef.current
    const el = sectionEls.current.get(scrollTarget.id)
    if (!root || !el) return
    handledSeqRef.current = scrollTarget.seq
    const r = root.getBoundingClientRect()
    const s = el.getBoundingClientRect()
    const top = Math.max(0, root.scrollTop + (s.top - r.top) - (root.clientHeight - s.height) / 2)
    if (typeof root.scrollTo === 'function') root.scrollTo({ top })
    else root.scrollTop = top
  })

  // Zoom keeps the point at the view's centre fixed on the active slide: its
  // place within that slide (as a share of the slide section) is read before
  // the new scale lays out, and put back at the centre after it.
  const scaleRef = useRef(scale)
  const anchorRef = useRef<{ fx: number; fy: number } | null>(null)
  if (scaleRef.current !== scale) {
    scaleRef.current = scale
    const root = rootRef.current
    const el = activeSlideId ? sectionEls.current.get(activeSlideId) : undefined
    const s = el?.getBoundingClientRect()
    const r = root?.getBoundingClientRect()
    anchorRef.current = root && r && s && s.width > 0 && s.height > 0
      ? { fx: (r.left + root.clientWidth / 2 - s.left) / s.width, fy: (r.top + root.clientHeight / 2 - s.top) / s.height }
      : null
  }
  useLayoutEffect(() => {
    const a = anchorRef.current
    anchorRef.current = null
    const root = rootRef.current
    const el = activeSlideId ? sectionEls.current.get(activeSlideId) : undefined
    if (!a || !root || !el) return
    const r = root.getBoundingClientRect()
    const s = el.getBoundingClientRect()
    root.scrollLeft += s.left + a.fx * s.width - (r.left + root.clientWidth / 2)
    root.scrollTop += s.top + a.fy * s.height - (r.top + root.clientHeight / 2)
  }, [scale, activeSlideId])

  // Live: in view, one either side, and the active slide. Before the observer
  // has said anything (or with none), the active slide stands for the view.
  const index = new Map(slides.map((s, i) => [s.id, i] as const))
  const live = new Set<number>()
  const seeds = inView.length > 0 ? inView : activeSlideId ? [activeSlideId] : []
  for (const id of seeds) {
    const i = index.get(id)
    if (i === undefined) continue
    live.add(i - 1).add(i).add(i + 1)
  }
  const activeIdx = activeSlideId ? index.get(activeSlideId) : undefined
  if (activeIdx !== undefined) live.add(activeIdx)

  return (
    <div ref={setRoot} data-slide-stack="" className="flex-1 min-h-0 overflow-auto">
      {/* Wider than the view when zoomed: the column grows and the stack scrolls sideways. */}
      <div className="flex flex-col items-center py-2 w-max min-w-full">
        {slides.map((slide, i) => (
          <section
            key={slide.id}
            ref={sectionRef(slide.id)}
            data-slide-section={slide.id}
            aria-label={`Slide ${i + 1}`}
            className="flex-shrink-0 flex flex-col items-center"
            // The top margin holds the header; the bottom one is the handles'
            // room below the slide, part of the gap to the next.
            style={{ paddingTop: margin, paddingBottom: margin - 16 }}
          >
            <div style={{ position: 'relative', marginLeft: margin, marginRight: margin }}>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: '100%', height: SLIDE_HEADER_H, zIndex: 1 }}>
                {renderHeader(slide, i)}
              </div>
              {renderSlide(slide, i, live.has(i))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

// ── The header above each slide ──────────────────────────────────────────────

export interface SlideHeaderProps {
  index: number
  count: number
  title: string | undefined
  active: boolean
  canEdit: boolean
  /** A press anywhere on the header: the slide becomes active, and a pending crop is applied. */
  onActivate: () => void
  /** The title typed, trimmed; '' clears it. Called once per edit, and only when it changed. */
  onTitleCommit: (title: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDuplicate: () => void
  onDelete: () => void
  onAddAfter: () => void
}

const headerBtn = 'h-7 w-7 p-0 text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]'

/** "Slide N", its title field and its actions. Slides have no hide of their own, so there is none. */
export function SlideHeader({
  index, count, title, active, canEdit, onActivate, onTitleCommit, onMoveUp, onMoveDown, onDuplicate, onDelete, onAddAfter,
}: SlideHeaderProps) {
  const saved = title ?? ''
  const [draft, setDraft] = useState(saved)
  // While the field has focus it is the person's; otherwise it shows the slide's title (an undo, another writer).
  const editingRef = useRef(false)
  const cancelRef = useRef(false)
  useEffect(() => {
    if (!editingRef.current) setDraft(saved)
  }, [saved])

  function commit() {
    if (!editingRef.current) return
    editingRef.current = false
    const next = draft.trim()
    if (cancelRef.current || next === saved) {
      cancelRef.current = false
      setDraft(saved)
      return
    }
    onTitleCommit(next)
  }

  const label = `Slide ${index + 1}`
  return (
    <div
      data-slide-header=""
      className="group flex items-center gap-1 h-full pb-1 text-xs text-[var(--editor-text)]"
      onPointerDown={onActivate}
    >
      <span className="font-semibold whitespace-nowrap">{label}</span>
      <input
        type="text"
        aria-label={`${label} title`}
        placeholder="Add a title"
        value={draft}
        disabled={!canEdit}
        onFocus={() => { editingRef.current = true; onActivate() }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            // Puts the title back; the Esc is the field's, not the canvas's.
            e.preventDefault()
            e.stopPropagation()
            e.nativeEvent.stopImmediatePropagation()
            cancelRef.current = true
            e.currentTarget.blur()
          }
        }}
        onBlur={commit}
        className="min-w-0 flex-1 h-6 px-1 rounded bg-transparent text-xs text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)] placeholder:text-[color-mix(in_srgb,var(--editor-text)_45%,transparent)] hover:bg-[var(--editor-surface)] focus:bg-[var(--editor-surface)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--editor-accent)]"
      />
      <div className={`flex items-center ${active ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
        <Button variant="ghost" className={headerBtn} aria-label="Move slide up" title="Move up" disabled={!canEdit || index === 0} onClick={onMoveUp}><ChevronUp size={14} aria-hidden="true" /></Button>
        <Button variant="ghost" className={headerBtn} aria-label="Move slide down" title="Move down" disabled={!canEdit || index === count - 1} onClick={onMoveDown}><ChevronDown size={14} aria-hidden="true" /></Button>
        <Button variant="ghost" className={headerBtn} aria-label="Duplicate slide" title="Duplicate" disabled={!canEdit} onClick={onDuplicate}><Copy size={14} aria-hidden="true" /></Button>
        <Button variant="ghost" className={headerBtn} aria-label="Delete slide" title="Delete" disabled={!canEdit} onClick={onDelete}><Trash2 size={14} aria-hidden="true" /></Button>
        <Button variant="ghost" className={headerBtn} aria-label="Add slide after" title="Add slide after" disabled={!canEdit} onClick={onAddAfter}><Plus size={14} aria-hidden="true" /></Button>
      </div>
    </div>
  )
}
