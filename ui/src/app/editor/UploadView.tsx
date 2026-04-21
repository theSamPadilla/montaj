import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, type Profile } from '@/lib/api'
import type { Project, Workflow } from '@/lib/types/schema'
import { normalizeProjectType } from '@/lib/types/project'
import { ASPECT_RATIOS, DEFAULT_ASPECT_RATIO, type AspectRatio } from '@/lib/types/kling'
import { ClipUploadFields, type ClipUploadData } from '@/components/upload/ClipUploadFields'
import { LyricsUploadFields, type LyricsUploadData } from '@/components/upload/LyricsUploadFields'
import { AIVideoUploadFields, type AIVideoUploadData } from '@/components/upload/AIVideoUploadFields'

interface Prefill {
  clips?: string[]
  name?: string | null
  prompt?: string
  workflow?: string
  profile?: string
  aiVideoData?: AIVideoUploadData
  aspectRatio?: AspectRatio
  targetDuration?: number | null
}

/** Tiny SVG rectangles that convey landscape / portrait / square orientation. */
function AspectRatioIcon({ ratio, className }: { ratio: string; className?: string }) {
  const size = 16
  let w: number, h: number
  switch (ratio) {
    case '9:16': w = 9; h = 14; break
    case '1:1':  w = 12; h = 12; break
    case '16:9':
    default:     w = 14; h = 9; break
  }
  const x = (size - w) / 2
  const y = (size - h) / 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className}>
      <rect x={x} y={y} width={w} height={h} rx={1.5} fill="currentColor" />
    </svg>
  )
}

