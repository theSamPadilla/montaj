import { useEffect, useRef, useState } from 'react'
import type { Project, OverlayElement, GlobalOverlay, EditorAdapter } from '../types'
import { Loader } from '../ui/Loader'

// TODO (v2): live thumbnail rendering for each overlay card
// TODO (v2): respect overlay staticFrame when rendering thumbnails — requires API extension

interface Props {
  open: boolean
  onClose: () => void
  project: Project
  adapter: EditorAdapter<Project>
  onPick: (element: OverlayElement) => void
  /** Editor theme mode — light/dark. Only affects the load-error text
   *  (red-400 is sub-AA on a light `--editor-surface`). Absent -> dark,
   *  matching every existing caller. */
  mode?: 'light' | 'dark'
}

export default function OverlayPicker({ open, onClose, project, adapter, onPick, mode = 'dark' }: Props) {
  const [overlays, setOverlays] = useState<GlobalOverlay[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // fetchingRef prevents concurrent fetches; loaded state prevents re-fetch after success
  const fetchingRef = useRef(false)

  useEffect(() => {
    if (!open || loaded || fetchingRef.current) return
    fetchingRef.current = true
    setLoading(true)
    setError(null)

    const promises: Promise<GlobalOverlay[]>[] = [adapter.listGlobalOverlays()]
    if (project.profile) {
      promises.push(adapter.listProfileOverlays?.(project.profile) ?? Promise.resolve([]))
    }

    Promise.all(promises)
      .then(results => {
        // Combine and dedupe by jsxPath
        const seen = new Set<string>()
        const combined: GlobalOverlay[] = []
        for (const list of results) {
          for (const o of list) {
            if (!seen.has(o.jsxPath)) {
              seen.add(o.jsxPath)
              combined.push(o)
            }
          }
        }
        setOverlays(combined)
        setLoaded(true)
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      // fetchingRef reset in finally so a failed fetch can be retried on next open
      .finally(() => { fetchingRef.current = false; setLoading(false) })
  }, [open, loaded, project.profile])

  // Reset loaded state when closed so next open re-fetches fresh data
  useEffect(() => {
    if (!open) setLoaded(false)
  }, [open])

  // Escape key to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function handlePick(overlay: GlobalOverlay) {
    const [w, h] = project.settings.resolution
    const elementW = 800
    const elementH = 200
    const durationProp = overlay.props.find(p => p.name === 'duration')
    const duration = typeof durationProp?.default === 'number' ? durationProp.default : 60
    const props = Object.fromEntries(
      overlay.props
        .filter(p => p.default !== undefined)
        .map(p => [p.name, p.default])
    )
    const element: OverlayElement = {
      id: crypto.randomUUID(),
      type: 'overlay',
      overlay: { template: overlay.jsxPath, props },
      frame: Math.max(0, duration - 1),
      x: Math.round(w / 2 - elementW / 2),
      y: Math.round(h / 2 - elementH / 2),
      w: elementW,
      h: elementH,
      rotation: 0,
    }
    onPick(element)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <h2 className="text-sm font-semibold text-[var(--editor-text)]">Add Overlay</h2>
          <button
            onClick={onClose}
            className="text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex justify-center py-8">
              <Loader size="md" label="Loading overlays" />
            </div>
          )}
          {error && (
            <div className={`text-center text-sm py-8 ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>{error}</div>
          )}
          {!loading && !error && overlays.length === 0 && (
            <div className="text-center text-[var(--editor-text)]/60 text-sm py-8">No overlays available</div>
          )}
          {!loading && !error && overlays.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              {overlays.map(overlay => (
                <button
                  key={overlay.jsxPath}
                  onClick={() => handlePick(overlay)}
                  className="text-left p-3 bg-[var(--editor-surface)] hover:opacity-90 border border-[var(--editor-border)] hover:border-[var(--editor-accent)] rounded-lg transition-colors"
                >
                  <div className="text-sm font-medium text-[var(--editor-text)] truncate">{overlay.name}</div>
                  {overlay.group && (
                    <div className="text-xs text-[var(--editor-accent)] mt-0.5 truncate">{overlay.group}</div>
                  )}
                  {overlay.description && (
                    <div className="text-xs text-[var(--editor-text)]/60 mt-1 line-clamp-2">{overlay.description}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
