import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { containsTime } from '@bycrux/timeline-core'
import { videoTransformContainerStyle, videoTransformBoxPct, type VideoTransform } from './transformStyle'
import type { EditorProject as Project } from '../../schema'
import type { OverlayFactory } from '../../types'
import CaptionPreview from './CaptionPreview'
import { getOverlayDesignCanvas } from '../design-canvas'
import { useDragOverlay } from './useDragOverlay'
import type { OverlayChanges } from './useDragOverlay'
import type { CaptionEditPatch } from '../timeline/makeCaptionEdit'
import OverlayItemsLayer from './OverlayItemsLayer'
import { useVideoPlayback } from './useVideoPlayback'
import { useEnginePlayback, type EnginePlayback } from './useEnginePlayback'
import EngineSurface from './EngineSurface'
import { evaluateEngineEligibility } from '../../engine/eligibility'
import type { AcquiredDemux } from '../../engine'
import { usePlaybackTime, type PlaybackClock } from '../playback-clock'
import { gateTimeSink, handOverToHover, useHoverScrubTime, type HoverScrub } from '../hover-scrub'
import { sourceCropVideoStyle } from './sourceCropStyle'
import CarouselPreview from './CarouselPreview'
import SocialSafeZoneOverlay, { type SocialPreviewPlatform } from './SocialSafeZoneOverlay'

// ---------------------------------------------------------------------------

/**
 * SP5 T9 — the transport seam. The ONE cross-component API a host-level
 * keymap needs to drive play/pause without knowing which playback path
 * (legacy `<video>` slots or the WebCodecs engine) is actually running.
 * `PreviewPlayer` fills it from whichever hook is active; see
 * `PreviewSurface` below.
 */
export interface TransportHandle {
  togglePlay: () => void
  isPlaying: () => boolean
  /** The J/K/L shuttle's live transport rate. Engine mode drives the engine's
   *  own rate (audible fast-forward); the legacy path has no rate knob, so it is
   *  a no-op there. */
  setRate: (rate: number) => void
}

/**
 * The audible drag-scrub source's (`../../engine/scrub-source.ts`) seam onto
 * the engine's shared demux LRU — mirrors `TransportHandle`'s shape. Filled
 * only on the WebCodecs engine path (see the effect beside `transportRef`'s,
 * below); stays null on the legacy `<video>` fallback, since a fallback
 * project's clips either lack a `proxySrc` or can't be engine-decoded — this
 * absence IS the capability gate the scrubber needs.
 */
export interface ScrubHandle {
  acquireDemux: (src: string) => Promise<AcquiredDemux>
}

/** Stable no-op for the legacy playback path, which has no transport-rate knob. */
const NO_RATE = (_rate: number) => {}

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
  // Caption selection/positioning — pass-through to CaptionPreview. All optional:
  // a host that omits them (PendingSurface) gets the historical passive,
  // click-through caption layer.
  selectedCaptionId?: string
  onSelectCaption?: (id: string | null) => void
  onCaptionSegmentChange?: (segmentId: string, patch: CaptionEditPatch) => void
  /**
   * SP4 — mirrors `VideoEditorProps['engine']` (see `../../types.ts`).
   * Absent/`{enabled: false}` (default): no effect, the legacy `<video>` slots
   * render exactly as before — the eligibility probe is never even run.
   * `{enabled: true}` asks for the WebCodecs engine; whether this project
   * actually gets it is decided by `useEngineMode` below.
   */
  engine?: { enabled: boolean; debugHud?: boolean }
  /**
   * SP5 T9 — imperative play/pause handle for a host-level keymap/command
   * palette. Filled from whichever playback hook is active (legacy or
   * engine). Absent → no-op; nothing reads or writes it.
   */
  transportRef?: MutableRefObject<TransportHandle | null>
  /**
   * The audible drag-scrub source's engine seam — mirrors `transportRef`.
   * Absent → no-op; nothing reads or writes it.
   */
  scrubHandleRef?: MutableRefObject<ScrubHandle | null>
  /**
   * The preview-axis override: while the pointer is over the timeline with the
   * axis on, this holds the time under it and the preview paints THAT frame
   * instead of the playhead's. Null (or the store absent) → the playhead's
   * frame, which is every other moment and every other host.
   *
   * Deliberately not folded into `clock`: the playhead must not follow the
   * pointer, or the red line and the scrubber handle would chase the mouse and
   * Space would start playing from wherever it happened to rest. See
   * `../hover-scrub.ts`.
   */
  hoverScrub?: HoverScrub
  /**
   * Social-platform preview chrome (mirrors CapCut's "Preview your video for
   * social media" picker) — see `SocialSafeZoneOverlay`. Absent/falsy/
   * unrecognized → no-op, same contract as that component's own `platform`
   * prop, which this passes straight through. Threaded in here (rather than
   * mounted by the host as a sibling of `PreviewPlayer`) so it lands INSIDE
   * the same stacking context as the rest of the picture — see the z-index
   * note at its render site below.
   */
  socialPreview?: SocialPreviewPlatform | string | null
}

