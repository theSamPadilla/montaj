import type { VisualItem } from '../schema'
import { KeyframeNav } from '../video/OverlayInspector'
import { CROP_PROPS, KEYFRAME_TIME_EPSILON, cropKeyedAt, localTimeOf, toggleCropKeyframeAt, trackFor } from '../video/keyframeOps'
import { usePlaybackTime, type PlaybackClock } from '../video/playback-clock'

/** The Crop tab's `‹ ◇ ›` (PV55): step between crop keyframes, and add or
 *  remove the crop keyframe at the playhead. The four crop props key as one;
 *  the rules are the Transform rows' (`toggleCropKeyframeAt`). */
export function CropKeyframeNav({ item, clock, onChange, onSeek }: {
  item: VisualItem
  clock: PlaybackClock
  onChange: (item: VisualItem) => void
  onSeek?: (time: number) => void
}) {
  const localT = localTimeOf(item, usePlaybackTime(clock))
  const times = [...new Set(CROP_PROPS.flatMap(p => trackFor(item, p)?.points.map(pt => pt.t) ?? []))].sort((a, b) => a - b)
  let prev: number | undefined
  for (const t of times) if (t < localT - KEYFRAME_TIME_EPSILON) prev = t
  const next = times.find(t => t > localT + KEYFRAME_TIME_EPSILON)
  const keyed = cropKeyedAt(item, localT)
  return (
    <KeyframeNav
      prevLabel="Previous Crop keyframe"
      nextLabel="Next Crop keyframe"
      diamondLabel={keyed ? 'Remove Crop keyframe at playhead' : 'Add Crop keyframe at playhead'}
      pressed={keyed}
      canPrev={!!onSeek && prev !== undefined}
      canNext={!!onSeek && next !== undefined}
      onPrev={() => { if (prev !== undefined) onSeek?.(item.start + prev) }}
      onNext={() => { if (next !== undefined) onSeek?.(item.start + next) }}
      onDiamond={() => onChange(toggleCropKeyframeAt(item, localT))}
    />
  )
}
