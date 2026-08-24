/**
 * editor-core / types — the host-agnostic boundary for Montaj's carousel
 * editor.
 *
 * The editor module knows nothing about *where* a project lives or *how* it is
 * transported. The host application (Montaj's own UI, or a Next.js client app
 * like mission-control) supplies an `EditorAdapter` that implements load / save
 * / subscribe / render / image-resolution against whatever transport it owns.
 *
 * The canonical project/slide/element shapes live in `./schema` (the package's
 * own editor-facing schema). Internally we alias `EditorProject` to `Project`
 * so the ported reducer/hook/tests keep their original naming. These names are
 * re-exported from this module so the package's internal modules can import
 * them from `../types`; the public barrel (index.ts) sources the schema types
 * from `./schema` directly to avoid duplicate-export conflicts.
 */
import type { ReactElement, ReactNode } from 'react'
import type {
  EditorProject as Project,
  Slide,
  CarouselElement,
  ImageElement,
  OverlayElement,
  Captions,
} from './schema'
import type { ImageTone } from './video/imageTone'
import type { SourcePreviewStore } from './video/source-preview'

// ── Overlay compiler ─────────────────────────────────────────────────────────

/**
 * A compiled overlay factory: given the current frame/fps/durationFrames and
 * the overlay's runtime props, returns a React element (or null on error).
 * Matches the signature produced by `lib/overlay-eval`'s `compileOverlay`.
 */
export type OverlayFactory = (
  frame: number,
  fps: number,
  durationFrames: number,
  props: Record<string, unknown>,
) => ReactElement | null

// ── Re-exported canonical carousel types ─────────────────────────────────────
// schema.ts is the single source of truth. Consumers of editor-core import
// these from here so the module presents one coherent surface.
export type { Project, Slide, CarouselElement, ImageElement, OverlayElement }

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * A single frame of render progress. Discriminated on `type`:
 *  - 'log'   — a human-readable progress line.
 *  - 'done'  — terminal success; `outputPath` is the rendered artifact location
 *              (a host-resolvable path/URL — Montaj returns a workspace path,
 *              a Hub client may return a media URL).
 *  - 'error' — terminal failure; `message` describes what went wrong.
 */
export type RenderEvent =
  | { type: 'log'; message: string }
  /**
   * `outputPath` is always the primary (master) file. `outputPaths` is present
   * only when the render emitted more than one file (an `--export both` HDR
   * render: master first, derived SDR sibling second) AND the host was able to
   * learn the full list — hosts that can't simply omit it.
   */
  | { type: 'done'; outputPath: string; outputPaths?: string[] }
  | { type: 'error'; message: string }

/**
 * Which file(s) a render produces for an HDR project:
 *  - 'auto' — one master in the project's own color space (an HDR project stays
 *             HDR). The historical behavior and the default.
 *  - 'sdr'  — one standard-range file, tone-mapped through `sdrCurve`.
 *  - 'both' — the HDR master plus an SDR sibling derived from it.
 * SDR projects are unaffected: every value renders the same single SDR file.
 */
export type RenderExport = 'auto' | 'sdr' | 'both'

/**
 * Options for a render request. Hosts ignore fields they don't support, and
 * omitting the whole object keeps a host's default behavior.
 */
export interface RenderOptions {
  /** Output scale multiplier (1 = native resolution). */
  scale?: number
  /** Which file(s) an HDR project exports. Defaults to 'auto' host-side. */
  export?: RenderExport
  /**
   * Id of the HDR→SDR tone curve used for any SDR output (see
   * `video/sdrCurves.ts` for the descriptors, and the `curves` keys in
   * montaj_assets/luts/looks.json for what a host validates against). Typed as
   * `string` so a host can ship curves the package doesn't know about; ignored
   * when the render produces no SDR file.
   */
  sdrCurve?: string
  /**
   * Output base filename (no extension) for the rendered file, from the export
   * dialog's Name field. Hosts that support naming the output read this; others
   * ignore it. Omitted → the host's default naming applies.
   */
  name?: string
  /**
   * Poster/cover frame timecode in project-timeline seconds, from the export
   * dialog's cover picker. Hosts that produce a cover read this; others ignore
   * it. Omitted → the host's default (e.g. first frame) applies.
   */
  cover?: number
}

/**
 * Options for a sample-frame request. Only the SDR curve for now — the frame
 * itself is identified by the project id and timestamp.
 */
export interface SampleFrameOptions {
  /** Tone curve to map an HDR project's frame through (see `RenderOptions.sdrCurve`). */
  sdrCurve?: string
  /**
   * Prefer each clip's SDR proxy over the full-resolution master for a fast
   * preview (cover posters, the cover-frame grid). The proxy is already SDR, so
   * this is mutually exclusive with `sdrCurve` — a proxy frame cannot show a
   * per-curve HDR→SDR grade. Adapters that can't sample from a proxy may ignore
   * it. Falls back to the master per clip when no proxy exists.
   */
  preferProxy?: boolean
}

/**
 * Coarse phase of an async render pipeline. Ordered roughly by execution order;
 * hosts may skip phases that don't apply to their pipeline — `sdr_derive` in
 * particular only runs when an HDR project exports SDR (`export: 'sdr' | 'both'`).
 */
export type RenderPhase =
  | 'preparing'
  | 'rendering'
  | 'captions'
  | 'encoding'
  | 'sdr_derive'
  | 'saving'
  | 'done'

