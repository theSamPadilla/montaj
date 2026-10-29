// Array-valued keyframe tracks (§616). A path mask's `maskPoints` track keys
// point LISTS, not numbers, so everything that assumes `value` is a number
// (timeline-core's `normalizeTrack` drops a non-finite value, `sampleTrack`
// reads NaN) must route through here. The editor never authors or edits one:
// it only has to keep it intact, re-time it and sample it at a cut.

import { MASK_POINTS_PROP, normalizeTrack as coreNormalizeTrack, sampleTrack, samplePointsTrack, validPoints } from '@bycrux/timeline-core'
import type { Keyframe, KeyframeTrack } from '../schema'

/** True for a `maskPoints` track (its `prop` is not in the number-valued `KeyframeProp`). */
export function isPointsTrack(track: { prop: string } | null | undefined): boolean {
  return !!track && track.prop === MASK_POINTS_PROP
}

/** The same test on a bare prop name. */
export function isPointsProp(prop: string): boolean {
  return prop === MASK_POINTS_PROP
}

/** A keyframe's point-list value (typed as the number the schema says). */
function pointsOf(p: Keyframe): unknown {
  return p.value as unknown
}

/**
 * timeline-core's `normalizeTrack` (ascending by `t`, last wins on a tie) that
 * also works for a `maskPoints` track: it keeps keys whose value is a valid
 * point list, where the core one would drop them all as non-numbers.
 */
export function normalizeTrack(track: KeyframeTrack): KeyframeTrack
export function normalizeTrack(track: KeyframeTrack | undefined): KeyframeTrack | undefined
export function normalizeTrack(track: KeyframeTrack | undefined): KeyframeTrack | undefined {
  if (!track) return undefined
  if (!isPointsTrack(track)) return coreNormalizeTrack(track) as KeyframeTrack | undefined
  const usable = (Array.isArray(track.points) ? track.points : [])
    .filter(p => !!p && Number.isFinite(p.t) && validPoints(pointsOf(p)))
    .sort((a, b) => a.t - b.t)
  const points = usable.filter((p, i) => !(i + 1 < usable.length && usable[i + 1].t === p.t))
  return { ...track, points }
}

/**
 * The value of `track` at item-relative `t` as a keyframe value: the sampled
 * number, or for a `maskPoints` track the sampled point list. Undefined when
 * the track has no usable key.
 */
export function sampleTrackValue(track: KeyframeTrack, t: number): Keyframe['value'] | undefined {
  if (!isPointsTrack(track)) return sampleTrack(track, t)
  const first = track.points.map(pointsOf).find(v => validPoints(v)) as Array<[number, number]> | undefined
  if (!first) return undefined
  return samplePointsTrack(track, t, first.length) as unknown as Keyframe['value'] | undefined
}
