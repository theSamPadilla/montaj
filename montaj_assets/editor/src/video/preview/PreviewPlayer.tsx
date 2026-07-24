import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { videoTransformContainerStyle, videoTransformBoxPct, type VideoTransform } from './transformStyle'
import type { EditorProject as Project } from '../../schema'
import type { OverlayFactory } from '../../types'
import CaptionPreview from './CaptionPreview'
import { getOverlayDesignCanvas } from '../design-canvas'
import { useDragOverlay } from './useDragOverlay'
import type { OverlayChanges } from './useDragOverlay'
import OverlayItemsLayer from './OverlayItemsLayer'
import { useVideoPlayback } from './useVideoPlayback'
import { usePlaybackTime, type PlaybackClock } from '../playback-clock'
import { sourceCropVideoStyle } from './sourceCropStyle'
import CarouselPreview from './CarouselPreview'

// ---------------------------------------------------------------------------

interface PreviewPlayerProps {
  project: Project
  clock: PlaybackClock
  selectedOverlayId?: string
  onOverlayChange?: (id: string, changes: OverlayChanges) => void
  onEditOverlay?: (id: string) => void
  // Adapter-injected capabilities
  compileOverlay: (src: string) => Promise<OverlayFactory>
  clearOverlayCache?: (src?: string) => void
  watchFile?: (path: string, onChange: () => void) => () => void
  fileUrl: (path: string) => string
  resolveCaptionTemplate?: (style: string) => string
}

