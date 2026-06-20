import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { EditorAdapter, Project } from '../types'

interface RenderModalProps<P extends Project = Project> {
  projectId: string
  /** Adapter driving the render stream + file-URL resolution. */
  adapter: EditorAdapter<P>
  /** Fired when the modal closes from a finished or errored state (post-render).
   *  Callers can use this to navigate away or refresh project state. */
  onClose: () => void
  /** Fired when the user cancels an in-progress render via the Cancel button.
   *  Distinct from onClose so callers can dismiss the modal without navigating
   *  away from the editor — the project is unchanged and the user is likely
   *  about to keep editing. Defaults to onClose if not provided (back-compat). */
  onCancel?: () => void
  /** Host-supplied export controls (e.g. a "Download all (.zip)" link) rendered
   *  in the done state's action area, mirroring the carousel render modal. */
  exportActions?: ReactNode
}

function basename(p: string) { return p.split('/').pop() ?? p }

function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\[montaj render\]\s*/, '')
  let color = 'text-[var(--editor-text)]/60'
  if (/ready|complete|done|encoded|assembled/i.test(t))  color = 'text-green-400'
  else if (/rendering|bundling|launching|browsers/i.test(t)) color = 'text-sky-400'
  else if (/trimming|building|composing/i.test(t))       color = 'text-amber-400'
  else if (/frame\s+\d+\/\d+/i.test(t))                  color = 'text-[var(--editor-text)]/55'
  else if (/error|fail|warn/i.test(t))                   color = 'text-red-400'

  const prefix = text.startsWith('[montaj render]')
    ? <span className="text-[var(--editor-text)]/40">[render] </span>
    : null

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {prefix}{t}
    </span>
  )
}

export default function RenderModal<P extends Project = Project>({ projectId, adapter, onClose, onCancel, exportActions }: RenderModalProps<P>) {
  const [logs, setLogs]         = useState<string[]>([])
  const [status, setStatus]     = useState<'running' | 'done' | 'error'>('running')
  const [outputPath, setOutput] = useState<string | null>(null)
  const [errorMsg, setError]    = useState<string | null>(null)
  const logRef                  = useRef<HTMLDivElement>(null)
  const cancelledRef            = useRef(false)
  const unmountedRef            = useRef(false)
  const cleanupTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // React StrictMode in dev fires mount → cleanup → mount synchronously to
    // catch effects that aren't idempotent. Triggering a render is the textbook
    // non-idempotent effect (spawns a subprocess), so we have to handle it
    // explicitly: defer the teardown in cleanup, and if the next mount fires
    // within the same tick, rescue the pending teardown.
    //
    // Without this, every render in dev would consume two render streams against
    // the same workspace, racing on segment files and producing corrupted output
    // — the bug we tracked down.
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
      unmountedRef.current = false
      cancelledRef.current = false
      return scheduleCleanup
    }

    unmountedRef.current = false
    cancelledRef.current = false

    void (async () => {
      try {
        for await (const ev of adapter.render(projectId)) {
          if (unmountedRef.current || cancelledRef.current) break
          if (ev.type === 'log') {
            setLogs(l => [...l, ev.message])
          } else if (ev.type === 'done') {
            setOutput(ev.outputPath)
            setStatus('done')
          } else {
            setError(ev.message)
            setStatus('error')
          }
        }
      } catch (e) {
        if (!unmountedRef.current && !cancelledRef.current) {
          setError(e instanceof Error ? e.message : String(e))
          setStatus('error')
        }
      }
    })()

    return scheduleCleanup

    function scheduleCleanup() {
      // Defer the actual teardown. StrictMode's transient unmount fires before
      // the next mount; setTimeout(0) puts the teardown after both, giving the
      // next mount a chance to clearTimeout it. On real unmount the timer fires
      // and the render stream is abandoned for real.
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null
        unmountedRef.current = true
      }, 0)
    }
  }, [projectId, adapter])

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  // Escape to close only when done/error
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, onClose])

  function handleCancel() {
    cancelledRef.current = true
    // Use onCancel when provided so the host can dismiss without navigating
    // (cancelling an in-progress render shouldn't yank the user away from
    // their editor). Falls back to onClose for back-compat with callers that
    // haven't been updated.
    ;(onCancel ?? onClose)()
  }

  if (status === 'done' && outputPath) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md">
        <div className="w-[96vw] h-[96vh] bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-2xl shadow-2xl flex overflow-hidden">

          {/* Left — video */}
          <div className="flex-1 bg-black flex items-center justify-center overflow-hidden">
            <video
              src={adapter.fileUrl(outputPath)}
              controls
              autoPlay
              playsInline
              className="h-full w-full object-contain"
            />
          </div>

          {/* Right — info panel */}
          <div className="w-72 shrink-0 flex flex-col border-l border-[var(--editor-border)]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
              <div className="flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                <div>
                  <p className="text-sm font-semibold text-[var(--editor-text)]">Render complete</p>
                  <p className="text-xs text-[var(--editor-text)]/60">Your video is ready.</p>
                </div>
              </div>
              <button onClick={onClose} className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
            </div>

            <div className="flex flex-col gap-3 p-5 flex-1">
              <p className="text-xs font-mono text-[var(--editor-text)]/55 break-all leading-relaxed">{outputPath}</p>
              {/* Host-supplied export controls (e.g. download-all .zip). */}
              {exportActions}
              <a
                href={adapter.fileUrl(outputPath)}
                download={basename(outputPath)}
                className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-green-800/60 border border-green-700 text-green-200 hover:bg-green-700/60 transition-colors font-medium"
              >
                Download
              </a>
              <button
                onClick={onClose}
                className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/80 hover:opacity-90 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-3xl bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-[var(--editor-text)]">
                {status === 'running' ? 'Rendering…' : 'Render failed'}
              </h2>
            </div>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
          )}
        </div>

        {/* Log output */}
        <div className="relative">
          <button
            onClick={() => navigator.clipboard.writeText(logs.join('\n') + (errorMsg ? '\n' + errorMsg : ''))}
            className="absolute top-2 right-2 z-10 text-[10px] px-2 py-0.5 rounded bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] hover:border-[var(--editor-border)] transition-colors"
            title="Copy logs"
          >
            Copy
          </button>
          <div
            ref={logRef}
            className="h-96 overflow-y-auto px-4 py-3 font-mono text-[11px] text-[var(--editor-text)]/80 bg-[var(--editor-surface)] flex flex-col gap-0.5"
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

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--editor-border)]">
          {status === 'running' ? (
            <button
              onClick={handleCancel}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/80 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300 transition-colors"
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
    </div>
  )
}