/**
 * Point-in-time snapshot of an async render's progress. Returned by
 * `EditorAdapter.getRenderStatus`; safe to poll on any cadence.
 *
 *  - `'idle'`    — no render has been kicked off (or results were cleared).
 *  - `'running'` — render is in progress; `phase` indicates where in the
 *                  pipeline it currently is.
 *  - `'done'`    — render completed successfully; `media` carries the promoted
 *                  outputs.
 *  - `'error'`   — render failed; `error` carries a human-readable message.
 */
export interface RenderStatus {
  status: 'idle' | 'running' | 'done' | 'error'
  phase?: RenderPhase
  /** Promoted render outputs as directly-fetchable (R2 presigned) media. */
  media?: Array<{ id: string; filename: string; contentType: string; url: string }>
  error?: string
}

// ── Caption regeneration ─────────────────────────────────────────────────────

/**
 * A single frame of caption-regeneration progress. Discriminated on `type`:
 *  - 'log'   — a human-readable progress line.
 *  - 'done'  — terminal success; `captions` is the freshly transcribed caption
 *              track to patch onto the project.
 *  - 'error' — terminal failure; `message` describes what went wrong (the host
 *              route may emit `multi_source`/`no_clips`/`empty_keeps` — shown
 *              verbatim).
 */
export type CaptionEvent =
  | { type: 'log'; message: string }
  | { type: 'done'; captions: Captions }
  | { type: 'error'; message: string }

/**
 * Options for a caption-regeneration request. All optional — the host fills in
 * sensible defaults (multilingual whisper model + auto-detected language).
 */
export interface GenerateCaptionsOptions {
  /** Whisper model to run (e.g. 'large'). */
  model?: string
  /** Source-language hint (e.g. 'es'); omit to auto-detect. */
  language?: string
  /** Caption style to seed the regenerated track with. */
  style?: string
}

// ── Overlay library types ─────────────────────────────────────────────────────
// Copied verbatim from Montaj's `ui/src/lib/api.ts` so the package owns the
// shape the editor consumes. A host's overlay-listing endpoints return these;
// the adapter wraps whatever transport produces them.

/**
 * A single declared prop on an overlay template. `type` drives the input
 * control the editor renders; `default` seeds an unset value.
 */
export interface GlobalOverlayProp {
  name: string
  type: 'string' | 'int' | 'float' | 'bool' | 'color'
  default?: unknown
  description?: string
}

/**
 * A reusable overlay template the host exposes (global, system, or
 * profile-scoped). `jsxPath` is the host-resolvable path to the JSX template
 * the adapter feeds to `compileOverlay`; `group` is an optional UI grouping;
 * `empty` flags a placeholder group with no concrete overlay yet.
 */
export interface GlobalOverlay {
  name: string
  description: string
  props: GlobalOverlayProp[]
  jsxPath: string
  group?: string
  empty?: boolean
}

// ── Version history (optional capability) ─────────────────────────────────────

/**
 * A single entry in a project's version history. The editor-relevant slice of
 * Montaj's `ProjectVersion` (ui/src/lib/types/schema.ts): a content-addressed
 * `hash` to restore by, a human-readable `message`, and a `timestamp`. The
 * adapter maps the host's richer shape down to this.
 */
export interface VersionEntry {
  hash: string
  message: string
  timestamp: string
}

// ── Host path resolution ─────────────────────────────────────────────────────

/**
 * Resolves a host-internal asset path into a displayable URL (e.g. Montaj's
 * `/api/files?path=…`). This is `EditorAdapter.fileUrl`'s signature, named so
 * the components it is threaded down to as a prop can type it without
 * depending on the whole adapter: the canvas timeline takes it to display the
 * `path`s that come back on `WaveformChunk` and `FilmstripSheet` below.
 * Optional wherever it is a prop — a host that omits it gets identity, and the
 * feature that needed the URL degrades to nothing rather than erroring.
 */
export type ResolveFilePath = (path: string) => string

// ── Waveform chunks (optional capability) ─────────────────────────────────────

/**
 * One rendered waveform-image chunk for an audio track. `path` is a
 * host-resolvable image path (route through `fileUrl` to display); `start`/`end`
 * are source-file seconds the chunk covers. Copied verbatim from Montaj's former
 * `lib/audio-waveform.ts` so the package owns the shape the timeline consumes.
 */
export interface WaveformChunk {
  path: string
  start: number
  end: number
}

// ── Waveform peaks & filmstrips (optional capability) ─────────────────────────

/**
 * Zoom-bucketed audio peak data for a scrubbable waveform view — the
 * canvas-rendered replacement for `WaveformChunk`'s fixed PNGs. `peaks` is
 * interleaved `[min, max, min, max, ...]`, one pair per sample bucket, values
 * in int16 range. `samplesPerSecond` is normally one of the requested
 * resolution buckets (50 | 200 | 800) but may come back as a lower,
 * non-bucketed number when the host's total-samples clamp forced a step-down
 * for a long window — the actual resolution used, never silently truncated,
 * hence `number` rather than a literal union. `start`/`duration` echo the
 * decoded source-time window in seconds. Maps to Montaj's `waveform_peaks`
 * step.
 */
export interface PeaksData {
  samplesPerSecond: number
  start: number
  duration: number
  peaks: number[]
}

/** The three bucketed resolutions `getWaveformPeaks` may request. */
export type PeaksResolution = 50 | 200 | 800

