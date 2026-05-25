import { useEffect, useRef, useState } from 'react'
import { api, fileUrl } from '@/lib/api'

interface CarouselRenderModalProps {
  projectId: string
  /** Number of slides in the project — drives the gallery row count. */
  slidesCount: number
  /** Slide resolution [width, height] — drives thumbnail aspect ratio. */
  resolution: [number, number]
  /** Fired when the modal closes from a finished or errored state. */
  onClose: () => void
  /** Fired when the user cancels an in-progress render. Falls back to onClose. */
  onCancel?: () => void
}

function slideFile(index: number): string {
  return `slide_${String(index + 1).padStart(2, '0')}.png`
}

function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\[render\]\s*/, '')
  let color = 'text-gray-400'
  if (/done|complete|→/i.test(t))           color = 'text-green-400'
  else if (/rendering|launching|bundling/i.test(t)) color = 'text-sky-400'
  else if (/error|fail/i.test(t))           color = 'text-red-400'

  const prefix = text.startsWith('[render]')
    ? <span className="text-gray-600">[render] </span>
    : null

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {prefix}{t}
    </span>
  )
}

export default function CarouselRenderModal({ projectId, slidesCount, resolution, onClose, onCancel }: CarouselRenderModalProps) {
  const [logs, setLogs]         = useState<string[]>([])
  const [status, setStatus]     = useState<'running' | 'done' | 'error'>('running')
  const [outputDir, setOutDir]  = useState<string | null>(null)
  const [errorMsg, setError]    = useState<string | null>(null)
  const logRef                  = useRef<HTMLDivElement>(null)
  const cancelRef               = useRef<(() => void) | null>(null)
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
    api.renderProject(
      projectId,
      line => { if (!unmountedRef.current) setLogs(l => [...l, line]) },
      path => { if (!unmountedRef.current) { setOutDir(path); setStatus('done') } },
      msg  => { if (!unmountedRef.current) { setError(msg); setStatus('error') } },
    ).then(cancel => {
      if (unmountedRef.current) cancel()
      else cancelRef.current = cancel
    })
    return scheduleCleanup

    function scheduleCleanup() {
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null
        unmountedRef.current = true
        cancelRef.current?.()
        cancelRef.current = null
      }, 0)
    }
  }, [projectId])

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
    cancelRef.current?.()
    ;(onCancel ?? onClose)()
  }

  // ── Done state — gallery + zip download ─────────────────────────────────
  if (status === 'done' && outputDir) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md">
        <div className="w-[96vw] h-[96vh] bg-gray-950 border border-gray-800 rounded-2xl shadow-2xl flex overflow-hidden">

          {/* Left — slide gallery */}
          <div className="flex-1 bg-black flex items-center justify-center overflow-auto p-8">
            <div
              className="grid gap-4 w-full max-w-6xl"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
            >
              {Array.from({ length: slidesCount }).map((_, i) => {
                const file = slideFile(i)
                const url = fileUrl(`${outputDir}/${file}`)
                return (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative block rounded-lg overflow-hidden border border-gray-800 hover:border-gray-600 transition-colors bg-gray-900"
                  >
                    <img
                      src={url}
                      alt={file}
                      className="block w-full h-auto"
                      style={{ aspectRatio: `${resolution[0]} / ${resolution[1]}` }}
                    />
                    <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-black/70 backdrop-blur-sm text-[11px] text-gray-300 font-mono flex justify-between">
                      <span>#{String(i + 1).padStart(2, '0')}</span>
                      <span className="text-gray-500">{file}</span>
                    </div>
                  </a>
                )
              })}
            </div>
          </div>

          {/* Right — info panel */}
          <div className="w-72 shrink-0 flex flex-col border-l border-gray-800">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <div className="flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                <div>
                  <p className="text-sm font-semibold text-white">Render complete</p>
                  <p className="text-xs text-gray-400">
                    {slidesCount} slide{slidesCount === 1 ? '' : 's'} ready.
                  </p>
                </div>
              </div>
              <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">×</button>
            </div>

            <div className="flex flex-col gap-3 p-5 flex-1">
              <p className="text-xs font-mono text-gray-500 break-all leading-relaxed">{outputDir}</p>
              <a
                href={`/api/projects/${projectId}/render-zip`}
                download
                className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-green-800/60 border border-green-700 text-green-200 hover:bg-green-700/60 transition-colors font-medium"
              >
                Download all (.zip)
              </a>
              <button
                onClick={onClose}
                className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Running / error state — log readout ─────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-3xl bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-white">
                {status === 'running' ? 'Rendering slides…' : 'Render failed'}
              </h2>
            </div>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">×</button>
          )}
        </div>

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
              <span className="text-gray-600 italic">Starting render engine…</span>
            )}
            {logs.map((line, i) => (
              <LogLine key={i} text={line} />
            ))}
            {status === 'error' && errorMsg && (
              <span className="text-red-400 mt-1">{errorMsg}</span>
            )}
          </div>
        </div>

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
