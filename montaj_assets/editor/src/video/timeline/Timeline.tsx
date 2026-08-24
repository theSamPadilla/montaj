import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import AudioTrackRow from './AudioTrackRow'
import type { GetWaveformChunks, ResolveFilePath } from './AudioWaveformLayer'
import type { FilmstripIndex, GetFilmstripArgs, GetWaveformPeaksArgs, PeaksData, Project } from '../../types'
import { reflowMagneticLanes } from '../audioMagnet'
import { normalizeCaptionLanes } from '../captionLanes'
import { collapseGaps, setClipSpeed } from '../cuts'
import { ratioFromClientX } from './utils'
import { useTimelineZoom } from './useTimelineZoom'
import { TimelineContext, type TimelineContextValue } from './TimelineContext'
import type { PlaybackClock } from '../playback-clock'
import Scrubber from './Scrubber'
import TrackGutter from './TrackGutter'
import { computeTimelineLayout, TIMELINE_COLORS } from './canvas/draw'
import { DEFAULT_FADE_CURVE, fadeCurveIconPoints, type FadeCurve } from './canvas/fade-curve'
import { normalizeTracks, updateAudioTrack } from './timeline-model'
import VisualTrackRow from './VisualTrackRow'
import { deleteSelection, toggleSelection } from './multiSelectOps'
import { computeAutoCrossfade, computeDerivedTiming, groupAudioLanes, trackItems } from './timeline-model'
import TimelineCanvas, { useCanvasZoomControls, type ZoomControls } from './canvas/TimelineCanvas'
import { useViewportStore, useViewportValue, xToTime } from './canvas/viewport'
import { useKeymap, matchesArrowLeft, matchesArrowRight, matchesDelete } from '../keymap'
import { Tooltip } from '../../ui/Tooltip'

/** How long the auto-crossfade pass waits after an audio-timing change before
 *  it COMMITS the derived fades. Long enough that the continuous changes of a
 *  live drag keep resetting it (so a whole gesture commits its crossfade once,
 *  via `commitTimelineEdit`, not per frame); short enough that a settled edge
 *  edit or ripple-delete lands its fade promptly. See the effect below. */
export const CROSSFADE_COMMIT_DELAY_MS = 250

/** Imperative actions a host-level command palette can trigger on the
 *  timeline's zoom without lifting Timeline's local state up. Filled via
 *  `actionsRef` (SP5 T9) — mirrors `transportRef`'s "ref threaded down,
 *  written by the owner" shape used for PreviewPlayer. */
export interface TimelineActions {
  zoomFit: () => void
}