export default function UploadView() {
  const location = useLocation()
  const prefill  = (location.state as { prefill?: Prefill } | null)?.prefill

  const [name, setName]         = useState(prefill?.name ?? '')
  const [profile, setProfile]   = useState<string>(prefill?.profile ?? '')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [prompt, setPrompt]     = useState(prefill?.prompt ?? '')
  const [workflow, setWorkflow] = useState(prefill?.workflow ?? 'clean_cut')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [running, setRunning]   = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const navigate = useNavigate()

  // Per-branch state
  const [clipData, setClipData] = useState<ClipUploadData>({ clips: prefill?.clips ?? [], assets: [] })
  const [lyricsData, setLyricsData] = useState<LyricsUploadData>({ audio: [], lyricsFile: [], bgVideo: [] })
  const [aiVideoData, setAiVideoData] = useState<AIVideoUploadData>(prefill?.aiVideoData ?? { imageRefs: [], styleRefs: [] })
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(prefill?.aspectRatio ?? DEFAULT_ASPECT_RATIO)
  const [targetDuration, setTargetDuration] = useState<number | null>(prefill?.targetDuration ?? null)

  const selectedWorkflow = workflows.find(w => w.name === workflow)
  const projectType = normalizeProjectType(selectedWorkflow?.project_type)

  useEffect(() => {
    api.listProfiles().then(setProfiles).catch(() => {})
    api.listWorkflows().then(setWorkflows).catch(() => {})
  }, [])

  async function handleRun() {
    if (!prompt.trim()) return
    setRunning(true)
    setRunError(null)
    try {
      let project: Project

      switch (projectType) {
        case 'music_video': {
          let finalPrompt = prompt.trim()
          const finalClips = lyricsData.audio
          if (lyricsData.lyricsFile[0]) {
            finalPrompt = `Lyrics file: ${lyricsData.lyricsFile[0]}\n\n${finalPrompt}`
          }
          if (lyricsData.bgVideo[0]) {
            finalPrompt = `Background video: ${lyricsData.bgVideo[0]}\n\n${finalPrompt}`
          }
          project = await api.createProject({
            clips: finalClips,
            name: name.trim() || undefined,
            prompt: finalPrompt,
            workflow,
            profile: profile || undefined,
          })
          break
        }
        case 'ai_video': {
          project = await api.createProject({
            workflow,
            prompt: prompt.trim(),
            clips: [],
            assets: [],
            name: name.trim() || undefined,
            profile: profile || undefined,
            aiVideoIntake: {
              imageRefs: aiVideoData.imageRefs
                .filter(r => r.mode === 'upload' ? r.path : r.text)
                .map(r =>
                  r.mode === 'upload'
                    ? { label: r.label, path: r.path! }
                    : { label: r.label, text: r.text! }
                ),
              styleRefs: aiVideoData.styleRefs
                .filter(r => r.path)
                .map(r => ({ label: r.label, path: r.path })),
              aspectRatio,
              targetDurationSeconds: targetDuration,
            },
          })
          break
        }
        case 'editing':
        default: {
          project = await api.createProject({
            clips: clipData.clips,
            assets: clipData.assets.length ? clipData.assets : undefined,
            name: name.trim() || undefined,
            prompt: prompt.trim(),
            workflow,
            profile: profile || undefined,
          })
          break
        }
      }

      navigate(`/projects/${project.id}`, { state: { project } })
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setRunning(false)
    }
  }

  const submitLabel = (() => {
    if (running) return 'Running...'
    switch (projectType) {
      case 'music_video': return 'Generate lyrics video \u2318\u21B5'
      case 'ai_video':    return 'Generate storyboard \u2318\u21B5'
      case 'editing':
      default:            return 'Run \u2318\u21B5'
    }
  })()

  const promptPlaceholder = (() => {
    switch (projectType) {
      case 'music_video': return 'dark moody vibe, white text, center position\u2026'
      case 'ai_video':    return 'Describe the video you want to create\u2026'
      case 'editing':
      default:            return 'tight cuts, remove filler, 9:16 for Reels\u2026'
    }
  })()

  const headerDescription = (() => {
    switch (projectType) {
      case 'music_video': return 'Add your audio and lyrics. Background video is optional.'
      case 'ai_video':    return 'Describe your video, add references, and generate a storyboard.'
      case 'editing':
      default:            return 'Add clips, write a prompt, hit Run.'
    }
  })()

  // --- AI Video: single-column centered layout ---
  if (projectType === 'ai_video') {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto p-6 flex flex-col gap-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">New project</h2>
            <p className="text-sm text-gray-500">{headerDescription}</p>
          </div>

          {/* Name + Profile + Workflow */}
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

          {/* Prompt */}
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">Prompt</p>
            <Textarea
              className="min-h-[120px] resize-none"
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
            />
          </div>

          {/* Aspect ratio + Duration row */}
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <p className="text-xs text-gray-500 mb-1.5">Aspect ratio</p>
              <div className="flex gap-1">
                {ASPECT_RATIOS.map(r => (
                  <button
                    key={r}
                    onClick={() => setAspectRatio(r)}
                    className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm transition-colors ${
                      aspectRatio === r
                        ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600'
                    }`}
                  >
                    <AspectRatioIcon ratio={r} className={aspectRatio === r ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'} />
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="w-36">
              <p className="text-xs text-gray-500 mb-1.5">Duration (optional)</p>
              <input
                type="number"
                step="1"
                min="1"
                value={targetDuration ?? ''}
                onChange={e => {
                  const v = e.target.value
                  setTargetDuration(v ? parseInt(v, 10) : null)
                }}
                placeholder="seconds"
                className="w-full h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Image + Style references */}
          <AIVideoUploadFields data={aiVideoData} onChange={setAiVideoData} onError={setError} />

          {error && <p className="text-xs text-red-400">{error}</p>}
          {runError && <p className="text-xs text-red-400">{runError}</p>}

          {/* Workflow (typically only one ai_video workflow, but keep selectable) */}
          {workflows.length > 1 && (
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Workflow</p>
              <select
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
                className="w-full h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            </div>
          )}

          <Button
            onClick={handleRun}
            disabled={running || !prompt.trim()}
            className="w-full"
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    )
  }

  // --- Default two-column layout (editing, music_video) ---
  return (
    <div className="flex h-full">
      {/* Left column */}
      <div className="flex-1 overflow-y-auto p-6 border-r border-gray-200 dark:border-gray-800 flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">New project</h2>
          <p className="text-sm text-gray-500">{headerDescription}</p>
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

        {projectType === 'music_video' ? (
          <LyricsUploadFields data={lyricsData} onChange={setLyricsData} onError={setError} />
        ) : (
          <ClipUploadFields data={clipData} onChange={setClipData} onError={setError} />
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
          placeholder={promptPlaceholder}
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
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
