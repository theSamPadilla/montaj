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
} from './schema'

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
  | { type: 'done'; outputPath: string }
  | { type: 'error'; message: string }

/**
 * Options for a render request. Kept intentionally minimal — Montaj's render
 * endpoint (`POST /api/projects/:id/render`) takes no body today, so `scale`
 * is the only forward-looking knob and is optional. Hosts ignore fields they
 * don't support.
 */
export interface RenderOptions {
  /** Output scale multiplier (1 = native resolution). */
  scale?: number
}

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

// ── Adapter ────────────────────────────────────────────────────────────────

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
   * Compile a JSX overlay template file into an `OverlayFactory`.
   * The host supplies this because the compilation pipeline (Babel, fetch
   * strategy, caching) is host-specific. The editor-core preview component
   * receives it as a prop; nothing inside editor-core imports the host's
   * compiler directly.
   */
  compileOverlay(template: string): Promise<OverlayFactory>
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
}

// ── Top-level component props ──────────────────────────────────────────────────

/**
 * Props for the carousel editor component. The host supplies the project id and
 * an adapter; theme and slots are optional, and `readOnly` disables mutation.
 */
export interface CarouselEditorProps<P extends Project = Project> {
  projectId: string
  adapter: EditorAdapter<P>
  theme?: EditorTheme
  slots?: EditorSlots
  readOnly?: boolean
}