interface TimelineProps {
  project: Project
  clock: PlaybackClock
  onProjectChange?: (p: Project) => void
  onOverlayEdit?: (p: Project) => void
  /** Open the overlay props dialog (owned by VideoEditor). Threaded to each
   *  VisualTrackRow so a selected overlay block can offer an edit button. */
  onEditOverlay?: (id: string) => void
  /** Unified selection — covers both visual items and audio tracks. Captions
   *  share this same array (D1) — a caption id is selected/moved/trimmed on
   *  the canvas timeline exactly like a clip or audio track. Caption editing
   *  UI itself (text, style, per-segment color) lives in the sidebar
   *  CaptionListPanel now, not in Timeline — see VideoEditor.tsx. */
  selectedIds?: string[]
  onSelectIds?: (ids: string[]) => void
  onInspectClip?: (id: string) => void
  onInspectAudio?: (id: string) => void
  /** Double-click on a caption block (canvas mode only). Forwarded straight to
   *  `TimelineCanvas` — Timeline itself does nothing with it beyond passing it
   *  through, same as `onInspectClip`/`onInspectAudio` above. The host
   *  (VideoEditor) uses this to focus the segment's row in the sidebar
   *  CaptionListPanel, since a caption has no inspector dialog of its own. */
  onEditCaption?: (id: string) => void
  rippleMode?: boolean
  /**
   * CapCut's "preview axis" toggle, owned by VideoEditor's track-controls bar
   * and OFF by default — off is exactly the behaviour this timeline has always
   * had, so omitting it changes nothing. On, a yellow cursor line tracks the
   * pointer and `onHoverScrub` reports the time under it. Canvas mode only:
   * the DOM track rows keep their own mouse-follow indicator.
   */
  previewAxis?: boolean
  /** The time under the pointer while the axis is on, null when it leaves.
   *  Fires per mousemove — VideoEditor routes it into an external store. */
  onHoverScrub?: (time: number | null) => void
  /**
   * SP5 — opt into the canvas track-row area. Mirrors the `engine` (SP4)
   * host-knob precedent. Absent or `{ canvas: false }`: the existing DOM
   * track rows (visual tracks + audio lanes), unchanged — this is the
   * non-regression guarantee SP5 tests against, but captions pay for it:
   * DOM mode has no caption row at all, so captions can only be edited
   * through the sidebar transcript panel, with no timeline retiming
   * available there. `{ canvas: true }`: the DOM track rows are replaced by
   * one `TimelineCanvas` surface with its own px-per-second viewport, and
   * captions get their own row IN it — selected, moved and trimmed exactly
   * like a clip, through the unified `selectedIds`.
   */
  timeline?: { canvas: boolean }
  /** Audio-waveform fetcher, threaded to every AudioWaveformLayer. In V4 the
   *  VideoEditor wires this from `adapter.getWaveformChunks`. Absent → no
   *  waveforms render (graceful). */
  getWaveformChunks?: GetWaveformChunks
  /** Resolves a waveform chunk's host path into a displayable URL. */
  resolveFilePath?: ResolveFilePath
  /** Zoom-bucketed peaks fetcher for the canvas timeline's waveforms (T6),
   *  threaded from `adapter.getWaveformPeaks`. Canvas-mode only — passed to
   *  `TimelineCanvas` and ignored by the DOM track rows. Absent → no
   *  waveforms anywhere (graceful). */
  getWaveformPeaks?: (args: GetWaveformPeaksArgs) => Promise<PeaksData>
  /** Filmstrip-index fetcher for the canvas timeline's tile strips + hover-
   *  scrub thumb (T7), threaded from `adapter.getFilmstrip`. Canvas-mode
   *  only — passed to `TimelineCanvas` and ignored by the DOM track rows.
   *  Absent → no filmstrips or thumbs anywhere (graceful). */
  getFilmstrip?: (args: GetFilmstripArgs) => Promise<FilmstripIndex>
  /** Host-computed gate for the per-clip subcut-regenerate affordance (Montaj:
   *  ai_video projects). The package never reads `projectType`. */
  regenEnabled?: boolean
  /** Host-computed predicate driving the per-clip "queued" badge (Montaj:
   *  project.regenQueue membership). The package never reads `regenQueue`. */
  isClipQueued?: (itemId: string) => boolean
  /** Render-prop seam for the Montaj-specific subcut-regeneration tool. The
   *  timeline owns the open/close trigger (the per-clip Scissors button toggles
   *  `subcutClipId`); when a clip is active it calls this with the clip id and a
   *  close callback. The host closure supplies the full Montaj project,
   *  regenQueue, storyboard, and onSave — none of which the package types know.
   *  Absent → the subcut tool is simply not rendered. */
  renderSubcutRegen?: (ctx: { clipId: string; onClose: () => void }) => ReactNode
  /**
   * SP5 T9 — true while a HOST-level dialog (RenderModal, the command
   * palette, etc.) is open, so Timeline's own keymap (arrows/delete/enter/
   * escape) doesn't fire underneath it. Absent (PendingSurface today has no
   * such dialogs) → the keymap's own guards apply, unchanged.
   */
  modalOpen?: boolean
  /** Opens the command palette's "go to time" input directly. Wired to the
   *  scrubber's time readout; absent → the readout is plain text. */
  onOpenGoToTime?: () => void
  /** Imperative zoom actions for a host-level command palette. */
  actionsRef?: MutableRefObject<TimelineActions | null>
}

/** Icon size for the fade-shape picker's buttons — small enough for a
 *  compact popover, large enough that `exp`/`log`'s curvature reads clearly
 *  at a glance. */
const FADE_CURVE_ICON_SIZE = { width: 40, height: 28 }
/** Inset between the icon's frame and where the curve itself is drawn, so
 *  the polyline never touches (and gets clipped by) the frame's own stroke. */
const FADE_CURVE_ICON_PAD = 4

/**
 * One fade-shape picker option's icon: a small inline SVG tracing the ACTUAL
 * curve (`fadeCurveIconPoints`, sampling the same `fadeGain` the real
 * envelope and waveform scaling use), not a decorative stand-in — "Linear"
 * really is a straight ramp, "Logarithmic" really is concave-down (rises
 * fast, levels near the top), "Exponential" really is concave-up (stays low,
 * rises sharply near the end). Silent is the bottom-left corner, full volume
 * the top-right, matching Vegas' own fade-icon convention.
 *
 * `active` brightens both the frame and the stroke — the same "clearer when
 * it matters" language the timeline's other affordances (trim handles, fade
 * grips) already use — so the picker itself shows which shape is currently
 * set the moment it opens.
 */
