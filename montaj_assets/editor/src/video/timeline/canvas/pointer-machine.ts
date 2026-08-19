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
import { AUDIO_LANE_HEIGHT_PX, moveItemAcrossTracks, updateAudioTrack } from '../timeline-model'
import { DRAG_THRESHOLD_PX, computeResizedItem, type Draggable } from '../useItemDragDrop'
import type { TimelineLayout } from './draw'
import { hitTest, isEmptyHit, type HitResult, type HitTestOptions, type Point } from './hit-test'
import {
  applySnap,
  createSnapState,
  snapPointsExcluding,
  snapPointsForSpan,
  type SnapConfig,
  type SnapState,
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
  markers: readonly [number | null, number | null]
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
  /** `setMarkers` with the next A/B tuple. */
  | { type: 'markers'; markers: [number | null, number | null] }
  /** Double-click on a clip or audio bar — `onInspectClip` / `onInspectAudio`. */
  | { type: 'inspect'; target: 'visual' | 'audio'; id: string }
  /** The surface's CSS cursor. Emitted only when it changes. */
  | { type: 'cursor'; cursor: Cursor }

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
  /** `ctx.snapBoundaries` as they stood when the press began. The host echoes
   *  every `projectChange` back through Timeline's re-render, and that re-render
   *  recomputes `ctx.snapBoundaries` from the echoed project — so mid-gesture the
   *  live boundary list contains the dragged item's own CURRENT edges, not just
   *  its press-time ones. `itemSnapPoints` only excludes the press-time pair, so
   *  a gesture that read `ctx.snapBoundaries` live would find its own last
   *  position back in the magnet list and snap to itself. Capturing the list
   *  once, here, is what makes that exclusion complete. */
  snapBoundaries: readonly number[]
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

/**
 * The DOM's marker cycle, lifted from `handleScrubDoubleClick`: first
 * double-click places A, the second places B and completes the range, a third
 * starts over from a fresh A.
 */
export function cycleMarkers(
  markers: readonly [number | null, number | null],
  t: number,
): [number | null, number | null] {
  const [a, b] = markers
  if (a === null) return [t, null]
  if (b === null) return [a, t]
  return [t, null]
}

/** Snap targets for a gesture that moves an item: clip and audio boundaries,
 *  both markers, and the playhead — minus whatever the gesture is itself
 *  dragging, which would otherwise pin it to where it started.
 *
 *  Boundaries come from `press.snapBoundaries`, captured once at press time,
 *  NOT `ctx.snapBoundaries`. The host re-derives `ctx.snapBoundaries` from
 *  every echoed `projectChange`, so a live read would put the item's own
 *  moving edges back into the magnet list mid-gesture (see the `Press.
 *  snapBoundaries` doc). Markers and the playhead are read from `ctx` because
 *  neither can change during an item gesture. */
function itemSnapPoints(ctx: PointerContext, press: Press, exclude: readonly number[]): number[] {
  const points: number[] = [...press.snapBoundaries]
  for (const marker of ctx.markers) if (marker !== null) points.push(marker)
  points.push(ctx.playheadTime)
  return snapPointsExcluding(points, exclude)
}

/** Snap targets for dragging the playhead itself: boundaries and markers. */
function playheadSnapPoints(ctx: PointerContext): number[] {
  const points: number[] = [...ctx.snapBoundaries]
  for (const marker of ctx.markers) if (marker !== null) points.push(marker)
  return snapPointsExcluding(points, [])
}

/**
 * Is this visual row one the painter has faded out?
 *
 * With a marker placed and a primary selection somewhere, the DOM row carries
 * `opacity-30 pointer-events-none` — every OTHER row is both dimmed and inert,
 * so the marker flow can't be derailed by a stray click. `drawTimelineContent`
 * already reproduces the fade; this reproduces the inertness, using the same
 * predicate (draw.ts's `dimmed`) so the picture and the pointer agree. Audio
 * lanes are never dimmed — AudioTrackRow has no such class.
 */
function isDimmedRow(ctx: PointerContext, trackIdx: number | undefined): boolean {
  if (trackIdx === undefined) return false
  const primarySelectedId = ctx.selectedIds[0] ?? null
  if (primarySelectedId === null || ctx.markers[0] === null) return false
  const row = ctx.layout.rows.find(r => r.trackIdx === trackIdx)
  return row !== undefined && !row.items.some(item => item.id === primarySelectedId)
}

/** Downgrade a hit on an inert row to bare track area, so it seeks instead. */
function throughDimmedRows(hit: HitResult, ctx: PointerContext): HitResult {
  if (hit.kind !== 'item-body' && hit.kind !== 'item-edge') return hit
  if (!isDimmedRow(ctx, hit.trackIdx)) return hit
  return { kind: 'empty-row', t: hit.t, trackIdx: hit.trackIdx }
}

function replaceVisualItem(project: Project, id: string, patch: Partial<VisualItem>): Project {
  return {
    ...project,
    tracks: (project.tracks ?? []).map(track =>
      track.map(item => (item.id === id ? { ...item, ...patch } : item)),
    ),
  }
}

/** The items either side of `item` on its own track, in timeline order, and
 *  only when they actually touch it — a gap means there is no shared boundary
 *  to roll. Same adjacency rule `slideItem` uses in cuts.ts. */
function adjacentOnTrack(project: Project, item: VisualItem): { prev?: VisualItem; next?: VisualItem } {
  const track = (project.tracks ?? []).find(t => t.some(other => other.id === item.id))
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

// ── Gesture application ──────────────────────────────────────────────────

interface Applied {
  effects: PointerEffect[]
  snap: SnapState
  lastProject: Project
}

function noChange(snap: SnapState, lastProject: Project): Applied {
  return { effects: [], snap, lastProject }
}

/** Emit a live edit, unless the op clamped to a no-op and handed back the same
 *  project reference (which `rollEdit`/`slipItem`/`slideItem` all do). */
function change(next: Project, previous: Project, snap: SnapState): Applied {
  if (next === previous) return noChange(snap, previous)
  return { effects: [{ type: 'projectChange', project: next }], snap, lastProject: next }
}

function applyMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const item = press.hit.item
  if (!item || press.hit.trackIdx === undefined) return noChange(snap, lastProject)

  const duration = item.end - item.start
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const rawStart = clamp(item.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  const points = snapPointsForSpan(itemSnapPoints(ctx, press, [item.start, item.end]), duration)
  const snapped = applySnap(rawStart, points, ctx.viewport, snap, ctx.snapConfig)
  const start = clamp(snapped.time, 0, Math.max(0, ctx.totalDuration - duration))

  const next: Project = {
    ...lastProject,
    tracks: moveItemAcrossTracks({
      tracks: lastProject.tracks ?? [],
      item,
      start,
      end: start + duration,
      sourceTrackIdx: press.hit.trackIdx,
      dy: point.y - press.origin.y,
    }),
  }
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next }
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

  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next }
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
  return change(rolled, lastProject, snapped.state)
}

