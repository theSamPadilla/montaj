import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Trash2 } from 'lucide-react'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

export default function ProjectList() {
  const [projects, setProjects]   = useState<Project[]>([])
  const [loading, setLoading]     = useState(true)
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied]       = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    api.listProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false))
    api.getInfo()
      .then(info => setSkillPath(info.skill_path))
      .catch(() => {})
  }, [])

  function copyGetStarted() {
    if (!skillPath) return
    navigator.clipboard.writeText(`Read ${skillPath} and help me get started with Montaj`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="p-6 max-w-3xl mx-auto overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Projects</h1>
        <Button onClick={() => navigate('/projects/new')} size="sm">
          + New project
        </Button>
      </div>

      {loading && <p className="text-gray-400 text-sm">Loading…</p>}

      {!loading && projects.length === 0 && (
        <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-12 text-center">
          <p className="text-gray-500 mb-2">No projects yet.</p>
          <p className="text-sm text-gray-400">
            Click <strong className="text-gray-600 dark:text-gray-300">+ New project</strong> or run{' '}
            <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded text-gray-700 dark:text-gray-300">
              montaj run ./clips --prompt "…"
            </code>
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {projects.map((p) => (
          <div
            key={p.id}
            className="group flex items-center gap-4 p-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <button
              onClick={() => navigate(`/projects/${p.id}`)}
              className="flex-1 min-w-0 text-left"
            >
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                {p.name ?? p.id.slice(0, 8)}
              </p>
              <p className="text-xs text-gray-500 truncate mt-0.5">{p.editingPrompt}</p>
            </button>
            <StatusBadge status={p.status} />
            <button
              onClick={async (e) => {
                e.stopPropagation()
                if (!window.confirm(`Delete project "${p.name ?? p.id.slice(0, 8)}"?`)) return
                await api.deleteProject(p.id)
                setProjects(prev => prev.filter(x => x.id !== p.id))
              }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 transition-all"
              title="Delete project"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* About */}
      <div className="mt-10 pt-8 border-t border-gray-100 dark:border-gray-800">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">About</p>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Open source video editing toolkit. AI-native, CLI-first, agent-friendly.
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
          Montaj is a video editing harness that mounts on top of your existing AI agent.
          You bring Claude, Claude Code, OpenClaw, or any agent framework and Montaj gives it the tools to edit videos.
        </p>
        <br />
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
          Built-in steps cover common operations. Build your own steps and workflows.
          The agent decides what to run, in what order, and with what params.
          Customize your editing style with your social media styles.
        </p>
        {skillPath && (
          <div className="mt-6 rounded-xl border-2 border-indigo-500/40 bg-indigo-50 dark:bg-indigo-950/40 p-4 flex flex-col gap-3">
            <p className="text-sm font-bold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">Send this to your agent to get started</p>
            <div className="flex items-start justify-between gap-3 px-3 py-3 rounded-lg bg-white dark:bg-black/40 border border-indigo-200 dark:border-indigo-700/50">
              <code className="text-xs text-gray-700 dark:text-gray-200 font-mono break-all leading-relaxed">
                Read {skillPath} and help me get started with Montaj
              </code>
              <button
                onClick={copyGetStarted}
                className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200 transition-colors shrink-0 mt-0.5"
              >
                <Copy size={13} />
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-gray-400 dark:text-gray-500 mt-4">
          Built with ❤️ and ☕{' '}
          <a
            href="https://bycrux.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            By Crux
          </a>
        </p>
      </div>
    </div>
  )
}
