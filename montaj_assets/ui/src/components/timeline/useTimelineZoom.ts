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
    const rect = container.getBoundingClientRect()
    const pivotOffset = pivotClientX !== undefined
      ? Math.max(0, Math.min(containerWidth, pivotClientX - rect.left))
      : containerWidth / 2
    const pivotPct = Math.max(0, Math.min(1,
      (currentScrollLeft + pivotOffset) / (containerWidth * zoomRef.current)
    ))
    pendingScrollRef.current = Math.max(0, pivotPct * containerWidth * clamped - pivotOffset)
    setZoom(clamped)
  }

  function handleTimelineWheel(e: React.WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      // Multiplicative step so perceived speed is consistent across zoom levels.
      // deltaY ≈ 100 per mouse-wheel tick → factor ≈ 0.82 (≈ 18% zoom change).
      const factor = Math.exp(-e.deltaY * 0.002)
      zoomTo(zoomRef.current * factor, e.clientX)
    } else if (e.altKey) {
      e.preventDefault()
      if (scrollRef.current) scrollRef.current.scrollLeft += e.deltaY
    }
  }

  return { zoom, zoomRef, scrollRef, pendingScrollRef, zoomTo, handleTimelineWheel }
}
