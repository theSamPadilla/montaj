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

import type { AudioTrack, CaptionSegment, VisualItem } from '../../../schema'
import type { Project } from '../../../types'
import { groupCaptionLanes } from '../../captionLanes'
import {
  AUDIO_LANE_HEIGHT_PX,
  BASE_VISUAL_ROW_RENDER_HEIGHT_PX,
  CAPTION_ROW_HEIGHT_PX,
  visualItemLabel,
  ROW_GAP_PX,
  VISUAL_ROW_RENDER_HEIGHT_PX,
  computeDerivedTiming,
  groupAudioLanes,
  normalizeTracks,
  trackItems,
} from '../timeline-model'
import type { SnapStrength } from './snap'
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

/** The retired CaptionTrackRow's Tailwind purple classes, resolved. Unlike `TRACK_PALETTE`,
 *  which cycles a hue per track, every caption block shares this ONE palette —
 *  captions are a single row, not several, so there is nothing to cycle.
 *  `fill`/`border` are the unselected state (`bg-purple-700/40` +
 *  `border-purple-500/40`); `fillSelected`/`ring` the selected one
 *  (`bg-purple-600/70` + `ring-purple-300/80`); `text` is `text-purple-100`. */
export const CAPTION_PALETTE: TrackPalette = {
  fill: 'rgba(126,34,206,0.4)',
  fillSelected: 'rgba(147,51,234,0.7)',
  ring: 'rgba(216,180,254,0.8)',
  border: 'rgba(168,85,247,0.4)',
  text: '#f3e8ff',
}

/** TrackGutter's rail-cell accent for the caption row. Same purple hue as
 *  `CAPTION_PALETTE.border`, at a higher alpha (0.6 vs 0.4) — a rail chip
 *  reads best brighter than a canvas fill. Exported beside `CAPTION_PALETTE`,
 *  the single source for the caption purple, instead of letting TrackGutter
 *  hardcode its own copy with nothing tying the two together. */
export const CAPTION_RAIL_ACCENT = 'rgba(168,85,247,0.6)'

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
  /** Where two items on the same row overlap in time.
   *
   *  These were 0.15 amber fill / 0.3 amber border. Two things were wrong with
   *  that. It was invisible over filmstrip frames — legible back when a clip
   *  was a flat colour block, gone the moment clips filled with picture. And
   *  amber was the wrong thing to say: yellow on a timeline reads as a
   *  warning, and an overlap is a fact about the edit, not a fault in it. It
   *  was also all but the same hue as the preview-axis cursor.
   *
   *  Deliberately colourless now. White stripes over a dark under-stroke are
   *  the barber-pole "this region is special" pattern, and carry no status.
   *  The hatching is what does the work — a wash of any strength competes with
   *  the picture underneath, and diagonals do not. */
  // 0.12, not the 0.1 that would read most naturally here: `audioMutedFill` is
  // already exactly `rgba(255,255,255,0.1)`, and two different meanings sharing
  // one literal is a trap for anything reasoning about the paint — a muted bar
  // and an overlap band would have been indistinguishable by colour alone.
  overlapFill: 'rgba(255,255,255,0.12)',
  overlapHatch: 'rgba(255,255,255,0.75)',
  /** Laid under each hatch line, a little wider, so the white has something to
   *  read against. White on a bright sky is nearly invisible and white on a
   *  dark frame is fine; a dark outline makes one treatment work on both, the
   *  same trick the clip labels use to survive an arbitrary frame. */
  overlapHatchShadow: 'rgba(0,0,0,0.45)',
  /** Translucent and thin, unlike the solid amber rules this replaces. White
   *  is already the selection vocabulary (the outline and the trim handles),
   *  and a hard white rule down each side of a band made an overlap read as a
   *  selected clip. Thin enough to bound the span, faint enough not to be
   *  mistaken for a border. */
  overlapEdge: 'rgba(255,255,255,0.55)',
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
  /** The trim-handle pill on a selected clip's in/out edge. Same white as the
   *  selection outline, deliberately: the handles read as thickenings of that
   *  border rather than as separate furniture. */
  handleFill: 'rgba(255,255,255,0.92)',
  /** The handle under the pointer. Opaque, so "this is the one you'd grab"
   *  survives a bright filmstrip frame behind it. */
  handleFillHovered: '#ffffff',
  /** The grip ticks inside the pill — dark on white, the universal
   *  drag-me-sideways glyph. */
  handleGrip: 'rgba(15,23,42,0.55)',
  handleGripHovered: 'rgba(15,23,42,0.9)',
  /** The snap guide: the line marking the boundary a gesture is magnetized to.
   *  Cyan because every other line on this surface is spoken for — red is the
   *  playhead, yellow the preview axis, emerald the audio bars — and a guide
   *  that could be confused with the playhead would be worse than none. */
  snapGuide: '#22d3ee',
  /** A guide for a boundary on some OTHER track. Same hue so it is obviously
   *  the same idea, but faint and capless: a cross-track alignment is a hint,
   *  not the thing you were aiming at, and at full strength these were
   *  indistinguishable from the alignment that actually matters. */
  snapGuideWeak: 'rgba(34,211,238,0.4)',
  /** The time ruler across the top. A shade off `rowBackground` so the strip
   *  reads as chrome rather than as one more track you could drop a clip on. */
  rulerBackground: '#0b1220',
  /** Tick marks and their labels. Deliberately low-contrast: the ruler is a
   *  reference you consult, not something that should compete with the clips. */
  rulerTick: 'rgba(148,163,184,0.55)',
  rulerTickMinor: 'rgba(148,163,184,0.25)',
  rulerText: 'rgba(148,163,184,0.9)',
  /** The marquee (rubber-band) selection box. Same white as the selection
   *  vocabulary, since what it is doing IS selecting. */
  marqueeFill: 'rgba(255,255,255,0.08)',
  marqueeBorder: 'rgba(255,255,255,0.65)',
} as const

