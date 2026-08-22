import { createContext, useContext } from 'react'
import type { PlaybackClock } from '../playback-clock'
import type { Viewport } from './canvas/viewport'

export interface TimelineContextValue {
  /**
   * The canvas surface's viewport in CANVAS mode, `null` in legacy DOM mode.
   *
   * The rows that stayed in the DOM after the tracks moved to canvas — today
   * just the caption row and its playhead line — must position against this,
   * not against `totalDuration`. The canvas owns its own zoom and scroll, so a
   * DOM row laid out as a fraction of the whole project drifts out of
   * alignment with the clips above it the moment you zoom: the same instant on
   * two surfaces landed at two different x's, which read as a broken playhead.
   */
  viewport: Viewport | null
  totalDuration: number
  contentDuration: number
  snapBoundaries: number[]
  zoom: number
  zoomRef: React.RefObject<number>
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrubberRef: React.RefObject<HTMLDivElement | null>
  overlayDraggedRef: React.MutableRefObject<boolean>
  clock: PlaybackClock
}

export const TimelineContext = createContext<TimelineContextValue | null>(null)

export function useTimelineContext(): TimelineContextValue {
  const ctx = useContext(TimelineContext)
  if (!ctx) throw new Error('useTimelineContext must be used within a TimelineContext.Provider')
  return ctx
}
