import { useLayoutEffect, useRef, useState } from 'react'
import type { Slide, Project, EditorAdapter } from '../types'
import SlideCanvas from './SlideCanvas'

/**
 * Public read-only props for rendering a single carousel slide. This is the
 * clean read-only surface over the internal (interactive-heavy) SlideCanvas
 * Props: it exposes only the fields a non-editing consumer needs — geometry,
 * an optional explicit scale or auto-fit, and the adapter capabilities the
 * render path can use (image resolution, overlay compilation, file watching).
 */
export interface ReadOnlySlideProps {
  slide: Slide
  /** Native slide width (resolution[0]). */
  width: number
  /** Native slide height (resolution[1]). */
  height: number
  /** Explicit scale; if omitted and autoFit is on, the scale is measured. */
  scale?: number
  /**
   * When true, measure the wrapper's box via a ResizeObserver and fit the slide
   * with `min(parentW/width, parentH/height)`. When false (default), the
   * effective scale is `scale ?? 1`.
   */
  autoFit?: boolean
  resolveImageSrc?: EditorAdapter<Project>['resolveImageSrc']
  compileOverlay?: EditorAdapter<Project>['compileOverlay']
  watchFile?: EditorAdapter<Project>['watchFile']
  /** Element ids to omit from the render (non-persisted). */
  hiddenElementIds?: string[]
}

/**
 * Thin read-only renderer for a single carousel slide. Renders a
 * non-interactive SlideCanvas — no selection, drag, resize, rotate, crop, or
 * text-edit chrome. The wrapper fills its sized parent (width/height: 100%) so
 * the parent's `aspect-ratio` controls layout; with `autoFit` the slide is
 * scaled to fit that box.
 */
export default function ReadOnlySlide({
  slide,
  width,
  height,
  scale: explicitScale,
  autoFit = false,
  resolveImageSrc,
  compileOverlay,
  watchFile,
  hiddenElementIds,
}: ReadOnlySlideProps) {
  // Auto-fit: measure the wrapper and pick the largest scale that preserves the
  // slide's aspect ratio. Consumers just give the wrapper a sized parent (e.g. a
  // box with `aspect-ratio: <w>/<h>; width: 100%`); no explicit scale needed.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [measuredScale, setMeasuredScale] = useState<number>(0)
  useLayoutEffect(() => {
    if (!autoFit || explicitScale !== undefined) return
    const node = rootRef.current
    if (!node) return
    const compute = () => {
      const w = node.clientWidth
      const h = node.clientHeight
      if (w === 0 || h === 0) return
      const fit = Math.min(w / width, h / height)
      if (Number.isFinite(fit) && fit > 0) setMeasuredScale(fit)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(node)
    return () => ro.disconnect()
  }, [autoFit, explicitScale, width, height])

  const scale = explicitScale ?? (autoFit ? measuredScale : 1)

  return (
    <div ref={rootRef} style={{ width: '100%', height: '100%' }}>
      <SlideCanvas
        slide={slide}
        width={width}
        height={height}
        interactive={false}
        scale={scale}
        resolveImageSrc={resolveImageSrc}
        compileOverlay={compileOverlay}
        watchFile={watchFile}
        hiddenElementIds={hiddenElementIds}
      />
    </div>
  )
}
