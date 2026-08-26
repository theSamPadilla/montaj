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
import { DEFAULT_FADE_CURVE, fadeGain, makeFadeGainAt, type FadeCurve } from './fade-curve'
import { canKeyframe, isKeyframed } from '../../keyframeOps'
import { KEYFRAME_DIAMOND_SIZE_PX, KEYFRAME_STRIP_BOTTOM_PAD_PX, keyframeDiamondX, keyframeUnionTimes } from './keyframe-strip'
import type { SnapStrength } from './snap'
import { timeToX, visibleRange, type Viewport } from './viewport'
import {
  LIGHT_WAVEFORM_COLORS,
  WAVEFORM_COLORS,
  drawAudioLaneWaveform,
  drawClipWaveform,
  type WaveformColors,
  type WaveformSceneLookup,
} from './waveforms'
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
  /** Unused by any painter today — the fade-envelope curve
   *  (`drawFadeEnvelope`) was its one caller until fade shapes replaced the
   *  single quadratic ease with a sampled polyline. Kept on the interface
   *  since it's part of the real `CanvasRenderingContext2D` shape a live
   *  context satisfies for free, and a future curve is one candidate use. */
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
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
  /** Dash pattern for subsequent strokes; `[]` is a solid line. Used by exactly
   *  one painter (`drawPendingDropBand`), because "dashed" is the one outline
   *  on this surface that means "not real yet". It is set INSIDE that painter's
   *  own save/restore pair — a dash left on the context leaks into every later
   *  stroke on the same layer, which on the overlay would mean a dashed
   *  playhead. */
  setLineDash(segments: number[]): void
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

/** `TRACK_PALETTE` for a LIGHT row.
 *
 *  Same six hue identities in the same order — slate, sky, violet, emerald,
 *  rose, amber — because a clip's colour is how you recognize which track it
 *  came from, and that must not change when the host flips theme. What DOES
 *  change is which end of each hue's ramp is used: dark rows take a saturated
 *  500/700-level fill with a 100/200-level LABEL on it, light rows take a
 *  200/300-level fill with a 800/900-level label. The border/ring pair follows
 *  the same inversion (a 500-level hairline, a 700-level selection ring), so
 *  "the ring is brighter than the fill" becomes "the ring is DARKER than the
 *  fill" — the same statement about contrast, read on the other ground.
 *
 *  Fills stay at high alpha (0.85/0.95 rather than the dark set's 0.8/0.9)
 *  because a pale tint at 0.8 over an already-pale row washes out into it; the
 *  amber entry keeps its own lower pair (0.7/0.9 against the dark set's
 *  0.6/0.8) so it stays the quietest of the six here too. */
export const LIGHT_TRACK_PALETTE: TrackPalette[] = [
  { fill: 'rgba(203,213,225,0.85)', fillSelected: 'rgba(148,163,184,0.95)', ring: 'rgba(51,65,85,0.85)',   border: 'rgba(100,116,139,0.6)', text: '#1e293b' }, // slate
  { fill: 'rgba(186,230,253,0.85)', fillSelected: 'rgba(125,211,252,0.95)', ring: 'rgba(3,105,161,0.85)',  border: 'rgba(14,165,233,0.6)',  text: '#0c4a6e' }, // sky
  { fill: 'rgba(221,214,254,0.85)', fillSelected: 'rgba(196,181,253,0.95)', ring: 'rgba(109,40,217,0.85)', border: 'rgba(139,92,246,0.6)',  text: '#4c1d95' }, // violet
  { fill: 'rgba(167,243,208,0.85)', fillSelected: 'rgba(110,231,183,0.95)', ring: 'rgba(4,120,87,0.85)',   border: 'rgba(16,185,129,0.6)',  text: '#064e3b' }, // emerald
  { fill: 'rgba(254,205,211,0.85)', fillSelected: 'rgba(253,164,175,0.95)', ring: 'rgba(190,18,60,0.85)',  border: 'rgba(244,63,94,0.6)',   text: '#881337' }, // rose
  { fill: 'rgba(253,230,138,0.7)',  fillSelected: 'rgba(252,211,77,0.9)',   ring: 'rgba(180,83,9,0.85)',   border: 'rgba(245,158,11,0.6)',  text: '#78350f' }, // amber
]

/** The caption block palette. Unlike `TRACK_PALETTE`, which cycles a hue per
 *  track, every caption block shares this ONE palette — captions are a single
 *  row, not several, so there is nothing to cycle. Deliberately CYAN, distinct
 *  from the overlay tracks' violet and the audio lane's emerald, so a caption
 *  reads as its own element type on the timeline rather than blending into an
 *  overlay. `fill`/`border` are the unselected state; `fillSelected`/`ring` the
 *  selected one; `text` is the label color. (The selected/unselected keyframe
 *  diamonds are white / amber, both legible on this cyan.) */
export const CAPTION_PALETTE: TrackPalette = {
  fill: 'rgba(8,145,178,0.4)',
  fillSelected: 'rgba(6,182,212,0.75)',
  ring: 'rgba(165,243,252,0.85)',
  border: 'rgba(34,211,238,0.5)',
  text: '#cffafe',
}

/** `CAPTION_PALETTE` on a LIGHT row. Still CYAN — the whole point of that
 *  choice is that a caption is neither the overlays' violet nor the audio
 *  lane's emerald, and that separation has to survive the theme flip — read
 *  off the other end of the cyan ramp: a 200-level fill with a 900-level
 *  label, a 500-level border and a 700-level selection ring. The unselected
 *  fill keeps its deliberately-low alpha relative to the selected one (0.55 vs
 *  0.85, mirroring the dark set's 0.4 vs 0.75), so selecting a caption is
 *  still a visible jump in weight rather than only a change of outline. */
export const LIGHT_CAPTION_PALETTE: TrackPalette = {
  fill: 'rgba(165,243,252,0.55)',
  fillSelected: 'rgba(103,232,249,0.85)',
  ring: 'rgba(14,116,144,0.85)',
  border: 'rgba(6,182,212,0.65)',
  text: '#164e63',
}

/** TrackGutter's rail-cell accent for the caption row. Same cyan hue as
 *  `CAPTION_PALETTE.border`, at a higher alpha — a rail chip reads best brighter
 *  than a canvas fill. Exported beside `CAPTION_PALETTE`, the single source for
 *  the caption color, instead of letting TrackGutter hardcode its own copy with
 *  nothing tying the two together. */
export const CAPTION_RAIL_ACCENT = 'rgba(34,211,238,0.6)'

/** `CAPTION_RAIL_ACCENT` on the LIGHT rail. Same relationship to
 *  `LIGHT_CAPTION_PALETTE.border` the dark pair has to its own — a rail chip
 *  reads best with MORE weight than the canvas fill beside it — which on a
 *  near-white rail means stepping the hue DOWN the ramp (cyan-600) rather than
 *  up it, and nudging the alpha up to hold the 2px chip together. */
export const LIGHT_CAPTION_RAIL_ACCENT = 'rgba(8,145,178,0.75)'

