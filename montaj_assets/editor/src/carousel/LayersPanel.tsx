import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Eye, EyeOff, GripVertical, Lock, LockOpen, Shapes, Type } from 'lucide-react'
import type { CarouselElement, ImageElement, OverlayElement } from '../types'
import type { ReorderDirection } from '../state/project-reducer'
import { isLocked } from './lock'
import { isTextOverlay } from './textStyle'

const iconBtn =
  'flex items-center justify-center h-7 w-7 rounded-md text-[var(--editor-text)] hover:bg-[var(--editor-surface)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]'

/** A layer row's label: a text's words, an image's file name, an overlay's template name. */
export function layerName(el: CarouselElement): string {
  if (el.type === 'image') {
    const file = el.src.split(/[\\/]/).pop() ?? el.src
    try { return decodeURIComponent(file) || 'Image' } catch { return file || 'Image' }
  }
  if (isTextOverlay(el)) {
    const t = String(el.overlay.props.text).replace(/\s+/g, ' ').trim()
    return t || 'Text'
  }
  return (el as OverlayElement).overlay.template || 'Element'
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
  elements, slideLabel, selectedIds, hiddenElementIds, onToggleElementVisibility, resolveImageSrc, canEdit,
  onSelect, onToggleLock, onReorderSelection, onMove,
}: LayersPanelProps) {
  const rows = [...elements].reverse()
  const selected = new Set(selectedIds)
  const hidden = new Set(hiddenElementIds ?? [])
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; where: 'above' | 'below' } | null>(null)
  const dragRef = useRef<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

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
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]">{slideLabel}</span>
        <div className="flex gap-0.5">
          {header('Bring to front', 'front', ChevronsUp)}
          {header('Bring forward', 'forward', ArrowUp)}
          {header('Send backward', 'backward', ArrowDown)}
          {header('Send to back', 'back', ChevronsDown)}
        </div>
      </div>
      <ul ref={listRef} aria-label="Layers" className="flex flex-col gap-0.5 px-2 pb-2">
        {rows.map((el) => {
          const on = selected.has(el.id)
          const locked = isLocked(el)
          const isHidden = hidden.has(el.id)
          const name = layerName(el)
          return (
            <li
              key={el.id}
              data-layer-id={el.id}
              draggable={canEdit}
              onDragStart={(e) => {
                dragRef.current = el.id
                setDragId(el.id)
                if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', el.id) }
              }}
              onDragOver={(e) => {
                if (!dragRef.current) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                setOver({ id: el.id, where: e.clientY < r.top + r.height / 2 ? 'above' : 'below' })
              }}
              onDrop={(e) => {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const where = e.clientY < r.top + r.height / 2 ? 'above' : 'below'
                const from = dragRef.current
                dragRef.current = null
                setDragId(null)
                setOver(null)
                if (!from) return
                onMove(selected.has(from) ? selectedIds : [from], el.id, where)
              }}
              onDragEnd={() => { dragRef.current = null; setDragId(null); setOver(null) }}
              className={`flex items-center gap-1.5 h-10 pl-1 pr-1 rounded-md ${on ? 'bg-[var(--editor-surface)] ring-1 ring-[var(--editor-accent)]' : 'hover:bg-[var(--editor-surface)]'} ${dragId === el.id ? 'opacity-50' : ''} ${over?.id === el.id ? (over.where === 'above' ? 'border-t-2 border-[var(--editor-accent)]' : 'border-b-2 border-[var(--editor-accent)]') : ''}`}
            >
              <span aria-hidden="true" className="cursor-grab text-[color-mix(in_srgb,var(--editor-text)_40%,transparent)]"><GripVertical size={14} /></span>
              <button
                type="button"
                aria-pressed={on}
                aria-label={`Select ${name}`}
                title={name}
                onClick={(e) => onSelect(el.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                className={`flex-1 min-w-0 flex items-center gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] rounded ${isHidden ? 'opacity-50' : ''}`}
              >
                <span className="flex-shrink-0 flex items-center justify-center h-7 w-7 rounded border border-[var(--editor-border)] bg-[var(--editor-bg)] overflow-hidden">
                  {el.type === 'image'
                    ? <img src={resolveImageSrc(el)} alt="" draggable={false} className="h-full w-full object-cover" />
                    : isTextOverlay(el) ? <Type size={14} aria-hidden="true" /> : <Shapes size={14} aria-hidden="true" />}
                </span>
                <span className="truncate">{name}</span>
              </button>
              <button
                type="button"
                className={iconBtn}
                aria-label={locked ? `Unlock ${name}` : `Lock ${name}`}
                title={locked ? 'Unlock' : 'Lock'}
                disabled={!canEdit}
                onClick={() => onToggleLock(el.id)}
              >
                {locked ? <Lock size={14} /> : <LockOpen size={14} className="opacity-50" />}
              </button>
              {onToggleElementVisibility && (
                <button
                  type="button"
                  className={iconBtn}
                  aria-label={isHidden ? `Show ${name}` : `Hide ${name}`}
                  title={isHidden ? 'Show' : 'Hide'}
                  onClick={() => onToggleElementVisibility(el.id)}
                >
                  {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
            </li>
          )
        })}
        <li data-layer-background className="flex items-center gap-2 h-10 pl-6 pr-2 text-xs text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]">
          Background
        </li>
      </ul>
    </div>
  )
}
