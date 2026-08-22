// Multi-select project mutations shared by VisualTrackRow and AudioTrackRow.
//
// Selection IDs are unified — a single `selectedIds: string[]` covers visual
// items (project.tracks[*][*]) and audio tracks (project.audio.tracks[*]).
// Cross-type ops (e.g. resize a video clip + an audio track in one drag) work
// because every id is globally unique within a Project.

import type { VisualItem, AudioTrack } from '../../schema'
import type { Project } from '../../types'
import { mapTrackItems } from './timeline-model'
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