export default function PreviewPlayer(props: PreviewPlayerProps) {
  if (props.project.projectType === 'carousel') {
    // CarouselPreview renders into normal document flow (no `isolation:
    // isolate` stacking context of its own — see VideoPreviewPlayer/
    // PreviewSurface below), so the social-preview overlay composes correctly
    // as a plain sibling here; it only needs to move INSIDE the video path.
    return (
      <>
        <CarouselPreview project={props.project} />
        <SocialSafeZoneOverlay platform={props.socialPreview} />
      </>
    )
  }
  return <VideoPreviewPlayer {...props} />
}

// ── Which playback path owns this project ────────────────────────────────────

type EngineMode = 'legacy' | 'engine'

/**
 * Plan decision 2, at its call site.
 *
 * Eligibility is evaluated ONCE per project LOAD — re-run only when the project
 * IDENTITY changes (a different `project.id`), never on an edit. Two
 * consequences the plan states explicitly and this hook is the enforcement of:
 *
 *   - a project that was eligible stays on the engine for the whole session,
 *     even if a clip added later has no proxy yet (that clip alone shows
 *     `EngineSurface`'s Preparing placeholder — the engine never hands a
 *     running project back to the legacy player);
 *   - a project that was INELIGIBLE stays on the legacy player for the whole
 *     session, even if its proxies finish encoding a minute later. A reload
 *     picks up engine mode. The alternative — swapping playback engines under a
 *     playing editor — is the mode-flapping the decision exists to forbid.
 *
 * Returns `null` while the (async) capability probe is still outstanding, which
 * can only happen with the flag ON: with it off the answer is `'legacy'`
 * synchronously, on the first render, with no probe and no console line.
 */
function useEngineMode(
  engine: PreviewPlayerProps['engine'],
  project: Project,
): EngineMode | null {
  const enabled = !!engine?.enabled
  const projectId = project.id
  const [decision, setDecision] = useState<{ id: string; mode: EngineMode } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void evaluateEngineEligibility(project).then((result) => {
      if (cancelled) return
      if (!result.eligible) {
        // ONE line, with the reason. Not a warning: falling back is the
        // designed behavior, not a fault.
        console.info(
          `[montaj] playback engine unavailable for this project — using the legacy player (${result.reason ?? 'ineligible'})`,
        )
      }
      setDecision({ id: projectId, mode: result.eligible ? 'engine' : 'legacy' })
    })
    return () => { cancelled = true }
  // Deliberately NOT `[project]`: an edit must not re-evaluate. The `project`
  // captured here is the one loaded under this id, which is what "evaluated
  // once per project-load" means.
  }, [enabled, projectId])

  if (!enabled) return 'legacy'
  if (!decision || decision.id !== projectId) return null
  return decision.mode
}

function VideoPreviewPlayer(props: PreviewPlayerProps) {
  const { project, clock, engine } = props
  // Subscribe to the playhead store. PreviewPlayer legitimately re-renders per
  // tick — activeClip/cropStyle memos and the video/overlay/caption children all
  // depend on the current time.
  const playheadTime = usePlaybackTime(clock)
  // Hover-scrub wins while it is set. Everything downstream — the playback
  // hooks' seeking, the active-clip memo, the overlay and caption layers —
  // reads this one number, so the previewed frame, the overlays drawn on it and
  // the highlighted caption all describe the same instant.
  const hoverTime = useHoverScrubTime(props.hoverScrub)
  const currentTime = hoverTime ?? playheadTime
  const mode = useEngineMode(engine, project)

  // See `gateTimeSink` — never hand the hooks `clock.set` directly, or seeking
  // to show a hovered frame writes that position back and the red playhead
  // chases the yellow cursor.
  const hoverScrub = props.hoverScrub
  const timeSink = useMemo(() => gateTimeSink(clock, hoverScrub), [clock, hoverScrub])

  const [RENDER_W, RENDER_H] = getOverlayDesignCanvas(project.settings?.resolution)

  // Flag on, probe outstanding. Holding the frame for the (sub-frame, cached
  // after the first project) probe is what keeps the legacy hook from mounting,
  // loading a <video>, wiring Web Audio and tearing it all down again one tick
  // later. The two playback hooks are DIFFERENT components on purpose: mounting
  // one and only one of them is what makes a single hook call per path legal.
  if (mode === null) {
    return (
      <div
        className="relative bg-black h-full max-w-full overflow-hidden rounded"
        style={{ aspectRatio: `${RENDER_W} / ${RENDER_H}`, isolation: 'isolate' }}
      />
    )
  }

  return mode === 'engine'
    ? <EnginePreview {...props} currentTime={currentTime} timeSink={timeSink} />
    : <LegacyPreview {...props} currentTime={currentTime} timeSink={timeSink} />
}

