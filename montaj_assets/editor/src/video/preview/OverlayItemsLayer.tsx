import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { containsTime, geometryAt, geometryFor } from '@bycrux/timeline-core'
import { isProxyUsable, markProxyFailed } from './proxySupport'
import type { EditorProject as Project, VisualItem } from '../../schema'
import type { OverlayFactory } from '../../types'
import OverlayErrorBoundary from '../../carousel/OverlayErrorBoundary'
import { getOverlayDesignCanvas } from '../design-canvas'
import { ensureGoogleFontsLoaded } from '../../lib/google-fonts'
import type { Corner, Edge, OverlayChanges } from './useDragOverlay'
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
function OverlayVideo({ src, currentTime, itemStart, inPoint, speed = 1, isPlaying, muted, visible, onSrcError }: {
  src: string; currentTime: number; itemStart: number; inPoint: number; speed?: number
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
    // Source time = inPoint + S·(projectTime − start), matching timeline-core's
    // `seekTime`. Strict no-op at S=1. A sped/slowed overlay walks its source
    // faster/slower than project time, so without S it would seek to the wrong
    // frame (and, past S=1, run off the end).
    const target = Math.max(inPoint, inPoint + speed * (currentTime - itemStart))
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
    const target = inPoint + speed * (currentTime - itemStart)
    const drift = Math.abs(v.currentTime - target)
    if (!v.paused && drift < 1.5) return
    if (drift > 0.3) {
      v.currentTime = Math.max(inPoint, target)
    }
  }, [currentTime, itemStart, inPoint, speed])

  // Play/pause sync — only play when visible; pause when pre-loading or past end
  useEffect(() => {
    const v = ref.current
    if (!v) return
    // Play at S× so one project-second consumes S source-seconds — keeps the
    // element in step with project time instead of drifting until a re-seek
    // fires. `preservesPitch` matters only for an audible overlay; harmless
    // otherwise. Set before play(); a fresh src load resets rate to 1, so the
    // dependency list re-runs this whenever speed changes under us.
    v.playbackRate = speed
    v.preservesPitch = true
    if (isPlaying && visible) {
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [isPlaying, visible, speed])

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
  // Live prop edits (the panel's Content tab → VideoEditor.withItemProps)
  // always produce a new `props` object reference, so this recomputes on every
  // edit.
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
// Selection chrome — box, resize handles, rotate handle, snap guides
// ---------------------------------------------------------------------------

// Everything the selection draws reads the host theme's selection colour, so a
// selected OVERLAY and a selected base CLIP are the same object to the eye. The
// clip's box is PreviewPlayer.tsx (~:526-559): a 2px outline plus 12px white
// squares with a 1.5px selection-coloured border. These constants exist so the
// two can't drift into "nearly the same" — change the look in one place.
const SELECTION         = 'var(--editor-selection)'
const SELECTION_OUTLINE = `2px solid ${SELECTION}`
const HANDLE_PX         = 12

/** White square with a selection-coloured border — the clip box's handle. */
const HANDLE_FACE: React.CSSProperties = {
  width: HANDLE_PX,
  height: HANDLE_PX,
  backgroundColor: '#fff',
  border: `1.5px solid ${SELECTION}`,
  borderRadius: 2,
}

// Eight handles: four corners scale BOTH axes together, four edge midpoints
// scale exactly one (`useDragOverlay` maps `resize-e`/`resize-w` to X and
// `resize-n`/`resize-s` to Y). Ordered corners-then-edges only for readability.
const RESIZE_HANDLES: Array<Corner | Edge> = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']

const HANDLE_CURSOR: Record<Corner | Edge, string> = {
  nw: 'cursor-nw-resize', ne: 'cursor-ne-resize',
  sw: 'cursor-sw-resize', se: 'cursor-se-resize',
  n:  'cursor-ns-resize', s:  'cursor-ns-resize',
  e:  'cursor-ew-resize', w:  'cursor-ew-resize',
}

/** Anchor point on the item's bounding box, in % of the box. */
const HANDLE_ANCHOR: Record<Corner | Edge, [number, number]> = {
  nw: [0, 0],    n: [50, 0],    ne: [100, 0],
  w:  [0, 50],                  e:  [100, 50],
  sw: [0, 100],  s: [50, 100],  se: [100, 100],
}

// Every chrome element inside the item's wrapper inherits the wrapper's
// `scale(scaleX, scaleY)`, so each counter-scales by the INVERSE OF BOTH AXES to
// stay a constant, SQUARE visual size. A single `scale(1/s)` would leave the
// handles visibly stretched into rectangles on a non-uniformly scaled item.
function ResizeHandle({ handle, scaleX, scaleY, onMouseDown }: {
  handle: Corner | Edge
  scaleX: number
  scaleY: number
  onMouseDown: (e: React.MouseEvent) => void
}) {
  const [ax, ay] = HANDLE_ANCHOR[handle]
  return (
    <div
      data-handle={handle}
      className={`absolute z-50 ${HANDLE_CURSOR[handle]}`}
      style={{
        ...HANDLE_FACE,
        // `left`/`top` put the handle's TOP-LEFT on the anchor point, and the
        // origin is pinned there too — so the transform below is measured from
        // the anchor, not from the handle's own centre.
        left: `${ax}%`,
        top:  `${ay}%`,
        transformOrigin: '0 0',
        // Order is load-bearing: `scale` OUTSIDE `translate`. The -50%/-50%
        // resolves against the handle's own 12px box, and only in this order
        // does the wrapper's scale(sx, sy) cancel out of BOTH the size and the
        // centring offset — leaving a constant 12px square centred on the
        // anchor at any scale. `translate(...) scale(...)` would leave the
        // centring offset scaled and walk the handle off the box.
        transform: `scale(${1 / scaleX}, ${1 / scaleY}) translate(-50%, -50%)`,
      }}
      onMouseDown={onMouseDown}
    />
  )
}

function RotateHandle({ scaleX, scaleY, onMouseDown }: {
  scaleX: number
  scaleY: number
  onMouseDown: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className="absolute top-0 left-1/2 z-50 cursor-grab flex flex-col items-center"
      style={{ transform: `translateX(-50%) translateY(-100%) scale(${1 / scaleX}, ${1 / scaleY})`, transformOrigin: 'bottom center' }}
      onMouseDown={onMouseDown}
    >
      {/* Same white square as a resize handle, lifted clear of the box on a
          short stalk so it never collides with the `n` edge handle. */}
      <div style={HANDLE_FACE} />
      <div style={{ width: 1, height: HANDLE_PX, backgroundColor: SELECTION }} />
    </div>
  )
}

// Segmented control for an image item's object-fit. Appears below the selected
// image's bounding box; counter-scales so it stays a constant size regardless of
// the item's scale. 'fill' is the legacy stretch behavior (kept for opt-in).
const FIT_OPTIONS: Array<'cover' | 'contain' | 'fill'> = ['cover', 'contain', 'fill']
function FitControl({ value, scaleX, scaleY, onChange }: {
  value: 'cover' | 'contain' | 'fill'
  scaleX: number
  scaleY: number
  onChange: (fit: 'cover' | 'contain' | 'fill') => void
}) {
  return (
    <div
      // Part of the selection treatment (it only exists while the item is
      // selected), so it rides the same token as the box and handles rather
      // than keeping an accent of its own.
      className="absolute bottom-0 left-1/2 z-50 flex gap-px rounded bg-black/70 border overflow-hidden"
      style={{
        borderColor: SELECTION,
        transform: `translateX(-50%) translateY(140%) scale(${1 / scaleX}, ${1 / scaleY})`,
        transformOrigin: 'top center',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {FIT_OPTIONS.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange(opt) }}
          className={`px-2 py-1 text-[11px] font-mono capitalize ${
            value === opt ? 'text-black' : 'text-gray-300 hover:bg-white/10'
          }`}
          style={value === opt ? { backgroundColor: SELECTION } : undefined}
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
        // Animated for the same reason as the items branch below: the renderer
        // composites tracks[0] images through the very same
        // buildImageItemFilterParts, which since SP9d compiles their curves into
        // ffmpeg expressions. Leaving this branch on the static resolve would
        // put back a preview/render divergence in the one place nobody would
        // look for it. Opacity stays static here too — ffmpeg cannot vary it.
        const gAnimated = geometryAt(item, 'image', currentTime - item.start)
        const g        = { ...gAnimated, opacity: geometryFor(item, 'image').opacity }
        const fit      = g.fit ?? 'cover'
        const offsetX  = (liveOffset?.id   === item.id ? liveOffset.x       : null) ?? g.offsetX
        const offsetY  = (liveOffset?.id   === item.id ? liveOffset.y       : null) ?? g.offsetY
        const scale    = (liveScale?.id    === item.id ? liveScale.scale    : null) ?? g.scale
        // The rendered box is per-axis; `scale` above stays the uniform value the
        // drag state is seeded with. `g.scaleX`/`g.scaleY` already fall back to
        // `g.scale`, so a legacy scale-only item resolves both to the same number.
        const scaleX   = (liveScale?.id    === item.id ? liveScale.scaleX   : null) ?? g.scaleX
        const scaleY   = (liveScale?.id    === item.id ? liveScale.scaleY   : null) ?? g.scaleY
        const rotation = (liveRotation?.id === item.id ? liveRotation.rotation : null) ?? g.rotation
        const hasPerAxis = item.scaleX != null || item.scaleY != null
        const wrapperStyle: React.CSSProperties = {
          transform: `translate(${offsetX}%, ${offsetY}%) rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`,
          transformOrigin: 'center center',
          // Raise above play/pause div (z=10) when selected so pointer events land here
          zIndex: isSel ? 11 : 2,
          opacity: g.opacity,
          // Selection box — the same 2px token outline a selected base clip
          // gets (PreviewPlayer.tsx ~:536), so the two read as one treatment.
          ...(isSel ? { outline: SELECTION_OUTLINE } : null),
        }
        const wrapperClass = `absolute inset-0 ${
          isSel
            ? (dragState?.type === 'move' ? 'cursor-grabbing' : 'cursor-grab')
            : 'pointer-events-none'
        }`
        const initGeom = { initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initScaleX: scaleX, initScaleY: scaleY, initHasPerAxis: hasPerAxis, initRotation: rotation }
        function startMove(e: React.MouseEvent) {
          if (!isSel) return
          e.stopPropagation()
          setDragState({ id: item.id, type: 'move', initX: e.clientX, initY: e.clientY, ...initGeom })
        }
        const handles = isSel && (
          <>
            {RESIZE_HANDLES.map(h => (
              <ResizeHandle key={h} handle={h} scaleX={scaleX} scaleY={scaleY} onMouseDown={(e) => {
                e.stopPropagation()
                setDragState({ id: item.id, type: `resize-${h}`, initX: e.clientX, initY: e.clientY, ...initGeom })
              }} />
            ))}
            <RotateHandle scaleX={scaleX} scaleY={scaleY} onMouseDown={(e) => {
              e.stopPropagation()
              const rect = containerRef.current?.getBoundingClientRect()
              if (!rect) return
              const cx = rect.left + rect.width  * (0.5 + offsetX / 100)
              const cy = rect.top  + rect.height * (0.5 + offsetY / 100)
              const initAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
              setDragState({ id: item.id, type: 'rotate', initX: e.clientX, initY: e.clientY, ...initGeom, cx, cy, initAngle })
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
              <FitControl value={fit} scaleX={scaleX} scaleY={scaleY} onChange={(next) => onOverlayChange(item.id, { fit: next })} />
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
          //
          // EVERY item kind animates its position, scale and rotation: since
          // SP9d the renderer compiles a clip's curves into time-varying ffmpeg
          // expressions (encode-segment.js `animatedGeometry`), so a moving clip
          // in this preview is a promise the export now keeps.
          //
          // OPACITY IS THE ONE EXCEPTION, and it is not a cost decision — it is
          // a wall. ffmpeg's `colorchannelmixer` takes its alpha gain `aa` as a
          // <double> and accepts no expression at all, so a clip's opacity curve
          // cannot reach the render in any form. Animating it here would put
          // back exactly the preview/render divergence this package exists to
          // prevent: a fade the viewer sees and the export silently drops. So
          // clips sample the curve for geometry and keep their STATIC opacity.
          //
          // Do not "finish the job" by dropping this override. Overlays are
          // unaffected — they are baked per frame in a browser, where opacity is
          // just another CSS value.
          const animated = geometryAt(item, item.type, currentTime - item.start)
          const g        = item.type === 'overlay'
            ? animated
            : { ...animated, opacity: geometryFor(item, item.type).opacity }
          const fit      = g.fit ?? 'cover'
          const offsetX  = (liveOffset?.id   === item.id ? liveOffset.x       : null) ?? g.offsetX
          const offsetY  = (liveOffset?.id   === item.id ? liveOffset.y       : null) ?? g.offsetY
          const scale    = (liveScale?.id    === item.id ? liveScale.scale    : null) ?? g.scale
          // Per-axis is what the box actually renders at; `scale` stays the
          // uniform value the drag state carries. `g.scaleX`/`g.scaleY` already
          // fall back to `g.scale`, so a legacy item resolves both to one number.
          const scaleX   = (liveScale?.id    === item.id ? liveScale.scaleX   : null) ?? g.scaleX
          const scaleY   = (liveScale?.id    === item.id ? liveScale.scaleY   : null) ?? g.scaleY
          const rotation = (liveRotation?.id === item.id ? liveRotation.rotation : null) ?? g.rotation
          // Whether the item PERSISTS per-axis scale (vs inheriting both from the
          // legacy uniform `scale`) — decides whether a resize commits per-axis
          // fields; see `onUp` in useDragOverlay.ts.
          const hasPerAxis = item.scaleX != null || item.scaleY != null
          const initGeom = { initOffsetX: offsetX, initOffsetY: offsetY, initScale: scale, initScaleX: scaleX, initScaleY: scaleY, initHasPerAxis: hasPerAxis, initRotation: rotation }

          function startMove(e: React.MouseEvent) {
            if (!isSel) return
            e.stopPropagation()
            setDragState({ id: item.id, type: 'move', initX: e.clientX, initY: e.clientY, ...initGeom })
          }

          // Corner OR edge — `useDragOverlay` reads the suffix and decides
          // between a both-axes and a single-axis gesture.
          function startResize(handle: Corner | Edge) {
            return (e: React.MouseEvent) => {
              e.stopPropagation()
              setDragState({ id: item.id, type: `resize-${handle}`, initX: e.clientX, initY: e.clientY, ...initGeom })
            }
          }

          function startRotate(e: React.MouseEvent) {
            e.stopPropagation()
            const rect = containerRef.current?.getBoundingClientRect()
            if (!rect) return
            const cx = rect.left + rect.width  * (0.5 + offsetX / 100)
            const cy = rect.top  + rect.height * (0.5 + offsetY / 100)
            const initAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
            setDragState({ id: item.id, type: 'rotate', initX: e.clientX, initY: e.clientY, ...initGeom, cx, cy, initAngle })
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

          // PARITY-CRITICAL: `render/test/overlay-transform-parity.test.mjs`
          // hand-mirrors this exact `transform`/`transformOrigin`/`opacity`
          // template (its `previewStyle`, ~:56-63) to prove the render bake
          // produces the same CSS string this preview does — it cannot import
          // this .tsx file into its plain node:test runner, so it transcribes
          // instead. This file's own suite
          // (preview/__tests__/OverlayItemsLayer.keyframes.test.tsx, the
          // "pins the exact preview template" test) pins the SAME literal
          // template against what this component actually renders, so a drift
          // here fails THAT test even though the render-side test can't see
          // this file at all. Change this template, update both.
          //
          // The template ships in FIVE places, two real and three transcribed:
          // this line, the tracks[0] block above, the keyframes suite's
          // `previewStyle`, render/bundle.js's overlay bake, and the render
          // parity suite's `previewStyle`. The render-side pair is mid-migration
          // onto the two-argument `scale(sx, sy)` form under its own slice, so
          // it still transcribes the one-argument form for now — that gap is
          // known and tracked, not a drift to "fix" from here.
          const wrapperStyle: React.CSSProperties = {
            transform: `translate(${offsetX}%, ${offsetY}%) rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`,
            transformOrigin: 'center center',
            zIndex,
            opacity: g.opacity,
            // Selection box. NOT part of the parity template above — the render
            // bake has no selection state to reproduce — so it is appended
            // here, after the three transcribed properties, and only when the
            // item is actually selected.
            ...(isSel ? { outline: SELECTION_OUTLINE } : null),
          }

          const wrapperClass = `absolute inset-0 ${
            isSel
              ? (dragState?.type === 'move' ? 'cursor-grabbing' : 'cursor-grab')
              : 'pointer-events-none'
          }`

          const handles = isSel && (
            <>
              {RESIZE_HANDLES.map(h => (
                <ResizeHandle key={h} handle={h} scaleX={scaleX} scaleY={scaleY} onMouseDown={startResize(h)} />
              ))}
              <RotateHandle scaleX={scaleX} scaleY={scaleY} onMouseDown={startRotate} />
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
                  <FitControl value={fit} scaleX={scaleX} scaleY={scaleY} onChange={(next) => onOverlayChange(item.id, { fit: next })} />
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
                  speed={item.speed ?? 1}
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
              // The selection outline rides on `wrapperStyle` (shared with the
              // branches above), so only the cursor differs from unselected.
              className={`absolute ${isSel ? 'cursor-grab' : 'pointer-events-none'} ${posClass[pos] ?? posClass['bottom-left']}`}
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

      {/* Snap guides. All of these are selection chrome, so they read the same
          token as the box and handles. The faint reference frame gets its
          fade from element `opacity` rather than a translucent colour: the
          token is an opaque colour string, and this codebase deliberately
          avoids `color-mix` (see ControlsInfoModal.tsx ~:130). */}
      {/* Center snap guide lines */}
      {dragState?.type === 'move' && snapGuides.x && (
        <div className="absolute top-0 bottom-0 left-1/2 w-px pointer-events-none z-50"
             style={{ backgroundColor: SELECTION, transform: 'translateX(-50%)' }} />
      )}
      {dragState?.type === 'move' && snapGuides.y && (
        <div className="absolute left-0 right-0 top-1/2 h-px pointer-events-none z-50"
             style={{ backgroundColor: SELECTION, transform: 'translateY(-50%)' }} />
      )}
      {/* Edge guide lines — always visible during a move drag as reference frame */}
      {dragState?.type === 'move' && <div className="absolute top-0 bottom-0 left-0   w-px pointer-events-none z-50" style={{ backgroundColor: SELECTION, opacity: 0.3 }} />}
      {dragState?.type === 'move' && <div className="absolute top-0 bottom-0 right-0  w-px pointer-events-none z-50" style={{ backgroundColor: SELECTION, opacity: 0.3 }} />}
      {dragState?.type === 'move' && <div className="absolute left-0 right-0 top-0    h-px pointer-events-none z-50" style={{ backgroundColor: SELECTION, opacity: 0.3 }} />}
      {dragState?.type === 'move' && <div className="absolute left-0 right-0 bottom-0 h-px pointer-events-none z-50" style={{ backgroundColor: SELECTION, opacity: 0.3 }} />}
      {/* Edge snap highlight — brighten when snapping to an edge */}
      {dragState?.type === 'move' && snapGuides.left   && <div className="absolute top-0 bottom-0 left-0   w-px pointer-events-none z-50" style={{ backgroundColor: SELECTION }} />}
      {dragState?.type === 'move' && snapGuides.right  && <div className="absolute top-0 bottom-0 right-0  w-px pointer-events-none z-50" style={{ backgroundColor: SELECTION }} />}
      {dragState?.type === 'move' && snapGuides.top    && <div className="absolute left-0 right-0 top-0    h-px pointer-events-none z-50" style={{ backgroundColor: SELECTION }} />}
      {dragState?.type === 'move' && snapGuides.bottom && <div className="absolute left-0 right-0 bottom-0 h-px pointer-events-none z-50" style={{ backgroundColor: SELECTION }} />}
      {/* Rotation snap guide — line through center at the snapped angle.
          `stroke` goes through the CSS `style` prop, NOT the SVG presentation
          attribute: `var()` is only resolved by the CSS cascade, so
          stroke="var(--editor-selection)" would be parsed as an unknown paint
          and drop the line entirely. */}
      {dragState?.type === 'rotate' && snapRotation !== null && (
        <div className="absolute inset-0 pointer-events-none z-50">
          <svg width="100%" height="100%" overflow="visible">
            <line
              x1="50%" y1="50%"
              x2={`calc(50% + 200% * ${Math.cos((snapRotation - 90) * Math.PI / 180)})`}
              y2={`calc(50% + 200% * ${Math.sin((snapRotation - 90) * Math.PI / 180)})`}
              style={{ stroke: SELECTION }}
              strokeWidth="1" strokeDasharray="4 3" opacity="0.8"
            />
            <line
              x1="50%" y1="50%"
              x2={`calc(50% - 200% * ${Math.cos((snapRotation - 90) * Math.PI / 180)})`}
              y2={`calc(50% - 200% * ${Math.sin((snapRotation - 90) * Math.PI / 180)})`}
              style={{ stroke: SELECTION }}
              strokeWidth="1" strokeDasharray="4 3" opacity="0.8"
            />
          </svg>
        </div>
      )}

    </>
  )
}
