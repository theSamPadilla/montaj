// Removing a whole track from the timeline (right-click on a track header).
// Pure model functions; the menu and confirm dialog live in TrackContextMenu
// and ui/ConfirmDialog.
//
// Audio lanes: removing a lane drops every AudioTrack in it and does NOT
// renumber the others. `groupAudioLanes` sorts by lane number and tolerates
// gaps, and shifting explicit lanes could collide with the lanes it hands to
// tracks that carry none.

import type { Project } from '../../types'
import { groupAudioLanes, normalizeTrackOrder, normalizeTracks, trackItems } from './timeline-model'

/** A visual track counts as video when it holds a video item or is empty. */
function isVideoTrack(items: readonly { type?: string }[]): boolean {
  return items.length === 0 || items.some(i => i.type === 'video')
}

export function visualTrackItemCount(project: Project, trackIdx: number): number {
  return trackItems(project)[trackIdx]?.length ?? 0
}

export function canRemoveVisualTrack(project: Project, trackIdx: number): boolean {
  const tracks = trackItems(project)
  const items = tracks[trackIdx]
  if (!items) return false
  if (!isVideoTrack(items)) return true
  return tracks.filter(isVideoTrack).length > 1
}

export function removeVisualTrack(project: Project, trackIdx: number): Project {
  if (!canRemoveVisualTrack(project, trackIdx)) return project
  const normalized = normalizeTracks(project)
  const tracks = (normalized.tracks ?? []).filter((_, i) => i !== trackIdx)
  return normalizeTrackOrder({ ...normalized, tracks })
}

function laneTrackIds(project: Project, laneIndex: number): string[] {
  const lane = groupAudioLanes(project.audio?.tracks ?? []).find(l => l.laneIndex === laneIndex)
  return lane ? lane.tracks.map(t => t.id) : []
}

export function audioLaneItemCount(project: Project, laneIndex: number): number {
  return laneTrackIds(project, laneIndex).length
}

export function canRemoveAudioLane(project: Project, laneIndex: number): boolean {
  const lanes = groupAudioLanes(project.audio?.tracks ?? [])
  return lanes.length > 1 && lanes.some(l => l.laneIndex === laneIndex)
}

export function removeAudioLane(project: Project, laneIndex: number): Project {
  if (!canRemoveAudioLane(project, laneIndex) || !project.audio) return project
  const drop = new Set(laneTrackIds(project, laneIndex))
  return {
    ...project,
    audio: { ...project.audio, tracks: (project.audio.tracks ?? []).filter(t => !drop.has(t.id)) },
  }
}
