import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, Pencil, RefreshCw, AlertCircle, Sparkles, Loader2 } from 'lucide-react'
import { StatusBadge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { getVisualItems } from '@/lib/types/schema'
import type { Project } from '@/lib/types/schema'
import ProxyMigrationModal from '@/components/ProxyMigrationModal'
import CaptionActivityIndicator from '@/components/CaptionActivityIndicator'

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
  const [proxyOpen, setProxyOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const needsProxy = (project.settings as { proxy?: boolean } | undefined)?.proxy !== false
    && getVisualItems(project).some(it => it.type === 'video' && it.src && !it.proxySrc)

  // Is the background proxy drain actually running? While it is, this project's
  // unproxied clips are being made ready automatically, so the manual "Generate
  // previews" trigger must NOT show (it reads as "nothing is happening, do it
  // yourself" and invites a redundant re-run). We poll the same global status
  // the ProxyActivityIndicator does — fast while active, slow while idle — only
  // while this project has clips that still need a proxy.
  const [proxyActive, setProxyActive] = useState(false)
  useEffect(() => {
    if (!needsProxy) { setProxyActive(false); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    async function poll() {
      let remaining = 0
      try {
        const s = await api.proxyStatus()
        remaining = s.running + s.queued
      } catch { /* endpoint mid-rollout or a transient error — treat as idle */ }
      if (cancelled) return
      const active = remaining > 0
      setProxyActive(active)
      timer = setTimeout(poll, active ? 3_000 : 10_000)
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [needsProxy])

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
    <>
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

      {needsProxy && (
        proxyActive ? (
          <span
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-gray-500 dark:text-gray-400 shrink-0"
            title="Montaj is making smooth-scrubbing copies of your footage. You can keep editing while this finishes."
          >
            <Loader2 size={11} className="animate-spin" />
            Getting your footage ready to edit
          </span>
        ) : (
          <button
            onClick={() => setProxyOpen(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60 transition-colors shrink-0"
            title="Some clips have no editing preview, so scrubbing is slow. Click to generate them."
          >
            <Sparkles size={11} />
            Generate previews
          </button>
        )
      )}

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
        title={refreshState === 'err' ? 'Refresh failed. Check your connection.' : 'Refresh project'}
      >
        {refreshState === 'err'
          ? <AlertCircle size={12} />
          : <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />}
      </button>

      <div className="ml-auto flex items-center gap-2">
        {/* Proxy activity is already surfaced by this header's own project-
            specific chip above (Generate previews / Getting your footage
            ready), so only the caption-job indicator moves here from the app
            header — the global ProxyActivityIndicator would double it. */}
        <CaptionActivityIndicator />
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
    {proxyOpen && <ProxyMigrationModal project={project} onClose={() => setProxyOpen(false)} />}
    </>
  )
}
