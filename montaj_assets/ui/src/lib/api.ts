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

// Single type identity for overlay shapes: the editor package owns these, and
// Montaj re-exports them so callers (OverlaysPage/ProfilesPage/montajAdapter)
// and the adapter contract refer to the same type. Imported locally too so the
// request<…> generics below can name them.
import type { GlobalOverlay, GlobalOverlayProp, EditorContext } from '@bycrux/editor'
export type { GlobalOverlay, GlobalOverlayProp }

export interface ProfileAssetEntry {
  description: string
  tags?: string[]
}

export interface ProfileAssetFile {
  filename: string
  size: number
  mime: string
  mtime: number
  path: string
}

export interface ProfileAssetsManifest {
  summary: string
  files: Record<string, ProfileAssetEntry>
}

export interface ProfileAssetsDrift {
  filesWithoutEntry: string[]
  entriesWithoutFile: string[]
}

export interface ProfileAssetsResponse {
  files: ProfileAssetFile[]
  manifest: ProfileAssetsManifest
  drift: ProfileAssetsDrift
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

  reportContext: (id: string, context: EditorContext) =>
    request<void>(`/api/projects/${id}/context`, {
      method: 'POST',
      body: JSON.stringify(context),
    }),

  createProject: (body: {
    clips?: string[]
    assets?: string[]
    prompt?: string
    workflow?: string
    name?: string
    profile?: string
    carouselAspect?: 'square' | 'portrait' | 'vertical'
    /** One entry per recorded take, in the order they should play. Init concatenates. */
    voiceoverAssets?: string[]
    /** @deprecated Single-take intake. Still honored by the server; prefer voiceoverAssets. */
    voiceoverAsset?: string
    aiVideoIntake?: {
      imageRefs: Array<{ label: string; path?: string; text?: string }>
      styleRefs: Array<{ label: string; path: string }>
      aspectRatio: AspectRatio
      targetDurationSeconds: number | null
      music?:
        | { mode: 'upload',   path: string }
        | { mode: 'describe', prompt: string }
      voiceover?: { prompt: string }
    }
  }) =>
    request<Project>('/api/run', { method: 'POST', body: JSON.stringify(body) }),

  listSteps: () => request<StepSchema[]>('/api/steps'),
  listSkills: () => request<{ name: string; description: string; scope: 'native' | 'custom' }[]>('/api/skills'),

  runStep: <T = unknown>(name: string, params: Record<string, unknown>) =>
    request<T>(`/api/steps/${name}`, { method: 'POST', body: JSON.stringify(params) }),