export const TIMELINE_COLORS = {
  /** `bg-gray-900` — the dark-mode row background both row kinds use. */
  rowBackground: '#111827',
  /** A hair lighter than `rowBackground`, alternated with it per row so
   *  adjacent track lanes read as distinct panels instead of one dark field. */
  rowBackgroundAlt: '#161f30',
  /** Subtle outline around every row band — the visible divider that separates
   *  one track lane from the next, rather than relying on the gap alone. */
  rowDivider: 'rgba(148,163,184,0.16)',
  /** `bg-emerald-500/40` + `border-emerald-500/60` on AudioTrackRow's bars. */
  audioFill: 'rgba(16,185,129,0.4)',
  audioBorder: 'rgba(16,185,129,0.6)',
  /** `bg-white/10` — a muted audio bar. */
  audioMutedFill: 'rgba(255,255,255,0.1)',
  audioRing: 'rgba(110,231,183,0.8)',
  audioText: '#a7f3d0',
  /** Fade envelope: the dimmed tint across the WHOLE fade-width band
   *  (`drawFadeEnvelope`; both sides of the curve, not a wedge on one side),
   *  and the curve's own stroke drawn on top of it. Replaces a flat
   *  linear-gradient wash — the curve is what makes the RAMP, and its
   *  length, legible, not just "audio is quieter somewhere near here". */
  fadeEnvelopeDim: 'rgba(0,0,0,0.35)',
  fadeEnvelopeLine: 'rgba(255,255,255,0.55)',
  /** The fade-grip triangle at an audio bar's top corner (`drawFadeGrip`).
   *  Subtle by default so it doesn't compete with the label; brighter when
   *  hovered or the bar is selected — the same "clearer when it matters"
   *  language the trim handles use. */
  fadeGripSubtle: 'rgba(255,255,255,0.35)',
  fadeGripActive: 'rgba(255,255,255,0.95)',
  /** The keyframe-strip diamond (`drawKeyframeDiamond`). Amber rather than
   *  reusing white (the selection/handle vocabulary) or cyan (the snap
   *  guide) or yellow (`cursor`, the preview-axis line) — every other
   *  bright hue on this surface already means something else, and a
   *  keyframe is its own kind of mark. */
  keyframeDiamondFill: '#fb923c',
  /** Outline so the diamond reads as a shape rather than a blob against a
   *  filmstrip frame of any brightness — same trick `LABEL_SHADOW_COLOR`
   *  uses for the clip label. */
  keyframeDiamondStroke: 'rgba(0,0,0,0.7)',
  /** The ONE diamond matching the host's `selectedKeyframe`, drawn with this
   *  fill instead of `keyframeDiamondFill`. White, not a new hue: it is
   *  already the selection vocabulary on this surface (`clipSelectedOutline`,
   *  `handleFill`), and reads clearly against the amber every other diamond
   *  in the strip keeps. */
  keyframeDiamondSelectedFill: '#ffffff',
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
  /** The ghost band for a file still being imported (`drawPendingDropBand`).
   *
   *  Deliberately colourless — slate, the same neutral the row divider and the
   *  ruler ticks are drawn in. Every saturated hue on this surface is spoken
   *  for and each one is a claim: red is where playback is, cyan is an
   *  alignment, amber is a keyframe, emerald is audio, white is selection. A
   *  pending import is none of those; it is a placeholder, and a placeholder
   *  that borrowed any of those hues would be read as the thing that hue
   *  means. What says "not real yet" is the DASHED outline, not the colour.
   *
   *  The fill is one step up in alpha from `rowDivider` (0.18 vs 0.16) so the
   *  two are never the same literal — a hairline divider and a whole band are
   *  different marks and must not be confusable by colour alone. */
  pendingDropFill: 'rgba(148,163,184,0.18)',
  /** Slate-200: brighter than the fill, so the dashes hold together as an
   *  outline over whatever row background the band lands on. */
  pendingDropStroke: 'rgba(226,232,240,0.7)',
  /** The filename inside the band. A shade brighter again than the stroke —
   *  the band is translucent, so the text is competing with the row (and any
   *  clip) showing through it. */
  pendingDropText: 'rgba(241,245,249,0.9)',
} as const

/** The shape both palettes satisfy — `TIMELINE_COLORS`'s own keys, widened
 *  from its `as const` string literals to plain `string` so the light set can
 *  be typed against it and so no consumer accidentally depends on a specific
 *  literal being present at a key. */
export type TimelineColors = { [K in keyof typeof TIMELINE_COLORS]: string }

/**
 * `TIMELINE_COLORS` for a LIGHT host theme.
 *
 * Every entry is the SEMANTIC of its dark counterpart re-derived against a
 * light row, not the dark number lightened. Two rules do most of the work:
 *
 *  1. Anything whose dark rationale was "white, because it survives an
 *     arbitrary video frame / because white is the selection vocabulary here"
 *     becomes near-black (`rgba(15,23,42,…)` / `#0f172a`), because on this
 *     ground that is the colour that survives and that selection speaks. The
 *     ALPHAS are carried over verbatim wherever they were load-bearing — see
 *     `overlapFill` below.
 *  2. Anything that was a dark scrim UNDER something white flips to a light
 *     scrim under something dark (`overlapHatchShadow`), for the same reason
 *     it existed at all: the mark needs a ground of the opposite value to read
 *     against, whatever is painted behind it.
 *
 * The exceptions are called out at their own keys.
 */
