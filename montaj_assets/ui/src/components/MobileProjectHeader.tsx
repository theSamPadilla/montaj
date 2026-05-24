import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, RefreshCw, AlertCircle } from 'lucide-react'
import { StatusBadge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface Props {
  project: Project
  onProjectChange: (p: Project) => void
  /** Right-side slot for a primary action (e.g. Render button). */
  actions?: React.ReactNode
}

export default function MobileProjectHeader({ project, onProjectChange, actions }: Props) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [nameVal, setNameVal] = useState(project.name ?? '')
  const [deleting, setDeleting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshState, setRefreshState] = useState<'idle' | 'ok' | 'err'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit() {
    setNameVal(project.name ?? '')
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  async function commitName() {
    setEditing(false)
    const trimmed = nameVal.trim() || null
    if (trimmed === project.name) return
    const updated = { ...project, name: trimmed }
    onProjectChange(updated)
    try { await api.saveProject(project.id, updated) } catch (e) { console.error(e) }
  }

  async function handleDelete() {
    const label = project.name ?? project.id.slice(0, 8)
    if (!window.confirm(`Delete project "${label}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.deleteProject(project.id)
      navigate('/')
    } catch (e) {
      alert(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`)
      setDeleting(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    setRefreshState('idle')
    const [result] = await Promise.allSettled([
      api.getProject(project.id),
      new Promise(r => setTimeout(r, 1000)),
    ])
    setRefreshing(false)
    if (result.status === 'fulfilled') onProjectChange(result.value)
    else { console.error(result.reason); setRefreshState('err'); setTimeout(() => setRefreshState('idle'), 2500) }
  }

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shrink-0">
      {/* Top row: back, name, refresh, delete */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/')}
          className="p-2 -ml-2 text-gray-500 hover:text-gray-900 dark:hover:text-white text-base shrink-0"
          aria-label="Back to projects"
        >
          ←
        </button>

        {editing ? (
          <input
            ref={inputRef}
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setEditing(false); setNameVal(project.name ?? '') } }}
            placeholder="Project name…"
            className="flex-1 min-w-0 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white text-sm font-medium px-2 py-1 rounded border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-500"
          />
        ) : (
          <button onClick={startEdit} className="flex-1 min-w-0 text-left py-1">
            <span className="text-sm font-medium text-gray-900 dark:text-white truncate block">
              {project.name ?? <span className="text-gray-500 italic">Untitled</span>}
            </span>
          </button>
        )}

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className={`p-2 rounded transition-colors shrink-0 ${
            refreshState === 'err'
              ? 'text-red-500 bg-red-50 dark:bg-red-950'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
          aria-label="Refresh"
        >
          {refreshState === 'err' ? <AlertCircle size={16} /> : <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />}
        </button>

        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-2 rounded text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0"
          aria-label="Delete project"
        >
          <Trash2 size={16} />
        </button>
      </div>

      {/* Bottom row: status badge + action slot */}
      <div className="flex items-center justify-between gap-2 px-2">
        <StatusBadge status={project.status} />
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
