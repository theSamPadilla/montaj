import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EditorAdapter, Project } from '../types'
import type { Captions } from '../schema'

interface CaptionRegenModalProps<P extends Project = Project> {
  projectId: string
  /** Adapter driving the caption-regeneration stream. Must implement
   *  `generateCaptions` — callers gate rendering on its presence. */
  adapter: EditorAdapter<P>
  /** Caption rows the project has right now (`maxCaptionLane(segments) + 1`,
   *  so 1 for a lane-less or empty track). Regeneration replaces the whole
   *  track with a single fresh row, so this is the count the warning banner
   *  below reports as about to be discarded. */
  existingRowCount: number
  /** Fired on terminal success with the freshly transcribed caption track. The
   *  caller patches `project.captions` from this; the modal then closes. */
  onDone: (captions: Captions) => void
  /** Fired when the modal closes (cancel, error dismiss, or post-done). */
  onClose: () => void
}

function LogLine({ text }: { text: string }) {
  let color = 'text-[var(--editor-text)]/60'
  if (/ready|complete|done|transcribed/i.test(text))      color = 'text-green-400'
  else if (/transcrib|detecting|loading|model/i.test(text)) color = 'text-sky-400'
  else if (/extract|building|composing/i.test(text))      color = 'text-amber-400'
  else if (/error|fail|warn/i.test(text))                 color = 'text-red-400'

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {text}
    </span>
  )
}

export default function CaptionRegenModal<P extends Project = Project>({ projectId, adapter, existingRowCount, onDone, onClose }: CaptionRegenModalProps<P>) {
  const [logs, setLogs]     = useState<string[]>([])
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running')
  const [errorMsg, setError] = useState<string | null>(null)
  const logRef              = useRef<HTMLDivElement>(null)
  const cancelledRef        = useRef(false)
  const unmountedRef        = useRef(false)
  const cleanupTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // React StrictMode in dev fires mount → cleanup → mount synchronously to
    // catch effects that aren't idempotent. Triggering transcription is a
    // non-idempotent effect (spawns sidecar work), so we defer the teardown in
    // cleanup, and if the next mount fires within the same tick we rescue the
    // pending teardown — mirroring RenderModal's StrictMode handling.
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
        for await (const ev of adapter.generateCaptions!(projectId)) {
          if (unmountedRef.current || cancelledRef.current) break
          if (ev.type === 'log') {
            setLogs(l => [...l, ev.message])
          } else if (ev.type === 'done') {
            setStatus('done')
            onDone(ev.captions)
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
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null
        unmountedRef.current = true
      }, 0)
    }
  }, [projectId, adapter, onDone])

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  // Escape to close only when not running
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, onClose])

  function handleCancel() {
    cancelledRef.current = true
    onClose()
  }

  // Portal to document.body so a transformed host ancestor can't trap this
  // `fixed` overlay and push the panel off-screen (see RenderModal).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
      <div className="w-full max-w-3xl bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'done'    && <span className="w-2 h-2 rounded-full bg-green-400" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-[var(--editor-text)]">
                {status === 'running' ? 'Regenerating captions…'
                  : status === 'done' ? 'Captions regenerated'
                  : 'Caption regeneration failed'}
              </h2>
            </div>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
          )}
        </div>

        {/* Discard warning — only when there is more than one row to lose.
            Regeneration always replaces project.captions wholesale with a
            single fresh row (see onDone below), so a hand-built second or
            third row (a title card, a call-out) is silently gone otherwise. */}
        {existingRowCount > 1 && (
          <div className="px-5 py-2 text-[11px] leading-snug text-amber-400/90 border-b border-[var(--editor-border)]">
            This will replace all {existingRowCount} caption rows with a single new row.
          </div>
        )}

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
              <span className="text-[var(--editor-text)]/40 italic">Starting transcription…</span>
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
    </div>,
    document.body,
  )
}
