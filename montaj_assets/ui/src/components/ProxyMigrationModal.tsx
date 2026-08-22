import { useEffect, useRef, useState } from 'react'
import { Sparkles, Gauge, AudioLines, Palette, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface ProxyMigrationModalProps {
  project: Project
  onClose: () => void
}

export default function ProxyMigrationModal({ project, onClose }: ProxyMigrationModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [result, setResult]   = useState<{ scheduled: number; alreadyFresh: number } | null>(null)
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Cancel the pending auto-close if the modal is dismissed (Esc, backdrop,
  // header ×) before it fires, so we never setState after unmount.
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
    }
  }, [])

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.generateProxies(project.id)
      setResult(res)
      setLoading(false)
      // SSE drives the live project updates as proxies land — there is no
      // updated project to merge here. Show the confirmation briefly, then
      // close on its own so the user isn't left hunting for a button. The
      // modal stays manually dismissible the whole time (Esc/backdrop/×).
      closeTimeoutRef.current = setTimeout(onClose, 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start proxy generation')
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col gap-0 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-500/15">
              <Sparkles size={14} className="text-amber-400" />
            </span>
            <h2 className="text-sm font-semibold text-white">Migrate this project to V4</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-4">
          {error && <p className="text-xs text-red-400">{error}</p>}

          {result ? (
            result.scheduled > 0 ? (
              <p className="text-sm text-emerald-400">
                Migrating {result.scheduled} clips in the background. The timeline will fill in as they finish.
              </p>
            ) : result.alreadyFresh > 0 ? (
              <p className="text-sm text-emerald-400">This project is already on V4.</p>
            ) : (
              <p className="text-sm text-amber-400">Nothing to migrate. The source files for this project are missing.</p>
            )
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-300">
                This project was made in an older version of Montaj. Migrating updates it for the V4 editor:
              </p>
              <ul className="flex flex-col gap-2.5">
                <li className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10">
                    <Gauge size={16} className="text-sky-400" />
                  </span>
                  <span className="text-sm text-gray-200">Smoother playback and scrubbing</span>
                </li>
                <li className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
                    <AudioLines size={16} className="text-violet-400" />
                  </span>
                  <span className="text-sm text-gray-200">Audio waveforms on the timeline</span>
                </li>
                <li className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                    <Palette size={16} className="text-amber-400" />
                  </span>
                  <span className="text-sm text-gray-200">Corrected color</span>
                </li>
              </ul>
              <div className="flex items-start gap-2 rounded-lg bg-gray-800/50 px-3 py-2">
                <Clock size={13} className="mt-0.5 shrink-0 text-gray-500" />
                <p className="text-xs text-gray-400">
                  Runs in the background, so you can keep editing. It can take a few minutes.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {!result && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-800">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
            <Button size="sm" onClick={handleGenerate} disabled={loading}>
              {loading ? 'Starting...' : 'Migrate now'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
