// The ONE placement rule shared by every entry point that drops brand-new
// footage onto the timeline — today the footage-bin drag in
// `canvas/TimelineCanvas.tsx`, and a filesystem drop landing in a later task.
// Both hand the pointer's drop time and (optionally) which row it released
// over to `placeDroppedClip` below and get back a project with the clip
// placed "where you dropped it, without stomping existing footage" — the
// exact rule lives in exactly one place instead of being reimplemented, and
// possibly drifting, at each drop site.
//
// Pure and DOM-free on purpose: no canvas, no DragEvent, no React — so the
// rule itself is unit-testable without simulating a real drag, and so a
// future THIRD drop entry point (there will be one) has nothing to
// reimplement either.

import type { Project } from '../../types'
import type { VisualTrack } from '../../schema'
import { insertClipAt, overlapsAny, type NewClipInput } from '../cuts'
import { normalizeTracks, nextVisualTrackId } from './timeline-model'

/** What a drop needs to tell `placeDroppedClip` about ITSELF — the pointer's
 *  drop time, which row (if any) it released over, and the magnet/snap state
 *  the caller already knows. Everything geometry-shaped (pixel→time, pixel→
 *  row) is the caller's job; this module only ever sees seconds and track
 *  indices. */
export interface DroppedClipPlacement {
  /** Timeline time (seconds) the pointer released at. Clamped to >= 0. */
  atTime: number
  /** Index of the track the pointer released over, in the NORMALIZED track
   *  order (`normalizeTracks(project).tracks`). Pass -1 for "no preference"
   *  (e.g. released over the ruler, a caption band, or an audio lane). */
  preferredTrackIndex: number
  /** The footage to place. Its `sourceDuration` is the placed clip's length. */
  clip: NewClipInput
  /** Ripple/magnet mode — the editor's `rippleMode`. Default false. */
  ripple?: boolean
  /** Candidate snap targets in seconds (clip edges, the playhead), supplied by
   *  the caller because this module knows nothing about the viewport. */
  snapTimes?: readonly number[]
  /** Max distance (seconds) at which `atTime` is pulled to a `snapTimes`
   *  entry. Omitted / <= 0 disables snapping. */
  snapToleranceSec?: number
}

/** What `placeDroppedClip` did. */
export interface PlacedClipResult<P extends Project> {
  /** The updated project. The SAME reference as the input when nothing was
   *  placed (see `trackIndex`). */
  project: P
  /** Index of the track the clip landed on, in the RETURNED project's
   *  normalized order. `-1` means nothing was placed. */
  trackIndex: number
  /** The placed clip's start time on the timeline. `0` when nothing was placed. */
  start: number
  /** The placed item's id. Absent when nothing was placed. */
  itemId?: string
  /** True when a NEW video track had to be created to hold the clip. */
  createdTrack: boolean
}

/** The no-op result every early return below hands back — same project
 *  reference, nothing placed. */
function nothingPlaced<P extends Project>(project: P): PlacedClipResult<P> {
  return { project, trackIndex: -1, start: 0, createdTrack: false }
}

/**
 * Snap `atTime` to the nearest `snapTimes` entry within `snapToleranceSec`,
 * ties going to the SMALLER time (deterministic — two equidistant snap
 * targets must resolve the same way on every call, not by array-scan order).
 * Falls through to `atTime` unchanged when snapping is disabled (no
 * `snapTimes`, or a tolerance that is absent/<= 0) or nothing is in range.
 *
 * Exported (and typed against a `Pick` rather than the full
 * `DroppedClipPlacement`) so a caller that doesn't yet know WHAT is being
 * placed can still snap the drop point itself — `TimelineCanvas`'s OS-file
 * drop branch has no `clip` at drop time (the file hasn't been probed or
 * ingested yet), but still wants the ghost band and the eventual placement to
 * land on the same magnetized second a bin drop would.
 */
export function resolveDropPoint({
  atTime,
  snapTimes,
  snapToleranceSec,
}: Pick<DroppedClipPlacement, 'atTime' | 'snapTimes' | 'snapToleranceSec'>): number {
  if (!snapTimes || snapTimes.length === 0 || !(snapToleranceSec! > 0)) return atTime

  let best: number | null = null
  let bestDist = Infinity
  for (const t of snapTimes) {
    const dist = Math.abs(t - atTime)
    if (dist > snapToleranceSec!) continue
    if (dist < bestDist || (dist === bestDist && (best === null || t < best))) {
      best = t
      bestDist = dist
    }
  }
  return best ?? atTime
}

