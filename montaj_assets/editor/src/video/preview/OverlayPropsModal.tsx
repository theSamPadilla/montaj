import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { cn, inspectorInputClass, SwatchInput } from '../../ui'
import { inferOverlayPropFields, type PropField } from './overlay-prop-fields'

// Remember the dialog's dragged position for the browser session, so it re-opens
// where the operator left it instead of always at the default corner. Scoped to
// sessionStorage (per-tab, survives reloads, clears when the tab closes) and
// guarded so a non-browser/blocked-storage host degrades to the default.
const POS_KEY = 'montaj.overlayPropsModal.pos'

function loadSavedPos(): { x: number; y: number } | null {
  try {
    const raw = sessionStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
    // Clamp into the current viewport so a saved spot never lands off-screen
    // (e.g. after the window shrank), keeping the header grabbable.
    return {
      x: Math.min(Math.max(0, p.x), window.innerWidth - 120),
      y: Math.min(Math.max(0, p.y), window.innerHeight - 60),
    }
  } catch {
    return null
  }
}

function saveSavedPos(p: { x: number; y: number }) {
  try {
    sessionStorage.setItem(POS_KEY, JSON.stringify(p))
  } catch {
    /* storage blocked/unavailable — position just won't persist */
  }
}

interface Props {
  itemProps: Record<string, unknown>
  onSave: (next: Record<string, unknown>) => void
  onClose: () => void
  /** Live-preview every in-progress edit (no history/save) so the overlay
   *  updates as the operator tweaks. Commit happens on Save; Cancel reverts. */
  onPreview?: (next: Record<string, unknown>) => void
  /** Resolve a workspace path to a servable URL (for image thumbnails). */
  fileUrl?: (path: string) => string
  /** Upload a picked file, returning its new workspace path (for image "change"). */
  uploadFile?: (file: File) => Promise<string>
}

