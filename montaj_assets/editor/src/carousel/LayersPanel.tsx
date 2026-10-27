import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, ArrowUp, Blocks, TextCursor, ChevronsDown, ChevronsUp, Eye, EyeOff, GripVertical, Lock, LockOpen } from 'lucide-react'
import type { CarouselElement, ImageElement, OverlayElement } from '../types'
import type { ReorderDirection } from '../state/project-reducer'
import { isLocked } from './lock'
import { moveToLayer } from './layerOrder'
import { isTextOverlay } from './textStyle'
import { railEyebrow, railFaint, railHoverBg, railIconBtn, railMuted, railSelectedBg } from './railStyles'

/** How far a press moves before it is a drag and not a click, in px. */
const DRAG_START_PX = 4

type DropAt = { id: string; where: 'above' | 'below' }

// A row is 40px: its lock and eye take Montaj's 32px tool.
const iconBtn = railIconBtn

/** A layer row's label: a text's words, an image's file name, an overlay's template name. */
export function layerName(el: CarouselElement, overlayLabel?: (template: string) => string | undefined): string {
  if (el.type === 'image') {
    const file = el.src.split(/[\\/]/).pop() ?? el.src
    try { return decodeURIComponent(file) || 'Image' } catch { return file || 'Image' }
  }
  if (isTextOverlay(el)) {
    const t = String(el.overlay.props.text).replace(/\s+/g, ' ').trim()
    return t || 'Text'
  }
  const template = (el as OverlayElement).overlay.template
  return overlayLabel?.(template) || template || 'Element'
}

export interface LayersPanelProps {
  /** The active slide's elements, back first (index 0) to front, as stored. */
  elements: CarouselElement[]
  slideLabel: string
  selectedIds: string[]
  hiddenElementIds?: string[]
  /** Absent: no eye toggle. */
  onToggleElementVisibility?: (elementId: string) => void
  resolveImageSrc: (el: ImageElement) => string
  /** A shipped shape, line or frame's tile label, by its template path; undefined for any other template. */
  overlayLabel?: (template: string) => string | undefined
  canEdit: boolean
  /** A plain click selects the row; Shift/Cmd/Ctrl-click toggles it in the selection. */
  onSelect: (elementId: string, additive: boolean) => void
  onToggleLock: (elementId: string) => void
  onReorderSelection: (direction: ReorderDirection) => void
  /** Moves `ids` (any order) so they sit just above (`before`) or below the target row on screen. */
  onMove: (ids: string[], targetId: string, where: 'above' | 'below') => void
}