/**
 * Args for `EditorAdapter.getWaveformPeaks`. `projectId` scopes the host's
 * output cache (mirrors `getWaveformChunks`'s explicit `projectId`, since a
 * single adapter instance isn't itself project-scoped); `src` is the
 * source-identity path — a proxy or original file, per the caller's
 * input-selection policy (see the Montaj adapter implementation comment);
 * `samplesPerSecond` is the requested resolution bucket; `start`/`duration`
 * optionally window the request to part of the source (omit for the whole
 * file).
 */
export interface GetWaveformPeaksArgs {
  projectId: string
  src: string
  samplesPerSecond: PeaksResolution
  start?: number
  duration?: number
}

/**
 * One tiled contact sheet in a `FilmstripIndex`. `path` is a host-resolvable
 * image path (route through `fileUrl` to display — same convention as
 * `WaveformChunk.path`). `tiles` maps each cell to its source timestamp `t`
 * (seconds) and its `row`/`col` position in the sheet's `cols` x `rows` grid.
 */
export interface FilmstripSheet {
  path: string
  cols: number
  rows: number
  tiles: Array<{ t: number; row: number; col: number }>
}

/**
 * A video's uniform time-grid thumbnail strip, tiled across one or more
 * `FilmstripSheet`s. `interval` is the seconds between consecutive tiles
 * (uniform across the whole filmstrip); `tileWidth` is the pixel width every
 * tile was scaled to. Maps to Montaj's `filmstrip` step.
 */
export interface FilmstripIndex {
  sheets: FilmstripSheet[]
  interval: number
  tileWidth: number
}

/**
 * Args for `EditorAdapter.getFilmstrip`. `projectId` scopes the host's output
 * cache; `src` is the source-identity path (proxy-only, per the video
 * timeline's filmstrip policy — see the Montaj adapter implementation
 * comment). The grid params mirror the `filmstrip` step's own knobs and are
 * optional — omit to use the step's defaults (`max-tiles=100`,
 * `min-interval=1.0`, `tile-width=160`).
 */
export interface GetFilmstripArgs {
  projectId: string
  src: string
  maxTiles?: number
  minInterval?: number
  tileWidth?: number
}

// ── Audio polish (optional capability) ────────────────────────────────────────

/**
 * Args for `EditorAdapter.analyzeAudioPolish`. `projectId` scopes the host's
 * job/output cache (mirrors `getWaveformPeaks`/`getFilmstrip`); `piece`
 * selects which of Montaj's four audio-polish steps to run (or the
 * `'silence-check'` dry run — see `AudioPolishAnalysis`); `src` is the
 * source-identity path being analyzed. `window`, when given, restricts
 * analysis to a slice of the source — in **source** seconds, not timeline
 * seconds (see `AudioPolishAnalysis` for why that distinction matters).
 * `options` are piece-specific knobs: `language`/`model` steer `fillers`'
 * speech recognition, `targetLufs` steers `loudness`'s gain calculation, and
 * `maxWordGap`/`sentenceEdge` steer `silence`/`silence-check`'s gap-merging
 * heuristics.
 */
export interface AnalyzeAudioPolishArgs {
  projectId: string
  piece: 'silence' | 'fillers' | 'loudness' | 'voice' | 'silence-check'
  src: string
  window?: { in: number; out: number }
  options?: {
    /**
     * Speech-recognition language hint for `fillers` (e.g. `'en'`). Defaults
     * to `'en'` at the call site and should be surfaced as a visible user
     * control — a wrong language silently corrupts detection rather than
     * failing loudly.
     */
    language?: string
    model?: string
    targetLufs?: number
    maxWordGap?: number
    sentenceEdge?: number
  }
}

/**
 * Result of `EditorAdapter.analyzeAudioPolish`, discriminated on `piece`.
 * **Every time in here is source time** — an offset into the source file
 * named by the request's `src`, never timeline time. Mixing the two is the
 * single easiest way to misuse this type; a caller must convert through the
 * clip's own timeline↔source mapping before applying a removal/keep to the
 * project.
 *
 *  - `'silence'` / `'fillers'` — `removals`, each a source-time span to cut,
 *    with optional `text` (the recognized words, for `fillers`).
 *  - `'silence-check'` — `keeps`, the source-time spans that WOULD survive
 *    silence removal at the current settings — the inverse framing of
 *    `'silence'`, for previewing a threshold before committing to it.
 *  - `'loudness'` — the measured integrated/true-peak/LRA loudness, the
 *    requested target, and the gain in dB needed to reach it.
 *  - `'voice'` — the isolated vocal track: `vocalsPath` is the host path,
 *    `url` a directly displayable/fetchable URL for it (same convention as
 *    `getSampleFrame`'s `url`).
 */
export type AudioPolishAnalysis =
  | { piece: 'silence' | 'fillers'; removals: Array<{ start: number; end: number; text?: string }> }
  | { piece: 'silence-check'; keeps: Array<[number, number]> }
  | {
      piece: 'loudness'
      measuredI: number
      measuredTP: number
      measuredLRA: number
      targetI: number
      gainDb: number
    }
  | { piece: 'voice'; vocalsPath: string; url: string }

// ── Media (optional capability) ───────────────────────────────────────────────

/**
 * Scope for a media-library query. Grounded in mission-control's
 * `UseMediaListScope`: media is either project-scoped or drawn from the host's
 * universal/global library.
 */
