import { createContext, useContext } from 'react'

export interface TimelineContextValue {
  totalDuration: number
  snapBoundaries: number[]
  zoom: number
  zoomRef: React.RefObject<number>
  scrollRef: React.RefObject<HTMLDivElement>
  scrubberRef: React.RefObject<HTMLDivElement>
  overlayDraggedRef: React.MutableRefObject<boolean>
  currentTime: number
  onTimeUpdate: (t: number) => void
  markers: [number | null, number | null]
  setMarkers: (m: [number | null, number | null] | ((prev: [number | null, number | null]) => [number | null, number | null])) => void
  selection: { start: number; end: number } | null
}

export const TimelineContext = createContext<TimelineContextValue | null>(null)

export function useTimelineContext(): TimelineContextValue {
  const ctx = useContext(TimelineContext)
  if (!ctx) throw new Error('useTimelineContext must be used within a TimelineContext.Provider')
  return ctx
}