/**
 * A track at `index` is a video-placement CANDIDATE when either it already
 * carries a video item (`trackGroupKind`'s own rule, timeline-model.ts), or
 * it is the empty base row (`index === 0` with no items at all) —
 * `computeTimelineLayout` (canvas/draw.ts) already draws that row tall,
 * i.e. treats it as video-kind, regardless of content. Overlay/image tracks
 * are never candidates. Captions and audio don't live in `project.tracks` at
 * all, so they can never be selected here — there is nothing to exclude them
 * with, they simply aren't in the array this function scans.
 */
function isVideoCandidate(track: VisualTrack, index: number): boolean {
  return track.items.some(it => it.type === 'video') || (index === 0 && track.items.length === 0)
}

/**
 * Pick the candidate index minimizing `(|i - ref|, i)` — closest to `ref`
 * first, lower index breaking a tie. `candidates` must be non-empty.
 *
 * Index distance stands in for on-screen distance: rows differ in rendered
 * height (120px for the base video row, 40px for the rest), but the video
 * block is contiguous from index 0 after normalization (`normalizeTracks`),
 * so ordering by index distance orders the candidates the same way the eye
 * would order them by pixel distance.
 */
function closestByIndex(candidates: readonly number[], ref: number): number {
  return candidates.reduce((best, i) =>
    Math.abs(i - ref) < Math.abs(best - ref) || (Math.abs(i - ref) === Math.abs(best - ref) && i < best)
      ? i
      : best,
  )
}

/**
 * Insert `clip` onto the track `trackId` already names via `insertClipAt`,
 * then read back WHERE it actually landed — `insertClipAt` mints the placed
 * item's id itself and doesn't hand it back, so the placed item is found by
 * diffing the track's item ids before/after the call.
 *
 * Always re-normalizes the result before reading it back (`normalizeTracks`
 * is a no-op, same-reference return when order is already canonical — see
 * its own doc — so this costs nothing on the common path). That matters for
 * exactly one case here: dropping onto the empty base row (index 0) flips it
 * from overlay-kind to video-kind the moment it gains a video item, which can
 * move its position in the canonical video-block/overlay-block stack
 * (`orderedTrackArray`) — so the track's index has to be re-resolved by id,
 * never assumed stable across the insert.
 */
function placeOnTrack<P extends Project>(
  project: P,
  trackId: string,
  clip: NewClipInput,
  dropAt: number,
  ripple: boolean,
  createdTrack: boolean,
): PlacedClipResult<P> {
  const before = new Set(
    (normalizeTracks(project).tracks ?? []).find(t => t.id === trackId)?.items.map(it => it.id) ?? [],
  )
  const normalized = normalizeTracks(insertClipAt(project, trackId, clip, dropAt, { ripple }))
  const nextTracks = normalized.tracks ?? []
  const trackIndex = nextTracks.findIndex(t => t.id === trackId)
  const placedItem = trackIndex >= 0 ? nextTracks[trackIndex].items.find(it => !before.has(it.id)) : undefined

  return {
    project: normalized,
    trackIndex,
    start: placedItem?.start ?? 0,
    itemId: placedItem?.id,
    createdTrack,
  }
}

/**
 * Step 5 of the algorithm: no existing video track has room, so mint a fresh
 * one and place the clip there. The new track is appended empty (overlay-kind
 * by `trackGroupKind`, since it holds no items), then `placeOnTrack`'s own
 * re-normalize after the insert is what promotes it into the video block —
 * at the END of that block, i.e. the TOP-most video row, because
 * `orderedTrackArray` is a STABLE partition: the new track was the very last
 * element before the re-sort, so among video-kind tracks (which it now is)
 * it is still the last one encountered, and "last in the video group" is the
 * highest index in a contiguous video-first stack.
 */
function placeOnNewTrack<P extends Project>(
  project: P,
  tracks: readonly VisualTrack[],
  clip: NewClipInput,
  dropAt: number,
  ripple: boolean,
): PlacedClipResult<P> {
  const newId = nextVisualTrackId(tracks)
  const withNewTrack: P = { ...project, tracks: [...tracks, { id: newId, items: [] }] } as P
  return placeOnTrack(withNewTrack, newId, clip, dropAt, ripple, true)
}