/** Height of the time ruler strip at the top of the surface.
 *
 *  The ruler exists because canvas mode removed the overview scrubber bar (see
 *  Scrubber.tsx), which left pressing the track area as the only way to seek —
 *  and that gesture is now the marquee. Giving scrubbing its own strip is what
 *  every NLE does, and it is what makes drag-to-select in the track area
 *  possible without losing drag-to-scrub. */
export const RULER_HEIGHT_PX = 18
/** Tick height for a labelled (major) tick and an unlabelled (minor) one. */
export const RULER_MAJOR_TICK_PX = 7
export const RULER_MINOR_TICK_PX = 4
/** Baseline for a ruler label, measured from the top of the strip. */
export const RULER_LABEL_BASELINE_PX = 9
/** Minimum px between labelled ticks. Below this the labels collide, so the
 *  step is promoted to the next entry in `RULER_STEPS_SECONDS`. */
export const RULER_MIN_LABEL_SPACING_PX = 64
/** The step ladder, in seconds. A ruler that picked a raw "nice" number could
 *  land on 2.5s or 7s; these are the intervals an editor actually thinks in,
 *  so the labels stay readable as times rather than as arithmetic. */
export const RULER_STEPS_SECONDS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800, 3600,
] as const

export const ROW_RADIUS_PX = 4           // Tailwind `rounded`
/** Horizontal inset per side between a clip's time span and its drawn body —
 *  two touching clips therefore show twice this as a dark gutter. */
export const CLIP_GUTTER_PX = 2
/** Corner radius on a clip body. */
export const CLIP_RADIUS_PX = 4
/** Weight of the selected-clip outline. Thick on purpose: it has to read over
 *  filmstrip frames of any brightness. */
export const CLIP_SELECTED_BORDER_PX = 3
/** Drawn width of a visual clip's trim handle. Equal to
 *  `VISUAL_EDGE_TOLERANCE_PX` in hit-test.ts ON PURPOSE — the pill you see is
 *  exactly the strip that trims, so aiming at it is never a guess. Change one
 *  and change the other. */
export const CLIP_HANDLE_WIDTH_PX = 10
/** Same contract against `AUDIO_EDGE_TOLERANCE_PX`. */
export const AUDIO_HANDLE_WIDTH_PX = 6
/** Grip ticks per handle, their width, and the gap between them. */
export const HANDLE_GRIP_COUNT = 2
export const HANDLE_GRIP_WIDTH_PX = 1.5
export const HANDLE_GRIP_GAP_PX = 2.5
/** Fraction of the handle's height the ticks span, and the cap that keeps them
 *  from becoming a full-height stripe on the tall base video row. */
export const HANDLE_GRIP_HEIGHT_RATIO = 0.4
export const HANDLE_GRIP_MAX_HEIGHT_PX = 16
/** Below this the pill is thinner than its own grip and draws as a smear, so a
 *  very narrow clip gets no handles — the white selection outline is still
 *  there to say it's selected. */
export const MIN_HANDLE_WIDTH_PX = 3
export const SNAP_GUIDE_WIDTH_PX = 2
/** The weak guide is a hairline. Half the width and no caps — visible if you
 *  look for it, invisible if you aren't. */
export const SNAP_GUIDE_WEAK_WIDTH_PX = 1
/** The arrowheads at the guide's ends. They are what make it read as "this
 *  boundary", not as another playhead. */
export const SNAP_GUIDE_CAP_HALF_WIDTH_PX = 5
export const SNAP_GUIDE_CAP_HEIGHT_PX = 7
/** Gap between the diagonal hatch lines in an overlap band, their weight, and
 *  the weight of the solid rule down each side of it. */
export const OVERLAP_HATCH_SPACING_PX = 9
export const OVERLAP_HATCH_WIDTH_PX = 1.5
/** How much wider the shadow pass is than the amber it sits under. */
export const OVERLAP_HATCH_SHADOW_WIDTH_PX = 3
export const OVERLAP_EDGE_WIDTH_PX = 1.5
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
  /** The track's `muted === true`. Item-level mute is folded in per item at
   *  draw time (mirrors `effectiveItemAudio`'s OR) since this flag alone can't
   *  see an individual item's own `muted`. */
  trackMuted: boolean
}

export interface AudioLaneLayout {
  laneIndex: number
  tracks: AudioTrack[]
  y: number
  height: number
}

export interface CaptionRowLayout {
  /** Which caption lane this band renders (see `CaptionSegment.lane` /
   *  `captionLanes.ts`). Lane 0 is the band adjacent to the base video row;
   *  higher lanes stack upward toward the overlays. */
  lane: number
  y: number
  height: number
  segments: CaptionSegment[]
}

