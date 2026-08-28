/**
 * TimelineCanvas (SP5 T4) — the canvas track-row area. It is the ONLY track
 * surface: it carries the visual tracks, the audio lanes and the caption rows
 * alike, and the DOM rows it replaced (which for a while it was mounted in
 * place of, behind a `timeline.canvas` prop) are gone.
 *
 * ── How this stays fast ──────────────────────────────────────────────────
 * Three rules, all of them about NOT re-rendering React:
 *
 * 1. Two stacked canvases. Content (rows, clips, audio) on the lower
 *    one, the playhead alone on the upper one. Playback moves the playhead ~60
 *    times a second; on a single canvas each move would have to repaint every
 *    clip, which is precisely the cost this surface exists to avoid.
 * 2. The playhead subscribes to the playback clock directly, the way the DOM
 *    path's `PlayheadLine` did — except the subscription drives an imperative
 *    redraw instead of a React render, so nothing above it re-renders.
 * 3. Zoom/scroll live in an external store (viewport.ts), not React state, so
 *    a wheel-zoom gesture never re-renders Timeline. Only the zoom badge
 *    subscribes for display.
 *
 * All redraws funnel through `requestRedraw`, which coalesces to one rAF and
 * repaints only the layers marked dirty.
 *
 * ── Pointer interaction (SP5 T5) ─────────────────────────────────────────
 * Every gesture — seek, select, move, trim, roll/slip/slide — is
 * decided by `pointer-machine.ts`, which is pure. This file does only the three
 * things a pure reducer cannot: it turns mouse events into surface-space
 * points, it hands the machine a fresh view of the world on each event, and it
 * performs the effects the machine returns. Listeners follow the same pattern
 * the wheel handler established (a ref to the latest closure, bound once on
 * mount) so a drag never re-binds anything; the document-level move/up pair is
 * attached for the duration of a gesture only, exactly as the DOM rows' drag
 * hook does it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GetFilmstripArgs, GetWaveformPeaksArgs, FilmstripIndex, PeaksData, PendingDrop, Project, FootageDropPayload, ResolveFilePath, TimelineDropPlacement } from '../../../types'
import { FOOTAGE_DND_MIME } from '../../../types'
import type { KeyframeProp, Marker } from '../../../schema'
import type { PlaybackClock } from '../../playback-clock'
import { BASE_VISUAL_ROW_RENDER_HEIGHT_PX, ROW_GAP_PX, VISUAL_ROW_RENDER_HEIGHT_PX } from '../timeline-model'
import { placeDroppedClip, resolveDropPoint } from '../placement'
import { computeTimelineLayout, drawTimelineContent, drawTimelineOverlay, MARKER_FLAG_WIDTH_PX, MARKER_LABEL_GAP_PX, type PendingDropBand, type TimelineLayout, type TimelineMode, type VisualRowLayout } from './draw'
import { hitTest, isEdgeHit, type Point, type SurfaceRect } from './hit-test'
import { keyframeUnionTimes } from './keyframe-strip'
import { renameMarker } from '../markers'
import {
  createPointerMachine,
  type KeyframeSelection,
  type Modifiers,
  type PointerContext,
  type PointerEffect,
} from './pointer-machine'
import { DEFAULT_SNAP_CONFIG, type SnapStrength } from './snap'
import { WaveformPeaksStore, type WaveformSceneLookup } from './waveforms'
import { FilmstripStore, type FilmstripSceneLookup } from './filmstrips'
import {
  EDGE_SCROLL_MAX_PX_PER_SEC,
  EDGE_SCROLL_RAMP_PX,
  EDGE_SCROLL_ZONE_PX,
  ZOOM_BUTTON_FACTOR,
  applyWheelIntent,
  clampScrollSeconds,
  edgeScrollDelta,
  fitViewport,
  formatZoomMultiple,
  observeSurface,
  reclampForDuration,
  scaleContextToDpr,
  syncCanvasBackingStore,
  timeToX,
  useViewportValue,
  wheelIntent,
  withSurfaceWidth,
  xToTime,
  zoomAtPivot,
  zoomMultiple,
  type SurfaceMetrics,
  type ViewportStore,
} from './viewport'

export interface TimelineCanvasProps {
  project: Project
  clock: PlaybackClock
  /** Shared with Timeline's zoom chrome — see `useCanvasZoomControls`. */
  store: ViewportStore
  /** Content duration plus the timeline's drag headroom (timeline-model). */
  totalDuration: number
  /** The project's frame rate. Used for exactly one thing — a click on a
   *  caption seeks half a frame into the segment rather than to its start, so
   *  the preview's frame-snapped clock lands inside it. See the seek in
   *  `pointer-machine`'s `pointerUp`. */
  fps: number
  /** Unified selection: visual items, audio tracks and caption segments alike.
   *  Captions share this ONE array rather than a channel of their own, which is
   *  what lets a mixed clip+caption drag commit as a single undo entry. */
  selectedIds: string[]
  /** Clip and audio boundaries the gestures snap to — Timeline's existing
   *  `computeDerivedTiming` memo, shared with the DOM rows. Absent means no
   *  magnetism, which is the right degradation rather than an error. */
  snapBoundaries?: number[]
  /** Trims close the gap they open, as they do on the DOM rows. */
  rippleMode?: boolean
  /** CapCut's "preview axis", off by default. On, a yellow cursor line tracks
   *  the pointer across this surface and `onHoverScrub` reports the time under
   *  it, so the host can show that frame in the preview while the playhead
   *  stays where it is. Off, this surface behaves exactly as it always has:
   *  no cursor line, and clicking seeks as usual. Pointer gestures are
   *  identical either way — the toggle adds a hover affordance, it does not
   *  change what a click does. */
  previewAxis?: boolean
  /** The time under the pointer while the axis is on, or null when the pointer
   *  leaves or a gesture starts. Fires per mousemove, so the host must route it
   *  to an external store rather than React state. */
  onHoverScrub?: (time: number | null) => void
  /** Timeline's `handleSelectItem` — additive rules and the item↔caption
   *  exclusivity stay owned there, so both surfaces select identically. */
  onSelectItem?: (id: string | null, additive: boolean) => void
  /** A marquee's whole catch, applied in one step. Falls back to replaying
   *  `onSelectItem` per id when the host does not implement it, so a host that
   *  predates the marquee still selects correctly. */
  onSelectItems?: (ids: string[], additive: boolean) => void
  /** The currently selected keyframe, drawn filled. Null when none. */
  selectedKeyframe?: KeyframeSelection | null
  onSelectKeyframe?: (selection: KeyframeSelection | null) => void
  /** Live, uncommitted edit — fires once per pointer move during a gesture. */
  onProjectChange?: (p: Project) => void
  /** Gesture finished; persist. Same split the DOM rows use. */
  onOverlayEdit?: (p: Project) => void
  onInspectClip?: (id: string) => void
  onInspectAudio?: (id: string) => void
  /** Double-click on a caption block. A caption has no inspector dialog, so
   *  this is not `onInspectClip`'s sibling: it asks the host to focus that
   *  segment's row in the transcript sidebar, where caption text is edited. */
  onEditCaption?: (id: string) => void
  /** Right-click on an audio bar's fade GRIP — Vegas' own gesture for picking
   *  a fade's shape. `x`/`y` are CLIENT coordinates (not surface-relative,
   *  unlike every other callback here) because the host renders the picker as
   *  an absolutely-positioned DOM menu of its own, outside this canvas
   *  surface, and a screen position is what CSS `left`/`top` need. Absent →
   *  a right-click on a fade grip falls through to the browser's own context
   *  menu, same as anywhere else on the surface. */
  onFadeCurveMenu?: (args: { trackId: string; side: 'in' | 'out'; x: number; y: number }) => void
  /** Right-click on a keyframe-strip diamond (SP9b T3.3) — `onFadeCurveMenu`'s
   *  sibling for the keyframe-strip's own popup: the host is expected to
   *  offer the six `EASING_NAMES` (via `keyframeOps.setKeyframeEasing`) AND a
   *  way to remove the keyframe (via `keyframeOps.removeKeyframe`), applied
   *  once per entry in `props` — every keyframe track that has a point at
   *  `t`, which is every prop this ONE diamond represents (plan decision 2).
   *  `x`/`y` are CLIENT coordinates, same reason `onFadeCurveMenu`'s are.
   *  `isLast` is true when `t` is the item's LAST keyframe: its easing (which
   *  governs the segment INTO the next keyframe — see `Keyframe.easing`'s
   *  doc in schema.ts) has no next keyframe to reach, so a host offering the
   *  easing picker should grey it out or omit it there — removal still
   *  applies regardless. Absent → a right-click on a diamond falls through to
   *  the browser's own context menu. */
  onKeyframeMenu?: (args: { itemId: string; t: number; props: KeyframeProp[]; isLast: boolean; x: number; y: number }) => void
  /** T6 — the host adapter's peaks fetcher, threaded from
   *  `adapter.getWaveformPeaks` via Timeline. Absent → no waveforms anywhere
   *  (graceful; the surface just never asks). */
  getWaveformPeaks?: (args: GetWaveformPeaksArgs) => Promise<PeaksData>
  /** T7 — the host adapter's filmstrip fetcher, threaded from
   *  `adapter.getFilmstrip` via Timeline. Absent → no filmstrips or
   *  hover-scrub thumbs anywhere (graceful). */
  getFilmstrip?: (args: GetFilmstripArgs) => Promise<FilmstripIndex>
  /** T7 — resolves a filmstrip sheet's host path into a displayable URL, the
   *  SAME mechanism `WaveformChunk.path` uses for the DOM waveform PNGs
   *  (`adapter.fileUrl`). Threaded from Timeline's own `resolveFilePath`. */
  resolveFilePath?: ResolveFilePath
  /** Which ground the painter draws on, resolved from the host theme by
   *  `VideoEditor` (see `isLightTheme`) and threaded through Timeline. The
   *  canvas cannot read a CSS variable, so this is how a theme flip reaches
   *  the pixels. Defaults to `'dark'` — the only mode this surface had — so a
   *  host that never passes it is unchanged. */
  mode?: TimelineMode
  /** A drop of real OS FILES onto this surface, threaded from
   *  `VideoEditorProps.onImportFilesToTimeline` (see its doc for the contract).
   *  Its PRESENCE is what makes this surface accept an OS-file drag at all:
   *  absent, `dragover` never calls `preventDefault` for one, so the browser
   *  keeps its own handling and the whole gesture is inert — which is exactly
   *  what a host that predates this feature gets. */
  onImportFilesToTimeline?: (files: File[], placement: TimelineDropPlacement) => void
  /** Ghost bands for the host's in-flight imports, drawn on the overlay layer.
   *  Absent/empty → nothing extra is painted. */
  pendingDrops?: readonly PendingDrop[]
}

