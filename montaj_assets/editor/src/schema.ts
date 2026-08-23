// Editor-facing schema for the @bycrux/editor package.
//
// These types describe the slice of a Montaj project the carousel editor reads
// and writes. They are intentionally self-contained: the package owns no
// pipeline/agent types and depends on nothing from Montaj. The host app
// (Montaj, Hub, …) extends EditorProject with its own pipeline fields.

export interface Word {
  word: string
  start: number
  end: number
}

export interface AudioTrack {
  id: string
  type?: 'voiceover' | 'music' | 'sfx' | 'audio'
  src: string
  start: number          // position on project timeline (seconds)
  end: number
  volume?: number        // 0.0–2.0, default 1.0
  inPoint?: number       // offset into source file (seconds)
  outPoint?: number      // end offset in source file (seconds)
  label?: string         // display name, defaults to filename
  muted?: boolean
  ducking?: {
    enabled: boolean
    depth?: number       // dB, default -12
    attack?: number      // seconds, default 0.3
    release?: number     // seconds, default 0.5
  }
  fadeIn?: number          // fade-in duration in seconds (0 = no fade)
  fadeOut?: number         // fade-out duration in seconds (0 = no fade)
  sourceDuration?: number  // intrinsic duration of the source file in seconds
  lane?: number            // visual grouping — tracks sharing a lane render in the same row
}

export interface CaptionSegment {
  id?: string
  text: string
  start: number
  end: number
  words?: Word[]
  offsetX?: number   // percent of frame width,  0/absent = default anchor
  offsetY?: number   // percent of frame height, 0/absent = default anchor
  // Visual scale of the whole caption block about its own centre — a CSS
  // transform, not a font-size change, so it scales the background box and
  // text stroke too and does NOT re-wrap the text. Default 1.
  scale?: number
  // Per-segment override of the track-level `Captions.color` (base text color
  // only — not the per-style accent fields below). CSS color (hex or named).
  // Absent → inherits the track-level color → the template's own default.
  // Honored only by the JSX browser preview / Puppeteer render path; the
  // ffmpeg `drawtext` render branch has no per-segment concept and keeps
  // reading only the track-level `color`.
  color?: string
}

