import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'

// In-page confirm. No native dialogs. Dark wears the editor's own chrome
// (gray-900 surface, gray-800 border); light the theme vars. Danger is red.

export interface ConfirmDialogProps {
  open: boolean
  title: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger'
  onConfirm: () => void
  onCancel: () => void
  mode?: 'dark' | 'light'
}

export default function ConfirmDialog({
  open, title, confirmLabel, cancelLabel = 'Cancel', tone, onConfirm, onCancel, mode = 'dark',
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const live = useRef({ onConfirm, onCancel })
  live.current = { onConfirm, onCancel }
  const dark = mode === 'dark'
  const danger = tone === 'danger'

  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  // Hand focus back to the opener when the dialog closes.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // Capture phase on window: every key except Tab stays inside the dialog,
    // so Delete or Space never reaches the editor's keymap behind the scrim.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        live.current.onCancel()
      } else if (e.key === 'Enter' && document.activeElement !== cancelRef.current) {
        e.preventDefault()
        live.current.onConfirm()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  const confirmBg = danger ? '#dc2626' : 'var(--editor-accent)'
  const confirmFg = '#fff'
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center text-[var(--editor-text)]"
      style={{ background: dark ? 'rgba(0,0,0,0.55)' : 'rgba(15,23,42,0.35)' }}
      onClick={(e) => { e.stopPropagation(); onCancel() }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320, padding: 16, borderRadius: 8,
          background: dark ? '#111827' : 'var(--editor-surface)',
          border: `1px solid ${dark ? '#1f2937' : 'var(--editor-border)'}`,
          color: dark ? '#f3f4f6' : 'var(--editor-text)',
          boxShadow: dark ? '0 10px 30px rgba(0,0,0,0.5)' : '0 12px 30px rgba(15,23,42,0.18)',
        }}
      >
        {danger && (
          <div
            style={{
              width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(220,38,38,0.12)', color: dark ? '#fca5a5' : '#dc2626', marginBottom: 12,
            }}
          >
            <Trash2 size={16} />
          </div>
        )}
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>{title}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              height: 30, padding: '0 12px', borderRadius: 6, fontSize: 12, background: 'transparent',
              border: `1px solid ${dark ? '#1f2937' : 'var(--editor-border)'}`, color: 'inherit', cursor: 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              height: 30, padding: '0 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: confirmBg, color: confirmFg, border: 0, cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
