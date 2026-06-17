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
  fit?: 'cover' | 'contain' | 'fill'  // image type only — how the source fills its box. Default 'cover' (AR-preserving fill+crop). 'contain' letterboxes; 'fill' is legacy stretch (no AR).
  volume?: number         // video audio level 0.0–2.0, default 1.0 (ignored for images)
  rotation?: number       // degrees, clockwise
  opaque?: boolean        // legacy boolean kept for old overlay items
  props?: Record<string, unknown>  // overlay type only
  googleFonts?: string[]  // overlay type only — Google Fonts family specs (e.g. ["Syne:wght@800"])
  remove_bg?: boolean     // video type only
  nobg_src?: string         // video type only — ProRes 4444 .mov for final render
  nobg_preview_src?: string // video type only — VP9 WebM with alpha for browser preview
  muted?: boolean         // video type only — suppress audio in preview and render
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
  settings: { resolution: [number, number]; fps?: number; brandKit?: string }
  name?: string | null
  editingPrompt?: string
  slides?: Slide[]
  tracks?: VisualItem[][]
  captions?: Captions
  audio?: { tracks: AudioTrack[] }
  assets?: Asset[]
  carousel?: { aspect: string }
  profile?: string
  // Host-only / pipeline fields pass through at the type level.
  [key: string]: unknown
}
