// Multi-select project mutations shared by the canvas pointer machine
// (canvas/pointer-machine.ts) and Timeline.tsx.
//
// Selection IDs are unified — a single `selectedIds: string[]` covers visual
// items (project.tracks[*][*]), audio tracks (project.audio.tracks[*]) and
// caption segments (project.captions.segments[*]).
// Cross-type ops (e.g. resize a video clip + an audio track in one drag) work
// because every id is globally unique within a Project. Captions join only the
// MOVE op: mute, delete and resize are still clip/audio vocabulary.

import type { VisualItem, AudioTrack, CaptionSegment, Captions } from '../../schema'
import type { Project } from '../../types'
import { laneOf } from '../captionLanes'
import { mapTrackItems, normalizeTrackOrder, trackItems } from './timeline-model'
import { computeResizedItem, resizeWindowedItem, type Draggable } from './useItemDragDrop'


export interface ResizeDeltas {
  /** Delta in seconds applied to start-edge resizes. 0 if edge !== 'start'. */
  dStart: number
  /** Delta in seconds applied to end-edge resizes. 0 if edge !== 'end'. */
  dEnd: number
}

/** Apply a start/end resize delta to every item in `selectedIds`, skipping the
 *  originator (already updated by the hook's onLivePreview). Returns a new
 *  Project. Clamps each item to its own min-duration and source-duration. */
export function applyResizeDeltaToSelection(
  project: Project,
  originatorId: string,
  selectedIds: readonly string[],
  edge: 'start' | 'end',
  deltas: ResizeDeltas,
): Project {
  if (selectedIds.length <= 1) return project
  const targets = new Set(selectedIds.filter(id => id !== originatorId))
  if (targets.size === 0) return project

  const nextTracks = mapTrackItems(project, items =>
    items.map(item => targets.has(item.id) ? resizeVisualItem(item, edge, deltas) : item)
  )
  const nextAudio = (project.audio?.tracks ?? []).map(t =>
    targets.has(t.id) ? resizeAudioTrack(t, edge, deltas) : t
  )

  return {
    ...project,
    tracks: nextTracks,
    audio: project.audio ? { ...project.audio, tracks: nextAudio } : project.audio,
  }
}

/** Delegates to `computeResizedItem` so the span/window invariant is enforced
 *  in ONE place. This used to hand-roll the same arithmetic with the same
 *  independent clamps on the edge and the window, and therefore the same bug:
 *  propagating a trim to the rest of a multi-selection could stretch a clip's
 *  timeline span past the source it actually has. The only thing added here is
 *  the timeline floor at t=0, applied to the REQUESTED time so the shared
 *  function still does all the clamping that matters. */
function resizeVisualItem(item: VisualItem, edge: 'start' | 'end', { dStart, dEnd }: ResizeDeltas): VisualItem {
  const requested = edge === 'start'
    ? Math.max(0, item.start + dStart)
    : item.end + dEnd
  return computeResizedItem(item as Draggable, edge, requested) as VisualItem
}

/** As `resizeVisualItem`, but an audio track is always source-windowed — there
 *  is no "no window" case to fall through to, so it goes straight to
 *  `resizeWindowedItem` rather than through the video/non-video branch. */
function resizeAudioTrack(track: AudioTrack, edge: 'start' | 'end', { dStart, dEnd }: ResizeDeltas): AudioTrack {
  const requested = edge === 'start'
    ? Math.max(0, track.start + dStart)
    : track.end + dEnd
  return resizeWindowedItem(track as unknown as Draggable, edge, requested) as unknown as AudioTrack
}

/**
 * How far the SELECTED captions, as a group, may travel before any one of them
 * would cross a NON-selected caption's edge IN ITS OWN LANE.
 *
 * Captions must never overlap WITHIN A LANE. `activeCaptionSegments`
 * (timeline-core) hands the preview and every render template EVERY segment
 * live at `t`, ordered by lane ascending — a lane is a z-order and carries no
 * vertical offset of its own — so two segments overlapping in one lane paint
 * at the same place, one straight over the other, in preview AND in export.
 * With transcripts back-to-back by default that is not an edge case. Segments
 * on DIFFERENT lanes coinciding is the feature caption rows exist for (each
 * carries its own `offsetX`/`offsetY`), so a segment in lane 1 is not a bound
 * on a segment in lane 0 and must not stop it moving.
 *
 * For each selected segment this finds its nearest NON-selected same-lane
 * neighbour on either side (greatest `end <= seg.start` on the left, smallest
 * `start >= seg.end` on the right) and how much room that neighbour leaves.
 * The group bound is the TIGHTEST of those per-segment rooms — same shape as
 * the extent scan below: one number covers the whole body. Selected ids are
 * excluded from the neighbour search on BOTH sides (a selected segment is
 * never treated as another selected segment's neighbour, itself included);
 * that is what lets a run of adjacent selected captions move rigidly, stopping
 * only at the first caption not coming along for the ride, rather than jamming
 * against each other one gap in. Absent neighbour reads as unbounded
 * (`Infinity`) on that side.
 *
 * Lanes are read through `laneOf`, never off `seg.lane` directly, so an absent
 * or hand-edited value collapses the same way it does everywhere else.
 */
