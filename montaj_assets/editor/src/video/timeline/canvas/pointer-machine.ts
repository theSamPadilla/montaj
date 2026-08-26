/**
 * Canvas timeline gesture machine (SP5 T5) — every pointer gesture the timeline
 * supports, as a pure reducer.
 *
 * ── Why a machine, and why pure ──────────────────────────────────────────
 * The DOM timeline spread its gestures across four components and two hooks,
 * each attaching its own `document` mousemove/mouseup pair and each holding a
 * little private state (`dragStarted`, `lastUpdated`, `snappedTo`). That works
 * when the browser addresses every event for you. On one canvas surface there
 * is a single pointer stream and no elements, so the state has to be explicit —
 * and once it is explicit it may as well be testable.
 *
 * So: no DOM in this file. Points arrive already in surface-space CSS pixels,
 * everything the machine needs to decide comes in as `PointerContext`, and
 * everything it wants to happen goes out as `PointerEffect[]` for the component
 * to perform. `pointerReducer` is a pure function of (state, event) — every
 * transition below is a unit test, not a browser session.
 *
 * ── Parity ───────────────────────────────────────────────────────────────
 * The DOM rows are the spec, and the behaviours worth naming because they are
 * NOT guessable are:
 *
 * - **Selection happens on release, not on press.** The DOM selected in a
 *   `click` handler, which fires after mouseup and was suppressed whenever the
 *   press had turned into a drag. Same here: a press that stays under the drag
 *   threshold selects, one that crosses it does not.
 * - **A plain click on an unselected clip also seeks** to the clicked time,
 *   unsnapped; an additive click, or a click on an already-selected clip, does
 *   not (VisualTrackRow.tsx's `if (!additive && !isSel)`). Audio bars never
 *   seek on click — AudioTrackRow has no such line. A caption seeks too, but
 *   to its own start plus half a frame rather than to the clicked time; the
 *   reasoning is at the seek itself, in `pointerUp`.
 * - **Additive means shift OR meta OR ctrl**, and the resulting selection is
 *   computed by `toggleSelection`, which the host still owns: the machine emits
 *   `{type:'select', id, additive}` so Timeline's existing `handleSelectItem`
 *   applies it, including clearing the caption selection. The item↔caption
 *   mutual exclusivity therefore cannot drift.
 * - **Per-move `onProjectChange`, commit-time `onOverlayEdit`** — the callback
 *   split every DOM row uses. Emitted here as `projectChange` and `commit`.
 * - **Ripple mode collapses gaps on every trim move**, exactly where
 *   VisualTrackRow does it (after the multi-selection delta, before the
 *   callback), and nowhere else: moves and audio edits never collapse.
 * - **Trims recompute from the project as it was when the press began**;
 *   moves accumulate from the last emitted project (the DOM's `lastUpdated`),
 *   because the cross-track search needs to see the tracks it has been pruning.
 *
 * ── The four trim-op bindings (plan decision 8) ──────────────────────────
 *   plain edge-drag    trim   (ripple-aware, the DOM behaviour)
 *   Alt   + edge-drag  roll   the shared boundary with the adjacent neighbour
 *   Alt   + body-drag  slip   the source window, item stays put
 *   Cmd/Ctrl + body-drag slide the item, neighbours absorb it
 * Modifiers are read at press time, so releasing Alt mid-drag doesn't change
 * what the gesture is. Cmd/Ctrl is also the additive-selection modifier, which
 * doesn't collide: that path only fires for presses that never became drags.
 */

import type { AudioTrack, CaptionSegment, VisualItem } from '../../../schema'
import type { Project } from '../../../types'
import { reflowMagneticLanes } from '../../audioMagnet'
import { laneOf, normalizeCaptionLanes, resolveDropLane, sameLaneNeighbours } from '../../captionLanes'
import { collapseGaps, rollEdit, slideItem, slipItem } from '../../cuts'
import { canKeyframe, enableKeyframing, moveKeyframe, setKeyframe, transformProps, valueAt } from '../../keyframeOps'
import { applyMoveDeltaToSelection, applyResizeDeltaToSelection } from '../multiSelectOps'
import { AUDIO_LANE_HEIGHT_PX, CAPTION_ROW_HEIGHT_PX, computeDerivedTiming, groupAudioLanes, mapTrackItems, moveItemAcrossTracks, normalizeTracks, resolveTargetTrackIdx, trackItems, updateAudioTrack } from '../timeline-model'
import { DRAG_THRESHOLD_PX, computeResizedItem, resizeWindowedItem, type Draggable } from '../useItemDragDrop'
import type { TimelineLayout } from './draw'
import { keyframeUnionTimes } from './keyframe-strip'
import {
  PLAYHEAD_GRAB_PX,
  hitTest,
  isCaptionHit,
  isEdgeHit,
  isEmptyHit,
  itemsInRect,
  normalizeRect,
  type HitResult,
  type HitTestOptions,
  type Point,
  type SurfaceRect,
} from './hit-test'
import {
  DEFAULT_SNAP_CONFIG,
  applySnap,
  createSnapState,
  snapPointsExcluding,
  snapPointsForSpan,
  type SnapConfig,
  type SnapPoint,
  type SnapResult,
  type SnapState,
  type SnapStrength,
} from './snap'
import { timeToX, xToTime, type Viewport } from './viewport'

// ── Inputs ───────────────────────────────────────────────────────────────

export interface Modifiers {
  shift: boolean
  alt: boolean
  meta: boolean
  ctrl: boolean
}

export const NO_MODIFIERS: Modifiers = { shift: false, alt: false, meta: false, ctrl: false }

/** The DOM's additive-selection test, verbatim from both row components. */
export function isAdditive(m: Modifiers): boolean {
  return m.shift || m.meta || m.ctrl
}

/** Everything the machine needs to know about the world, injected per event so
 *  the machine never holds a stale project or viewport of its own. */
export interface PointerContext {
  project: Project
  layout: TimelineLayout
  viewport: Viewport
  selectedIds: readonly string[]
  /** Clip/audio boundaries — `computeDerivedTiming(project).snapBoundaries`. */
  snapBoundaries: readonly number[]
  /** Content duration plus the timeline's drag headroom. */
  totalDuration: number
  rippleMode: boolean
  /** Where the playhead is, so item gestures can snap to it. */
  playheadTime: number
  /** The project's frame rate. Needed for exactly one thing: a click on a
   *  caption seeks half a frame INTO the segment rather than to its start —
   *  see the seek in `pointerUp`. No gesture's arithmetic uses it. */
  fps: number
  snapConfig?: SnapConfig
  hitTestOptions?: HitTestOptions
  /** The host's current keyframe selection, or null/undefined for none. Read
   *  ONLY by `pointerUp`'s `keyframe-move` branch, to decide whether a
   *  diamond retime should carry the selection to its new `t` — the machine
   *  is otherwise stateless about selection (see `KeyframeSelection`), this
   *  is the one gesture where "was the thing I just dragged the selected
   *  one?" has to be answered mid-commit rather than left to the host. */
  selectedKeyframe?: KeyframeSelection | null
}

export type PointerMachineEvent =
  | { type: 'pointerDown'; point: Point; modifiers: Modifiers; ctx: PointerContext }
  | { type: 'pointerMove'; point: Point; modifiers: Modifiers; ctx: PointerContext }
  | { type: 'pointerUp'; point: Point; modifiers: Modifiers; ctx: PointerContext }
  | { type: 'doubleClick'; point: Point; modifiers: Modifiers; ctx: PointerContext }
  /** Pointer lost (leave, blur, unmount). Drops the gesture WITHOUT committing;
   *  whatever the last `projectChange` emitted stands, exactly as it would if
   *  the DOM path's mouseup listener never fired. */
  | { type: 'cancel' }

// ── Outputs ──────────────────────────────────────────────────────────────

export type Cursor = 'default' | 'pointer' | 'grab' | 'grabbing' | 'ew-resize' | 'nwse-resize' | 'nesw-resize' | 'crosshair'

export type PointerEffect =
  /** `clock.set` — move the playhead. */
  | { type: 'seek'; time: number }
  /** Timeline's `handleSelectItem(id, additive)`. */
  | { type: 'select'; id: string | null; additive: boolean }
  /** `onProjectChange` — a live, uncommitted edit. Fires once per move. */
  | { type: 'projectChange'; project: Project }
  /** `onOverlayEdit` — the gesture is finished, persist it. */
  | { type: 'commit'; project: Project }
  /** Double-click on a clip or audio bar — `onInspectClip` / `onInspectAudio`. */
  | { type: 'inspect'; target: 'visual' | 'audio'; id: string }
  /** Double-click on a caption block. Deliberately NOT `inspect`: a caption has
   *  no inspector dialog — this routes to focusing its row in the transcript
   *  sidebar, which is where caption text is edited now that the inline
   *  contentEditable row is gone. */
  | { type: 'editCaption'; id: string }
  /** The surface's CSS cursor. Emitted only when it changes. */
  | { type: 'cursor'; cursor: Cursor }
  /** Where to draw the snap guide and how hard it is holding, or nulls to take
   *  it down. Emitted only when it CHANGES — a drag held against one boundary
   *  emits once on capture and once on release, not sixty times a second. */
  | { type: 'snapGuide'; time: number | null; strength: SnapStrength | null }
  /** The rubber-band box to paint, or null to take it down. */
  | { type: 'marquee'; rect: SurfaceRect | null }
  /** What a finished marquee caught. Separate from `select` because a marquee
   *  replaces (or extends) the whole selection in one step — replaying it as N
   *  single `select` effects would make the host apply N re-renders and, worse,
   *  would need the first to be non-additive and the rest additive. */
  | { type: 'selectMany'; ids: string[]; additive: boolean }
  /** A keyframe diamond became the selected keyframe. Item-relative `t`,
   *  matching `Keyframe.t`. The host holds this selection; the machine is
   *  stateless about it, exactly as it is about item selection. */
  | { type: 'selectKeyframe'; itemId: string; t: number }

/** The host's record of which diamond is selected. A diamond is a time on an
 *  item — the props at that time are derived when acted on, never stored here. */
export interface KeyframeSelection {
  itemId: string
  /** ITEM-RELATIVE seconds, matching `Keyframe.t` and `HitResult.kfT`. Never
   *  absolute timeline time. */
  t: number
}

// ── State ────────────────────────────────────────────────────────────────

export type GestureKind =
  | 'move'
  | 'trim'
  | 'roll'
  | 'slip'
  | 'slide'
  | 'audio-move'
  | 'audio-trim'
  /** Dragging an audio bar's fade-in or fade-out grip. See `applyAudioFade`. */
  | 'audio-fade'
  /** Dragging a keyframe-strip diamond to retime it. See `applyKeyframeMove`. */
  | 'keyframe-move'
  /** Re-timing a caption block. Rides the clip group-move path, so a mixed
   *  clip+caption selection travels as one body and lands as one undo. */
  | 'caption-move'
  /** Dragging one caption block's in/out edge. Single-segment: multi-caption
   *  trim is out of scope for v1. */
  | 'caption-trim'
  /** Dragging the playhead. Lives on the ruler strip only. */
  | 'scrub'
  /** Dragging a rubber-band box across empty track area to select. */
  | 'marquee'

