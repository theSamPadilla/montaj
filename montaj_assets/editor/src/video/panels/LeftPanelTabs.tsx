import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../ui'
import { usePersistentState } from '../../ui/usePersistentState'

export interface LeftPanelTab {
  /** Stable id, also the persisted value. */
  id: string
  /** Rendered above the label in the rail. Callers pass a lucide icon element. */
  icon: ReactNode
  /** Short rail label, also the tab's accessible name. */
  label: string
  /** Panel body. Lazily mounted (see below). */
  content: ReactNode
}

export interface LeftPanelTabsProps {
  tabs: LeftPanelTab[]
  /** Tab shown when nothing is persisted (or the persisted id is stale).
   *  Defaults to `tabs[0].id` when omitted or not found in `tabs`. */
  defaultTabId?: string
  /** localStorage key for the active-tab preference.
   *  Default: 'montaj.editor.leftPanelTab'. */
  storageKey?: string
  className?: string
}

const DEFAULT_STORAGE_KEY = 'montaj.editor.leftPanelTab'

/**
 * Generic, presentational tabbed shell for the editor's left browser panel.
 * Knows nothing about media/captions/versions — the host supplies tabs and
 * this component only handles the rail, persistence, and lazy mounting.
 */
export default function LeftPanelTabs({ tabs, defaultTabId, storageKey = DEFAULT_STORAGE_KEY, className }: LeftPanelTabsProps) {
  const baseId = useId()
  const buttonRefs = useRef(new Map<string, HTMLButtonElement | null>())

  const resolvedDefaultId =
    defaultTabId !== undefined && tabs.some(t => t.id === defaultTabId) ? defaultTabId : tabs[0]?.id

  const [activeId, setActiveId] = usePersistentState<string>(
    storageKey,
    resolvedDefaultId ?? '',
    // Reject anything that isn't a string, or that isn't the id of a tab
    // that exists right now — a stale id from an older build (a tab that's
    // since been renamed or removed) falls back to the default rather than
    // rendering a blank pane.
    raw => (typeof raw === 'string' && tabs.some(t => t.id === raw) ? raw : null),
  )

  // Stale-tab safety at render time too: `tabs` can change after mount (a
  // host swapping which tabs it offers). If the persisted/active id no
  // longer names a real tab, fall back to the resolved default instead of
  // rendering nothing.
  const currentId = tabs.some(t => t.id === activeId) ? activeId : resolvedDefaultId

  // Lazy mount, then keep mounted: a tab's `content` isn't rendered into the
  // tree until that tab is first activated (the Media tab can be heavy and
  // shouldn't mount until asked for), but once mounted it stays mounted and
  // is only hidden on switch-away (the Captions tab owns sub-control state —
  // sub-tabs, pickers, scroll position — that must survive a tab switch).
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set(currentId ? [currentId] : []))
  if (currentId && !mountedIds.has(currentId)) {
    setMountedIds(prev => {
      const next = new Set(prev)
      next.add(currentId)
      return next
    })
  }

  function moveFocus(nextId: string) {
    setActiveId(nextId)
    buttonRefs.current.get(nextId)?.focus()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, tabId: string) {
    const ids = tabs.map(t => t.id)
    const idx = ids.indexOf(tabId)
    if (idx === -1) return
    let nextIdx: number
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        nextIdx = (idx + 1) % ids.length
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIdx = (idx - 1 + ids.length) % ids.length
        break
      case 'Home':
        nextIdx = 0
        break
      case 'End':
        nextIdx = ids.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    moveFocus(ids[nextIdx])
  }

  return (
    <div className={cn('flex h-full min-h-0', className)}>
      <div
        role="tablist"
        aria-orientation="vertical"
        className="w-16 shrink-0 flex flex-col overflow-y-auto border-r border-[var(--editor-border)] bg-[var(--editor-bg)]"
      >
        {tabs.map(tab => {
          const selected = tab.id === currentId
          return (
            <button
              key={tab.id}
              ref={el => { buttonRefs.current.set(tab.id, el) }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(tab.id)}
              onKeyDown={e => handleKeyDown(e, tab.id)}
              className={cn(
                'relative flex flex-col items-center gap-1 px-1 py-2.5 text-[10px] transition-colors',
                selected
                  ? 'text-[var(--editor-accent)] bg-[var(--editor-accent)]/10'
                  : 'text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] hover:bg-[var(--editor-text)]/5',
              )}
            >
              {selected && (
                <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--editor-accent)]" aria-hidden="true" />
              )}
              {/* Decorative — the label carries the accessible name. */}
              <span className="text-base leading-none" aria-hidden="true">{tab.icon}</span>
              <span className="leading-tight text-center">{tab.label}</span>
            </button>
          )
        })}
      </div>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {tabs
          .filter(tab => mountedIds.has(tab.id))
          .map(tab => {
            const active = tab.id === currentId
            return (
              <div
                key={tab.id}
                role="tabpanel"
                id={`${baseId}-panel-${tab.id}`}
                aria-labelledby={`${baseId}-tab-${tab.id}`}
                hidden={!active}
                style={active ? undefined : { display: 'none' }}
                className="flex-1 min-h-0 flex flex-col overflow-hidden"
              >
                {tab.content}
              </div>
            )
          })}
      </div>
    </div>
  )
}