export interface TimelineLayout {
  /** The time ruler strip across the top. Always present and always at y=0;
   *  carried in the layout rather than assumed so hit-testing and painting
   *  read the same rectangle, the same contract the rows have. */
  ruler: { y: number; height: number }
  /** Visual rows in DRAW order (top of the surface first). */
  rows: VisualRowLayout[]
  lanes: AudioLaneLayout[]
  /** The caption bands, one per lane (see `captionLanes.ts`'s
   *  `groupCaptionLanes`), carried the same way `ruler` is — a first-class set
   *  of rectangles the painter and hit-test both read, rather than each
   *  re-deriving them. In DRAW order (descending lane), so index 0 is the
   *  HIGHEST lane and the last entry is lane 0, immediately above the base
   *  video row (see `computeTimelineLayout`). Absent — not an empty array —
   *  when the project has no caption segments, so a caption-less project's
   *  layout is unchanged from before captions existed. */
  captions?: CaptionRowLayout[]
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
  // The ruler owns the top strip; everything else starts below it.
  const ruler = { y: 0, height: RULER_HEIGHT_PX }
  let y = RULER_HEIGHT_PX + ROW_GAP_PX

  // Only stored when there is something to show — an empty `segments` (or no
  // `project.captions` at all) means no bands at all, not an empty array, so a
  // caption-less project's layout is byte-for-byte what it was before
  // captions joined the canvas.
  const captionSegments = project.captions?.segments ?? []
  // One group per lane, `0..maxCaptionLane`, INCLUDING holes as empty groups
  // (see `groupCaptionLanes`) — a hole still needs a band, because an empty
  // band that keeps painting its row background is what stops the timeline
  // jumping by a whole row height mid-drag when a caption that was alone in
  // its lane moves out of it.
  const captionGroups = captionSegments.length > 0 ? groupCaptionLanes(captionSegments) : []
  const captions: CaptionRowLayout[] = []
  const emitCaptionBands = () => {
    // Descending lane order: the highest lane is emitted FIRST, so it lands
    // closest to the overlay rows already pushed above (smaller y); lane 0 is
    // emitted LAST, landing at the current `y` — exactly where the single
    // band sat before multi-lane captions existed. Higher lanes therefore
    // stack upward toward the overlays, per the caption-lane convention
    // documented in `captionLanes.ts`.
    for (let i = captionGroups.length - 1; i >= 0; i--) {
      const group = captionGroups[i]
      captions.push({ lane: group.lane, y, height: CAPTION_ROW_HEIGHT_PX, segments: group.segments })
      y += CAPTION_ROW_HEIGHT_PX + ROW_GAP_PX
    }
  }

  for (let reversedIdx = 0; reversedIdx < allTracks.length; reversedIdx++) {
    const trackIdx = allTracks.length - 1 - reversedIdx
    // The caption bands sit directly above the base video track — captions
    // narrate that footage, so they read as adjacent to it. `trackIdx === 0`
    // is always the LAST iteration of this loop (reversed order), so this is
    // "immediately before the base row is pushed".
    if (trackIdx === 0 && captionGroups.length > 0) emitCaptionBands()
    const height = trackIdx === 0 ? BASE_VISUAL_ROW_RENDER_HEIGHT_PX : VISUAL_ROW_RENDER_HEIGHT_PX
    rows.push({
      trackIdx,
      items: allTracks[trackIdx],
      y,
      height,
      disabled: trackSettings[trackIdx]?.enabled === false,
      trackMuted: trackSettings[trackIdx]?.muted === true,
    })
    y += height + ROW_GAP_PX
  }
  // A project with captions but NO visual tracks at all never runs the loop
  // above, so the hook that emits the bands right before `trackIdx === 0`
  // never fires. Emit them here instead — still above where the (absent) base
  // row would sit, which is the same rule applied to zero rows.
  if (allTracks.length === 0 && captionGroups.length > 0) emitCaptionBands()

  // Resolved once per layout, not per track: an audio track may legally omit
  // `start`/`end`, and `groupAudioLanes` needs a horizon to fall back to.
  const { contentDuration } = computeDerivedTiming(project)
  const lanes: AudioLaneLayout[] = groupAudioLanes(project.audio?.tracks ?? [], contentDuration).map(lane => {
    const laneLayout: AudioLaneLayout = {
      laneIndex: lane.laneIndex,
      tracks: lane.tracks,
      y,
      height: AUDIO_LANE_HEIGHT_PX,
    }
    y += AUDIO_LANE_HEIGHT_PX + ROW_GAP_PX
    return laneLayout
  })

