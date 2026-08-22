import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { containsTime, geometryFor } from '@bycrux/timeline-core'
import { isProxyUsable, markProxyFailed } from './proxySupport'
import type { EditorProject as Project, VisualItem } from '../../schema'
import type { OverlayFactory } from '../../types'
import OverlayErrorBoundary from '../../carousel/OverlayErrorBoundary'
import { getOverlayDesignCanvas } from '../design-canvas'
import { ensureGoogleFontsLoaded } from '../../lib/google-fonts'
import type { Corner, OverlayChanges } from './useDragOverlay'
import type { useDragOverlay } from './useDragOverlay'
import { enabledTrackItems } from '../timeline/timeline-model'

// Mount video items this many seconds before item.start so the frame is ready.
//
// This pre-mount window is deliberately NOT part of @bycrux/timeline-core's
// activation predicate: a pre-mounted item is rendered at opacity 0 and is not
// "on screen" in any sense the renderer or sample-frame would agree with. It
// exists purely to give the browser time to decode the first frame so the item
// doesn't flash in — presentation, not activation. `containsTime` (the shared
// predicate) still decides `visible`; see timeline-core/index.d.ts.
const VIDEO_PRELOAD_S = 0.4

// Synced video overlay — seeks to the correct position within the item's inPoint/outPoint range
function OverlayVideo({ src, currentTime, itemStart, inPoint, isPlaying, muted, visible, onSrcError }: {
  src: string; currentTime: number; itemStart: number; inPoint: number
  isPlaying: boolean; muted?: boolean; visible: boolean; onSrcError?: () => void
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
    if (isPlaying && visible) {
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [isPlaying, visible])

  return (
    <video
      ref={ref}
      // Anonymous CORS so cross-origin R2 clips aren't tainted (would mute the
      // Web Audio graph). crossOrigin must be set before src. R2 sends ACAO.
      crossOrigin="anonymous"
      src={src}
      muted={muted}
      preload="auto"
      onError={onSrcError}
      onSeeked={() => {
        // After a mid-clip seek the browser may have paused to buffer — restart if we should be playing
        const v = ref.current
        if (!v) return
        if (isPlayingRef.current && visibleRef.current && v.paused) {
          v.play().catch(() => {})
        }
      }}
      playsInline
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      style={{ opacity: visible ? 1 : 0 }}
    />
  )
}

// ---------------------------------------------------------------------------
// Recursively rewrite absolute workspace path strings in overlay props to
// servable proxy URLs (via fileUrl), so <img src> resolves in the browser
// preview. Mirrors the render-side rewritePathsToFileUrls (bundle.js), which
// already recurses — without this, image paths nested in array/object props
// (e.g. players[].src, items[].src) reach <img> raw as /var/hub-scratch/... and
// render blank in preview even though they render correctly in the final MP4.
// Already-proxied /api/ URLs are left untouched (idempotent).
export function resolveOverlayPropPaths(
  value: unknown,
  fileUrl: (path: string) => string,
): unknown {
  if (typeof value === 'string') {
    return value.startsWith('/') && !value.startsWith('/api/') ? fileUrl(value) : value
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveOverlayPropPaths(v, fileUrl))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveOverlayPropPaths(v, fileUrl)]),
    )
  }
  return value
}

// CustomOverlay: fetches, compiles, and renders a custom JSX overlay file
//
// Live overlay-edit reload behavior (Montaj host):
//   - When `watchFile` is provided, it opens a watch subscription on the
//     template's `src` path. On change: calls `clearOverlayCache?.(src)` then
//     recompiles via `compileOverlay(src)`.
//   - When `watchFile` is absent (non-Montaj host), the component only compiles
//     once on `src` change (static preview — graceful, no error).
//   - No raw /api/files/stream EventSource is ever opened in this package.
// ---------------------------------------------------------------------------

interface CustomOverlayProps {
  src: string
  props: Record<string, unknown>
  frame: number
  fps: number
  durationFrames: number
  googleFonts?: string[]
  compileOverlay: (src: string) => Promise<OverlayFactory>
  clearOverlayCache?: (src?: string) => void
  watchFile?: (path: string, onChange: () => void) => () => void
  fileUrl: (path: string) => string
}

