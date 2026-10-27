import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { shortcutText } from '../ui/modifierKeys'

// The rail layout's right-click menu (§587 M7): one list at the pointer. It
// only draws the list and moves through it; each entry's `run` is the handler
// the key or the toolbar already uses.

export interface ContextMenuItem {
  id: string
  label: string
  /** The key, in Mac glyphs; shown with the platform's labels. */
  keys?: readonly string[]
  disabled?: boolean
  run: () => void
}
export type ContextMenuEntry = ContextMenuItem | 'separator'

const EDGE = 8

export default function CanvasContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number
  y: number
  entries: ContextMenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const enabled = entries.filter((e): e is ContextMenuItem => e !== 'separator' && !e.disabled)
  const [activeId, setActiveId] = useState<string | null>(null)

  // Kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - r.width - EDGE))
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - r.height - EDGE))
    setPos({ left, top })
  }, [x, y])

  // The latest list and close, read by the listeners below.
  const live = useRef({ enabled, activeId, onClose })
  live.current = { enabled, activeId, onClose }

  useEffect(() => {
    const run = (item: ContextMenuItem) => {
      live.current.onClose()
      item.run()
    }
    const onKey = (e: KeyboardEvent) => {
      const { enabled: items, activeId: active } = live.current
      const at = items.findIndex((i) => i.id === active)
      const stop = () => { e.preventDefault(); e.stopPropagation() }
      if (e.key === 'Escape') { stop(); live.current.onClose(); return }
      if (e.key === 'ArrowDown') { stop(); if (items.length) setActiveId(items[(at + 1) % items.length].id); return }
      if (e.key === 'ArrowUp') { stop(); if (items.length) setActiveId(items[(at <= 0 ? items.length : at) - 1].id); return }
      if (e.key === 'Home') { stop(); if (items.length) setActiveId(items[0].id); return }
      if (e.key === 'End') { stop(); if (items.length) setActiveId(items[items.length - 1].id); return }
      if (e.key === 'Enter' || e.key === ' ') {
        stop()
        if (at >= 0) run(items[at])
        return
      }
      if (e.key === 'Tab') { stop(); live.current.onClose() }
    }
    // A press elsewhere, a scroll or a window resize closes it (zoom closes it from the editor).
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      live.current.onClose()
    }
    const onAway = () => live.current.onClose()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('wheel', onAway, true)
    window.addEventListener('scroll', onAway, true)
    window.addEventListener('resize', onAway)
    window.addEventListener('blur', onAway)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('wheel', onAway, true)
      window.removeEventListener('scroll', onAway, true)
      window.removeEventListener('resize', onAway)
      window.removeEventListener('blur', onAway)
    }
  }, [])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Canvas menu"
      data-testid="canvas-context-menu"
      className="fixed z-50 min-w-[200px] rounded-lg border border-[var(--editor-border)] bg-[var(--editor-surface)] py-1 text-xs text-[var(--editor-text)] shadow-lg"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) => {
        if (entry === 'separator') {
          return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-[var(--editor-border)]" />
        }
        const active = entry.id === activeId
        return (
          <div
            key={entry.id}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={entry.disabled ? 'true' : undefined}
            data-active={active ? 'true' : undefined}
            className={`flex items-center justify-between gap-6 px-3 py-1.5 ${
              entry.disabled
                ? 'cursor-default opacity-40'
                : `cursor-pointer ${active ? 'bg-[color-mix(in_srgb,var(--editor-text)_10%,transparent)]' : ''} hover:bg-[color-mix(in_srgb,var(--editor-text)_10%,transparent)]`
            }`}
            onPointerEnter={() => { if (!entry.disabled) setActiveId(entry.id) }}
            onClick={() => {
              if (entry.disabled) return
              onClose()
              entry.run()
            }}
          >
            <span>{entry.label}</span>
            {entry.keys && <span className="opacity-60">{shortcutText(entry.keys)}</span>}
          </div>
        )
      })}
    </div>
  )
}
