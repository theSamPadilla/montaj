import { useEffect, useRef, useState } from 'react'
import type { EditorAdapter, Project } from '../types'
import type { Captions } from '../schema'

interface CaptionRegenModalProps<P extends Project = Project> {
  projectId: string
  /** Adapter driving the caption-regeneration stream. Must implement
   *  `generateCaptions` — callers gate rendering on its presence. */
  adapter: EditorAdapter<P>
  /** Fired on terminal success with the freshly transcribed caption track. The
   *  caller patches `project.captions` from this; the modal then closes. */
  onDone: (captions: Captions) => void
  /** Fired when the modal closes (cancel, error dismiss, or post-done). */
  onClose: () => void
}

function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\[montaj captions\]\s*/, '')
  let color = 'text-gray-400'
  if (/ready|complete|done|transcribed/i.test(t))      color = 'text-green-400'
  else if (/transcrib|detecting|loading|model/i.test(t)) color = 'text-sky-400'
  else if (/extract|building|composing/i.test(t))      color = 'text-amber-400'
  else if (/error|fail|warn/i.test(t))                 color = 'text-red-400'

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {t}
    </span>
  )
}

export default function CaptionRegenModal<P extends Project = Project>({ projectId, adapter, onDone, onClose }: CaptionRegenModalProps<P>) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-3xl bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'done'    && <span className="w-2 h-2 rounded-full bg-green-400" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-white">
                {status === 'running' ? 'Regenerating captions…'
                  : status === 'done' ? 'Captions regenerated'
                  : 'Caption regeneration failed'}
              </h2>
            </div>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">×</button>
          )}
        </div>

        {/* Log output */}
        <div className="relative">
          <button
            onClick={() => navigator.clipboard.writeText(logs.join('\n') + (errorMsg ? '\n' + errorMsg : ''))}
            className="absolute top-2 right-2 z-10 text-[10px] px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
            title="Copy logs"
          >
            Copy
          </button>
          <div
            ref={logRef}
            className="h-96 overflow-y-auto px-4 py-3 font-mono text-[11px] text-gray-300 bg-gray-950 flex flex-col gap-0.5"
          >
            {logs.length === 0 && status === 'running' && (
              <span className="text-gray-600 italic">Starting transcription…</span>
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
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800">
          {status === 'running' ? (
            <button
              onClick={handleCancel}
              className="text-sm px-4 py-1.5 rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300 transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onClose}
              className="text-sm px-4 py-1.5 rounded-md bg-gray-800 border border-gray-700 text-white hover:bg-gray-700 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
