import { useEffect, useRef, useState } from 'react'
import { api, fileUrl } from '@/lib/api'

interface Props {
  projectId: string
  onClose: () => void
  onCancel?: () => void
}

function basename(p: string) { return p.split('/').pop() ?? p }

function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\[montaj render\]\s*/, '')
  let color = 'text-gray-400'
  if (/ready|complete|done|encoded|assembled/i.test(t)) color = 'text-green-400'
  else if (/rendering|bundling|launching|browsers/i.test(t)) color = 'text-sky-400'
  else if (/trimming|building|composing/i.test(t)) color = 'text-amber-400'
  else if (/frame\s+\d+\/\d+/i.test(t)) color = 'text-gray-500'
  else if (/error|fail|warn/i.test(t)) color = 'text-red-400'
  const prefix = text.startsWith('[montaj render]')
    ? <span className="text-gray-600">[render] </span> : null
  return <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>{prefix}{t}</span>
}

export default function MobileRenderModal({ projectId, onClose, onCancel }: Props) {
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running')
  const [outputPath, setOutput] = useState<string | null>(null)
  const [errorMsg, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let unmounted = false
    api.renderProject(
      projectId,
      line => { if (!unmounted) setLogs(l => [...l, line]) },
      path => { if (!unmounted) { setOutput(path); setStatus('done') } },
      msg  => { if (!unmounted) { setError(msg); setStatus('error') } },
    ).then(cancel => {
      if (unmounted) cancel()
      else cancelRef.current = cancel
    })
    return () => { unmounted = true; cancelRef.current?.(); cancelRef.current = null }
  }, [projectId])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [logs])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && status !== 'running') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, onClose])

  function handleCancel() { cancelRef.current?.(); (onCancel ?? onClose)() }

  if (status === 'done' && outputPath) {
    return (
      // Note: `h-[100svh]` (small viewport height) avoids the iOS Safari URL-bar issue
      // where `h-screen` includes the collapsed URL bar's reserved space.
      <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-md">
        <div className="flex-1 bg-black flex items-center justify-center overflow-hidden p-2">
          <video
            src={fileUrl(outputPath)}
            controls
            autoPlay
            playsInline
            className="max-h-full max-w-full"
          />
        </div>
        <div className="shrink-0 bg-gray-950 border-t border-gray-800 p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            <p className="text-sm font-semibold text-white">Render complete</p>
          </div>
          <p className="text-xs font-mono text-gray-500 break-all">{outputPath}</p>
          <a
            href={fileUrl(outputPath)}
            download={basename(outputPath)}
            className="w-full text-center text-sm px-4 py-3 rounded-lg bg-green-800/60 border border-green-700 text-green-200 font-medium"
          >
            Download
          </a>
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

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'error' && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <h2 className="text-sm font-semibold text-white">
              {status === 'running' ? 'Rendering…' : 'Render failed'}
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