  /**
   * Run a step via the server's async job flow: POST with `_async: true`
   * (202 + job_id), then poll GET /api/steps/jobs/{id} until done/error.
   *
   * Use this instead of runStep for anything that can take more than a few
   * seconds (waveform_image, generate_image): a pending fetch pins one of the
   * browser's 6 HTTP/1.1 connections to the server for its whole duration,
   * and long sync steps were a major contributor to editor freezes.
   */
  runStepAsync: async <T = unknown>(
    name: string,
    params: Record<string, unknown>,
    opts?: { pollMs?: number; timeoutMs?: number },
  ): Promise<T> => {
    const pollMs    = opts?.pollMs ?? 1500
    const timeoutMs = opts?.timeoutMs ?? 15 * 60_000  // matches MONTAJ_STEP_TIMEOUT's magnitude
    const { job_id } = await request<{ job_id: string }>(`/api/steps/${name}`, {
      method: 'POST',
      body: JSON.stringify({ ...params, _async: true }),
    })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs))
      const job = await request<{
        status: 'running' | 'done' | 'error'
        result?: T
        error?: { error?: string; message?: string }
      }>(`/api/steps/jobs/${job_id}`)
      if (job.status === 'done') return job.result as T
      if (job.status === 'error') {
        throw new Error(job.error?.message ?? job.error?.error ?? `step ${name} failed`)
      }
      if (Date.now() >= deadline) {
        throw new Error(`step ${name} timed out after ${Math.round(timeoutMs / 1000)}s`)
      }
    }
  },

  saveWorkflow: (name: string, workflow: Record<string, unknown>) =>
    request<unknown>(`/api/workflows/${name}`, { method: 'PUT', body: JSON.stringify(workflow) }),

  pickFiles: (options?: { extensions?: string[]; prompt?: string }) => {
    const params = new URLSearchParams()
    if (options?.extensions?.length) params.set('extensions', options.extensions.join(','))
    if (options?.prompt) params.set('prompt', options.prompt)
    const qs = params.toString()
    return request<{ paths: string[] }>(`/api/pick-files${qs ? `?${qs}` : ''}`)
  },

  uploadFile: async (file: File, projectId?: string): Promise<string> => {
    const form = new FormData()
    form.append('file', file)
    // When a project exists, upload into the project's own directory so it stays
    // self-contained. Otherwise (e.g. during project creation) fall back to the
    // shared workspace _uploads/ folder.
    const url = projectId ? `/api/projects/${projectId}/upload-asset` : '/api/upload'
    const res = await fetch(url, { method: 'POST', body: form })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new Error(err.detail?.message ?? err.message ?? res.statusText)
    }
    const { path } = await res.json() as { path: string }
    return path
  },

  deleteProject: (id: string, opts?: { preserveAssets?: boolean }) => {
    // When preserveAssets is set, the server walks the project's storyboard
    // imageRefs/styleRefs, moves any workspace-resident files into
    // <workspace>/_uploads/ before rmtree, and returns {preserved: {old: new}}.
    // Used by the editor's "back to setup" flow so refs survive the round-trip
    // through the new-project form prefill. Without this, prefill paths point
    // into a workspace that no longer exists and the next create fails with
    // `Image ref not found`.
    const qs = opts?.preserveAssets ? '?preserve_assets=true' : ''
    return request<{ preserved: Record<string, string> } | void>(
      `/api/projects/${id}${qs}`, { method: 'DELETE' }
    )
  },

  rerun: (id: string, params?: { prompt?: string; workflow?: string; versionName?: string }) =>
    request<Project>(`/api/projects/${id}/rerun`, { method: 'POST', body: JSON.stringify(params ?? {}) }),

  generateProxies: (id: string) =>
    request<{ scheduled: number; alreadyFresh: number }>(`/api/projects/${id}/proxies`, { method: 'POST' }),

  /**
   * Poll the background proxy-generation drain. `running` is 0 or 1
   * (single-worker drain); `queued` is how many are waiting behind it.
   * Backs the passive header indicator (ProxyActivityIndicator) — the
   * server returns zeros rather than erroring when the queue hasn't been
   * touched yet, so this is safe to poll unconditionally.
   */
  proxyStatus: () =>
    request<{ running: number; queued: number }>('/api/proxies/status'),

  /**
   * Kick a background ingest of a new source clip (probe → normalize → proxy
   * → register in `project.sources`). Returns a job id to poll via
   * `getSourceJobStatus`. Backs `EditorAdapter.ingestSource`.
   */
  ingestSource: (projectId: string, path: string) =>
    request<{ job_id: string }>(`/api/projects/${projectId}/sources`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** Poll status for a job kicked off by `ingestSource`. */
  getSourceJobStatus: (projectId: string, jobId: string) =>
    request<{ status: string; phase?: string; result?: unknown; error?: string }>(
      `/api/projects/${projectId}/sources/status/${jobId}`,
    ),

  listWorkflows: () => request<Workflow[]>('/api/workflows'),

  getWorkflow: (name: string) => request<Record<string, unknown>>(`/api/workflows/${name}`),

  listVersions: (id: string) =>
    request<ProjectVersion[]>(`/api/projects/${id}/versions`),

  restoreVersion: (id: string, hash: string) =>
    request<Project>(`/api/projects/${id}/versions/${hash}/restore`, { method: 'POST' }),

  /**
   * Checkpoint the current on-disk project as a manual version (git commit of
   * project.json, no other side effects). `name` becomes the commit's label;
   * omitted, the server falls back to "manual save". Returns the updated
   * version list (same shape as `listVersions`).
   */
  saveVersion: (id: string, name?: string) =>
    request<ProjectVersion[]>(`/api/projects/${id}/versions`, {
      method: 'POST',
      body: JSON.stringify(name === undefined ? {} : { name }),
    }),

  getInfo: () => request<{ skill_path: string; root_skill_path: string; style_profile_skill_path: string }>('/api/info'),

  listProfiles: () => request<Profile[]>('/api/profiles'),

  getProfile: (name: string) => request<Profile>(`/api/profiles/${name}`),

  listGlobalOverlays: () => request<GlobalOverlay[]>('/api/overlays'),

  listSystemOverlays: () => request<GlobalOverlay[]>('/api/overlays/system'),

  createOverlayGroup: (name: string) =>
    request<{ name: string }>('/api/overlays/groups', { method: 'POST', body: JSON.stringify({ name }) }),

  listProfileOverlays: (profileName: string) =>
    request<GlobalOverlay[]>(`/api/profiles/${profileName}/overlays`),

  createProfileOverlayGroup: (profileName: string, name: string) =>
    request<{ name: string }>(`/api/profiles/${profileName}/overlays/groups`, { method: 'POST', body: JSON.stringify({ name }) }),

  listProfileAssets: (profileName: string) =>
    request<ProfileAssetsResponse>(`/api/profiles/${profileName}/assets`),

  uploadProfileAsset: (profileName: string, file: File, onProgress?: (loaded: number, total: number) => void) =>
    new Promise<{ filename: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/profiles/${profileName}/assets`)
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total) }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText))
        } else {
          try {
            const err = JSON.parse(xhr.responseText)
            reject(new Error(err.detail?.message ?? err.message ?? xhr.statusText))
          } catch {
            reject(new Error(xhr.statusText))
          }
        }
      }
      xhr.onerror = () => reject(new Error('Network error'))
      const form = new FormData()
      form.append('file', file)
      xhr.send(form)
    }),

  deleteProfileAsset: (profileName: string, filename: string) =>
    request<void>(`/api/profiles/${profileName}/assets/${encodeURIComponent(filename)}`, { method: 'DELETE' }),

  updateProfileAssetsSummary: (profileName: string, summary: string) =>
    request<ProfileAssetsManifest>(`/api/profiles/${profileName}/assets/manifest/summary`, {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    }),

  updateProfileAssetEntry: (profileName: string, filename: string, entry: ProfileAssetEntry) =>
    request<ProfileAssetEntry>(`/api/profiles/${profileName}/assets/manifest/files/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      body: JSON.stringify(entry),
    }),

  addProfileAssetToProject: (projectId: string, profile: string, filename: string) =>
    request<Project>(`/api/projects/${projectId}/assets`, {
      method: 'POST',
      body: JSON.stringify({ from: { profile, filename } }),
    }),

  reservePath: (projectId: string, body: { prefix: string; extension: string }) =>
    request<{ path: string }>(`/api/projects/${projectId}/reserve-path`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  logStatus: (projectId: string, message: string) =>
    request<void>(`/api/projects/${projectId}/log`, { method: 'POST', body: JSON.stringify({ message }) }),

  /**
   * One-shot render status snapshot. The SSE `done` event carries only the
   * primary path; a `both` export's full file list (`outputPaths`) lives here.
   */
  renderStatus: (projectId: string) =>
    request<{ status: string; outputPath?: string; outputPaths?: string[]; error?: string }>(
      `/api/projects/${projectId}/render/status`,
    ),

  /**
   * Start a render and stream its SSE progress.
   *
   * `opts` becomes the request body the render route reads: `export` picks the
   * deliverables an HDR project produces (auto | sdr | both), `sdrCurve` names
   * the HDR→SDR tone curve, `name` is the output base filename, and `cover` is
   * the poster-frame timecode (project seconds). Omitted → no body, which the
   * route treats as the historical defaults (`auto`, default curve).
   */
  renderProject: (
    projectId: string,
    onLog:   (line: string) => void,
    onDone:  (outputPath: string) => void,
    onError: (msg: string) => void,
    opts?: { export?: string; sdrCurve?: string; name?: string; cover?: number },
  ): Promise<() => void> => {
    const body: Record<string, unknown> = {}
    if (opts?.export) body.export = opts.export
    if (opts?.sdrCurve) body.sdrCurve = opts.sdrCurve
    if (opts?.name) body.name = opts.name
    if (opts?.cover !== undefined) body.cover = opts.cover
    const init: RequestInit = Object.keys(body).length > 0
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST' }

    return fetch(`/api/projects/${projectId}/render`, init).then(res => {
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
    })
  },

  /**
   * Regenerate the project's captions and stream the pipeline's SSE progress.
   *
   * Same transport as `renderProject` above — the POST opens a
   * `text/event-stream` whose log/done/error frames drive these callbacks —
   * with two deliberate differences:
   *
   *  1. `done` carries the caption track as JSON, not an output path. The RAW
   *     string is handed to `onDone` verbatim so this module stays free of the
   *     editor's `Captions` type; the adapter parses it.
   *  2. A 409 is an EXPECTED outcome (a caption job for this project is already
   *     in flight — the user clicked twice), so it is surfaced through
   *     `onError` rather than rejecting the promise. Every other non-ok status
   *     keeps `renderProject`'s throwing behaviour.
   *
   * `opts` becomes the request body the caption route reads: `model` (whisper
   * model), `language` (source-language hint; omit to auto-detect) and `style`
   * (caption style to seed the new track with). Omitted → no body, which the
   * route treats as its own defaults (large / auto / the existing style).
   */
  generateCaptions: (
    projectId: string,
    onLog:   (line: string) => void,
    onDone:  (captionsJson: string) => void,
    onError: (msg: string) => void,
    opts?: { model?: string; language?: string; style?: string },
  ): Promise<() => void> => {
    const body: Record<string, unknown> = {}
    if (opts?.model) body.model = opts.model
    if (opts?.language) body.language = opts.language
    if (opts?.style) body.style = opts.style
    const init: RequestInit = Object.keys(body).length > 0
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST' }

    return fetch(`/api/projects/${projectId}/captions`, init).then(res => {
      if (!res.ok) {
        return res.json().catch(() => ({})).then((err) => {
          const message = err.detail?.message ?? res.statusText
          // 409 `concurrent_caption_job` is a plain JSON error, not an SSE
          // frame, and it is a normal thing for the user to hit. Report it on
          // the error channel and hand back a no-op cancel so the caller's
          // stream terminates cleanly instead of rejecting.
          if (res.status === 409) {
            onError(message)
            return () => {}
          }
          throw new Error(message)
        })
      }
      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      // Set only by an actual terminal SSE frame (`done` or `error`) — NOT by
      // the reader reporting `done`. Those are different things: the server
      // can close the response body mid-pipeline (an exception the route
      // doesn't convert to its own `event: error` frame — see the catch-all
      // in serve/routes/projects.py's `event_stream`) without ever emitting
      // a terminal frame. Left unchecked, the read loop below would just
      // exit quietly, `onDone`/`onError` would never fire, the adapter's
      // `finish()` would never run, and CaptionRegenModal's `for await` would
      // hang on its progress state forever with nothing to show for it.
      let sawTerminal = false

      function parseSse(chunk: string) {
        buf += chunk
        const messages = buf.split('\n\n')
        buf = messages.pop() ?? ''
        for (const msg of messages) {
          let event = 'message', data = ''
          for (const line of msg.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim()
            // NOT trimmed: a `done` frame's caption-track JSON must survive verbatim.
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          // Log lines arrive pre-labelled as `[label] text`; passed through
          // untouched — the modal colour-codes on the text.
          if (event === 'log')   onLog(data)
          if (event === 'done')  { sawTerminal = true; onDone(data) }
          if (event === 'error') { sawTerminal = true; onError(data) }
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
          // The body closed without a terminal frame ever arriving — report
          // it on the error channel so the caller's stream still terminates
          // instead of hanging silently.
          if (!cancelled && !sawTerminal) onError('Caption stream ended without a result')
        } catch (e) {
          if (!cancelled) onError(String(e))
        }
      })()

      return () => { cancelled = true; reader.cancel() }
    })
  },
}

/** Build a URL that serves a local file through montaj serve. */
export function fileUrl(absolutePath: string) {
  return `/api/files?path=${encodeURIComponent(absolutePath)}`
}

/**
 * Build the URL for a rendered frame from a specific version. `commit` is a
 * git commit hash, or the literal string `"working"` for the live on-disk
 * state; `t` is the timestamp in seconds. Used as an `<img src>` — the
 * server renders and returns a PNG (GET /api/projects/:id/versions/:commit/frame).
 */
export function versionFrameUrl(id: string, commit: string, t: number) {
  return `/api/projects/${id}/versions/${encodeURIComponent(commit)}/frame?t=${t}`
}
