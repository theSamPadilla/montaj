import { createContext, useContext } from 'react'
import type { ProjectType, ProjectStatus } from './project'
import type { AspectRatio } from './kling'
export interface Workflow {
  name: string
  scope: 'project-local' | 'user' | 'built-in'
  project_type: ProjectType
}

export interface Word {
  word: string
  start: number
  end: number
}

export interface CaptionSegment {
  id?: string
  text: string
  start: number
  end: number
  words?: Word[]
}

export interface Captions {
  style: 'word-by-word' | 'pop' | 'karaoke' | 'subtitle'
  segments: CaptionSegment[]
  // ffmpeg-drawtext render params — ignored by JSX preview, used by render.js ffmpeg branch
  position?: 'center' | 'top-left' | 'bottom-left'
  color?: string
  fontsize?: number
  bgColor?: string
}

export interface VisualItem {
  id: string
  type: 'overlay' | 'image' | 'video'
  src?: string
  start: number
  end: number
  sourceDuration?: number     // video type only — used for right-edge drag guard
  inPoint?: number            // video type only
  outPoint?: number           // video type only
  loop?: boolean              // video type only — loop source clip within project window
  transition?: { type: string; duration: number }  // video type only — transition into next clip
  offsetX?: number
  offsetY?: number
  scale?: number
  opacity?: number        // 0.0–1.0
  rotation?: number       // degrees, clockwise
  opaque?: boolean        // legacy boolean kept for old overlay items
  props?: Record<string, unknown>  // overlay type only
  remove_bg?: boolean     // video type only
  nobg_src?: string         // video type only — ProRes 4444 .mov for final render
  nobg_preview_src?: string // video type only — VP9 WebM with alpha for browser preview
  muted?: boolean         // video type only — suppress audio in preview and render
  generation?: {            // ai_video only — frozen provenance from Kling generation
    // Single-shot fields (present when multiShot is falsy).
    sceneId?: string
    prompt?: string
    refImages?: string[]
    duration?: number
    // Shared fields.
    provider?: string
    model?: string
    attempts?: Array<{ ts: string; prompt: string; src: string }>
    eval?: {
      pass: boolean
      scores: Record<string, number>
      attempt: number
    }
    // Multi-shot / batched fields. When multiShot is true, the clip represents a
    // batch of up to 6 scenes generated in ONE Kling call. The outer sceneId/
    // prompt/refImages fields are replaced by batchShots[] which carries the
    // per-scene mapping inside the concatenated output video.
    multiShot?: boolean
    shotType?: 'customize' | 'intelligence'
    batchShots?: Array<{
      sceneId: string
      index: number          // 1-based, matches Kling's multi_prompt[].index
      prompt: string         // combined prompt for this shot (styleAnchor + scene prose + tokens)
      start: number          // shot start, seconds, RELATIVE to the batch clip
      end: number            // shot end, seconds, RELATIVE to the batch clip
      duration: number
    }>
  }
  // Legacy fields for old text overlay items (pre-schema migration)
  position?: string
  text?: string
}

export interface Asset {
  id: string
  src: string
  type: 'image'
  name?: string
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

export interface Storyboard {
  aspectRatio?: AspectRatio
  targetDurationSeconds?: number
  imageRefs: ImageRef[]
  styleRefs: StyleRef[]
  styleAnchor?: string
  scenes: Scene[]
  approval?: { approvedAt: string }
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

export interface Project {
  version: string
  id: string
  status: ProjectStatus
  projectType?: ProjectType
  name: string | null
  workflow: string
  editingPrompt: string
  runCount?: number
  sources?: VisualItem[]
  settings: { resolution: [number, number]; fps: number; brandKit?: string }
  tracks: VisualItem[][]
  captions?: Captions
  assets: Asset[]
  audio: Record<string, unknown>
  profile?: string
  renderMode?: 'ffmpeg-drawtext'
  history?: RunSnapshot[]
  storyboard?: Storyboard
  regenQueue?: RegenQueueEntry[]
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
  input?: { description?: string; multiple?: boolean; type?: string }
  params?: StepParam[]
  output?: { type: string; description?: string }
}

export interface RunSnapshot {
  timestamp: string
  tracks: VisualItem[][]
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
  return (p.tracks ?? []).flat()
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
