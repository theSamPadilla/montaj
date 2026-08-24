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
 *   - generateCaptions → `api.generateCaptions`
 *                       (POST /api/projects/:id/captions SSE), adapted the
 *                       same way into an `AsyncIterable<CaptionEvent>`.
 *   - resolveImageSrc → Montaj's workspace/files URL rule, replicated from
 *                       SlideCanvas's `resolveAsset`: absolute/data URLs pass
 *                       through; workspace paths route via `/api/files?path=`.
 *
 * `listMedia` is intentionally omitted — Montaj has no media-library endpoint
 * the editor consumes; image sources are workspace paths added via upload /
 * AI-generation, not a queryable library. The editor feature-detects its
 * absence.
 */
import { api, fileUrl, versionFrameUrl } from '@/lib/api'
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
  AnalyzeAudioPolishArgs,
  AudioPolishAnalysis,
  CaptionEvent,
  GenerateCaptionsOptions,
  Captions,
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

// Per (projectId, src) cache of pending whole-source audio-polish job
// promises — `voice` (vocal isolation) and `silence-check` (the dry-run
// keeps preview), the two EXPENSIVE, whole-source pieces `analyzeAudioPolish`
// can be asked for. Multiple clips routinely share one source, so this
// dedupes concurrent/repeat callers the same way `peaksCache`/`filmstripCache`
// do above (cache the *promise*, not the resolved value). The other three
// pieces (`silence`, `fillers`, `loudness`) are per-clip WINDOWED calls and
// are deliberately not cached anywhere: caching by src alone would return a
// different clip's window, and a cache key spanning the full window would
// dedupe next to nothing.
const voiceCache = new Map<string, Promise<Extract<AudioPolishAnalysis, { piece: 'voice' }>>>()
const silenceCheckCache = new Map<string, Promise<Extract<AudioPolishAnalysis, { piece: 'silence-check' }>>>()

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
 * Strips the extension off a path — used to derive `stem_separation`'s
 * default output directory without reading anything back from the server
 * (see the `voice` case below). Only the last dot IN THE BASENAME counts: a
 * dot in a directory segment is ignored, and a basename that starts with a
 * dot (a dotfile, e.g. `.bashrc`) is left untouched.
 *
 * Parity with Python's `os.path.splitext` is a COMPATIBILITY REQUIREMENT
 * here, not defensive coding: `steps/audio/stem_separation.py` computes its
 * own output dir with `os.path.splitext(args.input)[0]`, and this is the
 * client-side reimplementation that has to agree with it bit-for-bit — any
 * divergence produces a `vocalsPath` that doesn't point at the file the step
 * actually wrote. See `montajAdapter.audioPolish.test.ts`'s dedicated
 * edge-case tests (dot-in-directory, extensionless, dotfile, dotfile+ext).
 */
function stripExtension(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  if (dot <= slash + 1) return path
  return path.slice(0, dot)
}

/**
 * Maps a `rm_nonspeech`/`rm_fillers` windowed `cuts` array to
 * `AudioPolishAnalysis`'s `removals` shape. `text` is only ever present on
 * `rm_fillers`' cuts (the matched filler word); passed through when the step
 * supplies it, omitted otherwise, so a `silence` result never carries a
 * stray `text: undefined`. Defaults to `[]` when the step didn't windowed
 * (no `cuts` key at all) rather than throwing — a defensive fallback, not an
 * expected path, since `analyzeAudioPolish` always windows these two pieces.
 */