export interface Press {
  origin: Point
  /** The timeline time under `origin.x` when the press landed.
   *
   *  Every gesture measures its travel from HERE, not from `origin.x`, because
   *  a raw pixel delta is blind to the view moving underneath it: edge
   *  auto-scroll pans the viewport while the pointer is held still, and
   *  `point.x - origin.x` is unchanged by that pan, so the dragged item would
   *  sit at a fixed time while the timeline slid out from under the cursor —
   *  the clip visibly drifting away from the hand holding it. Anchoring in
   *  time makes the same held pointer resolve to a later time on every panned
   *  frame, which is exactly what keeps the item under the cursor. */
  originTime: number
  modifiers: Modifiers
  hit: HitResult
  /** The project as it stood when the press began. Trims and the three
   *  neighbour-aware ops recompute from here on every move, so dragging back and
   *  forth cannot compound. */
  baseProject: Project
  /** Was the pressed item already selected? Drives the DOM's conditional seek
   *  on a plain click. */
  wasSelected: boolean
  /** The project's boundaries as they stood when the press began, already
   *  tiered by `tieredBoundaries` against the row pressed on.
   *
   *  Captured, never read live. The host echoes every `projectChange` back
   *  through Timeline's re-render, and that re-render recomputes the boundary
   *  set from the echoed project — so mid-gesture the live list contains the
   *  dragged item's own CURRENT edges, not just its press-time ones.
   *  `itemSnapPoints` only excludes the press-time pair, so a gesture reading
   *  live boundaries would find its own last position back in the magnet list
   *  and snap to itself. Capturing once, here, is what makes that exclusion
   *  complete.
   *
   *  This is the DEFAULT tiering — the one every gesture except a single-item
   *  visual/audio MOVE uses as-is. Those two re-tier against the row the item
   *  is currently over instead of the row it started on (see `itemSnapPoints`'s
   *  `current` parameter); they do so by re-running `tieredBoundaries` fresh
   *  each move, off `baseProject` below (not off this field), so the id-based
   *  exclusion stays exact and the recompute never reads a live, re-rendered
   *  project either. */
  snapBoundaries: readonly SnapPoint[]
}

export type MachineState =
  | { kind: 'idle'; cursor: Cursor }
  | { kind: 'pressed'; cursor: Cursor; press: Press }
  | {
      kind: 'dragging'
      cursor: Cursor
      press: Press
      gesture: GestureKind
      snap: SnapState
      /** The boundary the guide is currently drawn on, or null. Held here (not
       *  derived from `snap`) because for a span gesture `snap.snappedTo` is a
       *  candidate START, which is not where the guide belongs — see
       *  `spanSnapGuide`. */
      guide: SnapGuide | null
      /** The most recent project this gesture emitted — what a commit persists. */
      lastProject: Project
      /** Latched once the gesture has pulled clear of where it started, and
       *  never cleared. Arms the origin boundary so a butted clip can snap back
       *  onto its neighbour — see `originGuard`. */
      escaped: boolean
      /** `keyframe-move` only: the most recent landed `toT` this gesture has
       *  produced (see `Applied.keyframeLandedT`), carried forward across a
       *  no-op frame rather than clobbered by `undefined`. `pointerUp` reads
       *  this to follow the selection onto the diamond's new time. Undefined
       *  for every gesture but `keyframe-move`. */
      keyframeT?: number
    }

export function initialMachineState(): MachineState {
  return { kind: 'idle', cursor: 'default' }
}

// ── Helpers ──────────────────────────────────────────────────────────────