export default function PreviewPlayer({
  project,
  clock,
  selectedOverlayId,
  onOverlayChange,
  onEditOverlay,
  compileOverlay,
  clearOverlayCache,
  watchFile,
  fileUrl,
  resolveCaptionTemplate,
}: PreviewPlayerProps) {
  if (project.projectType === 'carousel') return <CarouselPreview project={project} />

  // Subscribe to the playhead store. PreviewPlayer legitimately re-renders per
  // tick — activeClip/cropStyle memos and the video/overlay/caption children all
  // depend on the current time.
  const currentTime = usePlaybackTime(clock)

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
  } = useVideoPlayback(project, currentTime, clock.set, fileUrl)

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

  // ── Base-video on-canvas transform (position + zoom) ─────────────────────────
  // The selected tracks[0] video shows drag/resize handles like an overlay: drag
  // to move (offsetX/offsetY), corner-drag or scroll to scale. Live during a
  // pointer drag, committed on pointer-up via onOverlayChange; scroll commits
  // directly. The <video> container reflects it (WYSIWYG with the renderer).
  const selectedClip = useMemo(
    () => clips.find(c => c.id === selectedOverlayId) ?? null,
    [clips, selectedOverlayId],
  )
  const showVideoTransform = !isCanvasProject && !!selectedClip && selectedClip.id === activeClip?.id
  const [liveXf, setLiveXf] = useState<VideoTransform | null>(null)
  const xfDragRef = useRef<
    | { kind: 'move'; startClient: { x: number; y: number }; start: VideoTransform }
    | { kind: 'scale'; center: { x: number; y: number }; startDist: number; start: VideoTransform }
    | null
  >(null)
  const baseXf: VideoTransform = {
    scale: activeClip?.scale ?? 1,
    offsetX: activeClip?.offsetX ?? 0,
    offsetY: activeClip?.offsetY ?? 0,
  }
  const xf = liveXf ?? baseXf
  const transformContainerStyle = videoTransformContainerStyle(xf)
  const xfBox = videoTransformBoxPct(xf)

  const onXfMoveDown = (e: ReactPointerEvent) => {
    e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId)
    xfDragRef.current = { kind: 'move', startClient: { x: e.clientX, y: e.clientY }, start: baseXf }
  }
  const onXfScaleDown = (e: ReactPointerEvent) => {
    e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId)
    const r = containerRef.current?.getBoundingClientRect()
    if (!r) return
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    const startDist = Math.hypot(e.clientX - center.x, e.clientY - center.y) || 1
    xfDragRef.current = { kind: 'scale', center, startDist, start: baseXf }
  }
  const onXfMove = (e: ReactPointerEvent) => {
    const d = xfDragRef.current
    if (!d) return
    if (d.kind === 'move') {
      const ox = (d.start.offsetX ?? 0) + ((e.clientX - d.startClient.x) / (frameSize.w || 1)) * 100
      const oy = (d.start.offsetY ?? 0) + ((e.clientY - d.startClient.y) / (frameSize.h || 1)) * 100
      setLiveXf({ ...d.start, offsetX: ox, offsetY: oy })
    } else {
      const dist = Math.hypot(e.clientX - d.center.x, e.clientY - d.center.y)
      const s = Math.min(8, Math.max(0.2, (d.start.scale ?? 1) * (dist / d.startDist)))
      setLiveXf({ ...d.start, scale: s })
    }
  }
  const onXfUp = () => {
    const live = liveXf
    xfDragRef.current = null
    setLiveXf(null)
    if (live && selectedClip && onOverlayChange) {
      onOverlayChange(selectedClip.id, { offsetX: live.offsetX, offsetY: live.offsetY, scale: live.scale })
    }
  }
  const onXfWheel = (e: ReactWheelEvent) => {
    if (!showVideoTransform || !selectedClip || !onOverlayChange) return
    const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06
    const s = Math.min(8, Math.max(0.2, (activeClip?.scale ?? 1) * factor))
    onOverlayChange(selectedClip.id, { scale: s })
  }

  return (
    <div ref={containerRef} className="relative bg-black h-full max-w-full overflow-hidden rounded" style={{ aspectRatio: `${RENDER_W} / ${RENDER_H}`, isolation: 'isolate' }}>
      {isCanvasProject ? (
        <div className="absolute inset-0 cursor-pointer" style={{ zIndex: 10 }} onClick={togglePlay} />
      ) : clips.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
          No clips
        </div>
      ) : (
        // Transform container — applies the active clip's scale/offset to both
        // slots (the inactive one is invisible). The frame's overflow-hidden clips
        // anything pushed outside. Mirrors the renderer's crop→scale→position.
        <div className="absolute inset-0" style={transformContainerStyle}>
          {/* Slot 0 */}
          <video
            ref={video0Ref}
            // Clips load cross-origin from R2; without this the media is CORS-tainted
            // and the Web Audio createMediaElementSource graph outputs silence. R2
            // sends Access-Control-Allow-Origin, so anonymous CORS keeps it audible.
            crossOrigin="anonymous"
            // Fetch enough to render the seeked poster frame on load (before play).
            preload="auto"
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
            preload="auto"
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVideoDims({ w: v.videoWidth, h: v.videoHeight }) }}
            onTimeUpdate={() => { if (activeSlotRef.current === 1) handleTimeUpdate() }}
            onEnded={() => { if (activeSlotRef.current === 1) handleEnded() }}
            onPlay={() => { if (activeSlotRef.current === 1) setIsPlaying(true) }}
            onPause={() => { if (activeSlotRef.current === 1) handlePause() }}
            playsInline
            style={{ ...baseVideoStyle, opacity: showVideo && activeSlot === 1 ? 1 : 0, pointerEvents: activeSlot === 1 ? 'auto' : 'none', zIndex: activeSlot === 1 ? 1 : 0 }}
          />
        </div>
      )}

      {/* Base-video transform handles — drag to move, corner-drag or scroll to
          zoom. Shown only when the on-screen clip is selected. Above the
          play-toggle (z 10), below overlays (z 12+). */}
      {showVideoTransform && (
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 11 }}>
          <div
            onPointerDown={onXfMoveDown}
            onPointerMove={onXfMove}
            onPointerUp={onXfUp}
            onWheel={onXfWheel}
            style={{
              position: 'absolute',
              left: `${xfBox.left}%`, top: `${xfBox.top}%`, width: `${xfBox.width}%`, height: `${xfBox.height}%`,
              outline: '2px solid var(--editor-selection)', cursor: 'move', pointerEvents: 'auto', touchAction: 'none',
            }}
          />
          {([['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]] as const).map(([k, dx, dy]) => (
            <div
              key={k}
              onPointerDown={onXfScaleDown}
              onPointerMove={onXfMove}
              onPointerUp={onXfUp}
              style={{
                position: 'absolute',
                // Clamp into the frame so corners stay grabbable even when the box
                // is scaled beyond the frame (scale uses pointer-distance, not the
                // handle's position, so a clamped grab still scales correctly).
                left: `calc(${Math.min(98, Math.max(2, xfBox.left + dx * xfBox.width))}% - 6px)`,
                top: `calc(${Math.min(98, Math.max(2, xfBox.top + dy * xfBox.height))}% - 6px)`,
                width: 12, height: 12, backgroundColor: '#fff',
                border: '1.5px solid var(--editor-selection)', borderRadius: 2,
                cursor: 'nwse-resize', pointerEvents: 'auto', touchAction: 'none',
              }}
            />
          ))}
        </div>
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
        onEditOverlay={onEditOverlay}
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