// Image prop control: a thumbnail preview plus a file picker that uploads the
// chosen file (via the host adapter) and swaps the prop to the returned path.
// When no uploadFile is available (non-Montaj host), it degrades to an editable
// path text field so the value is still reachable.
function ImageField({
  name,
  value,
  fileUrl,
  uploadFile,
  onChange,
}: {
  name: string
  value: string
  fileUrl?: (path: string) => string
  uploadFile?: (file: File) => Promise<string>
  onChange: (v: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const preview = value ? (fileUrl ? fileUrl(value) : value) : ''

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked later
    if (!file || !uploadFile) return
    setBusy(true)
    setErr(null)
    try {
      onChange(await uploadFile(file))
    } catch (x) {
      setErr(String(x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {preview ? (
        <img
          src={preview}
          alt={name}
          className="h-14 w-14 shrink-0 rounded-md border border-[var(--editor-border,#1f2937)] object-cover bg-black/20"
        />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--editor-border,#1f2937)] text-[10px] text-[var(--editor-text)]/40">
          none
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-mono text-xs text-[var(--editor-text)]/70" title={value}>
          {value ? value.split('/').pop() : '—'}
        </span>
        {uploadFile ? (
          <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-[var(--editor-border,#1f2937)] px-2.5 py-1 text-xs text-[var(--editor-text)]/80 hover:bg-white/5">
            {busy ? 'Uploading…' : 'Change…'}
            <input
              type="file"
              accept="image/*"
              aria-label={name}
              className="hidden"
              onChange={onPick}
              disabled={busy}
            />
          </label>
        ) : (
          <input
            type="text"
            aria-label={name}
            value={value}
            onChange={e => onChange(e.target.value)}
            className={cn(inspectorInputClass, 'font-mono')}
          />
        )}
        {err && <span className="text-[11px] text-red-400">{err}</span>}
      </div>
    </div>
  )
}

export default function OverlayPropsModal({ itemProps, onSave, onClose, onPreview, fileUrl, uploadFile }: Props) {
  const [draft, setDraft] = useState<PropField[]>(() => inferOverlayPropFields(itemProps))

  // Floating, draggable panel (no dimming backdrop) so the overlay stays visible
  // and updates live while editing. `pos` is null until first drag, then a
  // fixed viewport position; the default anchors it top-right, off the centered
  // preview.
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => loadSavedPos())
  const [dragging, setDragging] = useState(false)
  const grabRef = useRef({ dx: 0, dy: 0 })
  const posRef = useRef<{ x: number; y: number } | null>(pos)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!dragging) return
    function onMove(e: MouseEvent) {
      const np = { x: e.clientX - grabRef.current.dx, y: e.clientY - grabRef.current.dy }
      posRef.current = np
      setPos(np)
    }
    function onUp() {
      setDragging(false)
      if (posRef.current) saveSavedPos(posRef.current) // persist once, on drop
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  function startDrag(e: ReactMouseEvent) {
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    grabRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    setPos({ x: rect.left, y: rect.top })
    setDragging(true)
  }

  function mergeProps(fields: PropField[]): Record<string, unknown> {
    const next: Record<string, unknown> = { ...itemProps }
    for (const f of fields) next[f.name] = f.value
    return next
  }

  // Update one field and immediately preview the merged props (live) so the
  // overlay reflects the edit without waiting for Save.
  function setField(name: string, value: string | number | boolean) {
    const nd = draft.map(f => (f.name === name ? { ...f, value } : f))
    setDraft(nd)
    onPreview?.(mergeProps(nd))
  }

  const panelStyle: CSSProperties = {
    position: 'fixed',
    ...(pos ? { left: pos.x, top: pos.y } : { top: 16, right: 16 }),
    // The panel portals to <body>, outside the VideoEditor element that carries
    // the --editor-* theme vars, so those are undefined here — give opaque
    // fallbacks so the panel is solid, not see-through.
    background: 'var(--editor-surface, #111827)',
    borderColor: 'var(--editor-border, #1f2937)',
    color: 'var(--editor-text, #f3f4f6)',
  }

  return createPortal(
    <div
      ref={panelRef}
      className="z-50 w-96 max-h-[85vh] border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      style={panelStyle}
    >
      {/* Header — drag handle */}
      <div
        onMouseDown={startDrag}
        className="flex cursor-move select-none items-center justify-between px-5 py-4 border-b border-[var(--editor-border,#1f2937)]"
      >
        <h2 className="text-sm font-semibold">Edit overlay</h2>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={onClose}
          aria-label="Close"
          className="opacity-55 hover:opacity-100 transition-opacity text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Fields */}
      <div className="flex flex-col gap-3 px-5 py-4 overflow-y-auto">
        {draft.map(f => (
          <div key={f.name} className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--editor-text)]/55">
              {f.name}
            </span>
            {f.kind === 'boolean' ? (
              <input
                type="checkbox"
                aria-label={f.name}
                checked={f.value as boolean}
                onChange={e => setField(f.name, e.target.checked)}
                className="h-4 w-4 accent-[var(--editor-accent)]"
              />
            ) : f.kind === 'number' ? (
              <input
                type="number"
                aria-label={f.name}
                value={f.value as number}
                onChange={e => setField(f.name, e.target.value === '' ? 0 : Number(e.target.value))}
                className={cn(inspectorInputClass, 'text-right')}
              />
            ) : f.kind === 'color' ? (
              <SwatchInput value={String(f.value)} ariaLabel={f.name} onChange={v => setField(f.name, v)} />
            ) : f.kind === 'image' ? (
              <ImageField
                name={f.name}
                value={String(f.value)}
                fileUrl={fileUrl}
                uploadFile={uploadFile}
                onChange={v => setField(f.name, v)}
              />
            ) : (
              <textarea
                aria-label={f.name}
                value={f.value as string}
                rows={1}
                onChange={e => setField(f.name, e.target.value)}
                className={cn(inspectorInputClass, 'h-auto resize-y')}
              />
            )}
          </div>
        ))}
        {draft.length === 0 && (
          <p className="text-sm text-[var(--editor-text)]/55">This overlay has no editable props.</p>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--editor-border,#1f2937)]">
        <button
          onClick={onClose}
          className="text-sm px-4 py-1.5 rounded-md border border-[var(--editor-border,#1f2937)] opacity-80 hover:opacity-100 hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(mergeProps(draft))}
          className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-accent,#6366f1)] text-[var(--editor-accent-foreground,#ffffff)] hover:opacity-90 transition-colors"
        >
          Save
        </button>
      </div>
    </div>,
    document.body,
  )
}
