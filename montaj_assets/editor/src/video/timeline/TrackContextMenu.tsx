import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, EyeOff, Trash2 } from 'lucide-react'

// Right-click menu on a track header: hide/show, then remove.

const EDGE = 8

export interface TrackContextMenuProps {
  x: number
  y: number
  onClose: () => void
  onHide: () => void
  onRemove: () => void
  removeDisabled?: boolean
  /** False → no Remove entry at all (a read-only timeline). Default true. */
  canRemove?: boolean
  hidden?: boolean
  /** Overrides the hide item's text (audio lanes say Mute/Unmute). */
  hideLabel?: string
  mode?: 'dark' | 'light'
}

export default function TrackContextMenu({
  x, y, onClose, onHide, onRemove, removeDisabled, canRemove = true, hidden, hideLabel, mode = 'dark',
}: TrackContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const live = useRef(onClose)
  live.current = onClose
  const dark = mode === 'dark'

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - r.width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - r.height - EDGE)),
    })
  }, [x, y])

  // Hand focus back to whatever had it when the menu opened.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    // Capture phase on window, so the editor's own key handling never sees
    // the Escape that closes the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      live.current()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) live.current()
    }
    // Anything that moves the page out from under the menu closes it.
    const close = () => live.current()
    // Only the window losing focus; an element blur (a click on a menu item
    // moves focus) must not close the menu before the click lands.
    const onBlur = (e: FocusEvent) => { if (e.target === window) live.current() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('resize', close, true)
    window.addEventListener('blur', onBlur, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('resize', close, true)
      window.removeEventListener('blur', onBlur, true)
    }
  }, [])

  const text = dark ? '#D5E3EF' : 'var(--editor-text)'
  const item = (label: string, icon: React.ReactNode, run: () => void, opts: { disabled?: boolean; color?: string } = {}) => (
    <button
      type="button"
      role="menuitem"
      aria-disabled={opts.disabled ? true : undefined}
      className="flex w-full items-center gap-2 px-2.5 text-left hover:bg-[rgba(128,150,170,0.16)]"
      style={{
        height: 32, borderRadius: 7, fontSize: 13, background: 'transparent', border: 0,
        color: opts.color ?? text, opacity: opts.disabled ? 0.4 : 1,
        cursor: opts.disabled ? 'default' : 'pointer',
      }}
      onClick={() => {
        if (opts.disabled) return
        run()
        live.current()
      }}
    >
      {icon}
      {label}
    </button>
  )

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos.left, top: pos.top, zIndex: 60, minWidth: 160, padding: 5,
        borderRadius: 11,
        background: dark ? '#142737' : 'var(--editor-surface)',
        border: `1px solid ${dark ? '#35495F' : 'var(--editor-border)'}`,
        boxShadow: dark ? '0 18px 40px rgba(0,8,16,0.55)' : '0 12px 30px rgba(15,23,42,0.18)',
      }}
    >
      {item(hideLabel ?? (hidden ? 'Show track' : 'Hide track'), hidden ? <Eye size={14} /> : <EyeOff size={14} />, onHide)}
      {canRemove && (
        <>
          <div role="separator" style={{ height: 1, margin: '4px 2px', background: dark ? '#2B3E52' : 'var(--editor-border)' }} />
          {item('Remove track', <Trash2 size={14} />, onRemove, { disabled: removeDisabled, color: dark ? '#F7A3BD' : '#BE185D' })}
        </>
      )}
    </div>,
    document.body,
  )
}