export type MediaScope =
  | { kind: 'universal' }
  | { kind: 'project'; projectId: string }

/**
 * A minimal media-library item. Hosts may carry more fields, but the editor
 * only relies on these: an id to reference, a resolvable URL to display, a
 * MIME content type, and an optional display name.
 */
export interface MediaItem {
  id: string
  /** A directly displayable URL (presigned, workspace, or otherwise host-resolved). */
  url: string
  contentType: string
  name?: string
}

// ── Footage bin drag-and-drop (optional capability) ───────────────────────────

/**
 * The drag payload for dropping a bin clip onto the timeline. A subset of
 * `VisualItem`'s fields — just enough for the timeline drop target to insert a
 * new clip without round-tripping through the host.
 */
export interface FootageDropPayload {
  src: string
  proxySrc?: string
  sourceDuration: number
  sourceWidth?: number
  sourceHeight?: number
  name?: string
}

/**
 * The custom drag-and-drop MIME type carrying a `FootageDropPayload` JSON
 * string from the footage bin to the timeline drop target.
 */
export const FOOTAGE_DND_MIME = 'application/x-montaj-footage'

// ── Adapter ────────────────────────────────────────────────────────────────

/**
 * What the editor is looking at right now — ephemeral UI state, never part of
 * the project document. Reported to the host so an agent can resolve "this
 * section" against the actual playhead instead of guessing.
 */
export interface EditorContext {
  /** Playhead position in project seconds. */
  playheadSec: number
  /** All selected timeline item ids; [0] is the primary. */
  selectedIds: string[]
  /** Selected caption segment id, if any. */
  selectedCaptionId: string | null
}

/**
 * The contract a host implements to drive the editor. All transport,
 * authentication, and URL-shape concerns live behind this interface; the
 * editor calls only these methods.
 *
 * Generic over the host's concrete project type `P` (constrained to the
 * editor-facing `Project` = EditorProject). Montaj instantiates it with its
 * full `Project`; a host with no extra fields gets the default `Project`. This
 * lets the host's pipeline fields survive load→edit→save round-trips at the
 * type level without casts.
 */
export interface EditorAdapter<P extends Project = Project> {
  /** Fetch the full project by id. */
  loadProject(id: string): Promise<P>

  /** Persist the full project. Mirrors Montaj's `PUT /api/projects/:id`. */
  saveProject(id: string, project: P): Promise<void>

  /**
   * Subscribe to live project frames (e.g. an SSE stream). `onFrame` is invoked
   * with each fresh project snapshot. Returns an unsubscribe function the
   * editor calls on teardown.
   */
  subscribe(id: string, onFrame: (project: P) => void): () => void

  /**
   * Start a render and stream progress as an async iterable of `RenderEvent`s.
   * The iterable completes after a terminal 'done' or 'error' event.
   */
  render(id: string, opts?: RenderOptions): AsyncIterable<RenderEvent>

  /**
   * Optional: kick an async render and return immediately. Hosts that support
   * poll-based renders implement this; streaming-only hosts omit it. Poll
   * `getRenderStatus` for progress and completion. Hosts without poll support
   * omit this and the editor falls back to `render`.
   */
  renderAsync?(id: string, opts?: RenderOptions): Promise<{ status: string }>

  /**
   * Optional: poll the status of an async render kicked off by `renderAsync`.
   * Safe to call at any cadence — returns the latest `RenderStatus` snapshot
   * without side-effects. Hosts without poll support omit this; the editor
   * feature-detects its absence and falls back to `render`.
   */
  getRenderStatus?(id: string): Promise<RenderStatus>

  /**
   * Resolve an `ImageElement` to a directly displayable URL. This is the host's
   * job because the resolution rule differs per host:
   *  - Montaj returns a workspace/files URL (e.g. `/api/files?path=...`).
   *  - Hub clients resolve a `mediaId` → presigned URL.
   * The editor never assumes a URL shape — it always routes through here.
   */
  resolveImageSrc(element: ImageElement): string

  /**
   * Optional: list media available to the editor in the given scope. Hosts
   * without a media library omit this; the editor must feature-detect it.
   */
  listMedia?(scope: MediaScope): Promise<MediaItem[]>

  /**
   * Optional: kick a background ingest of a new source clip (probe →
   * normalize to the project's color space → proxy → register in
   * `project.sources`). `input` is either a host-resolvable path already on
   * the host's filesystem, or a `File` the adapter uploads itself. Resolves
   * with a job id the caller can poll. Optional — hosts that don't support
   * post-init ingest omit it.
   */
  ingestSource?(
    projectId: string,
    input: { path: string } | File,
  ): Promise<{ jobId: string }>

  /**
   * Compile a JSX overlay template file into an `OverlayFactory`.
   * The host supplies this because the compilation pipeline (Babel, fetch
   * strategy, caching) is host-specific. The editor-core preview component
   * receives it as a prop; nothing inside editor-core imports the host's
   * compiler directly.
   */
  compileOverlay(template: string): Promise<OverlayFactory>

  /**
   * List the host's global (workspace-wide) overlay templates. The assembled
   * editor's overlay picker reads these. Maps to Montaj's `GET /api/overlays`.
   */
  listGlobalOverlays(): Promise<GlobalOverlay[]>

  /**
   * List the host's built-in/system overlay templates. Maps to Montaj's
   * `GET /api/overlays/system`.
   */
  listSystemOverlays(): Promise<GlobalOverlay[]>

