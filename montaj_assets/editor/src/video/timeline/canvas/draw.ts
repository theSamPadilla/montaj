/**
 * Canvas timeline painter (SP5 T4) — pure draw functions and the scene
 * composition that culls to the visible time range.
 *
 * Every export here is pure: no React, no DOM reads, no measuring. Each draw
 * function takes a 2D-context-shaped object and explicit layout arguments, so
 * tests drive them with a recording stub and assert on the call list. The
 * component (`TimelineCanvas`) owns the surface, the schedule and the state;
 * this module owns nothing but ink.
 *
 * The palette mirrors the DOM rows' Tailwind classes (VisualTrackRow's
 * six-colour track cycle, AudioTrackRow's emerald bars) resolved to literal
 * colours, because a canvas can't read a class. Keep them in sync by hand: the
 * canvas is meant to look like the timeline users already know, not like a new
 * design.
 */

import type { AudioTrack, VisualItem } from '../../../schema'
import type { Project } from '../../../types'
import {
  AUDIO_LANE_HEIGHT_PX,
  BASE_VISUAL_ROW_RENDER_HEIGHT_PX,
  visualItemLabel,
  ROW_GAP_PX,
  VISUAL_ROW_RENDER_HEIGHT_PX,
  groupAudioLanes,
  normalizeTracks,
  trackItems,
} from '../timeline-model'
import { timeToX, visibleRange, type Viewport } from './viewport'
import { drawAudioLaneWaveform, drawClipWaveform, type WaveformSceneLookup } from './waveforms'
import { drawFilmstripTiles, type FilmstripSceneLookup } from './filmstrips'

// ── The context surface the painter needs ────────────────────────────────
// A structural subset of CanvasRenderingContext2D: a real context satisfies it,
// and a recording stub can too. Keeping it narrow is what makes the draw calls
// assertable.

