import { useEffect, useRef, useState } from 'react'
import { api, fileUrl } from '@/lib/api'

interface Props {
  projectId: string
  /** Number of slides in the project — drives the gallery row count. */
  slidesCount: number
  /** Slide resolution [width, height] — drives thumbnail aspect ratio. */
  resolution: [number, number]
  onClose: () => void
  onCancel?: () => void
}

function slideFile(index: number): string {
  return `slide_${String(index + 1).padStart(2, '0')}.png`
}

function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\[render\]\s*/, '')
  let color = 'text-gray-400'
  if (/done|complete|→/i.test(t))                    color = 'text-green-400'
  else if (/rendering|launching|bundling/i.test(t))  color = 'text-sky-400'
  else if (/error|fail/i.test(t))                    color = 'text-red-400'

  const prefix = text.startsWith('[render]')
    ? <span className="text-gray-600">[render] </span>
    : null

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {prefix}{t}
    </span>
  )
}

export default function MobileCarouselRenderModal({ projectId, slidesCount, resolution, onClose, onCancel }: Props) {
  const [logs, setLogs]         = useState<string[]>([])
  const [status, setStatus]     = useState<'running' | 'done' | 'error'>('running')
  const [outputDir, setOutDir]  = useState<string | null>(null)
  const [errorMsg, setError]    = useState<string | null>(null)
  const logRef                  = useRef<HTMLDivElement>(null)
  const cancelRef               = useRef<(() => void) | null>(null)

  useEffect(() => {
    let unmounted = false
    api.renderProject(
      projectId,
      line => { if (!unmounted) setLogs(l => [...l, line]) },
      path => { if (!unmounted) { setOutDir(path); setStatus('done') } },
      msg  => { if (!unmounted) { setError(msg); setStatus('error') } },
    ).then(cancel => {
      if (unmounted) cancel()
      else cancelRef.current = cancel
    })
    return () => {
      unmounted = true
      cancelRef.current?.()
      cancelRef.current = null
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

  // ── Done state — full-screen slide gallery ──────────────────────────────
  if (status === 'done' && outputDir) {
    return (
      // `fixed inset-0` covers the full viewport including iOS Safari chrome
      <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-md">

        {/* Scrollable slide list */}
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-6">
          {Array.from({ length: slidesCount }).map((_, i) => {
            const url = fileUrl(`${outputDir}/${slideFile(i)}`)
            return (
              <div key={i} className="flex flex-col gap-1">
                <img
                  src={url}
                  alt={slideFile(i)}
                  className="w-full rounded-lg border border-gray-800"
                  style={{ aspectRatio: `${resolution[0]} / ${resolution[1]}` }}
                />
                <p className="text-xs text-gray-500 font-mono text-center">
                  Slide {i + 1} of {slidesCount}
                </p>
              </div>
            )
          })}
        </div>

        {/* Bottom info panel */}
        <div className="shrink-0 bg-gray-950 border-t border-gray-800 p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            <p className="text-sm font-semibold text-white">Render complete</p>
          </div>
          <p className="text-xs font-mono text-gray-500 break-all">{outputDir}</p>
          <button
            onClick={onClose}
            className="w-full text-center text-sm px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-gray-300"
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  // ── Running / error state — bottom-sheet log readout ────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <h2 className="text-sm font-semibold text-white">
              {status === 'running' ? 'Rendering slides…' : 'Render failed'}
            </h2>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none p-1">&times;</button>
          )}
        </div>

        <div
          ref={logRef}
          className="h-64 overflow-y-auto px-3 py-2 font-mono text-[10px] text-gray-300 bg-gray-950 flex flex-col gap-0.5"
        >
          {logs.length === 0 && status === 'running' && (
            <span className="text-gray-600 italic">Starting render engine…</span>
          )}
          {logs.map((line, i) => <LogLine key={i} text={line} />)}
          {status === 'error' && errorMsg && <span className="text-red-400 mt-1">{errorMsg}</span>}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-800">
          {status === 'running' ? (
            <button
              onClick={handleCancel}
              className="text-sm px-4 py-2 rounded-md bg-gray-800 border border-gray-700 text-gray-300"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onClose}
              className="text-sm px-4 py-2 rounded-md bg-gray-800 border border-gray-700 text-white"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
