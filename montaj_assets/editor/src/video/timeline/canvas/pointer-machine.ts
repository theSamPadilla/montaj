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
 *   seek on click — AudioTrackRow has no such line.
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

import type { AudioTrack, VisualItem } from '../../../schema'
import type { Project } from '../../../types'
import { collapseGaps, rollEdit, slideItem, slipItem } from '../../cuts'
import { applyResizeDeltaToSelection } from '../multiSelectOps'
import { AUDIO_LANE_HEIGHT_PX, groupAudioLanes, mapTrackItems, moveItemAcrossTracks, normalizeTracks, trackItems, updateAudioTrack } from '../timeline-model'
import { DRAG_THRESHOLD_PX, computeResizedItem, resizeWindowedItem, type Draggable } from '../useItemDragDrop'
import type { TimelineLayout } from './draw'
import { hitTest, isEmptyHit, type HitResult, type HitTestOptions, type Point } from './hit-test'
import {
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
import { xToTime, type Viewport } from './viewport'

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

export type Cursor = 'pointer' | 'grab' | 'grabbing' | 'ew-resize'

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
  /** The surface's CSS cursor. Emitted only when it changes. */
  | { type: 'cursor'; cursor: Cursor }
  /** Where to draw the snap guide and how hard it is holding, or nulls to take
   *  it down. Emitted only when it CHANGES — a drag held against one boundary
   *  emits once on capture and once on release, not sixty times a second. */
  | { type: 'snapGuide'; time: number | null; strength: SnapStrength | null }

// ── State ────────────────────────────────────────────────────────────────

export type GestureKind =
  | 'move'
  | 'trim'
  | 'roll'
  | 'slip'
  | 'slide'
  | 'audio-move'
  | 'audio-trim'
  /** Dragging the playhead across empty timeline. */
  | 'scrub'

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
    }

