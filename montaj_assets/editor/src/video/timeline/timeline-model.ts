// Pure timeline math shared by the DOM track-row area (today) and the canvas
// track-row area (T4 — see Timeline.tsx's `timeline` flag). Anything lifted
// here is behavior BOTH surfaces must reproduce identically, so it lives
// outside either render path.

import type { AudioTrack, VisualItem } from '../../schema'
import type { Project } from '../../types'

// ── Row geometry ─────────────────────────────────────────────────────────
// Named constants for the row-height magic numbers used in cross-row drag
// math (VisualTrackRow, AudioTrackRow). Centralized so the canvas painter
// (T4) draws rows at the same height the DOM rows use today.

/** Vertical travel, in px, that a cross-track drag must cover to move an item
 *  one visual track. NOT the rendered row height (see
 *  VISUAL_ROW_RENDER_HEIGHT_PX) — it is deliberately shorter than the row so a
 *  drag reaches the neighbouring track before the cursor fully leaves the
 *  current one. Lifted verbatim from VisualTrackRow's drag math. */
export const VISUAL_ROW_HEIGHT_PX = 24

/** Audio-lane row height in px — matches the `h-10` (2.5rem = 40px) Tailwind
 *  class on AudioTrackRow's row container. Doubles as the lane-index drag
 *  divisor (drag travel and rendered height coincide for audio lanes). */
export const AUDIO_LANE_HEIGHT_PX = 40

/** Rendered height of a visual track row — the `h-10` on `trackRow`
 *  (utils.ts). The canvas painter draws rows at this height so both surfaces
 *  look alike. */
export const VISUAL_ROW_RENDER_HEIGHT_PX = 40

/** Rendered height of the BASE visual track (index 0) — the `h-14` on
 *  `trackRowTall`. The base video track is drawn taller than the overlay
 *  tracks stacked above it. */
export const BASE_VISUAL_ROW_RENDER_HEIGHT_PX = 56

/** Vertical gap between rows — the `gap-1` (0.25rem = 4px) on the DOM track
 *  list's flex column. */
export const ROW_GAP_PX = 4

// ── Audio lane grouping ──────────────────────────────────────────────────

export interface AudioLane {
  laneIndex: number
  tracks: AudioTrack[]
}

/**
 * Group audio tracks into rendered lanes, in ascending lane order. Tracks
 * carrying an explicit `lane` keep it; the rest are auto-assigned lanes above
 * the highest explicit one, in array order. Lifted out of Timeline's inline
 * IIFE so the DOM rows and the canvas painter can't drift on which track lands
 * in which row.
 */
export function groupAudioLanes(tracks: AudioTrack[]): AudioLane[] {
  const laneMap = new Map<number, AudioTrack[]>()
  let nextAutoLane = 0
  for (const t of tracks) {
    if (t.lane != null && t.lane >= nextAutoLane) nextAutoLane = t.lane + 1
  }
  for (const t of tracks) {
    const lane = t.lane ?? nextAutoLane++
    if (!laneMap.has(lane)) laneMap.set(lane, [])
    laneMap.get(lane)!.push(t)
  }
  return [...laneMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([laneIndex, laneTracks]) => ({ laneIndex, tracks: laneTracks }))
}

// ── Cross-track move ─────────────────────────────────────────────────────

export interface CrossTrackMoveArgs {
  /** The project's visual tracks as they stand mid-drag. */
  tracks: VisualItem[][]
  /** The item being dragged, at its ORIGINAL props — only start/end change. */
  item: VisualItem
  /** The dragged item's new timeline window. */
  start: number
  end: number
  /** Which track the drag began on. */
  sourceTrackIdx: number
  /** Vertical travel of the drag in raw pixels (positive = downward). */
  dy: number
}

/**
 * Place a dragged item on the visual track its vertical travel points at,
 * searching outward for one where it does not collide.
 *
 * Extracted verbatim from VisualTrackRow's drag handler so the canvas pointer
 * machine (SP5 T5) lands items in exactly the same track the DOM rows would.
 * The rules it encodes, none of them obvious from the outside:
 *
 * - Vertical travel is divided by `VISUAL_ROW_HEIGHT_PX` (24), not the rendered
 *   row height, so a drag reaches the neighbouring track before the cursor has
 *   fully left the current one. Downward travel LOWERS the track index, because
 *   tracks are stacked with the highest index on top.
 * - "Collision" means overlapping an existing item by more than 30% of the
 *   dragged item's duration; brushing past a neighbour is allowed.
 * - When the target track is occupied the search fans out — one above, one
 *   below, then two, and so on — and one step past the end of the array is a
 *   legal answer, which is how a drag creates a new top track.
 * - Tracks left empty by the move are pruned, so dragging the last item off a
 *   track collapses it.
 */