const EPSILON = 1e-6

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function travelled(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Cursor for a resting pointer over a hit — the DOM rows' affordances:
 *  `cursor-ew-resize` on edge handles, `cursor-grab` on item bodies.
 *
 *  A fade GRIP is a resize too, but of the fade envelope rather than the clip,
 *  and it sits at a top CORNER — so it gets a DIAGONAL resize cursor pointing
 *  along that corner (`nwse-resize` for a top-left fade-in grip, `nesw-resize`
 *  for a top-right fade-out grip). That keeps it distinguishable from an edge
 *  trim's horizontal `ew-resize`: both read as "drag to resize", but you can
 *  tell by the cursor whether you've grabbed the fade or the clip edge.
 *
 *  Empty timeline is the plain arrow, not `pointer`. A hand cursor promises a
 *  thing you can click, and the gaps between clips are not a thing — they are
 *  where you drag out a selection. `pointer` there read as "everything on this
 *  surface is a button", which is the opposite of what a track area is.
 *  The ruler keeps `ew-resize`, because scrubbing IS a horizontal drag. */
export function cursorForHit(hit: HitResult): Cursor {
  switch (hit.kind) {
    case 'audio-fade':
      return hit.side === 'out' ? 'nesw-resize' : 'nwse-resize'
    // A diamond only ever moves horizontally along its own item — the same
    // retime-in-place gesture a trim edge does, so it gets the same cursor.
    case 'keyframe':
      return 'ew-resize'
    case 'item-edge':
    case 'audio-edge':
    case 'caption-edge':
      return 'ew-resize'
    case 'item-body':
    case 'audio-body':
    case 'caption-body':
      return 'grab'
    case 'ruler':
      return 'ew-resize'
    default:
      return 'default'
  }
}

function cursorForGesture(gesture: GestureKind): Cursor {
  switch (gesture) {
    case 'audio-fade':
      return 'nwse-resize'   // the diagonal fade-grip cursor, held through the drag
    case 'trim':
    case 'roll':
    case 'audio-trim':
    case 'caption-trim':
    case 'scrub':
    case 'keyframe-move':
      return 'ew-resize'
    case 'marquee':
      return 'crosshair'
    default:
      return 'grabbing'
  }
}

/** What a press on `hit` with `modifiers` becomes once it crosses the drag
 *  threshold. Null for hits that never start a drag gesture. */
export function resolveGesture(hit: HitResult, modifiers: Modifiers): GestureKind | null {
  switch (hit.kind) {
    case 'item-edge':
      return modifiers.alt ? 'roll' : 'trim'
    case 'item-body':
      if (modifiers.alt) return 'slip'
      return modifiers.meta || modifiers.ctrl ? 'slide' : 'move'
    // Audio has no roll/slip/slide — those ops are visual-track vocabulary in
    // cuts.ts — so modifiers fall through to the plain gesture.
    case 'audio-edge':
      return 'audio-trim'
    case 'audio-body':
      return 'audio-move'
    // No modifiers of its own — a fade grip does exactly one thing.
    case 'audio-fade':
      return 'audio-fade'
    // A keyframe diamond does exactly one thing too — retime.
    case 'keyframe':
      return 'keyframe-move'
    // Captions have no roll/slip/slide either — there is no source window to
    // slip and no neighbour to roll against — so modifiers fall through here
    // exactly as they do for audio.
    case 'caption-edge':
      return 'caption-trim'
    case 'caption-body':
      return 'caption-move'
    // Empty track area drags out a selection box. The ruler is handled on
    // press (it scrubs immediately, so it never reaches this resolution), and
    // is deliberately absent here.
    case 'empty-row':
    case 'empty-lane':
    case 'background':
      return 'marquee'
    default:
      return null
  }
}

/** Snap targets for a gesture that moves an item: clip and audio boundaries
 *  and the playhead — minus whatever the gesture is itself dragging, which
 *  would otherwise pin it to where it started.
 *
 *  Boundaries come from `press.snapBoundaries`, captured once at press time,
 *  NOT `ctx.snapBoundaries`. The host re-derives `ctx.snapBoundaries` from
 *  every echoed `projectChange`, so a live read would put the item's own
 *  moving edges back into the magnet list mid-gesture (see the `Press.
 *  snapBoundaries` doc). The playhead is read from `ctx` because it cannot
 *  change during an item gesture.
 *
 *  `current`, when passed, overrides which row is tiered STRONG: instead of
 *  `press.snapBoundaries` (frozen at the press-time row), this re-runs
 *  `tieredBoundaries` fresh against `press.baseProject` — still a frozen
 *  project, so the id-based exclusion (`press.hit.itemId`) stays exact and
 *  this is no less immune to the self-snap problem above — but tiered
 *  against the row the caller says the item is CURRENTLY over rather than
 *  the row it started on. Only a single-item visual/audio MOVE passes this;
 *  every other gesture stays on the press-time row (see call sites). */
function itemSnapPoints(
  ctx: PointerContext,
  press: Press,
  exclude: readonly number[],
  current?: { trackIdx?: number; laneIdx?: number },
): SnapPoint[] {
  const boundaries = current
    ? tieredBoundaries(press.baseProject, current.trackIdx, current.laneIdx, press.hit.itemId)
    : press.snapBoundaries
  // The playhead is STRONG regardless of tier: it belongs to no track, and
  // parking a cut on it is always a deliberate act rather than an accident of
  // what happens to be on the row above.
  const points: SnapPoint[] = [...boundaries, { time: ctx.playheadTime, strength: 'strong' }]
  return snapPointsExcluding(points, exclude)
}

/**
 * Every boundary in the project, tiered against the row the gesture is working
 * on. Captured once per press for most gestures (see `Press.snapBoundaries`);
 * a single-item visual/audio MOVE instead calls this fresh on every move,
 * with the CURRENT row (see `itemSnapPoints`'s `current` parameter).
 *
 * "Own track" used to mean the row the press LANDED on, held fixed for the
 * whole gesture even once a cross-track move carried the item somewhere else
 * — deliberately, to avoid the magnets under the cursor re-ranking (and the
 * clip appearing to lurch) the instant it crossed a row boundary. That
 * decision is REVERSED for a single-item move: dragging a clip onto another
 * track and getting only the origin track's strong magnets reads as "snapping
 * doesn't work over here", which is worse than the lurch it was avoiding — so
 * for `move`/`audio-move` the strong tier now follows the row the item is
 * CURRENTLY over, and the origin row's magnets fall back to weak the moment
 * the drag has crossed into a new one. Every other gesture (trim, roll, slip,
 * slide, the two audio/caption trims, scrub) never changes row mid-gesture,
 * so this reversal is invisible to them — they still tier once, at press time,
 * against the row they're on for their entire run.
 *
 * "The row it is CURRENTLY over" means the row `moveItemAcrossTracks` actually
 * PLACES it on, which is not the row the vertical travel points at — see
 * `applyMove`'s call site and `resolveTargetTrackIdx`. A multi-select move is
 * exempt for a different reason: `applyMoveDeltaToSelection` shifts a group in
 * place and never changes anyone's track, so a group's current row IS its
 * press-time row and `applyGroupMove` correctly stays on the frozen tier.
 *
 * Audio lanes tier against the LANE, matching how `hitTest` addresses them: a
 * lane can hold several tracks, and to an editor they are one row.
 *
 * `skipId` drops the dragged item's OWN two boundaries, by identity rather than
 * by value. That distinction is the whole fix for butted clips: narration is
 * recorded as takes that butt end-to-end, so a voice clip's start is numerically
 * equal to its neighbour's end, and the old value-based exclusion in
 * `itemSnapPoints` deleted BOTH — handing every butted clip a timeline where the
 * one boundary it most wants to snap to had been quietly removed. Excluding by
 * identity keeps the neighbour's boundary in the set; `originGuard` then handles
 * the separate problem of not being glued to it at rest.
 */
function tieredBoundaries(
  project: Project,
  trackIdx?: number,
  laneIdx?: number,
  skipId?: string,
): SnapPoint[] {
  const points: SnapPoint[] = []
  trackItems(project).forEach((items, idx) => {
    const strength: SnapStrength = idx === trackIdx ? 'strong' : 'weak'
    for (const item of items) {
      if (item.id === skipId) continue
      points.push({ time: item.start, strength }, { time: item.end, strength })
    }
  })
  // Grouped, not read off `track.lane` directly: a track with no `lane` gets
  // an auto-assigned one, so a raw `track.lane ?? 0` would file every
  // unlabelled track under lane 0 and call them all same-lane. `hitTest`
  // addresses lanes through this same grouping, and the two have to agree or
  // the tier is assigned against a row the gesture isn't on.
  for (const lane of groupAudioLanes(project.audio?.tracks ?? [], computeDerivedTiming(project).contentDuration)) {
    const strength: SnapStrength = lane.laneIndex === laneIdx ? 'strong' : 'weak'
    for (const track of lane.tracks) {
      if (track.id === skipId) continue
      points.push({ time: track.start, strength }, { time: track.end, strength })
    }
  }
  return points
}

/**
 * How far this gesture has travelled since the press, in TIMELINE seconds.
 *
 * Measured as "the time under the cursor now, minus the time under the cursor
 * at press" rather than as a pixel delta divided by the scale. The two agree
 * exactly while the viewport holds still, and disagree by the scroll travelled
 * the moment it does not — which is the whole point. Edge auto-scroll pans the
 * view while the pointer is parked in the edge band, re-feeding the machine
 * the SAME screen point every frame; a pixel delta would report no movement at
 * all for those frames, pinning the dragged item to one time while the
 * timeline slid past it. Reading through the live viewport instead means each
 * panned frame resolves that same point to a later time, and whatever the
 * gesture is moving stays under the cursor.
 *
 * Every horizontal gesture shares it — move, trim, roll, slip, slide, audio
 * move/trim/fade, keyframe, caption — so no gesture can drift while its
 * neighbours track. `hasEscaped` deliberately does NOT: a snap-release radius
 * is a distance the user's HAND has to travel, which is a screen measure.
 */
function dragDeltaSeconds(ctx: PointerContext, press: Press, point: Point): number {
  return xToTime(point.x, ctx.viewport) - press.originTime
}

/**
 * Has this gesture pulled clear of where it started?
 *
 * Measured in pixels from the press point, which is the same distance every
 * gesture's candidate has travelled from its own origin (a move's start, a
 * trim's edge, a roll's cut all track `point.x` one-for-one), so one test
 * serves them all without knowing which gesture is running.
 *
 * LATCHED by the caller: once true it stays true for the rest of the gesture.
 * That is the whole point. A guard that merely asked "am I far from the origin
 * right now" could never re-arm the origin boundary, because being near it is
 * exactly the moment you want it back.
 */
function hasEscaped(ctx: PointerContext, press: Press, point: Point): boolean {
  const releasePx = (ctx.snapConfig ?? DEFAULT_SNAP_CONFIG).releasePx
  return Math.abs(point.x - press.origin.x) >= releasePx
}

/** Is `point` within grab range of the playhead line? Measured against
 *  `ctx.playheadTime` — the time the overlay draws the line at — through the
 *  live viewport, so the band tracks the line at any zoom or scroll. Y is not
 *  tested: the line spans the whole surface, so the grab is available on every
 *  row (which rows it actually WINS on is `grabsPlayhead`'s call). */
function isOverPlayhead(point: Point, ctx: PointerContext): boolean {
  if (!(ctx.viewport.pxPerSecond > 0)) return false
  return Math.abs(point.x - timeToX(ctx.playheadTime, ctx.viewport)) <= PLAYHEAD_GRAB_PX
}

/** A near-playhead press that should grab the playhead and scrub, exactly as
 *  the ruler does. Trim EDGES win over the grab — they are the precise target,
 *  so grabbing the playhead where it crosses a clip yields the body but never
 *  the handle (decision D1); everything else, clip and audio bodies and empty
 *  space alike, yields to the grab (D2). Fade GRIPS win over it too, by the
 *  same D1 reasoning — an even smaller, more deliberate target than a trim
 *  edge — which is why this checks `hit.kind` directly rather than folding
 *  into `isEdgeHit` (whose contract is specifically "describes a trim grab",
 *  read via `hit.edge`; a fade grip has no `edge`, only `side`). Keyframe
 *  diamonds win for the identical reason — same size class as a fade grip,
 *  same "smaller and more deliberate than a trim edge" case for the grab. */
function grabsPlayhead(hit: HitResult, point: Point, ctx: PointerContext): boolean {
  return !isEdgeHit(hit) && hit.kind !== 'audio-fade' && hit.kind !== 'keyframe' && isOverPlayhead(point, ctx)
}

/**
 * The origin values to keep suppressed.
 *
 * A gesture starts ON its own origin, so any magnet sitting there captures it
 * instantly and then demands a full release radius of travel before the item
 * moves at all — the item stays put, then jumps 44px in one step. That is why
 * origins were excluded in the first place.
 *
 * But excluding them for the WHOLE gesture is what made a butted clip
 * unsnappable back: the boundary you want to return to is the boundary you
 * started on, and a butted neighbour contributes the very same value. Dropping
 * the suppression the moment the gesture has pulled clear gives both halves —
 * the clip breaks away cleanly, and the boundary re-arms behind it so butting
 * the two back together catches.
 */
function originGuard(escaped: boolean, origins: readonly number[]): readonly number[] {
  return escaped ? [] : origins
}

/** Snap targets for dragging the playhead itself: the clip/audio boundaries.
 *  All STRONG — the playhead belongs to no track, so there is no "own row" to
 *  rank against, and parking it on a cut is the point of the gesture. */
function playheadSnapPoints(ctx: PointerContext): SnapPoint[] {
  return snapPointsExcluding(ctx.snapBoundaries.map(time => ({ time, strength: 'strong' as const })), [])
}

function replaceVisualItem(project: Project, id: string, patch: Partial<VisualItem>): Project {
  return {
    ...project,
    tracks: mapTrackItems(project, items =>
      items.map(item => (item.id === id ? { ...item, ...patch } : item)),
    ),
  }
}

/** `replaceVisualItem`'s caption twin. `patch` is deliberately typed as a
 *  Partial of the whole segment rather than a start/end pair, but only ever
 *  called with one edge — see `applyCaptionTrim` on why nothing else moves. */
function replaceCaptionSegment(project: Project, id: string, patch: Partial<CaptionSegment>): Project {
  if (!project.captions) return project
  return {
    ...project,
    captions: {
      ...project.captions,
      segments: project.captions.segments.map(seg => (seg.id === id ? { ...seg, ...patch } : seg)),
    },
  }
}

/** The items either side of `item` on its own track, in timeline order, and
 *  only when they actually touch it — a gap means there is no shared boundary
 *  to roll. Same adjacency rule `slideItem` uses in cuts.ts. */
function adjacentOnTrack(project: Project, item: VisualItem): { prev?: VisualItem; next?: VisualItem } {
  const track = trackItems(project).find(t => t.some(other => other.id === item.id))
  if (!track) return {}
  const sorted = [...track].sort((a, b) => a.start - b.start)
  const pos = sorted.findIndex(other => other.id === item.id)
  const before = pos > 0 ? sorted[pos - 1] : undefined
  const after = pos >= 0 && pos < sorted.length - 1 ? sorted[pos + 1] : undefined
  return {
    prev: before && Math.abs(before.end - item.start) <= EPSILON ? before : undefined,
    next: after && Math.abs(after.start - item.end) <= EPSILON ? after : undefined,
  }
}

/** Where a guide line goes, and how hard the magnet holding it pulls. */
export interface SnapGuide {
  time: number
  strength: SnapStrength
}

// ── Gesture application ──────────────────────────────────────────────────

interface Applied {
  effects: PointerEffect[]
  snap: SnapState
  lastProject: Project
  /** Where the guide belongs after this move, or null for none. Never an
   *  effect on its own — the reducer diffs it against the last one and emits
   *  only on a change. */
  guide: SnapGuide | null
  /** `keyframe-move` only: the diamond's item-relative landed time (`toT`)
   *  after this move. Undefined for every other gesture, and undefined for a
   *  `keyframe-move` frame that clamped to a no-op — `pointerUp` falls back
   *  to the state's last known value (see the dragging state's `keyframeT`)
   *  so a settled no-op frame at release never loses it. */
  keyframeLandedT?: number
}

function noChange(snap: SnapState, lastProject: Project): Applied {
  return { effects: [], snap, lastProject, guide: null }
}

/** Emit a live edit, unless the op clamped to a no-op and handed back the same
 *  project reference (which `rollEdit`/`slipItem`/`slideItem` all do). */
function change(next: Project, previous: Project, snap: SnapState, guide: SnapGuide | null): Applied {
  if (next === previous) return { effects: [], snap, lastProject: previous, guide }
  return { effects: [{ type: 'projectChange', project: next }], snap, lastProject: next, guide }
}

/**
 * Which boundary a SPAN gesture actually landed on.
 *
 * `snapPointsForSpan` makes both edges of a dragged item magnetic by offering
 * two candidate start positions per boundary — `p` (leading edge lands on it)
 * and `p - duration` (trailing edge does). That is the right shape for the
 * magnet and the wrong one for the guide: `snap.snappedTo` is a start, and
 * drawing a line there when the item's TAIL is what caught puts the mark a
 * whole clip away from the edge the user is looking at.
 *
 * The recovery is a membership test against the un-expanded boundary list: a
 * snapped start that is itself a boundary means the head caught, anything else
 * means the tail did and the boundary is one duration later.
 */
function spanSnapGuide(snapped: SnapResult, duration: number, points: readonly SnapPoint[]): SnapGuide | null {
  const { snappedTo, strength } = snapped
  if (snappedTo === null || strength === null) return null
  const head = points.some(p => Math.abs(p.time - snappedTo) <= EPSILON)
  return { time: head ? snappedTo : snappedTo + duration, strength }
}

/** The guide for an EDGE gesture, suppressed when the op refused to put the
 *  edge where the magnet asked. Trims clamp to a 0.1s minimum duration and to
 *  the source window; a guide left drawn through a clamp would claim an
 *  alignment that isn't on screen. */
function edgeSnapGuide(snapped: SnapResult, landed: number): SnapGuide | null {
  const { snappedTo, strength, time } = snapped
  if (snappedTo === null || strength === null) return null
  return Math.abs(landed - time) <= EPSILON ? { time: snappedTo, strength } : null
}

/** `snapped.snappedTo` as a guide, for the gestures whose snap value IS the
 *  boundary (roll, slide, scrub). */
function directSnapGuide(snapped: SnapResult): SnapGuide | null {
  if (snapped.snappedTo === null || snapped.strength === null) return null
  return { time: snapped.snappedTo, strength: snapped.strength }
}

/** The whole selection travelling as one. The DRAGGED item's leading/trailing
 *  edge snaps to the boundaries exactly as a single move does; the delta that
 *  lands is what every selected item and audio track then shifts by, clamped as
 *  a body so none leaves the timeline. Rebuilt from `press.baseProject` each
 *  move so dragging back and forth cannot compound. Shared by `applyMove`,
 *  `applyAudioMove` and `applyCaptionMove` — a multi-selection can mix clips,
 *  audio bars and captions, so the group moves the same way whichever kind the
 *  drag started on.
 *
 *  `selection` is a parameter rather than a read of `ctx.selectedIds` because
 *  it is not always that: a freshly grabbed caption is not in the host's
 *  selection yet on the first move of its own drag. See `applyCaptionMove`. */
function applyGroupMove(
  ctx: PointerContext,
  press: Press,
  point: Point,
  snap: SnapState,
  lastProject: Project,
  escaped: boolean,
  dragged: { id: string; start: number; end: number },
  selection: readonly string[],
): Applied {
  const duration = dragged.end - dragged.start
  const dt = dragDeltaSeconds(ctx, press, point)
  const boundaries = itemSnapPoints(ctx, press, originGuard(escaped, [dragged.start, dragged.end]))
  const points = snapPointsForSpan(boundaries, duration)
  const snapped = applySnap(dragged.start + dt, points, ctx.viewport, snap, ctx.snapConfig)
  const next = applyMoveDeltaToSelection(press.baseProject, selection, snapped.time - dragged.start, ctx.totalDuration)
  return change(next, lastProject, snapped.state, spanSnapGuide(snapped, duration, boundaries))
}

function applyMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const item = press.hit.item
  if (!item || press.hit.trackIdx === undefined) return noChange(snap, lastProject)

  // Multi-select move: the pressed item belongs to a selection of more than
  // one, so the whole selection travels together by the same delta and keeps
  // its shape. Cross-track movement is dropped for the group (see
  // `applyMoveDeltaToSelection`); a single-item move keeps it, below.
  if (ctx.selectedIds.length > 1 && ctx.selectedIds.includes(item.id)) {
    return applyGroupMove(ctx, press, point, snap, lastProject, escaped, item, ctx.selectedIds)
  }

  const duration = item.end - item.start
  const dt = dragDeltaSeconds(ctx, press, point)
  const rawStart = clamp(item.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  // Which track the item is CURRENTLY ON. Not the POINTED-AT index
  // (`sourceTrackIdx - dy/24`) — `moveItemAcrossTracks` treats that as a mere
  // starting point and searches outward from it, so a pointed-at track the
  // dragged item's KIND can never occupy is not where it goes. Tiering against
  // the pointed-at index therefore ranked the boundaries of a row the item had
  // never been placed on, which is exactly what made a cross-track drag read
  // as "snapping doesn't work over here": drag an overlay down into a
  // same-length gap one row below and the pointed-at index lands on the VIDEO
  // track under it (the 24px drag divisor is roughly half a rendered overlay
  // row, so one row of real travel counts as two steps), the kind gate bounces
  // the drop back up onto the row the cursor is actually over, and the gap's
  // own two edges stay tiered WEAK — a 6px magnet where a 20px one belongs.
  //
  // Running the drop's own search removes the second copy of that arithmetic.
  // (The two can still differ after a mid-drag prune, which renumbers
  // `lastProject`'s tracks under the move's `baseProject`-space `sourceTrackIdx`
  // — pre-existing, and orthogonal to the tier.) `kindOnly` deliberately
  // keeps the COLLISION half of the search out of it — see the option's doc in
  // `timeline-model.ts`; consulting it here would kill the magnet precisely
  // where it is aiming and make the tier lurch between rows mid-slide. (It
  // also makes `ctx.rippleMode` irrelevant to the tier, since ripple mode only
  // ever relaxes that same collision gate.)
  //
  // Resolved against `press.baseProject`, not `lastProject`: `tieredBoundaries`
  // walks `baseProject`, and `press.hit.trackIdx` indexes it too, so all three
  // stay in ONE coordinate space even after a mid-drag prune has renumbered the
  // live project's tracks. The dragged item is filtered out of the kind gate by
  // id, so its own stale position in `baseProject` cannot affect the answer.
  //
  // The window is unread while `kindOnly` is on — the collision gate
  // short-circuits past it — so the RAW (pre-snap) one is passed for the sake
  // of the invariant rather than the arithmetic: if `kindOnly` is ever
  // relaxed, the tier stays a pure function of where the pointer is instead
  // of letting the magnet it produced decide which magnets exist.
  //
  // A past-the-end `currentTrackIdx` is `resolveTargetTrackIdx`'s signal that
  // the drop would MINT a new track. That intentionally matches no row below,
  // so every boundary tiers weak — correct by construction for a track with
  // no neighbours yet, not a case this call site branches on explicitly.
  const dy = point.y - press.origin.y
  const currentTrackIdx = resolveTargetTrackIdx({
    tracks: normalizeTracks(press.baseProject).tracks ?? [],
    item,
    start: rawStart,
    end: rawStart + duration,
    sourceTrackIdx: press.hit.trackIdx,
    dy,
  }, { kindOnly: true })

  const boundaries = itemSnapPoints(ctx, press, originGuard(escaped, [item.start, item.end]), { trackIdx: currentTrackIdx })
  const points = snapPointsForSpan(boundaries, duration)
  const snapped = applySnap(rawStart, points, ctx.viewport, snap, ctx.snapConfig)
  const start = clamp(snapped.time, 0, Math.max(0, ctx.totalDuration - duration))
  // Clamped against t=0 or the end of the timeline the item is NOT where the
  // magnet put it, so there is nothing to mark.
  const guide = Math.abs(start - snapped.time) <= EPSILON
    ? spanSnapGuide(snapped, duration, boundaries)
    : null

  const next: Project = {
    ...lastProject,
    tracks: moveItemAcrossTracks({
      // Server-side shape normalization is best-effort (a project must always
      // open even if migration throws), and the SSE stream's initial frame
      // reads project.json straight off disk with no migration at all — so a
      // legacy-shape project genuinely can reach here. Normalize defensively
      // rather than assume `.tracks` is already `VisualTrack[]`.
      tracks: normalizeTracks(lastProject).tracks ?? [],
      item,
      start,
      end: start + duration,
      sourceTrackIdx: press.hit.trackIdx,
      dy,
      makeSpace: ctx.rippleMode,
    }),
  }
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next, guide }
}

function applyTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const item = press.hit.item
  if (!item || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? item.start : item.end
  const dt = dragDeltaSeconds(ctx, press, point)
  const raw = clamp(initTime + dt, 0, ctx.totalDuration)

  // The opposite edge stays excluded for the whole gesture — trimming an out
  // edge back onto its own in edge is a zero-length clip, not an alignment.
  // Only the edge being dragged gets the re-arming treatment.
  const fixedEdge = edge === 'start' ? item.end : item.start
  const snapped = applySnap(
    raw,
    itemSnapPoints(ctx, press, [fixedEdge, ...originGuard(escaped, [initTime])]),
    ctx.viewport, snap, ctx.snapConfig,
  )
  const resized = computeResizedItem(item as Draggable, edge, snapped.time)

  // Trims always rebuild from the pressed-at project, never from the running
  // preview — otherwise ripple's gap collapse would compound move by move.
  let next = replaceVisualItem(press.baseProject, item.id, {
    start: resized.start,
    end: resized.end,
    inPoint: resized.inPoint,
    outPoint: resized.outPoint,
  })
  if (ctx.selectedIds.length > 1 && ctx.selectedIds.includes(item.id)) {
    next = applyResizeDeltaToSelection(next, item.id, ctx.selectedIds, edge, {
      dStart: edge === 'start' ? resized.start - item.start : 0,
      dEnd: edge === 'end' ? resized.end - item.end : 0,
    })
  }
  if (ctx.rippleMode) next = collapseGaps(next)

  const guide = edgeSnapGuide(snapped, edge === 'start' ? resized.start : resized.end)
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next, guide }
}

function applyRoll(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const item = press.hit.item
  if (!item || !press.hit.edge) return noChange(snap, lastProject)

  const { prev, next: after } = adjacentOnTrack(press.baseProject, item)
  const left = press.hit.edge === 'in' ? prev : item
  const right = press.hit.edge === 'in' ? item : after
  // No neighbour means no shared boundary. The gesture stays alive (releasing
  // Alt mid-drag must not silently turn it into a trim) but does nothing.
  if (!left || !right) return noChange(snap, lastProject)

  const boundary = left.end
  const dt = dragDeltaSeconds(ctx, press, point)
  const candidate = clamp(boundary + dt, 0, ctx.totalDuration)
  // A roll's origin IS the shared boundary, and both neighbours contribute it.
  // The outer edges stay excluded throughout: rolling the cut onto either
  // neighbour's far edge would consume that clip entirely.
  const snapped = applySnap(
    candidate,
    itemSnapPoints(ctx, press, [
      left.start, right.end,
      ...originGuard(escaped, [left.end, right.start]),
    ]),
    ctx.viewport,
    snap,
    ctx.snapConfig,
  )

  const rolled = rollEdit(press.baseProject, left.id, right.id, snapped.time - boundary)
  return change(rolled, lastProject, snapped.state, directSnapGuide(snapped))
}

function applySlip(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const item = press.hit.item
  if (!item) return noChange(snap, lastProject)

  // Dragging right pulls the media rightwards under a fixed window, so EARLIER
  // frames come into view — the film-under-a-gate model every NLE uses. Hence
  // the sign flip. No snapping: the delta is source time, and every snap point
  // the timeline knows about is timeline time.
  const dt = dragDeltaSeconds(ctx, press, point)
  return change(slipItem(press.baseProject, item.id, -dt), lastProject, snap, null)
}

function applySlide(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const item = press.hit.item
  if (!item) return noChange(snap, lastProject)

  const dt = dragDeltaSeconds(ctx, press, point)
  const candidate = clamp(item.start + dt, 0, ctx.totalDuration)
  const snapped = applySnap(
    candidate,
    itemSnapPoints(ctx, press, originGuard(escaped, [item.start, item.end])),
    ctx.viewport,
    snap,
    ctx.snapConfig,
  )
  const slid = slideItem(press.baseProject, item.id, snapped.time - item.start)
  return change(slid, lastProject, snapped.state, directSnapGuide(snapped))
}

function applyAudioMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const track = press.hit.track
  if (!track || press.hit.laneIdx === undefined) return noChange(snap, lastProject)

  // Multi-select move: the whole selection (clips and bars alike) travels as
  // one — same rule as the visual side. A lone audio bar keeps its lane-change
  // behaviour, below.
  if (ctx.selectedIds.length > 1 && ctx.selectedIds.includes(track.id)) {
    return applyGroupMove(ctx, press, point, snap, lastProject, escaped, track, ctx.selectedIds)
  }

  const duration = track.end - track.start
  const dt = dragDeltaSeconds(ctx, press, point)
  const rawStart = clamp(track.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  // Positive dy is downward, which in the audio stack means a HIGHER lane index
  // (lanes ascend downward) — the opposite of visual tracks. Computed here,
  // ahead of the snap boundaries below, because `destLane` is simultaneously
  // "which lane the drop will land on" and "which lane's peers should snap
  // strong right now" — the same current-lane derivation `itemSnapPoints`
  // needs, so one computation serves both.
  const laneDelta = Math.round((point.y - press.origin.y) / AUDIO_LANE_HEIGHT_PX)
  const destLane = Math.max(0, press.hit.laneIdx + laneDelta)

  const boundaries = itemSnapPoints(ctx, press, originGuard(escaped, [track.start, track.end]), { laneIdx: destLane })
  const points = snapPointsForSpan(boundaries, duration)
  const snapped = applySnap(rawStart, points, ctx.viewport, snap, ctx.snapConfig)
  const start = clamp(snapped.time, 0, Math.max(0, ctx.totalDuration - duration))
  const guide = Math.abs(start - snapped.time) <= EPSILON
    ? spanSnapGuide(snapped, duration, boundaries)
    : null

  const changes: Partial<AudioTrack> = { start, end: start + duration, lane: destLane }
  // Cross-lane inheritance: a clip dropped onto another lane adopts THAT
  // lane's magnet state, so the row it lands on stays consistent rather than
  // mixing a magnetic clip in with non-magnetic neighbours (or vice versa).
  // Grouped from `press.baseProject` — the project as it stood before this
  // drag — so mid-drag lane membership never sees the dragged clip's own
  // in-flight `lane` changes, and via `groupAudioLanes` so an auto-assigned
  // (lane-less) neighbour is matched the same way the rail groups it, not by
  // a raw `lane` field comparison. Moving onto an EMPTY lane leaves
  // `magnetic` untouched: there is no row to be consistent with yet.
  const destLaneGroup = groupAudioLanes(press.baseProject.audio?.tracks ?? [])
    .find(l => l.laneIndex === destLane)
  const destLaneTracks = (destLaneGroup?.tracks ?? []).filter(t => t.id !== track.id)
  if (destLaneTracks.length > 0) {
    changes.magnetic = destLaneTracks.every(t => t.magnetic === true)
  }

  const next = updateAudioTrack(press.baseProject, track.id, changes)
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next, guide }
}

function applyAudioTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const track = press.hit.track
  if (!track || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? track.start : track.end
  const dt = dragDeltaSeconds(ctx, press, point)
  const raw = clamp(initTime + dt, 0, ctx.totalDuration)
  const fixedEdge = edge === 'start' ? track.end : track.start
  const snapped = applySnap(
    raw,
    itemSnapPoints(ctx, press, [fixedEdge, ...originGuard(escaped, [initTime])]),
    ctx.viewport, snap, ctx.snapConfig,
  )

  // An audio track is always source-windowed, so it goes straight to
  // `resizeWindowedItem` — `computeResizedItem` would take its non-video
  // branch and move the timeline edge alone. This used to reproduce
  // AudioTrackRow's window arithmetic by hand, with the edge and the window
  // clamped independently; that is the bug documented on `resizeWindowedItem`,
  // and a bar trimmed past its media ended up claiming more timeline than it
  // had audio for.
  const resized = resizeWindowedItem(track as unknown as Draggable, edge, snapped.time)
  const changes: Partial<AudioTrack> = {
    start: resized.start,
    end: resized.end,
    inPoint: resized.inPoint,
    outPoint: resized.outPoint,
  }

  let next = updateAudioTrack(press.baseProject, track.id, changes)
  if (ctx.selectedIds.length > 1 && ctx.selectedIds.includes(track.id)) {
    next = applyResizeDeltaToSelection(next, track.id, ctx.selectedIds, edge, {
      dStart: edge === 'start' ? resized.start - track.start : 0,
      dEnd: edge === 'end' ? resized.end - track.end : 0,
    })
  }
  const guide = edgeSnapGuide(snapped, edge === 'start' ? resized.start : resized.end)
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next, guide }
}

/**
 * Drag an audio bar's fade-in or fade-out GRIP. Dragging the fade-IN grip
 * RIGHT (away from the bar's start) grows `fadeIn`; dragging the fade-OUT
 * grip LEFT (away from the bar's end) grows `fadeOut` — opposite pixel signs
 * for the same "away from the corner, into the clip" motion. Dragging either
 * grip back past its own corner clamps to 0, which is how a fade is removed.
 *
 * No snapping — a fade grip has no meaningful timeline boundary to magnetize
 * to, only its own bar's corner and duration, both already enforced by the
 * clamp below — so this is simpler than `applyAudioTrim`: no
 * `itemSnapPoints`/`applySnap`, no guide, `snap` passed straight through
 * unchanged.
 *
 * Clamp: `fadeIn`/`fadeOut` are each floored at 0 (Math.max inside `clamp`),
 * and the two together may never exceed the bar's own duration — measured
 * against the OTHER side's current (committed) value, since a single drag
 * only ever touches its own side.
 */
function applyAudioFade(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const track = press.hit.track
  const side = press.hit.side
  if (!track || !side) return noChange(snap, lastProject)

  const duration = Math.max(0, track.end - track.start)
  const dt = dragDeltaSeconds(ctx, press, point)
  const initial = side === 'in' ? (track.fadeIn ?? 0) : (track.fadeOut ?? 0)
  const otherFade = side === 'in' ? (track.fadeOut ?? 0) : (track.fadeIn ?? 0)
  const raw = side === 'in' ? initial + dt : initial - dt
  const value = clamp(raw, 0, Math.max(0, duration - otherFade))

  const changes: Partial<AudioTrack> = side === 'in' ? { fadeIn: value } : { fadeOut: value }
  const next = updateAudioTrack(press.baseProject, track.id, changes)
  return { effects: [{ type: 'projectChange', project: next }], snap, lastProject: next, guide: null }
}

/**
 * Drag a keyframe-strip diamond to retime it (plan decision 5).
 *
 * The diamond represents every prop that has a point at the SAME
 * item-relative `t` — the "union of times" decision 2 draws as one merged
 * strip — so moving it moves EVERY track that has a point there, together,
 * one `keyframeOps.moveKeyframe` call per prop. `toT` clamps to
 * `[0, item.end - item.start]`, the item's own span; there is nothing outside
 * it a keyframe could mean.
 *
 * Snapping, unlike the fade grip (which has no meaningful boundary and skips
 * `applySnap` entirely), DOES apply here: the item's own start/end and every
 * OTHER keyframe time on the SAME item are real alignments worth a magnet —
 * converted to ABSOLUTE timeline time (`item.start + t`) since `applySnap`
 * works in that unit, the same conversion `applyAudioTrim`'s `edgeSnapGuide`
 * call makes for its own landed value. `fromT`'s own instant is excluded via
 * `originGuard`, exactly as a trim excludes the edge it started on, so the
 * diamond isn't recaptured at the position it is leaving; excluded THROUGH
 * `escaped`, so dragging back allows it to re-snap onto its own start
 * position once the gesture has pulled clear — same story as a trimmed edge
 * butting back onto its origin.
 *
 * Recomputes from `press.baseProject` every move — like every other
 * bounded, single-item op (trim, fade) and unlike `move`, which accumulates
 * — so dragging back and forth cannot compound.
 *
 * LANDING ON ANOTHER KEYFRAME MERGES THE TWO. Every other keyframe time is a
 * STRONG snap target (above), so a drag is actively steered onto them — and
 * `moveKeyframe` → `normalizeTrack` resolve a same-`t` collision last-wins:
 * for any prop the two diamonds share, the DRAGGED one's value survives and
 * the target's is silently dropped. This is deliberate — it reads as "drag
 * one diamond onto another to collapse them into one" — but it IS a real data
 * loss for whichever prop's value didn't win, so don't "fix" it into a no-op
 * or a merge-by-average without a product decision first. It is a normal
 * undo step like any other keyframe edit, so it is trivially reversible.
 */
function applyKeyframeMove(
  ctx: PointerContext,
  press: Press,
  point: Point,
  snap: SnapState,
  lastProject: Project,
  escaped: boolean,
): Applied {
  const item = press.hit.item
  const fromT = press.hit.kfT
  if (!canKeyframe(item) || fromT === undefined) return noChange(snap, lastProject)

  const duration = Math.max(0, item.end - item.start)
  const dt = dragDeltaSeconds(ctx, press, point)
  const raw = clamp(fromT + dt, 0, duration)

  const otherTimes = keyframeUnionTimes(item).filter(t => t !== fromT)
  const rawPoints: SnapPoint[] = [0, duration, ...otherTimes].map(t => ({ time: item.start + t, strength: 'strong' as const }))
  const points = snapPointsExcluding(rawPoints, originGuard(escaped, [item.start + fromT]))
  const snapped = applySnap(item.start + raw, points, ctx.viewport, snap, ctx.snapConfig)
  const toT = clamp(snapped.time - item.start, 0, duration)

  const props = (item.keyframes ?? [])
    .filter(track => track.points.some(p => p.t === fromT))
    .map(track => track.prop)
  if (props.length === 0) return noChange(snap, lastProject)

  let nextItem = item
  for (const prop of props) nextItem = moveKeyframe(nextItem, prop, fromT, toT)
  if (nextItem === item) return noChange(snap, lastProject)

  const next = replaceVisualItem(press.baseProject, item.id, nextItem)
  const guide = edgeSnapGuide(snapped, item.start + toT)
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next, guide, keyframeLandedT: toT }
}

/**
 * Re-time a caption block — across rows for a lone caption, and along the
 * timeline for a caption travelling with a wider selection.
 *
 * The selection expression is load-bearing. `applyMoveDeltaToSelection` moves
 * only ids it is handed, and when a drag starts on an UNSELECTED caption the
 * `selectMany` effect that selects it has not been echoed back by the host yet
 * — so `ctx.selectedIds` does not contain it on that first move, and the
 * caption would sit perfectly still while the pointer walked away from it.
 * Falling back to `[seg.id]` covers both cases in one line: a caption already
 * in a multi-selection group-moves with everything else, a freshly grabbed one
 * takes the single-caption path below.
 *
 * **Group drags never change lanes.** `applyMoveDeltaToSelection` is
 * horizontal-only — it shifts times and re-spreads word timings, and `lane`
 * rides its spread untouched — so a multi-selection travels along the timeline
 * however far the pointer moves vertically. This is the one place where "drag
 * any member and the whole selection follows" meets "drag up a row to change
 * rows", and horizontal-only wins: a group has no single source lane to
 * measure a lane delta from, and moving every member by the same lane delta
 * would silently re-stack rows the operator never pointed at.
 *
 * Snapping is the ordinary boundary set. A caption hit carries no `trackIdx`
 * or `laneIdx` — it belongs to no row — so `tieredBoundaries` ranks every clip
 * and audio boundary WEAK for it, and captions do not snap to each other at
 * all (that function reads tracks and audio only). Accepted for v1.
 *
 * Captions may NOT overlap WITHIN A LANE. On the group path
 * `applyMoveDeltaToSelection` folds a same-lane caption-neighbour bound in
 * alongside its timeline-edge bound (see `captionNeighbourBounds` in
 * multiSelectOps.ts); on the single path the rule is enforced by choosing a
 * lane the landed span actually fits in (`resolveDropLane`) rather than by
 * clamping the horizontal landing. Overlap is illegal within a lane because
 * `activeCaptionSegments` (timeline-core) hands the preview and every render
 * template EVERY live segment, lane-ascending, and a lane is a z-order with no
 * vertical offset of its own — so two segments sharing a lane and an instant
 * paint one straight over the other, in preview AND in the export. Two
 * segments on DIFFERENT lanes coinciding is the feature rows exist for.
 * `applyCaptionTrim`, below, has the matching same-lane clamp for a trim.
 */
function applyCaptionMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const seg = press.hit.segment
  if (!seg || seg.id === undefined) return noChange(snap, lastProject)
  const id = seg.id
  const selection = ctx.selectedIds.includes(id) ? ctx.selectedIds : [id]
  const dragged = { id, start: seg.start, end: seg.end }
  if (selection.length > 1) {
    return applyGroupMove(ctx, press, point, snap, lastProject, escaped, dragged, selection)
  }

  // The row the press landed in, read off the BAND rather than off the segment.
  // The two agree by construction (`groupCaptionLanes` files each segment into
  // the band for its own lane), but the band is what the operator actually
  // pointed at.
  const sourceLane = press.hit.captionLane ?? laneOf(seg)

  // Divided by CAPTION_ROW_HEIGHT_PX (40), NOT by the 44px band pitch the
  // layout actually stacks bands at — the same deliberate shortfall
  // `applyAudioMove` (AUDIO_LANE_HEIGHT_PX) and `moveItemAcrossTracks`
  // (VISUAL_ROW_HEIGHT_PX) use, so the drag reaches the neighbouring row a few
  // pixels before the cursor has fully left the current one.
  //
  // `resolveDropLane` then computes `wanted = clamp(sourceLane - laneDelta, 0,
  // maxLane + 1)`. The MINUS is a deliberate inversion, not a slip: caption
  // lanes ascend UPWARD on screen (Phase 3 emits the bands in descending lane
  // order, so lane 0 sits lowest, immediately above the base video row),
  // whereas audio lanes ascend DOWNWARD — so for captions a downward drag
  // (positive `laneDelta`) must LOWER the lane number. A sign error here sends
  // every caption the wrong way.
  const laneDelta = Math.round((point.y - press.origin.y) / CAPTION_ROW_HEIGHT_PX)

  // No vertical intent at all: byte-for-byte the horizontal-only behaviour,
  // same-lane neighbour clamp included. This is what an operator who never
  // drags vertically experiences, so it stays exactly the group path with a
  // selection of one rather than a second implementation of the same thing.
  if (laneDelta === 0) {
    return applyGroupMove(ctx, press, point, snap, lastProject, escaped, dragged, selection)
  }

  // ── Vertical intent: a row change, resolved lane-first ──────────────────
  const duration = seg.end - seg.start
  const dt = dragDeltaSeconds(ctx, press, point)
  const boundaries = itemSnapPoints(ctx, press, originGuard(escaped, [seg.start, seg.end]))
  const snapped = applySnap(seg.start + dt, snapPointsForSpan(boundaries, duration), ctx.viewport, snap, ctx.snapConfig)

  // The horizontal landing is bounded by the timeline's own edges and NOTHING
  // else — deliberately not by `applyMoveDeltaToSelection`'s neighbour clamp.
  // A caption that is leaving its row must not be held back by that row's
  // neighbours, and the row it lands in is chosen to fit it rather than being
  // clamped against. That is the whole reason a cross-row drag never teleports
  // a caption sideways hunting for a gap: the search happens in the vertical
  // axis, exactly as `moveItemAcrossTracks` searches tracks for a clip.
  //
  // Same lo/hi `applyMoveDeltaToSelection` computes for a lone caption, minus
  // its neighbour half — `hi`'s `Math.max(0, …)` floor included, so a caption
  // already overhanging `totalDuration` (clips trimmed after captioning) is
  // neither pushed further out nor yanked back in.
  const delta = clamp(snapped.time - seg.start, -seg.start, Math.max(0, ctx.totalDuration - seg.end))
  const start = seg.start + delta
  const end = seg.end + delta

  // Fans out from `wanted` — `wanted, wanted-1, wanted+1, …`, bounded to
  // `[0, maxLane + 1]` — and takes the first lane the landed span fits in, so
  // an occupied target row hands off to the nearest free one. `maxLane + 1` is
  // empty by construction, so the search always terminates there; landing on
  // it is exactly how a NEW row gets created.
  const lane = resolveDropLane({
    segments: press.baseProject.captions?.segments ?? [],
    seg, sourceLane, laneDelta, start, end,
  })

  // Word timings are ABSOLUTE seconds, so every word travels with the segment
  // by the same delta and nothing is respread — the identical rule
  // `shiftCaptions` (multiSelectOps.ts) applies on the group path. `text` is
  // never touched: a move is a retime.
  const patch: Partial<CaptionSegment> = { start, end, lane }
  if (seg.words) patch.words = seg.words.map(w => ({ ...w, start: w.start + delta, end: w.end + delta }))

  // Same-reference on a true no-op, the contract `change` reads: a drag held
  // against a clamp in a row it never left emits nothing rather than an
  // identical project per pointer event.
  const next = delta === 0 && lane === sourceLane
    ? press.baseProject
    : replaceCaptionSegment(press.baseProject, id, patch)
  // Clamped against t=0 or the end of the timeline the caption is NOT where
  // the magnet asked, so there is nothing to mark — same rule as `applyMove`.
  const guide = Math.abs(start - snapped.time) <= EPSILON
    ? spanSnapGuide(snapped, duration, boundaries)
    : null
  return change(next, lastProject, snapped.state, guide)
}

/** The shortest a caption may be trimmed to. Carried over from the retired DOM
 *  row, which got the same floor from `beginResize`, and relied on twice: a
 *  zero-length caption is unselectable and unreadable, and the click-seek in
 *  `pointerUp` needs every segment to be at least one frame long. */
export const CAPTION_MIN_DURATION_S = 0.1

/**
 * Drag ONE caption edge. Single-segment by design — multi-caption trim is out
 * of scope for v1, so a trim never consults the selection at all.
 *
 * Only the dragged edge is written. `text` and `words` are never touched: a
 * pure retime must not respread word timings, which is exactly why the retired
 * DOM row's commit patch carried the one numeric field and nothing else. Word
 * timings are absolute seconds, so they stay where the speech actually is; a
 * respread would silently invent new ones from the segment's new duration.
 */
function applyCaptionTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const seg = press.hit.segment
  if (!seg || seg.id === undefined || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? seg.start : seg.end
  // The nearest OTHER caption SHARING THIS SEGMENT'S LANE on either side — a
  // segment on another row is not a bound, because captions on different rows
  // may overlap and all render. `sameLaneNeighbours` (captionLanes.ts) is the
  // one place that search lives; `seg` is excluded there so it is never its own
  // neighbour. Absent neighbour reads as unbounded (`±Infinity`) on that side,
  // the same convention the move clamp uses.
  //
  // Press-time, not live — same reasoning `press.baseProject` carries for the
  // snap boundaries (see the `Press` interface): the host echoes every
  // `projectChange` back through a re-render, and a neighbour search reading
  // the live project mid-drag would see this very segment's own current edge
  // reflected back as if it were a different, moving neighbour.
  const { prev, next: after } = sameLaneNeighbours(press.baseProject.captions?.segments ?? [], seg)
  const prevEnd = prev?.end ?? -Infinity
  const nextStart = after?.start ?? Infinity

  // ── The dragged edge's LEGAL RANGE, computed once and used for everything ──
  //
  // The timeline on one side, the duration floor on the other, and a
  // same-lane caption-neighbour bound on the third: captions may never overlap
  // within a lane (see the WHY on `applyCaptionMove`), so a trim may not push
  // its edge across the adjacent SAME-LANE segment's edge either — a segment
  // on another row bounds nothing, since rows are allowed to overlap and all
  // render. All three fold into ONE range rather than
  // clamps in sequence: whichever clamp ran second would undo the first.
  // Floor-after-bounds let a segment already shorter than the floor escape the
  // timeline (a 0s–0.05s segment's in edge landed at -0.05s); bounds-after-
  // floor would break the other invariant instead. As a range, all three hold
  // at once.
  //
  // `hi` on the end side is NOT a flat `totalDuration`. That value is
  // `contentDuration + Math.max(5, contentDuration * 0.2)` (timeline-model),
  // derived from clips and audio ONLY, so a caption can outlast it whenever
  // clips were trimmed or deleted after captioning. Rare, but reachable.
  // Pinning such a segment at `totalDuration` would yank its end backwards the
  // moment its handle was touched — a silent destructive shrink triggered by
  // grabbing a handle, which is worse than the out-of-bounds write this bound
  // exists to prevent: that one needs a sub-floor segment at a boundary, this
  // one needs only an overhanging caption and a nudge. Ceiling at the segment's
  // own end instead, so a trim never pushes a caption FURTHER out than it
  // already was. A caption inside the timeline is unaffected — for it the max
  // IS `totalDuration`. `nextStart` then tightens that ceiling further when a
  // following caption IN THE SAME LANE sits closer than the timeline edge does
  // (`Infinity` when there is no such caption, so it never loosens the
  // existing bound).
  //
  // `lo` on the start side stays floored at 0 rather than mirroring `hi`
  // (`Math.min(0, seg.start)`): a negative `start` is unreachable —
  // `applyMoveDeltaToSelection` clamps a group move at `-minStart` and this
  // trim clamps at 0, so nothing in the codebase can produce one, and
  // mirroring would be generality for a state that cannot occur. `prevEnd`
  // raises that floor when a preceding caption IN THE SAME LANE sits to the
  // right of t=0 (`-Infinity` when there is no such caption, so it never
  // lowers it).
  const lo = edge === 'start' ? Math.max(0, prevEnd) : seg.start + CAPTION_MIN_DURATION_S
  const hi = edge === 'start'
    ? seg.end - CAPTION_MIN_DURATION_S
    : Math.min(Math.max(ctx.totalDuration, seg.end), nextStart)

  // An EMPTY range means a sub-floor segment pinned against t=0, the end of
  // the timeline, or a same-lane neighbouring caption's own edge: there is no legal
  // position for this edge at all, so the trim declines to move rather than
  // inventing a least-bad one. Same shape `applyMoveDeltaToSelection` uses for
  // a group already wider than the timeline (or its own caption-neighbour
  // bound), which likewise refuses to move rather than pick a side.
  //
  // This MUST short-circuit before either clamp below. `clamp` is
  // `Math.max(lo, Math.min(hi, v))`, which silently returns `lo` when the range
  // is inverted — so an unguarded clamp would not error, it would quietly place
  // the edge at a bound that is on the wrong side of the other one.
  if (lo > hi) return noChange(snap, lastProject)

  const dt = dragDeltaSeconds(ctx, press, point)
  const raw = clamp(initTime + dt, lo, hi)

  // Same exclusions as every other trim: the opposite edge stays suppressed
  // for the whole gesture, and only the dragged edge's origin re-arms.
  const fixedEdge = edge === 'start' ? seg.end : seg.start
  const snapped = applySnap(
    raw,
    itemSnapPoints(ctx, press, [fixedEdge, ...originGuard(escaped, [initTime])]),
    ctx.viewport, snap, ctx.snapConfig,
  )
  // Clamped again after the snap: a magnet can sit outside the range (the
  // playhead parked past a short caption's floor, say), and a snap is a
  // suggestion, not a licence to leave it.
  const landed = clamp(snapped.time, lo, hi)

  // Same-reference on a no-op, the contract `change` reads. Held against a
  // clamp — dragging further past the floor produces the same edge every move —
  // this is what keeps a pinned drag from emitting an identical project per
  // pointer event, and a drag returned to its origin from committing at all.
  const next = Math.abs(landed - initTime) <= EPSILON
    ? press.baseProject
    : replaceCaptionSegment(press.baseProject, seg.id, edge === 'start' ? { start: landed } : { end: landed })
  return change(next, lastProject, snapped.state, edgeSnapGuide(snapped, landed))
}

