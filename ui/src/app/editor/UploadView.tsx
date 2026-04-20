import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { X, FolderOpen, Film, Image, Music, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, type Profile } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

function basename(path: string) {
  return path.split('/').pop() ?? path
}

interface DropZoneProps {
  label: string
  sublabel: string
  icon: React.ReactNode
  accept: string
  files: string[]
  uploading: boolean
  onBrowse: () => void
  onDrop: (files: File[]) => void
  onRemove: (path: string) => void
  browseLabel: string
  accentClass: string
  dropLabel?: string
  fileIcon?: React.ReactNode
  single?: boolean
}

function DropZone({ label, sublabel, icon, accept, files, uploading, onBrowse, onDrop, onRemove, browseLabel, accentClass, dropLabel, fileIcon, single }: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith(accept))
    if (dropped.length) onDrop(single ? dropped.slice(0, 1) : dropped)
  }

  const defaultDropLabel =
    accept === 'video/' ? 'Drop video files here' :
    accept === 'audio/' ? 'Drop audio file here' :
    accept === 'text/'  ? 'Drop lyrics file here' :
                          'Drop files here'

  const defaultFileIcon =
    accept === 'video/' ? <Film size={12} /> :
    accept === 'audio/' ? <Music size={12} /> :
    accept === 'text/'  ? <FileText size={12} /> :
                          <Image size={12} />

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
            {dragOver ? 'Drop to add' : (dropLabel ?? defaultDropLabel)}
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
                {fileIcon ?? defaultFileIcon}
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

interface Prefill {
  clips?: string[]
  name?: string | null
  prompt?: string
  workflow?: string
  profile?: string
}