function captionNeighbourBounds(
  captions: Captions | undefined,
  targets: ReadonlySet<string>,
): { maxLeft: number; maxRight: number } {
  const segments = captions?.segments ?? []
  let maxLeft = Infinity
  let maxRight = Infinity
  for (const seg of segments) {
    if (seg.id === undefined || !targets.has(seg.id)) continue
    const lane = laneOf(seg)
    let leftEnd = -Infinity
    let rightStart = Infinity
    for (const other of segments) {
      // Skips every selected segment, this one included — see the WHY above.
      if (other.id !== undefined && targets.has(other.id)) continue
      // …and every segment on another row: overlap across lanes is legal.
      if (laneOf(other) !== lane) continue
      if (other.end <= seg.start && other.end > leftEnd) leftEnd = other.end
      if (other.start >= seg.end && other.start < rightStart) rightStart = other.start
    }
    if (leftEnd > -Infinity) maxLeft = Math.min(maxLeft, seg.start - leftEnd)
    if (rightStart < Infinity) maxRight = Math.min(maxRight, rightStart - seg.end)
  }
  return { maxLeft, maxRight }
}

/**
 * Shift every selected visual item, audio track and caption segment by the same
 * timeline delta, preserving their relative positions — a rigid move of the
 * whole selection.
 *
 * The delta is clamped ONCE, against the group as a body: the leftmost selected
 * start cannot cross t=0 and the rightmost selected end cannot cross
 * `totalDuration`, so the selection keeps its shape at the edges instead of
 * bunching up when one member hits a wall. Cross-track (vertical) movement is
 * deliberately not part of a group move — every item stays on its own
 * track/lane, which is the predictable behaviour when several move at once.
 *
 * The SAME clamp also folds in `captionNeighbourBounds`: a selected caption may
 * not cross a non-selected one SHARING ITS LANE, so a group that includes
 * captions is clamped by whichever is tighter, the timeline edge or a
 * same-lane caption neighbour. Vertical movement is not part of a group move
 * for captions either — every segment keeps the lane it started in, so a
 * multi-selection drag never changes rows however far the pointer travels up
 * or down (`applyCaptionMove` in canvas/pointer-machine.ts owns the one gesture
 * that does).
 *
 * The caller rebuilds from the press-time project on every move, so dragging
 * back and forth cannot compound.
 */
export function applyMoveDeltaToSelection(
  project: Project,
  selectedIds: readonly string[],
  requestedDelta: number,
  totalDuration: number,
): Project {
  const targets = new Set(selectedIds)
  if (targets.size === 0) return project

  // The group's extent, so one clamp keeps every member on the timeline.
  let minStart = Infinity
  let maxEnd = -Infinity
  // `id` is optional only because `CaptionSegment.id` is (a segment briefly
  // lacks one before `backfillCaptionIds` mints it). An id-less member can
  // never be in `selectedIds`, so it simply never counts toward the extent.
  const consider = (it: { id?: string; start: number; end: number }) => {
    if (it.id === undefined || !targets.has(it.id)) return
    if (it.start < minStart) minStart = it.start
    if (it.end > maxEnd) maxEnd = it.end
  }
  for (const items of trackItems(project)) items.forEach(consider)
  for (const t of project.audio?.tracks ?? []) consider(t)
  // Captions join the SAME extent scan, so one clamp covers a mixed
  // clip+caption selection rather than letting the captions slide past t=0
  // while the clips hold.
  for (const seg of project.captions?.segments ?? []) consider(seg)
  // None of the selected ids are actually present (e.g. a stale selection).
  if (!Number.isFinite(minStart)) return project

  // The caption-neighbour bound folds into the SAME lo/hi the timeline edges
  // use below — one range, not two clamps in sequence (a second clamp would
  // undo the first, same reasoning `applyCaptionTrim` documents for its own
  // lo/hi). `maxLeft`/`maxRight` are `Infinity` when nothing selected is a
  // caption (or no neighbour exists), so `Math.max`/`Math.min` below are then
  // no-ops and the plain timeline-edge bound is all that's left.
  const { maxLeft, maxRight } = captionNeighbourBounds(project.captions, targets)

  const lo = Math.max(-minStart, -maxLeft)
  // Floored at 0: never push a member further out than it already is.
  // `totalDuration` is derived from clips and audio only (timeline-model.ts),
  // so a caption can legally outlast it (e.g. clips trimmed/deleted after
  // captioning) — for clips/audio `maxEnd` never exceeds `totalDuration`, but
  // an overhanging caption drives `maxEnd` past it, which without the floor
  // sends `hi` negative and drags the whole group backwards on a rightward
  // drag (or makes it un-movable when mixed with a clip at lo=0). Mirrors the
  // `Math.max(ctx.totalDuration, seg.end)` ceiling `applyCaptionTrim` already
  // uses for the same overhang case.
  const hi = Math.min(Math.max(0, totalDuration - maxEnd), maxRight)
  // A group already wider than the timeline (lo > hi) can't move without
  // pushing a member off an edge, so it doesn't. Same short-circuit now also
  // catches a group that can't move without crossing a caption neighbour.
  const delta = lo > hi ? 0 : Math.max(lo, Math.min(hi, requestedDelta))
  if (delta === 0) return project

  const shift = <T extends { id: string; start: number; end: number }>(it: T): T =>
    targets.has(it.id) ? { ...it, start: it.start + delta, end: it.end + delta } : it

  const captions = shiftCaptions(project.captions, targets, delta)
  return {
    ...project,
    tracks: mapTrackItems(project, items => items.map(shift)),
    audio: project.audio
      ? { ...project.audio, tracks: (project.audio.tracks ?? []).map(shift) }
      : project.audio,
    // Same reference back when no caption moved, so a clips-only group move
    // leaves `project.captions` byte-for-byte what it was — and stays
    // `undefined` on a project that has none.
    captions,
  }
}