function applySlip(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const item = press.hit.item
  if (!item) return noChange(snap, lastProject)

  // Dragging right pulls the media rightwards under a fixed window, so EARLIER
  // frames come into view — the film-under-a-gate model every NLE uses. Hence
  // the sign flip. No snapping: the delta is source time, and every snap point
  // the timeline knows about is timeline time.
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  return change(slipItem(press.baseProject, item.id, -dt), lastProject, snap)
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
  return change(slid, lastProject, snapped.state)
}

function applyAudioMove(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const track = press.hit.track
  if (!track || press.hit.laneIdx === undefined) return noChange(snap, lastProject)

  const duration = track.end - track.start
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const rawStart = clamp(track.start + dt, 0, Math.max(0, ctx.totalDuration - duration))

  const points = snapPointsForSpan(itemSnapPoints(ctx, press, [track.start, track.end]), duration)
  const snapped = applySnap(rawStart, points, ctx.viewport, snap, ctx.snapConfig)
  const start = clamp(snapped.time, 0, Math.max(0, ctx.totalDuration - duration))

  // Positive dy is downward, which in the audio stack means a HIGHER lane index
  // (lanes ascend downward) — the opposite of visual tracks.
  const laneDelta = Math.round((point.y - press.origin.y) / AUDIO_LANE_HEIGHT_PX)
  const next = updateAudioTrack(press.baseProject, track.id, {
    start,
    end: start + duration,
    lane: Math.max(0, press.hit.laneIdx + laneDelta),
  })
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next }
}

