// Multi-select project mutations shared by VisualTrackRow and AudioTrackRow.
//
// Selection IDs are unified — a single `selectedIds: string[]` covers visual
// items (project.tracks[*][*]) and audio tracks (project.audio.tracks[*]).
// Cross-type ops (e.g. resize a video clip + an audio track in one drag) work
// because every id is globally unique within a Project.

import type { VisualItem, AudioTrack } from '../../schema'
import type { Project } from '../../types'

const MIN_DURATION = 0.1

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

  const nextTracks = (project.tracks ?? []).map(track =>
    track.map(item => targets.has(item.id) ? resizeVisualItem(item, edge, deltas) : item)
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

function resizeVisualItem(item: VisualItem, edge: 'start' | 'end', { dStart, dEnd }: ResizeDeltas): VisualItem {
  if (edge === 'start') {
    const newStart = Math.max(0, Math.min(item.start + dStart, item.end - MIN_DURATION))
    if (item.type !== 'video') return { ...item, start: newStart }
    const inP = item.inPoint ?? 0
    const outP = item.outPoint ?? (inP + (item.end - item.start))
    const dActual = newStart - item.start
    return {
      ...item,
      start: newStart,
      inPoint: Math.max(0, Math.min(inP + dActual, outP - MIN_DURATION)),
    }
  } else {
    const newEnd = Math.max(item.start + MIN_DURATION, item.end + dEnd)
    if (item.type !== 'video') return { ...item, end: newEnd }
    const inP = item.inPoint ?? 0
    const outP = item.outPoint ?? (inP + (item.end - item.start))
    const dActual = newEnd - item.end
    return {
      ...item,
      end: newEnd,
      outPoint: Math.max(inP + MIN_DURATION, Math.min(outP + dActual, item.sourceDuration ?? Infinity)),
    }
  }
}

function resizeAudioTrack(track: AudioTrack, edge: 'start' | 'end', { dStart, dEnd }: ResizeDeltas): AudioTrack {
  const inP = track.inPoint ?? 0
  const outP = track.outPoint ?? (inP + (track.end - track.start))
  const srcDur = track.sourceDuration ?? Infinity

  if (edge === 'start') {
    const newStart = Math.max(0, Math.min(track.start + dStart, track.end - MIN_DURATION))
    const dActual = newStart - track.start
    return {
      ...track,
      start: newStart,
      inPoint: Math.max(0, Math.min(inP + dActual, outP - MIN_DURATION)),
    }
  } else {
    const newEnd = Math.max(track.start + MIN_DURATION, track.end + dEnd)
    const dActual = newEnd - track.end
    return {
      ...track,
      end: newEnd,
      outPoint: Math.max(inP + MIN_DURATION, Math.min(outP + dActual, srcDur)),
    }
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
    tracks: (project.tracks ?? []).map(track =>
      track.map(item => targets.has(item.id) ? { ...item, muted } : item)
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
    tracks: (project.tracks ?? [])
      .map(track => track.filter(item => !targets.has(item.id)))
      .filter(track => track.length > 0),
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
