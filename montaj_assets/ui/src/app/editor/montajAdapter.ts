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
  SampleFrameOptions,
  GlobalOverlay,
  VersionEntry,
  WaveformChunk,
  PeaksData,
  GetWaveformPeaksArgs,
  FilmstripIndex,
  GetFilmstripArgs,
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

// Per (projectId, src, window, samplesPerSecond) cache of pending peaks
// fetches. The canvas timeline (T6) re-fetches at a higher resolution bucket
// as zoom crosses each bucket's px/s ceiling, so the key includes the bucket:
// each distinct (src, window, bucket) tuple is fetched at most once.
const peaksCache = new Map<string, Promise<PeaksData>>()

// Per (projectId, src, grid params) cache of pending filmstrip fetches.
const filmstripCache = new Map<string, Promise<FilmstripIndex>>()

/**
 * Deterministic, filesystem-safe short hash of a source path — used to give
 * each source its own subfolder under a project-scoped filmstrip cache dir
 * (a project's proxied clips/tracks each need their own sheet set, unlike
 * `getWaveformPeaks`, which returns its JSON result inline with nothing
 * written to disk). Not cryptographic; only needs to avoid collisions across
 * the handful of sources a single project has.
 */
function srcCacheKey(src: string): string {
  let h = 0
  for (let i = 0; i < src.length; i++) {
    h = (Math.imul(31, h) + src.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/**
 * Directory a reserved workspace path sits in — the project directory, since
 * `reserve-path` always allocates inside it. Handles both separators so a
 * Windows-hosted workspace resolves the same way.
 */
function projectDirOf(reservedPath: string): string {
  const cut = Math.max(reservedPath.lastIndexOf('/'), reservedPath.lastIndexOf('\\'))
  return cut === -1 ? '.' : reservedPath.slice(0, cut)
}

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

    // `opts` (the RenderModal's export choice + SDR curve) rides on the POST
    // that opens the SSE stream — this host implements only the streaming
    // `render`, never `renderAsync`, so this is the one place render options
    // can reach the backend.
    render: (id: string, opts?: RenderOptions): AsyncIterable<RenderEvent> => {
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
              (outputPath) => {
                // The SSE done frame carries one path by contract. A `both`
                // export produced a second file (the derived SDR sibling) —
                // pick the full list up from the status snapshot, best-effort:
                // any failure just emits the single-path event as before.
                if (opts?.export === 'both') {
                  api.renderStatus(id)
                    .then((snap) => {
                      const paths = snap.outputPaths
                      push(paths && paths.length > 1
                        ? { type: 'done', outputPath, outputPaths: paths }
                        : { type: 'done', outputPath })
                    })
                    .catch(() => push({ type: 'done', outputPath }))
                } else {
                  push({ type: 'done', outputPath })
                }
              },
              (message) => push({ type: 'error', message }),
              { export: opts?.export, sdrCurve: opts?.sdrCurve },
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

    // Waveform peaks → the `waveform_peaks` step, the canvas-timeline sibling
    // of `getWaveformChunks`. Input-selection policy is the CALLER's job, not
    // this method's: `item.proxySrc` (proxy only, no fallback to the original)
    // for per-clip waveforms on visual tracks, `track.src` for audio lanes
    // (SP5 plan decision 5, proxy-only as resolved in T6). The
    // step returns its `{samplesPerSecond, start, duration, peaks}` JSON
    // inline — no `--out-dir`, nothing is written to the workspace.
    getWaveformPeaks: (args: GetWaveformPeaksArgs): Promise<PeaksData> => {
      const { projectId, src, samplesPerSecond, start, duration } = args
      const key = `${projectId}:${src}:${start ?? ''}:${duration ?? ''}:${samplesPerSecond}`
      const existing = peaksCache.get(key)
      if (existing) return existing

      const stepArgs: Record<string, unknown> = {
        input: src,
        'samples-per-second': samplesPerSecond,
      }
      if (start !== undefined) stepArgs.start = start
      if (duration !== undefined) stepArgs.duration = duration

      const promise = api.runStepAsync<PeaksData>('waveform_peaks', stepArgs)
      // Evict on failure so a transient error doesn't poison the cache with a
      // permanently-rejected promise — the next call retries (same pattern as
      // getWaveformChunks above).
      promise.catch(() => {
        if (peaksCache.get(key) === promise) peaksCache.delete(key)
      })
      peaksCache.set(key, promise)
      return promise
    },

    // Filmstrip → the `filmstrip` step. PROJECT-SCOPED and per-source (unlike
    // the waveform PNG cache's workspace-global by-trackId shape): a
    // project's proxied clips/tracks each get their own sheet set under
    // `.cache/filmstrips/<projectId>/<hash of src>/`.
    getFilmstrip: (args: GetFilmstripArgs): Promise<FilmstripIndex> => {
      const { projectId, src, maxTiles, minInterval, tileWidth } = args
      const key = `${projectId}:${src}:${maxTiles ?? ''}:${minInterval ?? ''}:${tileWidth ?? ''}`
      const existing = filmstripCache.get(key)
      if (existing) return existing

      const stepArgs: Record<string, unknown> = {
        input: src,
        'out-dir': `.cache/filmstrips/${projectId}/${srcCacheKey(src)}`,
      }
      if (maxTiles !== undefined) stepArgs['max-tiles'] = maxTiles
      if (minInterval !== undefined) stepArgs['min-interval'] = minInterval
      if (tileWidth !== undefined) stepArgs['tile-width'] = tileWidth

      const promise = api.runStepAsync<FilmstripIndex>('filmstrip', stepArgs)
      promise.catch(() => {
        if (filmstripCache.get(key) === promise) filmstripCache.delete(key)
      })
      filmstripCache.set(key, promise)
      return promise
    },

    // Sample frame → the `sample_frame` step, composited at project resolution
    // and tone-mapped through `sdrCurve` when the project is HDR. Composes the
    // same two-step flow as `generateImage`: reserve a path inside the project
    // (each curve gets its own file, so two samples of the same timestamp don't
    // collide), then run the step writing to it. The reserved path also tells
    // us the project directory, which is how we address the project.json the
    // step wants — the editor only ever knows the project id.
    getSampleFrame: async (
      projectId: string,
      at: number,
      opts?: SampleFrameOptions,
    ): Promise<{ url: string }> => {
      const { path: outPath } = await api.reservePath(projectId, {
        prefix: 'sdr_sample',
        extension: 'png',
      })
      const stepArgs: Record<string, unknown> = {
        project: `${projectDirOf(outPath)}/project.json`,
        at,
        out: outPath,
      }
      // Kebab-case: the step server matches body keys to the step schema's
      // declared param names (`--sdr-curve`), rejecting anything unrecognized.
      if (opts?.sdrCurve) stepArgs['sdr-curve'] = opts.sdrCurve

      const result = await api.runStepAsync<{ path: string }>('sample_frame', stepArgs)
      return { url: fileUrl(result?.path ?? outPath) }
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
