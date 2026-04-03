import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const RENDER_W = 1080
const RENDER_H = 1920
import { fileUrl } from '@/lib/api'
import { getOverlayTracks, getVideoTrack } from '@/lib/project'
import type { Project } from '@/lib/project'
import { compileOverlay } from '@/lib/overlay-eval'
import type { OverlayFactory } from '@/lib/overlay-eval'
import CaptionPreview from '@/components/CaptionPreview'
import { getCaptionTrack } from '@/lib/project'

interface VirtualClip {
  src: string
  inPoint: number
  outPoint: number
  virtualStart: number
  duration: number
  pendingCuts?: [number, number][]
}

function buildVirtualTimeline(clips: { src: string; inPoint?: number; outPoint?: number; order: number; pendingCuts?: [number, number][] }[]): VirtualClip[] {
  const ready = clips.filter(
    (c): c is typeof c & { inPoint: number; outPoint: number } =>
      c.inPoint !== undefined && c.outPoint !== undefined && c.outPoint > c.inPoint,
  )
  const sorted = [...ready].sort((a, b) => a.order - b.order)
  let cursor = 0
  return sorted.map((c) => {
    const duration = c.outPoint - c.inPoint
    const entry: VirtualClip = { src: c.src, inPoint: c.inPoint, outPoint: c.outPoint, virtualStart: cursor, duration, pendingCuts: c.pendingCuts }
    cursor += duration
    return entry
  })
}

// ---------------------------------------------------------------------------
// CustomOverlay: fetches, compiles, and renders a custom JSX overlay file
// ---------------------------------------------------------------------------

interface CustomOverlayProps {
  src: string
  props: Record<string, unknown>
  frame: number
  fps: number
  durationFrames: number
}

function CustomOverlay({ src, props, frame, fps, durationFrames }: CustomOverlayProps) {
  const [factory, setFactory] = useState<OverlayFactory | null>(null)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    compileOverlay(src)
      .then((f) => { if (!cancelled) setFactory(() => f) })
      .catch((e) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [src])

  if (error) {
    return (
      <div className="absolute bottom-4 left-4 right-4 pointer-events-none">
        <div className="bg-red-950/80 border border-red-700 text-red-300 text-xs px-3 py-2 rounded font-mono truncate">
          overlay error: {src.split('/').pop()}
        </div>
      </div>
    )
  }

  if (!factory) return null

  const resolvedProps = Object.fromEntries(
    Object.entries(props).map(([k, v]) => [
      k,
      typeof v === 'string' && v.startsWith('/') && !v.startsWith('/api/')
        ? `/api/files?path=${encodeURIComponent(v)}`
        : v,
    ]),
  )

  const element = factory(frame, fps, durationFrames, resolvedProps)
  if (!element) return null

  return <div className="absolute inset-0 pointer-events-none">{element}</div>
}

// ---------------------------------------------------------------------------
// Corner handle — L-shaped bracket that stays a fixed visual size
// ---------------------------------------------------------------------------

type Corner = 'nw' | 'ne' | 'sw' | 'se'

function CornerHandle({ corner, scale, onMouseDown }: {
  corner: Corner
  scale: number
  onMouseDown: (e: React.MouseEvent) => void
}) {
  const cursorClass = {
    nw: 'cursor-nw-resize', ne: 'cursor-ne-resize',
    sw: 'cursor-sw-resize', se: 'cursor-se-resize',
  }[corner]

  const posClass = {
    nw: 'top-0 left-0',   ne: 'top-0 right-0',
    sw: 'bottom-0 left-0', se: 'bottom-0 right-0',
  }[corner]

  // L-shaped bracket: show only the two relevant border sides
  const borderClass = {
    nw: 'border-t-2 border-l-2',
    ne: 'border-t-2 border-r-2',
    sw: 'border-b-2 border-l-2',
    se: 'border-b-2 border-r-2',
  }[corner]

  // Inverse scale so handle stays constant visual size; origin at the corner itself
  const origin = `${corner.includes('n') ? 'top' : 'bottom'} ${corner.includes('w') ? 'left' : 'right'}`

  return (
    <div
      className={`absolute w-5 h-5 border-amber-400 z-50 ${cursorClass} ${posClass} ${borderClass}`}
      style={{ transformOrigin: origin, transform: `scale(${1 / scale})` }}
      onMouseDown={onMouseDown}
    />
  )
}

