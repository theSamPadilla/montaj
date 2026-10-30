// Removing a whole track from the timeline (right-click on a track header).
// Pure model functions; the menu and confirm dialog live in TrackContextMenu
// and ui/ConfirmDialog.
//
// Audio lanes: removing a lane drops every AudioTrack in it and does NOT
// renumber the others. `groupAudioLanes` sorts by lane number and tolerates
// gaps, and shifting explicit lanes could collide with the lanes it hands to
// tracks that carry none.
//
// Every audio function reads the rows as DRAWN: the project is stamped first
// (`stampAudioLanes`, same horizon as the painter), so a lane index is the row
// the person right-clicked, and the clips left behind keep their rows instead
// of re-packing once the removed ones are gone.

import type { Project } from '../../types'
import { groupAudioLanes, normalizeTrackOrder, normalizeTracks, stampAudioLanes, trackItems } from './timeline-model'

/** A visual track counts as video when it holds a video item or is empty. */
function isVideoTrack(items: readonly { type?: string }[]): boolean {
  return items.length === 0 || items.some(i => i.type === 'video')
}

export function visualTrackItemCount(project: Project, trackIdx: number): number {
  return trackItems(project)[trackIdx]?.length ?? 0
}

/** The base track (index 0) may hold only video and images. */
function baseIsValid(items: readonly { type?: string }[] | undefined): boolean {
  return !items || items.every(i => i.type === 'video' || i.type === 'image')
}

/** The tracks left after removing `trackIdx`: canonical order, and when the
 *  new base holds anything but video and images, the first empty track moved
 *  to the front. `null` when no valid base can be made. */
function tracksAfterRemoval(project: Project, trackIdx: number): Array<{ items: { type?: string }[] }> | null {
  const normalized = normalizeTrackOrder(normalizeTracks(project))
  const kept = ((normalized.tracks ?? []) as Array<{ items: { type?: string }[] }>).filter((_, i) => i !== trackIdx)
  if (baseIsValid(kept[0]?.items)) return kept
  const empty = kept.findIndex(t => t.items.length === 0)
  if (empty < 0) return null
  return [kept[empty], ...kept.filter((_, i) => i !== empty)]
}

export function canRemoveVisualTrack(project: Project, trackIdx: number): boolean {
  const tracks = trackItems(project)
  const items = tracks[trackIdx]
  if (!items) return false
  if (isVideoTrack(items) && tracks.filter(isVideoTrack).length <= 1) return false
  return tracksAfterRemoval(project, trackIdx) !== null
}

export function removeVisualTrack(project: Project, trackIdx: number): Project {
  if (!canRemoveVisualTrack(project, trackIdx)) return project
  const tracks = tracksAfterRemoval(project, trackIdx)
  if (!tracks) return project
  return { ...normalizeTracks(project), tracks: tracks as unknown as Project['tracks'] }
}

/** The id of visual track `trackIdx`, as the menu opened on it. */
export function visualTrackId(project: Project, trackIdx: number): string | null {
  const tracks = (normalizeTracks(project).tracks ?? []) as Array<{ id?: string }>
  return tracks[trackIdx]?.id ?? null
}

function visualTrackIndex(project: Project, trackId: string): number {
  return ((normalizeTracks(project).tracks ?? []) as Array<{ id?: string }>).findIndex(t => t.id === trackId)
}

/** Removes the visual track with id `trackId` (captured when the menu opened),
 *  so a save that moved the rows meanwhile never removes a different one. */
export function removeVisualTrackById(project: Project, trackId: string): Project {
  const idx = visualTrackIndex(project, trackId)
  return idx < 0 ? project : removeVisualTrack(project, idx)
}

export function visualTrackItemCountById(project: Project, trackId: string): number {
  const idx = visualTrackIndex(project, trackId)
  return idx < 0 ? 0 : visualTrackItemCount(project, idx)
}

/** The AudioTrack ids drawn on row `laneIndex`. */
export function audioLaneTrackIds(project: Project, laneIndex: number): string[] {
  const lane = groupAudioLanes(stampAudioLanes(project).audio?.tracks ?? []).find(l => l.laneIndex === laneIndex)
  return lane ? lane.tracks.map(t => t.id) : []
}

export function audioLaneItemCount(project: Project, laneIndex: number): number {
  return audioLaneTrackIds(project, laneIndex).length
}

export function canRemoveAudioLane(project: Project, laneIndex: number): boolean {
  const lanes = groupAudioLanes(stampAudioLanes(project).audio?.tracks ?? [])
  return lanes.length > 1 && lanes.some(l => l.laneIndex === laneIndex)
}

/** Removes the AudioTracks `ids` (the lane's, captured when the menu opened)
 *  from the stamped project, so what remains keeps its rows. Never the last
 *  audio left, as `canRemoveAudioLane` never offers the last lane. */
export function removeAudioTracksByIds(project: Project, ids: readonly string[]): Project {
  if (!project.audio) return project
  const stamped = stampAudioLanes(project)
  const all = stamped.audio?.tracks ?? []
  const drop = new Set(ids)
  const kept = all.filter(t => !drop.has(t.id))
  if (kept.length === all.length || kept.length === 0) return project
  return { ...stamped, audio: { ...stamped.audio, tracks: kept } }
}

/** Removes row `laneIndex` from the stamped project, so what remains carries
 *  explicit lanes and stays on the rows it was drawn on. */
export function removeAudioLane(project: Project, laneIndex: number): Project {
  if (!canRemoveAudioLane(project, laneIndex) || !project.audio) return project
  const stamped = stampAudioLanes(project)
  const drop = new Set(audioLaneTrackIds(stamped, laneIndex))
  return {
    ...stamped,
    audio: { ...stamped.audio, tracks: (stamped.audio?.tracks ?? []).filter(t => !drop.has(t.id)) },
  }
}
