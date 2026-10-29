import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Copy, Plus, Trash2 } from 'lucide-react'
import type { Slide } from '../types'
import { railFaintPlaceholder, railIconBtnSm, railMuted } from './railStyles'

// §587 M2: the rail layout's canvas, every slide stacked in one vertical scroll.
//
// The ACTIVE slide is the editor's selected slide: the one last clicked, else
// the one most in view while scrolling. This component reports the second; the
// editor owns the first. While an element is selected the active slide is the
// selection's and stays: the person scrolling the selected element far out of
// view (see SELECTION_AWAY_PX) lets it go, and only then does the slide most in
// view take over. Another slide coming more into view alone takes nothing. Slides near the viewport (in view, one either side,
// and the active one) are live, interactive canvases; two away they draw as
// their static thumbnail; further still as a placeholder the slide's size and
// colour, so a long carousel mounts neither a canvas nor its overlays per slide.
// The same SlideCanvas instance flips between live and thumbnail, so a slide
// coming into view keeps what it has drawn and does not flicker.

/** The share of a slide in view is reported at every tenth. */
const THRESHOLDS = Array.from({ length: 11 }, (_, i) => i / 10)

/** How a slide in the stack is drawn: the interactive canvas, its static thumbnail, or a placeholder its size. */
export type StackSlideMode = 'live' | 'thumb' | 'placeholder'

/** The header's height above each slide, px. It sits in the slide's top margin. */
export const SLIDE_HEADER_H = 32

/** How far past the stack's visible edge, px, the whole selection must be before
 *  a scroll lets it go: one slide header, so a selection just out of view stays. */
export const SELECTION_AWAY_PX = SLIDE_HEADER_H

/** Whether box `a` lies wholly outside box `b` grown by `m` on every side. */
function farOutside(a: DOMRect, b: DOMRect, m: number): boolean {
  return a.bottom < b.top - m || a.top > b.bottom + m || a.right < b.left - m || a.left > b.right + m
}

export interface StackedSlidesProps {
  slides: Slide[]
  activeSlideId: string | null
  /** While the person scrolls, another slide became the one most in view. A layout change alone never calls it. */
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
  /** A slide's canvas, drawn as `mode` says. Return an element whose props stay the same for an unchanged slide (a memoised component), so a render of the stack renders only what changed. */
  renderSlide: (slide: Slide, index: number, mode: StackSlideMode) => ReactNode
  /** The selected elements' ids, on the active slide. While there are any, a scroll changes no slide. */
  selectedElementIds?: readonly string[]
  /** The person scrolled the whole selection far out of view: the editor lets it go (and applies a crop). */
  onSelectionScrolledAway?: () => void
  /** A click (press and release) on the grey around the slides, outside any slide's own canvas and header. */
  onBackdropClick?: () => void
}