/**
 * The two playback paths, discriminated. `PreviewSurface` reads the shared keys
 * off the union directly and narrows on `mode` for the surface itself; nothing
 * else in the component tree knows which path is running.
 */
type PlaybackBinding =
  | ({ mode: 'legacy' } & ReturnType<typeof useVideoPlayback>)
  | ({ mode: 'engine' } & EnginePlayback)

type SurfaceProps = PreviewPlayerProps & {
  currentTime: number
  /** `clock.set`, gated on hover-preview — see `timeSink` above. Never pass
   *  `clock.set` directly here, or hover-seeking writes back into the clock. */
  timeSink: (t: number) => void
}

function LegacyPreview(props: SurfaceProps) {
  const playback = useVideoPlayback(props.project, props.currentTime, props.timeSink, props.fileUrl)
  return <PreviewSurface {...props} playback={{ mode: 'legacy', ...playback }} />
}

function EnginePreview(props: SurfaceProps) {
  const playback = useEnginePlayback(props.project, props.currentTime, props.timeSink, props.fileUrl)
  return <PreviewSurface {...props} playback={{ mode: 'engine', ...playback }} />
}

function PreviewSurface({
  project,
  clock,
  hoverScrub,
  currentTime,
  playback,
  selectedOverlayId,
  onOverlayChange,
  onEditOverlay,
  compileOverlay,
  clearOverlayCache,
  watchFile,
  fileUrl,
  resolveCaptionTemplate,
  selectedCaptionId,
  onSelectCaption,
  onCaptionSegmentChange,
  engine,
  transportRef,
  scrubHandleRef,
  socialPreview,
}: SurfaceProps & { playback: PlaybackBinding }) {
  const [RENDER_W, RENDER_H] = getOverlayDesignCanvas(project.settings?.resolution)

  // Play from the yellow line, and bring the red one with it — see
  // `handOverToHover`. No-op on every ordinary press of play.
  useEffect(() => {
    if (playback.isPlaying) handOverToHover(clock, hoverScrub)
  }, [playback.isPlaying, hoverScrub, clock])

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
    showVideo,
    isPlaying,
    togglePlay,
    isCanvasProject,
    clips,
    tracks0NonVideo,
    overlayTracks,
  } = playback

  // The transport seam (SP5 T9): fill the host's ref with the ACTIVE path's
  // togglePlay/isPlaying, identically shaped for both legacy and engine
  // playback — a host-level keymap never needs to know which one is running.
  // `isPlaying` is exposed as a getter (not the boolean itself) so a poller
  // (the J/K/L shuttle) always reads the current value, not a stale closure
  // from the render that last wrote the ref.
  // Engine mode carries the real rate knob; the legacy path has none (no-op).
  const setRate = playback.mode === 'engine' ? playback.setRate : NO_RATE
  useEffect(() => {
    if (!transportRef) return
    transportRef.current = { togglePlay, isPlaying: () => isPlaying, setRate }
    return () => { transportRef.current = null }
  }, [transportRef, togglePlay, isPlaying, setRate])

  // The scrub seam: only the engine path can decode a grain, so the legacy
  // `<video>` fallback simply never fills this — that absence is the audible
  // drag-scrub's capability gate. `acquireDemux` is a stable-identity callback
  // (see `useEnginePlayback`), so this effect only re-runs on a mode change.
  const acquireDemux = playback.mode === 'engine' ? playback.acquireDemux : undefined
  useEffect(() => {
    if (!scrubHandleRef || !acquireDemux) return
    scrubHandleRef.current = { acquireDemux }
    return () => { scrubHandleRef.current = null }
  }, [scrubHandleRef, acquireDemux])

  const captionTrack = useMemo(() => project.captions, [project])

  // ── sourceCrop reflection ───────────────────────────────────────────────────
  // Mirror render's crop→contain so the preview frames the clip the way the
  // final output will. The active clip is the one whose [start, end) contains the
  // playhead (same selection the playback hook uses internally). Only the active
  // <video> slot is opaque, so applying the active clip's crop to both slots is
  // safe — the inactive slot is invisible.
  //
  // Activation is `containsTime` from @bycrux/timeline-core — the shared
  // half-open `start <= t < end` predicate, so at an exact cut the LATER clip
  // wins here exactly as it does in the renderer.
  //
  // The `?? clips[clips.length - 1]` tail is deliberately NOT part of the
  // resolver: `resolveAt` returns an EMPTY Scene inside a gap or past the end of
  // the timeline. Falling back to the last clip is editor-side PRESENTATION —
  // it keeps the trailing frame's crop/transform on screen instead of snapping
  // to an untransformed frame — so it stays local. See the `containsTime` note
  // in timeline-core/index.d.ts.
  const activeClip = useMemo(
    () => clips.find(c => containsTime(c.start, c.end, currentTime)) ?? clips[clips.length - 1],
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
        // Transform container — applies the active clip's scale/offset to the
        // picture surface. On the legacy path that surface is the two <video>
        // slots (the inactive one is invisible); on the engine path it is one
        // canvas. The div itself, its styles and its z-order are IDENTICAL for
        // both — the frame's overflow-hidden clips anything pushed outside, and
        // the whole thing mirrors the renderer's crop→scale→position.
        <div className="absolute inset-0" style={transformContainerStyle}>
          {playback.mode === 'engine' ? (
            <EngineSurface
              attach={playback.attachCanvas}
              picture={playback.status.picture}
              reason={playback.status.reason}
              debugHud={engine?.debugHud}
              getStats={playback.getStats}
            />
          ) : (
            <>
              {/* Slot 0 */}
              <video
                ref={playback.video0Ref}
                // Clips load cross-origin from R2; without this the media is CORS-tainted
                // and the Web Audio createMediaElementSource graph outputs silence. R2
                // sends Access-Control-Allow-Origin, so anonymous CORS keeps it audible.
                crossOrigin="anonymous"
                // Fetch enough to render the seeked poster frame on load (before play).
                preload="auto"
                onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVideoDims({ w: v.videoWidth, h: v.videoHeight }) }}
                onTimeUpdate={() => { if (playback.activeSlotRef.current === 0) playback.handleTimeUpdate() }}
                onEnded={() => { if (playback.activeSlotRef.current === 0) playback.handleEnded() }}
                onError={() => playback.handleVideoError(0)}
                onPlay={() => { if (playback.activeSlotRef.current === 0) playback.setIsPlaying(true) }}
                onPause={() => { if (playback.activeSlotRef.current === 0) playback.handlePause() }}
                playsInline
                style={{ ...baseVideoStyle, opacity: showVideo && playback.activeSlot === 0 ? 1 : 0, pointerEvents: playback.activeSlot === 0 ? 'auto' : 'none', zIndex: playback.activeSlot === 0 ? 1 : 0 }}
              />
              {/* Slot 1 */}
              <video
                ref={playback.video1Ref}
                // See slot 0: anonymous CORS so R2 cross-origin clips aren't tainted
                // (which would mute the Web Audio graph).
                crossOrigin="anonymous"
                preload="auto"
                onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVideoDims({ w: v.videoWidth, h: v.videoHeight }) }}
                onTimeUpdate={() => { if (playback.activeSlotRef.current === 1) playback.handleTimeUpdate() }}
                onEnded={() => { if (playback.activeSlotRef.current === 1) playback.handleEnded() }}
                onError={() => playback.handleVideoError(1)}
                onPlay={() => { if (playback.activeSlotRef.current === 1) playback.setIsPlaying(true) }}
                onPause={() => { if (playback.activeSlotRef.current === 1) playback.handlePause() }}
                playsInline
                style={{ ...baseVideoStyle, opacity: showVideo && playback.activeSlot === 1 ? 1 : 0, pointerEvents: playback.activeSlot === 1 ? 'auto' : 'none', zIndex: playback.activeSlot === 1 ? 1 : 0 }}
              />
            </>
          )}
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

      {/* Audio elements are managed programmatically in the playback hook */}

      {/* Caption preview */}
      {captionTrack && (
        <CaptionPreview
          track={captionTrack}
          currentTime={currentTime}
          fps={project.settings?.fps ?? 30}
          compileOverlay={compileOverlay}
          resolveCaptionTemplate={resolveCaptionTemplate}
          selectedCaptionId={selectedCaptionId}
          onSelectCaption={onSelectCaption}
          onCaptionSegmentChange={onCaptionSegmentChange}
        />
      )}

      {/* Social-preview chrome — see `SocialSafeZoneOverlay` and the
          `socialPreview` prop doc above. Rendered HERE, inside this same
          `isolation: isolate` container as the video/overlays/captions above
          and the play glyph below, so its z-index (48) is compared directly
          against theirs rather than being evaluated one stacking context up
          (where a positive z-index sibling of an isolated box paints over
          the ENTIRE box, glyph included, regardless of that box's own
          internal ordering). No-ops on an absent/unrecognized platform, so
          this is unconditional. */}
      <SocialSafeZoneOverlay platform={socialPreview} />
    </div>
  )
}
