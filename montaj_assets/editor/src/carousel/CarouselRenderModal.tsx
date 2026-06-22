import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EditorAdapter, Project } from '../types'

interface CarouselRenderModalProps {
  projectId: string
  /** Adapter drives the render stream and path→URL resolution. */
  adapter: EditorAdapter<Project>
  /** Number of slides in the project — drives the gallery row count. */
  slidesCount: number
  /** Slide resolution [width, height] — drives thumbnail aspect ratio. */
  resolution: [number, number]
  /** Fired when the modal closes from a finished or errored state. */
  onClose: () => void
  /** Fired when the user cancels an in-progress render. Falls back to onClose. */
  onCancel?: () => void
  /**
   * Host-supplied export controls (e.g. a "Download all (.zip)" link). Rendered
   * in the done-state info panel. The package no longer hardcodes host URLs.
   */
  exportActions?: ReactNode
}

function slideFile(index: number): string {
  return `slide_${String(index + 1).padStart(2, '0')}.png`
}

function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\[render\]\s*/, '')
  let color = 'text-[var(--editor-text)]/60'
  if (/done|complete|→/i.test(t))           color = 'text-green-400'
  else if (/rendering|launching|bundling/i.test(t)) color = 'text-sky-400'
  else if (/error|fail/i.test(t))           color = 'text-red-400'

  const prefix = text.startsWith('[render]')
    ? <span className="text-[var(--editor-text)]/40">[render] </span>
    : null

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {prefix}{t}
    </span>
  )
}

export default function CarouselRenderModal({ projectId, adapter, slidesCount, resolution, onClose, onCancel, exportActions }: CarouselRenderModalProps) {
  const [logs, setLogs]         = useState<string[]>([])
  const [status, setStatus]     = useState<'running' | 'done' | 'error'>('running')
  const [outputDir, setOutDir]  = useState<string | null>(null)
  const [errorMsg, setError]    = useState<string | null>(null)
  const logRef                  = useRef<HTMLDivElement>(null)
  const cancelledRef            = useRef(false)
  const unmountedRef            = useRef(false)
  const cleanupTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // StrictMode-safe render trigger — see RenderModal.tsx for the long-form
    // comment.
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
      unmountedRef.current = false
      return scheduleCleanup
    }

    unmountedRef.current = false
    cancelledRef.current = false
    ;(async () => {
      try {
        for await (const ev of adapter.render(projectId)) {
          if (cancelledRef.current || unmountedRef.current) break
          if (ev.type === 'log') setLogs(l => [...l, ev.message])
          else if (ev.type === 'done') { setOutDir(ev.outputPath); setStatus('done') }
          else if (ev.type === 'error') { setError(ev.message); setStatus('error') }
        }
      } catch (e) {
        if (!cancelledRef.current && !unmountedRef.current) {
          setError(String(e)); setStatus('error')
        }
      }
    })()
    return scheduleCleanup

    function scheduleCleanup() {
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null
        unmountedRef.current = true
        cancelledRef.current = true
      }, 0)
    }
  }, [projectId, adapter])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, onClose])

  function handleCancel() {
    cancelledRef.current = true
    ;(onCancel ?? onClose)()
  }

  // ── Done state — gallery + zip download ─────────────────────────────────
  if (status === 'done' && outputDir) {
    // Portal to document.body (see RenderModal): a transformed host ancestor
    // would otherwise trap this `fixed` overlay and center the panel off-screen.
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md">
        <div className="w-[96vw] h-[96vh] bg-[var(--editor-bg)] border border-[var(--editor-border)] rounded-2xl shadow-2xl flex overflow-hidden">

          {/* Left — slide gallery */}
          <div className="flex-1 bg-black flex items-center justify-center overflow-auto p-8">
            <div
              className="grid gap-4 w-full max-w-6xl"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
            >
              {Array.from({ length: slidesCount }).map((_, i) => {
                const file = slideFile(i)
                const url = adapter.fileUrl(`${outputDir}/${file}`)
                return (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative block rounded-lg overflow-hidden border border-[var(--editor-border)] hover:border-[var(--editor-accent)] transition-colors bg-[var(--editor-surface)]"
                  >
                    <img
                      src={url}
                      alt={file}
                      className="block w-full h-auto"
                      style={{ aspectRatio: `${resolution[0]} / ${resolution[1]}` }}
                    />
                    <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-black/70 backdrop-blur-sm text-[11px] text-[var(--editor-text)] font-mono flex justify-between">
                      <span>#{String(i + 1).padStart(2, '0')}</span>
                      <span className="text-[var(--editor-text)]/60">{file}</span>
                    </div>
                  </a>
                )
              })}
            </div>
          </div>

          {/* Right — info panel */}
          <div className="w-72 shrink-0 flex flex-col border-l border-[var(--editor-border)]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
              <div className="flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                <div>
                  <p className="text-sm font-semibold text-[var(--editor-text)]">Render complete</p>
                  <p className="text-xs text-[var(--editor-text)]/60">
                    {slidesCount} slide{slidesCount === 1 ? '' : 's'} ready.
                  </p>
                </div>
              </div>
              <button onClick={onClose} className="text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
            </div>

            <div className="flex flex-col gap-3 p-5 flex-1">
              <p className="text-xs font-mono text-[var(--editor-text)]/60 break-all leading-relaxed">{outputDir}</p>
              {exportActions}
              <button
                onClick={onClose}
                className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)] hover:opacity-90 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  // ── Running / error state — log readout ─────────────────────────────────
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-3xl bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-[var(--editor-text)]">
                {status === 'running' ? 'Rendering slides…' : 'Render failed'}
              </h2>
            </div>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => navigator.clipboard.writeText(logs.join('\n') + (errorMsg ? '\n' + errorMsg : ''))}
            className="absolute top-2 right-2 z-10 text-[10px] px-2 py-0.5 rounded bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] hover:border-[var(--editor-accent)] transition-colors"
            title="Copy logs"
          >
            Copy
          </button>
          <div
            ref={logRef}
            className="h-96 overflow-y-auto px-4 py-3 font-mono text-[11px] text-[var(--editor-text)] bg-[var(--editor-bg)] flex flex-col gap-0.5"
          >
            {logs.length === 0 && status === 'running' && (
              <span className="text-[var(--editor-text)]/40 italic">Starting render engine…</span>
            )}
            {logs.map((line, i) => (
              <LogLine key={i} text={line} />
            ))}
            {status === 'error' && errorMsg && (
              <span className="text-red-400 mt-1">{errorMsg}</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--editor-border)]">
          {status === 'running' ? (
            <button
              onClick={handleCancel}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)] hover:bg-red-900/40 hover:border-red-700 hover:text-red-300 transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onClose}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)] hover:opacity-90 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