/** The Layers rail panel (§587 M4): the active slide's elements front to back. */
export default function LayersPanel({
  elements, slideLabel, selectedIds, hiddenElementIds, onToggleElementVisibility, resolveImageSrc, overlayLabel, canEdit,
  onSelect, onToggleLock, onReorderSelection, onMove,
}: LayersPanelProps) {
  const rows = [...elements].reverse()
  const selected = new Set(selectedIds)
  const hidden = new Set(hiddenElementIds ?? [])
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<DropAt | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // The click a finished drag leaves behind (on the row it began on, when it
  // ends there) is not a select.
  const swallowClickRef = useRef(false)
  const endDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endDragRef.current?.(), [])

  // Read when the pointer moves, which may be before the next render.
  const live = useRef({ elements, selectedIds, onMove })
  live.current = { elements, selectedIds, onMove }

  /** The ids a drag of `from` moves: the whole selection when it is in it. */
  const movingIds = (from: string) => {
    const ids = live.current.selectedIds
    return ids.includes(from) ? ids : [from]
  }

  /** Where a drop at `clientY` puts the rows, by the rows' places on screen:
   *  above or below the row under the pointer by its halves, and past the
   *  first or last row, at that end. Null when nothing would move. */
  function dropAt(ids: string[], clientY: number): DropAt | null {
    const rowEls = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-layer-id]') ?? [])
    if (rowEls.length === 0) return null
    let at: DropAt | null = null
    for (const row of rowEls) {
      const r = row.getBoundingClientRect()
      if (clientY < r.bottom || row === rowEls[rowEls.length - 1]) {
        at = { id: row.dataset.layerId!, where: clientY < r.top + r.height / 2 ? 'above' : 'below' }
        break
      }
    }
    if (!at) return null
    const els = live.current.elements
    return moveToLayer(els, ids, at.id, at.where) === els ? null : at
  }

  /** A press on a row: past `DRAG_START_PX` it drags the row (the selection
   *  when the row is in it), and a release drops it where the line shows. A
   *  press that does not move is left to the click, which selects. */
  function onRowPointerDown(e: ReactPointerEvent<HTMLLIElement>, id: string) {
    swallowClickRef.current = false
    if (!canEdit || e.button !== 0 || endDragRef.current) return
    // The row's own buttons (lock, eye) keep their press.
    if ((e.target as Element).closest?.('[data-layer-action]')) return
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    // Frozen at the press: the selection can change under a long drag.
    const ids = movingIds(id)
    const move = (ev: PointerEvent) => {
      // A release the page never saw (outside the window, over a menu).
      if (ev.buttons === 0) { end(); return }
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return
        dragging = true
        setDragId(id)
      }
      ev.preventDefault()
      setOver(dropAt(ids, ev.clientY))
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
      endDragRef.current = null
      setDragId(null)
      setOver(null)
    }
    const up = (ev: PointerEvent) => {
      if (dragging) {
        // The click comes in this same task, if at all; a later one (a key) is a select again.
        swallowClickRef.current = true
        setTimeout(() => { swallowClickRef.current = false }, 0)
        const target = dropAt(ids, ev.clientY)
        if (target) live.current.onMove(ids, target.id, target.where)
      }
      end()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', end)
    endDragRef.current = end
  }

  // The newest selected row scrolls into view.
  const lastSelected = selectedIds[selectedIds.length - 1]
  useEffect(() => {
    if (!lastSelected) return
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-layer-id]') ?? []).find((r) => r.dataset.layerId === lastSelected)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [lastSelected])

  const header = (label: string, dir: ReorderDirection, Icon: typeof ArrowUp) => (
    <button type="button" className={iconBtn} aria-label={label} title={label} disabled={!canEdit || selectedIds.length === 0} onClick={() => onReorderSelection(dir)}>
      <Icon size={16} />
    </button>
  )

  return (
    <div className="flex flex-col text-[var(--editor-text)]">
      <div className="flex items-center justify-between px-3 pt-3 pb-0.5">
        <span className={railEyebrow}>{slideLabel}</span>
        <div className="flex gap-0.5">
          {header('Bring to front', 'front', ChevronsUp)}
          {header('Bring forward', 'forward', ArrowUp)}
          {header('Send backward', 'backward', ArrowDown)}
          {header('Send to back', 'back', ChevronsDown)}
        </div>
      </div>
      <ul
        ref={listRef}
        aria-label="Layers"
        className="flex flex-col gap-0.5 px-2 pb-2"
        style={dragId ? { cursor: 'grabbing' } : undefined}
        onClickCapture={(e) => {
          if (!swallowClickRef.current) return
          swallowClickRef.current = false
          e.stopPropagation()
          e.preventDefault()
        }}
      >
        {rows.map((el) => {
          const on = selected.has(el.id)
          const locked = isLocked(el)
          const isHidden = hidden.has(el.id)
          const name = layerName(el, overlayLabel)
          return (
            <li
              key={el.id}
              data-layer-id={el.id}
              onPointerDown={(e) => onRowPointerDown(e, el.id)}
              // Inline, so a host's stylesheet cannot lose them: the row is a grab handle, the line its drop place.
              style={{ position: 'relative', userSelect: 'none', WebkitUserSelect: 'none', cursor: canEdit ? (dragId ? 'grabbing' : 'grab') : undefined }}
              className={`flex items-center gap-1.5 h-10 pl-1 pr-1 rounded-xl ${on ? railSelectedBg : railHoverBg} ${dragId && (dragId === el.id || (selected.has(dragId) && on)) ? 'opacity-50' : ''}`}
            >
              {over?.id === el.id && (
                <span
                  aria-hidden="true"
                  data-layer-drop-line={over.where}
                  style={{ position: 'absolute', left: 0, right: 0, height: 2, borderRadius: 1, pointerEvents: 'none', background: 'var(--editor-accent)', ...(over.where === 'above' ? { top: -2 } : { bottom: -2 }) }}
                />
              )}
              <span aria-hidden="true" className={railFaint}><GripVertical size={14} /></span>
              <button
                type="button"
                aria-pressed={on}
                aria-label={`Select ${name}`}
                title={name}
                onClick={(e) => onSelect(el.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                style={{ cursor: 'inherit' }}
                className={`flex-1 min-w-0 flex items-center gap-2 text-left text-[13px] text-[var(--editor-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] rounded-md ${on ? 'font-semibold' : ''} ${isHidden ? 'opacity-40' : ''}`}
              >
                <span className={`flex-shrink-0 flex items-center justify-center h-7 w-7 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] overflow-hidden ${railMuted}`}>
                  {el.type === 'image'
                    ? <img src={resolveImageSrc(el)} alt="" draggable={false} className="h-full w-full object-cover" />
                    : isTextOverlay(el) ? <TextCursor size={16} aria-hidden="true" /> : <Blocks size={16} aria-hidden="true" />}
                </span>
                <span className="truncate">{name}</span>
              </button>
              <button
                type="button"
                className={iconBtn}
                data-layer-action
                aria-label={locked ? `Unlock ${name}` : `Lock ${name}`}
                title={locked ? 'Unlock' : 'Lock'}
                disabled={!canEdit}
                onClick={() => onToggleLock(el.id)}
              >
                {locked ? <Lock size={16} /> : <LockOpen size={16} className="opacity-60" />}
              </button>
              {onToggleElementVisibility && (
                <button
                  type="button"
                  className={iconBtn}
                  data-layer-action
                  aria-label={isHidden ? `Show ${name}` : `Hide ${name}`}
                  title={isHidden ? 'Show' : 'Hide'}
                  onClick={() => onToggleElementVisibility(el.id)}
                >
                  {isHidden ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              )}
            </li>
          )
        })}
        <li data-layer-background className={`flex items-center gap-2 h-10 pl-6 pr-2 text-[13px] ${railMuted}`}>
          Background
        </li>
      </ul>
    </div>
  )
}
