import { useLayoutEffect, useRef, useState } from 'react'

export function useTimelineZoom(totalDuration: number) {
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingScrollRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScrollRef.current
      pendingScrollRef.current = null
    }
  })

  function zoomTo(newZoom: number, pivotClientX?: number) {
    const clamped = Math.max(1, Math.min(20, newZoom))
    if (!scrollRef.current || totalDuration === 0) { setZoom(clamped); return }
    const container = scrollRef.current
    const containerWidth = container.clientWidth
    const currentScrollLeft = container.scrollLeft
    let pivotPct: number
    if (pivotClientX !== undefined) {
      const rect = container.getBoundingClientRect()
      pivotPct = (currentScrollLeft + (pivotClientX - rect.left)) / (containerWidth * zoomRef.current)
    } else {
      pivotPct = (currentScrollLeft + containerWidth / 2) / (containerWidth * zoomRef.current)
    }
    pivotPct = Math.max(0, Math.min(1, pivotPct))
    pendingScrollRef.current = Math.max(0, pivotPct * containerWidth * clamped - containerWidth / 2)
    setZoom(clamped)
  }

  function handleTimelineWheel(e: React.WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.5 : 0.5
      zoomTo(zoomRef.current + delta, e.clientX)
    } else if (e.altKey) {
      e.preventDefault()
      if (scrollRef.current) scrollRef.current.scrollLeft += e.deltaY
    }
  }

  return { zoom, zoomRef, scrollRef, pendingScrollRef, zoomTo, handleTimelineWheel }
}
