import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileUrl } from '@/lib/api'
import type { Project } from '@/lib/project'
import { compileOverlay } from '@/lib/overlay-eval'
import type { OverlayFactory } from '@/lib/overlay-eval'
import CaptionPreview from '@/components/CaptionPreview'

const RENDER_W = 1080
const RENDER_H = 1920

const VIDEO_PRELOAD_S = 0.4  // mount this many seconds before item.start so the frame is ready

// Synced video overlay — seeks to the correct position within the item's inPoint/outPoint range
function OverlayVideo({ src, currentTime, itemStart, inPoint, isPlaying, muted, visible }: {
  src: string; currentTime: number; itemStart: number; inPoint: number
  isPlaying: boolean; muted?: boolean; visible: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)

  // On mount: seek to the frame that will be shown at itemStart (so it's ready when it becomes visible)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const target = Math.max(inPoint, inPoint + (currentTime - itemStart))
    v.currentTime = target
    if (isPlaying && visible) v.play().catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On scrub (large jump): re-seek
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const target = inPoint + (currentTime - itemStart)
    if (Math.abs(v.currentTime - target) > 0.3) {
      v.currentTime = Math.max(inPoint, target)
    }
  }, [currentTime, itemStart, inPoint])

  // Play/pause sync — only play when visible; pause when pre-loading or past end
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (isPlaying && visible) v.play().catch(() => {})
    else v.pause()
  }, [isPlaying, visible])

  return (
    <video
      ref={ref}
      src={src}
      muted={muted}
      playsInline
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      style={{ opacity: visible ? 1 : 0 }}
    />
  )
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
  // Double-buffer video elements for seamless clip transitions
  const video0Ref    = useRef<HTMLVideoElement>(null)
  const video1Ref    = useRef<HTMLVideoElement>(null)
  const activeSlotRef = useRef<0 | 1>(0)
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0)
  // Tracks what src is preloaded in the inactive slot (relative URL)
  const preloadSrcRef = useRef('')

  const containerRef    = useRef<HTMLDivElement>(null)
  const [renderScale, setRenderScale] = useState<number>(1)
  const activeIdxRef = useRef(0)
  const seekingRef   = useRef(false)
  const lastTimeRef  = useRef(currentTime)
  const rafRef       = useRef<number | null>(null)
  const rafLastMs    = useRef<number | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showVideo, setShowVideo] = useState(true)

  // Gap clock — advances time through lift-style gaps between primary clips
  const gapRAFRef      = useRef<number | null>(null)
  const inGapRef       = useRef(false)
  const gapWallRef     = useRef(0)
  const gapFromRef     = useRef(0)
  const gapTargetRef   = useRef(0)
  const gapNextIdxRef  = useRef(0)

  function getActiveVideo() { return activeSlotRef.current === 0 ? video0Ref.current : video1Ref.current }
  function getInactiveVideo() { return activeSlotRef.current === 0 ? video1Ref.current : video0Ref.current }

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
  const clips        = useMemo(() => project.tracks?.[0] ?? [], [project])
  const overlayTracks = useMemo(() => project.tracks?.slice(1) ?? [], [project])

  // Canvas project: no primary video in tracks[0] (e.g. image-only background track)
  const isCanvasProject = clips.length === 0 || clips.every(c => c.type !== 'video')

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
  const captionTrack = useMemo(() => project.captions, [project])

  // Space = play/pause
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (isCanvasProject) { setIsPlaying(prev => !prev); return }
        if (inGapRef.current) {
          if (gapRAFRef.current !== null) {
            // Playing through gap → pause
            cancelAnimationFrame(gapRAFRef.current)
            gapRAFRef.current = null
          } else {
            // Paused in gap → resume from current position
            gapFromRef.current = lastTimeRef.current
            gapWallRef.current = performance.now()
            gapRAFRef.current  = requestAnimationFrame(tickGap)
          }
          return
        }
        const video = getActiveVideo()
        if (!video) return
        video.paused ? video.play().catch(() => {}) : video.pause()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCanvasProject])

  // Load first clip into active slot when clips change
  useEffect(() => {
    const video = getActiveVideo()
    if (!video || !clips.length || !clips[0].src) return
    activeIdxRef.current = 0
    activeSlotRef.current = 0
    setActiveSlot(0)
    preloadSrcRef.current = ''
    video.src = fileUrl(clips[0].src)
    video.currentTime = clips[0].inPoint ?? 0
    // Clear inactive slot
    const inactive = getInactiveVideo()
    if (inactive) { inactive.pause(); inactive.removeAttribute('src') }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips])

  const cancelGap = useCallback(() => {
    if (gapRAFRef.current !== null) {
      cancelAnimationFrame(gapRAFRef.current)
      gapRAFRef.current = null
    }
    inGapRef.current = false
  }, [])

  const tickGap = useCallback(function tickGap() {
    if (!inGapRef.current) return
    const elapsed = (performance.now() - gapWallRef.current) / 1000
    const t = Math.min(gapFromRef.current + elapsed, gapTargetRef.current)
    lastTimeRef.current = t
    onTimeUpdate(t)

    if (t < gapTargetRef.current) {
      gapRAFRef.current = requestAnimationFrame(tickGap)
      return
    }

    // Gap over — transition to next clip
    inGapRef.current = false
    gapRAFRef.current = null
    const ni = gapNextIdxRef.current
    const nc = clips[ni]
    if (!nc?.src) return
    const ns = (1 - activeSlotRef.current) as 0 | 1
    const nv = ns === 0 ? video0Ref.current : video1Ref.current
    lastTimeRef.current = nc.start
    onTimeUpdate(nc.start)
    activeIdxRef.current = ni
    if (nv) {
      const src = fileUrl(nc.src)
      if (preloadSrcRef.current !== src) { nv.src = src; nv.currentTime = nc.inPoint ?? 0 }
      nv.play().catch(() => {})
    }
    ;(activeSlotRef.current === 0 ? video0Ref.current : video1Ref.current)?.pause()
    activeSlotRef.current = ns
    setActiveSlot(ns)
    setShowVideo(true)
    preloadSrcRef.current = ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, onTimeUpdate])

  // Scrub: seek active slot when currentTime jumps externally
  useEffect(() => {
    if (Math.abs(currentTime - lastTimeRef.current) < 0.05) return
    cancelGap()
    setShowVideo(true)
    seekingRef.current = true
    try {
      lastTimeRef.current = currentTime
      const idx = clips.findIndex(c => currentTime >= c.start && currentTime < c.end)
      let clipIdx: number
      if (idx !== -1) {
        clipIdx = idx
      } else {
        clipIdx = clips.reduce((best, c, i) => (c.end <= currentTime ? i : best), 0)
      }
      const clip = clips[clipIdx]
      if (!clip?.src) return
      activeIdxRef.current = clipIdx
      const video = getActiveVideo()
      if (!video) return
      const targetSrc = fileUrl(clip.src)
      if (video.src !== targetSrc) {
        video.src = targetSrc
        // Clear preloaded inactive slot — it may no longer be the right next clip
        preloadSrcRef.current = ''
        const inactive = getInactiveVideo()
        if (inactive) { inactive.pause(); inactive.removeAttribute('src') }
      }
      video.currentTime = Math.max(clip.inPoint ?? 0, (clip.inPoint ?? 0) + (currentTime - clip.start))
    } finally {
      seekingRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, clips])

  const handleTimeUpdate = useCallback(() => {
    const slot = activeSlotRef.current
    const video = slot === 0 ? video0Ref.current : video1Ref.current
    if (!video || seekingRef.current) return
    const clip = clips[activeIdxRef.current]
    if (!clip) return

    const outPoint = clip.outPoint ?? clip.end - clip.start + (clip.inPoint ?? 0)

    // Preload next clip into inactive slot ~1s before end
    const timeLeft = outPoint - video.currentTime
    if (timeLeft < 1.0) {
      const nextIdx = activeIdxRef.current + 1
      if (nextIdx < clips.length && clips[nextIdx].src) {
        const inactiveVideo = slot === 0 ? video1Ref.current : video0Ref.current
        const nextSrc = fileUrl(clips[nextIdx].src!)
        if (inactiveVideo && preloadSrcRef.current !== nextSrc) {
          preloadSrcRef.current = nextSrc
          inactiveVideo.src = nextSrc
          inactiveVideo.currentTime = clips[nextIdx].inPoint ?? 0
        }
      }
    }

    if (video.currentTime >= outPoint) {
      const nextIdx = activeIdxRef.current + 1
      if (nextIdx < clips.length && clips[nextIdx].src) {
        const next = clips[nextIdx]
        const cur  = clips[activeIdxRef.current]

        if (next.start > cur.end + 0.02) {
          // Gap between clips — hide video (black), advance time via RAF clock
          video.pause()
          setShowVideo(false)
          inGapRef.current      = true
          gapFromRef.current    = cur.end
          gapWallRef.current    = performance.now()
          gapTargetRef.current  = next.start
          gapNextIdxRef.current = nextIdx
          gapRAFRef.current     = requestAnimationFrame(tickGap)
        } else {
          // Contiguous — immediate switch
          const nextSlot = (1 - slot) as 0 | 1
          const nextVideo = nextSlot === 0 ? video0Ref.current : video1Ref.current

          lastTimeRef.current = next.start
          onTimeUpdate(next.start)
          activeIdxRef.current = nextIdx

          if (nextVideo) {
            const nextSrc = fileUrl(next.src!)
            if (preloadSrcRef.current !== nextSrc) {
              nextVideo.src = nextSrc
              nextVideo.currentTime = next.inPoint ?? 0
            }
            nextVideo.play().catch(() => {})
          }

          activeSlotRef.current = nextSlot
          setActiveSlot(nextSlot)
          preloadSrcRef.current = ''
          video.pause()
        }
      }
      return
    }

    const t = clip.start + (video.currentTime - (clip.inPoint ?? 0))
    lastTimeRef.current = t
    onTimeUpdate(t)
  }, [clips, onTimeUpdate])

  // ── Render ─────────────────────────────────────────────────────────────────

  function togglePlay() {
    if (isCanvasProject) { setIsPlaying(p => !p); return }
    const video = getActiveVideo()
    if (!video) return
    video.paused ? video.play().catch(() => {}) : video.pause()
  }

  return (
    <div ref={containerRef} className="relative bg-black h-full aspect-[9/16] max-w-full overflow-hidden rounded">
      {isCanvasProject ? (
        <>
          {/* Background items from tracks[0] — images shown at low z-index */}
          {clips.map(item => {
            if (item.type !== 'image' || !item.src) return null
            const visible = currentTime >= item.start && currentTime < item.end
            if (!visible) return null
            return (
              <img
                key={item.id}
                src={fileUrl(item.src)}
                draggable={false}
                className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                style={{ zIndex: 1 }}
              />
            )
          })}
          <div className="absolute inset-0 cursor-pointer" style={{ zIndex: 10 }} onClick={togglePlay} />
        </>
      ) : clips.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
          No clips
        </div>
      ) : (
        <>
          {/* Slot 0 */}
          <video
            ref={video0Ref}
            className="absolute inset-0 w-full h-full object-contain"
            onTimeUpdate={() => { if (activeSlotRef.current === 0) handleTimeUpdate() }}
            onPlay={() => { if (activeSlotRef.current === 0) setIsPlaying(true) }}
            onPause={() => { if (activeSlotRef.current === 0) setIsPlaying(false) }}
            playsInline
            style={{ opacity: showVideo && activeSlot === 0 ? 1 : 0, pointerEvents: activeSlot === 0 ? 'auto' : 'none', zIndex: activeSlot === 0 ? 1 : 0 }}
          />
          {/* Slot 1 */}
          <video
            ref={video1Ref}
            className="absolute inset-0 w-full h-full object-contain"
            onTimeUpdate={() => { if (activeSlotRef.current === 1) handleTimeUpdate() }}
            onPlay={() => { if (activeSlotRef.current === 1) setIsPlaying(true) }}
            onPause={() => { if (activeSlotRef.current === 1) setIsPlaying(false) }}
            playsInline
            style={{ opacity: showVideo && activeSlot === 1 ? 1 : 0, pointerEvents: activeSlot === 1 ? 'auto' : 'none', zIndex: activeSlot === 1 ? 1 : 0 }}
          />
        </>
      )}

      {/* Montaj play/pause control — covers the active video area */}
      {!isCanvasProject && clips.length > 0 && (
        <div
          className="absolute inset-0 cursor-pointer"
          style={{ zIndex: 10 }}
          onClick={togglePlay}
        />
      )}

      {/* Play button overlay — shown when paused */}
      {!isPlaying && (clips.length > 0 || isCanvasProject) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 11 }}>
          <div className="w-14 h-14 rounded-full bg-black/50 flex items-center justify-center">
            <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Overlay tracks — rendered in z-order (track 0 first, higher indexes on top) */}
      {overlayTracks.map((trackItems, trackIdx) =>
        trackItems.map((item) => {
          const visible  = currentTime >= item.start && currentTime < item.end
          // Pre-mount video items slightly before their start so the frame is ready (no flash)
          const mounted  = item.type === 'video'
            ? currentTime >= item.start - VIDEO_PRELOAD_S && currentTime < item.end
            : visible
          if (!mounted) return null

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
            zIndex: trackIdx + 12,
            opacity: item.opacity ?? 1,
          }

          const wrapperClass = `absolute inset-0 ${
            isSel
              ? `${dragState?.type === 'move' ? 'cursor-grabbing' : 'cursor-grab'} ring-1 ring-inset ring-amber-400/40`
              : 'pointer-events-none'
          }`

          // Image items
          if (item.type === 'image' && item.src) {
            return (
              <div key={`${trackIdx}-${item.id}`} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
                <img
                  src={fileUrl(item.src)}
                  draggable={false}
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />
                {isSel && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                  <CornerHandle key={c} corner={c} scale={scale} onMouseDown={startResize(c)} />
                ))}
              </div>
            )
          }

          // Video items (preview uses raw src; remove_bg compositing only happens at final render)
          if (item.type === 'video' && item.src) {
            return (
              <div key={`${trackIdx}-${item.id}`} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
                <OverlayVideo
                  src={fileUrl(item.nobg_preview_src ?? item.src)}
                  currentTime={currentTime}
                  itemStart={item.start}
                  inPoint={item.inPoint ?? 0}
                  isPlaying={isPlaying}
                  muted={item.muted}
                  visible={visible}
                  key={`vid-${item.id}`}
                />
                {isSel && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                  <CornerHandle key={c} corner={c} scale={scale} onMouseDown={startResize(c)} />
                ))}
              </div>
            )
          }

          // JSX overlays
          if (item.type === 'overlay' && item.src) {
            const fps = project.settings?.fps ?? 30
            const frame = Math.round((currentTime - item.start) * fps)
            const durationFrames = Math.round((item.end - item.start) * fps)
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
                    src={item.src}
                    props={item.props ?? {}}
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
          const pos = (item.position as string) ?? 'bottom-left'
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
              {!!item.text && (
                <span className="bg-black/70 text-white text-sm font-bold px-3 py-1.5 rounded">
                  {item.text as string}
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