  const layout: TimelineLayout = { ruler, rows, lanes, height: Math.max(0, y - ROW_GAP_PX) }
  if (captions.length > 0) layout.captions = captions
  return layout
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

export interface TrimHandleDrawArgs {
  /** The BODY rect of the clip or bar — the rectangle actually painted, not
   *  the full time span. A handle drawn against the span would hang two pixels
   *  out over the gutter and touch its neighbour. */
  rect: Rect
  edge: 'in' | 'out'
  /** Nominal width; narrowed automatically so two handles can never overlap on
   *  a short clip. */
  width: number
  hovered?: boolean
  radius?: number
}

/**
 * A trim handle: the grabbable pill on one end of a selected clip.
 *
 * This exists because canvas mode inherited the DOM path's *invisible* resize
 * strips — a 10px zone with nothing drawn in it. That was survivable when a
 * clip was a flat colour block with a visible 1px border; once clips filled
 * with filmstrip frames there was no way to see where trimming started, and
 * the only feedback was the cursor changing after you were already there.
 *
 * The drawn width is `VISUAL_EDGE_TOLERANCE_PX` (or the audio one), so the
 * pill is a picture of the hit zone rather than a decoration near it.
 *
 * Handles are drawn for SELECTED items only. Trimming an unselected clip still
 * works — hit-testing never consulted the selection and still doesn't — but
 * showing a pair of pills on every clip on the timeline would bury the one
 * thing selection is for.
 */
export function drawTrimHandle(ctx: DrawContext, args: TrimHandleDrawArgs): void {
  const { rect, edge, hovered = false } = args
  if (rect.width <= 0 || rect.height <= 0) return

  // Two handles must never meet in the middle: on a clip narrower than twice
  // the nominal width they each take half and stop.
  const width = Math.min(args.width, rect.width / 2)
  if (width < MIN_HANDLE_WIDTH_PX) return

  const x = edge === 'in' ? rect.x : rect.x + rect.width - width
  const radius = Math.min(args.radius ?? CLIP_RADIUS_PX, width / 2, rect.height / 2)

  ctx.save()
  ctx.fillStyle = hovered ? TIMELINE_COLORS.handleFillHovered : TIMELINE_COLORS.handleFill
  roundRectPath(ctx, x, rect.y, width, rect.height, radius)
  ctx.fill()

  // Grip ticks, centred in the pill. Skipped when the pill has narrowed to the
  // point where they'd fill it edge to edge and read as one solid block.
  const gripSpan = HANDLE_GRIP_COUNT * HANDLE_GRIP_WIDTH_PX + (HANDLE_GRIP_COUNT - 1) * HANDLE_GRIP_GAP_PX
  if (gripSpan <= width - 2) {
    const gripHeight = Math.min(rect.height * HANDLE_GRIP_HEIGHT_RATIO, HANDLE_GRIP_MAX_HEIGHT_PX)
    const gripY = rect.y + (rect.height - gripHeight) / 2
    let gripX = x + (width - gripSpan) / 2
    ctx.fillStyle = hovered ? TIMELINE_COLORS.handleGripHovered : TIMELINE_COLORS.handleGrip
    for (let i = 0; i < HANDLE_GRIP_COUNT; i++) {
      ctx.fillRect(gripX, gripY, HANDLE_GRIP_WIDTH_PX, gripHeight)
      gripX += HANDLE_GRIP_WIDTH_PX + HANDLE_GRIP_GAP_PX
    }
  }
  ctx.restore()
}

/**
 * Both trim handles for one selected item.
 *
 * Split out of the item painters so the row painter can run it as a LAST pass,
 * after every clip in the row is down. Handles are an affordance, not content:
 * where two clips overlap, the one on top owns the picture, but the selected
 * clip still owns its own edges and has to be able to show them. Painting them
 * in stacking order meant a clip whose end was overlapped had a handle you
 * could neither see nor — before the hit-test learned about this — grab.
 */
export function drawItemHandles(
  ctx: DrawContext,
  rect: Rect,
  width: number,
  hoveredEdge?: 'in' | 'out' | null,
  radius?: number,
): void {
  for (const edge of ['in', 'out'] as const) {
    drawTrimHandle(ctx, { rect, edge, width, hovered: hoveredEdge === edge, radius })
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

  // The handles themselves are NOT drawn here — the row painter puts them on
  // in a pass of its own once every clip is down (see `drawTimelineContent`),
  // because a clip that overlaps this one would otherwise bury them. Their
  // width still matters here: the label has to indent past where they will
  // land, or a pill drops onto the first glyph of a short overlay name.
  const handleWidth = selected ? Math.min(CLIP_HANDLE_WIDTH_PX, body.width / 2) : 0

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
    ctx.fillText(label, body.x + LABEL_PAD_PX + handleWidth, body.y + LABEL_TOP_OFFSET_PX)
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
  const handleWidth = selected ? Math.min(AUDIO_HANDLE_WIDTH_PX, rect.width / 2) : 0
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
    ctx.fillText(label, rect.x + LABEL_PAD_PX + handleWidth, rect.y + rect.height / 2)
  }
  ctx.restore()

  if (selected) {
    ctx.strokeStyle = TIMELINE_COLORS.audioRing
    ctx.lineWidth = 1
    roundRectPath(ctx, rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1), AUDIO_ITEM_RADIUS_PX)
    ctx.stroke()
    // Handles come later, in the lane painter's own pass — crossfaded bars
    // overlap by design, so burying them here would be the normal case rather
    // than the exception.
  }

  ctx.restore()
}

export interface CaptionBlockDrawArgs {
  /** Already inset (see `AUDIO_ITEM_INSET_PX`) — same contract as
   *  `drawAudioItem`'s `rect`, not the full row span. */
  rect: Rect
  selected: boolean
  label: string
}

