import type { Project, ProjectVersion, StepSchema, Workflow } from './types/schema'
import type { AspectRatio } from './types/kling'

export interface ProfileStats {
  videos_analyzed?:  number
  avg_duration?:     number
  avg_cuts_per_min?: number
  avg_wpm?:          number
  avg_speech_ratio?: number
  dominant_colors?:  string[]
  common_resolution?: string
  common_fps?:       number
}

export interface StyleMeta {
  username?:         string
  links?:            string
  style_summary?:    string
  content_overview?: string
  created?:          string
  updated?:          string
  videos_current?:   string
  videos_inspired?:  string
}

export interface Profile {
  name:                string
  display_name?:       string
  created:             string
  updated:             string
  notes?:              string
  stats?:              ProfileStats
  sources?:            { type: 'current' | 'inspired'; video_count?: number; label?: string }[]
  style_doc?:          string
  style_meta?:         StyleMeta
  color_palette?:      { current: string[]; inspired: string[]; merged: string[] }
  sample_frames?:      string[]
  style_profile_path?: string
}

export interface GlobalOverlayProp {
  name: string
  type: 'string' | 'int' | 'float' | 'bool' | 'color'
  default?: unknown
  description?: string
}

export interface GlobalOverlay {
  name: string
  description: string
  props: GlobalOverlayProp[]
  jsxPath: string
  group?: string
  empty?: boolean
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(err.detail?.message ?? err.message ?? res.statusText)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return res.json()
}

export const api = {
  listProjects: (status?: string) =>
    request<Project[]>(`/api/projects${status ? `?status=${status}` : ''}`),

  getProject: (id: string) =>
    request<Project>(`/api/projects/${id}`),

  saveProject: (id: string, project: Project) =>
    request<Project>(`/api/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(project),
    }),

  createProject: (body: {
    clips: string[]
    assets?: string[]
    prompt: string
    workflow?: string
    name?: string
    profile?: string
    aiVideoIntake?: {
      imageRefs: Array<{ label: string; path?: string; text?: string }>
      styleRefs: Array<{ label: string; path: string }>
      aspectRatio: AspectRatio
      targetDurationSeconds: number | null
    }
  }) =>
    request<Project>('/api/run', { method: 'POST', body: JSON.stringify(body) }),

  listSteps: () => request<StepSchema[]>('/api/steps'),
  listSkills: () => request<{ name: string; description: string; scope: 'native' | 'custom' }[]>('/api/skills'),

  runStep: <T = unknown>(name: string, params: Record<string, unknown>) =>
    request<T>(`/api/steps/${name}`, { method: 'POST', body: JSON.stringify(params) }),

  saveWorkflow: (name: string, workflow: Record<string, unknown>) =>
    request<unknown>(`/api/workflows/${name}`, { method: 'PUT', body: JSON.stringify(workflow) }),

  pickFiles: (options?: { extensions?: string[]; prompt?: string }) => {
    const params = new URLSearchParams()
    if (options?.extensions?.length) params.set('extensions', options.extensions.join(','))
    if (options?.prompt) params.set('prompt', options.prompt)
    const qs = params.toString()
    return request<{ paths: string[] }>(`/api/pick-files${qs ? `?${qs}` : ''}`)
  },

  uploadFile: async (file: File): Promise<string> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/upload', { method: 'POST', body: form })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new Error(err.detail?.message ?? err.message ?? res.statusText)
    }
    const { path } = await res.json() as { path: string }
    return path
  },

  deleteProject: (id: string) =>
    request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  rerun: (id: string, params?: { prompt?: string; workflow?: string; versionName?: string }) =>
    request<Project>(`/api/projects/${id}/rerun`, { method: 'POST', body: JSON.stringify(params ?? {}) }),

  listWorkflows: () => request<Workflow[]>('/api/workflows'),

  getWorkflow: (name: string) => request<Record<string, unknown>>(`/api/workflows/${name}`),

  listVersions: (id: string) =>
    request<ProjectVersion[]>(`/api/projects/${id}/versions`),

  restoreVersion: (id: string, hash: string) =>
    request<Project>(`/api/projects/${id}/versions/${hash}/restore`, { method: 'POST' }),

  getInfo: () => request<{ skill_path: string; root_skill_path: string; style_profile_skill_path: string }>('/api/info'),

  listProfiles: () => request<Profile[]>('/api/profiles'),

  getProfile: (name: string) => request<Profile>(`/api/profiles/${name}`),

  listGlobalOverlays: () => request<GlobalOverlay[]>('/api/overlays'),

  createOverlayGroup: (name: string) =>
    request<{ name: string }>('/api/overlays/groups', { method: 'POST', body: JSON.stringify({ name }) }),

  listProfileOverlays: (profileName: string) =>
    request<GlobalOverlay[]>(`/api/profiles/${profileName}/overlays`),

  createProfileOverlayGroup: (profileName: string, name: string) =>
    request<{ name: string }>(`/api/profiles/${profileName}/overlays/groups`, { method: 'POST', body: JSON.stringify({ name }) }),

  logStatus: (projectId: string, message: string) =>
    request<void>(`/api/projects/${projectId}/log`, { method: 'POST', body: JSON.stringify({ message }) }),

  renderProject: (
    projectId: string,
    onLog:   (line: string) => void,
    onDone:  (outputPath: string) => void,
    onError: (msg: string) => void,
  ): Promise<() => void> =>
    fetch(`/api/projects/${projectId}/render`, { method: 'POST' }).then(res => {
      if (!res.ok) return res.json().catch(() => ({})).then(err => { throw new Error(err.detail?.message ?? res.statusText) })
      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      function parseSse(chunk: string) {
        buf += chunk
        const messages = buf.split('\n\n')
        buf = messages.pop() ?? ''
        for (const msg of messages) {
          let event = 'message', data = ''
          for (const line of msg.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim()
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (event === 'log')   onLog(data)
          if (event === 'done')  onDone(data)
          if (event === 'error') onError(data)
        }
      }

      let cancelled = false
      ;(async () => {
        try {
          while (!cancelled) {
            const { done, value } = await reader.read()
            if (done) break
            parseSse(decoder.decode(value, { stream: true }))
          }
        } catch (e) {
          if (!cancelled) onError(String(e))
        }
      })()

      return () => { cancelled = true; reader.cancel() }
    }),
}

/** Build a URL that serves a local file through montaj serve. */
export function fileUrl(absolutePath: string) {
  return `/api/files?path=${encodeURIComponent(absolutePath)}`
}