  /**
   * Upload a file and return a host-resolvable path/ref. When `projectId` is
   * given, the host should store it inside the project (so it stays
   * self-contained); otherwise a shared/upload location is used. Maps to
   * Montaj's `POST /api/projects/:id/upload-asset` (or `POST /api/upload`).
   */
  uploadFile(file: File, projectId?: string): Promise<string>

  /**
   * Map a host path to a directly fetchable URL. Synchronous because hosts
   * derive it by string transform (Montaj: `/api/files?path=...`). Distinct
   * from `resolveImageSrc`, which takes an `ImageElement` and applies element
   * resolution rules; `fileUrl` is the raw path→URL primitive.
   */
  fileUrl(path: string): string

  /**
   * Optional: list overlay templates scoped to a named profile. Hosts without
   * profile-scoped overlays omit this. Maps to Montaj's
   * `GET /api/profiles/:name/overlays`.
   */
  listProfileOverlays?(profileName: string): Promise<GlobalOverlay[]>

  /**
   * Optional: host environment info the editor may surface (e.g. the root
   * skill path for authoring overlays). Maps to Montaj's `GET /api/info`.
   */
  getInfo?(): Promise<{ root_skill_path?: string }>

  /**
   * Optional: generate an image from a prompt and return its host path. Hosts
   * without AI image generation omit this; the editor feature-detects it.
   */
  generateImage?(prompt: string, projectId: string): Promise<{ path: string }>

  /**
   * Optional: watch a host file path for changes, invoking `onChange` whenever
   * the file is rewritten. Returns an unsubscribe function. The editor uses this
   * to auto-recover an overlay preview when its source is edited on disk. Hosts
   * without a file-watch transport omit this; the editor simply doesn't watch
   * (no fallback EventSource). Montaj wires this to its `/api/files/stream` SSE.
   */
  watchFile?(path: string, onChange: () => void): () => void

  /**
   * Optional: resolve the host's default "static text" overlay template — the
   * one the editor's "+ Text" button seeds. Returns null when the host has no
   * such template (the editor then hides "+ Text"). Hosts without any system
   * text overlay omit this entirely. Montaj implements it over
   * `listSystemOverlays()` + its `static-text` matcher.
   */
  getDefaultTextOverlay?(): Promise<GlobalOverlay | null>

  // ── Video editor capabilities (optional) ────────────────────────────────────
  // Hosts driving the video editor implement these; carousel-only hosts omit
  // them and the editor feature-detects their absence.

  /**
   * Optional: list the project's version history, newest-first. Maps to
   * Montaj's `GET /api/projects/:id/versions`, mapped down to `VersionEntry`.
   */
  listVersionHistory?(id: string): Promise<VersionEntry[]>

  /**
   * Optional: restore the project to a prior version by `hash`, returning the
   * restored project. Maps to Montaj's
   * `POST /api/projects/:id/versions/:hash/restore`.
   */
  restoreVersion?(id: string, hash: string): Promise<P>

  /**
   * Optional: save the current project state as a named version. Maps to
   * Montaj's `POST /api/projects/:id/versions` with `{ name? }`. Returns the
   * updated version list.
   */
  saveVersion?(id: string, name?: string): Promise<VersionEntry[]>

  /**
   * Optional: build the URL for a rendered frame from a specific version
   * (git commit hash, or the string `"working"` for the live on-disk state)
   * at time `t` seconds. The URL is used as an `<img src>`; the host serves
   * the PNG. Maps to Montaj's `GET /api/projects/:id/versions/:commit/frame?t=`.
   */
  versionFrameUrl?(id: string, commit: string, t: number): string

  /**
   * RETIRED — the editor no longer calls this. It produced rendered
   * waveform-image chunks (fixed PNG strips) for the DOM timeline's audio
   * rows; those rows are gone and the canvas timeline draws from
   * `getWaveformPeaks` instead, which is now the package's only waveform
   * path. The signature is kept so hosts that still implement it keep
   * compiling, and so a host can go on serving it to its own chrome — but
   * nothing in this package reads the result. Mapped to Montaj's
   * `waveform_image` step; args were the project id, the track id (which
   * namespaced the output cache), the track's source path, and an optional
   * chunk duration in seconds.
   */
  getWaveformChunks?(
    projectId: string,
    trackId: string,
    trackSrc: string,
    chunkDurationS?: number,
  ): Promise<WaveformChunk[]>

  /**
   * Optional: produce zoom-bucketed audio peak data for a scrubbable
   * waveform view. This is the package's ONLY waveform path — the canvas
   * timeline draws every waveform from it (see the retired
   * `getWaveformChunks` above). Input-selection policy is the *caller's*
   * responsibility, not this method's: `item.proxySrc` (proxy only — no
   * fallback to the original) for per-clip waveforms on visual tracks,
   * `track.src` for audio lanes (see the Montaj adapter implementation
   * comment). Maps to Montaj's
   * `waveform_peaks` step. Optional: a host without a peaks step omits it and
   * the editor feature-detects its absence, drawing no waveforms.
   */
  getWaveformPeaks?(args: GetWaveformPeaksArgs): Promise<PeaksData>

  /**
   * Optional: produce a uniform time-grid filmstrip (thumbnail strip) for a
   * video source, tiled into one or more contact sheets with a timestamp
   * index. Maps to Montaj's `filmstrip` step. Optional: a host without a
   * filmstrip step omits it and the editor feature-detects its absence,
   * drawing no tile strips or hover-scrub thumbs.
   */
  getFilmstrip?(args: GetFilmstripArgs): Promise<FilmstripIndex>

