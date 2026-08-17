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
  ROW_GAP_PX,
  VISUAL_ROW_RENDER_HEIGHT_PX,
  groupAudioLanes,
} from '../timeline-model'
import { timeToX, visibleRange, type Viewport } from './viewport'
import { drawAudioLaneWaveform, drawClipWaveform, type WaveformSceneLookup } from './waveforms'
import { drawFilmstripHoverThumb, drawFilmstripTiles, type FilmstripHoverThumb, type FilmstripSceneLookup } from './filmstrips'

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
  /** `bg-red-500/20` — the two-marker range tint drawn across the rows. */
  markerSelectionTint: 'rgba(239,68,68,0.2)',
  /** `bg-amber-400` — marker A/B lines. */
  marker: '#fbbf24',
  /** `bg-red-500` — the playhead. */
  playhead: '#ef4444',
} as const

export const ROW_RADIUS_PX = 4           // Tailwind `rounded`
export const AUDIO_ITEM_RADIUS_PX = 4    // Tailwind `rounded` on the bar
export const AUDIO_ITEM_INSET_PX = 4     // `top-1 bottom-1` on the bar
export const PLAYHEAD_WIDTH_PX = 2       // `w-[2px]`
export const LABEL_FONT = '10px ui-sans-serif, system-ui, sans-serif'
export const LABEL_PAD_PX = 6
/** Below this width a label is more smear than information, so it is skipped. */
export const MIN_LABEL_WIDTH_PX = 28

// ── Row layout ───────────────────────────────────────────────────────────

export interface VisualRowLayout {
  trackIdx: number
  items: VisualItem[]
  y: number
  height: number
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
  const allTracks = project.tracks ?? []
  const rows: VisualRowLayout[] = []
  let y = 0

  for (let reversedIdx = 0; reversedIdx < allTracks.length; reversedIdx++) {
    const trackIdx = allTracks.length - 1 - reversedIdx
    const height = trackIdx === 0 ? BASE_VISUAL_ROW_RENDER_HEIGHT_PX : VISUAL_ROW_RENDER_HEIGHT_PX
    rows.push({ trackIdx, items: allTracks[trackIdx], y, height })
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
  /** Rows unrelated to the primary selection dim while markers are placed —
   *  the DOM path's `opacity-30`. */
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
export function drawClipRect(ctx: DrawContext, args: ClipDrawArgs): void {
  const { rect, palette, selected, label, dimmed, drawContent } = args
  if (rect.width <= 0) return
  ctx.save()
  if (dimmed) ctx.globalAlpha = 0.3

  ctx.fillStyle = selected ? palette.fillSelected : palette.fill
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

  // `border-r` between adjacent clips.
  ctx.fillStyle = palette.border
  ctx.fillRect(rect.x + rect.width - 1, rect.y, 1, rect.height)

  drawContent?.(ctx, rect)

  if (selected) {
    // `ring-1 ring-inset` — a 1px ring drawn inside the box.
    ctx.strokeStyle = palette.ring
    ctx.lineWidth = 1
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1))
  }

  if (rect.width >= MIN_LABEL_WIDTH_PX) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.fillStyle = palette.text
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'middle'
    ctx.fillText(label, rect.x + LABEL_PAD_PX, rect.y + rect.height / 2)
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

/** The red wash over the marker range. */
export function drawSelectionTint(ctx: DrawContext, rect: Rect): void {
  if (rect.width <= 0) return
  ctx.fillStyle = TIMELINE_COLORS.markerSelectionTint
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
}

export function drawMarkerLine(ctx: DrawContext, x: number, top: number, bottom: number): void {
  ctx.fillStyle = TIMELINE_COLORS.marker
  ctx.fillRect(x, top, 1, bottom - top)
}

export function drawPlayhead(ctx: DrawContext, x: number, top: number, bottom: number): void {
  ctx.fillStyle = TIMELINE_COLORS.playhead
  ctx.fillRect(x - PLAYHEAD_WIDTH_PX / 2, top, PLAYHEAD_WIDTH_PX, bottom - top)
}

// ── Scene composition ────────────────────────────────────────────────────

export interface TimelineScene {
  project: Project
  viewport: Viewport
  layout: TimelineLayout
  /** Unified selection (visual items + audio tracks), as Timeline holds it. */
  selectedIds: string[]
  /** The two-marker range, when both markers are placed. */
  markerSelection: { start: number; end: number } | null
  markers: [number | null, number | null]
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
 * Paint the content layer: rows, clips, audio bars, crossfade bands, the
 * marker range tint and marker lines. The playhead is NOT drawn here — it
 * lives on its own layer so a 60fps playhead never repaints the content (see
 * `drawTimelineOverlay`).
 *
 * Culling is the whole point: items outside the visible time range are skipped
 * before any draw call, so the number of draw calls is bounded by what fits on
 * screen, not by how big the project is. Returned stats make that assertable.
 */
export function drawTimelineContent(ctx: DrawContext, scene: TimelineScene): DrawStats {
  const { viewport, layout, selectedIds, markerSelection, markers, surfaceWidth, surfaceHeight } = scene
  const range = visibleRange(viewport)
  const stats: DrawStats = { visualItemsDrawn: 0, audioItemsDrawn: 0, itemsCulled: 0 }

  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)

