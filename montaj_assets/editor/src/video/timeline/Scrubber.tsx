import { formatTime, pct, ratioFromClientX } from './utils'
import { useTimelineContext } from './TimelineContext'
import { usePlaybackTime } from '../playback-clock'
import { Tooltip } from '../../ui/Tooltip'

interface ScrubberProps {
  /**
   * Whether to render the overview BAR (the track, the elapsed fill, the red
   * handle). False in canvas mode, where it was removed: the bar maps the whole
   * project across the full width while the canvas timeline owns its own zoom
   * and scroll, so at any zoom but "fit" its red handle sat at a different x
   * than the canvas playhead for the same instant — two red markers
   * disagreeing about where you are. The readouts below it stay: they are
   * times, not positions, and read from the same clock the canvas draws.
   */
  showBar?: boolean
  hoverPct: number | null
  draggingPlayhead: boolean
  setDraggingPlayhead: (v: boolean) => void
  keyNavTime: number | null
  /** SP5 T9 — opens the command palette's "go to time" input. Absent →
   *  the time readout stays plain, non-interactive text. */
  onOpenGoToTime?: () => void
}

export default function Scrubber({
  showBar = true,
  hoverPct,
  draggingPlayhead,
  setDraggingPlayhead,
  keyNavTime,
  onOpenGoToTime,
}: ScrubberProps) {
  const { clock, totalDuration, contentDuration, snapBoundaries, scrubberRef } = useTimelineContext()
  const currentTime = usePlaybackTime(clock)

  function handleScrubClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (totalDuration === 0) return
    clock.set(ratioFromClientX(e.clientX, scrubberRef.current!.getBoundingClientRect()) * totalDuration)
  }

  return (
    <>
      {/* ── Scrubber ── */}
      {showBar && (
      <div
        ref={scrubberRef}
        className="relative h-4 rounded-full bg-gray-200 dark:bg-gray-800 group cursor-crosshair"
        onClick={handleScrubClick}
      >
        {/* Elapsed fill */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gray-400 dark:bg-gray-600 pointer-events-none"
          style={{ width: `${pct(currentTime, totalDuration)}%` }}
        />

        {/* Playhead handle */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-red-500 ring-2 ring-red-500/30 transition-transform group-hover:scale-125 ${draggingPlayhead ? 'cursor-grabbing scale-125' : 'cursor-grab'}`}
          style={{ left: `${pct(currentTime, totalDuration)}%` }}
          onMouseDown={(e) => {
            e.stopPropagation()
            if (totalDuration === 0) return
            setDraggingPlayhead(true)
            const boundaries = snapBoundaries
            let snappedTo: number | null = null   // which boundary we're currently locked to
            function onMove(me: MouseEvent) {
              const rect = scrubberRef.current?.getBoundingClientRect()
              if (!rect) return
              const attractPx = 18   // cursor enters this range → snaps in
              const releasePx = 28   // cursor must leave this range → breaks free
              const attract = (attractPx / rect.width) * totalDuration
              const release = (releasePx / rect.width) * totalDuration
              const rawT = ratioFromClientX(me.clientX, scrubberRef.current!.getBoundingClientRect()) * totalDuration
              // Already snapped — hold until cursor escapes release radius
              if (snappedTo !== null) {
                if (Math.abs(rawT - snappedTo) < release) { clock.set(snappedTo); return }
                snappedTo = null
              }
              // Scan for attraction
              for (const b of boundaries) {
                if (Math.abs(rawT - b) < attract) { snappedTo = b; clock.set(b); return }
              }
              clock.set(rawT)
            }
            function onUp() {
              setDraggingPlayhead(false)
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }}
        >
          {keyNavTime !== null && (
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-gray-800 border border-gray-700 text-white text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap z-20">
              {formatTime(keyNavTime)}
            </div>
          )}
        </div>

        {/* Time tooltip */}
        {hoverPct !== null && totalDuration > 0 && (
          <div
            className="absolute -top-7 -translate-x-1/2 bg-gray-800 border border-gray-700 text-white text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap z-20"
            style={{ left: `${hoverPct}%` }}
          >
            {formatTime((hoverPct / 100) * totalDuration)}
          </div>
        )}
      </div>
      )}

      {/* Time readout. Without the bar this is the whole widget: current time
          on the left, project duration on the right. */}
      {/* `cursor-pointer` without the bar: the row is then a strip of timeline
          background, and Timeline's container click seeks through it (see
          `handleContainerClick`), so it should look live rather than dead. */}
      <div className={`flex items-center justify-between text-[10px] font-mono text-gray-600 ${showBar ? '-mt-1' : 'cursor-pointer'}`}>
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
    </>
  )
}
