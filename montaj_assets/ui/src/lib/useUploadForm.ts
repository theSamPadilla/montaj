import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api, type Profile } from '@/lib/api'
import type { Project, Workflow } from '@/lib/types/schema'
import type { Asset } from '@/lib/types/schema'
import { normalizeProjectType, type ProjectType } from '@/lib/types/project'
import { DEFAULT_ASPECT_RATIO, type AspectRatio } from '@/lib/types/kling'
import { DEFAULT_CAROUSEL_ASPECT, type CarouselAspect } from '@/lib/types/carousel'
import { type ClipUploadData } from '@/components/upload/ClipUploadFields'
import { type LyricsUploadData } from '@/components/upload/LyricsUploadFields'
import { type AIVideoUploadData } from '@/components/upload/AIVideoUploadFields'

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

export interface UseUploadFormReturn {
  // state values + setters
  name: string; setName: (v: string) => void
  prompt: string; setPrompt: (v: string) => void
  workflow: string; setWorkflow: (v: string) => void
  profile: string; setProfile: (v: string) => void
  workflows: Workflow[]
  profiles: Profile[]
  clipData: ClipUploadData; setClipData: (v: ClipUploadData) => void
  aiVideoData: AIVideoUploadData; setAiVideoData: (v: AIVideoUploadData) => void
  lyricsData: LyricsUploadData; setLyricsData: (v: LyricsUploadData) => void
  carouselAssets: Asset[]; setCarouselAssets: (v: Asset[]) => void
  aiVideoAssets: Asset[]; setAiVideoAssets: (v: Asset[]) => void
  carouselAspect: CarouselAspect; setCarouselAspect: (v: CarouselAspect) => void
  aspectRatio: AspectRatio; setAspectRatio: (v: AspectRatio) => void
  targetDuration: number | null; setTargetDuration: (v: number | null) => void
  error: string | null; setError: (v: string | null) => void
  runError: string | null
  running: boolean
  // derived
  projectType: ProjectType
  selectedWorkflow: Workflow | undefined
  loadingTitle: string
  loadingMessage: string
  loadingSlowHint: string | undefined
  promptPlaceholder: string
  headerDescription: string
  submitLabel: string
  clipCount: number
  // actions
  handleRun: () => Promise<void>
}

export function useUploadForm(): UseUploadFormReturn {
  const location = useLocation()
  const prefill  = (location.state as { prefill?: Prefill } | null)?.prefill

  const [name, setName]         = useState(prefill?.name ?? '')
  const [profile, setProfile]   = useState<string>(prefill?.profile ?? '')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [prompt, setPrompt]     = useState(prefill?.prompt ?? '')
  const [workflow, setWorkflow] = useState(prefill?.workflow ?? 'overlays')
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
  const [carouselAspect, setCarouselAspect] = useState<CarouselAspect>(DEFAULT_CAROUSEL_ASPECT)
  const [carouselAssets, setCarouselAssets] = useState<Asset[]>([])
  const [aiVideoAssets, setAiVideoAssets]   = useState<Asset[]>([])

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
            assets: aiVideoAssets.length ? aiVideoAssets.map(a => a.src) : [],
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
              music: aiVideoData.musicMode === 'upload' && aiVideoData.musicFile?.path
                ? { mode: 'upload' as const, path: aiVideoData.musicFile.path }
                : aiVideoData.musicMode === 'describe' && aiVideoData.musicPrompt?.trim()
                ? { mode: 'describe' as const, prompt: aiVideoData.musicPrompt.trim() }
                : undefined,
              voiceover: aiVideoData.voiceoverPrompt?.trim()
                ? { prompt: aiVideoData.voiceoverPrompt.trim() }
                : undefined,
            },
          })
          break
        }
        case 'carousel': {
          project = await api.createProject({
            workflow,
            name: name.trim() || undefined,
            profile: profile || undefined,
            carouselAspect,
            prompt: prompt.trim(),
            assets: carouselAssets.length ? carouselAssets.map(a => a.src) : undefined,
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
      case 'music_video': return 'Generate lyrics video ⌘↵'
      case 'ai_video':    return 'Generate storyboard ⌘↵'
      case 'carousel':    return 'Create carousel ⌘↵'
      case 'editing':
      default:            return 'Run ⌘↵'
    }
  })()

  const clipCount = (() => {
    switch (projectType) {
      case 'music_video': return lyricsData.audio.length
      case 'ai_video':    return 0
      case 'carousel':    return 0
      case 'editing':
      default:            return clipData.clips.length
    }
  })()

  const loadingTitle = (() => {
    switch (projectType) {
      case 'music_video': return 'Preparing your lyrics video'
      case 'ai_video':    return 'Generating your storyboard'
      case 'carousel':    return 'Setting up your carousel'
      case 'editing':
      default:            return 'Setting up your project'
    }
  })()

  const loadingMessage = (() => {
    switch (projectType) {
      case 'music_video':
        return 'Importing audio and analyzing the track…'
      case 'ai_video':
        return 'Composing the storyboard from your references and prompt…'
      case 'carousel':
        return 'Creating workspace…'
      case 'editing':
      default:
        if (clipCount === 0) return 'Creating workspace…'
        if (clipCount === 1) return 'Importing 1 clip and preparing it for editing…'
        return `Importing ${clipCount} clips and preparing them for editing…`
    }
  })()

  const loadingSlowHint = projectType === 'editing'
    ? 'Long or high-resolution clips may need transcoding. Hang tight — this only happens once.'
    : undefined

  const promptPlaceholder = (() => {
    switch (projectType) {
      case 'music_video': return 'dark moody vibe, white text, center position…'
      case 'ai_video':    return 'Describe the video you want to create…'
      case 'carousel':    return 'Describe the carousel — topic, vibe, what each slide should cover…'
      case 'editing':
      default:            return 'tight cuts, remove filler, 9:16 for Reels…'
    }
  })()

  const headerDescription = (() => {
    switch (projectType) {
      case 'music_video': return 'Add your audio and lyrics. Background video is optional.'
      case 'ai_video':    return 'Describe your video, add references, and generate a storyboard.'
      case 'carousel':    return 'Image carousel for Instagram/TikTok. Pick an aspect ratio and start designing.'
      case 'editing':
      default:            return 'Add clips, write a prompt, hit Run.'
    }
  })()

  return {
    name, setName,
    prompt, setPrompt,
    workflow, setWorkflow,
    profile, setProfile,
    workflows,
    profiles,
    clipData, setClipData,
    aiVideoData, setAiVideoData,
    lyricsData, setLyricsData,
    carouselAssets, setCarouselAssets,
    aiVideoAssets, setAiVideoAssets,
    carouselAspect, setCarouselAspect,
    aspectRatio, setAspectRatio,
    targetDuration, setTargetDuration,
    error, setError,
    runError,
    running,
    projectType,
    selectedWorkflow,
    loadingTitle,
    loadingMessage,
    loadingSlowHint,
    promptPlaceholder,
    headerDescription,
    submitLabel,
    clipCount,
    handleRun,
  }
}