/**
 * Place a single newly-dropped clip on the timeline, following the shared
 * drop rule (see the module doc comment above for who calls this).
 *
 * Pure: never mutates `project`, its tracks/items, or `placement.clip`.
 *
 * ALGORITHM
 * 0. Guard — `clip.sourceDuration` must be a finite number > 0, or nothing is
 *    placed (mirrors the guard the canvas drop handler and the host's
 *    `FootagePanel.hasPlaceableDuration` already apply before a drag even
 *    starts).
 * 1. Resolve the drop point: snap `atTime` to the nearest in-tolerance
 *    `snapTimes` entry (see `resolveDropPoint`), then clamp to `>= 0`.
 * 2. Gather video-placement candidate tracks (see `isVideoCandidate`).
 * 3. `ref` — the preferred index if given, else 0 — is the point every
 *    "closest" measurement below is relative to.
 * 4a. Ripple ON: the preferred track if it's a candidate, else the closest
 *     candidate (ties → lower index), else mint a new track. Collision never
 *     disqualifies a candidate here — ripple means "push what's in the way",
 *     so there is nothing to collide with.
 * 4b. Ripple OFF: the closest candidate (ties → lower index) whose
 *     `[dropAt, dropAt + sourceDuration]` window is free of existing items
 *     (`overlapsAny`, cuts.ts — same EPSILON tolerance every other placement
 *     op in this codebase uses). No free candidate → mint a new track.
 * 5. New track: see `placeOnNewTrack`.
 */
/**
 * Where a dropped clip WOULD land, WITHOUT placing it — the resolved
 * video-track index in normalized order, or `normalizeTracks(project).tracks.length`
 * (a row that does not exist yet) when a NEW video track would be created.
 *
 * This is the EXACT selection `placeDroppedClip` makes (it calls this), so a
 * caller can draw a pre-ingest ghost band on the row the real clip will land on
 * instead of wherever the pointer happened to be — a filesystem drop that
 * released over an overlay/image row must still ghost on a VIDEO row, because
 * that is where the clip resolves to. `closestByIndex` here, and the ghost
 * renderer's own "unknown index falls back to the base video row" (see
 * `pendingDropBands`), together guarantee the ghost never sits on an overlay
 * row. `clip.sourceDuration` matters only in the ripple-OFF free-gap test —
 * pass the ghost's fast local probe.
 */
export function resolveDropTrackIndex<P extends Project>(
  project: P,
  placement: Pick<DroppedClipPlacement, 'atTime' | 'preferredTrackIndex' | 'ripple' | 'snapTimes' | 'snapToleranceSec'>
    & { clip: Pick<NewClipInput, 'sourceDuration'> },
): number {
  const { clip, ripple = false, preferredTrackIndex } = placement
  const dropAt = Math.max(0, resolveDropPoint(placement))
  const tracks = normalizeTracks(project).tracks ?? []
  const candidateIdxs: number[] = []
  tracks.forEach((t, i) => { if (isVideoCandidate(t, i)) candidateIdxs.push(i) })
  const ref = preferredTrackIndex >= 0 ? preferredTrackIndex : 0

  if (ripple) {
    // Ripple ON — collision never disqualifies a candidate.
    if (candidateIdxs.includes(preferredTrackIndex)) return preferredTrackIndex
    if (candidateIdxs.length > 0) return closestByIndex(candidateIdxs, ref)
    return tracks.length // no video row exists ⇒ a fresh one would be created
  }

  // Ripple OFF — only a candidate whose drop window is actually free.
  const freeIdxs = candidateIdxs.filter(
    i => !overlapsAny(dropAt, dropAt + clip.sourceDuration, tracks[i].items),
  )
  if (freeIdxs.length === 0) return tracks.length
  return closestByIndex(freeIdxs, ref)
}

export function placeDroppedClip<P extends Project>(
  project: P,
  placement: DroppedClipPlacement,
): PlacedClipResult<P> {
  const { clip, ripple = false } = placement

  // 0. Guard — an unplaceable clip places nothing, by reference.
  if (!(Number.isFinite(clip.sourceDuration) && clip.sourceDuration > 0)) return nothingPlaced(project)

  // 1. Drop point + target row. The row is resolved by `resolveDropTrackIndex`
  // so placement and the pre-ingest ghost band can never diverge.
  const dropAt = Math.max(0, resolveDropPoint(placement))
  const tracks = normalizeTracks(project).tracks ?? []
  const targetIdx = resolveDropTrackIndex(project, placement)

  // targetIdx past the end of the (same, normalized) array ⇒ no existing video
  // row fits ⇒ a new track is created.
  if (targetIdx >= tracks.length) return placeOnNewTrack(project, tracks, clip, dropAt, ripple)
  return placeOnTrack(project, tracks[targetIdx].id, clip, dropAt, ripple, false)
}