  /**
   * Optional: render one fully composited project frame at `at` (project
   * timeline seconds) and return a directly displayable URL for it — a still
   * the editor can put straight into an `<img>`. `opts.sdrCurve` picks the
   * HDR→SDR tone curve so the same frame can be sampled through each curve for
   * a side-by-side comparison (the RenderModal's curve picker).
   *
   * URL rather than a host path because the resolution rule is the host's:
   * Montaj returns its `/api/files?path=` URL for the produced PNG, a Hub
   * client would return a presigned one. Hosts without a frame sampler omit
   * this; the editor feature-detects its absence and shows the picker without
   * thumbnails. Maps to Montaj's `sample_frame` step.
   */
  getSampleFrame?(
    projectId: string,
    at: number,
    opts?: SampleFrameOptions,
  ): Promise<{ url: string }>

  /**
   * Optional: invalidate the host's compiled-overlay cache. When `src` is given,
   * only that entry is dropped; hosts may treat a missing `src` as a no-op or a
   * full clear. Maps to Montaj's `clearOverlayCache` in `lib/overlay-eval`.
   */
  clearOverlayCache?(src?: string): void

  /**
   * Optional: resolve the template identifier that `compileOverlay` should
   * receive for a given caption style name. The mapping is host-specific —
   * Montaj uses `/api/caption-template/<style>`; other hosts may differ.
   * When absent the editor renders no captions (graceful no-op). Hosts without
   * caption support omit this entirely.
   */
  resolveCaptionTemplate?(style: string): string

  /**
   * Optional: regenerate the project's caption track by re-running multilingual
   * transcription on the host's sidecar, streaming progress as an async iterable
   * of `CaptionEvent`s. The iterable completes after a terminal 'done' (carrying
   * the fresh `Captions`) or 'error'. The host persists the captions server-side;
   * the editor patches `project.captions` from the 'done' event. Hosts without a
   * transcription pipeline omit this; the editor feature-detects its absence and
   * hides the "Regenerate captions" control.
   *
   * The 'done' `Captions` REPLACES `project.captions` wholesale, not just its
   * segments in row 0 — a project with more than one caption row (see the
   * `timeline` prop doc above) loses every row but the single fresh one this
   * produces. `CaptionRegenModal` warns before that happens whenever the
   * project has more than one row; there is no partial/per-row regeneration.
   */
  generateCaptions?(id: string, opts?: GenerateCaptionsOptions): AsyncIterable<CaptionEvent>

  /**
   * Optional: report the editor's live playhead and selection to the host.
   *
   * Fire-and-forget and already throttled by the editor (see
   * `useReportContext`) — a host must not add its own debounce. Hosts with
   * nowhere to put ephemeral UI state omit this entirely; the editor feature-
   * detects its absence and reports nothing. A rejected promise is swallowed:
   * context sync is a convenience and must never surface as an editor error.
   */
  reportContext?(id: string, context: EditorContext): Promise<void>

  /**
   * Optional: analyze a clip's audio for one of four cleanup pieces (or a
   * `'silence-check'` dry run) and return proposed edits for the user to
   * review before applying — detect silence/filler words to trim, measure
   * loudness and the gain needed to hit a target, or isolate vocals. Maps to
   * Montaj's four underlying audio-polish steps.
   *
   * Promise-based, not an async iterable, and deliberately so: these are
   * polled jobs with no log stream, unlike `generateCaptions`'s streaming
   * transcription — modeled instead on `getWaveformPeaks`/`getFilmstrip`.
   *
   * Optional so Hub keeps compiling against the released `@bycrux/editor`
   * unchanged; the UI hides the audio-polish entry point on hosts that omit
   * this, the same `generateCaptions` precedent. Hosts without an
   * audio-polish pipeline simply don't implement it.
   *
   * `args.window` and every time in the result are **source** time — offsets
   * into `args.src`, never timeline time (see `AudioPolishAnalysis`). This is
   * the single easiest way to misuse this method; a caller must convert
   * through the clip's own timeline↔source mapping before applying a
   * removal/keep to the project.
   */
  analyzeAudioPolish?(args: AnalyzeAudioPolishArgs): Promise<AudioPolishAnalysis>
}

// ── Theme ────────────────────────────────────────────────────────────────────

/**
 * A flat token record describing the editor's visual language. The host passes
 * one of these (or relies on the Montaj default). `applyTheme` (in theme.ts)
 * writes these tokens as CSS custom properties so styling stays declarative and
 * host-overridable.
 */
export interface EditorTheme {
  colors: {
    /** Outermost canvas/page background. */
    background: string
    /** Raised panels, toolbars, inspectors. */
    surface: string
    /** Primary interactive/brand accent. */
    accent: string
    /**
     * Readable foreground to pair with `accent` — e.g. dark text on a yellow
     * accent button. Optional; when absent, `applyTheme` falls back to `text`.
     */
    accentForeground?: string
    /** Default text color. */
    text: string
    /** Hairline/divider color. */
    border: string
    /** Selection outline / active-element highlight. */
    selection: string
  }
  fonts: {
    sans: string
    serif?: string
    display?: string
  }
  /** Border-radius scale, smallest → largest. */
  radii: {
    sm: string
    md: string
    lg: string
  }
  /**
   * Spacing scale keyed by step. Indices follow a 4px-base rhythm (matching
   * Tailwind's `1`=4px, `2`=8px, …). Values are CSS lengths.
   */
  spacing: Record<number, string>
}