/**
 * The marker rename box, isolated into its own component for the same reason
 * `CanvasZoomBadge` (bottom of this file) is: it owns the viewport
 * subscription itself, so a zoom or scroll while the box is open moves it
 * without making `TimelineCanvas`'s own render body subscribe to the
 * viewport — which would re-render the whole surface on every wheel-zoom
 * tick and pan frame, the exact thing this file's header doc says never
 * happens. The subscription only exists for as long as this component is
 * mounted, i.e. only while a rename is actually open.
 */
function MarkerRenameBox({
  marker,
  store,
  top,
  onCommit,
  onCancel,
}: {
  marker: Marker
  store: ViewportStore
  top: number
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const viewport = useViewportValue(store)
  return (
    <input
      aria-label="Rename marker"
      autoFocus
      defaultValue={marker.label}
      className="absolute z-10 h-4 rounded-sm border border-sky-400 bg-slate-900 px-1 text-[11px] text-slate-50 outline-none"
      style={{
        left: Math.round(timeToX(marker.t, viewport)) + MARKER_FLAG_WIDTH_PX + MARKER_LABEL_GAP_PX,
        top,
        width: 120,
      }}
      onKeyDown={e => {
        // Stop Escape/Enter reaching the document keymap: this box owns
        // them while it is open.
        e.stopPropagation()
        if (e.key === 'Enter') onCommit((e.target as HTMLInputElement).value)
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={e => onCommit(e.target.value)}
    />
  )
}

/**
 * Which video row a drop at surface-y `y` landed on, as an index into the
 * NORMALIZED track order `placeDroppedClip` measures in — or `-1` for "no
 * preference", which is what the ruler, a caption band, an audio lane and the
 * gap between two rows all resolve to.
 *
 * Reads the layout's own row rectangles rather than re-deriving row geometry
 * from heights and gaps: that is the rule stated at the top of `hit-test.ts`
 * ("layout is read, never re-derived"), and it applies here for the same
 * reason — a drop that computed its own rows would drift from the picture the
 * moment a row height changed, and the drift would show as a clip landing on
 * the row above the one you aimed at.
 */
export function dropTrackIndexAt(y: number, layout: TimelineLayout): number {
  for (const row of layout.rows) {
    if (y >= row.y && y < row.y + row.height) return row.trackIdx
  }
  return -1
}

/**
 * Resolve each host `PendingDrop` to the rectangle its ghost is drawn in.
 *
 * A `trackIndex` of -1 (or one naming a row that no longer exists — the host's
 * list is asynchronous and the project can have changed under it) falls back to
 * the BASE video row: the lowest-`trackIdx` row that holds video, else the
 * first row in the layout. With no rows at all there is nowhere to draw, so the
 * band is dropped rather than guessed at a y of 0, which would put it in the
 * ruler.
 *
 * `drop.newTrack` is the one exception to "look up `trackIndex` in `layout`":
 * there IS no row for it yet — `placeOnNewTrack` (placement.ts) hasn't run —
 * so its rectangle is computed instead of looked up, by `newTrackRowRect`
 * below.
 */
export function pendingDropBands(
  pendingDrops: readonly PendingDrop[],
  layout: TimelineLayout,
): PendingDropBand[] {
  if (layout.rows.length === 0) return []
  // `rows` is in DRAW order (highest trackIdx first), so the base video row is
  // found by scanning for the lowest trackIdx that carries video, not by
  // taking rows[0].
  const videoRows = layout.rows.filter(r => r.items.some(it => it.type === 'video'))
  const baseRow = videoRows.length > 0
    ? videoRows.reduce((lowest, r) => (r.trackIdx < lowest.trackIdx ? r : lowest))
    : layout.rows[layout.rows.length - 1]

  // Computed lazily, and only once: no drop in the list needs it unless at
  // least one carries `newTrack`, and every `newTrack` drop shares the exact
  // same rectangle (there is only ever one "next new track" position for a
  // given layout).
  let newTrackRow: { y: number; height: number } | null = null
  const resolveNewTrackRow = (): { y: number; height: number } => {
    if (!newTrackRow) newTrackRow = newTrackRowRect(layout, videoRows, baseRow)
    return newTrackRow
  }

  const bands: PendingDropBand[] = []
  for (const drop of pendingDrops) {
    const row = drop.newTrack
      ? resolveNewTrackRow()
      : layout.rows.find(r => r.trackIdx === drop.trackIndex) ?? baseRow
    bands.push({
      start: drop.atTime,
      end: drop.atTime + Math.max(0, drop.durationSec),
      y: row.y,
      height: row.height,
      label: drop.label,
    })
  }
  return bands
}

/**
 * Where a BRAND NEW video track renders, computed against the CURRENT layout
 * (before that track exists) — the rectangle `pendingDropBands` draws a
 * `newTrack` ghost's band in.
 *
 * `placeOnNewTrack` (placement.ts) always lands a freshly-minted video track
 * at the TOP of the video block — the highest trackIdx among video-kind
 * tracks (its own doc comment walks through why: `orderedTrackArray`'s stable
 * partition keeps the new track last among video-kind tracks, and "last in
 * the video group" is the highest index in a block that is contiguous from
 * 0). In DRAW order that is the row directly ABOVE whichever row currently
 * holds that top-of-video-block spot — above the highest-`trackIdx` entry in
 * `videoRows`, i.e. one row closer to the ruler than the current top video
 * row (or than `baseRow`, when the project's only video row IS the base row).
 * A freshly-created track always carries a video item the moment ingest
 * finishes, so it takes the SAME height every video-kind row gets
 * (`BASE_VISUAL_ROW_RENDER_HEIGHT_PX` — see `computeTimelineLayout`'s own
 * height rule, "any video-kind track", not only trackIdx 0), not the shorter
 * overlay-row height.
 *
 * Clamped so the band can never intrude into the ruler strip: on a project
 * with little or no room between the ruler and the top video row (few or no
 * overlay/caption rows above it) there isn't a full row's worth of space to
 * insert a phantom into without the surface actually growing by one row — the
 * canvas only grows once the real track lands. That is an inherent limit of
 * ghosting a row that does not exist yet, not a bug: the clamp keeps the
 * result directly adjacent to the top of the video block (never past the
 * ruler) rather than off the top of the surface entirely.
 */
function newTrackRowRect(
  layout: TimelineLayout,
  videoRows: readonly VisualRowLayout[],
  baseRow: VisualRowLayout,
): { y: number; height: number } {
  const topVideoRow = videoRows.length > 0
    ? videoRows.reduce((highest, r) => (r.trackIdx > highest.trackIdx ? r : highest))
    : baseRow
  const height = BASE_VISUAL_ROW_RENDER_HEIGHT_PX
  const rulerBottom = layout.ruler.y + layout.ruler.height
  const y = Math.max(rulerBottom, topVideoRow.y - ROW_GAP_PX - height)
  return { y, height }
}

const requestFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? cb => requestAnimationFrame(() => cb())
    : cb => setTimeout(cb, 16) as unknown as number

const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout

/** A monotonic clock for timing the edge auto-scroll loop's frame deltas.
 *  `performance.now()` where available (real browsers, and jsdom under
 *  Vitest's fake timers, which fake it in lockstep with `requestAnimationFrame`);
 *  `Date.now()` as the only fallback. */
function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** Stable empty default so an omitted `snapBoundaries` doesn't churn the
 *  pointer layer's latest-props ref with a fresh array every render. */
const NO_SNAP_BOUNDARIES: number[] = []

/** `NO_SNAP_BOUNDARIES`' sibling, for the same reason: an omitted
 *  `pendingDrops` must not hand the ghost memo a fresh array each render. */
const NO_PENDING_DROPS: readonly PendingDrop[] = []

/**
 * How tall the surface must be to reach the bottom of the pane's visible area.
 *
 * `surfaceOffsetTop` is the surface's top measured from the scroll CONTENT's
 * origin (everything laid out above it: the zoom chrome, the scrubber, the
 * paddings) — NOT its position on screen. That distinction is what makes the
 * measurement scroll-invariant: scrolling a tall timeline moves the surface's
 * screen position but not its offset within the content, so the fill it asks
 * for never grows as you scroll. It is also independent of the surface's OWN
 * height, so setting the result can never change the next measurement.
 *
 * `paddingBelow` is the padding under the surface in the flow (only the
 * Timeline root's `py-3` contributes today). Pure, so it unit-tests without a
 * layout. Clamped at 0 so an overflowing timeline never asks for a negative
 * height (the caller's Math.max keeps the layout height there instead).
 */
export function paneFillHeight(viewportHeight: number, surfaceOffsetTop: number, paddingBelow: number): number {
  return Math.max(0, viewportHeight - surfaceOffsetTop - paddingBelow)
}

/** Sum the `padding-bottom` of every element from `from` up to and including
 *  `to` — the padding that sits under the surface within the scroll viewport,
 *  which the fill must leave clear or it would overflow the pane by that much
 *  and show a scrollbar. Generic over the DOM chain rather than hardcoding the
 *  root's `py-3`, so a class change to the timeline column can't silently
 *  reintroduce the overflow. */
function paddingBelowSurface(from: HTMLElement | null, to: HTMLElement): number {
  let total = 0
  for (let el: HTMLElement | null = from; el; el = el.parentElement) {
    total += parseFloat(getComputedStyle(el).paddingBottom) || 0
    if (el === to) break
  }
  return total
}

export default function TimelineCanvas({
  project,
  clock,
  store,
  totalDuration,
  fps,
  selectedIds,
  snapBoundaries = NO_SNAP_BOUNDARIES,
  rippleMode = false,
  previewAxis = false,
  onHoverScrub,
  onSelectItem,
  onSelectItems,
  selectedKeyframe = null,
  onSelectKeyframe,
  onProjectChange,
  onOverlayEdit,
  onInspectClip,
  onInspectAudio,
  onEditCaption,
  onFadeCurveMenu,
  onKeyframeMenu,
  getWaveformPeaks,
  getFilmstrip,
  resolveFilePath,
  mode = 'dark',
  onImportFilesToTimeline,
  pendingDrops = NO_PENDING_DROPS,
}: TimelineCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const metricsRef = useRef<SurfaceMetrics>({ cssWidth: 0, cssHeight: 0, dpr: 1 })

  // T6 — one fetch-state store for the lifetime of this mounted surface, so
  // in-flight/resolved peaks survive across redraws (pan, zoom, selection).
  const waveformStoreRef = useRef<WaveformPeaksStore | null>(null)
  if (waveformStoreRef.current === null) waveformStoreRef.current = new WaveformPeaksStore()

  // T7 — same lifetime rule as the waveform store, for filmstrip indexes and
  // decoded sheet images.
  const filmstripStoreRef = useRef<FilmstripStore | null>(null)
  if (filmstripStoreRef.current === null) filmstripStoreRef.current = new FilmstripStore()


  // `project.captions` is in here because the caption band is part of the
  // layout: without it a caption move or trim would change the project and
  // repaint the OLD band, so the block would spring back under the cursor.
  const layout = useMemo(() => computeTimelineLayout(project), [project.tracks, project.audio, project.captions])

  // How far the surface grows PAST the drawn tracks to fill the empty area at
  // the bottom of the resizable timeline pane. The tracks stay top-anchored;
  // this only adds background below them, so a click there hits the canvas
  // (deselect / seek / marquee) instead of dead page space. 0 until measured,
  // and stays 0 in any host that doesn't mark a scroll viewport (see the effect
  // below), which degrades to the pre-fill behaviour.
  const [paneFill, setPaneFill] = useState(0)
  const surfaceHeight = Math.max(layout.height, VISUAL_ROW_RENDER_HEIGHT_PX, paneFill)

  // Which marker's rename box is open, or null for none. The box itself is a
  // real DOM `<input>` (rendered below, as a third child of the wrapper div)
  // rather than a canvas-drawn fake — `editCaption` has no equivalent here
  // because it routes to the transcript sidebar instead, so this is the one
  // inline text editor this canvas hosts directly.
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null)

  // Latest draw inputs, readable from the imperative paint without making the
  // paint a dependency of every effect (the ref-to-latest pattern
  // `useTimelineZoom` uses for its wheel handler).
  // The host's in-flight imports, resolved to rectangles against the CURRENT
  // layout. Memoized on the layout too, not just the list: a row added or
  // removed by an unrelated edit moves every row's y, and a ghost still drawn
  // at the old one would float over the wrong track.
  const pendingDropBandList = useMemo(() => pendingDropBands(pendingDrops, layout), [pendingDrops, layout])

  const sceneRef = useRef({ project, layout, selectedIds, selectedKeyframe, totalDuration, mode, pendingDropBandList })
  sceneRef.current = { project, layout, selectedIds, selectedKeyframe, totalDuration, mode, pendingDropBandList }

  // The preview-axis cursor, tracked imperatively for the same reason the
  // filmstrip hover thumb is: it moves with every mousemove, and a React state
  // write per mouse position would re-render the caption row's hundreds of DOM
  // nodes to move a 2px line. Read fresh at overlay-paint time.
  const cursorTimeRef = useRef<number | null>(null)

  // The snap guide, tracked the same imperative way and for the same reason:
  // it moves during a drag, and a React state write per pointer move would
  // re-render the whole timeline to place a 2px line. The machine emits a
  // `snapGuide` effect only when the guide MOVES, so this is written a couple
  // of times per gesture rather than per event.
  const snapGuideRef = useRef<{ time: number; strength: SnapStrength } | null>(null)

  // The rubber-band box, same imperative treatment: it follows the pointer, so
  // a React state write per move would re-render the timeline to move a
  // rectangle.
  const marqueeRef = useRef<SurfaceRect | null>(null)

  // The trim handle under the resting pointer, so the painter can light it up.
  // Held as a ref for the usual reason, but redrawn through `requestRedraw`
  // only when the identity changes — crossing into or out of a handle, which
  // happens a handful of times a session, not per mousemove.
  const hoveredHandleRef = useRef<{ itemId: string; edge: 'in' | 'out' } | null>(null)

  // Hover-scrub emissions, coalesced to one per animation frame.
  //
  // The LINE is cheap — `requestRedraw` already folds it into one rAF. The
  // EMISSION is not: each one asks the preview to show a different frame,
  // which means seeking the source. A trackpad sweep delivers 60-120
  // mousemoves a second, and on long-GOP media each seek cancels the decode
  // still in flight, so the picture can end up never landing a frame at all
  // (worst on un-proxied 4K HEVC, where a seek decodes up to a second of
  // frames). One emission per frame is all a display can show anyway; the
  // intermediate positions are dropped rather than queued, so the seek target
  // is always the pointer's CURRENT position and never a stale backlog.
  const hoverEmitRef = useRef<{ frame: number | null; pending: number | null }>({ frame: null, pending: null })

  const dirtyRef = useRef({ content: false, overlay: false })
  const frameRef = useRef<number | null>(null)

  const paintRef = useRef<() => void>(() => {})
  paintRef.current = () => {
    const { cssWidth, cssHeight, dpr } = metricsRef.current
    if (cssWidth <= 0 || cssHeight <= 0) return
    const dirty = dirtyRef.current
    const viewport = store.get()
    const scene = sceneRef.current

    if (dirty.content) {
      dirty.content = false
      const ctx = contentCanvasRef.current?.getContext('2d')
      if (ctx) {
        scaleContextToDpr(ctx, dpr)
        // T6 — one query context per paint (px/second and the project id can
        // both have moved since the last one); the store itself is what
        // persists across paints. `onReady` re-marks content dirty and
        // schedules a redraw once new data lands, the same way a project
        // edit does.
        const waveforms: WaveformSceneLookup | undefined = getWaveformPeaks
          ? {
              clipColumns: (item, rect) => waveformStoreRef.current!.clipColumns(item, rect, {
                projectId: scene.project.id,
                getWaveformPeaks,
                pxPerSecond: viewport.pxPerSecond,
                // Lets `clipColumns` recover the clip's full on-screen span
                // and slice its peaks to whatever sub-range `rect` actually
                // shows — see `WaveformQueryContext.viewport`.
                viewport,
                onReady: () => requestRedraw('content'),
              }),
              audioColumns: (track, rect) => waveformStoreRef.current!.audioColumns(track, rect, {
                projectId: scene.project.id,
                getWaveformPeaks,
                pxPerSecond: viewport.pxPerSecond,
                viewport,
                onReady: () => requestRedraw('content'),
              }),
            }
          : undefined
        // T7 — filmstrip data is shared with the overlay layer's hover thumb
        // (see filmstrips.ts's `FilmstripQueryContext.onReady` doc), so
        // whichever call resolves a fetch invalidates BOTH layers.
        const filmstrips: FilmstripSceneLookup | undefined = (getFilmstrip && resolveFilePath)
          ? {
              clipTiles: (item, rect) => filmstripStoreRef.current!.clipTiles(item, rect, {
                projectId: scene.project.id,
                getFilmstrip,
                fileUrl: resolveFilePath,
                viewport,
                onReady: () => requestRedraw('all'),
              }),
            }
          : undefined
        drawTimelineContent(ctx, {
          project: scene.project,
          viewport,
          layout: scene.layout,
          selectedIds: scene.selectedIds,
          selectedKeyframe: scene.selectedKeyframe,
          hoveredHandle: hoveredHandleRef.current,
          surfaceWidth: cssWidth,
          surfaceHeight: cssHeight,
          waveforms,
          filmstrips,
          mode: scene.mode,
        })
      }
    }

    if (dirty.overlay) {
      dirty.overlay = false
      const ctx = overlayCanvasRef.current?.getContext('2d')
      if (ctx) {
        scaleContextToDpr(ctx, dpr)
        drawTimelineOverlay(ctx, {
          viewport,
          currentTime: clock.get(),
          cursorTime: cursorTimeRef.current,
          snapTime: snapGuideRef.current?.time ?? null,
          snapStrength: snapGuideRef.current?.strength ?? null,
          marquee: marqueeRef.current,
          pendingDrops: scene.pendingDropBandList,
          surfaceWidth: cssWidth,
          surfaceHeight: cssHeight,
          mode: scene.mode,
        })
      }
    }
  }

  const requestRedraw = useCallback((layer: 'content' | 'overlay' | 'all') => {
    const dirty = dirtyRef.current
    if (layer !== 'overlay') dirty.content = true
    if (layer !== 'content') dirty.overlay = true
    if (frameRef.current !== null) return
    frameRef.current = requestFrame(() => {
      frameRef.current = null
      paintRef.current()
    })
  }, [])

  // The latch must be reset here too, or a StrictMode remount (cleanup runs
  // on the same instance before the effect re-fires) deadlocks every future
  // `requestRedraw` behind a stale non-null handle.
  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current)
      frameRef.current = null
    }
    const emit = hoverEmitRef.current
    if (emit.frame !== null) cancelFrame(emit.frame)
    emit.frame = null
    emit.pending = null
    // Same StrictMode concern as `frameRef` above, for the edge auto-scroll
    // loop's own rAF handle.
    stopEdgeAutoScroll()
  }, [])

  // ── Surface: CSS size, DPR, backing stores ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    return observeSurface(el, metrics => {
      metricsRef.current = metrics
      const content = contentCanvasRef.current
      const overlay = overlayCanvasRef.current
      if (content) syncCanvasBackingStore(content, metrics)
      if (overlay) syncCanvasBackingStore(overlay, metrics)
      store.set(vp => withSurfaceWidth(vp, metrics.cssWidth, sceneRef.current.totalDuration))
      // Unconditional: writing `canvas.width` clears the canvas, and a DPR
      // change invalidates the transform even when the CSS size is identical.
      requestRedraw('all')
    })
  }, [store, requestRedraw])

  // ── Fill the pane: grow the surface to reach the bottom of the timeline
  //    pane, so the empty area under the last track is live canvas ──
  //
  // Measured against the pane's scroll viewport (the `data-timeline-scroll`
  // marker VideoEditor puts on it), whose height is set by the resizable pane
  // and is INDEPENDENT of the surface's own height — so setting `paneFill` can
  // never change what the next measurement reads, and there is no feedback loop
  // even while the surface (and the flow below it) grows and the pane scrolls.
  // A host that marks no viewport (the pending layout, tests) is left at 0 and
  // keeps the pre-fill height. Re-measures on pane resize (the viewport's
  // ResizeObserver) and whenever the layout changes (a row added above the
  // surface shifts its top; more rows change how much space is left).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const scroll = el.closest('[data-timeline-scroll]') as HTMLElement | null
    if (!scroll) return
    const measure = () => {
      const scrollRect = scroll.getBoundingClientRect()
      const surfaceRect = el.getBoundingClientRect()
      // Offset within the scroll CONTENT, not on screen: the `scrollTop` term
      // cancels the shift `surfaceRect.top` takes on when the pane is scrolled,
      // so a scrolled-down measurement asks for the same fill as an unscrolled
      // one (see `paneFillHeight`).
      const surfaceOffsetTop = surfaceRect.top - scrollRect.top + scroll.scrollTop
      const padding = paddingBelowSurface(el.parentElement, scroll)
      const next = Math.round(paneFillHeight(scrollRect.height, surfaceOffsetTop, padding))
      setPaneFill(prev => (prev === next ? prev : next))
    }
    measure()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure())
      ro.observe(scroll)
    }
    const onResize = () => measure()
    window.addEventListener('resize', onResize)
    return () => { ro?.disconnect(); window.removeEventListener('resize', onResize) }
  }, [layout])

  // ── Turning the axis off with the pointer still over the surface takes the
  //    line and the host's override down with it: no further mousemove is
  //    coming to do it, and the preview would stay frozen on a hovered frame. ──
  useEffect(() => {
    if (previewAxis) return
    const emit = hoverEmitRef.current
    if (emit.frame !== null) cancelFrame(emit.frame)
    emit.frame = null
    emit.pending = null
    if (cursorTimeRef.current === null) return
    cursorTimeRef.current = null
    onHoverScrub?.(null)
    requestRedraw('overlay')
  }, [previewAxis, onHoverScrub, requestRedraw])

  // ── Viewport: pan/zoom moves everything, including the playhead ──
  useEffect(() => store.subscribe(() => requestRedraw('all')), [store, requestRedraw])

  // ── Playhead: the only per-tick subscriber, and it repaints one layer ──
  useEffect(() => clock.subscribe(() => requestRedraw('overlay')), [clock, requestRedraw])

  // ── Theme: a light/dark flip repaints BOTH layers ──
  //
  // `mode` is not part of the content effect below on purpose. It changes the
  // colour of marks on the OVERLAY too — the playhead, the axis cursor, the
  // marquee — and that layer is repainted only by the clock, the viewport or a
  // gesture. Without this the surface would keep showing stale pixels of the
  // previous theme until something unrelated happened to touch each layer,
  // which for the overlay of a paused, untouched timeline is "never". The
  // paint reads `sceneRef.current.mode`, written during the same render that
  // schedules this effect, so the repaint always sees the NEW mode.
  useEffect(() => { requestRedraw('all') }, [mode, requestRedraw])

  // ── Content: project/selection edits ──
  const selectionKey = selectedIds.join('\0')
  // The selected keyframe is content too — the strip draws it filled — so a
  // change of diamond has to repaint that layer, same as a change of item.
  useEffect(() => { requestRedraw('content') }, [project, layout, selectionKey, selectedKeyframe, requestRedraw])

  // ── Overlay: the pending-import ghosts ──
  //
  // The ghosts live on the overlay layer, which is repainted only by the clock,
  // the viewport or a gesture — so without this a ghost would appear (or fail
  // to disappear) only on the next unrelated repaint, i.e. "never" on a paused,
  // untouched timeline. Keyed by CONTENT rather than by the array's identity,
  // exactly like `selectionKey` above: a host that rebuilds the list each
  // render (or passes an inline `[]`) must not schedule a repaint per render
  // for a picture that hasn't moved.
  const pendingDropsKey = pendingDropBandList
    .map(b => [b.start, b.end, b.y, b.height, b.label ?? ''].join('|'))
    .join('\0')
  useEffect(() => { requestRedraw('overlay') }, [pendingDropsKey, requestRedraw])

  // ── Duration changes re-clamp scale and scroll ──
  useEffect(() => {
    store.set(vp => reclampForDuration(vp, totalDuration))
    requestRedraw('all')
  }, [totalDuration, store, requestRedraw])

  // ── Wheel: ⌘/Ctrl zoom at cursor, Alt (or horizontal) pan, plain wheel
  //    left alone so the page keeps scrolling. preventDefault only fires for
  //    intents we consume, which is why the listener must be non-passive —
  //    React's onWheel is registered passive at the root (same reason
  //    useTimelineZoom binds natively). ──
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {})
  wheelRef.current = (e: WheelEvent) => {
    const el = containerRef.current
    if (!el) return
    const intent = wheelIntent(e, e.clientX - el.getBoundingClientRect().left)
    if (intent.kind === 'none') return
    e.preventDefault()
    // Don't let a wheel gesture we've already consumed bubble to the scroll
    // container we sit inside, or to the page. (This originally existed for a
    // sharper reason: the DOM timeline bound its own non-passive wheel
    // listener to that container, and without this it would zoom its separate
    // multiplier off the same gesture and widen the page under the canvas.
    // Those rows and that listener are gone — see `useTimelineZoom` — so this
    // is now just ordinary "we handled it" containment.)
    e.stopPropagation()
    store.set(vp => applyWheelIntent(vp, intent, sceneRef.current.totalDuration))
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => wheelRef.current(e)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Pointer: the gesture machine's DOM shell ──

  const machineRef = useRef<ReturnType<typeof createPointerMachine> | null>(null)
  if (machineRef.current === null) machineRef.current = createPointerMachine()
  const machine = machineRef.current

  // Everything the machine's context and effects need, refreshed each render so
  // handlers bound once on mount never read a stale project or callback.
  const pointerRef = useRef({
    project, layout, selectedIds, selectedKeyframe, snapBoundaries, totalDuration, fps, rippleMode, previewAxis,
    onSelectItem, onSelectItems, onSelectKeyframe, onProjectChange, onOverlayEdit, onInspectClip, onInspectAudio, onEditCaption, onHoverScrub, onFadeCurveMenu, onKeyframeMenu,
    onImportFilesToTimeline,
  })
  pointerRef.current = {
    project, layout, selectedIds, selectedKeyframe, snapBoundaries, totalDuration, fps, rippleMode, previewAxis,
    onSelectItem, onSelectItems, onSelectKeyframe, onProjectChange, onOverlayEdit, onInspectClip, onInspectAudio, onEditCaption, onHoverScrub, onFadeCurveMenu, onKeyframeMenu,
    // Read by the drag handlers below, which are bound ONCE on mount — a
    // file-drop hook read from the closure instead of from here would be the
    // one the host passed on the very first render, forever.
    onImportFilesToTimeline,
  }

  const buildContext = useCallback((): PointerContext => {
    const p = pointerRef.current
    return {
      project: p.project,
      layout: p.layout,
      viewport: store.get(),
      selectedIds: p.selectedIds,
      selectedKeyframe: p.selectedKeyframe,
      snapBoundaries: p.snapBoundaries,
      totalDuration: p.totalDuration,
      fps: p.fps,
      rippleMode: p.rippleMode,
      playheadTime: clock.get(),
    }
  }, [store, clock])

  const runEffects = useCallback((effects: PointerEffect[]) => {
    const p = pointerRef.current
    let edited = false
    for (const effect of effects) {
      switch (effect.type) {
        case 'seek':          clock.set(effect.time); break
        case 'select':        p.onSelectItem?.(effect.id, effect.additive); break
        case 'selectKeyframe': p.onSelectKeyframe?.({ itemId: effect.itemId, t: effect.t }); break
        case 'projectChange': p.onProjectChange?.(effect.project); edited = true; break
        case 'commit':        p.onOverlayEdit?.(effect.project); break
        case 'inspect':       (effect.target === 'visual' ? p.onInspectClip : p.onInspectAudio)?.(effect.id); break
        case 'editCaption':   p.onEditCaption?.(effect.id); break
        case 'editMarker':    setEditingMarkerId(effect.id); break
        // Cursor is written straight to the node: an affordance that changes on
        // every hover must not cost a React render.
        case 'cursor':        if (containerRef.current) containerRef.current.style.cursor = effect.cursor; break
        // Overlay-only: the guide is gesture feedback, not content, so putting
        // it up or taking it down never costs a filmstrip repaint.
        case 'snapGuide':
          snapGuideRef.current = effect.time === null || effect.strength === null
            ? null
            : { time: effect.time, strength: effect.strength }
          requestRedraw('overlay')
          break
        // Overlay-only for the same reason as the guide: the box follows the
        // pointer, and repainting clips and filmstrips behind it sixty times a
        // second to move a rectangle would be absurd.
        case 'marquee':
          marqueeRef.current = effect.rect
          requestRedraw('overlay')
          break
        case 'selectMany':
          if (p.onSelectItems) {
            p.onSelectItems(effect.ids, effect.additive)
          } else {
            // No bulk handler: replay as singles. The first is non-additive
            // unless the marquee itself was additive (so it replaces the old
            // selection), and every one after it extends what the first set.
            if (!effect.additive && effect.ids.length === 0) p.onSelectItem?.(null, false)
            effect.ids.forEach((id, i) => p.onSelectItem?.(id, effect.additive || i > 0))
          }
          break
      }
    }
    // The edit reaches the surface as a new `project` prop, which schedules a
    // redraw on its own — but only once the host echoes it back. Marking the
    // content dirty here keeps a drag responsive under a host that defers.
    if (edited) requestRedraw('content')
  }, [clock, requestRedraw])

  // Document-level move/up, live only for the duration of a gesture (the DOM
  // drag hook's pattern) so ordinary mouse movement over the page costs nothing.
  const releaseGestureRef = useRef<(() => void) | null>(null)

  // The surface rect, frozen for the duration of a gesture — see
  // `surfacePoint`'s comment for why. Null while idle.
  const gestureRectRef = useRef<DOMRect | null>(null)

  // ── Edge auto-scroll ──
  //
  // The latest surface-space point and modifiers a real pointermove reported
  // during a drag. The rAF loop below re-feeds THIS SAME point back into the
  // machine after each pan, rather than reading a fresh one — the pointer
  // itself hasn't moved, only the view under it has, so re-dispatching the
  // unchanged point against the panned viewport is exactly what advances the
  // dragged item's time (see `dispatchPointerMove`). Null outside a gesture.
  const lastDragPointRef = useRef<{ point: Point; modifiers: Modifiers } | null>(null)
  // The loop's own rAF handle, and the timestamp its last tick ran at (for a
  // framerate-independent pan). Both null while the loop isn't running.
  const edgeScrollFrameRef = useRef<number | null>(null)
  const edgeScrollLastTimeRef = useRef<number | null>(null)

  const handlersRef = useRef({
    down: (_e: MouseEvent) => {},
    hover: (_e: MouseEvent) => {},
    move: (_e: MouseEvent) => {},
    up: (_e: MouseEvent) => {},
    doubleClick: (_e: MouseEvent) => {},
    leave: (_e: MouseEvent) => {},
    contextMenu: (_e: MouseEvent) => {},
  })

  function surfacePoint(e: MouseEvent): Point | null {
    const el = containerRef.current
    if (!el) return null
    // A gesture's own live edit can resize the surface and shift its rect mid-
    // drag (a cross-track move adds/removes a row under the moving cursor); the
    // press-time rect is that gesture's fixed frame of reference, matching the
    // DOM drag hooks' raw-delta math. Idle reads (hover, no gesture) stay live.
    const rect = gestureRectRef.current ?? el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function modifiersOf(e: MouseEvent): Modifiers {
    return { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey }
  }

  // ── Trim-handle hover ──
  //
  // A second hit-test per hover event, on top of the one the machine does
  // internally. It is gated on there BEING a selection, because handles are
  // only drawn on selected items: with nothing selected — the common state
  // while just moving the pointer around — this costs a length check and
  // returns.
  //
  // The alternative was another remembered value in the machine and an effect
  // per hover; a hit-test over the visible rows is cheaper than that, and it
  // keeps the machine about gestures rather than about paint.

  function hoveredHandleAt(point: Point): { itemId: string; edge: 'in' | 'out' } | null {
    const p = pointerRef.current
    if (p.selectedIds.length === 0) return null
    // `selectedIds` also lets a keyframe diamond's own small zone take
    // precedence here, same as it does in the machine's own hit-test — a
    // trim handle must not light up underneath a diamond that would win the
    // actual press.
    const hit = hitTest(point, p.layout, store.get(), { selectedIds: p.selectedIds, markers: p.project.markers })
    if (!isEdgeHit(hit) || hit.itemId === undefined || hit.edge === undefined) return null
    return p.selectedIds.includes(hit.itemId) ? { itemId: hit.itemId, edge: hit.edge } : null
  }

  function updateHoveredHandle(point: Point) {
    const next = hoveredHandleAt(point)
    const prev = hoveredHandleRef.current
    if (prev?.itemId === next?.itemId && prev?.edge === next?.edge) return
    hoveredHandleRef.current = next
    requestRedraw('content')
  }

  function clearHoveredHandle() {
    if (hoveredHandleRef.current === null) return
    hoveredHandleRef.current = null
    requestRedraw('content')
  }

  // ── Preview axis: the cursor line, and the frame it asks the host to show ──
  //
  // Both halves are driven from the same place so the line and the previewed
  // frame can never disagree. Time is taken raw from the x position — no
  // snapping, because a hover affordance that jumped to clip boundaries would
  // preview a frame other than the one the line is drawn at.

  function updateAxisCursor(point: Point) {
    const p = pointerRef.current
    if (!p.previewAxis) return
    const t = Math.max(0, Math.min(p.totalDuration, xToTime(point.x, store.get())))
    if (cursorTimeRef.current === t) return
    cursorTimeRef.current = t
    requestRedraw('overlay')
    // The line tracks the pointer exactly; the frame request is rate-limited.
    const emit = hoverEmitRef.current
    emit.pending = t
    if (emit.frame !== null) return
    emit.frame = requestFrame(() => {
      emit.frame = null
      const next = emit.pending
      emit.pending = null
      if (next !== null) pointerRef.current.onHoverScrub?.(next)
    })
  }

  /** Drop any frame request that hasn't fired yet, so a release can't be
   *  overtaken by a stale position arriving one frame later. */
  function cancelPendingHoverEmit() {
    const emit = hoverEmitRef.current
    if (emit.frame !== null) cancelFrame(emit.frame)
    emit.frame = null
    emit.pending = null
  }

  // Guarded on the ref, so the paths that call this speculatively (every
  // pointer-leave, every press, mount with the axis already off) stay silent
  // when there was no cursor up to take down.
  function clearAxisCursor() {
    cancelPendingHoverEmit()
    if (cursorTimeRef.current === null) return
    cursorTimeRef.current = null
    // Released synchronously, never deferred: the preview must be handed back
    // to the playhead the instant the pointer leaves or a gesture starts.
    pointerRef.current.onHoverScrub?.(null)
    requestRedraw('overlay')
  }

  // ── Edge auto-scroll: pan the view while a drag holds near either edge ──
  //
  // Standard NLE behaviour: drag an item/handle past the visible edge and the
  // view pans to follow, rather than trapping the gesture at whatever was on
  // screen when the drag started. Only gestures where "the pointer is
  // captured and following makes sense" qualify — every `dragging` state
  // EXCEPT `scrub` (the ruler already owns the playhead directly; panning
  // underneath it while it drags would fight the seek instead of extending
  // it). Marquee selection is included: dragging the box out past the edge to
  // catch items further along the timeline is the same affordance.

  function dispatchPointerMove(point: Point, modifiers: Modifiers) {
    runEffects(machine.dispatch({ type: 'pointerMove', point, modifiers, ctx: buildContext() }))
  }

  function stopEdgeAutoScroll() {
    if (edgeScrollFrameRef.current !== null) {
      cancelFrame(edgeScrollFrameRef.current)
      edgeScrollFrameRef.current = null
    }
    edgeScrollLastTimeRef.current = null
  }

  function inEdgeZone(pointerX: number, surfaceWidth: number): boolean {
    return pointerX < EDGE_SCROLL_ZONE_PX || pointerX > surfaceWidth - EDGE_SCROLL_ZONE_PX
  }

  function edgeAutoScrollTick() {
    edgeScrollFrameRef.current = null

    const state = machine.state
    if (state.kind !== 'dragging' || state.gesture === 'scrub') { stopEdgeAutoScroll(); return }
    const drag = lastDragPointRef.current
    const rect = gestureRectRef.current
    if (!drag || !rect || rect.width <= 0) { stopEdgeAutoScroll(); return }
    if (!inEdgeZone(drag.point.x, rect.width)) { stopEdgeAutoScroll(); return }

    const now = perfNow()
    const last = edgeScrollLastTimeRef.current
    edgeScrollLastTimeRef.current = now
    // The first tick has no prior timestamp to diff against; skip panning
    // this frame (a 0-length delta would pan nothing anyway) and let the next
    // one carry a real elapsed time, so the very first frame after entering
    // the zone doesn't jump by a guessed duration.
    if (last !== null) {
      const dt = Math.min(0.1, (now - last) / 1000)
      const viewport = store.get()
      const delta = edgeScrollDelta(
        drag.point.x, rect.width, viewport.pxPerSecond, dt,
        EDGE_SCROLL_ZONE_PX, EDGE_SCROLL_MAX_PX_PER_SEC, EDGE_SCROLL_RAMP_PX,
      )
      if (delta !== 0) {
        let hitClamp = false
        store.set(vp => {
          const nextScroll = clampScrollSeconds(vp.scrollSeconds + delta, vp, sceneRef.current.totalDuration)
          if (nextScroll === vp.scrollSeconds) { hitClamp = true; return vp }
          return { ...vp, scrollSeconds: nextScroll }
        })
        if (hitClamp) { stopEdgeAutoScroll(); return }
        // Re-feed the SAME screen point now that scrollSeconds has moved
        // under it — the store's own `subscribe` (wired above) already
        // requests the repaint this pan needs.
        dispatchPointerMove(drag.point, drag.modifiers)
      }
    }

    edgeScrollFrameRef.current = requestFrame(edgeAutoScrollTick)
  }

  /** Called on every real pointermove during a gesture. Starts the loop the
   *  first time the pointer enters an edge zone; leaves it running otherwise
   *  (the loop re-reads `lastDragPointRef` itself each tick, so a pointer that
   *  keeps moving within the zone doesn't need to restart anything, and one
   *  that leaves the zone is caught on the loop's own next tick). */
  function updateEdgeAutoScroll() {
    const state = machine.state
    if (state.kind !== 'dragging' || state.gesture === 'scrub') { stopEdgeAutoScroll(); return }
    const drag = lastDragPointRef.current
    const rect = gestureRectRef.current
    if (!drag || !rect || rect.width <= 0 || !inEdgeZone(drag.point.x, rect.width)) return
    if (edgeScrollFrameRef.current !== null) return // already running
    edgeScrollLastTimeRef.current = null
    edgeScrollFrameRef.current = requestFrame(edgeAutoScrollTick)
  }

  handlersRef.current = {
    down(e) {
      if (e.button !== 0) return
      // A stale gesture whose mouseup never fired (focus loss, etc.) must not
      // leave its frozen rect and listeners behind for this new one.
      releaseGestureRef.current?.()
      gestureRectRef.current = containerRef.current?.getBoundingClientRect() ?? null
      const point = surfacePoint(e)
      if (!point) return
      // A gesture is starting — no axis cursor during a drag/trim. The gesture
      // itself owns the playhead from here, and a click seeks, so leaving the
      // cursor up would draw a second line the drag never moves.
      clearAxisCursor()
      // Suppress the native text-selection drag; the surface is `select-none`
      // but a press-and-drag still starts one in some browsers. That
      // preventDefault also suppresses the focus a plain click would give this
      // container, which Timeline's own Delete/Enter bindings depend on
      // (they only fire with focus inside Timeline's root — see Timeline.tsx)
      // — so focus it explicitly.
      containerRef.current?.focus({ preventScroll: true })
      e.preventDefault()
      runEffects(machine.dispatch({ type: 'pointerDown', point, modifiers: modifiersOf(e), ctx: buildContext() }))

      const onMove = (ev: MouseEvent) => handlersRef.current.move(ev)
      const onUp = (ev: MouseEvent) => handlersRef.current.up(ev)
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      releaseGestureRef.current = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        gestureRectRef.current = null
        releaseGestureRef.current = null
        // Every path that ends a gesture — release, a stale gesture's next
        // press, or unmount — runs through here, so this is the one place
        // edge auto-scroll needs to be torn down.
        stopEdgeAutoScroll()
        lastDragPointRef.current = null
      }
    },
    // Hover only updates the cursor, and only while no gesture is running — the
    // document listener owns movement once a press is down, so without this
    // guard every mid-drag move would be dispatched twice.
    hover(e) {
      if (machine.state.kind !== 'idle') return
      const point = surfacePoint(e)
      if (!point) return
      runEffects(machine.dispatch({ type: 'pointerMove', point, modifiers: modifiersOf(e), ctx: buildContext() }))
      updateHoveredHandle(point)
      updateAxisCursor(point)
    },
    move(e) {
      const point = surfacePoint(e)
      if (!point) return
      const modifiers = modifiersOf(e)
      // Latched for edge auto-scroll: its rAF loop re-dispatches THIS point
      // once scrollSeconds pans under it, rather than reading a fresh one —
      // see `lastDragPointRef`'s doc.
      lastDragPointRef.current = { point, modifiers }
      dispatchPointerMove(point, modifiers)
      updateEdgeAutoScroll()
    },
    up(e) {
      // Point first, then release — the point must still see this gesture's
      // frozen rect, not the live one the teardown below reverts to.
      const point = surfacePoint(e)
      releaseGestureRef.current?.()
      if (!point) { runEffects(machine.dispatch({ type: 'cancel' })); return }
      runEffects(machine.dispatch({ type: 'pointerUp', point, modifiers: modifiersOf(e), ctx: buildContext() }))
    },
    doubleClick(e) {
      const point = surfacePoint(e)
      if (!point) return
      e.preventDefault()
      runEffects(machine.dispatch({ type: 'doubleClick', point, modifiers: modifiersOf(e), ctx: buildContext() }))
    },
    // The pointer left the surface entirely; no more `mousemove` events will
    // arrive to naturally age the cursor out, so drop it explicitly.
    leave() {
      clearAxisCursor()
      // A gesture owns the highlight until it ends: during a trim the pointer
      // routinely leaves the surface, and dropping the lit handle then would
      // un-light the very edge being dragged.
      if (machine.state.kind === 'idle') clearHoveredHandle()
    },
    // Right-click a fade grip → the fade-shape picker (Vegas' own gesture), OR
    // a keyframe diamond → its own easing/remove picker (SP9b T3.3, the same
    // shape of popup — see `onKeyframeMenu`'s doc). Anywhere else on the
    // surface, this is a no-op and the browser's normal context menu shows —
    // only one of those two hits calls `preventDefault`. Runs its OWN
    // hit-test rather than going through the pointer machine: a right-click
    // is not a gesture (no drag, no press/release pair), and the machine's
    // vocabulary has nothing for it.
    contextMenu(e) {
      const p = pointerRef.current
      if (!p.onFadeCurveMenu && !p.onKeyframeMenu) return
      const point = surfacePoint(e)
      if (!point) return
      const hit = hitTest(point, p.layout, store.get(), { selectedIds: p.selectedIds, markers: p.project.markers })
      if (p.onFadeCurveMenu && hit.kind === 'audio-fade' && hit.itemId !== undefined && hit.side) {
        e.preventDefault()
        p.onFadeCurveMenu({ trackId: hit.itemId, side: hit.side, x: e.clientX, y: e.clientY })
        return
      }
      if (p.onKeyframeMenu && hit.kind === 'keyframe' && hit.itemId !== undefined && hit.kfT !== undefined && hit.item) {
        e.preventDefault()
        const times = keyframeUnionTimes(hit.item)
        const isLast = times.length > 0 && hit.kfT === times[times.length - 1]
        const props = (hit.item.keyframes ?? [])
          .filter(track => track.points.some(pt => pt.t === hit.kfT))
          .map(track => track.prop)
        p.onKeyframeMenu({ itemId: hit.itemId, t: hit.kfT, props, isLast, x: e.clientX, y: e.clientY })
      }
    },
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onDown = (e: MouseEvent) => handlersRef.current.down(e)
    const onHover = (e: MouseEvent) => handlersRef.current.hover(e)
    const onDoubleClick = (e: MouseEvent) => handlersRef.current.doubleClick(e)
    const onLeave = (e: MouseEvent) => handlersRef.current.leave(e)
    const onContextMenu = (e: MouseEvent) => handlersRef.current.contextMenu(e)
    el.addEventListener('mousedown', onDown)
    el.addEventListener('mousemove', onHover)
    el.addEventListener('dblclick', onDoubleClick)
    el.addEventListener('contextmenu', onContextMenu)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('mousemove', onHover)
      el.removeEventListener('dblclick', onDoubleClick)
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('mouseleave', onLeave)
      releaseGestureRef.current?.()
    }
  }, [])

  // ── Drops onto the surface: the footage bin, and OS files ──
  //
  // Two drags land here and neither is a pointer gesture — the browser owns
  // the drag, there is no mousedown/up pair on this surface — so both stay out
  // of the pointer machine.
  //
  // A FOOTAGE-BIN drag (our own `FOOTAGE_DND_MIME`) carries everything needed
  // to place a clip, so it commits here, straight through the SAME
  // discrete-edit pair every other discrete timeline edit uses:
  // `onProjectChange` applies it live, `onOverlayEdit` persists it as one undo
  // step (mirroring the machine's own `projectChange`+`commit` effects in
  // `runEffects`, and Timeline's ripple-delete keymap). WHERE it lands is not
  // decided here: both drop paths hand the drop time and the row released over
  // to `placeDroppedClip` (placement.ts), which owns the one rule — "where you
  // dropped it, without stomping existing footage". (It used to pin every bin
  // drop to the main video track regardless of the row under the cursor; a
  // drop onto an occupied span then silently overlapped whatever was there.)
  //
  // An OS-FILE drag cannot be placed here at all: a `File` has no duration, no
  // proxy and no host-resolvable path until the host has probed and ingested
  // it. So that path only REPORTS the drop — the files, the time, the row —
  // through `onImportFilesToTimeline`, and the host commits the clip when its
  // import lands. The hook's PRESENCE is also the feature detection: without
  // it we never `preventDefault` an OS-file drag, so the browser keeps its own
  // handling and the gesture is completely inert (`dataTransfer.getData()`
  // returns "" during `dragover` for security, which is why the accept test
  // reads `types` rather than the data itself — both paths depend on that).
  //
  // The insertion indicator is the overlay's own cursor line
  // (`drawTimelineOverlay`'s `cursorTime`) reused via `cursorTimeRef` — no new
  // draw plumbing — and is taken down on `dragleave`/`drop`. It is written
  // straight to the ref (never through `clearAxisCursor`) so a drag never fires
  // the host's `onHoverScrub` preview seek.
  const dragHandlersRef = useRef({
    over: (_e: DragEvent) => {},
    leave: (_e: DragEvent) => {},
    drop: (_e: DragEvent) => {},
  })

  /** Where in the timeline a drop at client-x `clientX` landed, clamped to the
   *  project's own span. Shared by both drop paths so a bin clip and a
   *  filesystem file dropped at the same pixel land at the same second. */
  function dropTimeAt(clientX: number, rect: DOMRect): number {
    return Math.max(0, Math.min(
      pointerRef.current.totalDuration,
      xToTime(clientX - rect.left, store.get()),
    ))
  }

  /** The snap inputs `placeDroppedClip` takes: every boundary a gesture would
   *  magnetize to, plus the playhead, and the magnet's radius expressed in
   *  SECONDS.
   *
   *  Pixels are the unit of feel (see snap.ts's own module comment): a magnet
   *  has to cover the same distance on screen whether the timeline shows ten
   *  seconds or ten minutes, so the radius is a pixel count divided by the
   *  current scale on every call rather than a fixed number of seconds. A
   *  non-positive `pxPerSecond` (a viewport not yet measured) would divide to
   *  Infinity and magnetize the drop to the nearest boundary anywhere on the
   *  timeline, so it disables snapping instead. */
  function dropSnapInputs(): { snapTimes: number[]; snapToleranceSec: number } {
    const p = pointerRef.current
    const pxPerSecond = store.get().pxPerSecond
    return {
      snapTimes: [...(p.snapBoundaries ?? []), clock.get()],
      snapToleranceSec: pxPerSecond > 0 ? DEFAULT_SNAP_CONFIG.attractPx / pxPerSecond : 0,
    }
  }

  dragHandlersRef.current = {
    over(e) {
      const dt = e.dataTransfer
      if (!dt) return
      // EITHER our own bin MIME, or — only when the host gave us somewhere to
      // send them — an OS-file drag. `getData()` is unreadable during
      // `dragover`, so this can only test `types`.
      const isFootage = dt.types?.includes(FOOTAGE_DND_MIME)
      const isFiles = !!pointerRef.current.onImportFilesToTimeline && dt.types?.includes('Files')
      if (!isFootage && !isFiles) return
      // Without preventDefault the browser never fires `drop`; `copy` shows the
      // right affordance (a drop adds a placement, it doesn't move the source).
      e.preventDefault()
      dt.dropEffect = 'copy'
      const el = containerRef.current
      if (!el) return
      const t = xToTime(e.clientX - el.getBoundingClientRect().left, store.get())
      if (cursorTimeRef.current === t) return
      cursorTimeRef.current = t
      requestRedraw('overlay')
    },
    leave() {
      if (cursorTimeRef.current === null) return
      cursorTimeRef.current = null
      requestRedraw('overlay')
    },
    drop(e) {
      const p = pointerRef.current
      const el = containerRef.current
      // Which drag this is — decided by what the DataTransfer actually
      // CARRIES, not by what `dragover` accepted a moment ago: a drop can
      // arrive from a drag that started outside this surface entirely.
      const raw = e.dataTransfer?.getData(FOOTAGE_DND_MIME)
      const files = e.dataTransfer?.files

      if (raw) {
        e.preventDefault()
        // Take the indicator down whatever happens below.
        if (cursorTimeRef.current !== null) { cursorTimeRef.current = null; requestRedraw('overlay') }

        let payload: FootageDropPayload
        try {
          payload = JSON.parse(raw) as FootageDropPayload
        } catch {
          return
        }
        if (
          !payload ||
          typeof payload.src !== 'string' ||
          typeof payload.sourceDuration !== 'number' ||
          !Number.isFinite(payload.sourceDuration) ||
          payload.sourceDuration <= 0
        ) return

        if (!p.onProjectChange && !p.onOverlayEdit) return
        if (!el) return

        const rect = el.getBoundingClientRect()
        const placed = placeDroppedClip(p.project, {
          atTime: dropTimeAt(e.clientX, rect),
          preferredTrackIndex: dropTrackIndexAt(e.clientY - rect.top, p.layout),
          clip: payload,
          ripple: p.rippleMode,
          ...dropSnapInputs(),
        })
        // `placeDroppedClip` returns the input project BY REFERENCE when it
        // placed nothing (an unplaceable duration). Committing that would push
        // an undo entry and a save for an edit that never happened.
        if (placed.project === p.project) return
        p.onProjectChange?.(placed.project)
        p.onOverlayEdit?.(placed.project)
        return
      }

      if (files && files.length > 0 && p.onImportFilesToTimeline) {
        e.preventDefault()
        if (cursorTimeRef.current !== null) { cursorTimeRef.current = null; requestRedraw('overlay') }
        if (!el) return
        const rect = el.getBoundingClientRect()
        // Snapped HERE, unlike the bin path (which snaps inside its own
        // synchronous `placeDroppedClip` call): a file drop has no placement
        // call to snap inside of, since the host places the clip later, once
        // its background import resolves, at exactly the `atTime` reported
        // now. Resolving the magnet at drop time — same rule, same inputs
        // (`dropSnapInputs`) the bin path uses — is therefore the only chance
        // to apply it at all, and it makes the ghost band land on the same
        // second the real clip eventually will.
        p.onImportFilesToTimeline(Array.from(files), {
          atTime: resolveDropPoint({ atTime: dropTimeAt(e.clientX, rect), ...dropSnapInputs() }),
          preferredTrackIndex: dropTrackIndexAt(e.clientY - rect.top, p.layout),
          // Captured HERE, at drop time, not read by the host later: the
          // magnet is editor state the host cannot see, and by the time its
          // import resolves the operator may have toggled it. The mode during
          // the gesture is the one the drop meant. (The bin path above needs
          // no such capture — it places synchronously, so reading
          // `p.rippleMode` directly is already the drop-time value.)
          ripple: p.rippleMode ?? false,
        })
        return
      }

      // Neither — leave it for the browser (no preventDefault).
    },
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onOver = (e: DragEvent) => dragHandlersRef.current.over(e)
    const onLeave = (e: DragEvent) => dragHandlersRef.current.leave(e)
    const onDrop = (e: DragEvent) => dragHandlersRef.current.drop(e)
    el.addEventListener('dragover', onOver)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('dragleave', onLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [])

  // ── Marker rename box ──
  //
  // Unlike the imperative paint (which reads `store.get()` fresh per frame),
  // the box's `left` is a React-owned DOM style, so it needs a subscription to
  // follow a zoom or scroll that happens while it's open. That subscription
  // lives on `MarkerRenameBox` itself, below, rather than here — the same
  // reason `CanvasZoomBadge` is its own component: TimelineCanvas must not
  // subscribe to the viewport in its own render body, or every wheel-zoom
  // tick and pan frame re-renders this whole surface, which is exactly what
  // this file's header doc promises never happens.
  const editingMarker = editingMarkerId
    ? (project.markers ?? []).find(m => m.id === editingMarkerId) ?? null
    : null

  const commitRename = (value: string) => {
    // The id is captured and null-checked here because this same function is
    // also the input's blur handler, and it must be safe to call when there
    // is nothing being edited. Escape does not route through here at all —
    // its handler clears `editingMarkerId` directly (see `MarkerRenameBox`
    // below) — so the null check is for blur-with-nothing-open, not for
    // "Escape already cleared it before blur could commit."
    const id = editingMarkerId
    setEditingMarkerId(null)
    if (!id) return
    const next = renameMarker(project, id, value)
    if (next === project) return          // blank or unchanged — no undo entry
    onProjectChange?.(next)
    onOverlayEdit?.(next)                  // one commit, one undo step
  }

  return (
    <div
      ref={containerRef}
      data-timeline-canvas
      // Focusable (not tab-stoppable) so a pointer-down can focus it
      // programmatically — see the `down` handler above — satisfying
      // Timeline's root-focus guard for Delete/Enter without adding this
      // surface to the tab order.
      tabIndex={-1}
      // `outline-none` because this surface is focused by MOUSE and then
      // driven by KEYBOARD, which is exactly the sequence that turns
      // `:focus-visible` on. Pressing space to pause put a focus ring around
      // the entire timeline — pointer-down focuses the surface silently, then
      // the first keypress makes the browser decide the focus is now worth
      // showing, and it draws a box round every track at once.
      //
      // Suppressing it costs nothing here: `tabIndex={-1}` keeps this out of
      // the tab order, so there is no keyboard route to it and no keyboard
      // user who needs the ring to know where they are. Timeline's own
      // `tabIndex={0}` root — the one a keyboard user CAN reach — keeps its
      // own affordance decision separately.
      className="relative w-full select-none outline-none"
      style={{ height: surfaceHeight, cursor: 'pointer' }}
      // Timeline's container click also seeks, via `xToTime` against this
      // same canvas viewport. The pointer machine has already seeked (on
      // mousedown) by the time this fires, so swallow it rather than let it
      // re-seek to the wrong second.
      onClick={e => e.stopPropagation()}
    >
      <canvas ref={contentCanvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={overlayCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      {editingMarker && (
        <MarkerRenameBox
          marker={editingMarker}
          store={store}
          top={layout.markers?.y ?? 0}
          onCommit={commitRename}
          onCancel={() => setEditingMarkerId(null)}
        />
      )}
    </div>
  )
}

// ── Zoom chrome adapter ──────────────────────────────────────────────────
// Timeline renders the zoom buttons; the canvas owns what they do. It hands
// Timeline this adapter so the chrome stays presentational and the viewport
// mutation lives with the surface that draws it. (It was once a seam between
// two zoom models — the DOM path's integer multiplier and the canvas'
// viewport — but the DOM timeline is gone, so there is only one implementer.)

export interface ZoomControls {
  badge: ReactNode
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  showFit: boolean
}

export function useCanvasZoomControls(store: ViewportStore, totalDuration: number): ZoomControls {
  return useMemo(() => ({
    badge: <CanvasZoomBadge store={store} totalDuration={totalDuration} />,
    // Buttons zoom around the middle of the view, which is where the eye is
    // when there's no cursor to pivot on (the DOM path's `zoomTo` with no
    // pivot does the same).
    zoomIn:  () => store.set(vp => zoomAtPivot(vp, ZOOM_BUTTON_FACTOR, vp.widthPx / 2, totalDuration)),
    zoomOut: () => store.set(vp => zoomAtPivot(vp, 1 / ZOOM_BUTTON_FACTOR, vp.widthPx / 2, totalDuration)),
    fit:     () => store.set(vp => fitViewport(vp, totalDuration)),
    // Always offered: unlike the DOM model, canvas zoom can sit below 1×, so
    // "am I off fit?" is not simply "is zoom > 1". Keeping it unconditional
    // also keeps the badge the only part of the chrome that re-renders on zoom.
    showFit: true,
  }), [store, totalDuration])
}

/** The zoom readout, isolated so wheel-zoom re-renders this span and nothing
 *  else. Reports a fit-relative multiple for continuity with the DOM badge,
 *  where 1× also meant "the whole project fits". */
export function CanvasZoomBadge({ store, totalDuration }: { store: ViewportStore; totalDuration: number }) {
  const viewport = useViewportValue(store)
  return (
    <span className="text-[10px] font-mono text-gray-500 w-7 text-center tabular-nums select-none">
      {formatZoomMultiple(zoomMultiple(viewport, totalDuration))}×
    </span>
  )
}