function FadeCurveIcon({ curve, active }: { curve: FadeCurve; active: boolean }) {
  const { width: w, height: h } = FADE_CURVE_ICON_SIZE
  const points = fadeCurveIconPoints(curve, w - FADE_CURVE_ICON_PAD * 2, h - FADE_CURVE_ICON_PAD * 2)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="block">
      <rect
        x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3}
        fill="none"
        stroke={active ? TIMELINE_COLORS.fadeEnvelopeLine : 'rgba(255,255,255,0.15)'}
        strokeWidth={1}
      />
      <path
        d={d}
        transform={`translate(${FADE_CURVE_ICON_PAD},${FADE_CURVE_ICON_PAD})`}
        fill="none"
        stroke={active ? TIMELINE_COLORS.fadeEnvelopeLine : 'rgba(255,255,255,0.75)'}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function Timeline({ project, clock, onProjectChange, onOverlayEdit, onEditOverlay, selectedIds = [], onSelectIds, onInspectClip, onInspectAudio, onEditCaption, rippleMode = false, previewAxis = false, onHoverScrub, getWaveformChunks, resolveFilePath, getWaveformPeaks, getFilmstrip, regenEnabled, isClipQueued, renderSubcutRegen, timeline, modalOpen = false, onOpenGoToTime, actionsRef }: TimelineProps) {

  // Click/shift-click handler — additive selection on shift or meta (cmd/ctrl).
  // Under D1, captions share `selectedIds` with everything else, so there is
  // no separate caption-clearing step here anymore: a plain (non-additive)
  // select REPLACES the whole array with just this id, which drops any caption
  // id that was in it, and a click on empty space (id === null) clears the
  // array outright. A shift-click still ADDS to whatever is already selected,
  // so a caption can sit alongside clips/audio in one selection — the
  // overlay-parity ability D1 was for. VideoEditor derives its own
  // `selectedCaptionId` (the preview's caption-box target) from this same
  // array; see its `handleSelectCaption`.
  /**
   * Skip / un-skip a whole visual track.
   *
   * Preview-then-commit, the same two-channel shape every other timeline edit
   * uses: `onProjectChange` applies it live (transient — no save, no undo
   * entry), `onOverlayEdit` commits it as ONE undo step. Writing only through
   * `onProjectChange` would leave it unsaved until some unrelated gesture
   * flushed it.
   */
  function handleToggleTrackEnabled(trackIdx: number, enabled: boolean) {
    if (!onProjectChange) return
    const normalized = normalizeTracks(project)
    const tracks = (normalized.tracks ?? []).map((t, i) =>
      i === trackIdx ? { ...t, enabled } : t,
    )
    const next = { ...normalized, tracks } as Project
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  /**
   * Track-wide volume/mute, from the rail's settings popover (TrackGutter.tsx).
   * Same preview-then-commit shape as `handleToggleTrackEnabled` above, split
   * across two handlers because volume is a CONTINUOUS control (a slider drag
   * must preview many times and commit once) while mute is a discrete toggle
   * (one click, one commit) — mirrors CaptionListPanel's fontsize slider vs.
   * its style buttons.
   *
   * This writes `VisualTrack.volume`/`.muted`; the value doesn't stay
   * track-level from there. `effectiveItemAudio(track, item)` in
   * timeline-model.ts folds it into each item's own volume/mute (multiply,
   * either/or), and every playback and export path reads the FOLDED value at
   * its own fold point: `clipGain` in `useVideoPlayback.ts`,
   * `withTrackAudio` in `engine/scheduler.ts`, and the inline fold in
   * `render.js` (`collectAllItems`, ~line 829).
   */
  function handleSetTrackVolume(trackIdx: number, volume: number, commit: boolean) {
    if (!onProjectChange) return
    const normalized = normalizeTracks(project)
    const tracks = (normalized.tracks ?? []).map((t, i) =>
      i === trackIdx ? { ...t, volume } : t,
    )
    const next = { ...normalized, tracks } as Project
    onProjectChange(next)
    if (commit) onOverlayEdit?.(next)
  }

  function handleSetTrackMuted(trackIdx: number, muted: boolean) {
    if (!onProjectChange) return
    const normalized = normalizeTracks(project)
    const tracks = (normalized.tracks ?? []).map((t, i) =>
      i === trackIdx ? { ...t, muted } : t,
    )
    const next = { ...normalized, tracks } as Project
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  /**
   * Track-wide speed, from the rail's settings popover's Speed control
   * (TrackGutter.tsx / TrackSettingsPopover.tsx). Unlike volume/mute
   * above, speed isn't a `VisualTrack` setting — it lives on each video
   * clip — so this folds `setClipSpeed` over every video item on the track
   * into ONE project before committing, the same way a multi-item ripple
   * delete produces a single undo entry rather than one per clip. A bulk,
   * one-shot edit (mirrors the clip inspect modal's own "Save speed" button),
   * not a live preview, so there's no `commit` flag to thread.
   */
  function handleApplyTrackSpeed(trackIdx: number, speed: number) {
    if (!onProjectChange) return
    const items = trackItems(project)[trackIdx] ?? []
    let next = project
    for (const item of items) {
      if (item.type === 'video') next = setClipSpeed(next, item.id, speed)
    }
    if (rippleMode) next = collapseGaps(next)
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  /**
   * Audio-LANE volume/mute, from the rail's settings popover. A lane can hold
   * several `AudioTrack`s sharing one row (see `groupAudioLanes` in
   * timeline-model.ts), so the popover's single control fans out to every
   * track id in the lane via the existing `updateAudioTrack` helper — unlike
   * the visual-track handlers above, `AudioTrack.volume`/`.muted` are already
   * live end to end (mix-audio.js, both preview paths), no separate fold step
   * needed.
   */
  function handleSetLaneVolume(trackIds: string[], volume: number, commit: boolean) {
    if (!onProjectChange) return
    let next = project
    for (const id of trackIds) next = updateAudioTrack(next, id, { volume })
    onProjectChange(next)
    if (commit) onOverlayEdit?.(next)
  }

  function handleSetLaneMuted(trackIds: string[], muted: boolean) {
    if (!onProjectChange) return
    let next = project
    for (const id of trackIds) next = updateAudioTrack(next, id, { muted })
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  /**
   * Audio-LANE magnet toggle — same fan-out as mute above, since a lane can
   * hold several `AudioTrack`s. Turning it ON also collapses the lane
   * immediately (`reflowMagneticLanes`), so flipping the switch is itself an
   * edit rather than something that waits for the next drag to take effect.
   * Turning it OFF just clears the flag; a lane already gapless stays exactly
   * where it is.
   */
  function handleSetLaneMagnet(trackIds: string[], magnetic: boolean) {
    if (!onProjectChange) return
    let next = project
    for (const id of trackIds) next = updateAudioTrack(next, id, { magnetic })
    if (magnetic) next = reflowMagneticLanes(next)
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  /**
   * The fade-shape picker: a small DOM menu (Linear / Logarithmic /
   * Exponential) that opens on a RIGHT-CLICK of a fade grip (Vegas' own
   * gesture — see `TimelineCanvas`'s `contextMenu` handler, which is the only
   * caller of `setFadeCurveMenu`). `x`/`y` are CLIENT coordinates, so the
   * menu below positions itself with `position: fixed` rather than measuring
   * anything on this component's own tree.
   */
  const [fadeCurveMenu, setFadeCurveMenu] = useState<{ trackId: string; side: 'in' | 'out'; x: number; y: number } | null>(null)

  /**
   * Commit a fade's shape — a discrete, one-shot pick like
   * `handleSetLaneMagnet` above, not a continuous drag, so `onProjectChange`
   * + `onOverlayEdit` fire together as ONE undo entry rather than splitting
   * across a preview/commit pair.
   */
  function handleSetFadeCurve(trackId: string, side: 'in' | 'out', curve: FadeCurve) {
    setFadeCurveMenu(null)
    if (!onProjectChange) return
    const next = updateAudioTrack(project, trackId, side === 'in' ? { fadeInCurve: curve } : { fadeOutCurve: curve })
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  function handleSelectItem(id: string | null, additive: boolean) {
    if (!onSelectIds) return
    if (id === null) { onSelectIds([]); return }
    onSelectIds(toggleSelection(selectedIds, id, additive))
  }

  /**
   * A marquee's whole catch, applied at once.
   *
   * Deliberately a SET operation rather than a fold of `toggleSelection`:
   * toggling would flip off any item that was already selected and happens to
   * fall inside the box, so dragging a marquee over an existing selection would
   * deselect exactly the clips it visibly covers. A marquee states what is
   * selected; additive unions it with what was there.
   */
  function handleSelectItems(ids: string[], additive: boolean) {
    if (!onSelectIds) return
    onSelectIds(additive ? [...new Set([...selectedIds, ...ids])] : ids)
  }
  const allTracks      = trackItems(project)
  const captionTrack   = project.captions
  const audioTracks    = project.audio?.tracks ?? []

  // Memoized so playback ticks (which re-render Timeline via the ctx useMemo's
  // clock dependency) don't recompute these on every frame — they only change
  // when the underlying tracks/audio actually change. Both the DOM and canvas
  // (T4) track-row areas import this from timeline-model.ts, so timing can't
  // drift between the two.
  const { snapBoundaries, contentDuration, totalDuration } = useMemo(
    () => computeDerivedTiming(project),
    [project.tracks, project.audio],
  )

  // Auto-crossfade: when two audio tracks overlap, apply fade-out on the
  // earlier and fade-in on the later, each equal to the overlap duration. The
  // decision logic lives in timeline-model.ts (computeAutoCrossfade) so both
  // the DOM and canvas (T4) track-row areas share it; this effect is a thin
  // shell that applies the result.
  useEffect(() => {
    if (!onOverlayEdit) return
    const next = computeAutoCrossfade(project)
    if (!next) return
    // Commit the derived crossfade on a short delay, NEVER synchronously per
    // change. Audio timing moves on every mousemove of a drag, and committing
    // each one recorded dozens of undo entries for a single gesture — audio's
    // version of the per-move-undo bug the video-move commit split fixed. A
    // drag's own commit (`commitTimelineEdit`) now folds the crossfade into its
    // one undo step, so this debounced pass is only the catch-all for audio
    // timing that changes OUTSIDE a gesture (ripple-delete, gap-collapse): mid-
    // drag the timer is cleared and rescheduled every frame and never fires,
    // and right after a gesture it no-ops because `computeAutoCrossfade` is
    // idempotent. The digest keying this effect includes the FADES on purpose —
    // the gesture's own crossfade commit changes it, which re-runs this effect
    // and clears the pending timer rather than letting a stale one fire. That
    // is also why this only commits and no longer previews via `onProjectChange`:
    // a preview would change the fade digest and clear the timer before it
    // fired, so a ripple-delete's crossfade would never get saved.
    const timer = setTimeout(() => onOverlayEdit(next), CROSSFADE_COMMIT_DELAY_MS)
    return () => clearTimeout(timer)
  // Keyed on a stable digest of audio-track timing/mute AND fades, so the pass
  // re-runs on real edits (see above for why the fades belong in the key).
  }, [audioTracks.map(t => `${t.id}:${t.start}:${t.end}:${t.muted}:${t.fadeIn ?? ''}:${t.fadeOut ?? ''}`).join('|')])

  const [hoverPct, setHoverPct]               = useState<number | null>(null)
  const [draggingPlayhead, setDraggingPlayhead] = useState(false)

  // The tabIndex={0} root below — Delete/Enter's guards below check focus is
  // inside it before firing (see the useKeymap block), restoring the pre-T9
  // scoping those two bindings had (arrows/Escape were already document-level
  // pre-SP5 and stay that way — see the useKeymap block's own comment).
  const rootRef                               = useRef<HTMLDivElement>(null)
  const scrubberRef                           = useRef<HTMLDivElement>(null)
  const overlayDraggedRef                     = useRef(false)
  const [keyNavTime, setKeyNavTime]           = useState<number | null>(null)
  const keyNavTimerRef                        = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [subcutClipId, setSubcutClipId]       = useState<string | null>(null)

  const { zoom, zoomRef, scrollRef, zoomTo } = useTimelineZoom(totalDuration)

  // ── Zoom chrome, one control set over two models ──
  // The DOM path zooms a scroll container by a multiplier; the canvas path
  // pans/zooms a px-per-second viewport. Both feed the same three buttons via
  // this adapter, so the chrome below doesn't branch and legacy mode renders
  // exactly what it rendered before.
  const canvasMode = timeline?.canvas === true
  const viewportStore = useViewportStore()
  const canvasZoom = useCanvasZoomControls(viewportStore, totalDuration)
  const zoomControls: ZoomControls = canvasMode ? canvasZoom : {
    badge: <span className="text-[10px] font-mono text-gray-500 w-7 text-center tabular-nums select-none">{zoom}×</span>,
    zoomIn:  () => zoomTo(zoomRef.current + 1),
    zoomOut: () => zoomTo(zoomRef.current - 1),
    fit:     () => zoomTo(1),
    showFit: zoom > 1,
  }

  // ── Timeline's own keymap — arrows (frame-step) and delete (two-step:
  // deleteSelection + conditional collapseGaps). SP5 T9: these bindings
  // replace Timeline's old ad hoc document listener (arrows, gated on
  // totalDuration>0 by not registering at all) and its container-scoped
  // onKeyDown (delete) with the shared registry — one guarded document
  // listener instead of two different attachment mechanisms with two
  // different guard sets.
  //
  // Mounted HERE, not lifted into VideoEditor's keymap: this instance runs in
  // BOTH the pending and review surfaces (PendingSurface and ReviewSurface
  // each render their own `<Timeline>` with their own `PlaybackClock`), same
  // as the listeners it replaces. `modalOpen` is the host's dialogs
  // (ReviewSurface's RenderModal/palette/etc — absent in PendingSurface).
  const fps = project.settings?.fps ?? 30
  const frameStep = 1 / fps
  useKeymap([
    {
      id: 'timeline.frame-step',
      description: 'Step one frame (Shift steps ten)',
      matches: (e) => matchesArrowLeft(e) || matchesArrowRight(e),
      guard: () => totalDuration > 0,
      action: (e) => {
        // Shift is a COARSE frame step, not a wall-clock jump: ten frames,
        // so the unit stays the same as the plain step and only the size
        // changes. It used to be a flat 1 second, which meant the shifted
        // step drifted against the unshifted one on every fps that isn't 10.
        const step = e.shiftKey ? 10 * frameStep : frameStep
        const dir  = matchesArrowRight(e) ? 1 : -1
        const next = Math.max(0, Math.min(totalDuration, clock.get() + dir * step))
        clock.set(next)
        setKeyNavTime(next)
        if (keyNavTimerRef.current) clearTimeout(keyNavTimerRef.current)
        keyNavTimerRef.current = setTimeout(() => setKeyNavTime(null), 1500)
      },
    },
    {
      id: 'timeline.delete-selection',
      description: 'Delete selection',
      matches: matchesDelete,
      // Focus-scoped (unlike arrows/Escape below): pre-SP5, delete lived on
      // the container's own onKeyDown, so it only ever fired with the
      // timeline focused. Restored here so a Backspace pressed elsewhere on
      // the page (e.g. typing in the preview's overlay panel) can't delete
      // the selected clip out from under the operator.
      guard: () => selectedIds.length > 0 && !!rootRef.current?.contains(document.activeElement),
      action: () => {
        if (!onProjectChange) return
        let updated = deleteSelection(project, selectedIds)
        // `deleteSelection` only knows tracks/audio vocabulary (see
        // multiSelectOps.ts) — captions never lived in project.tracks, so a
        // selected caption segment needs its own strip here, folded into the
        // SAME commit as the clip/audio delete (one onProjectChange + one
        // onOverlayEdit = one undo entry covering a mixed selection).
        if (captionTrack?.segments?.length) {
          const targets = new Set(selectedIds)
          const kept = captionTrack.segments.filter(seg => !seg.id || !targets.has(seg.id))
          // Leave captions as an EMPTY-segments object when every segment is
          // removed, never null the whole track — that's the sidebar's
          // explicit "Remove all" action, not a side effect of Delete.
          //
          // `normalizeCaptionLanes` runs INSIDE this same commit: emptying a
          // caption row leaves a hole lane, and collapsing it here means the
          // row disappearing and its neighbours renumbering are the same undo
          // entry as the delete that caused them, not a second one.
          if (kept.length !== captionTrack.segments.length) {
            updated = { ...updated, captions: normalizeCaptionLanes({ ...captionTrack, segments: kept }) }
          }
        }
        if (rippleMode) updated = collapseGaps(updated)
        // Deleting a clip out of a magnetic audio lane leaves a gap exactly
        // like a trim or a move would — close it the same way, on release.
        updated = reflowMagneticLanes(updated)
        onProjectChange(updated)
        onOverlayEdit?.(updated)
        onSelectIds?.([])
      },
    },
  ], { modalOpen })

  // Close the fade-curve picker on Escape — the backdrop click below (and a
  // pick itself) already closes it any other way a user would try.
  useEffect(() => {
    if (!fadeCurveMenu) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setFadeCurveMenu(null) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [fadeCurveMenu])

  // Hand the zoom action up to a host-level command palette.
  useEffect(() => {
    if (!actionsRef) return
    actionsRef.current = { zoomFit: zoomControls.fit }
    return () => { actionsRef.current = null }
  })

  // Subscribing here (rather than inside each DOM row) keeps one subscription
  // for the whole timeline; the rows that need it read it off the context.
  // Null in DOM mode, where the rows own the layout and there is no canvas
  // zoom to track.
  // Same layout the canvas paints from, so the rail's rows line up with the
  // clips exactly rather than by two independent calculations agreeing.
  const canvasLayout = useMemo(() => computeTimelineLayout(project), [project.tracks, project.audio, project.captions])

  const canvasViewport = useViewportValue(viewportStore)
  const viewport = canvasMode ? canvasViewport : null

  const ctx = useMemo<TimelineContextValue>(() => ({
    viewport,
    totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, clock,
  }), [viewport, totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, clock])

  /**
   * Clicks that land on the timeline column but not on any row: the readout
   * strip above the tracks, the gaps between rows, the space under the last
   * one. They are background, and background belongs to the timeline — not
   * dead chrome.
   *
   * In CANVAS mode this used to do nothing at all. It maps x→time through the
   * scrubber's rect, and canvas mode doesn't render the scrubber bar, so
   * `scrubberRef` is null and every one of these clicks fell out at the
   * `if (!rect) return` below. The visible result was a ~40px strip under the
   * toolbar that looked live and ignored you — including for the thing you
   * most want a background click to do, which is drop the selection.
   *
   * Canvas mode now reads the canvas' own x-axis instead, so a background
   * click does exactly what pressing bare canvas does: clear the selection,
   * and seek to the clicked time. Clicks to the left of the canvas (over the
   * track rail, which has no time axis) clear the selection without seeking.
   * The canvas surface itself stops propagation — the pointer machine has
   * already seeked on mousedown — so nothing here double-handles a real
   * timeline click.
   *
   * `pointer-events` note: the controls in the strip (zoom buttons, the go-to
   * time readout) are excluded by the `closest` test below, so isolating them
   * costs nothing beyond it.
   */
  function handleContainerClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button, input, [contenteditable], [data-timeline-chrome]')) return
    if (totalDuration === 0) return

    if (canvasMode) {
      // Same order the pointer machine emits its effects in for a press on
      // bare canvas: clear the selection, then seek.
      handleSelectItem(null, false)
      const surface = rootRef.current?.querySelector('[data-timeline-canvas]')
      if (!surface || !viewport) return
      const surfaceRect = surface.getBoundingClientRect()
      const x = e.clientX - surfaceRect.left
      if (x < 0 || x > surfaceRect.width) return   // over the rail — no time here
      clock.set(Math.max(0, Math.min(totalDuration, xToTime(x, viewport))))
      return
    }

    const rect = scrubberRef.current?.getBoundingClientRect()
    if (!rect) return
    const clickedTime = ratioFromClientX(e.clientX, rect) * totalDuration
    const snapThreshold = (8 / rect.width) * totalDuration
    const boundaries = snapBoundaries
    for (const b of boundaries) {
      if (Math.abs(clickedTime - b) < snapThreshold) { clock.set(b); return }
    }
    clock.set(clickedTime)
  }

  return (
    <TimelineContext.Provider value={ctx}>
    <div
      ref={rootRef}
      // `min-h-full` so the column always fills the resizable timeline pane:
      // that is what lets the transcript panel below sit at the BOTTOM of the
      // pane rather than floating right under the tracks, and it makes the
      // space between them read as timeline surface instead of page
      // background. Content taller than the pane still scrolls.
      className="flex min-h-full flex-col gap-2 px-3 py-3 select-none outline-none"
      tabIndex={0}
      onMouseMove={(e) => {
        const rect = scrubberRef.current?.getBoundingClientRect()
        if (rect) setHoverPct(ratioFromClientX(e.clientX, rect) * 100)
      }}
      onMouseLeave={() => setHoverPct(null)}
      onClick={handleContainerClick}
    >

      {/* Zoom controls */}
      {totalDuration > 0 && (
        <div className={`flex items-center justify-end gap-0.5 -mb-1 ${canvasMode ? 'cursor-pointer' : ''}`}>
          <Tooltip label="Zoom out">
            <button
              className="text-[11px] leading-none text-gray-500 hover:text-gray-300 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
              aria-label="Zoom out"
              onClick={(e) => { e.stopPropagation(); zoomControls.zoomOut() }}
            >−</button>
          </Tooltip>
          {zoomControls.badge}
          <Tooltip label="Zoom in">
            <button
              className="text-[11px] leading-none text-gray-500 hover:text-gray-300 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
              aria-label="Zoom in"
              onClick={(e) => { e.stopPropagation(); zoomControls.zoomIn() }}
            >+</button>
          </Tooltip>
          {zoomControls.showFit && (
            <Tooltip label="Fit to view" className="ml-0.5">
              <button
                className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 h-5 rounded hover:bg-gray-800 transition-colors"
                aria-label="Fit to view"
                onClick={(e) => { e.stopPropagation(); zoomControls.fit() }}
              >fit</button>
            </Tooltip>
          )}
        </div>
      )}

      {/* Scroll container for zoomed tracks */}
      <div ref={scrollRef} className="overflow-x-auto">
      <div style={{ width: zoom > 1 ? `${zoom * 100}%` : '100%' }} className="min-w-full">

      {/* Scrubber + tracks wrapped in a relative container so the hover indicator spans the full height */}
      <div className="relative flex flex-col gap-2">
        {/* Mouse-follow indicator — DOM mode only. The canvas surface draws its
            own cursor line (on its own time axis, and only while the preview
            axis is on); this one is positioned as a percentage of the
            SCRUBBER's width, which stops being the canvas' time axis the
            moment you zoom in. The scrubber's hover tooltip (driven by the same
            `hoverPct`) is unaffected and still reads out the hovered time. */}
        {!canvasMode && hoverPct !== null && totalDuration > 0 && (
          <div
            className="absolute inset-y-0 w-px bg-yellow-400/80 pointer-events-none z-20"
            style={{ left: `${hoverPct}%` }}
          />
        )}

      <Scrubber
        showBar={!canvasMode}
        hoverPct={hoverPct}
        draggingPlayhead={draggingPlayhead}
        setDraggingPlayhead={setDraggingPlayhead}
        keyNavTime={keyNavTime}
        onOpenGoToTime={onOpenGoToTime}
      />

      {/* ── Tracks ── */}
      <div className="flex flex-col gap-1">
        {project.renderMode === 'ffmpeg-drawtext' && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-400/70 select-none">
            <span>⚡</span>
            <span>ffmpeg render — overlays are preview only, final text is burned by ffmpeg</span>
          </div>
        )}
        {canvasMode ? (
          // The gutter is a sibling COLUMN, not an overlay: it takes width from
          // the canvas (which measures its own container) instead of painting
          // over the clips at t=0. Captions have their own row PAINTED inside
          // `TimelineCanvas` below, not a separate DOM element — the gutter's
          // own caption cell is sized from the same layout (`canvasLayout`) so
          // the two line up. `showCaptionRow` is left at its default (true)
          // here: `TrackGutter` already gates the cell on `resolved.captions`,
          // which `computeTimelineLayout` only sets when there ARE captions,
          // so passing `!!captionTrack?.segments?.length` on top can never
          // change the outcome — it exists as a host knob for other callers,
          // not for this one.
          <div className="flex gap-1">
            <TrackGutter
              project={project}
              layout={canvasLayout}
              onToggleTrackEnabled={handleToggleTrackEnabled}
              onSetTrackVolume={handleSetTrackVolume}
              onSetTrackMuted={handleSetTrackMuted}
              onApplySpeed={handleApplyTrackSpeed}
              onSetLaneVolume={handleSetLaneVolume}
              onSetLaneMuted={handleSetLaneMuted}
              onSetLaneMagnet={handleSetLaneMagnet}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* ── Canvas track-row area — one surface in place of the visual
                tracks + audio lanes the DOM branch renders below. It owns its
                own zoom/scroll (px-per-second), so the scrubber above it stays
                a whole-project overview rather than tracking canvas zoom. ── */}
            <TimelineCanvas
              project={project}
              clock={clock}
              store={viewportStore}
              totalDuration={totalDuration}
              fps={fps}
              selectedIds={selectedIds}
              snapBoundaries={snapBoundaries}
              rippleMode={rippleMode}
              previewAxis={previewAxis}
              onHoverScrub={onHoverScrub}
              onSelectItem={handleSelectItem}
              onSelectItems={handleSelectItems}
              onProjectChange={onProjectChange}
              onOverlayEdit={onOverlayEdit}
              onInspectClip={onInspectClip}
              onInspectAudio={onInspectAudio}
              onEditCaption={onEditCaption}
              onFadeCurveMenu={setFadeCurveMenu}
              getWaveformPeaks={getWaveformPeaks}
              getFilmstrip={getFilmstrip}
              resolveFilePath={resolveFilePath}
            />
            </div>
          </div>
        ) : (
          <>
            {[...allTracks].reverse().map((trackItems, reversedIdx) => {
              const trackIdx = allTracks.length - 1 - reversedIdx
              return (
                <VisualTrackRow
                  key={trackIdx}
                  trackItems={trackItems}
                  trackIdx={trackIdx}
                  project={project}
                  selectedIds={selectedIds}
                  rippleMode={rippleMode}
                  onProjectChange={onProjectChange}
                  onOverlayEdit={onOverlayEdit}
                  onEditOverlay={onEditOverlay}
                  onSelectItem={handleSelectItem}
                  onInspectClip={onInspectClip}
                  subcutClipId={subcutClipId}
                  setSubcutClipId={setSubcutClipId}
                  regenEnabled={regenEnabled}
                  isClipQueued={isClipQueued}
                />
              )
            })}

            {/* Audio tracks — grouped by lane. The grouping lives in
                timeline-model so the canvas painter puts each track in the
                same row this branch does. */}
            {(() => {
              const lanes = groupAudioLanes(audioTracks, contentDuration)

              return lanes.map(({ laneIndex: laneIdx, tracks: laneTracks }) => (
                <AudioTrackRow
                  key={`audio-lane-${laneIdx}`}
                  tracks={laneTracks}
                  laneIndex={laneIdx}
                  laneCount={lanes.length}
                  project={project}
                  onProjectChange={onProjectChange}
                  onOverlayEdit={onOverlayEdit}
                  selectedIds={selectedIds}
                  onSelectItem={handleSelectItem}
                  onInspect={onInspectAudio}
                  getWaveformChunks={getWaveformChunks}
                  resolveFilePath={resolveFilePath}
                />
              ))
            })()}
          </>
        )}

      </div>

      </div>{/* end scrubber+tracks wrapper */}
      </div>{/* end inner zoom div */}
      </div>{/* end scroll container */}

      {/* ── Subcut regen tool (host-rendered via render-prop seam) ──
          The Montaj-specific SubcutRegenTool lives in the host (it reads
          regenQueue/storyboard). The timeline owns only the open trigger:
          the per-clip Scissors button sets subcutClipId. We surface a clip
          that still has frozen generation provenance (in-package field) and
          let the host decide what to render. */}
      {subcutClipId && renderSubcutRegen && (() => {
        const subcutClip = allTracks[0]?.find(c => c.id === subcutClipId)
        if (!subcutClip || !subcutClip.generation) return null
        return renderSubcutRegen({
          clipId: subcutClipId,
          onClose: () => setSubcutClipId(null),
        })
      })()}

      {/* ── Fade-shape picker — right-click a fade grip (canvas mode; see
          `TimelineCanvas`'s `contextMenu` handler). `fixed`-positioned at the
          CLIENT coordinates the grip was clicked at, since it renders outside
          the canvas surface's own coordinate space. A full-surface backdrop
          behind it closes the menu on any click (or right-click) elsewhere —
          the same dismiss-on-outside-interaction every other popover here
          uses (TrackSettingsPopover). Options are ICONS (`FadeCurveIcon`),
          not text — Vegas shows the curve's shape, not its name — with the
          shape name kept as `title`/`aria-label` so it's still discoverable
          on hover and to a screen reader. */}
      {fadeCurveMenu && (() => {
        const track = project.audio?.tracks?.find(t => t.id === fadeCurveMenu.trackId)
        const activeCurve: FadeCurve = (fadeCurveMenu.side === 'in' ? track?.fadeInCurve : track?.fadeOutCurve) ?? DEFAULT_FADE_CURVE
        return (
          <>
            <div
              data-timeline-chrome
              data-testid="fade-curve-menu-backdrop"
              className="fixed inset-0 z-40"
              onClick={() => setFadeCurveMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setFadeCurveMenu(null) }}
            />
            <div
              data-timeline-chrome
              className="fixed z-50 flex gap-1 rounded border border-gray-700 bg-gray-900 p-1 shadow-xl"
              style={{ left: fadeCurveMenu.x, top: fadeCurveMenu.y }}
            >
              {([
                ['linear', 'Linear'],
                ['log', 'Logarithmic'],
                ['exp', 'Exponential'],
              ] as const).map(([curve, label]) => (
                <button
                  key={curve}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={activeCurve === curve}
                  className={`rounded p-0.5 transition-colors ${activeCurve === curve ? 'bg-gray-700 ring-1 ring-emerald-400/60' : 'hover:bg-gray-800'}`}
                  onClick={() => handleSetFadeCurve(fadeCurveMenu.trackId, fadeCurveMenu.side, curve)}
                >
                  <FadeCurveIcon curve={curve} active={activeCurve === curve} />
                </button>
              ))}
            </div>
          </>
        )
      })()}

    </div>
    </TimelineContext.Provider>
  )
}
