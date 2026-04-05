/**
 * CaptionPreview — renders the active caption style on top of the video player.
 *
 * Loads the exact same JSX template used by the render engine
 * (render/templates/captions/<style>.jsx) so preview and final output
 * are a single source of truth. Uses overlay-eval to fetch + compile the
 * template in the browser.
 *
 * The caption layer is sized at the native render resolution (1080 × 1920) and
 * scaled down to fit the player via ResizeObserver so pixel values are 1:1 with
 * the render output.
 */

import { useEffect, useRef, useState } from 'react'
import type { Captions } from '@/lib/project'
import { compileOverlay } from '@/lib/overlay-eval'
import type { OverlayFactory } from '@/lib/overlay-eval'

const RENDER_W = 1080
const RENDER_H = 1920

interface CaptionPreviewProps {
  track:       Captions
  currentTime: number
  fps:         number
}

export default function CaptionPreview({ track, currentTime, fps }: CaptionPreviewProps) {
  const wrapRef            = useRef<HTMLDivElement>(null)
  const [scale, setScale]  = useState<number | null>(null)
  const [factory, setFactory] = useState<OverlayFactory | null>(null)

  // Scale the 1080×1920 render layer to fit the actual player size
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / RENDER_W)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Load the render-engine template for the active style
  useEffect(() => {
    setFactory(null)
    compileOverlay(`/api/caption-template/${track.style}`)
      .then(f  => setFactory(() => f))
      .catch(e => console.warn('[CaptionPreview] failed to load template:', e))
  }, [track.style])

  const frame   = Math.round(currentTime * fps)
  const lastSeg  = track.segments[track.segments.length - 1]
  const element  = (factory && scale !== null)
    ? factory(frame, fps, Math.round((lastSeg?.end ?? 0) * fps), { segments: track.segments })
    : null

  return (
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none overflow-hidden">
      {element && scale !== null && (
        <div style={{
          position:        'absolute',
          top: 0, left: 0,
          width:           RENDER_W,
          height:          RENDER_H,
          transform:       `scale(${scale})`,
          transformOrigin: 'top left',
        }}>
          {element}
        </div>
      )}
    </div>
  )
}
