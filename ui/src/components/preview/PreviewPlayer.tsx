import { useEffect, useMemo, useRef, useState } from 'react'
import { fileUrl } from '@/lib/api'
import type { Project } from '@/lib/project'
import CaptionPreview from '@/components/CaptionPreview'
import { useDragOverlay } from './useDragOverlay'
import OverlayItemsLayer from './OverlayItemsLayer'
import { useVideoPlayback } from './useVideoPlayback'

const DEFAULT_RENDER_W = 1080
const DEFAULT_RENDER_H = 1920

// ---------------------------------------------------------------------------

interface PreviewPlayerProps {
  project: Project
  currentTime: number
  onTimeUpdate: (t: number) => void
  selectedOverlayId?: string
  onOverlayChange?: (id: string, changes: { offsetX?: number; offsetY?: number; scale?: number; rotation?: number }) => void
}

export default function PreviewPlayer({ project, currentTime, onTimeUpdate, selectedOverlayId, onOverlayChange }: PreviewPlayerProps) {
  const RENDER_W = project.settings?.resolution?.[0] ?? DEFAULT_RENDER_W
  const RENDER_H = project.settings?.resolution?.[1] ?? DEFAULT_RENDER_H

  const containerRef = useRef<HTMLDivElement>(null)
  const [renderScale, setRenderScale] = useState<number>(1)

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

  // ── Drag state ────────────────────────────────────────────────────────────
  const {
    dragState, setDragState,
    liveOffset, liveScale, liveRotation,
    snapGuides, snapRotation,
  } = useDragOverlay(containerRef, onOverlayChange)

  const {
    video0Ref,
    video1Ref,
    activeSlotRef,
    activeSlot,
    showVideo,
    isPlaying,
    setIsPlaying,
    handleTimeUpdate,
    handlePause,
    handleEnded,
    togglePlay,
    isCanvasProject,
    clips,
    tracks0NonVideo,
    overlayTracks,
    musicRef,
  } = useVideoPlayback(project, currentTime, onTimeUpdate)

  const captionTrack = useMemo(() => project.captions, [project])

  return (
    <div ref={containerRef} className="relative bg-black h-full max-w-full overflow-hidden rounded" style={{ aspectRatio: `${RENDER_W} / ${RENDER_H}`, isolation: 'isolate' }}>
      {isCanvasProject ? (
        <div className="absolute inset-0 cursor-pointer" style={{ zIndex: 10 }} onClick={togglePlay} />
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
            onEnded={() => { if (activeSlotRef.current === 0) handleEnded() }}
            onPlay={() => { if (activeSlotRef.current === 0) setIsPlaying(true) }}
            onPause={() => { if (activeSlotRef.current === 0) handlePause() }}
            playsInline
            style={{ opacity: showVideo && activeSlot === 0 ? 1 : 0, pointerEvents: activeSlot === 0 ? 'auto' : 'none', zIndex: activeSlot === 0 ? 1 : 0 }}
          />
          {/* Slot 1 */}
          <video
            ref={video1Ref}
            className="absolute inset-0 w-full h-full object-contain"
            onTimeUpdate={() => { if (activeSlotRef.current === 1) handleTimeUpdate() }}
            onEnded={() => { if (activeSlotRef.current === 1) handleEnded() }}
            onPlay={() => { if (activeSlotRef.current === 1) setIsPlaying(true) }}
            onPause={() => { if (activeSlotRef.current === 1) handlePause() }}
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
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 100 }}>
          <div className="w-14 h-14 rounded-full bg-black/50 flex items-center justify-center">
            <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      <OverlayItemsLayer
        project={project}
        currentTime={currentTime}
        isPlaying={isPlaying}
        isCanvasProject={isCanvasProject}
        overlayTracks={overlayTracks}
        tracks0NonVideo={tracks0NonVideo}
        renderScale={renderScale}
        selectedOverlayId={selectedOverlayId}
        containerRef={containerRef}
        dragState={dragState}
        setDragState={setDragState}
        liveOffset={liveOffset}
        liveScale={liveScale}
        liveRotation={liveRotation}
        snapGuides={snapGuides}
        snapRotation={snapRotation}
      />

      {/* Background music — canvas and video projects */}
      {(project.audio?.music as { src?: string } | undefined)?.src && (
        <audio
          ref={musicRef}
          src={fileUrl((project.audio.music as { src: string }).src)}
          preload="auto"
        />
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
