import { formatTime } from './utils'
import { useTimelineContext } from './TimelineContext'
import { usePlaybackTime } from '../playback-clock'
import { Tooltip } from '../../ui/Tooltip'

/**
 * The strip above the tracks: current time on the left, project duration on
 * the right.
 *
 * ── Why there is no bar here any more ────────────────────────────────────
 * This used to also render an overview BAR — a track, an elapsed fill and a
 * draggable red handle spanning the whole project across the full width. The
 * canvas timeline owns its own zoom and scroll, so at any zoom but "fit" that
 * handle sat at a different x than the canvas playhead for the same instant:
 * two red markers disagreeing about where you are. The bar came out with the
 * DOM timeline and its per-bar affordances (drag-to-scrub with boundary
 * snapping, the hover-time tooltip) went with it — the canvas surface has its
 * own playhead grab band and its own preview axis for those.
 *
 * The readouts stay, because they are TIMES rather than positions: they read
 * from the same clock the canvas paints from and cannot disagree with it.
 */
interface ScrubberProps {
  /** SP5 T9 — opens the command palette's "go to time" input. Absent →
   *  the time readout stays plain, non-interactive text. */
  onOpenGoToTime?: () => void
}

export default function Scrubber({ onOpenGoToTime }: ScrubberProps) {
  const { clock, contentDuration } = useTimelineContext()
  const currentTime = usePlaybackTime(clock)

  return (
    /* `cursor-pointer`: the row is a strip of timeline background, and
       Timeline's container click seeks through it (see `handleContainerClick`),
       so it should look live rather than dead. */
    <div className="flex items-center justify-between text-[10px] font-mono text-gray-600 cursor-pointer">
      {onOpenGoToTime ? (
        <Tooltip label="Go to time">
          <button
            type="button"
            aria-label="Go to time"
            onClick={(e) => { e.stopPropagation(); onOpenGoToTime() }}
            className="hover:text-gray-300 transition-colors"
          >
            {formatTime(currentTime)}
          </button>
        </Tooltip>
      ) : (
        <span>{formatTime(currentTime)}</span>
      )}
      {/* `data-timeline-chrome`: a readout, not a place to seek to. Clicking
          it would otherwise jump the playhead to the far right of the view,
          since it sits at the right edge of a strip that IS a time axis. */}
      <span data-timeline-chrome className="cursor-default">{formatTime(contentDuration)}</span>
    </div>
  )
}
