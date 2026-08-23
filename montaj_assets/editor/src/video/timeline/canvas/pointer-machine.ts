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

import type { AudioTrack, CaptionSegment, Captions, VisualItem } from '../../../schema'
import type { Project } from '../../../types'
import { collapseGaps, rollEdit, slideItem, slipItem } from '../../cuts'
import { applyMoveDeltaToSelection, applyResizeDeltaToSelection } from '../multiSelectOps'
import { AUDIO_LANE_HEIGHT_PX, computeDerivedTiming, groupAudioLanes, mapTrackItems, moveItemAcrossTracks, normalizeTracks, trackItems, updateAudioTrack } from '../timeline-model'
import { DRAG_THRESHOLD_PX, computeResizedItem, resizeWindowedItem, type Draggable } from '../useItemDragDrop'
import type { TimelineLayout } from './draw'
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

export type Cursor = 'default' | 'pointer' | 'grab' | 'grabbing' | 'ew-resize' | 'crosshair'

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

// ── State ────────────────────────────────────────────────────────────────

export type GestureKind =
  | 'move'
  | 'trim'
  | 'roll'
  | 'slip'
  | 'slide'
  | 'audio-move'
  | 'audio-trim'
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
   *  complete. */
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
 *  `cursor-ew-resize` on handles, `cursor-grab` on item bodies.
 *
 *  Empty timeline is the plain arrow, not `pointer`. A hand cursor promises a
 *  thing you can click, and the gaps between clips are not a thing — they are
 *  where you drag out a selection. `pointer` there read as "everything on this
 *  surface is a button", which is the opposite of what a track area is.
 *  The ruler keeps `ew-resize`, because scrubbing IS a horizontal drag. */
export function cursorForHit(hit: HitResult): Cursor {
  switch (hit.kind) {
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
    case 'trim':
    case 'roll':
    case 'audio-trim':
    case 'caption-trim':
    case 'scrub':
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
 *  change during an item gesture. */
function itemSnapPoints(ctx: PointerContext, press: Press, exclude: readonly number[]): SnapPoint[] {
  // The playhead is STRONG regardless of tier: it belongs to no track, and
  // parking a cut on it is always a deliberate act rather than an accident of
  // what happens to be on the row above.
  const points: SnapPoint[] = [...press.snapBoundaries, { time: ctx.playheadTime, strength: 'strong' }]
  return snapPointsExcluding(points, exclude)
}

/**
 * Every boundary in the project, tiered against the row the gesture is working
 * on. Captured once per press (see `Press.snapBoundaries`).
 *
 * "Own track" is the row the press LANDED on, and it stays that row even if a
 * cross-track move later carries the item somewhere else. Re-tiering mid-drag
 * would re-rank the magnets under the cursor at the moment it crosses a row
 * boundary, which reads as the clip lurching; a fixed frame of reference for
 * the whole gesture is both calmer and easier to reason about.
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
 *  space alike, yields to the grab (D2). */
function grabsPlayhead(hit: HitResult, point: Point, ctx: PointerContext): boolean {
  return !isEdgeHit(hit) && isOverPlayhead(point, ctx)
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
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
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
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const rawStart = clamp(item.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  const boundaries = itemSnapPoints(ctx, press, originGuard(escaped, [item.start, item.end]))
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
      dy: point.y - press.origin.y,
    }),
  }
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next, guide }
}

function applyTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const item = press.hit.item
  if (!item || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? item.start : item.end
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
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
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
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
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  return change(slipItem(press.baseProject, item.id, -dt), lastProject, snap, null)
}

