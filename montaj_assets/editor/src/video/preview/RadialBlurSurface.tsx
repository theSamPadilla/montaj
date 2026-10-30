// A spin or zoom blur in the preview: a 2D canvas filling the clip's media box,
// drawn by the shared WebGL2 pass (radialBlurGL.ts) from the clip's own source.
//
// WHERE. The canvas fills the media box, so the box's transform, mask and blend
// apply to it as they do to the picture. The host keeps the source mounted at
// opacity 0 (it keeps decoding and firing frame callbacks) and passes it in:
// the <video> on the legacy and overlay-track paths, the <img> for images, the
// engine's 2D canvas for the base clip on the WebCodecs path. The canvas is
// transparent outside the picture's rect.
//
// WHEN IT DRAWS. On every prop change and resize; a <video> on every frame it
// presents (requestVideoFrameCallback: playback and seeks) and on `seeked` and
// `loadeddata`; an <img> on `load`; anything else (the engine canvas) when the
// host calls the handle's `draw()` from its paint.
//
// FAILURE. No WebGL2, a lost context, or a source WebGL may not read (a
// cross-origin <video> or <img> without CORS): the component renders nothing
// and calls `onStatus(false)`, so the host shows the source unblurred (one
// console warning, from radialBlurGL.ts). After the context is restored (or
// for a new source) it renders and draws again and calls `onStatus(true)`.
//
// BUDGET. Full resolution (the box's device pixels, capped at the 1080 short
// edge) whenever paused. While `playing`, the page's animation frames are
// timed: when the median of 30 runs over 25 ms (frames running long, under
// 40 fps), the canvas drops to half resolution until playback stops, so
// stills and parity checks always see full quality.

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import {
  drawRadialBlur, onRadialBlurRestored, radialBlurAvailable, radialWorkSize, watchVideoFrames,
  type FracRect, type RadialBlurSource,
} from './radialBlurGL'

/** What the host can do to a surface: redraw it now (the engine canvas's paint). */
export interface RadialBlurSurfaceHandle {
  draw(): void
}

export interface RadialBlurSurfaceProps {
  /** The picture's source, mounted by the host at opacity 0. Nothing draws while null. */
  source: RadialBlurSource | null
  type: 'spin' | 'zoom'
  /** Degrees (spin) or percent (zoom): timeline-core `blurOf`. */
  amount: number
  /** The centre, fractions of the box: timeline-core `blurCenterOf`. */
  center: { x: number; y: number }
  /** The picture's rect in the box, fractions: timeline-core `pictureRectInBox`. */
  pictureRect: FracRect
  /** The part of the source that fills the picture: the crop, or the picture's rect for an engine canvas
   *  that spans the box. The whole source when absent. */
  sourceRect?: FracRect
  /** Playback is running: allows the half-resolution fallback. Paused draws are always full resolution. */
  playing?: boolean
  /** The box's own on-screen scale (the wrapper's `scale(s)` over a full-frame media box), so the working
   *  resolution follows what the screen shows. 1 when absent. */
  scale?: number
  /** false when the surface cannot draw (no WebGL2, lost context) and the host should show the source; true
   *  once it draws. */
  onStatus?: (drawing: boolean) => void
  /** Called after every frame the surface draws (a performance HUD, tests). */
  onDraw?: () => void
  className?: string
  style?: CSSProperties
  ref?: Ref<RadialBlurSurfaceHandle>
}

/** Frames this long (median over {@link LONG_FRAME_WINDOW}) send a playing surface to half resolution. */
export const LONG_FRAME_MS = 25
export const LONG_FRAME_WINDOW = 30

const isVideo = (s: unknown): s is HTMLVideoElement => typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement
const isImage = (s: unknown): s is HTMLImageElement => typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement

export default function RadialBlurSurface(props: RadialBlurSurfaceProps) {
  const { source, type, amount, center, pictureRect, sourceRect, playing = false, scale = 1, className, style, ref } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ok, setOk] = useState(() => radialBlurAvailable())
  const [css, setCss] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [half, setHalf] = useState(false)
  // A source WebGL may not read (cross-origin): nothing drawn until the source changes.
  const [blocked, setBlocked] = useState<RadialBlurSource | null>(null)

  // The latest props for draw(), which frame callbacks hold on to.
  const latest = useRef(props)
  latest.current = props
  const statusRef = useRef<boolean | null>(null)
  const report = useCallback((drawing: boolean) => {
    if (statusRef.current === drawing) return
    statusRef.current = drawing
    latest.current.onStatus?.(drawing)
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const p = latest.current
    if (!canvas || !p.source || !(p.amount > 0)) return
    const res = drawRadialBlur({
      source: p.source, target: canvas, type: p.type, amount: p.amount,
      center: p.center, pictureRect: p.pictureRect, sourceRect: p.sourceRect,
    })
    if (res === 'unsupported' || res === 'lost') { setOk(false); report(false) }
    else if (res === 'blocked') { setBlocked(p.source); report(false) }
    else if (res === 'drawn') { report(true); p.onDraw?.() }
  }, [report])

  useImperativeHandle(ref, () => ({ draw }), [draw])

  // No context at mount: say so once.
  useEffect(() => { if (!ok) report(false) }, [ok, report])

  // A restored context: render again and redraw.
  useEffect(() => onRadialBlurRestored(() => {
    if (radialBlurAvailable()) setOk(true)
  }), [])

  // The box's CSS size.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const measure = () => setCss((c) => (c.w === canvas.clientWidth && c.h === canvas.clientHeight ? c : { w: canvas.clientWidth, h: canvas.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [ok])

  // The backing size, then a draw on any change.
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const work = radialWorkSize(css.w, css.h, dpr, scale, half && playing)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !(work.w > 0)) return
    if (canvas.width !== work.w) canvas.width = work.w
    if (canvas.height !== work.h) canvas.height = work.h
    draw()
  }, [ok, work.w, work.h, draw, source, type, amount, center.x, center.y,
    pictureRect.x, pictureRect.y, pictureRect.w, pictureRect.h,
    sourceRect?.x, sourceRect?.y, sourceRect?.w, sourceRect?.h])

  // The source's own redraws. One draw now too: a source that finished loading
  // between the first draw and these listeners fires no event again.
  useEffect(() => {
    if (!ok || !source) return
    draw()
    if (isVideo(source)) {
      const stop = watchVideoFrames(source, draw)
      source.addEventListener('seeked', draw)
      source.addEventListener('loadeddata', draw)
      return () => { stop(); source.removeEventListener('seeked', draw); source.removeEventListener('loadeddata', draw) }
    }
    if (isImage(source)) {
      source.addEventListener('load', draw)
      return () => source.removeEventListener('load', draw)
    }
  }, [ok, source, draw])

  // The budget: full resolution when paused; long frames while playing halve it.
  useEffect(() => {
    if (!playing) { setHalf(false); return }
    if (half || typeof requestAnimationFrame === 'undefined') return
    const gaps: number[] = []
    let prev = 0
    let raf = 0
    const tick = (t: number) => {
      if (prev) gaps.push(t - prev)
      prev = t
      if (gaps.length >= LONG_FRAME_WINDOW) {
        const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1]
        if (median > LONG_FRAME_MS) { setHalf(true); return }
        gaps.length = 0
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, half])

  if (!ok || (blocked && blocked === source)) return null
  return (
    <canvas
      ref={canvasRef}
      data-montaj-radial-blur={type}
      className={className}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', ...style }}
    />
  )
}