/**
 * One caption segment block. Structurally the closer sibling is
 * `drawAudioItem`, not `drawClipRect`: like an audio bar, a caption has no
 * content bands to split label position around, so its label rides centred;
 * like an audio bar, it takes its OWN hue on selection rather than the
 * global white clip-selection outline (`drawClipRect`'s override would be a
 * lie here — a caption is never confused with a video clip because nothing
 * else on this row looks like one).
 *
 * Unlike an audio bar, the FILL itself changes on selection too — mirrors
 * the retired DOM row's `bg-purple-700/40` → `bg-purple-600/70` swap — and
 * the border/ring pair is mutually exclusive (border unselected, ring
 * selected) rather than audio's "border always, ring layered on top",
 * because that is what the DOM classes did:
 * `border border-purple-500/40` XOR `ring-1 ring-inset ring-purple-300/80`.
 */
export function drawCaptionBlock(ctx: DrawContext, args: CaptionBlockDrawArgs): void {
  const { rect, selected, label } = args
  if (rect.width <= 0) return

  const palette = CAPTION_PALETTE
  const radius = Math.min(AUDIO_ITEM_RADIUS_PX, rect.width / 2, rect.height / 2)
  const handleWidth = selected ? Math.min(AUDIO_HANDLE_WIDTH_PX, rect.width / 2) : 0

  ctx.save()
  ctx.fillStyle = selected ? palette.fillSelected : palette.fill
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, radius)
  ctx.fill()

  ctx.strokeStyle = selected ? palette.ring : palette.border
  ctx.lineWidth = 1
  roundRectPath(ctx, rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1), radius)
  ctx.stroke()

  // Centred, clipped to the block — matching the DOM row's `flex items-center
  // overflow-hidden` rather than `drawClipRect`'s top pin, which exists only
  // to clear that clip's own frames/waveform split. A caption block has none.
  if (label !== '' && rect.width >= MIN_LABEL_WIDTH_PX) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.fillStyle = palette.text
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'middle'
    ctx.fillText(label, rect.x + LABEL_PAD_PX + handleWidth, rect.y + rect.height / 2)
    ctx.restore()
  }

  ctx.restore()
}

/**
 * The span where two items on one row sit on top of each other.
 *
 * On an audio lane that is a crossfade and usually deliberate. On a video
 * track it usually is not: within a track the later clip simply wins, so an
 * overlap means one clip is invisible for that stretch — worth shouting about
 * rather than whispering.
 *
 * Neutral wash, diagonal hatching, and a thin rule down each side. The hatch
 * is the load-bearing part: a translucent wash strong enough to see over a
 * bright filmstrip frame is strong enough to hide the frame, whereas diagonals
 * stay legible over anything without obscuring what is underneath them. It is
 * also the convention — every NLE marks a transition region with stripes.
 */
export function drawOverlapBand(ctx: DrawContext, rect: Rect): void {
  if (rect.width <= 0 || rect.height <= 0) return

  ctx.save()
  // Clip first: the diagonals run past the band's corners by design, and the
  // clip is what turns them into a contained patch of hatching.
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()

  ctx.fillStyle = TIMELINE_COLORS.overlapFill
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

  // Leaning the same way as a fade: bottom-left to top-right. Start far enough
  // left that the first line still crosses the band's bottom-left corner.
  ctx.beginPath()
  for (let offset = 0; offset <= rect.width + rect.height; offset += OVERLAP_HATCH_SPACING_PX) {
    ctx.moveTo(rect.x + offset, rect.y + rect.height)
    ctx.lineTo(rect.x + offset - rect.height, rect.y)
  }
  // One path, stroked twice: a wide dark pass, then the amber inside it.
  ctx.strokeStyle = TIMELINE_COLORS.overlapHatchShadow
  ctx.lineWidth = OVERLAP_HATCH_SHADOW_WIDTH_PX
  ctx.stroke()
  ctx.strokeStyle = TIMELINE_COLORS.overlapHatch
  ctx.lineWidth = OVERLAP_HATCH_WIDTH_PX
  ctx.stroke()
  ctx.restore()

  // Edges last and unclipped: they are what says exactly where the overlap
  // starts and stops, which is the number an editor is actually trying to read
  // off the screen. Kept thin and translucent so the band never reads as the
  // white outline that means "selected".
  const edge = Math.min(OVERLAP_EDGE_WIDTH_PX, rect.width / 2)
  ctx.fillStyle = TIMELINE_COLORS.overlapEdge
  ctx.fillRect(rect.x, rect.y, edge, rect.height)
  ctx.fillRect(rect.x + rect.width - edge, rect.y, edge, rect.height)
}

/**
 * Time spans where consecutive items on one row overlap.
 *
 * Consecutive in START order, which is what a crossfade is; a clip buried
 * under a much longer neighbour two positions along is a different problem and
 * not one a band can usefully describe. Pure so both row kinds can share it —
 * the visual rows had no overlap marking at all before this, and duplicating
 * the arithmetic is how they would drift apart again.
 */
export function overlapBands(items: readonly { start: number; end: number }[]): Array<{ start: number; end: number }> {
  const sorted = [...items].sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (a.end <= b.start) continue
    out.push({ start: b.start, end: Math.min(a.end, b.end) })
  }
  return out
}

