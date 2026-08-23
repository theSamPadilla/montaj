// Multi-select project mutations shared by VisualTrackRow and AudioTrackRow.
//
// Selection IDs are unified — a single `selectedIds: string[]` covers visual
// items (project.tracks[*][*]) and audio tracks (project.audio.tracks[*]).
// Cross-type ops (e.g. resize a video clip + an audio track in one drag) work
// because every id is globally unique within a Project.

import type { VisualItem, AudioTrack } from '../../schema'
import type { Project } from '../../types'
import { mapTrackItems, trackItems } from './timeline-model'
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
 * Shift every selected visual item and audio track by the same timeline delta,
 * preserving their relative positions — a rigid move of the whole selection.
 *
 * The delta is clamped ONCE, against the group as a body: the leftmost selected
 * start cannot cross t=0 and the rightmost selected end cannot cross
 * `totalDuration`, so the selection keeps its shape at the edges instead of
 * bunching up when one member hits a wall. Cross-track (vertical) movement is
 * deliberately not part of a group move — every item stays on its own
 * track/lane, which is the predictable behaviour when several move at once.
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
  const consider = (it: { id: string; start: number; end: number }) => {
    if (!targets.has(it.id)) return
    if (it.start < minStart) minStart = it.start
    if (it.end > maxEnd) maxEnd = it.end
  }
  for (const items of trackItems(project)) items.forEach(consider)
  for (const t of project.audio?.tracks ?? []) consider(t)
  // None of the selected ids are actually present (e.g. a stale selection).
  if (!Number.isFinite(minStart)) return project

  const lo = -minStart
  const hi = totalDuration - maxEnd
  // A group already wider than the timeline (lo > hi) can't move without
  // pushing a member off an edge, so it doesn't.
  const delta = lo > hi ? 0 : Math.max(lo, Math.min(hi, requestedDelta))
  if (delta === 0) return project

  const shift = <T extends { id: string; start: number; end: number }>(it: T): T =>
    targets.has(it.id) ? { ...it, start: it.start + delta, end: it.end + delta } : it

  return {
    ...project,
    tracks: mapTrackItems(project, items => items.map(shift)),
    audio: project.audio
      ? { ...project.audio, tracks: (project.audio.tracks ?? []).map(shift) }
      : project.audio,
  }
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

  return {
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