function applyAudioTrim(ctx: PointerContext, press: Press, point: Point, snap: SnapState, lastProject: Project): Applied {
  const track = press.hit.track
  if (!track || !press.hit.edge) return noChange(snap, lastProject)

  const edge = press.hit.edge === 'in' ? 'start' : 'end'
  const initTime = edge === 'start' ? track.start : track.end
  const dt = (point.x - press.origin.x) / ctx.viewport.pxPerSecond
  const raw = clamp(initTime + dt, 0, ctx.totalDuration)
  const snapped = applySnap(raw, itemSnapPoints(ctx, press, [track.start, track.end]), ctx.viewport, snap, ctx.snapConfig)

  // Audio tracks are never type 'video', so `computeResizedItem` only moves the
  // timeline edge; the source window is AudioTrackRow's own math, reproduced.
  const resized = computeResizedItem(track as Draggable, edge, snapped.time)
  const inPoint = track.inPoint ?? 0
  const outPoint = track.outPoint ?? inPoint + (track.end - track.start)
  const changes: Partial<AudioTrack> = { start: resized.start, end: resized.end, inPoint, outPoint }
  if (edge === 'start') {
    changes.inPoint = Math.max(0, Math.min(inPoint + (resized.start - track.start), outPoint - 0.1))
  } else {
    changes.outPoint = Math.max(
      inPoint + 0.1,
      Math.min(outPoint + (resized.end - track.end), track.sourceDuration ?? Infinity),
    )
  }

  let next = updateAudioTrack(press.baseProject, track.id, changes)
  if (ctx.selectedIds.length > 1 && ctx.selectedIds.includes(track.id)) {
    next = applyResizeDeltaToSelection(next, track.id, ctx.selectedIds, edge, {
      dStart: edge === 'start' ? resized.start - track.start : 0,
      dEnd: edge === 'end' ? resized.end - track.end : 0,
    })
  }
  return { effects: [{ type: 'projectChange', project: next }], snap: snapped.state, lastProject: next }
}

function applyScrub(ctx: PointerContext, point: Point, snap: SnapState, lastProject: Project): Applied {
  const raw = clamp(xToTime(point.x, ctx.viewport), 0, ctx.totalDuration)
  const snapped = applySnap(raw, playheadSnapPoints(ctx), ctx.viewport, snap, ctx.snapConfig)
  return { effects: [{ type: 'seek', time: snapped.time }], snap: snapped.state, lastProject }
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
    return withCursor({ kind: 'idle', cursor: state.cursor }, initialMachineState().cursor, [])
  }

  const { point, modifiers, ctx } = event

  // Mid-drag moves are the hot path (one per pointer event, all gesture) and
  // have no use for a hit result, so they take the early exit before one is
  // computed.
  if (event.type === 'pointerMove' && state.kind === 'dragging') {
    const applied = applyGesture(state.gesture, ctx, state.press, point, state.snap, state.lastProject)
    return {
      state: { ...state, snap: applied.snap, lastProject: applied.lastProject },
      effects: applied.effects,
    }
  }

  const hit = throughDimmedRows(hitTest(point, ctx.layout, ctx.viewport, ctx.hitTestOptions), ctx)

  switch (event.type) {
    case 'pointerDown': {
      // Empty timeline: seek straight away and keep scrubbing. The canvas has
      // no playhead handle of its own (the DOM scrubber above it stays whole-
      // project chrome), so pressing the surface IS grabbing the playhead. The
      // DOM's click-to-seek landed on mouseup; landing it on mousedown is the
      // same destination one event earlier, and it makes the drag continuous.
      if (isEmptyHit(hit)) {
        const applied = applyScrub(ctx, point, createSnapState(), ctx.project)
        const next: MachineState = {
          kind: 'dragging',
          cursor: state.cursor,
          press: {
            origin: point,
            modifiers,
            hit,
            baseProject: ctx.project,
            wasSelected: false,
            snapBoundaries: ctx.snapBoundaries,
          },
          gesture: 'scrub',
          snap: applied.snap,
          lastProject: ctx.project,
        }
        return withCursor(next, cursorForGesture('scrub'), applied.effects)
      }

      // On an item: nothing happens yet. Whether this is a click (select) or a
      // drag (edit) is not knowable until the pointer moves or lifts.
      const press: Press = {
        origin: point,
        modifiers,
        hit,
        baseProject: ctx.project,
        wasSelected: hit.itemId !== undefined && ctx.selectedIds.includes(hit.itemId),
        snapBoundaries: ctx.snapBoundaries,
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
        lastProject: applied.lastProject,
      }
      return withCursor(next, cursorForGesture(gesture), applied.effects)
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
        return withCursor({ kind: 'idle', cursor: state.cursor }, cursorForHit(hit), effects)
      }

      return withCursor(state, cursorForHit(hit), [])
    }

    case 'doubleClick': {
      // A clip or bar opens its inspector (the DOM item's own dblclick handler,
      // which stopped propagation so no marker was placed). Everything else is
      // timeline background and cycles the A/B markers — including empty audio
      // lanes, which the DOM left inert only because no handler happened to be
      // bound there.
      if (hit.itemId !== undefined) {
        const target = hit.kind === 'item-body' || hit.kind === 'item-edge' ? 'visual' : 'audio'
        return { state, effects: [{ type: 'inspect', target, id: hit.itemId }] }
      }
      return {
        state,
        effects: [{ type: 'markers', markers: cycleMarkers(ctx.markers, clamp(hit.t, 0, ctx.totalDuration)) }],
      }
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