function applyScrub(ctx: PointerContext, point: Point, snap: SnapState, lastProject: Project): Applied {
  const raw = clamp(xToTime(point.x, ctx.viewport), 0, ctx.totalDuration)
  const snapped = applySnap(raw, playheadSnapPoints(ctx), ctx.viewport, snap, ctx.snapConfig)
  return {
    effects: [{ type: 'seek', time: snapped.time }],
    snap: snapped.state,
    lastProject,
    guide: directSnapGuide(snapped),
  }
}

function applyGesture(
  gesture: GestureKind,
  ctx: PointerContext,
  press: Press,
  point: Point,
  snap: SnapState,
  lastProject: Project,
  escaped: boolean,
): Applied {
  // Before first layout there is no scale, so a pixel delta has no meaning.
  if (!(ctx.viewport.pxPerSecond > 0)) return noChange(snap, lastProject)
  switch (gesture) {
    case 'move':        return applyMove(ctx, press, point, snap, lastProject, escaped)
    case 'trim':        return applyTrim(ctx, press, point, snap, lastProject, escaped)
    case 'roll':        return applyRoll(ctx, press, point, snap, lastProject, escaped)
    case 'slip':        return applySlip(ctx, press, point, snap, lastProject)
    case 'slide':       return applySlide(ctx, press, point, snap, lastProject, escaped)
    case 'audio-move':  return applyAudioMove(ctx, press, point, snap, lastProject, escaped)
    case 'audio-trim':  return applyAudioTrim(ctx, press, point, snap, lastProject, escaped)
    case 'audio-fade':  return applyAudioFade(ctx, press, point, snap, lastProject)
    case 'keyframe-move': return applyKeyframeMove(ctx, press, point, snap, lastProject, escaped)
    case 'caption-move': return applyCaptionMove(ctx, press, point, snap, lastProject, escaped)
    case 'caption-trim': return applyCaptionTrim(ctx, press, point, snap, lastProject, escaped)
    case 'scrub':       return applyScrub(ctx, point, snap, lastProject)
    case 'marquee':     return applyMarquee(press, point, snap, lastProject)
  }
}

/** The live marquee: paint the box, change nothing. The selection is applied
 *  once, on release — a marquee that re-selected on every move would push a
 *  selection change per pointer event through the host for a gesture the user
 *  has not finished expressing. */
function applyMarquee(press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  return {
    effects: [{ type: 'marquee', rect: normalizeRect(press.origin, point) }],
    snap,
    lastProject,
    guide: null,
  }
}

// ── Reducer ──────────────────────────────────────────────────────────────

export interface Transition {
  state: MachineState
  effects: PointerEffect[]
}

/** The guide the surface is currently showing. Only a running gesture has one. */
function currentGuide(state: MachineState): SnapGuide | null {
  return state.kind === 'dragging' ? state.guide : null
}

/** Append a snap-guide effect when, and only when, the guide actually moves —
 *  or changes tier, which changes how it is drawn.
 *  Same contract as `withCursor`: the host holds the last value, so a silent
 *  transition means "unchanged", never "unknown". */
function guideEffects(previous: SnapGuide | null, next: SnapGuide | null, effects: PointerEffect[]): PointerEffect[] {
  if (previous?.time === next?.time && previous?.strength === next?.strength) return effects
  return [...effects, { type: 'snapGuide', time: next?.time ?? null, strength: next?.strength ?? null }]
}

/** Append a cursor effect when, and only when, the cursor actually changes. */
function withCursor(state: MachineState, cursor: Cursor, effects: PointerEffect[]): Transition {
  if (state.cursor === cursor) return { state, effects }
  return { state: { ...state, cursor }, effects: [...effects, { type: 'cursor', cursor }] }
}

