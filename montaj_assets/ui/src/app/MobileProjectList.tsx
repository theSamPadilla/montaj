import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { StatusBadge, WorkflowBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

export default function MobileProjectList() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api.listProjects().then(setProjects).catch(console.error).finally(() => setLoading(false))
  }, [])

  return (
    <div className="p-3 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Projects</h1>
        <Button onClick={() => navigate('/projects/new')} size="sm">
          + New
        </Button>
      </div>

      {loading && <p className="text-gray-400 text-sm">Loading…</p>}

      {!loading && projects.length === 0 && (
        <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center">
          <p className="text-gray-500 text-sm mb-2">No projects yet.</p>
          <p className="text-xs text-gray-400">Tap &quot;+ New&quot; to create one.</p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {projects.map(p => (
          <div key={p.id} className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <button onClick={() => navigate(`/projects/${p.id}`)} className="flex-1 min-w-0 text-left">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {p.name ?? p.id.slice(0, 8)}
                </p>
                {p.projectType === 'carousel' && (
                  <span className="shrink-0 inline-flex items-center rounded-full bg-fuchsia-500/10 px-1.5 py-0.5 text-[9px] font-medium text-fuchsia-500 border border-fuchsia-500/20 uppercase">
                    Carousel
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 truncate mt-0.5">{p.editingPrompt}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <StatusBadge status={p.status} />
                <WorkflowBadge workflow={p.workflow} />
              </div>
            </button>
            <button
              onClick={async (e) => {
                e.stopPropagation()
                if (!window.confirm(`Delete project "${p.name ?? p.id.slice(0, 8)}"?`)) return
                await api.deleteProject(p.id)
                setProjects(prev => prev.filter(x => x.id !== p.id))
              }}
              className="p-2 rounded text-gray-400 hover:text-red-500 dark:text-gray-500"
              aria-label="Delete"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-8 pt-6 border-t border-gray-100 dark:border-gray-800">
        <p className="text-xs text-gray-500 leading-relaxed">
          Open-source video editing toolkit. AI-native, CLI-first, agent-friendly.
        </p>
        <p className="text-[10px] text-gray-400 mt-2 font-mono">v{__APP_VERSION__}</p>
      </div>
    </div>
  )
}