export const LIGHT_TIMELINE_COLORS: TimelineColors = {
  /** Slightly DARKER than the editor surface (`#ffffff`) and than the shell
   *  (`#f3f4f6`), so a row reads as a recessed field you drop clips into. The
   *  dark pair is raised out of a near-black shell; on a near-white one the
   *  only way to say "this is the track area" is to sink it. */
  rowBackground: '#e9ecf1',
  /** Alternated with `rowBackground` per row, a hair DARKER — the mirror of
   *  the dark pair's "a hair lighter", and the same size of step (~8/255), so
   *  adjacent lanes separate exactly as subtly as they do in dark. */
  rowBackgroundAlt: '#e1e5ec',
  /** Slate-600 rather than dark's slate-400, at a slightly higher alpha: a
   *  hairline needs more weight to hold together against a light ground than
   *  against a dark one. */
  rowDivider: 'rgba(71,85,105,0.18)',
  /** Emerald stays emerald — the audio lane's identity. Nudged up in alpha
   *  (0.45 from 0.4) and the border down the ramp to emerald-600, because a
   *  0.4 wash of a mid-tone hue over a pale row is much closer to the row than
   *  the same wash over a near-black one. */
  audioFill: 'rgba(16,185,129,0.45)',
  audioBorder: 'rgba(5,150,105,0.75)',
  /** A muted bar: dark uses white-at-0.1 to wash the emerald toward its
   *  background. Here the wash toward the background is a near-black one, at
   *  the SAME 0.1 — see `overlapFill`, which depends on this literal staying
   *  distinct from its own. */
  audioMutedFill: 'rgba(15,23,42,0.1)',
  /** Dark's ring is emerald-300 — brighter than the fill. Light's is
   *  emerald-700 — darker than the fill. Same sentence, other ground. */
  audioRing: 'rgba(4,120,87,0.85)',
  audioText: '#064e3b',
  /** The fade band's tint. Dark DARKENS the band (black at 0.35); light
   *  LIGHTENS it, washing the emerald toward the row background — on a light
   *  ground "less signal" reads as "closer to empty", and a dark wash there
   *  would read as ink rather than as attenuation. The envelope line drawn on
   *  top of it is near-black, so the two still separate cleanly. */
  fadeEnvelopeDim: 'rgba(255,255,255,0.5)',
  fadeEnvelopeLine: 'rgba(15,23,42,0.65)',
  /** Same subtle-vs-active pair, inverted: the grip is a dark triangle that
   *  goes from quiet to emphatic rather than a white one. */
  fadeGripSubtle: 'rgba(15,23,42,0.4)',
  fadeGripActive: 'rgba(15,23,42,0.9)',
  /** IDENTICAL to dark, deliberately. Amber IS the keyframe mark — no other
   *  hue on this surface is free to mean it — and a diamond is painted over
   *  the clip's own content (filmstrip frames, waveform band), not over the
   *  row background, so it has to survive an arbitrary image in either mode
   *  rather than being tuned to the light row it happens to sit near. */
  keyframeDiamondFill: '#fb923c',
  /** The halo that makes the diamond read as a SHAPE rather than a blob. Dark
   *  lays a black one under an amber diamond sitting on dark content; light
   *  lays a white one, since the band under it here is pale and a black rim
   *  would merge with the dark bars of the waveform it sits in. */
  keyframeDiamondStroke: 'rgba(255,255,255,0.85)',
  /** The one selected diamond. Dark fills it white because white is already
   *  this surface's selection vocabulary; light fills it near-black for
   *  exactly the same reason — see `clipSelectedOutline` and `handleFill`,
   *  which moved the same way. White would also now collide with the halo. */
  keyframeDiamondSelectedFill: '#0f172a',
  // 0.12, not 0.1, for the SAME reason the dark set says 0.12: `audioMutedFill`
  // above is exactly `rgba(15,23,42,0.1)`, and letting a muted bar and an
  // overlap band share one literal would make them indistinguishable by colour
  // to anything reasoning about the paint. The "no two meanings share one
  // literal" property is preserved key-for-key across both modes.
  overlapFill: 'rgba(15,23,42,0.12)',
  overlapHatch: 'rgba(15,23,42,0.7)',
  /** Laid under each hatch line, a little wider. Dark puts BLACK under white
   *  stripes; light puts WHITE under near-black ones — the under-stroke's
   *  whole job is to be the opposite value of the stripe, so that one hatch
   *  treatment survives both a bright and a dark filmstrip frame. */
  overlapHatchShadow: 'rgba(255,255,255,0.6)',
  overlapEdge: 'rgba(15,23,42,0.5)',
  /** IDENTICAL to dark. Red-500 is unmistakable on either ground and there is
   *  no second thing on this surface it could be confused with. */
  playhead: '#ef4444',
  /** Dark's white outline is "the one colour that stays obvious over an
   *  arbitrary video frame"; on a light editor that colour is near-black. */
  clipSelectedOutline: '#0f172a',
  /** The preview-axis cursor. The ONE "keep it vivid" colour that had to move:
   *  yellow-400 against a near-white row is roughly 1.1:1 and simply is not
   *  there. Stepped to yellow-700 — still unmistakably the gold line, still
   *  impossible to confuse with the red playhead or the cyan snap guide, and
   *  actually visible (~4.7:1). */
  cursor: '#a16207',
  /** The trim pill, and the pill under the pointer. Same "the handles are
   *  thickenings of the selection border" rule, so these track
   *  `clipSelectedOutline` into near-black. */
  handleFill: 'rgba(15,23,42,0.9)',
  handleFillHovered: '#0f172a',
  /** The grip ticks INSIDE the pill. Dark-on-white in dark mode; the pill is
   *  now dark, so the ticks are light-on-dark. The glyph is unchanged — it is
   *  the contrast against the pill that carries it, not the colour. */
  handleGrip: 'rgba(248,250,252,0.6)',
  handleGripHovered: 'rgba(248,250,252,0.95)',
  /** Still cyan — every other line on this surface is spoken for in both modes
   *  — but stepped from cyan-400 to cyan-600, which is the shallowest step
   *  that clears "a 2px line you can actually see" on a light row. */
  snapGuide: '#0891b2',
  snapGuideWeak: 'rgba(8,145,178,0.45)',
  /** A shade off `rowBackground` so the ruler reads as chrome rather than as a
   *  droppable track — the same relationship dark has, inverted: dark's ruler
   *  sinks BELOW its rows, light's lifts ABOVE them toward the surface. */
  rulerBackground: '#f5f7fa',
  /** Deliberately low-contrast, as in dark: slate-600/700 at the same alphas
   *  rather than the slate-400 that reads as low-contrast on a dark ground. */
  rulerTick: 'rgba(71,85,105,0.55)',
  rulerTickMinor: 'rgba(71,85,105,0.3)',
  rulerText: 'rgba(51,65,85,0.85)',
  /** The marquee. Selection vocabulary again, so it follows the outline and
   *  the handles into near-black — at the dark set's own alphas, which were
   *  already tuned to "a wash you can see through and a border you can't miss". */
  marqueeFill: 'rgba(15,23,42,0.08)',
  marqueeBorder: 'rgba(15,23,42,0.6)',
  /** The pending-import ghost. Colourless in dark, colourless here — but the
   *  neutral has to come from the OTHER end of the slate ramp: on a pale row a
   *  slate-400 wash is barely a change of value at all, so the fill steps down
   *  to slate-600 and the outline/text to near-black, exactly the flip the
   *  marquee above makes. The alphas are carried over from the dark set, which
   *  is where the "a wash you can see through, an outline you can't miss"
   *  balance was tuned; only the hue's end of the ramp moves. */
  pendingDropFill: 'rgba(71,85,105,0.18)',
  pendingDropStroke: 'rgba(51,65,85,0.7)',
  pendingDropText: 'rgba(15,23,42,0.9)',
}

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
/** Fade-grip triangle size (px), base and height alike. Kept small
 *  deliberately — see hit-test.ts's `FADE_GRIP_HALF_WIDTH_PX`/
 *  `FADE_GRIP_ZONE_HEIGHT_PX` for why the grip's CLICKABLE zone is a
 *  matching small top-corner target rather than the full bar height. */
export const FADE_GRIP_SIZE_PX = 6
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
/** `LABEL_SHADOW_COLOR` for a light theme. The shadow exists to give the label
 *  a ground of the OPPOSITE value to its own text, so it reads over a
 *  filmstrip frame of any brightness. A light theme's clip labels are dark
 *  (see `LIGHT_TRACK_PALETTE`'s `text`), so a black halo behind them would do
 *  nothing at all — the halo has to be white. */
export const LIGHT_LABEL_SHADOW_COLOR = 'rgba(255,255,255,0.9)'
export const LABEL_SHADOW_BLUR_PX = 3

// ── Mode resolution ──────────────────────────────────────────────────────

/** Which ground the surface is being painted on. Named for the HOST theme's
 *  light/dark classification (`isLightTheme` in theme.ts), not for a Montaj
 *  theme name, because that is the only thing this module needs to know. */
export type TimelineMode = 'light' | 'dark'

/**
 * Everything a single draw pass needs to know about colour, resolved once.
 *
 * One object rather than a mode flag threaded down: the painters must never
 * each re-derive "which mode am I?", or a future palette that resolves from
 * something richer than a two-valued enum would have to be plumbed to every
 * one of them again. They take the resolved set and read it.
 *
 * `waveform` rides along here too, even though `WAVEFORM_COLORS` lives in
 * waveforms.ts, so the clip/audio waveform painters are handed the SAME
 * resolution the rest of the pass is using instead of doing a second,
 * independent mode lookup that could silently disagree with it.
 */
export interface TimelinePalette {
  mode: TimelineMode
  colors: TimelineColors
  /** Cycled per track index — see `TRACK_PALETTE`. */
  tracks: TrackPalette[]
  /** The single caption-block palette — see `CAPTION_PALETTE`. */
  caption: TrackPalette
  /** TrackGutter's caption rail chip — see `CAPTION_RAIL_ACCENT`. */
  captionRailAccent: string
  waveform: WaveformColors
  /** Drop shadow behind a clip label — see `LABEL_SHADOW_COLOR`. */
  labelShadow: string
}

/** The dark set, assembled from the module constants that have always held it.
 *  Every painter defaults to THIS when handed no palette, which is what keeps
 *  a caller (or a test) that predates modes drawing byte-identical pixels. */
export const DARK_TIMELINE_PALETTE: TimelinePalette = {
  mode: 'dark',
  colors: TIMELINE_COLORS,
  tracks: TRACK_PALETTE,
  caption: CAPTION_PALETTE,
  captionRailAccent: CAPTION_RAIL_ACCENT,
  waveform: WAVEFORM_COLORS,
  labelShadow: LABEL_SHADOW_COLOR,
}

export const LIGHT_TIMELINE_PALETTE: TimelinePalette = {
  mode: 'light',
  colors: LIGHT_TIMELINE_COLORS,
  tracks: LIGHT_TRACK_PALETTE,
  caption: LIGHT_CAPTION_PALETTE,
  captionRailAccent: LIGHT_CAPTION_RAIL_ACCENT,
  waveform: LIGHT_WAVEFORM_COLORS,
  labelShadow: LIGHT_LABEL_SHADOW_COLOR,
}

/** The palette for a mode. Returns one of two module-level objects rather than
 *  building one per call: this is read once per draw pass and once per
 *  TrackGutter render, and a fresh object each time would churn identity for
 *  anything that memoizes on it. */
export function timelinePalette(mode: TimelineMode): TimelinePalette {
  return mode === 'light' ? LIGHT_TIMELINE_PALETTE : DARK_TIMELINE_PALETTE
}

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
 * The base track is drawn taller (120px vs. 40px for the rest).
 *
 * T5's hit-testing should derive its rows from here rather than re-deriving
 * geometry — one layout, two readers.
 */
