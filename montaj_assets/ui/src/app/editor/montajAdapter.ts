/**
 * montajAdapter — the Montaj-native implementation of editor-core's
 * `EditorAdapter`.
 *
 * All transport is Montaj's existing surface:
 *   - loadProject     → `api.getProject` (GET /api/projects/:id)
 *   - saveProject     → `api.saveProject` (PUT /api/projects/:id)
 *   - subscribe       → the EventSource at `/api/projects/:id/stream`
 *                       (same stream `useProjectStream` opens)
 *   - render          → `api.renderProject` (POST /api/projects/:id/render SSE),
 *                       adapted from its callback shape into an
 *                       `AsyncIterable<RenderEvent>`.
 *   - resolveImageSrc → Montaj's workspace/files URL rule, replicated from
 *                       SlideCanvas's `resolveAsset`: absolute/data URLs pass
 *                       through; workspace paths route via `/api/files?path=`.
 *
 * `listMedia` is intentionally omitted — Montaj has no media-library endpoint
 * the editor consumes; image sources are workspace paths added via upload /
 * AI-generation, not a queryable library. The editor feature-detects its
 * absence.
 */
import { api, fileUrl } from '@/lib/api'
import {
  compileOverlay as hostCompileOverlay,
  clearOverlayCache as hostClearOverlayCache,
} from '@/lib/overlay-eval'
import { watchWorkspaceFile } from '@/lib/file-watch'
import { subscribeProjectStream } from '@/lib/sse'
import type {
  EditorAdapter,
  OverlayFactory,
  ImageElement,
  RenderEvent,
  RenderOptions,
  GlobalOverlay,
  VersionEntry,
  WaveformChunk,
} from '@bycrux/editor'
// Montaj instantiates the editor's generic adapter with its full project type,
// so loaded/saved/streamed frames keep Montaj's pipeline fields end-to-end.
import type { Project } from '@/lib/types/schema'

// Default waveform chunk duration (seconds). Folded in from the former
// `lib/audio-waveform.ts`; callers may override per-request.
const WAVEFORM_CHUNK_DURATION_S = 15

// Per (project,track,src,duration) cache of rendered waveform-chunk promises.
// Folded in from the former `lib/audio-waveform.ts` closure so the adapter owns
// the dedup. Module-level so it survives across `createMontajAdapter()` calls.
const waveformCache = new Map<string, Promise<WaveformChunk[]>>()

/** Replicates SlideCanvas's `resolveAsset` so the editor displays the same URL. */
export function resolveMontajImageSrc(element: ImageElement): string {
  const src = element.src
  if (!src) return src
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src
  }
  return `/api/files?path=${encodeURIComponent(src)}`
}

