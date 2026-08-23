import type { Project } from '../types'
import { computeDerivedTiming, groupAudioLanes } from './timeline/timeline-model'

/**
 * Collapse every MAGNETIC audio lane to gapless, non-overlapping clips.
 *
 * A lane (see `groupAudioLanes`) is magnetic when every one of its tracks
 * carries `magnetic: true` — the same "fanned out across the lane" shape
 * `AudioTrack.muted` already uses, so turning the gutter's magnet toggle on
 * for a lane with several tracks (a lane can hold more than one `AudioTrack`)
 * makes the whole row magnetic at once, never a mix.
 *
 * Only a magnetic lane's clips move, and only along the timeline: clips are
 * sorted by their current `start` (ties keep their original relative order —
 * see the decorate-with-index sort below) and butted end to end, ANCHORED at
 * the earliest clip's own start. That anchor is deliberate: it preserves a
 * leading gap before the first clip rather than snapping the whole row to 0,
 * so turning magnet on doesn't yank a lane that starts three seconds in back
 * to the top of the timeline. `inPoint`/`outPoint` (the SOURCE window) are
 * never touched — this only shifts where a clip sits on the timeline, never
 * re-windows what it plays.
 *
 * Non-magnetic lanes, `project.tracks`, and `project.captions` are untouched.
 * Idempotent and identity-preserving: reflowing an already-gapless project
 * (or one with no magnetic lanes at all) returns the SAME `project`
 * reference, which matters because this runs on every canvas commit — a
 * fresh object on every no-op call would defeat any caller that compares by
 * reference to decide whether something changed.
 */
export function reflowMagneticLanes<P extends Project>(project: P): P {
  const tracks = project.audio?.tracks
  if (!tracks || tracks.length === 0) return project

  const lanes = groupAudioLanes(tracks, computeDerivedTiming(project).contentDuration)
  const updates = new Map<string, { start: number; end: number }>()

  for (const lane of lanes) {
    if (lane.tracks.length === 0) continue
    if (!lane.tracks.every(t => t.magnetic === true)) continue

    // Stable sort by start: decorate with the original index so two clips
    // sharing a start keep their existing relative order rather than
    // whatever order the sort happens to leave equal keys in.
    const sorted = lane.tracks
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t.start - b.t.start || a.i - b.i)
      .map(({ t }) => t)

    let cursor = sorted[0].start
    for (const clip of sorted) {
      const duration = clip.end - clip.start
      const newStart = cursor
      if (Math.abs(newStart - clip.start) > 1e-6) {
        updates.set(clip.id, { start: newStart, end: newStart + duration })
      }
      cursor = newStart + duration
    }
  }

  if (updates.size === 0) return project

  return {
    ...project,
    audio: {
      ...project.audio,
      tracks: tracks.map(t => {
        const change = updates.get(t.id)
        return change ? { ...t, ...change } : t
      }),
    },
  }
}
