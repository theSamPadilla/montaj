import { createContext, useContext } from 'react'
import type { PlaybackClock } from '../playback-clock'

/**
 * What Timeline shares with the chrome it renders around the canvas surface.
 *
 * That is now one component — `Scrubber`, the time-readout strip — so this
 * carries exactly the two things it reads and nothing else. It used to also
 * carry the canvas viewport, the DOM scroll container's zoom/scrollRef, the
 * scrubber bar's rect ref and the overlay-drag flag, for the rows that stayed
 * in the DOM while the tracks moved to canvas. There are no such rows left:
 * clips, audio lanes and captions are all painted by `TimelineCanvas`, which
 * reads the viewport from its own external store (`canvas/viewport.ts`) rather
 * than through React, precisely so a zoom gesture doesn't re-render anything.
 *
 * Positions therefore never travel through this context — only times do. That
 * is the property worth keeping: two surfaces that agreed about the clock but
 * computed x independently is what made the old DOM playhead drift out of
 * alignment with the clips above it the moment you zoomed.
 */
export interface TimelineContextValue {
  contentDuration: number
  clock: PlaybackClock
}

export const TimelineContext = createContext<TimelineContextValue | null>(null)

export function useTimelineContext(): TimelineContextValue {
  const ctx = useContext(TimelineContext)
  if (!ctx) throw new Error('useTimelineContext must be used within a TimelineContext.Provider')
  return ctx
}