export function drawPlayhead(ctx: DrawContext, x: number, top: number, bottom: number): void {
  ctx.fillStyle = TIMELINE_COLORS.playhead
  ctx.fillRect(x - PLAYHEAD_WIDTH_PX / 2, top, PLAYHEAD_WIDTH_PX, bottom - top)
}

/**
 * The snap guide: the boundary a running gesture is currently magnetized to.
 *
 * A line plus an arrowhead at each end, pointing inward. The caps are load-
 * bearing, not decoration — a bare vertical line on this surface is already
 * two other things (the red playhead, the yellow preview axis), and the whole
 * job of this mark is to say "you are held HERE, and here is a real edge".
 *
 * Drawn last of everything on the overlay so it survives whatever it lands on.
 * When a gesture snaps to the playhead the cyan sits directly over the red,
 * which is exactly the right picture: that IS what happened.
 */
export function drawSnapGuide(
  ctx: DrawContext,
  x: number,
  top: number,
  bottom: number,
  strength: SnapStrength = 'strong',
): void {
  ctx.save()

  if (strength === 'weak') {
    ctx.fillStyle = TIMELINE_COLORS.snapGuideWeak
    ctx.fillRect(x - SNAP_GUIDE_WEAK_WIDTH_PX / 2, top, SNAP_GUIDE_WEAK_WIDTH_PX, bottom - top)
    ctx.restore()
    return
  }

  ctx.fillStyle = TIMELINE_COLORS.snapGuide
  ctx.fillRect(x - SNAP_GUIDE_WIDTH_PX / 2, top, SNAP_GUIDE_WIDTH_PX, bottom - top)

  const half = SNAP_GUIDE_CAP_HALF_WIDTH_PX
  const cap = SNAP_GUIDE_CAP_HEIGHT_PX

  ctx.beginPath()
  ctx.moveTo(x - half, top)
  ctx.lineTo(x + half, top)
  ctx.lineTo(x, top + cap)
  ctx.closePath()
  ctx.fill()

  ctx.beginPath()
  ctx.moveTo(x - half, bottom)
  ctx.lineTo(x + half, bottom)
  ctx.lineTo(x, bottom - cap)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
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
  /** The trim handle the pointer is resting on, if any. Only ever set for a
   *  SELECTED item, since unselected ones draw no handles to highlight. */
  hoveredHandle?: { itemId: string; edge: 'in' | 'out' } | null
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
  /** Caption blocks drawn. Kept OUT of `visualItemsDrawn`/`audioItemsDrawn` —
   *  every existing assertion built on those two ("drawn + culled === total
   *  items") predates captions and counts only clips/overlays and audio bars;
   *  folding captions in would silently change what those numbers mean for
   *  every project that already has any. Culled captions still count toward
   *  the shared `itemsCulled`, same as every other item kind. Required, not
   *  optional: `drawTimelineContent` always initializes it to 0 and is the
   *  only producer of a `DrawStats`, so every reader can rely on a number. */
  captionItemsDrawn: number
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
/**
 * The labelled interval for a ruler at this scale.
 *
 * Walks `RULER_STEPS_SECONDS` for the first step whose on-screen width clears
 * `RULER_MIN_LABEL_SPACING_PX`, so zooming changes the DENSITY of labels rather
 * than letting them overlap. Falls back to the coarsest step, which at extreme
 * zoom-out means sparse labels rather than none.
 */
export function rulerStepSeconds(pxPerSecond: number): number {
  if (!(pxPerSecond > 0)) return RULER_STEPS_SECONDS[RULER_STEPS_SECONDS.length - 1]
  for (const step of RULER_STEPS_SECONDS) {
    if (step * pxPerSecond >= RULER_MIN_LABEL_SPACING_PX) return step
  }
  return RULER_STEPS_SECONDS[RULER_STEPS_SECONDS.length - 1]
}

/** `m:ss`, plus tenths only when the step is finer than a second — a ruler
 *  labelled `0:03.0` every three seconds is noise, and one labelled `0:03`
 *  every 250ms is four identical labels in a row. */
export function formatRulerTime(seconds: number, step: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = safe - mins * 60
  if (step < 1) return `${mins}:${secs.toFixed(1).padStart(4, '0')}`
  return `${mins}:${String(Math.round(secs)).padStart(2, '0')}`
}

/**
 * The time ruler across the top of the surface — the strip you scrub on.
 *
 * Minor ticks subdivide each labelled interval into fifths, which is the
 * densest subdivision that still reads as ticks rather than as a grey band.
 */
export function drawRuler(
  ctx: DrawContext,
  viewport: Viewport,
  rect: { y: number; height: number },
  surfaceWidth: number,
): void {
  ctx.save()
  ctx.fillStyle = TIMELINE_COLORS.rulerBackground
  ctx.fillRect(0, rect.y, surfaceWidth, rect.height)

  const step = rulerStepSeconds(viewport.pxPerSecond)
  const minor = step / 5
  const bottom = rect.y + rect.height
  const range = visibleRange(viewport)
  const first = Math.floor(range.start / minor) * minor
  const last = range.end

  ctx.font = LABEL_FONT
  ctx.textBaseline = 'alphabetic'

  // Iterated in integer multiples of `minor` rather than by accumulating a
  // float, so a long timeline cannot drift the ticks off the labels.
  for (let i = 0; ; i++) {
    const t = first + i * minor
    if (t > last) break
    if (t < 0) continue
    const x = Math.round(timeToX(t, viewport)) + 0.5
    if (x < 0 || x > surfaceWidth) continue
    // Float multiples never land exactly on the step, so test the remainder
    // against a tolerance scaled to the step itself.
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6
    const tickHeight = isMajor ? RULER_MAJOR_TICK_PX : RULER_MINOR_TICK_PX
    ctx.fillStyle = isMajor ? TIMELINE_COLORS.rulerTick : TIMELINE_COLORS.rulerTickMinor
    ctx.fillRect(x, bottom - tickHeight, 1, tickHeight)

    if (isMajor) {
      ctx.fillStyle = TIMELINE_COLORS.rulerText
      ctx.fillText(formatRulerTime(t, step), x + 3, rect.y + RULER_LABEL_BASELINE_PX)
    }
  }
  ctx.restore()
}

/** The rubber-band selection box. Drawn on the overlay layer because it changes
 *  on every pointer move, exactly like the playhead. */
export function drawMarquee(ctx: DrawContext, rect: Rect): void {
  ctx.save()
  ctx.fillStyle = TIMELINE_COLORS.marqueeFill
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  ctx.strokeStyle = TIMELINE_COLORS.marqueeBorder
  ctx.lineWidth = 1
  // Half-pixel offsets so a 1px stroke lands on a pixel instead of straddling
  // two and rendering as a 2px blur.
  ctx.strokeRect(
    Math.round(rect.x) + 0.5,
    Math.round(rect.y) + 0.5,
    Math.round(rect.width),
    Math.round(rect.height),
  )
  ctx.restore()
}

export function drawTimelineContent(ctx: DrawContext, scene: TimelineScene): DrawStats {
  const { viewport, layout, selectedIds, surfaceWidth, surfaceHeight, hoveredHandle } = scene
  const range = visibleRange(viewport)
  const stats: DrawStats = { visualItemsDrawn: 0, audioItemsDrawn: 0, itemsCulled: 0, captionItemsDrawn: 0 }

  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)

  drawRuler(ctx, viewport, layout.ruler, surfaceWidth)


  for (const row of layout.rows) {
    drawRowBackground(ctx, { x: 0, y: row.y, width: surfaceWidth, height: row.height })

    // A SKIPPED track is drawn faded: it still draws, and stays selectable and
    // editable; only playback and export leave it out.
    const dimmed = row.disabled === true
    const palette = TRACK_PALETTE[row.trackIdx % TRACK_PALETTE.length]
    // Bodies of the selected clips in this row, queued for the handle pass at
    // the bottom of the loop.
    const handleRects: Array<{ body: Rect; hoveredEdge: 'in' | 'out' | null }> = []

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
      // Mirrors `effectiveItemAudio`'s track-or-item OR without needing a full
      // VisualTrack in scope here — `row.trackMuted` already folded in the
      // track's own `muted`, so only the item's is left to OR in.
      const itemMuted = row.trackMuted || item.muted === true
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
            if (clipWaveform) drawClipWaveform(c, r, clipWaveform, itemMuted)
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
      if (selectedIds.includes(item.id)) {
        handleRects.push({ body, hoveredEdge: hoveredHandle?.itemId === item.id ? hoveredHandle.edge : null })
      }
      stats.visualItemsDrawn++
    }

    // Overlaps on a visual row, drawn over the clips they span. New here: the
    // DOM timeline never marked these, and on canvas the only sign of one was
    // the clip band's dark wash landing twice — a faintly lighter box that
    // read as a rendering quirk rather than as two clips on top of each other.
    // A skipped row's band fades with the rest of it.
    ctx.save()
    if (dimmed) ctx.globalAlpha = 0.3
    for (const band of overlapBands(row.items)) {
      if (!intersectsRange(band.start, band.end, range)) continue
      drawOverlapBand(ctx, clampRectToSurface(
        { x: timeToX(band.start, viewport), y: row.y, width: (band.end - band.start) * viewport.pxPerSecond, height: row.height },
        surfaceWidth,
      ))
    }

    // Handles last of all, over the clips AND over any overlap band. They are
    // the control, so nothing gets to sit on top of them: a selected clip
    // whose end is buried under an overlapping neighbour still shows the edge
    // you can grab, which is what the hit-test now hands you there.
    for (const { body, hoveredEdge } of handleRects) {
      drawItemHandles(ctx, body, CLIP_HANDLE_WIDTH_PX, hoveredEdge, Math.min(CLIP_RADIUS_PX, body.width / 2, body.height / 2))
    }
    ctx.restore()
  }

  // The caption bands — absent entirely on a project with no caption segments
  // (see `computeTimelineLayout`), so this whole pass is a no-op for every
  // project that predates captions moving into the canvas. A hole lane still
  // gets a background-only band: nothing in its (empty) `segments` loop below
  // draws a block, but the row painted at its `y` is what keeps every OTHER
  // band from jumping position mid-drag.
  for (const caption of layout.captions ?? []) {
    drawRowBackground(ctx, { x: 0, y: caption.y, width: surfaceWidth, height: caption.height })
    const handleRects: Array<{ rect: Rect; hoveredEdge: 'in' | 'out' | null }> = []

    for (const seg of caption.segments) {
      if (!intersectsRange(seg.start, seg.end, range)) { stats.itemsCulled++; continue }
      const x = timeToX(seg.start, viewport)
      const rect = clampRectToSurface(
        {
          x,
          y: caption.y + AUDIO_ITEM_INSET_PX,
          width: (seg.end - seg.start) * viewport.pxPerSecond,
          height: caption.height - AUDIO_ITEM_INSET_PX * 2,
        },
        surfaceWidth,
      )
      if (rect.width <= 0) { stats.itemsCulled++; continue }
      // A segment briefly has no `id` — before `backfillCaptionIds` mints one
      // (see VideoEditor.tsx) — so it draws, but can never be selected or
      // handled. `segId` (not `seg.id`) is what the rest of this block reads,
      // since `seg.id`'s `string | undefined` would otherwise let a bare
      // `hoveredHandle?.itemId === seg.id` go true on "both sides undefined"
      // without `hoveredHandle` itself being set.
      const segId = typeof seg.id === 'string' ? seg.id : null
      const selected = segId !== null && selectedIds.includes(segId)
      drawCaptionBlock(ctx, { rect, selected, label: seg.text })
      if (selected && segId !== null) {
        const hoveredEdge = hoveredHandle?.itemId === segId ? hoveredHandle.edge : null
        handleRects.push({ rect, hoveredEdge })
      }
      stats.captionItemsDrawn++
    }

    // Handles last, over every block in the band — same "the control always
    // wins the stacking order" rule the visual rows and audio lanes follow.
    for (const { rect, hoveredEdge } of handleRects) {
      drawItemHandles(ctx, rect, AUDIO_HANDLE_WIDTH_PX, hoveredEdge, AUDIO_ITEM_RADIUS_PX)
    }
  }

  for (const lane of layout.lanes) {
    drawRowBackground(ctx, { x: 0, y: lane.y, width: surfaceWidth, height: lane.height })
    const laneHandleRects: Array<{ rect: Rect; hoveredEdge: 'in' | 'out' | null }> = []

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
      if (selectedIds.includes(track.id)) {
        laneHandleRects.push({ rect, hoveredEdge: hoveredHandle?.itemId === track.id ? hoveredHandle.edge : null })
      }
      stats.audioItemsDrawn++
    }

    // Overlap bands between consecutive unmuted bars in the lane. A muted bar
    // is not crossfading with anything, so it is left out of the pairing.
    for (const band of overlapBands(lane.tracks.filter(t => !t.muted))) {
      if (!intersectsRange(band.start, band.end, range)) continue
      drawOverlapBand(ctx, clampRectToSurface(
        { x: timeToX(band.start, viewport), y: lane.y, width: (band.end - band.start) * viewport.pxPerSecond, height: lane.height },
        surfaceWidth,
      ))
    }

    // As the visual rows: last, over everything. Crossfaded bars overlap by
    // design, so on a lane this is the normal case rather than the exception.
    for (const { rect, hoveredEdge } of laneHandleRects) {
      drawItemHandles(ctx, rect, AUDIO_HANDLE_WIDTH_PX, hoveredEdge, AUDIO_ITEM_RADIUS_PX)
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
  /** The boundary a running gesture is snapped to, or null when it is running
   *  free (or no gesture is running). Emitted by the pointer machine, which is
   *  the only thing that knows which edge of a dragged span actually caught. */
  snapTime?: number | null
  /** Which tier is holding it — a same-track magnet draws boldly, a
   *  cross-track one as a hairline. Defaults to strong. */
  snapStrength?: SnapStrength | null
  /** The rubber-band selection box while one is being dragged, else null. */
  marquee?: Rect | null
}