export interface DrawContext {
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  rect(x: number, y: number, w: number, h: number): void
  clip(): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient
  /** T7 — filmstrip tiles and the hover-scrub thumb are the only content
   *  drawn as images rather than shapes/text. */
  drawImage(
    image: CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  font: string
  textBaseline: CanvasTextBaseline
  globalAlpha: number
  /** Set only around clip labels, which sit over filmstrip frames; `restore()`
   *  clears it so no shape painter inherits a shadow. */
  shadowColor: string
  shadowBlur: number
}

// ── Palette ──────────────────────────────────────────────────────────────

export interface TrackPalette {
  fill: string
  fillSelected: string
  ring: string
  border: string
  text: string
}

/** VisualTrackRow's `trackColors`, resolved. Same order, same cycle length —
 *  a clip keeps its colour when the flag flips. */
export const TRACK_PALETTE: TrackPalette[] = [
  { fill: 'rgba(71,85,105,0.8)',   fillSelected: 'rgba(100,116,139,0.9)', ring: 'rgba(203,213,225,0.8)', border: 'rgba(148,163,184,0.5)', text: '#e2e8f0' }, // slate
  { fill: 'rgba(3,105,161,0.8)',   fillSelected: 'rgba(2,132,199,0.9)',   ring: 'rgba(125,211,252,0.8)', border: 'rgba(56,189,248,0.5)',  text: '#bae6fd' }, // sky
  { fill: 'rgba(109,40,217,0.8)',  fillSelected: 'rgba(124,58,237,0.9)',  ring: 'rgba(196,181,253,0.8)', border: 'rgba(167,139,250,0.5)', text: '#ddd6fe' }, // violet
  { fill: 'rgba(4,120,87,0.8)',    fillSelected: 'rgba(5,150,105,0.9)',   ring: 'rgba(110,231,183,0.8)', border: 'rgba(52,211,153,0.5)',  text: '#a7f3d0' }, // emerald
  { fill: 'rgba(190,18,60,0.8)',   fillSelected: 'rgba(225,29,72,0.9)',   ring: 'rgba(253,164,175,0.8)', border: 'rgba(251,113,133,0.5)', text: '#fecdd3' }, // rose
  { fill: 'rgba(180,83,9,0.6)',    fillSelected: 'rgba(217,119,6,0.8)',   ring: 'rgba(251,191,36,0.8)',  border: 'rgba(245,158,11,0.5)',  text: '#fde68a' }, // amber
]

export const TIMELINE_COLORS = {
  /** `bg-gray-900` — the dark-mode row background both row kinds use. */
  rowBackground: '#111827',
  /** `bg-emerald-500/40` + `border-emerald-500/60` on AudioTrackRow's bars. */
  audioFill: 'rgba(16,185,129,0.4)',
  audioBorder: 'rgba(16,185,129,0.6)',
  /** `bg-white/10` — a muted audio bar. */
  audioMutedFill: 'rgba(255,255,255,0.1)',
  audioRing: 'rgba(110,231,183,0.8)',
  audioText: '#a7f3d0',
  /** Fade in/out gradients: `linear-gradient(to right, rgba(0,0,0,0.6), transparent)`. */
  fadeShadow: 'rgba(0,0,0,0.6)',
  fadeTransparent: 'rgba(0,0,0,0)',
  /** The overlap band AudioTrackRow marks with a crossfade glyph. */
  crossfadeFill: 'rgba(251,191,36,0.15)',
  crossfadeBorder: 'rgba(251,191,36,0.3)',
  /** `bg-red-500` — the playhead, i.e. where playback/preview actually is. */
  playhead: '#ef4444',
  /** The selected clip's outline. White rather than the track's own hue: it is
   *  the one colour that stays obvious over an arbitrary video frame. */
  clipSelectedOutline: '#ffffff',
  /** `bg-yellow-400` — the preview-axis cursor: the line that tracks the
   *  pointer while the axis is on. Yellow so it can never be mistaken for the
   *  red playback line it moves independently of; it inherits the colour of
   *  the DOM hover indicator it replaces (Timeline.tsx's `bg-yellow-400/80`). */
  cursor: '#facc15',
} as const

export const ROW_RADIUS_PX = 4           // Tailwind `rounded`
/** Horizontal inset per side between a clip's time span and its drawn body —
 *  two touching clips therefore show twice this as a dark gutter. */
export const CLIP_GUTTER_PX = 2
/** Corner radius on a clip body. */
export const CLIP_RADIUS_PX = 4
/** Weight of the selected-clip outline. Thick on purpose: it has to read over
 *  filmstrip frames of any brightness. */
export const CLIP_SELECTED_BORDER_PX = 3
export const AUDIO_ITEM_RADIUS_PX = 4    // Tailwind `rounded` on the bar
export const AUDIO_ITEM_INSET_PX = 4     // `top-1 bottom-1` on the bar
export const PLAYHEAD_WIDTH_PX = 2       // `w-[2px]`
export const CURSOR_WIDTH_PX = 2         // matches the playhead's weight
export const LABEL_FONT = '10px ui-sans-serif, system-ui, sans-serif'
export const LABEL_PAD_PX = 6
/** Below this width a label is more smear than information, so it is skipped. */
export const MIN_LABEL_WIDTH_PX = 28
/** Middle-baseline offset from a clip's top edge — half the font's 10px plus a
 *  4px margin, so the label rides just inside the clip's top border. */
export const LABEL_TOP_OFFSET_PX = 9
/** Drop shadow behind a clip label, so it stays readable over a filmstrip
 *  frame of any brightness without needing a solid plate behind it. */
export const LABEL_SHADOW_COLOR = 'rgba(0,0,0,0.85)'
export const LABEL_SHADOW_BLUR_PX = 3

// ── Row layout ───────────────────────────────────────────────────────────

export interface VisualRowLayout {
  trackIdx: number
  items: VisualItem[]
  y: number
  height: number
  /** The track's `enabled === false` — the row still lays out and still takes
   *  its full height (you have to be able to see and re-enable it); the painter
   *  just dims it. */
  disabled?: boolean
}

export interface AudioLaneLayout {
  laneIndex: number
  tracks: AudioTrack[]
  y: number
  height: number
}

export interface TimelineLayout {
  /** Visual rows in DRAW order (top of the surface first). */
  rows: VisualRowLayout[]
  lanes: AudioLaneLayout[]
  /** Total surface height in CSS px, excluding trailing gap. */
  height: number
}

/**
 * Row rectangles for a project, in the order the DOM path stacks them:
 * visual tracks reversed (highest index on top, so the base video track sits at
 * the bottom and overlays stack above it), then audio lanes below, ascending.
 * The base track is drawn taller, matching `trackRowTall`.
 *
 * T5's hit-testing should derive its rows from here rather than re-deriving
 * geometry — one layout, two readers.
 */
export function computeTimelineLayout(project: Project): TimelineLayout {
  const allTracks = trackItems(project)
  // Settings live on the track object; `trackItems` deliberately returns only
  // items, so read `enabled` off the normalized tracks alongside it. A
  // legacy-shaped project has no settings, so every row is enabled.
  const trackSettings = normalizeTracks(project).tracks ?? []
  const rows: VisualRowLayout[] = []
  let y = 0

  for (let reversedIdx = 0; reversedIdx < allTracks.length; reversedIdx++) {
    const trackIdx = allTracks.length - 1 - reversedIdx
    const height = trackIdx === 0 ? BASE_VISUAL_ROW_RENDER_HEIGHT_PX : VISUAL_ROW_RENDER_HEIGHT_PX
    rows.push({
      trackIdx,
      items: allTracks[trackIdx],
      y,
      height,
      disabled: trackSettings[trackIdx]?.enabled === false,
    })
    y += height + ROW_GAP_PX
  }

  const lanes: AudioLaneLayout[] = groupAudioLanes(project.audio?.tracks ?? []).map(lane => {
    const laneLayout: AudioLaneLayout = {
      laneIndex: lane.laneIndex,
      tracks: lane.tracks,
      y,
      height: AUDIO_LANE_HEIGHT_PX,
    }
    y += AUDIO_LANE_HEIGHT_PX + ROW_GAP_PX
    return laneLayout
  })

  return { rows, lanes, height: Math.max(0, y - ROW_GAP_PX) }
}

// ── Primitives ───────────────────────────────────────────────────────────

/** Rounded-rect path. Hand-rolled rather than `ctx.roundRect` so the painter
 *  works on contexts (and stubs) that predate it. */
export function roundRectPath(ctx: DrawContext, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Clamp a rect to the surface so a clip stretching far off-screen doesn't ask
 *  the rasterizer to fill a million-pixel-wide box. */
export function clampRectToSurface(rect: Rect, surfaceWidth: number): Rect {
  const left = Math.max(rect.x, -1)
  const right = Math.min(rect.x + rect.width, surfaceWidth + 1)
  return { ...rect, x: left, width: Math.max(0, right - left) }
}

// ── Element painters ─────────────────────────────────────────────────────

export function drawRowBackground(ctx: DrawContext, rect: Rect, color: string = TIMELINE_COLORS.rowBackground): void {
  ctx.fillStyle = color
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, ROW_RADIUS_PX)
  ctx.fill()
}

export interface ClipDrawArgs {
  rect: Rect
  palette: TrackPalette
  selected: boolean
  label: string
  /** A skipped track's clips are faded — the DOM path's `opacity-30`. */
  dimmed?: boolean
  /** Content layer drawn between the fill/border and the label — the T6
   *  per-clip waveform hooks in here (filmstrip, T7, will too). Receives the
   *  same rect as the clip itself. */
  drawContent?: (ctx: DrawContext, rect: Rect) => void
}

/**
 * One clip/overlay block. Mirrors the DOM item: flat coloured box, a right
 * border separating touching clips, an inset ring when selected, and a small
 * label. Content layers (waveform T6, filmstrip T7) draw between the fill and
 * the label — pass through here once they exist.
 */
/**
 * The drawn body of a clip: inset from its true time span, so two clips that
 * touch on the timeline are separated by a real gutter of row background
 * rather than a 1px line. That line was legible while a clip was a flat
 * colour; against a continuous ribbon of filmstrip frames it vanished, and
 * twelve clips read as one.
 *
 * Hit-testing still uses the full span — the gutter is paint, not a dead zone.
 * Exported because the content lookups (`clipColumns`, `clipTiles`) must size
 * themselves to the SAME rect the painter will draw them into, or a filmstrip
 * lays out its cells against a width two pixels wider than the clip it lands
 * in.
 */
export function clipBodyRect(rect: Rect): Rect {
  const gutter = Math.min(CLIP_GUTTER_PX, Math.max(0, (rect.width - 1) / 2))
  return {
    x: rect.x + gutter,
    y: rect.y,
    width: Math.max(0, rect.width - gutter * 2),
    height: rect.height,
  }
}

export function drawClipRect(ctx: DrawContext, args: ClipDrawArgs): void {
  const { rect, palette, selected, label, dimmed, drawContent } = args
  if (rect.width <= 0) return

  const body = clipBodyRect(rect)
  if (body.width <= 0) return

  const radius = Math.min(CLIP_RADIUS_PX, body.width / 2, body.height / 2)

  ctx.save()
  if (dimmed) ctx.globalAlpha = 0.3

  // Fill and content clipped to the rounded body, so filmstrip tiles and
  // waveform bars stop at the corners instead of squaring them off.
  ctx.save()
  roundRectPath(ctx, body.x, body.y, body.width, body.height, radius)
  ctx.clip()
  ctx.fillStyle = selected ? palette.fillSelected : palette.fill
  ctx.fillRect(body.x, body.y, body.width, body.height)
  drawContent?.(ctx, body)
  ctx.restore()

  // The outline is the selection. A 1px inset ring in the track's own hue was
  // invisible once frames filled the clip; selection now reads as a thick
  // white border round the whole block, the one treatment that survives any
  // frame underneath it.
  if (selected) {
    const inset = CLIP_SELECTED_BORDER_PX / 2
    ctx.strokeStyle = TIMELINE_COLORS.clipSelectedOutline
    ctx.lineWidth = CLIP_SELECTED_BORDER_PX
    roundRectPath(ctx, body.x + inset, body.y + inset, Math.max(0, body.width - CLIP_SELECTED_BORDER_PX), Math.max(0, body.height - CLIP_SELECTED_BORDER_PX), radius)
    ctx.stroke()
  } else {
    ctx.strokeStyle = palette.border
    ctx.lineWidth = 1
    roundRectPath(ctx, body.x + 0.5, body.y + 0.5, Math.max(0, body.width - 1), Math.max(0, body.height - 1), radius)
    ctx.stroke()
  }

  // An empty label draws nothing at all — video clips carry none now that the
  // track rail names the row.
  if (label !== '' && body.width >= MIN_LABEL_WIDTH_PX) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(body.x, body.y, body.width, body.height)
    ctx.clip()
    ctx.fillStyle = palette.text
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'middle'
    // Pinned to the TOP, not the vertical centre it used to sit at: a video
    // clip is now split into a frames band and a waveform band, and the centre
    // is the seam between them — the worst line on the clip for legibility.
    // The shadow is what lets it read over an arbitrary frame underneath;
    // `restore()` below drops it before anything else paints.
    ctx.shadowColor = LABEL_SHADOW_COLOR
    ctx.shadowBlur = LABEL_SHADOW_BLUR_PX
    ctx.fillText(label, body.x + LABEL_PAD_PX, body.y + LABEL_TOP_OFFSET_PX)
    ctx.restore()
  }