export function initialMachineState(): MachineState {
  return { kind: 'idle', cursor: 'pointer' }
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
 *  `cursor-ew-resize` on handles, `cursor-grab` on item bodies,
 *  `cursor-pointer` on the row/lane background. */
export function cursorForHit(hit: HitResult): Cursor {
  switch (hit.kind) {
    case 'item-edge':
    case 'audio-edge':
      return 'ew-resize'
    case 'item-body':
    case 'audio-body':
      return 'grab'
    default:
      return 'pointer'
  }
}

function cursorForGesture(gesture: GestureKind): Cursor {
  switch (gesture) {
    case 'trim':
    case 'roll':
    case 'audio-trim':
    case 'scrub':
      return 'ew-resize'
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
 */
function tieredBoundaries(project: Project, trackIdx?: number, laneIdx?: number): SnapPoint[] {
  const points: SnapPoint[] = []
  trackItems(project).forEach((items, idx) => {
    const strength: SnapStrength = idx === trackIdx ? 'strong' : 'weak'
    for (const item of items) {
      points.push({ time: item.start, strength }, { time: item.end, strength })
    }
  })
  // Grouped, not read off `track.lane` directly: a track with no `lane` gets
  // an auto-assigned one, so a raw `track.lane ?? 0` would file every
  // unlabelled track under lane 0 and call them all same-lane. `hitTest`
  // addresses lanes through this same grouping, and the two have to agree or
  // the tier is assigned against a row the gesture isn't on.
  for (const lane of groupAudioLanes(project.audio?.tracks ?? [])) {
    const strength: SnapStrength = lane.laneIndex === laneIdx ? 'strong' : 'weak'
    for (const track of lane.tracks) {
      points.push({ time: track.start, strength }, { time: track.end, strength })
    }
  }
  return points
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

function applyMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const item = press.hit.item
  if (!item || press.hit.trackIdx === undefined) return noChange(snap, lastProject)

  const duration = item.end - item.start
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const rawStart = clamp(item.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  const boundaries = itemSnapPoints(ctx, press, [item.start, item.end])
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

function applyTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const item = press.hit.item
  if (!item || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? item.start : item.end
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const raw = clamp(initTime + dt, 0, ctx.totalDuration)

  const snapped = applySnap(raw, itemSnapPoints(ctx, press, [item.start, item.end]), ctx.viewport, snap, ctx.snapConfig)
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

function applyRoll(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
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
  const snapped = applySnap(
    clamp(boundary + dt, 0, ctx.totalDuration),
    itemSnapPoints(ctx, press, [left.start, left.end, right.start, right.end]),
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

function applySlide(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const item = press.hit.item
  if (!item) return noChange(snap, lastProject)

  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const snapped = applySnap(
    clamp(item.start + dt, 0, ctx.totalDuration),
    itemSnapPoints(ctx, press, [item.start, item.end]),
    ctx.viewport,
    snap,
    ctx.snapConfig,
  )
  const slid = slideItem(press.baseProject, item.id, snapped.time - item.start)
  return change(slid, lastProject, snapped.state, directSnapGuide(snapped))
}

function applyAudioMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const track = press.hit.track
  if (!track || press.hit.laneIdx === undefined) return noChange(snap, lastProject)

  const duration = track.end - track.start
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const rawStart = clamp(track.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  const boundaries = itemSnapPoints(ctx, press, [track.start, track.end])
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

function applyAudioTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const track = press.hit.track
  if (!track || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? track.start : track.end
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const raw = clamp(initTime + dt, 0, ctx.totalDuration)
  const snapped = applySnap(raw, itemSnapPoints(ctx, press, [track.start, track.end]), ctx.viewport, snap, ctx.snapConfig)

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
): Applied {
  // Before first layout there is no scale, so a pixel delta has no meaning.
  if (!(ctx.viewport.pxPerSecond > 0)) return noChange(snap, lastProject)
  switch (gesture) {
    case 'move':        return applyMove(ctx, press, point, snap, lastProject)
    case 'trim':        return applyTrim(ctx, press, point, snap, lastProject)
    case 'roll':        return applyRoll(ctx, press, point, snap, lastProject)
    case 'slip':        return applySlip(ctx, press, point, snap, lastProject)
    case 'slide':       return applySlide(ctx, press, point, snap, lastProject)
    case 'audio-move':  return applyAudioMove(ctx, press, point, snap, lastProject)
    case 'audio-trim':  return applyAudioTrim(ctx, press, point, snap, lastProject)
    case 'scrub':       return applyScrub(ctx, point, snap, lastProject)
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
    // showing a grabbing hand.
    return withCursor(
      { kind: 'idle', cursor: state.cursor },
      initialMachineState().cursor,
      guideEffects(currentGuide(state), null, []),
    )
  }

  const { point, modifiers, ctx } = event

  // Mid-drag moves are the hot path (one per pointer event, all gesture) and
  // have no use for a hit result, so they take the early exit before one is
  // computed.
  if (event.type === 'pointerMove' && state.kind === 'dragging') {
    const applied = applyGesture(state.gesture, ctx, state.press, point, state.snap, state.lastProject)
    return {
      state: { ...state, snap: applied.snap, guide: applied.guide, lastProject: applied.lastProject },
      effects: guideEffects(state.guide, applied.guide, applied.effects),
    }
  }

  const hit = hitTest(point, ctx.layout, ctx.viewport, ctx.hitTestOptions)

  switch (event.type) {
    case 'pointerDown': {
      // Empty timeline: seek straight away and keep scrubbing. The canvas has
      // no playhead handle of its own (the DOM scrubber above it stays whole-
      // project chrome), so pressing the surface IS grabbing the playhead. The
      // DOM's click-to-seek landed on mouseup; landing it on mousedown is the
      // same destination one event earlier, and it makes the drag continuous.
      if (isEmptyHit(hit)) {
        const applied = applyScrub(ctx, point, createSnapState(), ctx.project)
        // Pressing bare timeline clears the selection. Without this a clip
        // stayed selected while you scrubbed somewhere else entirely, so the
        // next keyboard action (split, ripple-delete) hit an item nowhere near
        // where you were looking. Additive presses are exempt — shift is how
        // you build a multi-selection, not how you drop one.
        const cleared: PointerEffect[] = isAdditive(modifiers)
          ? applied.effects
          : [{ type: 'select', id: null, additive: false }, ...applied.effects]
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
            snapBoundaries: tieredBoundaries(ctx.project, hit.trackIdx, hit.laneIdx),
          },
          gesture: 'scrub',
          snap: applied.snap,
          guide: applied.guide,
          lastProject: ctx.project,
        }
        return withCursor(next, cursorForGesture('scrub'), guideEffects(currentGuide(state), applied.guide, cleared))
      }

      // On an item: nothing happens yet. Whether this is a click (select) or a
      // drag (edit) is not knowable until the pointer moves or lifts.
      const press: Press = {
        origin: point,
        modifiers,
        hit,
        baseProject: ctx.project,
        wasSelected: hit.itemId !== undefined && ctx.selectedIds.includes(hit.itemId),
        snapBoundaries: tieredBoundaries(ctx.project, hit.trackIdx, hit.laneIdx),
      }
      return withCursor({ kind: 'pressed', cursor: state.cursor, press }, cursorForHit(hit), [])
    }

    case 'pointerMove': {
      // Dragging already returned above; only hover and a not-yet-resolved
      // press reach here.
      if (state.kind !== 'pressed') {
        return withCursor(state, cursorForHit(hit), [])
      }

      if (travelled(point, state.press.origin) < DRAG_THRESHOLD_PX) return { state, effects: [] }
      const gesture = resolveGesture(state.press.hit, state.press.modifiers)
      if (gesture === null) return { state, effects: [] }
      const applied = applyGesture(gesture, ctx, state.press, point, createSnapState(), state.press.baseProject)
      const next: MachineState = {
        kind: 'dragging',
        cursor: state.cursor,
        press: state.press,
        gesture,
        snap: applied.snap,
        guide: applied.guide,
        lastProject: applied.lastProject,
      }
      return withCursor(next, cursorForGesture(gesture), guideEffects(null, applied.guide, applied.effects))
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
          }
        }
        return withCursor({ kind: 'idle', cursor: state.cursor }, cursorForHit(hit), effects)
      }

      if (state.kind === 'dragging') {
        const effects: PointerEffect[] = []
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