function applySlide(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const item = press.hit.item
  if (!item) return noChange(snap, lastProject)

  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
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
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const rawStart = clamp(track.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  const boundaries = itemSnapPoints(ctx, press, originGuard(escaped, [track.start, track.end]))
  const points = snapPointsForSpan(boundaries, duration)
  const snapped = applySnap(rawStart, points, ctx.viewport, snap, ctx.snapConfig)
  const start = clamp(snapped.time, 0, Math.max(0, ctx.totalDuration - duration))
  const guide = Math.abs(start - snapped.time) <= EPSILON
    ? spanSnapGuide(snapped, duration, boundaries)
    : null

  // Positive dy is downward, which in the audio stack means a HIGHER lane index
  // (lanes ascend downward) — the opposite of visual tracks.
  const laneDelta = Math.round((point.y - press.origin.y) / AUDIO_LANE_HEIGHT_PX)
  const next = updateAudioTrack(press.baseProject, track.id, {
    start,
    end: start + duration,
    lane: Math.max(0, press.hit.laneIdx + laneDelta),
  })
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next, guide }
}

function applyAudioTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const track = press.hit.track
  if (!track || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? track.start : track.end
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
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
 * Re-time a caption block, and whatever else is selected with it.
 *
 * There is no single-segment path to fall through to, the way `applyMove` and
 * `applyAudioMove` have one: a caption belongs to no track and no lane, so
 * there is nothing for a lone drag to do that the group path doesn't already
 * do. Everything goes through `applyGroupMove`, which is also what makes a
 * mixed clip+caption drag land as ONE undo entry.
 *
 * The selection expression is load-bearing. `applyMoveDeltaToSelection` moves
 * only ids it is handed, and when a drag starts on an UNSELECTED caption the
 * `selectMany` effect that selects it has not been echoed back by the host yet
 * — so `ctx.selectedIds` does not contain it on that first move, and the
 * caption would sit perfectly still while the pointer walked away from it.
 * Falling back to `[seg.id]` covers both cases in one line: a caption already
 * in a multi-selection group-moves with everything else, a freshly grabbed one
 * moves alone.
 *
 * Snapping is the ordinary boundary set. A caption hit carries no `trackIdx`
 * or `laneIdx` — it belongs to no row — so `tieredBoundaries` ranks every clip
 * and audio boundary WEAK for it, and captions do not snap to each other at
 * all (that function reads tracks and audio only). Accepted for v1.
 *
 * Captions may NOT overlap. `applyGroupMove` clamps the delta through
 * `applyMoveDeltaToSelection`, which folds in a caption-neighbour bound
 * alongside its timeline-edge bound (see `captionNeighbourBounds` in
 * multiSelectOps.ts) — a selected caption may not cross a non-selected one, in
 * either direction. This was dropped when captions moved onto the canvas
 * timeline for overlay parity (the retired DOM `CaptionTrackRow` had a
 * neighbour clamp) and has now been restored, because the gap was not
 * cosmetic: the preview and every render template resolve the active caption
 * with `segments.find(s => t >= s.start && t < s.end)`, the FIRST match in
 * array order, so an overlapped span silently drops whichever segment lost
 * that race — in preview AND in the export. `applyCaptionTrim`, below, has the
 * matching clamp for a trim. Multiple caption ROWS, where captions on
 * DIFFERENT rows may overlap and all render (CapCut's model), is a separate
 * planned feature needing more than one caption lane — not this.
 */
function applyCaptionMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project, escaped: boolean): Applied {
  const seg = press.hit.segment
  if (!seg || seg.id === undefined) return noChange(snap, lastProject)
  const id = seg.id
  const selection = ctx.selectedIds.includes(id) ? ctx.selectedIds : [id]
  return applyGroupMove(ctx, press, point, snap, lastProject, escaped, { id, start: seg.start, end: seg.end }, selection)
}

/** The shortest a caption may be trimmed to. Carried over from the retired DOM
 *  row, which got the same floor from `beginResize`, and relied on twice: a
 *  zero-length caption is unselectable and unreadable, and the click-seek in
 *  `pointerUp` needs every segment to be at least one frame long. */
export const CAPTION_MIN_DURATION_S = 0.1

/**
 * The nearest OTHER caption's end at or before `seg.start`, and the nearest
 * OTHER caption's start at or after `seg.end` — the boundaries a trim of `seg`
 * may not cross, because captions may never overlap (see the WHY on
 * `applyCaptionMove`, above). `seg` itself is excluded so it is never its own
 * neighbour; unlike the move clamp (`captionNeighbourBounds` in
 * multiSelectOps.ts) there is no wider "selected" set to exclude, since a trim
 * never touches more than one segment — see `applyCaptionTrim`'s own doc
 * comment. Absent neighbour reads as unbounded (`±Infinity`) on that side,
 * same convention the move clamp uses.
 */
function captionEdgeNeighbours(captions: Captions | undefined, seg: CaptionSegment): { prevEnd: number; nextStart: number } {
  let prevEnd = -Infinity
  let nextStart = Infinity
  for (const other of captions?.segments ?? []) {
    if (other.id === seg.id) continue
    if (other.end <= seg.start && other.end > prevEnd) prevEnd = other.end
    if (other.start >= seg.end && other.start < nextStart) nextStart = other.start
  }
  return { prevEnd, nextStart }
}

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
  // Press-time, not live — same reasoning `press.baseProject` carries for the
  // snap boundaries (see the `Press` interface): the host echoes every
  // `projectChange` back through a re-render, and a neighbour search reading
  // the live project mid-drag would see this very segment's own current edge
  // reflected back as if it were a different, moving neighbour.
  const { prevEnd, nextStart } = captionEdgeNeighbours(press.baseProject.captions, seg)

  // ── The dragged edge's LEGAL RANGE, computed once and used for everything ──
  //
  // The timeline on one side, the duration floor on the other, and now a
  // caption-neighbour bound on the third: captions may never overlap (see the
  // WHY on `applyCaptionMove`), so a trim may not push its edge across the
  // adjacent segment's edge either. All three fold into ONE range rather than
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
  // following caption sits closer than the timeline edge does (`Infinity` when
  // there is no next caption, so it never loosens the existing bound).
  //
  // `lo` on the start side stays floored at 0 rather than mirroring `hi`
  // (`Math.min(0, seg.start)`): a negative `start` is unreachable —
  // `applyMoveDeltaToSelection` clamps a group move at `-minStart` and this
  // trim clamps at 0, so nothing in the codebase can produce one, and
  // mirroring would be generality for a state that cannot occur. `prevEnd`
  // raises that floor when a preceding caption sits to the right of t=0
  // (`-Infinity` when there is no previous caption, so it never lowers it).
  const lo = edge === 'start' ? Math.max(0, prevEnd) : seg.start + CAPTION_MIN_DURATION_S
  const hi = edge === 'start'
    ? seg.end - CAPTION_MIN_DURATION_S
    : Math.min(Math.max(ctx.totalDuration, seg.end), nextStart)

  // An EMPTY range means a sub-floor segment pinned against t=0, the end of
  // the timeline, or a neighbouring caption's own edge: there is no legal
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

  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
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
      state: { ...state, snap: applied.snap, guide: applied.guide, lastProject: applied.lastProject, escaped },
      effects: guideEffects(state.guide, applied.guide, applied.effects),
    }
  }

  const hit = hitTest(point, ctx.layout, ctx.viewport, ctx.hitTestOptions)

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
          effects.push({ type: 'commit', project: state.lastProject })
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
      // A clip or bar opens its inspector. Timeline background does nothing:
      // double-clicking it used to place the A/B range markers, which are gone.
      if (hit.itemId !== undefined) {
        // A caption has no inspector — it opens its text for editing instead.
        if (isCaptionHit(hit)) return { state, effects: [{ type: 'editCaption', id: hit.itemId }] }
        const target = hit.kind === 'item-body' || hit.kind === 'item-edge' ? 'visual' : 'audio'
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
