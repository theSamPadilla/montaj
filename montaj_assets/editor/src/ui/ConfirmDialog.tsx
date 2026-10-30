import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'

// In-page confirm. No native dialogs.

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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        live.current.onCancel()
      } else if (e.key === 'Enter' && document.activeElement !== cancelRef.current) {
        e.preventDefault()
        live.current.onConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const confirmBg = danger ? (dark ? '#F16890' : '#BE185D') : 'var(--editor-accent)'
  const confirmFg = danger ? (dark ? '#2A0614' : '#fff') : '#fff'
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: dark ? 'rgba(2,7,16,0.55)' : 'rgba(15,23,42,0.35)' }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 340, padding: 20, borderRadius: 16,
          background: dark ? '#101B2C' : 'var(--editor-surface)',
          border: `1px solid ${dark ? '#35495F' : 'var(--editor-border)'}`,
          color: dark ? '#D5E3EF' : 'var(--editor-text)',
        }}
      >
        {danger && (
          <div
            style={{
              width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(241,104,144,0.12)', color: dark ? '#F16890' : '#BE185D', marginBottom: 12,
            }}
          >
            <Trash2 size={16} />
          </div>
        )}
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{title}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, background: 'transparent',
              border: `1px solid ${dark ? '#35495F' : 'var(--editor-border)'}`, color: 'inherit', cursor: 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: confirmBg, color: confirmFg, border: 0, cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
