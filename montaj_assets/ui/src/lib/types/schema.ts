import { createContext, useContext } from 'react'
import type { ProjectType, ProjectStatus } from './project'
import type { CarouselAspect } from './carousel'
import type { AspectRatio } from './kling'
import type {
  AudioTrack,
  Captions,
  VisualItem,
  VisualTrack,
  Asset,
  Slide,
  EditorProject,
} from '@bycrux/editor'
import { trackItems } from '@bycrux/editor'

// Editor-facing types now live in @bycrux/editor. Re-exported here so existing
// `@/lib/types/schema` importers keep resolving them unchanged.
export type {
  Word,
  AudioTrack,
  CaptionSegment,
  Captions,
  VisualItem,
  VisualTrack,
  Asset,
  ImageElement,
  OverlayElement,
  CarouselElement,
  Slide,
  EditorProject,
} from '@bycrux/editor'

// Track-shape tolerance, re-exported as values so host files can import it from
// `@/lib/types/schema` alongside the types. `project.tracks` may be on disk as
// the legacy `VisualItem[][]` or as `VisualTrack[]`; read it through
// `trackItems`, and normalize on open with `normalizeTracks`.
export { enabledTrackItems, mapTrackItems, normalizeTracks, trackItems } from '@bycrux/editor'

export interface Workflow {
  name: string
  scope: 'project-local' | 'user' | 'built-in'
  project_type: ProjectType
}

export interface Scene {
  id: string
  prompt: string
  duration: number
  refImages: string[]
  shotScale?: string
  cameraMove?: string
  lastError?: { ts: string; message: string }
}

export interface ImageRef {
  id: string
  label: string
  anchor?: string
  refImages: string[]
  source: 'upload' | 'text'
  status: 'pending' | 'generating' | 'ready' | 'failed'
}

export interface StyleRef {
  id: string
  kind: 'video' | 'audio' | 'image'
  path: string
  label?: string
}

export type StoryboardMusic =
  | { mode: 'upload',   path: string }
  | { mode: 'describe', prompt: string }

export interface StoryboardVoiceover {
  prompt: string
}

export interface Storyboard {
  aspectRatio?: AspectRatio
  targetDurationSeconds?: number
  imageRefs: ImageRef[]
  styleRefs: StyleRef[]
  styleAnchor?: string
  scenes: Scene[]
  approval?: { approvedAt: string }
  music?:     StoryboardMusic
  voiceover?: StoryboardVoiceover
}

export interface RegenQueueEntry {
  id: string                              // unique within this queue; "req-<ts>" or UUID
  clipId: string                          // matches a tracks[0][i].id
  mode: 'full' | 'subcut'
  subrange: { start: number; end: number } | null  // source-seconds; null for full
  prompt: string                          // natural language; NO <<<image_N>>> tokens
  refImages: string[]                     // imageRef IDs
  duration: number                        // integer seconds in [3, 15]
  useFirstFrame: boolean                  // subcut only; ignored for full
  useLastFrame: boolean                   // subcut only; ignored for full
  model: string                           // e.g. "kling-v3-omni" | "kling-video-o1"
  requestedAt: string                     // ISO8601
  lastError?: { ts: string; message: string }
}

// The full Montaj project. Extends the editor-facing EditorProject with all
// pipeline/agent fields Montaj owns. The shared editor fields (id, status,
// settings, name, editingPrompt, slides, tracks, captions, audio, assets,
// carousel, profile) come from EditorProject; the field types below match
// what EditorProject declares so a full Project stays assignable to it.
export interface Project extends EditorProject {
  version: string
  id: string
  status: ProjectStatus
  projectType?: ProjectType
  name: string | null
  workflow: string
  editingPrompt: string
  runCount?: number
  sources?: VisualItem[]
  settings: { resolution: [number, number]; fps?: number; brandKit?: string }
  tracks?: VisualTrack[]
  captions?: Captions
  assets: Asset[]
  audio?: { tracks: AudioTrack[] }
  profile?: string
  renderMode?: 'ffmpeg-drawtext'
  history?: RunSnapshot[]
  storyboard?: Storyboard
  regenQueue?: RegenQueueEntry[]
  // Carousel-only
  slides?: Slide[]
  carousel?: { aspect: CarouselAspect }
}

export interface StepParam {
  name: string
  type: 'string' | 'int' | 'float' | 'bool' | 'enum'
  description?: string
  default?: unknown
  required?: boolean
  options?: string[]
  min?: number
  max?: number
}

export interface StepSchema {
  name: string
  description: string
  category?: string
  input?: { description?: string; multiple?: boolean; type?: string }
  params?: StepParam[]
  output?: { type: string; description?: string }
}

export interface RunSnapshot {
  timestamp: string
  tracks: VisualTrack[]
  captions?: Captions
  editingPrompt: string
}

export interface ProjectVersion {
  hash: string
  message: string
  timestamp: string
}

// Helpers
export function getVisualItems(p: Project): VisualItem[] {
  // `trackItems` is both-shapes-tolerant — identical behaviour today, and it
  // keeps working once `tracks` is on disk as `VisualTrack[]`.
  return trackItems(p).flat()
}

// React context
export interface ProjectContextValue {
  project: Project | null
  setProject: (p: Project) => void
}

export const ProjectContext = createContext<ProjectContextValue>({
  project: null,
  setProject: () => {},
})

export function useProject() {
  return useContext(ProjectContext)
}
