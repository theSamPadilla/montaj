import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorProject as Project } from '../../schema'
import type { OverlayFactory } from '../../types'
import CaptionPreview from './CaptionPreview'
import { getOverlayDesignCanvas } from '../design-canvas'
import { useDragOverlay } from './useDragOverlay'
import OverlayItemsLayer from './OverlayItemsLayer'
import { useVideoPlayback } from './useVideoPlayback'
import { sourceCropVideoStyle } from './sourceCropStyle'
import CarouselPreview from './CarouselPreview'

// ---------------------------------------------------------------------------

interface PreviewPlayerProps {
  project: Project
  currentTime: number
  onTimeUpdate: (t: number) => void
  selectedOverlayId?: string
  onOverlayChange?: (id: string, changes: { offsetX?: number; offsetY?: number; scale?: number; rotation?: number; fit?: 'cover' | 'contain' | 'fill' }) => void
  // Adapter-injected capabilities
  compileOverlay: (src: string) => Promise<OverlayFactory>
  clearOverlayCache?: (src?: string) => void
  watchFile?: (path: string, onChange: () => void) => () => void
  fileUrl: (path: string) => string
  resolveCaptionTemplate?: (style: string) => string
}

export default function PreviewPlayer({
  project,
  currentTime,
  onTimeUpdate,
  selectedOverlayId,
  onOverlayChange,
  compileOverlay,
  clearOverlayCache,
  watchFile,
  fileUrl,
  resolveCaptionTemplate,
}: PreviewPlayerProps) {
  if (project.projectType === 'carousel') return <CarouselPreview project={project} />

  const [RENDER_W, RENDER_H] = getOverlayDesignCanvas(project.settings?.resolution)

  const containerRef = useRef<HTMLDivElement>(null)
  const [renderScale, setRenderScale] = useState<number>(1)
  // Frame pixel size — used to compute the sourceCrop CSS transform that mirrors
  // render's crop→contain. Tracked alongside renderScale from the same observer.
  const [frameSize, setFrameSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  // Intrinsic dims of the loaded source <video>, captured on loadedmetadata.
  // Falls back to a clip's own sourceWidth/sourceHeight when present.
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null)

  // Track container size to scale overlay components from 1080×1920 → preview size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setRenderScale(entry.contentRect.width / RENDER_W)
      setFrameSize({ w: entry.contentRect.width, h: entry.contentRect.height })
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
  } = useVideoPlayback(project, currentTime, onTimeUpdate, fileUrl)

  const captionTrack = useMemo(() => project.captions, [project])

  // ── sourceCrop reflection ───────────────────────────────────────────────────
  // Mirror render's crop→contain so the preview frames the clip the way the
  // final output will. The active clip is the one whose [start, end) contains the
  // playhead (same selection the playback hook uses internally). Only the active
  // <video> slot is opaque, so applying the active clip's crop to both slots is
  // safe — the inactive slot is invisible.
  const activeClip = useMemo(
    () => clips.find(c => currentTime >= c.start && currentTime < c.end) ?? clips[clips.length - 1],
    [clips, currentTime],
  )
  const cropStyle = useMemo(() => {
    const crop = activeClip?.sourceCrop
    if (!crop) return null
    const sw = activeClip?.sourceWidth ?? videoDims?.w
    const sh = activeClip?.sourceHeight ?? videoDims?.h
    if (!sw || !sh || !frameSize.w || !frameSize.h) return null
    return sourceCropVideoStyle({
      crop,
      sourceWidth: sw,
      sourceHeight: sh,
      frameWidth: frameSize.w,
      frameHeight: frameSize.h,
    })
  }, [activeClip, videoDims, frameSize])

  // The default full-frame style (no crop). object-contain letterboxes the source.
  const baseVideoStyle = cropStyle
    ? { ...cropStyle }
    : { position: 'absolute' as const, inset: 0, width: '100%', height: '100%', objectFit: 'contain' as const }

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
            // Clips load cross-origin from R2; without this the media is CORS-tainted
            // and the Web Audio createMediaElementSource graph outputs silence. R2
            // sends Access-Control-Allow-Origin, so anonymous CORS keeps it audible.
            crossOrigin="anonymous"
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVideoDims({ w: v.videoWidth, h: v.videoHeight }) }}
            onTimeUpdate={() => { if (activeSlotRef.current === 0) handleTimeUpdate() }}
            onEnded={() => { if (activeSlotRef.current === 0) handleEnded() }}
            onPlay={() => { if (activeSlotRef.current === 0) setIsPlaying(true) }}
            onPause={() => { if (activeSlotRef.current === 0) handlePause() }}
            playsInline
            style={{ ...baseVideoStyle, opacity: showVideo && activeSlot === 0 ? 1 : 0, pointerEvents: activeSlot === 0 ? 'auto' : 'none', zIndex: activeSlot === 0 ? 1 : 0 }}
          />
          {/* Slot 1 */}
          <video
            ref={video1Ref}
            // See slot 0: anonymous CORS so R2 cross-origin clips aren't tainted
            // (which would mute the Web Audio graph).
            crossOrigin="anonymous"
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVideoDims({ w: v.videoWidth, h: v.videoHeight }) }}
            onTimeUpdate={() => { if (activeSlotRef.current === 1) handleTimeUpdate() }}
            onEnded={() => { if (activeSlotRef.current === 1) handleEnded() }}
            onPlay={() => { if (activeSlotRef.current === 1) setIsPlaying(true) }}
            onPause={() => { if (activeSlotRef.current === 1) handlePause() }}
            playsInline
            style={{ ...baseVideoStyle, opacity: showVideo && activeSlot === 1 ? 1 : 0, pointerEvents: activeSlot === 1 ? 'auto' : 'none', zIndex: activeSlot === 1 ? 1 : 0 }}
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
        onOverlayChange={onOverlayChange}
        containerRef={containerRef}
        dragState={dragState}
        setDragState={setDragState}
        liveOffset={liveOffset}
        liveScale={liveScale}
        liveRotation={liveRotation}
        snapGuides={snapGuides}
        snapRotation={snapRotation}
        compileOverlay={compileOverlay}
        clearOverlayCache={clearOverlayCache}
        watchFile={watchFile}
        fileUrl={fileUrl}
      />

      {/* Audio elements are managed programmatically in useVideoPlayback */}

      {/* Caption preview */}
      {captionTrack && (
        <CaptionPreview
          track={captionTrack}
          currentTime={currentTime}
          fps={project.settings?.fps ?? 30}
          compileOverlay={compileOverlay}
          resolveCaptionTemplate={resolveCaptionTemplate}
        />
      )}
    </div>
  )
}