export interface Captions {
  style: 'word-by-word' | 'pop' | 'karaoke' | 'subtitle' | 'highlight-box' | 'outline' | 'clean'
  segments: CaptionSegment[]
  // `color` and `fontsize` are read by BOTH paths: the JSX browser preview /
  // Puppeteer render (spread into the caption template props; `fontsize`→`fontSize`)
  // and the ffmpeg-drawtext render branch. `position` and `bgColor` are consumed
  // only by the ffmpeg-drawtext branch and ignored by the JSX preview.
  position?: 'center' | 'top-left' | 'bottom-left'
  color?: string          // base caption text color
  fontsize?: number
  bgColor?: string
  // Per-style accent color fields, each read by the matching JSX caption template.
  // A single UI control writes whichever one the active style uses (see TranscriptPanel).
  accentColor?: string    // active-word/box accent — highlight-box, outline
  highlightColor?: string // active word — karaoke
  activeColor?: string    // active word — pop
  backgroundColor?: string// text box background — subtitle
  googleFonts?: string[]  // Google Fonts family specs for the caption template (e.g. ["Figtree:wght@700"])
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
  fit?: 'cover' | 'contain' | 'fill'  // image type only — how the source fills its box. Default 'cover' (AR-preserving fill+crop). 'contain' letterboxes; 'fill' is legacy stretch (no AR).
  volume?: number         // video audio level 0.0–2.0, default 1.0 (ignored for images)
  rotation?: number       // degrees, clockwise
  opaque?: boolean        // legacy boolean kept for old overlay items
  props?: Record<string, unknown>  // overlay type only
  googleFonts?: string[]  // overlay type only — Google Fonts family specs (e.g. ["Syne:wght@800"])
  remove_bg?: boolean     // video type only
  nobg_src?: string         // video type only — ProRes 4444 .mov for final render
  nobg_preview_src?: string // video type only — VP9 WebM with alpha for browser preview
  normalizedSrc?: string    // derived per-window normalized cache; render/preview prefer it; src stays original
  /** Source-time (original coords) the normalizedSrc cache starts at; the cache covers [normalizedInPoint, normalizedInPoint + duration]. Absent ⇒ assume it starts at the clip's inPoint (legacy rebase-to-0). */
  normalizedInPoint?: number
  /** Full-source, all-intra 720p H.264+Opus editing proxy for instant-scrub preview (SP3). Never windowed —
   * no `proxyInPoint` — so one proxy can serve every clip sharing a lazy source. Preview-only: render never
   * reads this field. Preview's src precedence, alpha-safe, is
   * `nobg_preview_src ?? proxySrc ?? normalizedSrc ?? src`. Filename carries a look-version tag
   * (`<stem>_proxy_<PROXY_LOOK>.mp4`); bumping `PROXY_LOOK` (e.g. when Montaj Vivid ships) invalidates every
   * existing proxy by construction — the freshness check sees a different filename and regenerates lazily. */
  proxySrc?: string         // video type only
  muted?: boolean         // video type only — suppress audio in preview and render
  speed?: number          // video type only — playback speed, default 1.0, range 0.25–4
  sourceCrop?: { x: number; y: number; w: number; h: number }  // video type only — non-destructive crop of the source clip (0–1 fractions)
  sourceWidth?: number    // video type only — intrinsic width of the source clip in pixels
  sourceHeight?: number   // video type only — intrinsic height of the source clip in pixels
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

/**
 * One visual track: its items plus the properties that belong to the TRACK
 * rather than to any one clip. Track ORDER is meaningful — index 0 is the
 * primary footage track, higher indices render on top.
 *
 * `volume`, `muted` and `enabled` are optional and ABSENT by default; a track
 * carrying none of them behaves exactly as it did before tracks became
 * objects, so nothing needs to write a default in.
 *
 * A project may still be on disk in the legacy `VisualItem[][]` shape (a bare
 * array of item arrays, with nowhere to put the fields above). Readers tolerate
 * both shapes by going through `trackItems()` (video/timeline/timeline-model)
 * rather than touching `project.tracks` directly; `normalizeTracks()` converts
 * legacy → this shape when a project is opened.
 */
export interface VisualTrack {
  id: string
  items: VisualItem[]
  /** Gain applied to every item's audio on this track. Absent = unity (1.0). */
  volume?: number
  /** Absent or false = audible. */
  muted?: boolean
  /** Absent or true = the track renders. */
  enabled?: boolean
}

export interface Asset {
  id: string
  src: string
  type: 'image'
  name?: string
}

// ── Carousel types ─────────────────────────────────────────────────────────
export interface ImageElement {
  id: string
  type: 'image'
  src: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  /**
   * Optional non-destructive crop expressed as a sub-rectangle of the source
   * image in 0–1 fractions. The editor (mission-control) is the sole enforcer
   * of the aspect-lock invariant (crop pixel aspect == element pixel aspect);
   * the server validates only bounds. The renderer's object-fit: cover acts as
   * a graceful-degradation safety net when the invariant is violated by a
   * manual project.json edit. Absent = no crop = current behavior.
   */
  crop?: { x: number; y: number; w: number; h: number }
  /**
   * Optional passthrough field used by host apps (e.g. Hub) to link this
   * image element to an external media record. Montaj preserves the value
   * through load→save round-trips but never interprets it; the host app's
   * adapter (e.g. resolveImageSrc) is responsible for resolving the actual URL.
   */
  mediaId?: string
}

export interface OverlayElement {
  id: string
  type: 'overlay'
  overlay: { template: string; props: Record<string, unknown> }
  frame: number
  x: number
  y: number
  w: number
  h: number
  rotation: number
  /**
   * Optional Google Fonts family specs (e.g. ["Syne:wght@800"]) the overlay
   * renders with. Mirrors the video-side `VisualItem.googleFonts`. The carousel
   * overlay render path injects these so the preview uses the same glyphs and
   * metrics as the renderer; absent = no custom fonts loaded.
   */
  googleFonts?: string[]
}

export type CarouselElement = ImageElement | OverlayElement

export interface Slide {
  id: string
  base_color: string
  elements: CarouselElement[]
}

/**
 * The editor-facing view of a Montaj project. Captures only the fields the
 * carousel editor reads or writes. Field types mirror the host Project
 * interface exactly so that a full host Project is assignable to EditorProject.
 *
 * The index signature lets host-only / pipeline fields (workflow, storyboard,
 * regenQueue, version, …) pass through at the type level without the package
 * needing to know about them.
 */
export interface EditorProject {
  id: string
  status: 'pending' | 'storyboard_ready' | 'draft' | 'final'
  settings: {
    resolution: [number, number]
    fps?: number
    brandKit?: string
    normalize?: 'eager' | 'lazy'
    /** Project working color space (e.g. 'sdr_bt709', 'hdr_hlg'). Written by
     *  the render pipeline's smart-detect; read here to gate HDR-only UI. */
    colorSpace?: string
    /** Color mapping for overlay images in HDR renders — see video/imageTone.ts.
     *  Absent → the render default ('vivid'). No effect on SDR projects. */
    imageTone?: 'vivid' | 'broadcast' | 'punchy' | 'raw'
  }
  name?: string | null
  editingPrompt?: string
  slides?: Slide[]
  tracks?: VisualTrack[]
  captions?: Captions
  audio?: { tracks: AudioTrack[] }
  assets?: Asset[]
  carousel?: { aspect: string }
  profile?: string
  derivedFrom?: string  // ID of the source project this was derived from (e.g. clips workflow)
  // Host-only / pipeline fields pass through at the type level.
  [key: string]: unknown
}
