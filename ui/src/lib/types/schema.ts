import { createContext, useContext } from 'react'
import type { ProjectType, ProjectStatus } from './project'
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