// ── Host-injected UI ──────────────────────────────────────────────────────────

/**
 * Optional UI the host injects into editor slots — e.g. a "Publish to Hub"
 * button in the toolbar, or app-specific export controls.
 */
export interface EditorSlots {
  /** Rendered into the editor toolbar's action area. */
  toolbarActions?: ReactNode
  /** Rendered into the editor's export/render action area. */
  exportActions?: ReactNode
  /** Rendered into the editor's assets/media panel area. */
  assetsPanel?: ReactNode
  /**
   * Rendered in the left media column of the CapCut layout. When present, the
   * editor renders the three-column + full-width-timeline layout; otherwise
   * the classic layout is unchanged.
   */
  mediaPanel?: ReactNode
  /**
   * Rendered in the pending/empty view in place of the default
   * "Message your agent to start" copy. Hosts use this to surface live agent
   * progress (Montaj feeds its SSE log line here); absent → default copy shows.
   */
  pendingStatus?: ReactNode
  /**
   * Rendered in the right sidebar below the version-history panel — in the same
   * position ReviewView showed "Previous runs". The host supplies the concrete
   * Montaj run-snapshot list (reading `project.history: RunSnapshot[]` and
   * offering a "Restore this run" action via `onProjectChange`). The package
   * never reads `project.history` or `RunSnapshot` — those are host-only types.
   * Absent → nothing is rendered in that slot.
   */
  runHistory?: ReactNode
}

// ── Top-level component props ──────────────────────────────────────────────────

/**
 * Props for the carousel editor component. Controlled shape: the host owns the
 * `project` and is notified of edits via `onProjectChange`. The adapter drives
 * transport; theme and slots are optional, and `readOnly` disables mutation.
 */
export interface CarouselEditorProps<P extends Project = Project> {
  project: P
  adapter: EditorAdapter<P>
  onProjectChange?: (p: P) => void
  theme?: EditorTheme
  slots?: EditorSlots
  readOnly?: boolean
  /**
   * Editor-only set of element ids to hide from the interactive canvas. The host
   * owns this state; the package never persists it (hidden elements are omitted
   * from the canvas render only, never from `saveProject`). Lets a host
   * temporarily hide a scrim/background to position overlays beneath it.
   */
  hiddenElementIds?: string[]
  /**
   * Invoked when the user toggles the selected element's editor-visibility via
   * the property-panel eye button. The host updates its hidden-set and reflects
   * it back through `hiddenElementIds`. Absent → no eye toggle is rendered.
   */
  onToggleElementVisibility?: (elementId: string) => void
  /**
   * Invoked whenever the selected element changes — with the element, or `null`
   * when selection clears. Lets a host drive selection-aware chrome (e.g. a
   * "regenerate image" action in a toolbar slot that targets the current
   * selection). The package keeps owning selection state.
   */
  onSelectionChange?: (element: CarouselElement | null) => void
}

/**
 * Props for the video editor component. Mirrors `CarouselEditorProps` —
 * controlled `project` + `onProjectChange`, adapter-driven transport, optional
 * theme/slots/readOnly — and adds `onBackToSetup`, the host-supplied callback
 * the editor invokes when the user leaves the editor for the project's setup
 * view.
 */
export interface VideoEditorProps<P extends Project = Project> {
  project: P
  adapter: EditorAdapter<P>
  onProjectChange?: (p: P) => void
  theme?: EditorTheme
  slots?: EditorSlots
  readOnly?: boolean
  onBackToSetup?: () => void
  /**
   * Where the host's `slots.assetsPanel` is placed in the review layout:
   * - `'sidebar'` — stacked inside the right-hand version/run-history rail, below
   *   it, sharing one column. This is the historical Montaj-local OS layout
   *   (versions on top, assets right below) and what the desktop UI uses.
   * - `'right'` — its own dedicated sidebar column to the LEFT of the version
   *   rail (two separate columns). Preferred only when horizontal space is ample
   *   and the host wants assets visually distinct from versions.
   * - `'bottom'` — a full-width region stacked below the editor. Used by hosts with
   *   constrained width (e.g. the Hub editor) where vertical stacking reads better.
   * The host chooses per deployment; the package defaults to `'right'`.
   */
  assetsPlacement?: 'sidebar' | 'right' | 'bottom'

  /**
   * Which progress UI the RenderModal shows while a render runs:
   * - `'phases'` — the compact phase stepper (Preparing → Rendering → … →
   *   Saving). Works on any transport: poll-based hosts drive it from the
   *   status `phase`; SSE hosts park it on "Rendering". This is the universal
   *   default and what Hub clients use.
   * - `'logs'` — the full scrolling render-log panel (colorized lines + Copy).
   *   REQUIRES the SSE `adapter.render()` transport, which streams per-line
   *   logs; this is the historical montaj-native desktop view. On a poll-based
   *   host (no log lines) this panel would sit empty, so only pass `'logs'`
   *   from a host whose adapter implements the streaming `render()` path.
   * The host chooses per deployment; the package defaults to `'phases'`.
   */
  renderProgressView?: 'phases' | 'logs'

