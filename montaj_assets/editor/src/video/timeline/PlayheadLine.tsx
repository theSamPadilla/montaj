import { useTimelineContext } from './TimelineContext'
import { usePlaybackTime } from '../playback-clock'
import { pct } from './utils'

/** Leaf playhead indicator: the ONLY per-tick subscriber inside track rows.
 *  Isolating the clock subscription here means VisualTrackRow/AudioTrackRow
 *  (and everything else in a row) no longer re-render on every playback tick. */
export default function PlayheadLine() {
  const { clock, totalDuration } = useTimelineContext()
  const currentTime = usePlaybackTime(clock)
  if (totalDuration === 0) return null
  return (
    <div
      className="absolute top-0 bottom-0 w-[2px] bg-red-500 pointer-events-none z-10"
      style={{ left: `${pct(currentTime, totalDuration)}%` }}
    />
  )
}