/** Paint the playhead layer. Kept separate from the content so playback — which
 *  moves the playhead ~60 times a second — repaints two `fillRect`s, not the
 *  whole timeline. The preview-axis cursor rides here for the same reason:
 *  tracking the pointer must not force a content repaint. */
export function drawTimelineOverlay(ctx: DrawContext, scene: OverlayScene): void {
  const { viewport, currentTime, surfaceWidth, surfaceHeight, cursorTime, snapTime, snapStrength } = scene
  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)
  // First, so the playhead and any guide stay legible over it — the marquee is
  // a translucent wash and would otherwise dull both.
  if (scene.marquee) drawMarquee(ctx, scene.marquee)
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
  // Last, so it wins over both lines. A gesture snapped to the playhead should
  // look snapped, not hidden behind the thing it snapped to.
  if (snapTime !== undefined && snapTime !== null) {
    const sx = timeToX(snapTime, viewport)
    if (!(sx < -SNAP_GUIDE_CAP_HALF_WIDTH_PX || sx > surfaceWidth + SNAP_GUIDE_CAP_HALF_WIDTH_PX)) {
      drawSnapGuide(ctx, sx, 0, surfaceHeight, snapStrength ?? 'strong')
    }
  }
}

/** AudioTrackRow's label rule: the type name, else the track label, else the
 *  source filename. */
export function audioLabel(track: AudioTrack): string {
  if (track.type === 'voiceover') return 'Voiceover'
  if (track.type === 'music') return 'Music'
  return track.label ?? track.src.split('/').pop() ?? 'audio'
}