function CustomOverlay({
  src,
  props,
  frame,
  fps,
  durationFrames,
  googleFonts,
  compileOverlay,
  clearOverlayCache,
  watchFile,
  fileUrl,
}: CustomOverlayProps) {
  const [factory, setFactory] = useState<OverlayFactory | null>(null)
  const [error, setError]     = useState<string | null>(null)

  const compile = useCallback(() => {
    clearOverlayCache?.(src)
    compileOverlay(src)
      .then((f) => setFactory(() => f))
      .catch((e) => setError(String(e)))
  }, [src, compileOverlay, clearOverlayCache])

  useEffect(() => { compile() }, [compile])

  // Inject Google Fonts declared on the overlay item so the preview renders
  // with the same font metrics as the renderer (bundle.js does the same in
  // generateHtml). Without this, preview falls back to sans-serif and authors
  // get a misleadingly narrow preview of text that will overflow at render.
  useEffect(() => { ensureGoogleFontsLoaded(googleFonts) }, [googleFonts])

  // Live overlay-edit reload via injected watchFile (Montaj host).
  // When watchFile is absent (non-Montaj), this effect is a no-op — static preview.
  useEffect(() => {
    if (!watchFile) return
    const unwatch = watchFile(src, () => compile())
    return () => unwatch()
  }, [src, watchFile, compile])

  // Deep-clone/rewrite the props once per props change instead of every frame.
  // Live prop edits (OverlayPropsModal → VideoEditor.withItemProps) always
  // produce a new `props` object reference, so this recomputes on every edit.
  const resolvedProps = useMemo(
    () => resolveOverlayPropPaths(props, fileUrl) as Record<string, unknown>,
    [props, fileUrl],
  )

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

// Segmented control for an image item's object-fit. Appears below the selected
// image's bounding box; counter-scales so it stays a constant size regardless of
// the item's scale. 'fill' is the legacy stretch behavior (kept for opt-in).
const FIT_OPTIONS: Array<'cover' | 'contain' | 'fill'> = ['cover', 'contain', 'fill']
function FitControl({ value, scale, onChange }: {
  value: 'cover' | 'contain' | 'fill'
  scale: number
  onChange: (fit: 'cover' | 'contain' | 'fill') => void
}) {
  return (
    <div
      className="absolute bottom-0 left-1/2 z-50 flex gap-px rounded bg-black/70 border border-amber-400/50 overflow-hidden"
      style={{ transform: `translateX(-50%) translateY(140%) scale(${1 / scale})`, transformOrigin: 'top center' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {FIT_OPTIONS.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange(opt) }}
          className={`px-2 py-1 text-[11px] font-mono capitalize ${
            value === opt ? 'bg-amber-400 text-black' : 'text-gray-300 hover:bg-white/10'
          }`}
        >
          {opt}
        </button>
      ))}
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
  onOverlayChange?: (id: string, changes: OverlayChanges) => void
  /** Open the props dialog for an overlay (owned by VideoEditor). */
  onEditOverlay?: (id: string) => void
  containerRef: React.RefObject<HTMLDivElement | null>
  // from useDragOverlay
  dragState: ReturnType<typeof useDragOverlay>['dragState']
  setDragState: ReturnType<typeof useDragOverlay>['setDragState']
  liveOffset: ReturnType<typeof useDragOverlay>['liveOffset']
  liveScale: ReturnType<typeof useDragOverlay>['liveScale']
  liveRotation: ReturnType<typeof useDragOverlay>['liveRotation']
  snapGuides: ReturnType<typeof useDragOverlay>['snapGuides']
  snapRotation: ReturnType<typeof useDragOverlay>['snapRotation']
  // Adapter-injected overlay capabilities
  compileOverlay: (src: string) => Promise<OverlayFactory>
  clearOverlayCache?: (src?: string) => void
  watchFile?: (path: string, onChange: () => void) => () => void
  fileUrl: (path: string) => string
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
  onOverlayChange,
  onEditOverlay,
  containerRef,
  dragState,
  setDragState,
  liveOffset,
  liveScale,
  liveRotation,
  snapGuides,
  snapRotation,
  compileOverlay,
  clearOverlayCache,
  watchFile,
  fileUrl,
}: OverlayItemsLayerProps) {
  const [RENDER_W, RENDER_H] = getOverlayDesignCanvas(project.settings?.resolution)
  // SP3 fix B2: re-render trigger for proxy decode failures — marking a proxy
  // failed flips isProxyUsable() below, swapping the overlay video back to its
  // master src on the forced re-render.
  const [, bumpProxyFail] = useReducer((x: number) => x + 1, 0)

  // Interactive tracks — in canvas mode this includes track 0; otherwise overlays only.
  // Enabled only: a skipped track must not be draggable in the preview either.
  const interactiveTracks = isCanvasProject ? enabledTrackItems(project) : overlayTracks

  return (
    <>
      {/* tracks[0] non-video items (background images) — rendered with drag support at base z-level */}
      {!isCanvasProject && tracks0NonVideo.map((item) => {
        if (item.type !== 'image' || !item.src) return null
        const visible = containsTime(item.start, item.end, currentTime)
        if (!visible) return null
        const isSel    = selectedOverlayId === item.id
        // Persisted geometry from the resolver; live drag state layered on top.
        // The resolver only ever sees the SAVED project, so it cannot know about
        // an in-flight drag — `liveOffset`/`liveScale`/`liveRotation` must keep
        // winning, with `geometryFor` supplying the base each falls back to.
        const g        = geometryFor(item, 'image')
        const fit      = g.fit ?? 'cover'
        const offsetX  = (liveOffset?.id   === item.id ? liveOffset.x       : null) ?? g.offsetX
        const offsetY  = (liveOffset?.id   === item.id ? liveOffset.y       : null) ?? g.offsetY
        const scale    = (liveScale?.id    === item.id ? liveScale.scale    : null) ?? g.scale
        const rotation = (liveRotation?.id === item.id ? liveRotation.rotation : null) ?? g.rotation
        const wrapperStyle: React.CSSProperties = {
          transform: `translate(${offsetX}%, ${offsetY}%) rotate(${rotation}deg) scale(${scale})`,
          transformOrigin: 'center center',
          // Raise above play/pause div (z=10) when selected so pointer events land here
          zIndex: isSel ? 11 : 2,
          opacity: g.opacity,
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
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ objectFit: fit }}
            />
            {handles}
            {isSel && onOverlayChange && (
              <FitControl value={fit} scale={scale} onChange={(next) => onOverlayChange(item.id, { fit: next })} />
            )}
          </div>
        )
      })}

      {/* All interactive tracks — in canvas mode this includes track 0; otherwise overlays only */}
      {interactiveTracks.map((trackItems, trackIdx) =>
        trackItems.map((item) => {
          // Activation: the shared half-open `start <= t < end` predicate.
          const visible  = containsTime(item.start, item.end, currentTime)
          // Presentation-only pre-mount window — see VIDEO_PRELOAD_S above for
          // why it is not (and must not be) a resolver concern. A pre-mounted
          // item still renders at opacity 0 until `visible` flips true.
          const mounted  = item.type === 'video'
            ? containsTime(item.start - VIDEO_PRELOAD_S, item.end, currentTime)
            : visible
          if (!mounted) return null

          const isSel    = selectedOverlayId === item.id
          // Persisted geometry from the resolver; live drag state layered on top
          // (see the tracks[0] block above for why the override has to win).
          const g        = geometryFor(item, item.type)
          const fit      = g.fit ?? 'cover'
          const offsetX  = (liveOffset?.id   === item.id ? liveOffset.x       : null) ?? g.offsetX
          const offsetY  = (liveOffset?.id   === item.id ? liveOffset.y       : null) ?? g.offsetY
          const scale    = (liveScale?.id    === item.id ? liveScale.scale    : null) ?? g.scale
          const rotation = (liveRotation?.id === item.id ? liveRotation.rotation : null) ?? g.rotation

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

          // Double-click a selected JSX overlay opens the props dialog (owned by
          // VideoEditor). stopPropagation keeps it from re-triggering startMove.
          function handleDoubleClick(e: React.MouseEvent) {
            if (!isSel) return
            e.stopPropagation()
            if (item.type === 'overlay' && item.src) onEditOverlay?.(item.id)
          }

          // zIndex derives from the same back-to-front ordering the resolver
          // defines (`byTrackIdx`: lower trackIdx = further back = composited
          // first), but the mapping onto CSS stacking contexts stays local —
          // `trackIdx` here indexes `interactiveTracks`, which in non-canvas mode
          // is `project.tracks.slice(1)`, and the base offsets exist only to clear
          // the play-toggle div (z=10). Canvas mode track 0 sits just above it,
          // others stack above.
          const zIndex = isCanvasProject ? trackIdx + 11 : trackIdx + 12

          const wrapperStyle: React.CSSProperties = {
            transform: `translate(${offsetX}%, ${offsetY}%) rotate(${rotation}deg) scale(${scale})`,
            transformOrigin: 'center center',
            zIndex,
            opacity: g.opacity,
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
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  style={{ objectFit: fit }}
                />
                {handles}
                {isSel && onOverlayChange && (
                  <FitControl value={fit} scale={scale} onChange={(next) => onOverlayChange(item.id, { fit: next })} />
                )}
              </div>
            )
          }

          // Video items (preview uses raw src; remove_bg compositing only happens at final render)
          if (item.type === 'video' && item.src) {
            return (
              <div key={item.id} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove}>
                <OverlayVideo
                  // This is a THIRD src-precedence chain, deliberately not
                  // @bycrux/timeline-core's `playbackSrcFor` (see
                  // PreviewPlayer.tsx / useVideoPlayback.ts for that one): an
                  // overlay-track video loads the ORIGINAL src (skipping
                  // `normalizedSrc` entirely) and pairs it with a raw,
                  // un-rebased `inPoint`. Switching this to
                  // `playbackSrcFor(item, 'preview')` would add the
                  // `normalizedSrc` tier and require rebasing `inPoint` to
                  // match — an unbudgeted behavior change for this item
                  // class. Out of scope for SP2; owned by SP4.
                  //
                  // SP3 adds `proxySrc` as a middle tier (between
                  // `nobg_preview_src` and `src`), same precedence order as
                  // the main chain. `proxySrc` is full-source like `src`
                  // itself — no window, no rebase — so it slots in without
                  // disturbing the raw, un-rebased `inPoint` this chain
                  // already passes through. The tier is capability/failure
                  // gated (SP3 fix B2) exactly like the main chain's.
                  src={fileUrl(item.nobg_preview_src
                    ?? (isProxyUsable(item.proxySrc) ? item.proxySrc : undefined)
                    ?? item.src)}
                  onSrcError={() => {
                    if (!item.nobg_preview_src && isProxyUsable(item.proxySrc) && item.proxySrc) {
                      console.warn(`[montaj] overlay proxy failed to decode — falling back to the master: ${item.proxySrc}`)
                      markProxyFailed(item.proxySrc)
                      bumpProxyFail()
                    }
                  }}
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
              <div key={item.id} className={wrapperClass} style={wrapperStyle} onMouseDown={startMove} onDoubleClick={handleDoubleClick}>
                {/* Render at native 1080×1920 then scale down to match container */}
                <div
                  style={{
                    position: 'absolute', top: 0, left: 0,
                    width: RENDER_W, height: RENDER_H,
                    transform: `scale(${renderScale})`, transformOrigin: 'top left',
                    pointerEvents: 'none',
                  }}
                >
                  <OverlayErrorBoundary
                    label={item.src.split('/').pop() ?? item.src}
                    watchPath={item.src}
                    watchFile={watchFile}
                  >
                    <CustomOverlay
                      src={item.src}
                      props={item.props ?? {}}
                      frame={frame}
                      fps={fps}
                      durationFrames={durationFrames}
                      googleFonts={item.googleFonts}
                      compileOverlay={compileOverlay}
                      clearOverlayCache={clearOverlayCache}
                      watchFile={watchFile}
                      fileUrl={fileUrl}
                    />
                  </OverlayErrorBoundary>
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