  ctx.restore()
}

export interface AudioItemDrawArgs {
  rect: Rect
  selected: boolean
  muted: boolean
  label: string
  /** Fade widths in px, already converted from seconds. */
  fadeInPx?: number
  fadeOutPx?: number
  /** Content layer drawn inside the bar's clip region, beneath the fades and
   *  label — the T6 audio-lane waveform hooks in here (mirrors the DOM
   *  path's `AudioWaveformLayer`, which also paints behind the type label). */
  drawContent?: (ctx: DrawContext, rect: Rect) => void
}

export function drawAudioItem(ctx: DrawContext, args: AudioItemDrawArgs): void {
  const { rect, selected, muted, label, fadeInPx = 0, fadeOutPx = 0, drawContent } = args
  if (rect.width <= 0) return
  ctx.save()

  ctx.fillStyle = muted ? TIMELINE_COLORS.audioMutedFill : TIMELINE_COLORS.audioFill
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, AUDIO_ITEM_RADIUS_PX)
  ctx.fill()
  if (!muted) {
    ctx.strokeStyle = TIMELINE_COLORS.audioBorder
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // Clip the content/fades/label to the bar so none of them can bleed past
  // its edges.
  ctx.save()
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()

  drawContent?.(ctx, rect)

  if (fadeInPx > 0) {
    const w = Math.min(fadeInPx, rect.width)
    const g = ctx.createLinearGradient(rect.x, rect.y, rect.x + w, rect.y)
    g.addColorStop(0, TIMELINE_COLORS.fadeShadow)
    g.addColorStop(1, TIMELINE_COLORS.fadeTransparent)
    ctx.fillStyle = g
    ctx.fillRect(rect.x, rect.y, w, rect.height)
  }
  if (fadeOutPx > 0) {
    const w = Math.min(fadeOutPx, rect.width)
    const g = ctx.createLinearGradient(rect.x + rect.width, rect.y, rect.x + rect.width - w, rect.y)
    g.addColorStop(0, TIMELINE_COLORS.fadeShadow)
    g.addColorStop(1, TIMELINE_COLORS.fadeTransparent)
    ctx.fillStyle = g
    ctx.fillRect(rect.x + rect.width - w, rect.y, w, rect.height)
  }

  if (rect.width >= MIN_LABEL_WIDTH_PX) {
    ctx.fillStyle = TIMELINE_COLORS.audioText
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'middle'
    ctx.fillText(label, rect.x + LABEL_PAD_PX, rect.y + rect.height / 2)
  }
  ctx.restore()

  if (selected) {
    ctx.strokeStyle = TIMELINE_COLORS.audioRing
    ctx.lineWidth = 1
    roundRectPath(ctx, rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1), AUDIO_ITEM_RADIUS_PX)
    ctx.stroke()
  }

  ctx.restore()
}

