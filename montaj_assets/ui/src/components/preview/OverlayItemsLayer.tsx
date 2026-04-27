import { useCallback, useEffect, useRef, useState } from 'react'
import { fileUrl } from '@/lib/api'
import type { Project, VisualItem } from '@/lib/types/schema'
import { compileOverlay, clearOverlayCache } from '@/lib/overlay-eval'
import type { OverlayFactory } from '@/lib/overlay-eval'
import type { Corner } from './useDragOverlay'
import type { useDragOverlay } from './useDragOverlay'

const VIDEO_PRELOAD_S = 0.4  // mount this many seconds before item.start so the frame is ready

const DEFAULT_RENDER_W = 1080
const DEFAULT_RENDER_H = 1920

// Synced video overlay — seeks to the correct position within the item's inPoint/outPoint range
function OverlayVideo({ src, currentTime, itemStart, inPoint, isPlaying, muted, visible }: {
  src: string; currentTime: number; itemStart: number; inPoint: number
  isPlaying: boolean; muted?: boolean; visible: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  // Refs so the onSeeked handler can read current playback intent without stale closures
  const isPlayingRef = useRef(isPlaying)
  const visibleRef   = useRef(visible)
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  useEffect(() => { visibleRef.current   = visible   }, [visible])

  // On mount: seek to the frame that will be shown at itemStart so it's ready when it becomes visible.
  // Do NOT call play() here — the play/pause effect handles that and runs on mount too.
  // Calling play() from both effects simultaneously while the WebM is still buffering causes both
  // play() promises to abort each other, leaving the video in a silent play-pending state.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const target = Math.max(inPoint, inPoint + (currentTime - itemStart))
    v.currentTime = target
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On scrub (large jump): re-seek — but only once the video has data.
  // While playing, only re-seek on large jumps (>1.5s) to avoid chasing gap-clock drift.
  // The gap clock and video playback rate diverge slightly; a 0.3s threshold fires too often
  // and causes cascading re-seeks that skip the video forward until it ends prematurely.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (v.readyState < 2) return
    const target = inPoint + (currentTime - itemStart)
    const drift = Math.abs(v.currentTime - target)
    if (!v.paused && drift < 1.5) return
    if (drift > 0.3) {
      v.currentTime = Math.max(inPoint, target)
    }
  }, [currentTime, itemStart, inPoint])

  // Play/pause sync — only play when visible; pause when pre-loading or past end
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const label = src.split('/').pop()
    console.log('[OverlayVideo] isPlaying=', isPlaying, 'visible=', visible, 'paused=', v.paused,
      'readyState=', v.readyState, 'currentTime=', v.currentTime.toFixed(3), 'duration=', v.duration?.toFixed(3),
      'videoW=', v.videoWidth, label)
    if (isPlaying && visible) {
      v.play().then(() => {
        console.log('[OverlayVideo] play() resolved', label, 'ct=', v.currentTime.toFixed(3), 'dur=', v.duration?.toFixed(3))
      }).catch(e => console.warn('[OverlayVideo] play() rejected', label, e))
    } else {
      console.log('[OverlayVideo] pausing', label)
      v.pause()
    }
  }, [isPlaying, visible])

  return (
    <video
      ref={ref}
      src={src}
      muted={muted}
      preload="auto"
      onSeeked={() => {
        // After a mid-clip seek the browser may have paused to buffer — restart if we should be playing
        const v = ref.current
        if (!v) return
        const label = src.split('/').pop()
        console.log('[OverlayVideo] onSeeked paused=', v.paused, 'ct=', v.currentTime.toFixed(3), 'dur=', v.duration?.toFixed(3), 'readyState=', v.readyState, 'isPlaying=', isPlayingRef.current, 'visible=', visibleRef.current, label)
        if (isPlayingRef.current && visibleRef.current && v.paused) {
          v.play().catch(() => {})
        }
      }}
      onTimeUpdate={() => {
        const v = ref.current
        if (!v) return
        // Log first few timeupdate events to confirm playback is actually advancing
        if (!v.dataset.tuCount) v.dataset.tuCount = '0'
        const n = parseInt(v.dataset.tuCount)
        if (n < 3) {
          console.log('[OverlayVideo] timeupdate ct=', v.currentTime.toFixed(3), src.split('/').pop())
          v.dataset.tuCount = String(n + 1)
        }
      }}
      onEnded={() => console.log('[OverlayVideo] ended ct=', ref.current?.currentTime.toFixed(3), src.split('/').pop())}
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

  const compile = useCallback(() => {
    clearOverlayCache(src)
    compileOverlay(src)
      .then((f) => setFactory(() => f))
      .catch((e) => setError(String(e)))
  }, [src])

  useEffect(() => { compile() }, [compile])

  useEffect(() => {
    const es = new EventSource(`/api/files/stream?path=${encodeURIComponent(src)}`)
    es.onmessage = () => compile()
    return () => es.close()
  }, [src, compile])

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

function RotateHandle({ scale, onMouseDown }: {
  scale: number
  onMouseDown: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className="absolute top-0 left-1/2 z-50 cursor-grab flex flex-col items-center"
      style={{ transform: `translateX(-50%) translateY(-100%) scale(${1 / scale})`, transformOrigin: 'bottom center' }}
      onMouseDown={onMouseDown}
    >
      <div className="w-4 h-4 rounded-full border-2 border-amber-400 bg-black/60" />
      <div className="w-px h-3 bg-amber-400" />
    </div>
  )
}

// ---------------------------------------------------------------------------

interface OverlayItemsLayerProps {
  project: Project
  currentTime: number
  isPlaying: boolean
  isCanvasProject: boolean
  overlayTracks: VisualItem[][]
  tracks0NonVideo: VisualItem[]
  renderScale: number
  selectedOverlayId?: string
  containerRef: React.RefObject<HTMLDivElement | null>
  // from useDragOverlay
  dragState: ReturnType<typeof useDragOverlay>['dragState']
  setDragState: ReturnType<typeof useDragOverlay>['setDragState']
  liveOffset: ReturnType<typeof useDragOverlay>['liveOffset']
  liveScale: ReturnType<typeof useDragOverlay>['liveScale']
  liveRotation: ReturnType<typeof useDragOverlay>['liveRotation']
  snapGuides: ReturnType<typeof useDragOverlay>['snapGuides']
  snapRotation: ReturnType<typeof useDragOverlay>['snapRotation']
}

export default function OverlayItemsLayer({
  project,
  currentTime,
  isPlaying,
  isCanvasProject,
  overlayTracks,
  tracks0NonVideo,
  renderScale,
  selectedOverlayId,
  containerRef,
  dragState,
  setDragState,
  liveOffset,
  liveScale,
  liveRotation,
  snapGuides,
  snapRotation,
}: OverlayItemsLayerProps) {
  const RENDER_W = project.settings?.resolution?.[0] ?? DEFAULT_RENDER_W
  const RENDER_H = project.settings?.resolution?.[1] ?? DEFAULT_RENDER_H

  return (
    <>
      {/* tracks[0] non-video items (background images) — rendered with drag support at base z-level */}
      {!isCanvasProject && tracks0NonVideo.map((item) => {
        if (item.type !== 'image' || !item.src) return null
        const visible = currentTime >= item.start && currentTime < item.end
        if (!visible) return null
        const isSel    = selectedOverlayId === item.id
        const offsetX  = (liveOffset?.id   === item.id ? liveOffset.x       : null) ?? item.offsetX  ?? 0
        const offsetY  = (liveOffset?.id   === item.id ? liveOffset.y       : null) ?? item.offsetY  ?? 0
        const scale    = (liveScale?.id    === item.id ? liveScale.scale    : null) ?? item.scale    ?? 1
        const rotation = (liveRotation?.id === item.id ? liveRotation.rotation : null) ?? item.rotation ?? 0
        const wrapperStyle: React.CSSProperties = {
          transform: `translate(${offsetX}%, ${offsetY}%) rotate(${rotation}deg) scale(${scale})`,
          transformOrigin: 'center center',
          // Raise above play/pause div (z=10) when selected so pointer events land here
          zIndex: isSel ? 11 : 2,
          opacity: item.opacity ?? 1,
        }
        const wrapperClass = `absolute inset-0 ${
          isSel
            ? `${dragState?.type === 'move' ? 'cursor-grabbing' : 'cursor-grab'} ring-1 ring-inset ring-amber-400/40`
            : 'pointer-events-none'
        }`
        function startMove(e: React.MouseEvent) {
          if (!isSel) return
          e.stopPropagation()
          setDragState({ id: item.id, type: 'move', initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initRotation: rotation })
        }
        const handles = isSel && (
          <>
            {(['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
              <CornerHandle key={c} corner={c} scale={scale} onMouseDown={(e) => {
                e.stopPropagation()
                setDragState({ id: item.id, type: `resize-${c}`, initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initRotation: rotation })
              }} />
            ))}
            <RotateHandle scale={scale} onMouseDown={(e) => {
              e.stopPropagation()
              const rect = containerRef.current?.getBoundingClientRect()
              if (!rect) return
              const cx = rect.left + rect.width  * (0.5 + offsetX / 100)
              const cy = rect.top  + rect.height * (0.5 + offsetY / 100)
              const initAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
              setDragState({ id: item.id, type: 'rotate', initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initRotation: rotation, cx, cy, initAngle })
            }} />
          </>
        )
        return (
          <div key={item.id} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
            <img
              src={fileUrl(item.src)}
              draggable={false}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            />
            {handles}
          </div>
        )
      })}

      {/* All interactive tracks — in canvas mode this includes track 0; otherwise overlays only */}
      {(isCanvasProject ? project.tracks ?? [] : overlayTracks).map((trackItems, trackIdx) =>
        trackItems.map((item) => {
          const visible  = currentTime >= item.start && currentTime < item.end
          // Pre-mount video items slightly before their start so the frame is ready (no flash)
          const mounted  = item.type === 'video'
            ? currentTime >= item.start - VIDEO_PRELOAD_S && currentTime < item.end
            : visible
          if (!mounted) return null

          const isSel    = selectedOverlayId === item.id
          const offsetX  = (liveOffset?.id   === item.id ? liveOffset.x       : null) ?? item.offsetX  ?? 0
          const offsetY  = (liveOffset?.id   === item.id ? liveOffset.y       : null) ?? item.offsetY  ?? 0
          const scale    = (liveScale?.id    === item.id ? liveScale.scale    : null) ?? item.scale    ?? 1
          const rotation = (liveRotation?.id === item.id ? liveRotation.rotation : null) ?? item.rotation ?? 0

          function startMove(e: React.MouseEvent) {
            if (!isSel) return
            e.stopPropagation()
            setDragState({ id: item.id, type: 'move', initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initRotation: rotation })
          }

          function startResize(corner: Corner) {
            return (e: React.MouseEvent) => {
              e.stopPropagation()
              setDragState({ id: item.id, type: `resize-${corner}`, initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initRotation: rotation })
            }
          }

          function startRotate(e: React.MouseEvent) {
            e.stopPropagation()
            const rect = containerRef.current?.getBoundingClientRect()
            if (!rect) return
            const cx = rect.left + rect.width  * (0.5 + offsetX / 100)
            const cy = rect.top  + rect.height * (0.5 + offsetY / 100)
            const initAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
            setDragState({ id: item.id, type: 'rotate', initX: e.clientX, initY: e.clientY, initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initRotation: rotation, cx, cy, initAngle })
          }

          // zIndex: canvas mode track 0 sits just above the play-toggle div (10), others stack above
          const zIndex = isCanvasProject ? trackIdx + 11 : trackIdx + 12

          const wrapperStyle: React.CSSProperties = {
            transform: `translate(${offsetX}%, ${offsetY}%) rotate(${rotation}deg) scale(${scale})`,
            transformOrigin: 'center center',
            zIndex,
            opacity: item.opacity ?? 1,
          }

          const wrapperClass = `absolute inset-0 ${
            isSel
              ? `${dragState?.type === 'move' ? 'cursor-grabbing' : 'cursor-grab'} ring-1 ring-inset ring-amber-400/40`
              : 'pointer-events-none'
          }`

          const handles = isSel && (
            <>
              {(['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                <CornerHandle key={c} corner={c} scale={scale} onMouseDown={startResize(c)} />
              ))}
              <RotateHandle scale={scale} onMouseDown={startRotate} />
            </>
          )

          // Image items
          if (item.type === 'image' && item.src) {
            return (
              <div key={item.id} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
                <img
                  src={fileUrl(item.src)}
                  draggable={false}
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />
                {handles}
              </div>
            )
          }

          // Video items (preview uses raw src; remove_bg compositing only happens at final render)
          if (item.type === 'video' && item.src) {
            return (
              <div key={item.id} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
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
                {handles}
              </div>
            )
          }

          // JSX overlays
          if (item.type === 'overlay' && item.src) {
            const fps = project.settings?.fps ?? 30
            const frame = Math.round((currentTime - item.start) * fps)
            const durationFrames = Math.round((item.end - item.start) * fps)
            return (
              <div key={item.id} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
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
                {handles}
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
              key={item.id}
              className={`absolute ${isSel ? 'cursor-grab ring-1 ring-amber-400/40' : 'pointer-events-none'} ${posClass[pos] ?? posClass['bottom-left']}`}
              style={wrapperStyle}
              onMouseDown={startMove}
            >
              {!!item.text && (
                <span className="bg-black/70 text-white text-sm font-bold px-3 py-1.5 rounded">
                  {item.text as string}
                </span>
              )}
              {handles}
            </div>
          )
        })
      )}

      {/* Center snap guide lines */}
      {dragState?.type === 'move' && snapGuides.x && (
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-amber-400 pointer-events-none z-50"
             style={{ transform: 'translateX(-50%)' }} />
      )}
      {dragState?.type === 'move' && snapGuides.y && (
        <div className="absolute left-0 right-0 top-1/2 h-px bg-amber-400 pointer-events-none z-50"
             style={{ transform: 'translateY(-50%)' }} />
      )}
      {/* Edge guide lines — always visible during a move drag as reference frame */}
      {dragState?.type === 'move' && <div className="absolute top-0 bottom-0 left-0   w-px bg-amber-400/30 pointer-events-none z-50" />}
      {dragState?.type === 'move' && <div className="absolute top-0 bottom-0 right-0  w-px bg-amber-400/30 pointer-events-none z-50" />}
      {dragState?.type === 'move' && <div className="absolute left-0 right-0 top-0    h-px bg-amber-400/30 pointer-events-none z-50" />}
      {dragState?.type === 'move' && <div className="absolute left-0 right-0 bottom-0 h-px bg-amber-400/30 pointer-events-none z-50" />}
      {/* Edge snap highlight — brighten when snapping to an edge */}
      {dragState?.type === 'move' && snapGuides.left   && <div className="absolute top-0 bottom-0 left-0   w-px bg-amber-400 pointer-events-none z-50" />}
      {dragState?.type === 'move' && snapGuides.right  && <div className="absolute top-0 bottom-0 right-0  w-px bg-amber-400 pointer-events-none z-50" />}
      {dragState?.type === 'move' && snapGuides.top    && <div className="absolute left-0 right-0 top-0    h-px bg-amber-400 pointer-events-none z-50" />}
      {dragState?.type === 'move' && snapGuides.bottom && <div className="absolute left-0 right-0 bottom-0 h-px bg-amber-400 pointer-events-none z-50" />}
      {/* Rotation snap guide — line through center at the snapped angle */}
      {dragState?.type === 'rotate' && snapRotation !== null && (
        <div className="absolute inset-0 pointer-events-none z-50">
          <svg width="100%" height="100%" overflow="visible">
            <line
              x1="50%" y1="50%"
              x2={`calc(50% + 200% * ${Math.cos((snapRotation - 90) * Math.PI / 180)})`}
              y2={`calc(50% + 200% * ${Math.sin((snapRotation - 90) * Math.PI / 180)})`}
              stroke="rgb(251 191 36)" strokeWidth="1" strokeDasharray="4 3" opacity="0.8"
            />
            <line
              x1="50%" y1="50%"
              x2={`calc(50% - 200% * ${Math.cos((snapRotation - 90) * Math.PI / 180)})`}
              y2={`calc(50% - 200% * ${Math.sin((snapRotation - 90) * Math.PI / 180)})`}
              stroke="rgb(251 191 36)" strokeWidth="1" strokeDasharray="4 3" opacity="0.8"
            />
          </svg>
        </div>
      )}
    </>
  )
}