export function pointerReducer(state: MachineState, event: PointerMachineEvent): Transition {
  if (event.type === 'cancel') {
    // Carry the current cursor into the idle state first, so `withCursor` sees
    // the change it has to undo — a cancelled drag must not leave the surface
    // showing a grabbing hand. A cancelled marquee takes its box with it and
    // selects nothing, which is what cancel means.
    const cancelled: PointerEffect[] = state.kind === 'dragging' && state.gesture === 'marquee'
      ? [{ type: 'marquee', rect: null }]
      : []
    return withCursor(
      { kind: 'idle', cursor: state.cursor },
      initialMachineState().cursor,
      guideEffects(currentGuide(state), null, cancelled),
    )
  }

  const { point, modifiers, ctx } = event

  // Mid-drag moves are the hot path (one per pointer event, all gesture) and
  // have no use for a hit result, so they take the early exit before one is
  // computed.
  if (event.type === 'pointerMove' && state.kind === 'dragging') {
    // Latched, never cleared: once this gesture has pulled clear of its origin
    // the boundary it started on stays armed for the rest of the drag.
    const escaped = state.escaped || hasEscaped(ctx, state.press, point)
    const applied = applyGesture(state.gesture, ctx, state.press, point, state.snap, state.lastProject, escaped)
    return {
      state: {
        ...state,
        snap: applied.snap,
        guide: applied.guide,
        lastProject: applied.lastProject,
        escaped,
        keyframeT: applied.keyframeLandedT ?? state.keyframeT,
      },
      effects: guideEffects(state.guide, applied.guide, applied.effects),
    }
  }

  // `selectedIds` is merged in here rather than left for each caller to add
  // to its own `hitTestOptions`, so every host that builds a `PointerContext`
  // gets keyframe hit-testing for free the moment it has a selection —
  // exactly like `ctx.selectedIds` itself is already required on the context,
  // not an opt-in.
  const hit = hitTest(point, ctx.layout, ctx.viewport, { ...ctx.hitTestOptions, selectedIds: ctx.selectedIds })

  switch (event.type) {
    case 'pointerDown': {
      // The ruler, OR a press on the playhead line itself: seek straight away
      // and keep scrubbing. The ruler is the surface's dedicated playhead
      // handle — canvas mode dropped the DOM overview bar (see Scrubber.tsx) and
      // the track area's empty space now belongs to the marquee — and grabbing
      // the full-height red bar anywhere it is reachable does the same thing
      // (`grabsPlayhead`). Landing the seek on mousedown rather than mouseup is
      // what makes the drag continuous.
      const onRuler = hit.kind === 'ruler'
      if (onRuler || grabsPlayhead(hit, point, ctx)) {
        const applied = applyScrub(ctx, point, createSnapState(), ctx.project)
        // The RULER clears the selection, for the same reason pressing bare
        // timeline used to: a clip left selected while you scrub somewhere else
        // means the next keyboard action (split, ripple-delete) hits an item
        // nowhere near where you are looking. Additive presses are exempt —
        // shift is how you build a multi-selection, not how you drop one.
        // Grabbing the playhead itself does NOT clear it (decision D3): it is a
        // precise nudge in place, not a jump to somewhere else, and dropping a
        // selection every time you fine-tune the playhead would be hostile.
        const cleared: PointerEffect[] = (onRuler && !isAdditive(modifiers))
          ? [{ type: 'select', id: null, additive: false }, ...applied.effects]
          : applied.effects
        const next: MachineState = {
          kind: 'dragging',
          cursor: state.cursor,
          press: {
            origin: point,
            originTime: xToTime(point.x, ctx.viewport),
            modifiers,
            hit,
            baseProject: ctx.project,
            wasSelected: false,
            // A scrub never reads these (it uses `playheadSnapPoints`), but a
            // Press without them would be a Press with a hole in it.
            snapBoundaries: tieredBoundaries(ctx.project, hit.trackIdx, hit.laneIdx, hit.itemId),
          },
          gesture: 'scrub',
          snap: applied.snap,
          guide: applied.guide,
          lastProject: ctx.project,
          escaped: false,
        }
        return withCursor(next, cursorForGesture('scrub'), guideEffects(currentGuide(state), applied.guide, cleared))
      }

      // On an item, or on empty track area: nothing happens yet. Whether this
      // is a click (select an item / seek) or a drag (edit / marquee) is not
      // knowable until the pointer moves or lifts. Empty space used to seek on
      // press; it now waits, because the same press may turn out to be the
      // start of a selection box and seeking first would move the playhead
      // every time you drew one.
      const press: Press = {
        origin: point,
        originTime: xToTime(point.x, ctx.viewport),
        modifiers,
        hit,
        baseProject: ctx.project,
        wasSelected: hit.itemId !== undefined && ctx.selectedIds.includes(hit.itemId),
        snapBoundaries: tieredBoundaries(ctx.project, hit.trackIdx, hit.laneIdx, hit.itemId),
      }
      return withCursor({ kind: 'pressed', cursor: state.cursor, press }, cursorForHit(hit), [])
    }

    case 'pointerMove': {
      // Dragging already returned above; only hover and a not-yet-resolved
      // press reach here.
      if (state.kind !== 'pressed') {
        // Over the playhead line the cursor is the scrub cursor, so hovering the
        // red bar tells you it is grabbable before you press it.
        const cursor = grabsPlayhead(hit, point, ctx) ? 'ew-resize' : cursorForHit(hit)
        return withCursor(state, cursor, [])
      }

      if (travelled(point, state.press.origin) < DRAG_THRESHOLD_PX) return { state, effects: [] }
      const gesture = resolveGesture(state.press.hit, state.press.modifiers)
      if (gesture === null) return { state, effects: [] }
      // Grabbing an UNSELECTED clip, bar or caption to move it makes it the
      // selection first, so it is the thing that moves and the thing left
      // selected after — matching every NLE. A drag that starts on an item
      // already in a multi-selection is a group move and leaves the selection
      // untouched. Note this effect only reaches `ctx.selectedIds` on the NEXT
      // event, which is why each move applier has to cope with its own dragged
      // id being absent from it (see `applyCaptionMove`).
      const draggedId = state.press.hit.itemId
      const selectFirst: PointerEffect[] =
        (gesture === 'move' || gesture === 'audio-move' || gesture === 'caption-move')
          && draggedId !== undefined && !ctx.selectedIds.includes(draggedId)
          ? [{ type: 'selectMany', ids: [draggedId], additive: false }]
          : []
      const escaped = hasEscaped(ctx, state.press, point)
      const applied = applyGesture(gesture, ctx, state.press, point, createSnapState(), state.press.baseProject, escaped)
      const next: MachineState = {
        kind: 'dragging',
        cursor: state.cursor,
        press: state.press,
        gesture,
        snap: applied.snap,
        guide: applied.guide,
        lastProject: applied.lastProject,
        escaped,
        keyframeT: applied.keyframeLandedT,
      }
      return withCursor(next, cursorForGesture(gesture), guideEffects(null, applied.guide, [...selectFirst, ...applied.effects]))
    }

    case 'pointerUp': {
      if (state.kind === 'pressed') {
        const { hit: pressed, wasSelected } = state.press
        const effects: PointerEffect[] = []
        if (pressed.itemId !== undefined) {
          const additive = isAdditive(modifiers)
          effects.push({ type: 'select', id: pressed.itemId, additive })
          // VisualTrackRow seeks on a plain click that changes the selection;
          // AudioTrackRow never seeks. Both use the raw, unsnapped click time.
          const visual = pressed.kind === 'item-body' || pressed.kind === 'item-edge'
          if (visual && !additive && !wasSelected) {
            effects.push({ type: 'seek', time: clamp(xToTime(point.x, ctx.viewport), 0, ctx.totalDuration) })
          } else if (isCaptionHit(pressed) && pressed.segment && !additive && !wasSelected) {
            // A caption seeks to its OWN start, not to the clicked time —
            // the preview only offers drag handles for the segment active at
            // the playhead, so selecting one without seeking into it selects
            // something the preview cannot yet act on.
            //
            // And half a frame IN, not to `start` itself. `CaptionPreview`
            // snaps the clock to the frame grid (`t = Math.round(currentTime *
            // fps) / fps`) before the templates' own `t >= start && t < end`
            // test, and caption starts are arbitrary floats out of Whisper.
            // Seeking to exactly `start` therefore rounds DOWN into the
            // PREVIOUS segment whenever `start * fps` has a fractional part
            // below 0.5 — roughly half of all segments (start 3.44 at 30fps →
            // frame 103 → t 3.4333 < 3.44). `start + 0.5 / fps` puts the
            // snapped `t` in [start, start + 1/fps), always inside, and
            // `CAPTION_MIN_DURATION_S` guarantees no segment is under a frame.
            //
            // `ctx.fps` comes from `project.settings?.fps ?? 30`, which lets an
            // explicit `0` (falsy, but not nullish) through untouched — and
            // `0.5 / 0` is `Infinity`, which the clamp below parks at
            // `totalDuration` instead of inside the segment. Guarded here too.
            const fps = Number.isFinite(ctx.fps) && ctx.fps > 0 ? ctx.fps : 30
            effects.push({ type: 'seek', time: clamp(pressed.segment.start + 0.5 / fps, 0, ctx.totalDuration) })
          }
        } else if (isEmptyHit(pressed)) {
          // A click on empty track area that never became a marquee: seek and
          // drop the selection, which is what pressing there did before the
          // marquee took the drag half of this gesture.
          if (!isAdditive(modifiers)) effects.push({ type: 'select', id: null, additive: false })
          effects.push({ type: 'seek', time: clamp(xToTime(point.x, ctx.viewport), 0, ctx.totalDuration) })
        }
        return withCursor({ kind: 'idle', cursor: state.cursor }, cursorForHit(hit), effects)
      }

      if (state.kind === 'dragging') {
        const effects: PointerEffect[] = []
        if (state.gesture === 'marquee') {
          // Take the box down first, then apply what it caught. A marquee never
          // touches the project, so it never commits.
          const rect = normalizeRect(state.press.origin, point)
          effects.push({ type: 'marquee', rect: null })
          effects.push({
            type: 'selectMany',
            ids: itemsInRect(rect, ctx.layout, ctx.viewport),
            additive: isAdditive(state.press.modifiers) || isAdditive(modifiers),
          })
          return withCursor(
            { kind: 'idle', cursor: state.cursor },
            cursorForHit(hit),
            guideEffects(state.guide, null, effects),
          )
        }
        // A scrub has nothing to persist, and a gesture whose every move clamped
        // to a no-op has nothing either — committing an unchanged project would
        // make the host write the file for a gesture that did nothing.
        if (state.gesture !== 'scrub' && state.lastProject !== state.press.baseProject) {
          // Snap any magnetic audio lane gapless on RELEASE, not mid-drag —
          // `reflowMagneticLanes` is idempotent and only ever touches
          // magnetic audio lanes, so visual/caption gestures and non-magnetic
          // audio are unaffected; keeping it off the transient
          // `projectChange` frames is what keeps the drag itself smooth.
          let committed = reflowMagneticLanes(state.lastProject)
          // A caption that was alone in its row leaves a HOLE lane behind it.
          // Collapse it here — after the "did anything change" gate, inside the
          // one commit — so a cross-row drag renumbers exactly once and lands
          // as a single undo entry.
          //
          // The mid-drag `projectChange` frames deliberately keep the
          // UN-normalized project: the hole lane is what keeps
          // `groupCaptionLanes` emitting an empty band there, and that band is
          // what stops the whole timeline jumping a row height under the
          // pointer half way through the gesture.
          if (state.gesture === 'caption-move') {
            const normalized = normalizeCaptionLanes(committed.captions)
            if (normalized !== committed.captions) committed = { ...committed, captions: normalized }
          }
          effects.push({ type: 'commit', project: committed })
          // CapCut-correct retime: the diamond you dragged is the diamond you
          // have selected, even though its `t` just changed underneath the
          // selection's old value. Only follows when the dragged diamond WAS
          // the selected one (`ctx.selectedKeyframe` matches this gesture's
          // press-time itemId + fromT) — dragging some OTHER, unselected
          // diamond must not steal the selection, and a menu/Delete-driven
          // removal (not a retime) still goes through the host's own
          // clearing paths untouched by this branch. Gated on the same
          // "did anything actually change" check above, so a drag that
          // never crossed a real move never touches the selection either.
          if (state.gesture === 'keyframe-move' && state.keyframeT !== undefined) {
            const { itemId, kfT: fromT } = state.press.hit
            const sel = ctx.selectedKeyframe
            if (itemId !== undefined && fromT !== undefined && sel && sel.itemId === itemId && sel.t === fromT) {
              effects.push({ type: 'selectKeyframe', itemId, t: state.keyframeT })
            }
          }
        }
        return withCursor(
          { kind: 'idle', cursor: state.cursor },
          cursorForHit(hit),
          guideEffects(state.guide, null, effects),
        )
      }

      return withCursor(state, cursorForHit(hit), [])
    }

    case 'doubleClick': {
      // A diamond selects itself. Checked first: a 'keyframe' hit also carries an
      // itemId, so the generic branch below would otherwise swallow it.
      if (hit.kind === 'keyframe' && hit.itemId !== undefined && hit.kfT !== undefined) {
        return { state, effects: [{ type: 'selectKeyframe', itemId: hit.itemId, t: hit.kfT }] }
      }
      // Key the SELECTED element, and only when the click landed ON it. Checked
      // against `ctx.selectedIds` rather than "is there a selection" so a
      // double-click on a different clip never keys the selected one.
      if (
        (hit.kind === 'item-body' || hit.kind === 'item-edge') &&
        hit.item && hit.itemId !== undefined &&
        ctx.selectedIds.includes(hit.itemId) &&
        canKeyframe(hit.item)
      ) {
        const item = hit.item
        const localT = clamp(hit.t - item.start, 0, Math.max(0, item.end - item.start))

        // WHICH props get keyed depends on the item, and this used to be a
        // hand-maintained five-prop constant here. `transformProps` is the
        // shared rule (see its doc comment for why a fixed list breaks in both
        // directions): keying `scaleX`/`scaleY` on a uniform overlay freezes its
        // zoom, and keying `scale` on a per-axis one does nothing at all,
        // because a per-axis value shadows the uniform one in the resolver.
        // OverlayInspector's header keyframe-all action reads the same function.
        //
        // Every value read off the ORIGINAL item BEFORE threading, so one prop's
        // write cannot perturb another's sample. Same rule OverlayInspector's
        // header diamond follows.
        const sampled = transformProps(item).map(prop => [prop, valueAt(item, prop, localT)] as const)
        let nextItem = item
        for (const [prop, value] of sampled) {
          nextItem = setKeyframe(enableKeyframing(nextItem, prop, localT), prop, localT, value)
        }
        if (nextItem === item) return { state, effects: [] }

        // `ctx.project` is the ONLY project reference in scope here. The
        // `doubleClick` case is a top-level branch of the reducer's switch — it is
        // not nested under a `pressed`/`dragging` state, so there is no `press`
        // and no `baseProject`. (`baseProject` is a drag-only concept: recompute
        // from press-time so a back-and-forth drag cannot compound. A discrete
        // double-click never presses, so it is meaningless here.)
        const next = replaceVisualItem(ctx.project, item.id, { keyframes: nextItem.keyframes })
        return { state, effects: [
          { type: 'projectChange', project: next },
          { type: 'commit', project: next },
        ] }
      }
      // A clip or bar opens its inspector. Timeline background does nothing:
      // double-clicking it used to place the A/B range markers, which are gone.
      if (hit.itemId !== undefined) {
        // A caption has no inspector — it opens its text for editing instead.
        if (isCaptionHit(hit)) return { state, effects: [{ type: 'editCaption', id: hit.itemId }] }
        // 'keyframe' is visual too — a diamond only ever exists on an overlay
        // item (never an audio track). A well-formed diamond hit already
        // returned above; this only catches one missing its `kfT`, which still
        // belongs to that overlay rather than to any audio bar.
        const target = hit.kind === 'item-body' || hit.kind === 'item-edge' || hit.kind === 'keyframe' ? 'visual' : 'audio'
        return { state, effects: [{ type: 'inspect', target, id: hit.itemId }] }
      }
      return { state, effects: [] }
    }
  }
}

// ── Imperative wrapper ───────────────────────────────────────────────────

export interface PointerMachine {
  readonly state: MachineState
  dispatch(event: PointerMachineEvent): PointerEffect[]
  reset(): void
}

/** A reducer plus the one mutable slot the component needs. Kept trivial on
 *  purpose: all the behaviour is in `pointerReducer`, which tests drive
 *  directly. */
export function createPointerMachine(initial: MachineState = initialMachineState()): PointerMachine {
  let state = initial
  return {
    get state() { return state },
    dispatch(event) {
      const transition = pointerReducer(state, event)
      state = transition.state
      return transition.effects
    },
    reset() { state = initialMachineState() },
  }
}