export function createMontajAdapter(): EditorAdapter<Project> {
  return {
    loadProject: (id: string): Promise<Project> => api.getProject(id),

    saveProject: async (id: string, project: Project): Promise<void> => {
      await api.saveProject(id, project)
    },

    subscribe: (id: string, onFrame: (project: Project) => void): (() => void) =>
      // Multiplex over the shared per-project SSE pool (lib/sse) rather than
      // opening a dedicated EventSource: the host page's `useProjectStream` and
      // this editor subscription would otherwise be two connections to the same
      // `/api/projects/:id/stream` URL (the pool exists to avoid the browser
      // connection-pool exhaustion that froze the editor — CHANGELOG v3.6.2).
      // 'log' events are ignored here; the host consumes those via useProjectStream.
      subscribeProjectStream(id, { onFrame }),

    render: (id: string, _opts?: RenderOptions): AsyncIterable<RenderEvent> => {
      // Bridge api.renderProject's callback SSE into an async iterable. Events
      // are buffered and handed off through a promise-resolver queue so the
      // consumer's `for await` paces naturally.
      return {
        [Symbol.asyncIterator](): AsyncIterator<RenderEvent> {
          const queue: RenderEvent[] = []
          let resolveNext: ((r: IteratorResult<RenderEvent>) => void) | null = null
          let done = false
          let cancel: (() => void) | null = null

          const push = (ev: RenderEvent) => {
            // Terminal events end the stream after delivery.
            if (resolveNext) {
              const r = resolveNext
              resolveNext = null
              r({ value: ev, done: false })
            } else {
              queue.push(ev)
            }
            if (ev.type === 'done' || ev.type === 'error') finish()
          }

          const finish = () => {
            done = true
            if (resolveNext) {
              const r = resolveNext
              resolveNext = null
              r({ value: undefined, done: true })
            }
          }

          api
            .renderProject(
              id,
              (line) => push({ type: 'log', message: line }),
              (outputPath) => push({ type: 'done', outputPath }),
              (message) => push({ type: 'error', message }),
            )
            .then((c) => { cancel = c })
            .catch((err) => {
              push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
            })

          return {
            next(): Promise<IteratorResult<RenderEvent>> {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false })
              }
              if (done) return Promise.resolve({ value: undefined, done: true })
              return new Promise((resolve) => { resolveNext = resolve })
            },
            return(): Promise<IteratorResult<RenderEvent>> {
              done = true
              cancel?.()
              return Promise.resolve({ value: undefined, done: true })
            },
          }
        },
      }
    },

    resolveImageSrc: resolveMontajImageSrc,

    compileOverlay: (template: string): Promise<OverlayFactory> =>
      hostCompileOverlay(template),

    // T4 contract methods — thin wrappers over Montaj's existing api surface.
    // Full wiring/verification of the assembled editor against these lands in T6.
    listGlobalOverlays: (): Promise<GlobalOverlay[]> => api.listGlobalOverlays(),

    listSystemOverlays: (): Promise<GlobalOverlay[]> => api.listSystemOverlays(),

    uploadFile: (file: File, projectId?: string): Promise<string> =>
      api.uploadFile(file, projectId),

    fileUrl: (path: string): string => fileUrl(path),

    listProfileOverlays: (profileName: string): Promise<GlobalOverlay[]> =>
      api.listProfileOverlays(profileName),

    getInfo: async (): Promise<{ root_skill_path?: string }> => {
      const info = await api.getInfo()
      return { root_skill_path: info.root_skill_path }
    },

    // Composes Montaj's two-step AI image flow (matches the original
    // AddElementMenu): reserve a workspace path inside the project, then run the
    // `generate_image` step writing to it. Returns the produced path.
    generateImage: async (prompt: string, projectId: string): Promise<{ path: string }> => {
      const { path: outPath } = await api.reservePath(projectId, {
        prefix: 'carousel_image',
        extension: 'png',
      })
      const result = await api.runStepAsync<{ path: string }>('generate_image', {
        prompt,
        out: outPath,
      })
      return { path: result.path }
    },

    // Watch a workspace file for changes via the SHARED global file-watch
    // stream (one EventSource per tab, ref-counted per path) instead of one
    // EventSource per watcher — overlay-dense timelines used to exhaust the
    // browser's 6-connections-per-origin pool and freeze the editor.
    watchFile: (path: string, onChange: () => void): (() => void) =>
      watchWorkspaceFile(path, onChange),

    // Resolve Montaj's shipped `static-text` system overlay — the template the
    // editor's "+ Text" button seeds. The Montaj-specific name and matcher live
    // here, not in the package. Returns null when no such template exists.
    getDefaultTextOverlay: async (): Promise<GlobalOverlay | null> => {
      const system = await api.listSystemOverlays()
      return system.find(o => !o.empty && /static-text/.test(o.jsxPath)) ?? null
    },

    // ── Video editor capabilities ──────────────────────────────────────────────

    // Version history → `GET /api/projects/:id/versions`, mapped down to the
    // editor's VersionEntry slice (hash/message/timestamp).
    listVersionHistory: async (id: string): Promise<VersionEntry[]> => {
      const versions = await api.listVersions(id)
      return versions.map(v => ({ hash: v.hash, message: v.message, timestamp: v.timestamp }))
    },

    // Restore → `POST /api/projects/:id/versions/:hash/restore`, returns the
    // restored full Montaj project.
    restoreVersion: (id: string, hash: string): Promise<Project> =>
      api.restoreVersion(id, hash),

    // Waveform chunks → the `waveform_image` step, with the dedup cache folded
    // in from the former lib/audio-waveform.ts. The output dir is namespaced by
    // track id under `.cache/waveforms/` (matches the original ensureWaveformChunks).
    getWaveformChunks: (
      projectId: string,
      trackId: string,
      trackSrc: string,
      chunkDurationS: number = WAVEFORM_CHUNK_DURATION_S,
    ): Promise<WaveformChunk[]> => {
      const key = `${projectId}:${trackId}:${trackSrc}:${chunkDurationS}`
      const existing = waveformCache.get(key)
      if (existing) return existing

      const promise = api.runStepAsync<WaveformChunk[]>('waveform_image', {
        input: trackSrc,
        'chunk-duration': chunkDurationS,
        'out-dir': `.cache/waveforms/${trackId}`,
      })
      // Evict on failure so a transient error (async job timeout, or a
      // job_not_found after a mid-job server restart) doesn't poison the
      // cache with a permanently-rejected promise — the next call retries.
      promise.catch(() => {
        if (waveformCache.get(key) === promise) waveformCache.delete(key)
      })
      waveformCache.set(key, promise)
      return promise
    },

    // Drop one compiled-overlay cache entry. The host impl requires a src; with
    // none given there is nothing to clear, so this is a no-op.
    clearOverlayCache: (src?: string): void => {
      if (src) hostClearOverlayCache(src)
    },

    // Map a caption style name to the Montaj-specific template path that
    // compileOverlay understands. The `/api/caption-template/<style>` shape is
    // Montaj-specific and belongs here, not inside the host-agnostic package.
    resolveCaptionTemplate: (style: string): string =>
      `/api/caption-template/${style}`,
  }
}
