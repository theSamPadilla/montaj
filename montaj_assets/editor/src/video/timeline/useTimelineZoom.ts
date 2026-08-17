import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

  // ⌘/Ctrl + wheel = zoom; Alt + wheel = horizontal scroll. Both call
  // preventDefault, so the listener MUST be non-passive. React's onWheel prop is
  // registered passive at the root, which makes preventDefault a no-op and spams
  // "Unable to preventDefault inside passive event listener" — so attach a native
  // listener with { passive: false } instead. A ref to the latest handler keeps
  // it current without re-binding on every render.
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {})
  wheelHandlerRef.current = (e: WheelEvent) => {
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

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => wheelHandlerRef.current(e)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // `pendingScrollRef` stays internal: it's the mechanism that makes zoom
  // pivot-preserving (the scrollLeft write has to land in the same layout pass
  // as the new width), not something a caller can meaningfully use.
  return { zoom, zoomRef, scrollRef, zoomTo }
}
