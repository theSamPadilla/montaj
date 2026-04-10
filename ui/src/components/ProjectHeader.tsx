import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, Pencil, RefreshCw, AlertCircle } from 'lucide-react'
import { StatusBadge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { Project } from '@/lib/project'

interface ProjectHeaderProps {
  project: Project
  onProjectChange: (p: Project) => void
  actions?: React.ReactNode
}

export default function ProjectHeader({ project, onProjectChange, actions }: ProjectHeaderProps) {
  const navigate = useNavigate()
  const [editing, setEditing]     = useState(false)
  const [nameVal, setNameVal]     = useState(project.name ?? '')
  const [deleting, setDeleting]     = useState(false)
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
    try {
      await api.saveProject(project.id, updated)
    } catch (e) {
      console.error('Failed to save name:', e)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter')  commitName()
    if (e.key === 'Escape') { setEditing(false); setNameVal(project.name ?? '') }
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

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shrink-0">
      <button
        onClick={() => navigate('/')}
        className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-sm transition-colors shrink-0"
      >
        ←
      </button>

      {/* Editable name */}
      {editing ? (
        <input
          ref={inputRef}
          value={nameVal}
          onChange={e => setNameVal(e.target.value)}
          onBlur={commitName}
          onKeyDown={handleKeyDown}
          placeholder="Project name…"
          className="flex-1 min-w-0 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white text-sm font-medium px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-500"
        />
      ) : (
        <button
          onClick={startEdit}
          className="group flex items-center gap-1.5 min-w-0 text-left hover:bg-gray-100 dark:hover:bg-gray-800 rounded px-1.5 py-0.5 -mx-1.5 transition-colors"
          title="Rename project"
        >
          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
            {project.name ?? <span className="text-gray-500 italic">Untitled</span>}
          </span>
          <Pencil size={11} className="shrink-0 text-gray-500 group-hover:text-gray-300 transition-colors" />
        </button>
      )}

      <StatusBadge status={project.status} />

      <button
        onClick={async () => {
          setRefreshing(true)
          setRefreshState('idle')
          const [result] = await Promise.allSettled([
            api.getProject(project.id),
            new Promise(r => setTimeout(r, 1000)),
          ])
          setRefreshing(false)
          if (result.status === 'fulfilled') {
            onProjectChange(result.value)
          } else {
            console.error(result.reason)
            setRefreshState('err')
            setTimeout(() => setRefreshState('idle'), 2500)
          }
        }}
        disabled={refreshing}
        className={[
          'p-1 rounded transition-colors',
          refreshState === 'err'
            ? 'text-red-500 bg-red-50 dark:bg-red-950'
            : 'text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800',
        ].join(' ')}
        title={refreshState === 'err' ? 'Refresh failed — check connection' : 'Refresh project'}
      >
        {refreshState === 'err'
          ? <AlertCircle size={12} />
          : <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />}
      </button>

      <div className="ml-auto flex items-center gap-2">
        {actions}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-1.5 rounded text-gray-400 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Delete project"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}