function cutsToRemovals(
  cuts: Array<{ start: number; end: number; text?: string }> | undefined,
): Array<{ start: number; end: number; text?: string }> {
  return (cuts ?? []).map((c) =>
    c.text !== undefined ? { start: c.start, end: c.end, text: c.text } : { start: c.start, end: c.end },
  )
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
              { export: opts?.export, sdrCurve: opts?.sdrCurve, name: opts?.name, cover: opts?.cover },
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

    // Kick a background source ingest. A `File` input is staged into the
    // project directory first via `uploadFile` (returns the staged abs path),
    // then that path (or an already host-resolvable `input.path`) is handed to
    // `POST /api/projects/:id/sources`. The caller polls the returned job id
    // via `getSourceJobStatus`.
    ingestSource: async (
      projectId: string,
      input: { path: string } | File,
    ): Promise<{ jobId: string }> => {
      const path = input instanceof File
        ? await api.uploadFile(input, projectId)
        : input.path
      const { job_id } = await api.ingestSource(projectId, path)
      return { jobId: job_id }
    },

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

    /** Publish the live playhead/selection so the MCP server can read it.
     *  Swallows every failure: this is a convenience channel and must never
     *  make the editor look broken when serve is busy or restarting. */
    reportContext: async (id, context) => {
      try {
        await api.reportContext(id, context)
      } catch {
        // Intentionally silent — see above.
      }
    },

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

    // Save → `POST /api/projects/:id/versions`, mapped down to the same
    // VersionEntry slice as listVersionHistory.
    saveVersion: (id: string, name?: string): Promise<VersionEntry[]> =>
      api.saveVersion(id, name).then(vs => vs.map(v => ({ hash: v.hash, message: v.message, timestamp: v.timestamp }))),

    // Version frame URL → thin delegate to `GET /api/projects/:id/versions/:commit/frame`.
    versionFrameUrl: (id: string, commit: string, t: number): string =>
      versionFrameUrl(id, commit, t),

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
      // Fast preview from the SDR proxy (cover + cover grid). Mutually exclusive
      // with sdrCurve — a proxy frame can't show a per-curve grade — so callers
      // pass one or the other.
      if (opts?.preferProxy) stepArgs['prefer-proxy'] = true

      const result = await api.runStepAsync<{ path: string }>('sample_frame', stepArgs)
      return { url: fileUrl(result?.path ?? outPath) }
    },

    // Audio polish → one of Montaj's four audio-polish step CLIs (or a
    // `waveform_trim` dry run for `silence-check`), picked by `piece`. Every
    // time in `args.window`/the result is SOURCE time — untouched, never
    // converted to timeline time (that's the caller's job; see the
    // `AudioPolishAnalysis` doc in editor-core's `types.ts`). `window: win`
    // renames the destructured field so it doesn't shadow the DOM global
    // `window`.
    analyzeAudioPolish: async (args: AnalyzeAudioPolishArgs): Promise<AudioPolishAnalysis> => {
      const { projectId, piece, src, window: win, options } = args

      switch (piece) {
        case 'silence': {
          const stepArgs: Record<string, unknown> = { input: src }
          if (win) {
            stepArgs['window-in'] = win.in
            stepArgs['window-out'] = win.out
          }
          if (options?.language !== undefined) stepArgs.language = options.language
          if (options?.model !== undefined) stepArgs.model = options.model
          if (options?.maxWordGap !== undefined) stepArgs['max-word-gap'] = options.maxWordGap
          if (options?.sentenceEdge !== undefined) stepArgs['sentence-edge'] = options.sentenceEdge

          const result = await api.runStepAsync<{
            cuts?: Array<{ start: number; end: number; text?: string }>
          }>('rm_nonspeech', stepArgs)
          return { piece, removals: cutsToRemovals(result.cuts) }
        }

        case 'fillers': {
          const stepArgs: Record<string, unknown> = { input: src }
          if (win) {
            stepArgs['window-in'] = win.in
            stepArgs['window-out'] = win.out
          }
          if (options?.language !== undefined) stepArgs.language = options.language
          if (options?.model !== undefined) stepArgs.model = options.model

          const result = await api.runStepAsync<{
            cuts?: Array<{ start: number; end: number; text?: string }>
          }>('rm_fillers', stepArgs)
          return { piece, removals: cutsToRemovals(result.cuts) }
        }

        case 'loudness': {
          // Measure-only: the server prints the loudnorm pass-1 stats and
          // exits, no --out needed (see steps/media/normalize.json).
          const stepArgs: Record<string, unknown> = { input: src, 'measure-only': true }
          if (win) {
            stepArgs['window-in'] = win.in
            stepArgs['window-out'] = win.out
          }
          // `target` is an enum (youtube/podcast/broadcast/custom); `lufs`
          // is read only when target is 'custom' — so the two travel
          // together, and are omitted together to keep the step's own
          // default preset (youtube, -14 LUFS) when the caller passed none.
          if (options?.targetLufs !== undefined) {
            stepArgs.target = 'custom'
            stepArgs.lufs = options.targetLufs
          }

          const result = await api.runStepAsync<{
            input_i: number | string
            input_tp: number | string
            input_lra: number | string
            target_i: number | string
          }>('normalize', stepArgs)
          // normalize.py emits these as real JSON numbers as of the current
          // step version, but this adapter call is the boundary where an
          // untyped JSON payload from the step becomes a typed
          // AudioPolishAnalysis, and that is exactly where defensive
          // coercion belongs. ffmpeg's own loudnorm filter (which
          // normalize.py wraps) prints its pass-1 measurements as JSON
          // *strings*, so an older `montaj serve` still running a prior
          // step version -- or any future regression at the source -- must
          // not be able to hand the modal a string that crashes its
          // .toFixed() calls (see SP8c postmortem: AudioPolishModal.tsx
          // crashed exactly this way).
          const measuredI = Number(result.input_i)
          const measuredTP = Number(result.input_tp)
          const measuredLRA = Number(result.input_lra)
          const targetI = Number(result.target_i)
          // Applied gain = the level change (targetI - measuredI) held back
          // by a true-peak guard so the gain never pushes true peak above
          // -1.5 dBTP — NOT loudnorm's own dynamic pass (which additionally
          // limits/compresses; deliberately not what this preview computes).
          // A quiet-average/hot-peak clip (headroom-recorded speech is the
          // common case) needs the guard to win, and gainDb legitimately
          // comes out negative when it does — that's correct, not a bug.
          // Canonical sibling: editor/src/video/audioPolish.ts's
          // `loudnessGainDb(stats, targetI)` implements this exact formula;
          // the two must stay in sync until they're unified behind one
          // export (see SP8c coordination note).
          const gainDb = Math.min(targetI - measuredI, -1.5 - measuredTP)
          return {
            piece,
            measuredI,
            measuredTP,
            measuredLRA,
            targetI,
            gainDb,
          }
        }

        case 'voice': {
          const key = `${projectId}:${src}`
          const existing = voiceCache.get(key)
          if (existing) return existing

          // stem_separation prints only the manifest JSON's path (wrapped by
          // the server as `{path, type}`, not its content — unlike
          // rm_nonspeech/rm_fillers/normalize, which print their JSON result
          // directly). We still don't need to read it: NO --out-dir is sent
          // here, deliberately unlike getFilmstrip's `.cache/filmstrips/...`
          // convention — do not "harmonise" these. A filmstrip is a
          // disposable, regenerable preview asset; a vocals stem is not — its
          // path is persisted into `project.audio.tracks[].src` and later
          // read by the RENDERER (a separate process with no guaranteed cwd),
          // which feeds it to ffmpeg as `-i`. A relative `.cache/...` path
          // would work in preview and break at export. Omitting --out-dir
          // instead lets the step fall back to its own default — `<source
          // without extension>_stems/`, next to the source (see
          // steps/audio/stem_separation.py: `out_dir = args.out_dir or
          // f"{base}_stems"`) — which is already ABSOLUTE, since `src` always
          // is. `--stems vocals` also means only vocals.wav is written there
          // (`separate()` skips every stem not requested), so the path is
          // fully deterministic.
          const promise = (async () => {
            await api.runStepAsync<{ path: string }>('stem_separation', {
              input: src,
              stems: 'vocals',
            })
            const vocalsPath = `${stripExtension(src)}_stems/vocals.wav`
            return { piece, vocalsPath, url: fileUrl(vocalsPath) } as const
          })()
          promise.catch(() => {
            if (voiceCache.get(key) === promise) voiceCache.delete(key)
          })
          voiceCache.set(key, promise)
          return promise
        }

        case 'silence-check': {
          const key = `${projectId}:${src}`
          const existing = silenceCheckCache.get(key)
          if (existing) return existing

          // Whole source, no options exposed — a dry-run preview of what
          // `silence` would keep at the step's default threshold/min-silence.
          const promise = api.runStepAsync<{ keeps: Array<[number, number]> }>(
            'waveform_trim', { input: src },
          ).then((result) => ({ piece, keeps: result.keeps }) as const)
          promise.catch(() => {
            if (silenceCheckCache.get(key) === promise) silenceCheckCache.delete(key)
          })
          silenceCheckCache.set(key, promise)
          return promise
        }

        default: {
          const exhaustiveCheck: never = piece
          throw new Error(`analyzeAudioPolish: unknown piece ${String(exhaustiveCheck)}`)
        }
      }
    },

    // Drop one compiled-overlay cache entry. The host impl requires a src; with
    // none given there is nothing to clear, so this is a no-op.
    clearOverlayCache: (src?: string): void => {
      if (src) hostClearOverlayCache(src)
    },

    // Caption regeneration → `api.generateCaptions`, bridged from its callback
    // SSE into an async iterable by exactly the same queue + promise-resolver
    // pattern `render` uses above. Events are pushed as they arrive and never
    // buffered to completion: the pipeline runs four subprocesses and can take
    // minutes on a long timeline, while the CaptionRegenModal renders the log
    // live. The terminal 'done' carries the whole fresh track, which REPLACES
    // project.captions wholesale.
    generateCaptions: (id: string, opts?: GenerateCaptionsOptions): AsyncIterable<CaptionEvent> => {
      return {
        [Symbol.asyncIterator](): AsyncIterator<CaptionEvent> {
          const queue: CaptionEvent[] = []
          let resolveNext: ((r: IteratorResult<CaptionEvent>) => void) | null = null
          let done = false
          let cancel: (() => void) | null = null

          const push = (ev: CaptionEvent) => {
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
            .generateCaptions(
              id,
              (line) => push({ type: 'log', message: line }),
              (captionsJson) => {
                // The done frame carries the caption track as raw JSON (api.ts
                // stays free of the Captions type). A malformed payload must
                // become a terminal error here — if the parse escaped, the
                // stream would never terminate and the modal would hang.
                let captions: Captions
                try {
                  captions = JSON.parse(captionsJson) as Captions
                } catch (err) {
                  push({
                    type: 'error',
                    message: `Malformed caption payload: ${err instanceof Error ? err.message : String(err)}`,
                  })
                  return
                }
                push({ type: 'done', captions })
              },
              (message) => push({ type: 'error', message }),
              { model: opts?.model, language: opts?.language, style: opts?.style },
            )
            .then((c) => { cancel = c })
            .catch((err) => {
              push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
            })

          return {
            next(): Promise<IteratorResult<CaptionEvent>> {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false })
              }
              if (done) return Promise.resolve({ value: undefined, done: true })
              return new Promise((resolve) => { resolveNext = resolve })
            },
            return(): Promise<IteratorResult<CaptionEvent>> {
              done = true
              cancel?.()
              return Promise.resolve({ value: undefined, done: true })
            },
          }
        },
      }
    },

    // Map a caption style name to the Montaj-specific template path that
    // compileOverlay understands. The `/api/caption-template/<style>` shape is
    // Montaj-specific and belongs here, not inside the host-agnostic package.
    resolveCaptionTemplate: (style: string): string =>
      `/api/caption-template/${style}`,
  }
}
