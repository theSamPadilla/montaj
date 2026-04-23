import { formatTime, pct, ratioFromClientX } from './utils'
import { useTimelineContext } from './TimelineContext'

interface ScrubberProps {
  hoverPct: number | null
  draggingPlayhead: boolean
  setDraggingPlayhead: (v: boolean) => void
  keyNavTime: number | null
  onSplit?: (at: number) => void
  onCut?: (cut: { start: number; end: number }) => void
  cutButtonLabel: string
}

export default function Scrubber({
  hoverPct,
  draggingPlayhead,
  setDraggingPlayhead,
  keyNavTime,
  onSplit,
  onCut,
  cutButtonLabel,
}: ScrubberProps) {
  const { currentTime, totalDuration, contentDuration, markers, setMarkers, snapBoundaries, onTimeUpdate, scrubberRef, selection } = useTimelineContext()

  function handleScrubClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (totalDuration === 0) return
    onTimeUpdate(ratioFromClientX(e.clientX, scrubberRef.current!.getBoundingClientRect()) * totalDuration)
  }

  function handleScrubDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (totalDuration === 0) return
    e.preventDefault()
    const t = ratioFromClientX(e.clientX, scrubberRef.current!.getBoundingClientRect()) * totalDuration
    setMarkers(([a, b]) => {
      if (a === null) return [t, null]       // place first marker
      if (b === null) return [a, t]          // place second → selection complete
      return [t, null]                       // reset: start fresh with new first marker
    })
  }

  return (
    <>
      {/* ── Scrubber ── */}
      <div
        ref={scrubberRef}
        className={`relative h-4 rounded-full bg-gray-200 dark:bg-gray-800 group ${markers[0] !== null && markers[1] === null ? 'cursor-cell' : 'cursor-crosshair'}`}
        onClick={handleScrubClick}
        onDoubleClick={handleScrubDoubleClick}
      >
        {/* Elapsed fill */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gray-400 dark:bg-gray-600 pointer-events-none"
          style={{ width: `${pct(currentTime, totalDuration)}%` }}
        />

        {/* Selection range fill (both markers placed) */}
        {selection && (
          <div
            className="absolute inset-y-0 bg-amber-500/25 pointer-events-none"
            style={{ left: `${pct(selection.start, totalDuration)}%`, width: `${pct(selection.end - selection.start, totalDuration)}%` }}
          />
        )}

        {/* Marker A */}
        {markers[0] !== null && (
          <div className="absolute top-0 bottom-0 w-px bg-amber-400 pointer-events-none" style={{ left: `${pct(markers[0], totalDuration)}%` }}>
            <div className="absolute -top-0.5 -translate-x-1/2 w-2 h-2 bg-amber-400 rotate-45" />
          </div>
        )}

        {/* Marker B */}
        {markers[1] !== null && (
          <div className="absolute top-0 bottom-0 w-px bg-amber-400 pointer-events-none" style={{ left: `${pct(markers[1], totalDuration)}%` }}>
            <div className="absolute -top-0.5 -translate-x-1/2 w-2 h-2 bg-amber-400 rotate-45" />
          </div>
        )}

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
                if (Math.abs(rawT - snappedTo) < release) { onTimeUpdate(snappedTo); return }
                snappedTo = null
              }
              // Scan for attraction
              for (const b of boundaries) {
                if (Math.abs(rawT - b) < attract) { snappedTo = b; onTimeUpdate(b); return }
              }
              onTimeUpdate(rawT)
            }
            function onUp() {
              setDraggingPlayhead(false)
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            handleScrubDoubleClick(e as React.MouseEvent<HTMLDivElement>)
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

      {/* Time readout + marker / selection range */}
      <div className="flex items-center justify-between text-[10px] font-mono text-gray-600 -mt-1">
        <span>{formatTime(currentTime)}</span>
        {markers[0] !== null && markers[1] === null && (
          <span className="flex items-center gap-2 text-amber-400/80">
            {onSplit && (
              <button
                className="px-2 py-0.5 rounded bg-amber-500/80 hover:bg-amber-400 text-black text-[10px] font-medium transition-colors"
                onClick={(e) => { e.stopPropagation(); onSplit(markers[0]!); setMarkers([null, null]) }}
              >
                Split
              </button>
            )}
            {formatTime(markers[0])} — double-click to set end
            <button
              className="text-gray-600 hover:text-gray-400"
              onClick={(e) => { e.stopPropagation(); setMarkers([null, null]) }}
            >✕</button>
          </span>
        )}
        {selection && (
          <span className="flex items-center gap-2 text-amber-400">
            <button
              className="text-gray-600 hover:text-gray-400"
              onClick={(e) => { e.stopPropagation(); setMarkers([null, null]) }}
            >✕</button>
            {formatTime(selection.start)} – {formatTime(selection.end)}
            {onCut && (
              <button
                className="px-2 py-0.5 rounded bg-red-600/80 hover:bg-red-500 text-white text-[10px] font-medium transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onCut(selection)
                  setMarkers([null, null])
                }}
              >
                {cutButtonLabel}
              </button>
            )}
          </span>
        )}
        <span>{formatTime(contentDuration)}</span>
      </div>
    </>
  )
}