/** The amber band AudioTrackRow shows where two audio bars overlap. */
export function drawCrossfadeBand(ctx: DrawContext, rect: Rect): void {
  if (rect.width <= 0) return
  ctx.fillStyle = TIMELINE_COLORS.crossfadeFill
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  ctx.fillStyle = TIMELINE_COLORS.crossfadeBorder
  ctx.fillRect(rect.x, rect.y, 1, rect.height)
  ctx.fillRect(rect.x + rect.width - 1, rect.y, 1, rect.height)
}

export function drawPlayhead(ctx: DrawContext, x: number, top: number, bottom: number): void {
  ctx.fillStyle = TIMELINE_COLORS.playhead
  ctx.fillRect(x - PLAYHEAD_WIDTH_PX / 2, top, PLAYHEAD_WIDTH_PX, bottom - top)
}

/** The preview-axis cursor. Drawn BEFORE the playhead by `drawTimelineOverlay`
 *  so that where the two coincide the red playback line stays the one you see —
 *  the playhead is the position that survives the pointer leaving. */
export function drawCursorLine(ctx: DrawContext, x: number, top: number, bottom: number): void {
  ctx.fillStyle = TIMELINE_COLORS.cursor
  ctx.fillRect(x - CURSOR_WIDTH_PX / 2, top, CURSOR_WIDTH_PX, bottom - top)
}