// ---------------------------------------------------------------------------

type DragType = 'move' | `resize-${Corner}`

interface PreviewPlayerProps {
  project: Project
  currentTime: number
  onTimeUpdate: (t: number) => void
  selectedOverlayId?: string
  onOverlayChange?: (id: string, changes: { offsetX?: number; offsetY?: number; scale?: number }) => void
}

const SNAP_THRESHOLD = 2.5  // % of container

export default function PreviewPlayer({ project, currentTime, onTimeUpdate, selectedOverlayId, onOverlayChange }: PreviewPlayerProps) {
  const videoRef     = useRef<HTMLVideoElement>(null)
  const containerRef    = useRef<HTMLDivElement>(null)
  const [renderScale, setRenderScale] = useState<number>(1)
  const activeIdxRef = useRef(0)
  const seekingRef   = useRef(false)
  const lastTimeRef  = useRef(currentTime)
  const rafRef       = useRef<number | null>(null)
  const rafLastMs    = useRef<number | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  // ── Drag state ────────────────────────────────────────────────────────────
  const [dragState, setDragState] = useState<{
    id: string
    type: DragType
    initX: number
    initY: number
    initOffsetX: number
    initOffsetY: number
    initScale: number
  } | null>(null)

  const [liveOffset, setLiveOffset] = useState<{ id: string; x: number; y: number } | null>(null)
  const [liveScale,  setLiveScale]  = useState<{ id: string; scale: number } | null>(null)
  const liveOffsetRef = useRef<typeof liveOffset>(null)
  const liveScaleRef  = useRef<typeof liveScale>(null)

  // Snap guide visibility
  const [snapGuides, setSnapGuides] = useState({ x: false, y: false })
  const prevSnapRef = useRef({ x: false, y: false })

  useEffect(() => { liveOffsetRef.current = liveOffset }, [liveOffset])
  useEffect(() => { liveScaleRef.current  = liveScale  }, [liveScale])

  useEffect(() => {
    if (!dragState) return

    function onMove(e: MouseEvent) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || !dragState) return

      const dx = ((e.clientX - dragState.initX) / rect.width)  * 100  // %
      const dy = ((e.clientY - dragState.initY) / rect.height) * 100  // %

      if (dragState.type === 'move') {
        const rawX = dragState.initOffsetX + dx
        const rawY = dragState.initOffsetY + dy
        const snapX = Math.abs(rawX) < SNAP_THRESHOLD
        const snapY = Math.abs(rawY) < SNAP_THRESHOLD

        // Haptic on snap entry
        if (snapX && !prevSnapRef.current.x) navigator.vibrate?.(10)
        if (snapY && !prevSnapRef.current.y) navigator.vibrate?.(10)
        prevSnapRef.current = { x: snapX, y: snapY }

        setSnapGuides({ x: snapX, y: snapY })
        const next = { id: dragState.id, x: snapX ? 0 : rawX, y: snapY ? 0 : rawY }
        setLiveOffset(next)
        liveOffsetRef.current = next
      } else {
        // Resize from corner
        const corner = dragState.type.slice(7) as Corner  // 'resize-se' → 'se'
        const sx = corner.includes('e') ? 1 : -1
        const sy = corner.includes('s') ? 1 : -1
        const delta = (dx * sx + dy * sy) / 100
        const newScale = Math.max(0.1, dragState.initScale * (1 + delta))
        const next = { id: dragState.id, scale: newScale }
        setLiveScale(next)
        liveScaleRef.current = next
      }
    }

    function onUp() {
      const lo = liveOffsetRef.current
      const ls = liveScaleRef.current
      const changes: { offsetX?: number; offsetY?: number; scale?: number } = {}
      if (lo) { changes.offsetX = lo.x; changes.offsetY = lo.y }
      if (ls) { changes.scale = ls.scale }
      if (Object.keys(changes).length) onOverlayChange?.(dragState!.id, changes)
      setDragState(null)
      setLiveOffset(null)
      setLiveScale(null)
      setSnapGuides({ x: false, y: false })
      prevSnapRef.current = { x: false, y: false }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState])

  // Track container size to scale overlay components from 1080×1920 → preview size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setRenderScale(entry.contentRect.width / RENDER_W)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── Video timeline ─────────────────────────────────────────────────────────
  const clips        = useMemo(() => getVideoTrack(project)?.clips ?? [], [project])
  const overlayTracks = useMemo(() => getOverlayTracks(project), [project])

  const isCanvasProject = clips.length === 0

  useEffect(() => {
    if (!isCanvasProject) return
    const maxEnd = overlayTracks.flat().reduce((m, i) => Math.max(m, i.end), 0)

    function tick(ms: number) {
      if (rafLastMs.current !== null) {
        const dt   = (ms - rafLastMs.current) / 1000
        const next = Math.min(lastTimeRef.current + dt, maxEnd)
        lastTimeRef.current = next
        onTimeUpdate(next)
        if (next >= maxEnd) {
          setIsPlaying(false)
          rafRef.current = null
          rafLastMs.current = null
          return
        }
      }
      rafLastMs.current = ms
      rafRef.current = requestAnimationFrame(tick)
    }

    if (isPlaying) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      rafLastMs.current = null
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [isPlaying, isCanvasProject, overlayTracks, onTimeUpdate])
  const captionTrack = useMemo(() => getCaptionTrack(project), [project])
  const timeline     = useMemo(() => buildVirtualTimeline(clips), [clips])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (isCanvasProject) {
          setIsPlaying(prev => !prev)
          return
        }
        const video = videoRef.current
        if (!video) return
        video.paused ? video.play().catch(() => {}) : video.pause()
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 0.1 : 1
        onTimeUpdate(Math.max(0, lastTimeRef.current + (e.code === 'ArrowLeft' ? -step : step)))
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onTimeUpdate])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !timeline.length) return
    activeIdxRef.current = 0
    video.src = fileUrl(timeline[0].src)
    video.currentTime = timeline[0].inPoint
  }, [timeline])

  useEffect(() => {
    if (Math.abs(currentTime - lastTimeRef.current) < 0.05) return
    seekingRef.current = true
    lastTimeRef.current = currentTime
    const idx = timeline.findIndex(c => currentTime >= c.virtualStart && currentTime < c.virtualStart + c.duration)
    const clipIdx = idx !== -1 ? idx : 0
    const clip = timeline[clipIdx]
    if (!clip) return
    activeIdxRef.current = clipIdx
    const video = videoRef.current
    if (!video) return
    const targetSrc = fileUrl(clip.src)
    if (video.src !== targetSrc) video.src = targetSrc
    video.currentTime = clip.inPoint + (currentTime - clip.virtualStart)
    seekingRef.current = false
  }, [currentTime, timeline])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video || seekingRef.current) return
    const clip = timeline[activeIdxRef.current]
    if (!clip) return

    // Skip over any pending cut range the playhead has entered
    if (clip.pendingCuts?.length) {
      for (const [physS, physE] of clip.pendingCuts) {
        if (video.currentTime >= physS && video.currentTime < physE) {
          seekingRef.current = true
          video.currentTime = physE
          seekingRef.current = false
          return
        }
      }
    }

    if (video.currentTime >= clip.outPoint) {
      const nextIdx = activeIdxRef.current + 1
      if (nextIdx < timeline.length) {
        const next = timeline[nextIdx]
        activeIdxRef.current = nextIdx
        video.src = fileUrl(next.src)
        video.currentTime = next.inPoint
        video.play().catch(() => {})
      }
      return
    }
    const vTime = clip.virtualStart + (video.currentTime - clip.inPoint)
    lastTimeRef.current = vTime
    onTimeUpdate(vTime)
  }, [timeline, onTimeUpdate])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="relative bg-black h-full aspect-[9/16] max-w-full overflow-hidden rounded">
      {isCanvasProject ? (
        <div className="absolute inset-0 bg-black" />
      ) : timeline.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
          No clips
        </div>
      ) : (
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          onTimeUpdate={handleTimeUpdate}
          controls
          playsInline
        />
      )}

      {/* Overlay tracks — rendered in z-order (track 0 first, higher indexes on top) */}
      {overlayTracks.map((trackItems, trackIdx) =>
        trackItems.map((item) => {
          const visible = currentTime >= item.start && currentTime < item.end
          if (!visible) return null

          const isSel   = selectedOverlayId === item.id
          const offsetX = (liveOffset?.id === item.id ? liveOffset.x : null) ?? item.offsetX ?? 0
          const offsetY = (liveOffset?.id === item.id ? liveOffset.y : null) ?? item.offsetY ?? 0
          const scale   = (liveScale?.id  === item.id ? liveScale.scale : null) ?? item.scale ?? 1

          function startMove(e: React.MouseEvent) {
            if (!isSel) return
            e.stopPropagation()
            setDragState({ id: item.id, type: 'move', initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale })
          }

          function startResize(corner: Corner) {
            return (e: React.MouseEvent) => {
              e.stopPropagation()
              setDragState({ id: item.id, type: `resize-${corner}`, initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale })
            }
          }

          const wrapperStyle: React.CSSProperties = {
            transform: `translate(${offsetX}%, ${offsetY}%) scale(${scale})`,
            transformOrigin: 'center center',
            zIndex: trackIdx + 1,
          }

          const wrapperClass = `absolute inset-0 ${
            isSel
              ? `${dragState?.type === 'move' ? 'cursor-grabbing' : 'cursor-grab'} ring-1 ring-inset ring-amber-400/40`
              : 'pointer-events-none'
          }`

          // Custom JSX overlays
          if (item.type === 'custom' && item.src) {
            const fps = project.settings?.fps ?? 30
            const frame = Math.round((currentTime - item.start) * fps)
            const durationFrames = Math.round(((item.end as number) - (item.start as number)) * fps)
            return (
              <div key={`${trackIdx}-${item.id}`} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
                {/* Render at native 1080×1920 then scale down to match container */}
                <div style={{
                  position: 'absolute', top: 0, left: 0,
                  width: RENDER_W, height: RENDER_H,
                  transform: `scale(${renderScale})`, transformOrigin: 'top left',
                  pointerEvents: 'none',
                }}>
                  <CustomOverlay
                    src={item.src as string}
                    props={(item.props as Record<string, unknown>) ?? {}}
                    frame={frame}
                    fps={fps}
                    durationFrames={durationFrames}
                  />
                </div>
                {isSel && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                  <CornerHandle key={c} corner={c} scale={scale} onMouseDown={startResize(c)} />
                ))}
              </div>
            )
          }

          // Legacy text overlays
          const pos = item.position ?? 'bottom-left'
          const posClass: Record<string, string> = {
            'top-left':      'top-[8%] left-[4%]',
            'top-center':    'top-[8%] left-1/2 -translate-x-1/2',
            'top-right':     'top-[8%] right-[4%]',
            'center':        'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
            'bottom-left':   'bottom-[8%] left-[4%]',
            'bottom-center': 'bottom-[8%] left-1/2 -translate-x-1/2',
            'bottom-right':  'bottom-[8%] right-[4%]',
          }
          return (
            <div
              key={`${trackIdx}-${item.id}`}
              className={`absolute ${isSel ? 'cursor-grab ring-1 ring-amber-400/40' : 'pointer-events-none'} ${posClass[pos] ?? posClass['bottom-left']}`}
              style={wrapperStyle}
              onMouseDown={startMove}
            >
              {item.text && (
                <span className="bg-black/70 text-white text-sm font-bold px-3 py-1.5 rounded">
                  {item.text}
                </span>
              )}
              {isSel && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                <CornerHandle key={c} corner={c} scale={scale} onMouseDown={startResize(c)} />
              ))}
            </div>
          )
        })
      )}

      {/* Center snap guide lines — rendered at container level, unaffected by overlay transforms */}
      {dragState?.type === 'move' && snapGuides.x && (
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-amber-400 pointer-events-none z-50"
             style={{ transform: 'translateX(-50%)' }} />
      )}
      {dragState?.type === 'move' && snapGuides.y && (
        <div className="absolute left-0 right-0 top-1/2 h-px bg-amber-400 pointer-events-none z-50"
             style={{ transform: 'translateY(-50%)' }} />
      )}

      {/* Caption preview */}
      {captionTrack && (
        <CaptionPreview
          track={captionTrack}
          currentTime={currentTime}
          fps={project.settings?.fps ?? 30}
        />
      )}
    </div>
  )
}
