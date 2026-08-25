import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Copy, Trash2, Plus, Check, ArrowRight,
  FolderPlus, Bot, Clapperboard, Layers, Film,
} from 'lucide-react'
import { StatusBadge, WorkflowBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

const HEADING_FONT = { fontFamily: "'Space Grotesk', sans-serif", letterSpacing: '-0.02em' } as const

/** The command a user hands their agent to onboard. Reused by the getting-started
 *  guide and the slim footer, so the copy behaviour lives in one place. */
function AgentCommandCard({ skillPath }: { skillPath: string }) {
  const [copied, setCopied] = useState(false)
  const command = `Read ${skillPath} and help me get started with Montaj`
  function copy() {
    navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-indigo-200 bg-white px-3 py-3 dark:border-indigo-700/50 dark:bg-black/40">
      <code className="break-all font-mono text-xs leading-relaxed text-gray-700 dark:text-gray-200">
        {command}
      </code>
      <button
        onClick={copy}
        className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs font-semibold text-indigo-600 transition-colors hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-200"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/** Onboarding shown when there are no projects (and previewable via the temp
 *  toggle). Three steps: bring footage, let the agent edit, review and export. */
function GettingStarted({ skillPath, onNewProject }: { skillPath: string | null; onNewProject: () => void }) {
  return (
    <div className="mx-auto max-w-2xl py-6">
      {/* Hero */}
      <div className="flex flex-col items-center text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500/15 to-yellow-500/15 ring-1 ring-orange-500/20">
          <img src="/montaj-logo.png" alt="" className="h-9 w-9 rounded-lg" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white" style={HEADING_FONT}>
          Welcome to Montaj
        </h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          An AI-native video editor. Bring your clips and your agent, describe the edit,
          and review the cut here. A few steps to your first video.
        </p>
      </div>

      {/* Steps */}
      <ol className="mt-8 flex flex-col gap-3">
        <li className="flex gap-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <StepIcon n={1} icon={<FolderPlus size={16} />} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Start a project</p>
            <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              Create a project and drop in your footage, then pick a workflow: the recipe of
              editing steps your agent follows to build the video. For most social media style
              videos, the default{' '}
              <span className="font-medium text-gray-700 dark:text-gray-200">Overlays</span> workflow
              is a great start.
            </p>
            <div className="mt-3">
              <Button size="sm" onClick={onNewProject}>
                <Plus size={14} className="mr-1" /> New project
              </Button>
            </div>
          </div>
        </li>

        <li className="flex gap-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <StepIcon n={2} icon={<Bot size={16} />} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Let your agent edit</p>
            <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              Montaj runs on top of your AI agent. Hand it the command below and describe
              the edit you want.
            </p>
            {skillPath ? (
              <div className="mt-3">
                <AgentCommandCard skillPath={skillPath} />
              </div>
            ) : (
              <p className="mt-3 text-xs text-gray-400">The agent command appears once the server reports its skill path.</p>
            )}
          </div>
        </li>

        <li className="flex gap-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <StepIcon n={3} icon={<Clapperboard size={16} />} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Review and export</p>
            <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              Open the timeline to fine-tune clips, overlays, captions, and speed, then
              Export your finished video.
            </p>
          </div>
        </li>
      </ol>
    </div>
  )
}

function StepIcon({ n, icon }: { n: number; icon: ReactNode }) {
  return (
    <div className="relative shrink-0">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
        {icon}
      </div>
      <span
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-yellow-500 text-[10px] font-bold text-white"
        style={HEADING_FONT}
      >
        {n}
      </span>
    </div>
  )
}

function ProjectCard({ project, onOpen, onDelete }: { project: Project; onOpen: () => void; onDelete: () => void }) {
  const isCarousel = project.projectType === 'carousel'
  return (
    <div className="group relative flex flex-col rounded-xl border border-gray-200 bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700">
      <button onClick={onOpen} className="flex flex-1 flex-col text-left">
        <div className="flex items-center gap-2">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            isCarousel
              ? 'bg-fuchsia-500/10 text-fuchsia-500 dark:text-fuchsia-400'
              : 'bg-sky-500/10 text-sky-500 dark:text-sky-400'
          }`}>
            {isCarousel ? <Layers size={15} /> : <Film size={15} />}
          </span>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-white">
            {project.name ?? project.id.slice(0, 8)}
          </p>
        </div>
        <p className="mt-2.5 line-clamp-2 min-h-[2rem] text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {project.editingPrompt || 'No prompt.'}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusBadge status={project.status} />
            <WorkflowBadge workflow={project.workflow} />
          </span>
          <span className="flex items-center gap-1 text-xs font-medium text-gray-400 opacity-0 transition-opacity group-hover:opacity-100">
            Open <ArrowRight size={12} />
          </span>
        </div>
      </button>
      <button
        onClick={onDelete}
        className="absolute right-2 top-2 rounded p-1.5 text-gray-300 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100 dark:text-gray-600 dark:hover:text-red-400"
        title="Delete project"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

export default function ProjectList() {
  const [projects, setProjects]   = useState<Project[]>([])
  const [loading, setLoading]     = useState(true)
  const [skillPath, setSkillPath] = useState<string | null>(null)
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

  const showGuide = !loading && projects.length === 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6 md:p-8">
        {/* Header */}
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white" style={HEADING_FONT}>
              Projects
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {loading
                ? 'Loading your projects...'
                : projects.length === 0
                  ? 'No projects yet. Let us get you started.'
                  : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`}
            </p>
          </div>
          <Button onClick={() => navigate('/projects/new')}>
            <Plus size={15} className="mr-1" /> New project
          </Button>
        </div>

        {loading && <p className="text-sm text-gray-400">Loading...</p>}

        {showGuide ? (
          <GettingStarted skillPath={skillPath} onNewProject={() => navigate('/projects/new')} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map(p => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={() => navigate(`/projects/${p.id}`)}
                onDelete={async () => {
                  if (!window.confirm(`Delete project "${p.name ?? p.id.slice(0, 8)}"?`)) return
                  await api.deleteProject(p.id)
                  setProjects(prev => prev.filter(x => x.id !== p.id))
                }}
              />
            ))}
          </div>
        )}

        {/* Slim footer: about line, agent command (when projects exist, since the
            guide already shows it in the empty state), attribution + version. */}
        <div className="mt-12 border-t border-gray-100 pt-6 dark:border-gray-800">
          <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
            Montaj is an open source, AI-native video editing toolkit. Bring your own agent;
            Montaj gives it the tools to edit video.
          </p>
          {!showGuide && skillPath && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                Send this to your agent
              </p>
              <AgentCommandCard skillPath={skillPath} />
            </div>
          )}
          <div className="mt-6 flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
            <p>
              Built with ♥️ and ☕ by{' '}
              <a
                href="https://bycrux.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-gray-700 dark:hover:text-gray-300"
              >
                By Crux
              </a>
            </p>
            <p className="font-mono">v{__APP_VERSION__}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