// ── Scene composition ────────────────────────────────────────────────────

export interface TimelineScene {
  project: Project
  viewport: Viewport
  layout: TimelineLayout
  /** Unified selection (visual items + audio tracks), as Timeline holds it. */
  selectedIds: string[]
  surfaceWidth: number
  surfaceHeight: number
  /** T6 waveform content-layer provider. Absent → no waveforms drawn (DOM
   *  mode never sets this; canvas mode without a `getWaveformPeaks` adapter
   *  method omits it too). */
  waveforms?: WaveformSceneLookup
  /** T7 filmstrip content-layer provider (the background tile strip inside a
   *  clip rect). Absent → no filmstrips drawn, same graceful omission as
   *  `waveforms`. */
  filmstrips?: FilmstripSceneLookup
}

export interface DrawStats {
  visualItemsDrawn: number
  audioItemsDrawn: number
  itemsCulled: number
}

/** Does [start, end] intersect the viewport's visible time range? */
function intersectsRange(start: number, end: number, range: { start: number; end: number }): boolean {
  return end >= range.start && start <= range.end
}

/**
 * Paint the content layer: rows, clips, audio bars and crossfade bands. The
 * playhead is NOT drawn here — it lives on its own layer so a 60fps playhead
 * never repaints the content (see `drawTimelineOverlay`).
 *
 * Culling is the whole point: items outside the visible time range are skipped
 * before any draw call, so the number of draw calls is bounded by what fits on
 * screen, not by how big the project is. Returned stats make that assertable.
 */