export default function StackedSlides({
  slides, activeSlideId, onScrollActivate, scrollTarget, containerRef, margin, scale, renderHeader, renderSlide,
  selectedElementIds, onSelectionScrolledAway, onBackdropClick,
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
  const selectedRef = useRef<readonly string[]>([])
  selectedRef.current = selectedElementIds ?? []
  const onAwayRef = useRef(onSelectionScrolledAway)
  onAwayRef.current = onSelectionScrolledAway

  /** The slide most in view takes over when the active one is less so: a tie keeps the slide last clicked. */
  const activateMostInView = () => {
    let best: string | null = null
    let bestRatio = 0
    for (const [id, r] of ratiosRef.current) if (r > bestRatio) { best = id; bestRatio = r }
    const active = activeRef.current
    if (best && best !== active && (ratiosRef.current.get(active ?? '') ?? 0) < bestRatio) onScrollActivateRef.current(best)
  }

  /** On a scroll by the person: whether the whole selection now lies far out of
   *  view. Its elements' boxes are the ones drawn on the active slide; with none
   *  drawn, the slide's own box stands for them. */
  const selectionFarAway = (root: HTMLElement): boolean => {
    const ids = selectedRef.current
    const active = activeRef.current
    if (ids.length === 0 || !active) return false
    const section = sectionEls.current.get(active)
    if (!section) return false
    const view = root.getBoundingClientRect()
    const boxes = [...section.querySelectorAll<HTMLElement>('[data-element-id]')]
      .filter((el) => ids.includes(el.getAttribute('data-element-id') ?? ''))
      .map((el) => el.getBoundingClientRect())
    if (boxes.length === 0) boxes.push(section.getBoundingClientRect())
    return boxes.every((b) => farOutside(b, view, SELECTION_AWAY_PX))
  }

  // Only the person scrolling picks another slide. A layout change (a panel
  // opening, the zoom) or the stack's own scroll also moves what is in view, and
  // must not take the active slide (and its selection) away. So a report
  // activates only when a scroll or wheel came from the person since the last
  // one; a scale change and the stack's own scrolls clear that, and the scroll
  // event the stack's own scroll fires (at the position it set) is not counted.
  const userScrollRef = useRef(false)
  const ownScrollRef = useRef<{ top: number; left: number } | null>(null)
  const scrolledByStack = (root: HTMLElement) => {
    userScrollRef.current = false
    ownScrollRef.current = { top: root.scrollTop, left: root.scrollLeft }
  }
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onScroll = () => {
      const own = ownScrollRef.current
      ownScrollRef.current = null
      if (own && Math.abs(root.scrollTop - own.top) <= 1 && Math.abs(root.scrollLeft - own.left) <= 1) return
      userScrollRef.current = true
      if (selectionFarAway(root)) {
        // Let go now: the observer's next report (and this one, if none comes) picks the slide in view.
        selectedRef.current = []
        onAwayRef.current?.()
        activateMostInView()
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return
      ownScrollRef.current = null
      userScrollRef.current = true
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    root.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      root.removeEventListener('wheel', onWheel)
    }
  }, [])

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
      const byUser = userScrollRef.current
      userScrollRef.current = false
      // A selection holds its slide until it is scrolled far away.
      if (!byUser || selectedRef.current.length > 0) return
      activateMostInView()
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
    scrolledByStack(root)
  })

  // Zoom keeps the point at the view's centre fixed on the active slide: its
  // place within that slide (as a share of the slide section) is read before
  // the new scale lays out, and put back at the centre after it.
  const scaleRef = useRef(scale)
  const anchorRef = useRef<{ fx: number; fy: number } | null>(null)
  if (scaleRef.current !== scale) {
    scaleRef.current = scale
    userScrollRef.current = false
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
    scrolledByStack(root)
  }, [scale, activeSlideId])

  // Live: in view, one either side, and the active slide. Thumbnail: two away.
  // Before the observer has said anything (or with none), the active slide
  // stands for the view.
  const index = new Map(slides.map((s, i) => [s.id, i] as const))
  const live = new Set<number>()
  const near = new Set<number>()
  const seeds = inView.length > 0 ? inView : activeSlideId ? [activeSlideId] : []
  for (const id of seeds) {
    const i = index.get(id)
    if (i === undefined) continue
    live.add(i - 1).add(i).add(i + 1)
    near.add(i - 2).add(i + 2)
  }
  const activeIdx = activeSlideId ? index.get(activeSlideId) : undefined
  if (activeIdx !== undefined) live.add(activeIdx)
  const modeOf = (i: number): StackSlideMode => (live.has(i) ? 'live' : near.has(i) ? 'thumb' : 'placeholder')

  // The grey around the slides is these boxes themselves (the scroll area, the
  // column, a slide's section); a press inside a slide's canvas, its margin or
  // its header lands on something deeper. Only a press that began there ends
  // there as a click, so a drag-select let go off the slide clears nothing.
  const backdropDown = useRef(false)
  const onBackdrop = (e: { target: EventTarget }) => (e.target as HTMLElement).hasAttribute?.('data-stack-bg')
  return (
    <div
      ref={setRoot}
      data-slide-stack=""
      data-stack-bg=""
      className="flex-1 min-h-0 overflow-auto"
      onPointerDown={(e) => { backdropDown.current = onBackdrop(e) }}
      onClick={(e) => {
        const began = backdropDown.current
        backdropDown.current = false
        if (began && onBackdrop(e)) onBackdropClick?.()
      }}
    >
      {/* Wider than the view when zoomed: the column grows and the stack scrolls sideways. */}
      <div data-stack-bg="" className="flex flex-col items-center py-2 w-max min-w-full">
        {slides.map((slide, i) => (
          <section
            key={slide.id}
            ref={sectionRef(slide.id)}
            data-slide-section={slide.id}
            data-stack-bg=""
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
              {renderSlide(slide, i, modeOf(i))}
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
  /** A press anywhere on the header but Delete: the slide becomes active, and a pending crop is applied. */
  onActivate: () => void
  /** The title typed, trimmed; '' clears it. Called once per edit, and only when it changed. */
  onTitleCommit: (title: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDuplicate: () => void
  onDelete: () => void
  onAddAfter: () => void
}

const headerBtn = railIconBtnSm

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
        className={`min-w-0 flex-1 h-6 px-1 rounded-md bg-transparent text-xs ${railMuted} ${railFaintPlaceholder} hover:bg-[var(--editor-surface)] focus:bg-[var(--editor-surface)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]`}
      />
      <div className={`flex items-center ${active ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
        <button type="button" className={headerBtn} aria-label="Move slide up" title="Move up" disabled={!canEdit || index === 0} onClick={onMoveUp}><ChevronUp size={16} aria-hidden="true" /></button>
        <button type="button" className={headerBtn} aria-label="Move slide down" title="Move down" disabled={!canEdit || index === count - 1} onClick={onMoveDown}><ChevronDown size={16} aria-hidden="true" /></button>
        <button type="button" className={headerBtn} aria-label="Duplicate slide" title="Duplicate" disabled={!canEdit} onClick={onDuplicate}><Copy size={16} aria-hidden="true" /></button>
        {/* Deleting a slide makes no slide active: the press stays off the header, so the active slide and its selection stay. */}
        <button type="button" className={headerBtn} aria-label="Delete slide" title="Delete" disabled={!canEdit} onPointerDown={(e) => e.stopPropagation()} onClick={onDelete}><Trash2 size={16} aria-hidden="true" /></button>
        <button type="button" className={headerBtn} aria-label="Add slide after" title="Add slide after" disabled={!canEdit} onClick={onAddAfter}><Plus size={16} aria-hidden="true" /></button>
      </div>
    </div>
  )
}