/** The caption half of a group move. Word timings are ABSOLUTE seconds, so
 *  every word travels with its segment by the same delta; a move preserves
 *  duration, so nothing needs respreading. `text` is never touched, and
 *  neither is `lane` — it rides the spread untouched, which is what makes a
 *  group move horizontal-only for captions. */
function shiftCaptions(
  captions: Captions | undefined,
  targets: ReadonlySet<string>,
  delta: number,
): Captions | undefined {
  if (!captions) return captions
  let changed = false
  const segments = captions.segments.map(seg => {
    if (seg.id === undefined || !targets.has(seg.id)) return seg
    changed = true
    const next: CaptionSegment = { ...seg, start: seg.start + delta, end: seg.end + delta }
    if (seg.words) next.words = seg.words.map(w => ({ ...w, start: w.start + delta, end: w.end + delta }))
    return next
  })
  return changed ? { ...captions, segments } : captions
}

/** Set `muted` on every selected item to the given target value. Both visual
 *  items (`VisualItem.muted` is video-type-only but we just spread it; harmless
 *  on overlays/images that won't read it) and audio tracks are covered. */
export function applyMuteToSelection(
  project: Project,
  selectedIds: readonly string[],
  muted: boolean,
): Project {
  const targets = new Set(selectedIds)
  if (targets.size === 0) return project

  return {
    ...project,
    tracks: mapTrackItems(project, items =>
      items.map(item => targets.has(item.id) ? { ...item, muted } : item)
    ),
    audio: project.audio
      ? {
          ...project.audio,
          tracks: (project.audio.tracks ?? []).map(t => targets.has(t.id) ? { ...t, muted } : t),
        }
      : project.audio,
  }
}

/** Remove every selected item from both visual tracks and audio tracks.
 *  Visual tracks that become empty are pruned (matches existing single-delete
 *  behavior in Timeline.handleKeyDown). */
export function deleteSelection(project: Project, selectedIds: readonly string[]): Project {
  const targets = new Set(selectedIds)
  if (targets.size === 0) return project

  const next: Project = {
    ...project,
    // Prune, not a plain map: an emptied track collapses. The surviving TRACK
    // OBJECTS pass through the filter, so each keeps its own id and settings
    // rather than inheriting the ones a shifted index used to point at.
    tracks: mapTrackItems(project, items => items.filter(item => !targets.has(item.id)))
      .filter(track => track.items.length > 0),
    audio: project.audio
      ? {
          ...project.audio,
          tracks: (project.audio.tracks ?? []).filter(t => !targets.has(t.id)),
        }
      : project.audio,
  }
  // Re-group (Part B): a prune can change a track's coarse kind — a mixed
  // track that loses its only video item becomes overlay-kind — so the
  // canonical video-block/overlay-block invariant (`normalizeTrackOrder`) is
  // re-asserted here rather than assumed to survive every prune. A no-op
  // (same reference) when it already does.
  return normalizeTrackOrder(next)
}

/** Selection helper: toggle additive (shift-click) vs replace (plain click).
 *  - additive + already selected → remove from selection
 *  - additive + not selected → add to selection
 *  - !additive + sole selection of id → clear (re-clicking the only selected
 *    item deselects it, matching the prior single-select behavior)
 *  - !additive otherwise → selection becomes [id] */
export function toggleSelection(current: readonly string[], id: string, additive: boolean): string[] {
  const has = current.includes(id)
  if (additive) {
    return has ? current.filter(x => x !== id) : [...current, id]
  }
  if (has && current.length === 1) return []
  return [id]
}