export function computeTimelineLayout(project: Project): TimelineLayout {
  // Order-normalized (Part B): `trackItems` funnels through `normalizeTracks`,
  // which now groups tracks into the canonical video-block/overlay-block
  // stack (`normalizeTrackOrder`) before returning — so `allTracks` here is
  // ALREADY in that order, and `trackSettings` below (also read off
  // `normalizeTracks(project)`) agrees with it index-for-index by
  // construction. Display, hit-test (which derives its rows from this same
  // layout), and mutation (`moveItemAcrossTracks` re-groups its own result
  // the same way) therefore can never disagree about what trackIdx N is.
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

  // Highest trackIdx that holds a video item. Because `allTracks` is already
  // order-normalized (video block first, contiguous from index 0), this is
  // the TOP of that block — where the caption band(s) belong: directly above
  // the video block, below any overlay tracks. `-1` when there are no video
  // tracks at all, in which case captions fall back to sitting above
  // trackIdx 0 — today's behaviour, unchanged, whatever kind that track is.
  // For a project with exactly one video track, `topVideoIdx` is always 0
  // (the base track), so `captionEmitIdx` is 0 either way and this whole
  // change is a no-op for the single-video-track case.
  let topVideoIdx = -1
  for (let i = 0; i < allTracks.length; i++) {
    if (allTracks[i].some(item => item.type === 'video')) topVideoIdx = i
  }
  const captionEmitIdx = topVideoIdx >= 0 ? topVideoIdx : 0

  for (let reversedIdx = 0; reversedIdx < allTracks.length; reversedIdx++) {
    const trackIdx = allTracks.length - 1 - reversedIdx
    // The caption bands sit directly above the TOP of the video block —
    // captions narrate that footage, so they read as adjacent to it, above
    // whatever overlay tracks sit above the video block and below the video
    // block itself. `trackIdx === captionEmitIdx` fires exactly once per
    // layout, immediately before that row is pushed (rows are pushed in
    // descending trackIdx order, i.e. top of screen first).
    if (trackIdx === captionEmitIdx && captionGroups.length > 0) emitCaptionBands()
    // Tall not just for the base track (trackIdx 0, always tall even when
    // empty, so a blank base row doesn't jump size once footage lands) but
    // for ANY video-kind track — a second video track carries the same
    // filmstrip+waveform content as the base and is cramped without the
    // room. Overlay/image tracks keep the short row.
    const height = (trackIdx === 0 || allTracks[trackIdx][0]?.type === 'video')
      ? BASE_VISUAL_ROW_RENDER_HEIGHT_PX
      : VISUAL_ROW_RENDER_HEIGHT_PX
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
  // above, so the hook that emits the bands right before `trackIdx ===
  // captionEmitIdx` never fires. Emit them here instead — still above where
  // the (absent) base row would sit, which is the same rule applied to zero
  // rows.
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

/** `color` stays the THIRD parameter (callers and tests pass the alternating
 *  row shade there positionally); the palette is appended after it, and an
 *  omitted `color` falls back to that palette's own `rowBackground` rather
 *  than to the dark literal. */
export function drawRowBackground(
  ctx: DrawContext,
  rect: Rect,
  color?: string,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  ctx.fillStyle = color ?? palette.colors.rowBackground
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, ROW_RADIUS_PX)
  ctx.fill()
  // A faint outline so each lane reads as its own panel and the boundary
  // between adjacent tracks is a visible divider, not just the gap. Uses
  // strokeRect rather than a stroked roundRectPath so it adds no path
  // (`moveTo`) calls — the row corners are only 4px, so a square outline reads
  // as clean at this radius.
  ctx.strokeStyle = palette.colors.rowDivider
  ctx.lineWidth = 1
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1))
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
export function drawTrimHandle(
  ctx: DrawContext,
  args: TrimHandleDrawArgs,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const { rect, edge, hovered = false } = args
  if (rect.width <= 0 || rect.height <= 0) return

  // Two handles must never meet in the middle: on a clip narrower than twice
  // the nominal width they each take half and stop.
  const width = Math.min(args.width, rect.width / 2)
  if (width < MIN_HANDLE_WIDTH_PX) return

  const x = edge === 'in' ? rect.x : rect.x + rect.width - width
  const radius = Math.min(args.radius ?? CLIP_RADIUS_PX, width / 2, rect.height / 2)

  ctx.save()
  ctx.fillStyle = hovered ? palette.colors.handleFillHovered : palette.colors.handleFill
  roundRectPath(ctx, x, rect.y, width, rect.height, radius)
  ctx.fill()

  // Grip ticks, centred in the pill. Skipped when the pill has narrowed to the
  // point where they'd fill it edge to edge and read as one solid block.
  const gripSpan = HANDLE_GRIP_COUNT * HANDLE_GRIP_WIDTH_PX + (HANDLE_GRIP_COUNT - 1) * HANDLE_GRIP_GAP_PX
  if (gripSpan <= width - 2) {
    const gripHeight = Math.min(rect.height * HANDLE_GRIP_HEIGHT_RATIO, HANDLE_GRIP_MAX_HEIGHT_PX)
    const gripY = rect.y + (rect.height - gripHeight) / 2
    let gripX = x + (width - gripSpan) / 2
    ctx.fillStyle = hovered ? palette.colors.handleGripHovered : palette.colors.handleGrip
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
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  for (const edge of ['in', 'out'] as const) {
    drawTrimHandle(ctx, { rect, edge, width, hovered: hoveredEdge === edge, radius }, palette)
  }
}

/** `args.palette` is the TRACK's own hue (already resolved by the caller from
 *  the mode-appropriate cycle); the trailing `palette` is the surface-wide set
 *  the mode-independent furniture — the selection outline, the label's halo —
 *  comes from. */
export function drawClipRect(
  ctx: DrawContext,
  args: ClipDrawArgs,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const { rect, palette: trackPalette, selected, label, dimmed, drawContent } = args
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
  ctx.fillStyle = selected ? trackPalette.fillSelected : trackPalette.fill
  ctx.fillRect(body.x, body.y, body.width, body.height)
  drawContent?.(ctx, body)
  ctx.restore()

  // The outline is the selection. A 1px inset ring in the track's own hue was
  // invisible once frames filled the clip; selection now reads as a thick
  // white border round the whole block, the one treatment that survives any
  // frame underneath it.
  if (selected) {
    const inset = CLIP_SELECTED_BORDER_PX / 2
    ctx.strokeStyle = palette.colors.clipSelectedOutline
    ctx.lineWidth = CLIP_SELECTED_BORDER_PX
    roundRectPath(ctx, body.x + inset, body.y + inset, Math.max(0, body.width - CLIP_SELECTED_BORDER_PX), Math.max(0, body.height - CLIP_SELECTED_BORDER_PX), radius)
    ctx.stroke()
  } else {
    ctx.strokeStyle = trackPalette.border
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
    ctx.fillStyle = trackPalette.text
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'middle'
    // Pinned to the TOP, not the vertical centre it used to sit at: a video
    // clip is now split into a frames band and a waveform band, and the centre
    // is the seam between them — the worst line on the clip for legibility.
    // The shadow is what lets it read over an arbitrary frame underneath;
    // `restore()` below drops it before anything else paints.
    ctx.shadowColor = palette.labelShadow
    ctx.shadowBlur = LABEL_SHADOW_BLUR_PX
    ctx.fillText(label, body.x + LABEL_PAD_PX + handleWidth, body.y + LABEL_TOP_OFFSET_PX)
    ctx.restore()
  }

  ctx.restore()
}

/** Segments the envelope polyline samples `fadeGain` at. 24 is smooth enough
 *  that `exp`/`log`'s curvature reads clearly at any bar width the fade grip
 *  can produce, without asking the rasterizer to stroke hundreds of tiny
 *  segments on every repaint. Exported so tests can assert on the curve's
 *  `lineTo` call count directly. */
export const FADE_ENVELOPE_SEGMENTS = 24

/**
 * Vegas-style fade envelope: the WHOLE fade-width region — `x = spanX` to
 * `spanX + fadeInPx` for a fade-in, `spanX + spanWidth - fadeOutPx` to
 * `spanX + spanWidth` for a fade-out, measured off the clip's TRUE span (see
 * the note inside) so the fade tracks the clip under horizontal scroll — is
 * tinted FULL HEIGHT, top to bottom, as one band. The gain curve is then
 * stroked brightly on top of it, dividing the band into what's above and
 * below the curve — but BOTH halves stay tinted; this is not a wedge on one
 * side. The band is what says "this section is fading, full stop"; the curve
 * on top is what says exactly how much, at exactly which point. Replaces a
 * flat linear-gradient wash, which said "audio is quieter somewhere here"
 * but not how much quieter, where, or for how long — and replaced an earlier
 * one-sided wedge fill (shading only the region UNDER the curve) that read as
 * "this is the remaining signal" rather than "this is the fading section".
 *
 * The curve is drawn as a sampled polyline (`FADE_ENVELOPE_SEGMENTS` steps of
 * `fadeGain`), not a single curve primitive, because the shape is now a
 * per-fade CHOICE (`curve`) rather than one fixed ease — `fadeGain` is the
 * one source of truth for what each shape looks like, shared with the
 * waveform's own amplitude scaling (`waveforms.ts`) and the rendered mix
 * (`mix-audio.js`), and a polyline is the only primitive that can trace an
 * arbitrary one of them.
 */
function drawFadeEnvelope(
  ctx: DrawContext,
  rect: Rect,
  edge: 'in' | 'out',
  widthPx: number,
  spanX: number,
  spanWidth: number,
  curve: FadeCurve,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  // `spanX`/`spanWidth` are the clip's TRUE horizontal span (its unclamped
  // body edges), NOT `rect` — the lane painter clamps `rect` to the visible
  // surface, and anchoring the curve there pinned the fade to a fixed screen
  // x so it stayed put while the clip scrolled under it (the same class of bug
  // the waveform once had). The envelope is drawn inside the bar's clip
  // region, so a span edge scrolled off-screen is harmless — it's clipped.
  const w = Math.min(Math.max(0, widthPx), spanWidth)
  if (w <= 0) return
  const top = rect.y
  const bottom = rect.y + rect.height
  const silentX = edge === 'in' ? spanX : spanX + spanWidth
  const fullX = edge === 'in' ? spanX + w : spanX + spanWidth - w

  // Full-height tint across the whole fade-width band, both sides of the
  // curve — a plain rect, not a curve-bounded wedge, so `bandX` is just
  // whichever of the two x's is smaller regardless of edge direction.
  ctx.fillStyle = palette.colors.fadeEnvelopeDim
  ctx.fillRect(Math.min(silentX, fullX), top, w, bottom - top)

  // `p` runs 0 (silentX, bottom — silent) → 1 (fullX, top — full volume), the
  // same convention `fadeGain` itself uses, so the first sample is always
  // exactly the silent corner and the last exactly the full-volume one.
  ctx.beginPath()
  for (let i = 0; i <= FADE_ENVELOPE_SEGMENTS; i++) {
    const p = i / FADE_ENVELOPE_SEGMENTS
    const x = silentX + (fullX - silentX) * p
    const y = bottom - fadeGain(p, curve) * (bottom - top)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = palette.colors.fadeEnvelopeLine
  ctx.lineWidth = 1.5
  ctx.stroke()
}

/**
 * The small fade-grip triangle at one top corner of an audio bar — sitting
 * at the fade's inner edge when a fade is already set (drag it further in
 * or back out to the corner to adjust or remove the fade), or at the bar's
 * own corner when there is none yet (drag inward from there to create one).
 *
 * Drawn on EVERY bar, unlike the trim handles (`drawTrimHandle`), which are
 * selected-only: a fade grip has to be discoverable without selecting the
 * bar first, or it may as well not exist. `active` (hover, or the bar being
 * selected) brightens it — the same "clearer when it matters" language the
 * trim handles use, just without gating existence on selection too.
 */
function drawFadeGrip(
  ctx: DrawContext,
  x: number,
  top: number,
  active: boolean,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const half = FADE_GRIP_SIZE_PX / 2
  ctx.beginPath()
  ctx.moveTo(x - half, top)
  ctx.lineTo(x + half, top)
  ctx.lineTo(x, top + FADE_GRIP_SIZE_PX)
  ctx.closePath()
  ctx.fillStyle = active ? palette.colors.fadeGripActive : palette.colors.fadeGripSubtle
  ctx.fill()
}

/**
 * One keyframe-strip diamond, centred at `(x, y)`.
 *
 * Unlike `drawFadeGrip` (drawn on every audio bar, selected or not — see its
 * own doc for why), a diamond is drawn ONLY for the selected, keyframed
 * overlay item: `drawTimelineContent`'s loop gates the whole strip on that,
 * not this function. A keyframe is per-property editing state, not a
 * persistent property of the clip the way a fade is, so showing it on every
 * overlay would be noise rather than an affordance (plan decision 1) — and
 * because the gate already limits diamonds to a selected item, there is no
 * separate "active/subtle" distinction to draw here the way the fade grip
 * needs for discoverability.
 *
 * `selected` is a DIFFERENT axis from that gate: which one diamond, among
 * however many the strip draws, is the host's `selectedKeyframe`. It swaps
 * the fill to `keyframeDiamondSelectedFill` and thickens the stroke, the
 * same "outline thickens" language `drawItemHandles` uses for a selected
 * clip's border.
 */
function drawKeyframeDiamond(
  ctx: DrawContext,
  x: number,
  y: number,
  selected = false,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const half = KEYFRAME_DIAMOND_SIZE_PX / 2
  ctx.beginPath()
  ctx.moveTo(x, y - half)
  ctx.lineTo(x + half, y)
  ctx.lineTo(x, y + half)
  ctx.lineTo(x - half, y)
  ctx.closePath()
  ctx.fillStyle = selected ? palette.colors.keyframeDiamondSelectedFill : palette.colors.keyframeDiamondFill
  ctx.fill()
  ctx.strokeStyle = palette.colors.keyframeDiamondStroke
  ctx.lineWidth = selected ? 2 : 1
  ctx.stroke()
}

/**
 * The keyframe strip for one selected, keyframed overlay item: one diamond
 * per DISTINCT keyframe time across ALL of its tracks (`keyframeUnionTimes` —
 * plan decision 2's "union of times", not one row per property), positioned
 * along the BOTTOM of the clip's drawn body.
 *
 * Each diamond's x comes from `keyframeDiamondX`, which converts through the
 * SAME `timeToX` every other draw call on this surface uses — so unlike the
 * fade envelope (which has to be handed the clip's true, unclamped span to
 * survive horizontal scroll, see `drawFadeEnvelope`'s own note) a diamond
 * needs no such plumbing: its position is already absolute screen space.
 * What it DOES need is the clip to `body` (decision 3: never draw outside
 * the clip), which is why the whole strip is wrapped in one clip region
 * rather than each diamond clamping itself.
 *
 * The clip region is widened past `body`'s own edges, NOT set to `body`
 * verbatim. `body` is already inset from the clip's TRUE time span by
 * `CLIP_GUTTER_PX` (`clipBodyRect`), but a diamond's x is NOT computed from
 * `body` — `keyframeDiamondX` runs `item.start + t` through the same
 * `timeToX` the row loop used to get the clip's true, un-inset `rect` in the
 * first place. So an ENDPOINT diamond (t=0 or t=duration) is centred exactly
 * at `rect.x` / `rect.x + rect.width` — which is `CLIP_GUTTER_PX` further out
 * than `body`'s corresponding edge — and widening the clip by only half a
 * diamond from `body` (as it might look natural to do) still falls
 * `CLIP_GUTTER_PX` short of that centre, leaving a slimmer but still-real
 * sliver. The margin below is `half a diamond` **+ `CLIP_GUTTER_PX`**, which
 * puts the widened region's edge exactly back at `rect`'s true edge before
 * adding the half-diamond room a full diamond needs — so the endpoint diamond
 * survives WHOLE, not just mostly. That is not a corner case: `enableKeyframing`
 * seeds a keyframe at t=0 when the playhead sits at the item's own start, and
 * `applyKeyframeMove` lists 0 and duration as STRONG snap targets, so drags
 * are actively steered onto them. The extra margin never exposes anything
 * outside the clip's true span — a diamond's `t` is already clamped to
 * `[0, duration]` by every writer in `keyframeOps.ts` and, symmetrically, by
 * `hit-test.ts`'s `keyframeStripZone` filter — so "decision 3: never draw
 * outside the clip" still holds; only the definition of "the clip" grew back
 * out to `rect` (plus the diamond's own half-width) to match what decision 3
 * was actually protecting.
 *
 * `selectedT`, when given, is compared against each diamond's own `t` — not
 * carried as a separate "which index" — so the ONE diamond it names (if any
 * is currently on the strip at all) is the one `drawKeyframeDiamond` paints
 * `selected`. Absent or `null` means no diamond on this strip is selected,
 * the ordinary case for every item except the one holding the host's
 * `selectedKeyframe`.
 */
export function drawKeyframeStrip(
  ctx: DrawContext,
  item: VisualItem,
  body: Rect,
  viewport: Viewport,
  selectedT?: number | null,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const times = keyframeUnionTimes(item)
  if (times.length === 0 || body.width <= 0) return

  const y = body.y + body.height - KEYFRAME_DIAMOND_SIZE_PX / 2 - KEYFRAME_STRIP_BOTTOM_PAD_PX
  const margin = KEYFRAME_DIAMOND_SIZE_PX / 2 + CLIP_GUTTER_PX
  ctx.save()
  ctx.beginPath()
  ctx.rect(body.x - margin, body.y, body.width + margin * 2, body.height)
  ctx.clip()
  for (const t of times) {
    drawKeyframeDiamond(ctx, keyframeDiamondX(item, t, viewport), y, t === selectedT, palette)
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
  /** The clip's TRUE (unclamped) body span in surface x — left edge and
   *  width. The fade envelope and grips anchor to THIS, not `rect`, which the
   *  lane painter clamps to the visible surface; without it a fade stays
   *  pinned to the viewport edge instead of scrolling with its clip. Default
   *  to `rect.x`/`rect.width` when absent (an on-screen, unscrolled clip). */
  fadeSpanX?: number
  fadeSpanWidth?: number
  /** Envelope shape for each fade — see `fade-curve.ts`. Default
   *  `DEFAULT_FADE_CURVE` ('exp'), the shape every fade had before curves
   *  existed, so a bar whose track carries no explicit choice looks
   *  unchanged. */
  fadeInCurve?: FadeCurve
  fadeOutCurve?: FadeCurve
  /** Content layer drawn inside the bar's clip region, beneath the fades and
   *  label — the T6 audio-lane waveform hooks in here (mirrors the DOM
   *  path's `AudioWaveformLayer`, which also paints behind the type label). */
  drawContent?: (ctx: DrawContext, rect: Rect) => void
  /** Which fade grip (if any) the pointer is resting on — brightens that one
   *  grip the same way `hoveredEdge` brightens a trim handle. Absent/null
   *  when nothing is hovered, which is also what a host that never wires up
   *  hover detection gets: the grip still renders (just always at its
   *  subtle-or-selected style), so the feature is fully usable without this
   *  field ever being set. */
  hoveredFadeSide?: 'in' | 'out' | null
}

export function drawAudioItem(
  ctx: DrawContext,
  args: AudioItemDrawArgs,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const { rect, selected, muted, label, fadeInPx = 0, fadeOutPx = 0, drawContent, hoveredFadeSide } = args
  const fadeInCurve = args.fadeInCurve ?? DEFAULT_FADE_CURVE
  const fadeOutCurve = args.fadeOutCurve ?? DEFAULT_FADE_CURVE
  // Fades anchor to the clip's true span (scrolls with the clip); fall back to
  // the drawn rect for callers/tests that don't supply it (on-screen clip).
  const fadeSpanX = args.fadeSpanX ?? rect.x
  const fadeSpanWidth = args.fadeSpanWidth ?? rect.width
  const handleWidth = selected ? Math.min(AUDIO_HANDLE_WIDTH_PX, rect.width / 2) : 0
  if (rect.width <= 0) return
  ctx.save()

  ctx.fillStyle = muted ? palette.colors.audioMutedFill : palette.colors.audioFill
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, AUDIO_ITEM_RADIUS_PX)
  ctx.fill()
  if (!muted) {
    ctx.strokeStyle = palette.colors.audioBorder
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

  if (fadeInPx > 0) drawFadeEnvelope(ctx, rect, 'in', fadeInPx, fadeSpanX, fadeSpanWidth, fadeInCurve, palette)
  if (fadeOutPx > 0) drawFadeEnvelope(ctx, rect, 'out', fadeOutPx, fadeSpanX, fadeSpanWidth, fadeOutCurve, palette)

  if (rect.width >= MIN_LABEL_WIDTH_PX) {
    ctx.fillStyle = palette.colors.audioText
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'middle'
    ctx.fillText(label, rect.x + LABEL_PAD_PX + handleWidth, rect.y + rect.height / 2)
  }
  ctx.restore()

  if (selected) {
    ctx.strokeStyle = palette.colors.audioRing
    ctx.lineWidth = 1
    roundRectPath(ctx, rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1), AUDIO_ITEM_RADIUS_PX)
    ctx.stroke()
    // Handles come later, in the lane painter's own pass — crossfaded bars
    // overlap by design, so burying them here would be the normal case rather
    // than the exception.
  }

  // Fade grips: on EVERY bar (not gated on `selected`, unlike the trim
  // handles above) — see `drawFadeGrip`'s own doc for why. Skipped only
  // when the bar is too narrow for the two grips to avoid sitting on top of
  // each other.
  if (fadeSpanWidth >= FADE_GRIP_SIZE_PX * 2) {
    const inX = fadeSpanX + Math.min(fadeInPx, fadeSpanWidth)
    const outX = fadeSpanX + fadeSpanWidth - Math.min(fadeOutPx, fadeSpanWidth)
    drawFadeGrip(ctx, inX, rect.y, selected || hoveredFadeSide === 'in', palette)
    drawFadeGrip(ctx, outX, rect.y, selected || hoveredFadeSide === 'out', palette)
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
export function drawCaptionBlock(
  ctx: DrawContext,
  args: CaptionBlockDrawArgs,
  timeline: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const { rect, selected, label } = args
  if (rect.width <= 0) return

  // The block's own hue; the surrounding `timeline` palette carries nothing
  // else this painter needs (a caption takes its OWN ring on selection rather
  // than the global white/near-black clip outline — see the doc above).
  const palette = timeline.caption
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
export function drawOverlapBand(
  ctx: DrawContext,
  rect: Rect,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  if (rect.width <= 0 || rect.height <= 0) return

  ctx.save()
  // Clip first: the diagonals run past the band's corners by design, and the
  // clip is what turns them into a contained patch of hatching.
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()

  ctx.fillStyle = palette.colors.overlapFill
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

  // Leaning the same way as a fade: bottom-left to top-right. Start far enough
  // left that the first line still crosses the band's bottom-left corner.
  ctx.beginPath()
  for (let offset = 0; offset <= rect.width + rect.height; offset += OVERLAP_HATCH_SPACING_PX) {
    ctx.moveTo(rect.x + offset, rect.y + rect.height)
    ctx.lineTo(rect.x + offset - rect.height, rect.y)
  }
  // One path, stroked twice: a wide dark pass, then the amber inside it.
  ctx.strokeStyle = palette.colors.overlapHatchShadow
  ctx.lineWidth = OVERLAP_HATCH_SHADOW_WIDTH_PX
  ctx.stroke()
  ctx.strokeStyle = palette.colors.overlapHatch
  ctx.lineWidth = OVERLAP_HATCH_WIDTH_PX
  ctx.stroke()
  ctx.restore()

  // Edges last and unclipped: they are what says exactly where the overlap
  // starts and stops, which is the number an editor is actually trying to read
  // off the screen. Kept thin and translucent so the band never reads as the
  // white outline that means "selected".
  const edge = Math.min(OVERLAP_EDGE_WIDTH_PX, rect.width / 2)
  ctx.fillStyle = palette.colors.overlapEdge
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

export function drawPlayhead(
  ctx: DrawContext,
  x: number,
  top: number,
  bottom: number,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  ctx.fillStyle = palette.colors.playhead
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
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  ctx.save()

  if (strength === 'weak') {
    ctx.fillStyle = palette.colors.snapGuideWeak
    ctx.fillRect(x - SNAP_GUIDE_WEAK_WIDTH_PX / 2, top, SNAP_GUIDE_WEAK_WIDTH_PX, bottom - top)
    ctx.restore()
    return
  }

  ctx.fillStyle = palette.colors.snapGuide
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
export function drawCursorLine(
  ctx: DrawContext,
  x: number,
  top: number,
  bottom: number,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  ctx.fillStyle = palette.colors.cursor
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
  /** The selected keyframe diamond, if any (`pointer-machine.ts`'s
   *  `KeyframeSelection`, structurally — this module doesn't import that
   *  type, since `pointer-machine.ts` imports THIS module already, and the
   *  reverse would be circular). `itemId`'s strip, if it draws a diamond at
   *  `t` at all, paints that one `selected`; every other diamond on every
   *  other strip paints ordinary. Mirrors `hoveredHandle`'s own inline shape
   *  for the same reason. */
  selectedKeyframe?: { itemId: string; t: number } | null
  surfaceWidth: number
  surfaceHeight: number
  /** T6 waveform content-layer provider. Absent → no waveforms drawn, which
   *  is what a host without a `getWaveformPeaks` adapter method gets. */
  waveforms?: WaveformSceneLookup
  /** T7 filmstrip content-layer provider (the background tile strip inside a
   *  clip rect). Absent → no filmstrips drawn, same graceful omission as
   *  `waveforms`. */
  filmstrips?: FilmstripSceneLookup
  /** Which ground to paint on, resolved from the host theme by `VideoEditor`.
   *  Absent → `'dark'`, so every caller that predates light mode — and every
   *  existing test — paints byte-identical pixels. */
  mode?: TimelineMode
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
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  ctx.save()
  ctx.fillStyle = palette.colors.rulerBackground
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
    ctx.fillStyle = isMajor ? palette.colors.rulerTick : palette.colors.rulerTickMinor
    ctx.fillRect(x, bottom - tickHeight, 1, tickHeight)

    if (isMajor) {
      ctx.fillStyle = palette.colors.rulerText
      ctx.fillText(formatRulerTime(t, step), x + 3, rect.y + RULER_LABEL_BASELINE_PX)
    }
  }
  ctx.restore()
}

// ── Pending-drop ghost ───────────────────────────────────────────────────

/** Corner radius of a ghost band. The same 4px a clip uses — the band stands
 *  where a clip is about to be, so it should be the same shape. */
export const PENDING_DROP_RADIUS_PX = CLIP_RADIUS_PX
/** Inset from the row's own rectangle, top and bottom, so the ghost reads as
 *  sitting IN the row rather than replacing it. */
export const PENDING_DROP_INSET_PX = 2
/** Stroke width of the dashed outline. 1.5px, not 1: a dash is half gaps, so
 *  at 1px the outline reads as a faint dotted smudge rather than a border. */
export const PENDING_DROP_BORDER_PX = 1.5
/** Dash pattern — 6 on, 4 off. Long enough that each dash is unmistakably a
 *  dash (not a dot), short enough that a narrow band still shows several. */
export const PENDING_DROP_DASH: readonly number[] = [6, 4]

/** One in-flight import's ghost band. `start`/`end` are TIMELINE SECONDS (the
 *  painter converts them through the viewport, so a ghost pans and zooms with
 *  everything else without the host resending it); `y`/`height` are surface
 *  CSS pixels, resolved by the caller from the row rectangle in
 *  `TimelineLayout.rows` — the same "read the layout, never re-derive geometry"
 *  rule the hit-test states. `label` is the filename, drawn inside. */
export interface PendingDropBand {
  start: number
  end: number
  y: number
  height: number
  label?: string
}

/**
 * The ghost band for a file whose import is still in flight: a translucent
 * rounded rect with a DASHED outline, at the place the file was dropped.
 *
 * Dashed is the whole point. A solid band at clip opacity would read as a clip
 * that is already there, and the one thing this mark has to say is "this is
 * not real yet" — the outline is what says it, which is why it is dashed
 * rather than merely faint (a faint solid band just reads as a dimmed clip,
 * which on this surface already means a disabled track).
 *
 * `setLineDash` is scoped to this painter's own save/restore AND explicitly
 * reset before it returns. A real 2D context restores the dash with the rest
 * of its drawing state, but the stub contexts the tests drive do not, and a
 * leaked dash on the overlay layer means a dashed playhead — the single
 * easiest bug to ship here, so it is closed twice.
 */
export function drawPendingDropBand(
  ctx: DrawContext,
  band: PendingDropBand,
  viewport: Viewport,
  surfaceWidth: number,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  const x = timeToX(band.start, viewport)
  const width = Math.max(0, (band.end - band.start) * viewport.pxPerSecond)
  const rect = clampRectToSurface({ x, y: band.y + PENDING_DROP_INSET_PX, width, height: Math.max(0, band.height - PENDING_DROP_INSET_PX * 2) }, surfaceWidth)
  if (rect.width <= 0 || rect.height <= 0) return

  const radius = Math.min(PENDING_DROP_RADIUS_PX, rect.width / 2, rect.height / 2)

  ctx.save()
  ctx.fillStyle = palette.colors.pendingDropFill
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, radius)
  ctx.fill()

  // Inset by half the stroke so the dashes sit fully inside the band instead
  // of straddling its edge — same reason the marquee offsets by half a pixel.
  const inset = PENDING_DROP_BORDER_PX / 2
  ctx.strokeStyle = palette.colors.pendingDropStroke
  ctx.lineWidth = PENDING_DROP_BORDER_PX
  ctx.setLineDash(PENDING_DROP_DASH as number[])
  roundRectPath(
    ctx,
    rect.x + inset,
    rect.y + inset,
    Math.max(0, rect.width - PENDING_DROP_BORDER_PX),
    Math.max(0, rect.height - PENDING_DROP_BORDER_PX),
    radius,
  )
  ctx.stroke()
  ctx.setLineDash([])

  // The filename, clipped to the band: an import is usually named after a
  // camera file, and those are long — without the clip a name would bleed out
  // over the clips either side of the ghost. Same MIN_LABEL_WIDTH_PX floor the
  // clip labels use, below which a label is more smear than information.
  if (band.label && rect.width >= MIN_LABEL_WIDTH_PX) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.fillStyle = palette.colors.pendingDropText
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'middle'
    ctx.fillText(band.label, rect.x + LABEL_PAD_PX, rect.y + LABEL_TOP_OFFSET_PX)
    ctx.restore()
  }

  ctx.restore()
}

/** The rubber-band selection box. Drawn on the overlay layer because it changes
 *  on every pointer move, exactly like the playhead. */
export function drawMarquee(
  ctx: DrawContext,
  rect: Rect,
  palette: TimelinePalette = DARK_TIMELINE_PALETTE,
): void {
  ctx.save()
  ctx.fillStyle = palette.colors.marqueeFill
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  ctx.strokeStyle = palette.colors.marqueeBorder
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
  const { viewport, layout, selectedIds, selectedKeyframe, surfaceWidth, surfaceHeight, hoveredHandle } = scene
  // Resolved ONCE for the whole pass, not per row or per clip: this is read by
  // every painter below and a per-item lookup would repeat it hundreds of
  // times a frame for an answer that cannot change mid-pass.
  const themePalette = timelinePalette(scene.mode ?? 'dark')
  const range = visibleRange(viewport)
  const stats: DrawStats = { visualItemsDrawn: 0, audioItemsDrawn: 0, itemsCulled: 0, captionItemsDrawn: 0 }

  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)

  drawRuler(ctx, viewport, layout.ruler, surfaceWidth, themePalette)


  let rowShadeIdx = 0
  for (const row of layout.rows) {
    drawRowBackground(ctx, { x: 0, y: row.y, width: surfaceWidth, height: row.height }, rowShadeIdx++ % 2 === 0 ? themePalette.colors.rowBackground : themePalette.colors.rowBackgroundAlt, themePalette)

    // A SKIPPED track is drawn faded: it still draws, and stays selectable and
    // editable; only playback and export leave it out.
    const dimmed = row.disabled === true
    const palette = themePalette.tracks[row.trackIdx % themePalette.tracks.length]
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
            if (clipWaveform) drawClipWaveform(c, r, clipWaveform, itemMuted, themePalette.waveform)
          }
        : undefined
      const itemSelected = selectedIds.includes(item.id)
      drawClipRect(ctx, {
        rect,
        palette,
        selected: itemSelected,
        label: visualItemLabel(item),
        dimmed,
        drawContent,
      }, themePalette)
      // The keyframe strip (SP9b T3.3): selected, keyframed overlays only —
      // see `drawKeyframeStrip`'s own doc for why this is gated here rather
      // than inside it. Drawn AFTER the clip's own content/label so a
      // diamond never sits under a filmstrip frame.
      if (itemSelected && canKeyframe(item) && isKeyframed(item)) {
        drawKeyframeStrip(ctx, item, body, viewport, selectedKeyframe?.itemId === item.id ? selectedKeyframe.t : null, themePalette)
      }
      if (itemSelected) {
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
      ), themePalette)
    }

    // Handles last of all, over the clips AND over any overlap band. They are
    // the control, so nothing gets to sit on top of them: a selected clip
    // whose end is buried under an overlapping neighbour still shows the edge
    // you can grab, which is what the hit-test now hands you there.
    for (const { body, hoveredEdge } of handleRects) {
      drawItemHandles(ctx, body, CLIP_HANDLE_WIDTH_PX, hoveredEdge, Math.min(CLIP_RADIUS_PX, body.width / 2, body.height / 2), themePalette)
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
    drawRowBackground(ctx, { x: 0, y: caption.y, width: surfaceWidth, height: caption.height }, undefined, themePalette)
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
      drawCaptionBlock(ctx, { rect, selected, label: seg.text }, themePalette)
      if (selected && segId !== null) {
        const hoveredEdge = hoveredHandle?.itemId === segId ? hoveredHandle.edge : null
        handleRects.push({ rect, hoveredEdge })
      }
      stats.captionItemsDrawn++
    }

    // Handles last, over every block in the band — same "the control always
    // wins the stacking order" rule the visual rows and audio lanes follow.
    for (const { rect, hoveredEdge } of handleRects) {
      drawItemHandles(ctx, rect, AUDIO_HANDLE_WIDTH_PX, hoveredEdge, AUDIO_ITEM_RADIUS_PX, themePalette)
    }
  }

  for (const lane of layout.lanes) {
    drawRowBackground(ctx, { x: 0, y: lane.y, width: surfaceWidth, height: lane.height }, undefined, themePalette)
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
      // Horizontal gutter, same as a video clip's `clipBodyRect` — two
      // touching audio bars therefore show the same uniform CLIP_GUTTER_PX
      // gap video clips do, rather than a seam that depends on where exactly
      // the bars' edges land.
      const body = clipBodyRect(rect)
      // The clip's TRUE body span, before surface-clamping, so the fade
      // envelope/grips anchor to the clip and scroll with it (see
      // `fadeSpanX`/`fadeSpanWidth`). `rect`/`body` above are already clamped
      // to the visible surface for the bar fill and waveform.
      const fullBody = clipBodyRect({ x, y: body.y, width: (track.end - track.start) * viewport.pxPerSecond, height: body.height })
      const audioWaveform = scene.waveforms?.audioColumns(track, body) ?? null
      const fadeInPx = (track.fadeIn ?? 0) * viewport.pxPerSecond
      const fadeOutPx = (track.fadeOut ?? 0) * viewport.pxPerSecond
      const fadeInCurve = track.fadeInCurve ?? DEFAULT_FADE_CURVE
      const fadeOutCurve = track.fadeOutCurve ?? DEFAULT_FADE_CURVE
      // One gain-at-x lookup per bar, built against its TRUE span (mirrors
      // fadeSpanX/fadeSpanWidth below) so the waveform's amplitude scaling
      // agrees with the envelope drawn over it — same anchor, same curves.
      const gainAt = makeFadeGainAt(fullBody.x, fullBody.width, fadeInPx, fadeOutPx, fadeInCurve, fadeOutCurve)
      drawAudioItem(ctx, {
        rect: body,
        selected: selectedIds.includes(track.id),
        muted: !!track.muted,
        label: audioLabel(track),
        fadeInPx,
        fadeOutPx,
        fadeInCurve,
        fadeOutCurve,
        fadeSpanX: fullBody.x,
        fadeSpanWidth: fullBody.width,
        drawContent: audioWaveform ? (c) => drawAudioLaneWaveform(c, audioWaveform.rect, audioWaveform.columns, gainAt, themePalette.waveform) : undefined,
      }, themePalette)
      if (selectedIds.includes(track.id)) {
        laneHandleRects.push({ rect: body, hoveredEdge: hoveredHandle?.itemId === track.id ? hoveredHandle.edge : null })
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
      ), themePalette)
    }

    // As the visual rows: last, over everything. Crossfaded bars overlap by
    // design, so on a lane this is the normal case rather than the exception.
    for (const { rect, hoveredEdge } of laneHandleRects) {
      drawItemHandles(ctx, rect, AUDIO_HANDLE_WIDTH_PX, hoveredEdge, AUDIO_ITEM_RADIUS_PX, themePalette)
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
  /** Ghost bands for files the host is still importing (`PendingDrop` in
   *  types.ts, resolved to rectangles by the canvas). On the OVERLAY layer,
   *  not the content one, for the same reason the marquee is: they come and go
   *  on host events unrelated to any project edit, and a ghost must be able to
   *  appear and be retracted without repainting every clip and filmstrip
   *  underneath it. Absent or empty → nothing is drawn, and this layer's paint
   *  is byte-identical to what it was before ghosts existed. */
  pendingDrops?: readonly PendingDropBand[]
  /** Which ground to paint on — see `TimelineScene.mode`. Carried on BOTH
   *  scenes rather than only the content one: the playhead, the axis cursor
   *  and the marquee all live on this layer, and a mode change has to be able
   *  to repaint them without waiting for a content edit. */
  mode?: TimelineMode
}