export function drawTimelineContent(ctx: DrawContext, scene: TimelineScene): DrawStats {
  const { viewport, layout, selectedIds, surfaceWidth, surfaceHeight } = scene
  const range = visibleRange(viewport)
  const stats: DrawStats = { visualItemsDrawn: 0, audioItemsDrawn: 0, itemsCulled: 0 }

  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)


  for (const row of layout.rows) {
    drawRowBackground(ctx, { x: 0, y: row.y, width: surfaceWidth, height: row.height })

    // A SKIPPED track is drawn faded: it still draws, and stays selectable and
    // editable; only playback and export leave it out.
    const dimmed = row.disabled === true
    const palette = TRACK_PALETTE[row.trackIdx % TRACK_PALETTE.length]

    for (const item of row.items) {
      if (!intersectsRange(item.start, item.end, range)) { stats.itemsCulled++; continue }
      const x = timeToX(item.start, viewport)
      const rect = clampRectToSurface(
        { x, y: row.y, width: (item.end - item.start) * viewport.pxPerSecond, height: row.height },
        surfaceWidth,
      )
      if (rect.width <= 0) { stats.itemsCulled++; continue }
      // Both lookups size to the BODY, the rect `drawClipRect` actually paints
      // into — not the full span, which is two gutters wider.
      const body = clipBodyRect(rect)
      const clipWaveform = scene.waveforms?.clipColumns(item, body) ?? null
      const filmstripTiles = scene.filmstrips?.clipTiles(item, body) ?? null
      // Composed in one hook, but painting into DISJOINT halves of the clip
      // (`clip-bands.ts`): tiles in the upper frames band, waveform in the
      // lower one. Order no longer matters for overlap — it is kept
      // frames-then-waveform so that if a band ever gains a translucent edge
      // the picture sits under the audio, not over it. Either half may be
      // absent (no proxy, no adapter, nothing fetched yet) and the other still
      // draws.
      const drawContent = (filmstripTiles || clipWaveform)
        ? (c: DrawContext, r: Rect) => {
            if (filmstripTiles) drawFilmstripTiles(c, filmstripTiles)
            if (clipWaveform) drawClipWaveform(c, r, clipWaveform)
          }
        : undefined
      drawClipRect(ctx, {
        rect,
        palette,
        selected: selectedIds.includes(item.id),
        label: visualItemLabel(item),
        dimmed,
        drawContent,
      })
      stats.visualItemsDrawn++
    }
  }

  for (const lane of layout.lanes) {
    drawRowBackground(ctx, { x: 0, y: lane.y, width: surfaceWidth, height: lane.height })

    for (const track of lane.tracks) {
      if (!intersectsRange(track.start, track.end, range)) { stats.itemsCulled++; continue }
      const x = timeToX(track.start, viewport)
      const rect = clampRectToSurface(
        {
          x,
          y: lane.y + AUDIO_ITEM_INSET_PX,
          width: (track.end - track.start) * viewport.pxPerSecond,
          height: lane.height - AUDIO_ITEM_INSET_PX * 2,
        },
        surfaceWidth,
      )
      if (rect.width <= 0) { stats.itemsCulled++; continue }
      const audioWaveform = scene.waveforms?.audioColumns(track, rect) ?? null
      drawAudioItem(ctx, {
        rect,
        selected: selectedIds.includes(track.id),
        muted: !!track.muted,
        label: audioLabel(track),
        fadeInPx: (track.fadeIn ?? 0) * viewport.pxPerSecond,
        fadeOutPx: (track.fadeOut ?? 0) * viewport.pxPerSecond,
        drawContent: audioWaveform ? (c) => drawAudioLaneWaveform(c, audioWaveform.rect, audioWaveform.columns) : undefined,
      })
      stats.audioItemsDrawn++
    }

    // Overlap bands between consecutive unmuted bars in the lane.
    const sorted = lane.tracks.filter(t => !t.muted).sort((a, b) => a.start - b.start)
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]
      const b = sorted[i + 1]
      if (a.end <= b.start) continue
      const start = b.start
      const end = Math.min(a.end, b.end)
      if (!intersectsRange(start, end, range)) continue
      drawCrossfadeBand(ctx, clampRectToSurface(
        { x: timeToX(start, viewport), y: lane.y, width: (end - start) * viewport.pxPerSecond, height: lane.height },
        surfaceWidth,
      ))
    }
  }

  return stats
}