  const primarySelectedId = selectedIds[0] ?? null
  const markerActive = markers[0] !== null || markerSelection !== null

  for (const row of layout.rows) {
    drawRowBackground(ctx, { x: 0, y: row.y, width: surfaceWidth, height: row.height })

    // `dimmed`: with markers placed and a primary selection elsewhere, the DOM
    // fades every row that doesn't hold it.
    const dimmed = markerActive && primarySelectedId !== null && !row.items.some(i => i.id === primarySelectedId)
    const palette = TRACK_PALETTE[row.trackIdx % TRACK_PALETTE.length]

    for (const item of row.items) {
      if (!intersectsRange(item.start, item.end, range)) { stats.itemsCulled++; continue }
      const x = timeToX(item.start, viewport)
      const rect = clampRectToSurface(
        { x, y: row.y, width: (item.end - item.start) * viewport.pxPerSecond, height: row.height },
        surfaceWidth,
      )
      if (rect.width <= 0) { stats.itemsCulled++; continue }
      const clipWaveform = scene.waveforms?.clipColumns(item, rect) ?? null
      const filmstripTiles = scene.filmstrips?.clipTiles(item, rect) ?? null
      // Composed in one hook: filmstrip tiles paint first as the background
      // fill, the waveform's bottom band paints after as the overlay — the
      // ordering the plan calls for. When `filmstripTiles` is null (no T7
      // provider, or nothing ready yet) this reduces to exactly T6's
      // original single-waveform hook.
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
        label: `▪ ${item.type}`,
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

  // The range tint covers the visual rows only — the DOM draws it inside
  // VisualTrackRow, and audio lanes have never been tinted.
  const lastRow = layout.rows[layout.rows.length - 1]
  const visualRowsBottom = lastRow ? lastRow.y + lastRow.height : 0

  if (markerSelection && visualRowsBottom > 0 && intersectsRange(markerSelection.start, markerSelection.end, range)) {
    drawSelectionTint(ctx, clampRectToSurface(
      {
        x: timeToX(markerSelection.start, viewport),
        y: 0,
        width: (markerSelection.end - markerSelection.start) * viewport.pxPerSecond,
        height: visualRowsBottom,
      },
      surfaceWidth,
    ))
  }

  // Marker lines span the whole surface: they mark a time, not a row, the same
  // way the DOM's hover indicator spans the scrubber and every row below it.
  for (const marker of markers) {
    if (marker === null) continue
    const x = timeToX(marker, viewport)
    if (x < 0 || x > surfaceWidth) continue
    drawMarkerLine(ctx, x, 0, surfaceHeight)
  }

  return stats
}

export interface OverlayScene {
  viewport: Viewport
  currentTime: number
  surfaceWidth: number
  surfaceHeight: number
  /** T7 — the hover-scrub preview thumb, present only when the pointer rests
   *  over a clip (no gesture running) with a matched tile ready. Absent or
   *  `null` → nothing extra drawn. */
  hoverThumb?: FilmstripHoverThumb | null
}

/** Paint the playhead layer. Kept separate from the content so playback — which
 *  moves the playhead ~60 times a second — repaints two `fillRect`s, not the
 *  whole timeline. The T7 hover thumb lives here too (not the content layer)
 *  for the same reason: hovering must not force a content repaint. */
export function drawTimelineOverlay(ctx: DrawContext, scene: OverlayScene): void {
  const { viewport, currentTime, surfaceWidth, surfaceHeight, hoverThumb } = scene
  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)
  const x = timeToX(currentTime, viewport)
  if (!(x < -PLAYHEAD_WIDTH_PX || x > surfaceWidth + PLAYHEAD_WIDTH_PX)) {
    drawPlayhead(ctx, x, 0, surfaceHeight)
  }
  if (hoverThumb) drawFilmstripHoverThumb(ctx, hoverThumb, surfaceWidth)
}

/** AudioTrackRow's label rule: the type name, else the track label, else the
 *  source filename. */
export function audioLabel(track: AudioTrack): string {
  if (track.type === 'voiceover') return 'Voiceover'
  if (track.type === 'music') return 'Music'
  return track.label ?? track.src.split('/').pop() ?? 'audio'
}
