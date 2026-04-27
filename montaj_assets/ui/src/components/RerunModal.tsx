import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface RerunModalProps {
  project: Project
  onClose: () => void
  onRerun: (updated: Project) => void
}

export default function RerunModal({ project, onClose, onRerun }: RerunModalProps) {
  const [versionName, setVersionName] = useState('')
  const [prompt, setPrompt]           = useState(project.editingPrompt ?? '')
  const [workflow, setWorkflow]       = useState(project.workflow ?? 'clean_cut')
  const [workflows, setWorkflows]     = useState<string[]>(['clean_cut'])
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    api.listWorkflows().then(wfs => setWorkflows(wfs.map(w => w.name))).catch(() => {})
  }, [])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleRun() {
    if (!prompt.trim()) return
    setLoading(true)
    setError(null)
    try {
      const updated = await api.rerun(project.id, {
        prompt:      prompt.trim(),
        workflow,
        versionName: versionName.trim() || undefined,
      })
      onRerun(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-run failed')
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
          <h2 className="text-sm font-semibold text-white">Re-run</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-4">
          {error && <p className="text-xs text-red-400">{error}</p>}

          {/* Version name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">
              Save current version as <span className="text-gray-600 font-normal">(optional)</span>
            </label>
            <input
              ref={nameRef}
              value={versionName}
              onChange={e => setVersionName(e.target.value)}
              placeholder="e.g. tight cuts, no music"
              className="h-9 rounded-md border border-gray-600 bg-gray-800 px-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[11px] text-gray-600">Labels the current edit before it's archived — so you can restore it later.</p>
          </div>

          {/* Prompt */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
              rows={3}
              className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* Workflow */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">Workflow</label>
            <select
              value={workflow}
              onChange={e => setWorkflow(e.target.value)}
              className="h-9 rounded-md border border-gray-600 bg-gray-800 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {workflows.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-800">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button size="sm" onClick={handleRun} disabled={loading || !prompt.trim()}>
            {loading ? 'Starting…' : 'Re-run ⌘↵'}
          </Button>
        </div>
      </div>
    </div>
  )
}