export default function UploadView() {
  const location = useLocation()
  const prefill  = (location.state as { prefill?: Prefill } | null)?.prefill

  const [name, setName]                   = useState(prefill?.name ?? '')
  const [clips, setClips]                 = useState<string[]>(prefill?.clips ?? [])
  const [assets, setAssets]               = useState<string[]>([])
  const [profile, setProfile]             = useState<string>(prefill?.profile ?? '')
  const [profiles, setProfiles]           = useState<Profile[]>([])
  const [pickingClips, setPickingClips]   = useState(false)
  const [pickingAssets, setPickingAssets] = useState(false)
  const [uploadingClips, setUploadingClips]   = useState(false)
  const [uploadingAssets, setUploadingAssets] = useState(false)

  // Lyrics video mode
  const [audio, setAudio]                   = useState<string[]>([])
  const [lyricsFile, setLyricsFile]         = useState<string[]>([])
  const [bgVideo, setBgVideo]               = useState<string[]>([])
  const [pickingAudio, setPickingAudio]     = useState(false)
  const [pickingLyrics, setPickingLyrics]   = useState(false)
  const [pickingBgVideo, setPickingBgVideo] = useState(false)
  const [uploadingAudio, setUploadingAudio] = useState(false)
  const [uploadingLyrics, setUploadingLyrics] = useState(false)
  const [uploadingBgVideo, setUploadingBgVideo] = useState(false)

  const [error, setError]                 = useState<string | null>(null)
  const [prompt, setPrompt]     = useState(prefill?.prompt ?? '')
  const [workflow, setWorkflow] = useState(prefill?.workflow ?? 'clean_cut')
  const [workflows, setWorkflows] = useState<{ name: string }[]>([])
  const [running, setRunning]   = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const navigate = useNavigate()

  const isLyricsVideo = workflow === 'lyrics_video'

  useEffect(() => {
    api.listProfiles().then(setProfiles).catch(() => {})
    api.listWorkflows().then(setWorkflows).catch(() => {})
  }, [])

  function addUnique(prev: string[], paths: string[]) {
    return [...prev, ...paths.filter(p => !prev.includes(p))]
  }

  const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mts', 'mpg', 'mpeg']

  async function browseClips() {
    setPickingClips(true)
    setError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: VIDEO_EXTENSIONS, prompt: 'Select video clips' })
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

  async function browseAudio() {
    setPickingAudio(true)
    setError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: ['mp3'], prompt: 'Select MP3 file' })
      if (paths.length) setAudio([paths[0]])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) setError(msg)
    } finally {
      setPickingAudio(false)
    }
  }

  async function browseLyrics() {
    setPickingLyrics(true)
    setError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: ['txt'], prompt: 'Select lyrics file' })
      if (paths.length) setLyricsFile([paths[0]])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) setError(msg)
    } finally {
      setPickingLyrics(false)
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

  async function handleDropAudio(files: File[]) {
    setUploadingAudio(true)
    setError(null)
    try {
      const path = await api.uploadFile(files[0])
      setAudio([path])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingAudio(false)
    }
  }

  async function handleDropLyrics(files: File[]) {
    setUploadingLyrics(true)
    setError(null)
    try {
      const path = await api.uploadFile(files[0])
      setLyricsFile([path])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingLyrics(false)
    }
  }

  async function browseBgVideo() {
    setPickingBgVideo(true)
    setError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: VIDEO_EXTENSIONS, prompt: 'Select background video' })
      if (paths.length) setBgVideo([paths[0]])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) setError(msg)
    } finally {
      setPickingBgVideo(false)
    }
  }

  async function handleDropBgVideo(files: File[]) {
    setUploadingBgVideo(true)
    setError(null)
    try {
      const path = await api.uploadFile(files[0])
      setBgVideo([path])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingBgVideo(false)
    }
  }

  async function handleRun() {
    if (!prompt.trim()) return
    setRunning(true)
    setRunError(null)
    try {
      let finalClips  = clips
      let finalPrompt = prompt.trim()

      if (isLyricsVideo) {
        finalClips = audio
        if (lyricsFile[0]) {
          finalPrompt = `Lyrics file: ${lyricsFile[0]}\n\n${finalPrompt}`
        }
        if (bgVideo[0]) {
          finalPrompt = `Background video: ${bgVideo[0]}\n\n${finalPrompt}`
        }
      }

      const project: Project = await api.createProject({
        clips: finalClips,
        assets: !isLyricsVideo && assets.length ? assets : undefined,
        name: name.trim() || undefined,
        prompt: finalPrompt,
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
      {/* Left column */}
      <div className="flex-1 overflow-y-auto p-6 border-r border-gray-200 dark:border-gray-800 flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">New project</h2>
          <p className="text-sm text-gray-500">
            {isLyricsVideo
              ? 'Add your audio and lyrics. Background video is optional.'
              : 'Add clips, write a prompt, hit Run.'}
          </p>
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

        {isLyricsVideo ? (
          <>
            <div className="flex gap-4">
              <div className="flex-1">
                <DropZone
                  label="Audio"
                  sublabel="MP3 file — the song to sync lyrics to."
                  icon={<Music size={28} />}
                  accept="audio/mpeg"
                  dropLabel="Drop MP3 file here"
                  files={audio}
                  uploading={pickingAudio || uploadingAudio}
                  onBrowse={browseAudio}
                  onDrop={handleDropAudio}
                  onRemove={() => setAudio([])}
                  browseLabel={audio.length === 0 ? 'Browse files' : 'Replace'}
                  accentClass="border-green-500 bg-green-500/10"
                  single
                />
              </div>

              <div className="flex-1">
                <DropZone
                  label="Lyrics"
                  sublabel="Plain text file — one phrase per line."
                  icon={<FileText size={28} />}
                  accept="text/"
                  files={lyricsFile}
                  uploading={pickingLyrics || uploadingLyrics}
                  onBrowse={browseLyrics}
                  onDrop={handleDropLyrics}
                  onRemove={() => setLyricsFile([])}
                  browseLabel={lyricsFile.length === 0 ? 'Browse files' : 'Replace'}
                  accentClass="border-amber-500 bg-amber-500/10"
                  single
                />
              </div>
            </div>

            <DropZone
              label="Background Video"
              sublabel="Optional looping video behind the lyrics. Short clips (10–30s) work best."
              icon={<Film size={28} />}
              accept="video/"
              files={bgVideo}
              uploading={pickingBgVideo || uploadingBgVideo}
              onBrowse={browseBgVideo}
              onDrop={handleDropBgVideo}
              onRemove={() => setBgVideo([])}
              browseLabel={bgVideo.length === 0 ? 'Browse files' : 'Replace'}
              accentClass="border-blue-500 bg-blue-500/10"
              dropLabel="Drop background video here"
              single
            />
          </>
        ) : (
          <>
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
          </>
        )}

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
          placeholder={isLyricsVideo ? 'dark moody vibe, white text, center position…' : 'tight cuts, remove filler, 9:16 for Reels…'}
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
                : <option value="clean_cut">clean_cut</option>}
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