export interface OverlayScene {
  viewport: Viewport
  currentTime: number
  surfaceWidth: number
  surfaceHeight: number
  /** Where the preview-axis cursor sits, or null/absent when the axis is off
   *  or the pointer is elsewhere. Independent of `currentTime`: while the axis
   *  is on the preview follows THIS while the playhead stays put, which is the
   *  entire point of the toggle. */
  cursorTime?: number | null
}

/** Paint the playhead layer. Kept separate from the content so playback — which
 *  moves the playhead ~60 times a second — repaints two `fillRect`s, not the
 *  whole timeline. The preview-axis cursor rides here for the same reason:
 *  tracking the pointer must not force a content repaint. */
export function drawTimelineOverlay(ctx: DrawContext, scene: OverlayScene): void {
  const { viewport, currentTime, surfaceWidth, surfaceHeight, cursorTime } = scene
  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)
  if (cursorTime !== undefined && cursorTime !== null) {
    const cx = timeToX(cursorTime, viewport)
    if (!(cx < -CURSOR_WIDTH_PX || cx > surfaceWidth + CURSOR_WIDTH_PX)) {
      drawCursorLine(ctx, cx, 0, surfaceHeight)
    }
  }
  const x = timeToX(currentTime, viewport)
  if (!(x < -PLAYHEAD_WIDTH_PX || x > surfaceWidth + PLAYHEAD_WIDTH_PX)) {
    drawPlayhead(ctx, x, 0, surfaceHeight)
  }
}

/** AudioTrackRow's label rule: the type name, else the track label, else the
 *  source filename. */
export function audioLabel(track: AudioTrack): string {
  if (track.type === 'voiceover') return 'Voiceover'
  if (track.type === 'music') return 'Music'
  return track.label ?? track.src.split('/').pop() ?? 'audio'
}