export function moveItemAcrossTracks({ tracks, item, start, end, sourceTrackIdx, dy }: CrossTrackMoveArgs): VisualItem[][] {
  const trackDelta = Math.round(dy / VISUAL_ROW_HEIGHT_PX)
  const targetIdx = Math.max(0, sourceTrackIdx - trackDelta)
  const duration = end - start
  const overlapMin = duration * 0.3

  function hasOverlap(track: VisualItem[]): boolean {
    return track.some(other => {
      if (other.id === item.id) return false
      return Math.min(end, other.end) - Math.max(start, other.start) > overlapMin
    })
  }

  let bestIdx = targetIdx
  outer: for (let delta = 0; delta <= tracks.length; delta++) {
    for (const i of delta === 0 ? [targetIdx] : [targetIdx - delta, targetIdx + delta]) {
      if (i < 0) continue
      const candidateTrack = i < tracks.length ? tracks[i] : []
      if (!hasOverlap(candidateTrack)) { bestIdx = i; break outer }
    }
  }

  const removed = tracks.map(t => t.filter(other => other.id !== item.id))
  const movedItem = { ...item, start, end }
  const placed = bestIdx >= removed.length
    ? [...removed, [movedItem]]
    : removed.map((t, i) => i === bestIdx ? [...t, movedItem] : t)

  return placed.filter(t => t.length > 0)
}

// ── Audio track update ───────────────────────────────────────────────────

/** Patch one audio track by id, leaving the rest of the project alone. Shared
 *  by AudioTrackRow and the canvas pointer machine so audio edits take the same
 *  shape on both surfaces. */
export function updateAudioTrack(project: Project, trackId: string, changes: Partial<AudioTrack>): Project {
  return {
    ...project,
    audio: {
      ...project.audio,
      tracks: (project.audio?.tracks ?? []).map(t =>
        t.id === trackId ? { ...t, ...changes } : t,
      ),
    },
  }
}

// ── Derived timing ───────────────────────────────────────────────────────

export interface DerivedTiming {
  snapBoundaries: number[]
  contentDuration: number
  totalDuration: number
}

/** Snap boundaries, content duration, and the zoom/scroll-padded total
 *  duration for a project's tracks + audio. Lifted from the render-time memo
 *  that used to live inline in Timeline so the canvas surface (T4) computes
 *  timing identically to the DOM surface. */
export function computeDerivedTiming(project: Project): DerivedTiming {
  const allTracks = project.tracks ?? []
  const audioTracks = project.audio?.tracks ?? []
  const snapBoundaries = [...new Set([
    ...allTracks.flat().flatMap(c => [c.start, c.end]),
    ...audioTracks.flatMap(t => [t.start, t.end]),
  ])]
  const contentDuration = Math.max(
    allTracks.flat().reduce((m, i) => Math.max(m, i.end ?? 0), 0),
    audioTracks.reduce((m, t) => Math.max(m, t.end ?? 0), 0),
  )
  // Add 20% padding beyond content so the rightmost item can always be
  // dragged or resized further out. Minimum 5s headroom.
  const totalDuration = contentDuration + Math.max(5, contentDuration * 0.2)
  return { snapBoundaries, contentDuration, totalDuration }
}

// ── Auto-crossfade ───────────────────────────────────────────────────────

/**
 * Auto-crossfade: when two audio tracks overlap, apply fade-out on the
 * earlier track and fade-in on the later one, each equal to the overlap
 * duration. Lifted out of Timeline's render-time effect — previously a
 * hidden project mutation with no test coverage — so the canvas timeline
 * (T4) can't silently drop the behavior.
 *
 * Returns `null` — the no-change signal — when no track's fade needs to
 * change, so the caller's effect can skip calling `onProjectChange` and
 * avoid re-triggering itself forever.
 */
export function computeAutoCrossfade(project: Project): Project | null {
  const audioTracks = project.audio?.tracks ?? []
  if (!audioTracks.length) return null

  const sorted = [...audioTracks].sort((a, b) => a.start - b.start)
  let changed = false
  const updated = sorted.map(t => ({ ...t }))

  // We only auto-set fades where overlap exists
  for (let i = 0; i < updated.length - 1; i++) {
    const a = updated[i]
    const b = updated[i + 1]
    if (a.end > b.start && !a.muted && !b.muted) {
      // Overlap detected
      const overlap = Math.min(a.end - b.start, a.end - a.start, b.end - b.start)
      if ((a.fadeOut ?? 0) !== overlap) {
        a.fadeOut = Math.round(overlap * 10) / 10  // round to 0.1s
        changed = true
      }
      if ((b.fadeIn ?? 0) !== overlap) {
        b.fadeIn = Math.round(overlap * 10) / 10
        changed = true
      }
    }
  }

  if (!changed) return null

  const trackMap = new Map(updated.map(t => [t.id, t]))
  return {
    ...project,
    audio: {
      ...project.audio,
      tracks: audioTracks.map(t => trackMap.get(t.id) ?? t),
    },
  }
}
