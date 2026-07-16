/**
 * CaptionPreview — renders the active caption style on top of the video player.
 *
 * Loads the exact same JSX template used by the render engine
 * (render/templates/captions/<style>.jsx) so preview and final output
 * are a single source of truth. Receives `compileOverlay` as a prop from
 * PreviewPlayer (sourced from adapter.compileOverlay) so the package has no
 * direct dependency on the host's overlay-eval module.
 *
 * The caption layer is sized at the native render resolution (1080 × 1920) and
 * scaled down to fit the player via ResizeObserver so pixel values are 1:1 with
 * the render output.
 */

import { useEffect, useRef, useState } from 'react'
import type { Captions } from '../../schema'
import type { OverlayFactory } from '../../types'
import OverlayErrorBoundary from '../../carousel/OverlayErrorBoundary'

const RENDER_W = 1080
const RENDER_H = 1920

interface CaptionPreviewProps {
  track:                    Captions
  currentTime:              number
  fps:                      number
  compileOverlay:           (src: string) => Promise<OverlayFactory>
  resolveCaptionTemplate?:  (style: string) => string
}

export default function CaptionPreview({ track, currentTime, fps, compileOverlay, resolveCaptionTemplate }: CaptionPreviewProps) {
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

  // Load the render-engine template for the active style.
  // If the host did not supply resolveCaptionTemplate, render nothing (graceful
  // no-op — host does not support captions).
  useEffect(() => {
    setFactory(null)
    if (!resolveCaptionTemplate) return
    const templateSrc = resolveCaptionTemplate(track.style)
    compileOverlay(templateSrc)
      .then(f  => setFactory(() => f))
      .catch(e => console.warn('[CaptionPreview] failed to load template:', e))
  }, [track.style, compileOverlay, resolveCaptionTemplate])

  const frame    = Math.round(currentTime * fps)
  const lastSeg  = track.segments[track.segments.length - 1]

  // Theme props for the template: everything on the track except style/segments
  // (handled separately) and googleFonts (a render-time font-loading hint, not
  // a template prop). Normalize the legacy lowercase `fontsize` key to the
  // camelCase `fontSize` templates actually read.
  const { style: _style, segments: _segments, googleFonts: _googleFonts, fontsize, ...theme } = track
  const themeProps: Record<string, unknown> = { ...theme }
  if (fontsize != null) themeProps.fontSize = fontsize

  const element  = (factory && scale !== null)
    ? factory(frame, fps, Math.round((lastSeg?.end ?? 0) * fps), { segments: track.segments, ...themeProps })
    : null

  return (
    // zIndex 45 keeps captions above the active <video> (z 1) and overlay items
    // (z `trackIdx + 12`, ≈12–20) — mirroring the final render, where the caption
    // track composites on top — while staying below the editing affordances
    // (selection handles z 50, play button z 100). Without an explicit z-index the
    // root sits at `auto`, so the opaque active video paints over it and captions
    // never appear in the preview.
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 45 }}>
      <OverlayErrorBoundary label={`caption: ${track.style}`} resetKey={track.style}>
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
      </OverlayErrorBoundary>
    </div>
  )
}