/** Paint the playhead layer. Kept separate from the content so playback — which
 *  moves the playhead ~60 times a second — repaints two `fillRect`s, not the
 *  whole timeline. The preview-axis cursor rides here for the same reason:
 *  tracking the pointer must not force a content repaint. */
export function drawTimelineOverlay(ctx: DrawContext, scene: OverlayScene): void {
  const { viewport, currentTime, surfaceWidth, surfaceHeight, cursorTime, snapTime, snapStrength } = scene
  // Once per pass, same rule as `drawTimelineContent` — this layer repaints at
  // ~60Hz during playback, so it is the one that least wants a lookup per mark.
  const themePalette = timelinePalette(scene.mode ?? 'dark')
  ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)
  // First, so the playhead and any guide stay legible over it — the marquee is
  // a translucent wash and would otherwise dull both.
  if (scene.marquee) drawMarquee(ctx, scene.marquee, themePalette)
  // After the marquee (a ghost is a solid-ish band; under the wash it would be
  // dulled the same way the lines are), and before every LINE below it. The
  // playhead in particular has to stay legible over a ghost: an import that
  // happens to land under the playhead must not hide where playback is, and a
  // band is far wider than any of these marks, so it can only ever go beneath
  // them. Each band culls itself the way the playhead and cursor do — the
  // painter converts to x and returns on a rect that clamps away to nothing.
  if (scene.pendingDrops) {
    for (const band of scene.pendingDrops) {
      drawPendingDropBand(ctx, band, viewport, surfaceWidth, themePalette)
    }
  }
  if (cursorTime !== undefined && cursorTime !== null) {
    const cx = timeToX(cursorTime, viewport)
    if (!(cx < -CURSOR_WIDTH_PX || cx > surfaceWidth + CURSOR_WIDTH_PX)) {
      drawCursorLine(ctx, cx, 0, surfaceHeight, themePalette)
    }
  }
  const x = timeToX(currentTime, viewport)
  if (!(x < -PLAYHEAD_WIDTH_PX || x > surfaceWidth + PLAYHEAD_WIDTH_PX)) {
    drawPlayhead(ctx, x, 0, surfaceHeight, themePalette)
  }
  // Last, so it wins over both lines. A gesture snapped to the playhead should
  // look snapped, not hidden behind the thing it snapped to.
  if (snapTime !== undefined && snapTime !== null) {
    const sx = timeToX(snapTime, viewport)
    if (!(sx < -SNAP_GUIDE_CAP_HALF_WIDTH_PX || sx > surfaceWidth + SNAP_GUIDE_CAP_HALF_WIDTH_PX)) {
      drawSnapGuide(ctx, sx, 0, surfaceHeight, snapStrength ?? 'strong', themePalette)
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
