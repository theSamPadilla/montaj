import { createContext, useContext } from 'react'

export interface Clip {
  id: string
  src: string
  inPoint?: number   // undefined = not yet trimmed by agent
  outPoint?: number  // undefined = not yet trimmed by agent
  order: number
  transition?: { type: string; duration: number }
  pendingCuts?: [number, number][]  // physical [start, end] pairs queued for next apply
}

export interface VideoTrack {
  id: string
  type: 'video'
  clips: Clip[]
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

export interface CaptionTrack {
  id: string
  type: 'caption'
  style: 'word-by-word' | 'pop' | 'karaoke' | 'subtitle'
  segments: CaptionSegment[]
}

export interface OverlayItem {
  id: string
  type: string
  text?: string
  start: number
  end: number
  position?: string
  animation?: string
  src?: string
  offsetX?: number
  offsetY?: number
  scale?: number
  opaque?: boolean
  [key: string]: unknown
}

export interface OverlayTrack {
  id: string
  type: 'overlay'
  items: OverlayItem[]
}

export type Track = VideoTrack | CaptionTrack | OverlayTrack

export interface Asset {
  id: string
  src: string
  type: 'image'
  name?: string
}

export interface Project {
  version: string
  id: string
  status: 'pending' | 'draft' | 'final'
  name: string | null
  workflow: string
  editingPrompt: string
  runCount?: number
  sources?: Clip[]
  settings: { resolution: [number, number]; fps: number; brandKit?: string }
  tracks: Track[]
  overlay_tracks?: OverlayItem[][]
  assets: Asset[]
  audio: Record<string, unknown>
  profile?: string
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
  timestamp: string   // ISO-8601
  tracks: Track[]
  editingPrompt: string
}

export interface ProjectVersion {
  hash: string
  message: string
  timestamp: string  // ISO-8601
}

// Track helpers
export function getVideoTrack(p: Project): VideoTrack | undefined {
  return p.tracks.find((t): t is VideoTrack => t.type === 'video')
}
export function getCaptionTrack(p: Project): CaptionTrack | undefined {
  return p.tracks.find((t): t is CaptionTrack => t.type === 'caption')
}
export function getOverlayTrack(p: Project): OverlayTrack | undefined {
  return p.tracks.find((t): t is OverlayTrack => t.type === 'overlay')
}
export function getOverlayItems(p: Project): OverlayItem[] {
  return (p.overlay_tracks ?? []).flat()
}
export function getOverlayTracks(p: Project): OverlayItem[][] {
  return p.overlay_tracks ?? []
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