  /**
   * Opt a host OUT of the package's built-in toolbar Render button so it can
   * place Render in its own chrome (e.g. the desktop OS editor's top header).
   * When provided, the package: (a) hides the toolbar Render button, and (b)
   * calls this callback once with a stable `openRender()` trigger that marks the
   * project final, saves, and opens the package's RenderModal. The host stores
   * that trigger and wires it to its own Render button.
   *
   * Default (prop omitted): the package renders Render in its toolbar — so Hub
   * clients, which deliberately keep no render button in their own headers, are
   * unaffected.
   */
  onProvideRenderTrigger?: (openRender: () => void) => void

  /**
   * Opt a host OUT of the package's built-in toolbar image-tone button so it
   * can surface the setting in its own chrome (e.g. the top-of-page header).
   * Mirrors `onProvideRenderTrigger`: when provided, the package (a) hides its
   * toolbar control and (b) calls this callback with the current state
   * whenever it changes. The host renders its own control (the package exports
   * `ImageToneMenu` with `variant="header"` for exactly this) and calls
   * `set(tone)` to persist a choice; the editor owns the save path.
   *
   * Called with `null` when the control should not be shown (SDR project: the
   * tone only affects HDR renders). Hosts must render nothing in that case.
   */
  onProvideImageTone?: (api: { value: ImageTone; set: (tone: ImageTone) => void } | null) => void

  // ── Host-supplied Montaj-specific UI (render-prop seams) ──────────────────
  // The generation panel and the subcut-regeneration tool read host-only
  // fields (regenQueue, storyboard, the host's full Project) the package types
  // don't know. The editor surfaces them as render-props it threads/renders so
  // those components can stay host-side; the editor stays Montaj-agnostic.
  // Both take the clip id rather than a project entity — the editor owns the
  // selection, the host owns what to draw for it.

  /**
   * Render-prop seam for the host's per-clip generation panel (Montaj's AI
   * regenerate surface), rendered inside the right properties panel beneath
   * the clip properties whenever a VIDEO clip is selected. It reads and writes
   * `project.regenQueue` and `project.storyboard` — host-only fields this
   * package deliberately knows nothing about (see EditorProject's index-
   * signature comment) — so the content stays host-side and the editor only
   * says WHERE it goes and WHICH clip it is for. Absent → nothing rendered.
   */
  renderGenerationPanel?: (ctx: { clipId: string }) => ReactNode

  /**
   * Render-prop seam for the host's subcut-regeneration tool (Montaj's
   * SubcutRegenTool). Threaded straight through to the timeline, which owns the
   * open/close trigger (the per-clip Scissors button). Called with the clip id
   * and a close callback. Absent → the subcut tool isn't rendered.
   */
  renderSubcutRegen?: (ctx: { clipId: string; onClose: () => void }) => ReactNode

  /**
   * Host-computed gate for the per-clip subcut-regenerate affordance (Montaj:
   * ai_video projects). Threaded to the timeline. The package never reads
   * `projectType`.
   */
  regenEnabled?: boolean

  /**
   * Host-computed predicate driving the per-clip "queued" badge (Montaj:
   * project.regenQueue membership). Threaded to the timeline. The package never
   * reads `regenQueue`.
   */
  isClipQueued?: (itemId: string) => boolean

  /**
   * SP4 — opt into the WebCodecs playback engine for the video preview.
   * Follows the `assetsPlacement`/`regenEnabled` host-knob precedent: an
   * optional prop, absent by default, that a host passes to change editor
   * behavior. Threaded straight through to `PreviewPlayer`'s own `engine`
   * prop (see `video/preview/PreviewPlayer.tsx`).
   *
   * Default (prop omitted) or `{ enabled: false }`: the legacy `<video>`-slot
   * player, completely unchanged — this is the non-regression guarantee the
   * SP4 plan tests against (the entire editor suite stays green with this
   * prop untouched).
   *
   * `{ enabled: true }` does not itself force engine mode: the editor
   * evaluates per-project eligibility (`engine/eligibility.ts` — WebCodecs
   * avc1/opus decode support, plus every track-0 video item proxied and none
   * requiring the WebM `nobg_preview_src` alpha path) once per project load,
   * and falls back to the legacy player, reasoned via console, whenever a
   * project doesn't pass. `debugHud` additionally renders the
   * fps/drops/buffer/clock-kind readout; it has no effect while `enabled` is
   * false.
   *
   * No flag mechanism existed before this — hosts opt in explicitly, and this
   * prop stays absent-by-default for every consumer of the package. The montaj
   * ui app passes `enabled: true` unconditionally; other hosts are unaffected
   * and must still opt in.
   */
  engine?: { enabled: boolean; debugHud?: boolean }

  /**
   * Opt-in seam letting a host's footage bin drive the MAIN preview on hover.
   * When the host hovers a bin clip card it sets `{ url, fraction }` on this
   * store; the editor mounts a paused `<video>` overlay above the preview and
   * seeks it to `fraction × duration`, so the operator source-scrubs an
   * OFF-TIMELINE clip without disturbing the playhead. Clearing it to `null`
   * unmounts the overlay and the normal timeline preview shows again.
   *
   * Default (prop omitted): totally inert — no overlay is ever mounted and the
   * main preview behaves exactly as before, so the classic layout, Hub and LP
   * are unaffected. A host opts in by creating the store
   * (`createSourcePreviewStore`) and passing it here AND to the card that writes
   * to it. Mirrors the `hover-scrub` store pattern; see
   * `video/source-preview.ts`.
   */
  sourcePreview?: SourcePreviewStore
}
