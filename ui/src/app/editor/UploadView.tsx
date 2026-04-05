import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, FolderOpen, Film, Image } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, type Profile } from '@/lib/api'
import type { Project } from '@/lib/project'

function basename(path: string) {
  return path.split('/').pop() ?? path
}

interface DropZoneProps {
  label: string
  sublabel: string
  icon: React.ReactNode
  accept: string        // MIME prefix, e.g. 'video/' or 'image/'
  files: string[]
  uploading: boolean
  onBrowse: () => void
  onDrop: (files: File[]) => void
  onRemove: (path: string) => void
  browseLabel: string
  accentClass: string   // Tailwind color classes for the active border/bg
}

function DropZone({ label, sublabel, icon, accept, files, uploading, onBrowse, onDrop, onRemove, browseLabel, accentClass }: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only clear if leaving the zone itself, not a child
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith(accept))
    if (dropped.length) onDrop(dropped)
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{sublabel}</p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative rounded-lg border-2 border-dashed transition-colors ${
          dragOver
            ? `${accentClass} border-opacity-100`
            : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600'
        }`}
      >
        <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center">
          <div className={`${dragOver ? 'text-white' : 'text-gray-400 dark:text-gray-600'} transition-colors`}>
            {icon}
          </div>
          <p className={`text-sm transition-colors ${dragOver ? 'text-white' : 'text-gray-500 dark:text-gray-500'}`}>
            {dragOver ? 'Drop to add' : `Drop ${accept === 'video/' ? 'video' : 'image'} files here`}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <div className="h-px w-8 bg-gray-200 dark:bg-gray-800" />
            <span className="text-xs text-gray-400 dark:text-gray-700">or</span>
            <div className="h-px w-8 bg-gray-200 dark:bg-gray-800" />
          </div>
          <button
            onClick={onBrowse}
            disabled={uploading}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-sm text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-white transition-colors disabled:opacity-50 border border-gray-300 dark:border-gray-700"
          >
            <FolderOpen size={14} />
            {uploading ? 'Opening…' : browseLabel}
          </button>
        </div>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map(path => (
            <li
              key={path}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 group"
            >
              <span className="text-gray-400 dark:text-gray-600 shrink-0">
                {accept === 'video/' ? <Film size={12} /> : <Image size={12} />}
              </span>
              <span className="flex-1 text-xs text-gray-700 dark:text-gray-300 truncate font-mono">
                {basename(path)}
              </span>
              <button
                onClick={() => onRemove(path)}
                className="shrink-0 text-gray-400 hover:text-gray-600 dark:text-gray-700 dark:hover:text-gray-400 transition-colors opacity-0 group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function UploadView() {
  const [name, setName]                   = useState('')
  const [clips, setClips]                 = useState<string[]>([])
  const [assets, setAssets]               = useState<string[]>([])
  const [profile, setProfile]             = useState<string>('')
  const [profiles, setProfiles]           = useState<Profile[]>([])
  const [pickingClips, setPickingClips]   = useState(false)
  const [pickingAssets, setPickingAssets] = useState(false)
  const [uploadingClips, setUploadingClips]   = useState(false)
  const [uploadingAssets, setUploadingAssets] = useState(false)
  const [error, setError]                 = useState<string | null>(null)

  const [prompt, setPrompt]     = useState('')
  const [workflow, setWorkflow] = useState('basic_trim')
  const [workflows, setWorkflows] = useState<{ name: string }[]>([])
  const [running, setRunning]   = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listProfiles().then(setProfiles).catch(() => {})
    api.listWorkflows().then(setWorkflows).catch(() => {})
  }, [])

  function addUnique(prev: string[], paths: string[]) {
    return [...prev, ...paths.filter(p => !prev.includes(p))]
  }

  async function browseClips() {
    setPickingClips(true)
    setError(null)
    try {
      const { paths } = await api.pickFiles()
      if (paths.length) setClips(prev => addUnique(prev, paths))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) setError(msg)
    } finally {
      setPickingClips(false)
    }
  }

  async function browseAssets() {
    setPickingAssets(true)
    setError(null)
    try {
      const { paths } = await api.pickFiles()
      if (paths.length) setAssets(prev => addUnique(prev, paths))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) setError(msg)
    } finally {
      setPickingAssets(false)
    }
  }

  async function handleDropClips(files: File[]) {
    setUploadingClips(true)
    setError(null)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f)))
      setClips(prev => addUnique(prev, paths))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingClips(false)
    }
  }

  async function handleDropAssets(files: File[]) {
    setUploadingAssets(true)
    setError(null)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f)))
      setAssets(prev => addUnique(prev, paths))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingAssets(false)
    }
  }

  async function handleRun() {
    if (!prompt.trim()) return
    setRunning(true)
    setRunError(null)
    try {
      const project: Project = await api.createProject({
        clips,
        assets: assets.length ? assets : undefined,
        name: name.trim() || undefined,
        prompt: prompt.trim(),
        workflow,
        profile: profile || undefined,
      })
      navigate(`/projects/${project.id}`, { state: { project } })
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex h-full">
      {/* Left column: name + clips + assets */}
      <div className="flex-1 overflow-y-auto p-6 border-r border-gray-200 dark:border-gray-800 flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">New project</h2>
          <p className="text-sm text-gray-500">Add clips, write a prompt, hit Run.</p>
        </div>

        {/* Name + Profile */}
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Project name (optional)"
            className="flex-1 h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {profiles.length > 0 && (
            <select
              value={profile}
              onChange={e => setProfile(e.target.value)}
              className="h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">No profile</option>
              {profiles.map(p => (
                <option key={p.name} value={p.name}>
                  {p.style_meta?.username ?? p.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <DropZone
          label="Clips"
          sublabel="Source video files to edit."
          icon={<Film size={28} />}
          accept="video/"
          files={clips}
          uploading={pickingClips || uploadingClips}
          onBrowse={browseClips}
          onDrop={handleDropClips}
          onRemove={path => setClips(prev => prev.filter(p => p !== path))}
          browseLabel={clips.length === 0 ? 'Browse files' : 'Add more'}
          accentClass="border-blue-500 bg-blue-500/10"
        />

        <DropZone
          label="Assets"
          sublabel="Images the agent can use as overlays — logos, screenshots, graphics. Optional."
          icon={<Image size={28} />}
          accept="image/"
          files={assets}
          uploading={pickingAssets || uploadingAssets}
          onBrowse={browseAssets}
          onDrop={handleDropAssets}
          onRemove={path => setAssets(prev => prev.filter(p => p !== path))}
          browseLabel={assets.length === 0 ? 'Browse files' : 'Add more'}
          accentClass="border-purple-500 bg-purple-500/10"
        />

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Right column: prompt + workflow + run */}
      <div className="w-80 flex flex-col p-6 gap-4">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">Prompt</p>
          <p className="text-xs text-gray-500">Describe what you want the agent to do.</p>
        </div>

        <Textarea
          className="flex-1 resize-none"
          placeholder="tight cuts, remove filler, 9:16 for Reels…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
        />

        <div className="flex flex-col gap-2">
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Workflow</p>
            <select
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
              className="w-full h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {workflows.length > 0
                ? workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)
                : <option value="basic_trim">basic_trim</option>}
            </select>
          </div>

          {runError && <p className="text-xs text-red-400">{runError}</p>}

          <Button
            onClick={handleRun}
            disabled={running || !prompt.trim()}
            className="w-full"
          >
            {running ? 'Running…' : 'Run ⌘↵'}
          </Button>
        </div>
      </div>
    </div>
  )
}
