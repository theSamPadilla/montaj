import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Scissors } from 'lucide-react'
import { EASING_NAMES } from '@bycrux/timeline-core'
import type { FilmstripIndex, GetFilmstripArgs, GetWaveformPeaksArgs, PeaksData, Project, ResolveFilePath } from '../../types'
import type { EasingName, KeyframeProp, VisualItem } from '../../schema'
import { reflowMagneticLanes } from '../audioMagnet'
import { normalizeCaptionLanes } from '../captionLanes'
import { collapseGaps, setClipSpeed } from '../cuts'
import { removeKeyframesAt, setKeyframeEasing } from '../keyframeOps'
import { useTimelineZoom } from './useTimelineZoom'
import { TimelineContext, type TimelineContextValue } from './TimelineContext'
import type { PlaybackClock } from '../playback-clock'
import Scrubber from './Scrubber'
import TrackGutter from './TrackGutter'
import { computeTimelineLayout, timelinePalette, type TimelineLayout, type TimelineMode } from './canvas/draw'
import { DEFAULT_FADE_CURVE, fadeCurveIconPoints, type FadeCurve } from './canvas/fade-curve'
import { VISUAL_EDGE_TOLERANCE_PX } from './canvas/hit-test'
import { keyframeUnionTimes } from './canvas/keyframe-strip'
import { mapTrackItems, normalizeTracks, updateAudioTrack } from './timeline-model'
import { deleteSelection, toggleSelection } from './multiSelectOps'
import { computeAutoCrossfade, computeDerivedTiming, trackItems } from './timeline-model'
import TimelineCanvas, { useCanvasZoomControls, type ZoomControls } from './canvas/TimelineCanvas'
import type { KeyframeSelection } from './canvas/pointer-machine'
import { timeToX, useViewportStore, useViewportValue, xToTime, type ViewportStore } from './canvas/viewport'
import { useKeymap, matchesArrowLeft, matchesArrowRight, matchesDelete, matchesModKey } from '../keymap'
import { Tooltip } from '../../ui/Tooltip'

/** Re-exported so the host (`VideoEditor`) can name the mode it resolves from
 *  the theme without reaching into `canvas/draw` — Timeline is the seam it
 *  already imports. */
export type { TimelineMode } from './canvas/draw'

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
  /** Unified selection — covers both visual items and audio tracks. Captions
   *  share this same array (D1) — a caption id is selected/moved/trimmed on
   *  the canvas timeline exactly like a clip or audio track. Caption editing
   *  UI itself (text, style, per-segment color) lives in the sidebar
   *  CaptionListPanel now, not in Timeline — see VideoEditor.tsx. */
  selectedIds?: string[]
  onSelectIds?: (ids: string[]) => void
  onInspectClip?: (id: string) => void
  onInspectAudio?: (id: string) => void
  /** Double-click on a caption block. Forwarded straight to
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
   * pointer and `onHoverScrub` reports the time under it.
   */
  previewAxis?: boolean
  /** The time under the pointer while the axis is on, null when it leaves.
   *  Fires per mousemove — VideoEditor routes it into an external store. */
  onHoverScrub?: (time: number | null) => void
  /** Resolves a waveform chunk's host path into a displayable URL. */
  resolveFilePath?: ResolveFilePath
  /** Zoom-bucketed peaks fetcher for the canvas timeline's waveforms (T6),
   *  threaded from `adapter.getWaveformPeaks`. Passed straight to
   *  `TimelineCanvas`. Absent → no waveforms anywhere (graceful). */
  getWaveformPeaks?: (args: GetWaveformPeaksArgs) => Promise<PeaksData>
  /** Filmstrip-index fetcher for the canvas timeline's tile strips + hover-
   *  scrub thumb (T7), threaded from `adapter.getFilmstrip`. Passed straight
   *  to `TimelineCanvas`. Absent → no filmstrips or thumbs anywhere
   *  (graceful). */
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
  /**
   * Which ground the timeline paints on, resolved from the host theme by
   * `VideoEditor` (`isLightTheme`). Threaded — not looked up here — so the
   * canvas surface, the track rail and the fade-shape icons can never disagree
   * about the mode: three independent lookups is three chances to drift.
   * Defaults to `'dark'`, the only mode this timeline had.
   */
  mode?: TimelineMode
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
function FadeCurveIcon({ curve, active, mode = 'dark' }: { curve: FadeCurve; active: boolean; mode?: TimelineMode }) {
  const { width: w, height: h } = FADE_CURVE_ICON_SIZE
  const points = fadeCurveIconPoints(curve, w - FADE_CURVE_ICON_PAD * 2, h - FADE_CURVE_ICON_PAD * 2)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  // The ACTIVE stroke is the real envelope line, taken from the same palette
  // the canvas paints the real fade with — the icon and the thing it sets have
  // to be the same colour or the picker stops being a preview. The inactive
  // pair is this icon's own: white-on-dark in dark mode, near-black-on-light
  // in light, matching the menu ground below (which flips with `mode` too).
  const colors = timelinePalette(mode).colors
  const idleFrame = mode === 'light' ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.15)'
  const idleCurve = mode === 'light' ? 'rgba(15,23,42,0.7)' : 'rgba(255,255,255,0.75)'
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="block">
      <rect
        x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3}
        fill="none"
        stroke={active ? colors.fadeEnvelopeLine : idleFrame}
        strokeWidth={1}
      />
      <path
        d={d}
        transform={`translate(${FADE_CURVE_ICON_PAD},${FADE_CURVE_ICON_PAD})`}
        fill="none"
        stroke={active ? colors.fadeEnvelopeLine : idleCurve}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Gap between a clip's right edge and the right edge of its HTML chrome, in
 *  CSS px. Derived from the trim handle's own grab width rather than picked, so
 *  the Scissors button can never cover the band a trim has to be started in —
 *  a button sitting on the last two pixels of the handle is a trim you can't
 *  begin, which is exactly the kind of overlap a magic number drifts into. */
export const CLIP_CHROME_RIGHT_PAD_PX = VISUAL_EDGE_TOLERANCE_PX + 2

/**
 * Per-clip HTML chrome pinned over the canvas timeline: the subcut-regenerate
 * Scissors button and the "queued" badge.
 *
 * ── Why HTML and not paint ───────────────────────────────────────────────
 * These two affordances lived on the DOM clip rows (`VisualTrackRow`). The
 * canvas draws clips as pixels, so there is no per-clip element to hang a
 * button off — and a real button is what a click target with a title, an
 * accessible name and a hover state wants to be. Adding a per-clip button
 * sub-zone to `hit-test.ts` (plus the tap-vs-drag disambiguation that implies)
 * is far more machinery than two pieces of chrome need, so instead each one is
 * an absolutely-positioned HTML node placed by the SAME layout + viewport math
 * the painter uses: `row.y`/`row.height` from `computeTimelineLayout`, and
 * `timeToX` for the item's span.
 *
 * ── Why it is a SIBLING of the canvas surface, not a child ───────────────
 * `TimelineCanvas` binds `mousedown` on its own container element, and a
 * mousedown there STARTS A GESTURE (scrub, drag or trim). A button nested
 * inside that container would therefore start a gesture underneath its own
 * click — and `onMouseDown={e => e.stopPropagation()}` cannot prevent it,
 * because React delegates synthetic events to its ROOT container: the
 * canvas' own native listener sits between the button and that root, so it
 * fires first and a synthetic handler is already too late. Stopping it would
 * mean an imperative native listener per button.
 *
 * Rendering the chrome OUTSIDE `[data-timeline-canvas]` removes the hazard by
 * construction — the canvas' listener is never on the propagation path at
 * all — and costs nothing in alignment: the chrome's positioning context is
 * the flex column that wraps the canvas and nothing else, whose content box is
 * exactly the surface's box (one `w-full` child with an explicit height). The
 * remaining bubble path is Timeline's own container click, which already
 * excludes `button` from its background-click handling.
 *
 * `position: absolute` (not the `fixed` + clientX/clientY snapshot the fade and
 * keyframe menus use) because this chrome is persistent: it has to stay pinned
 * to a clip that pans and rescales, not sit where a one-shot right-click
 * happened.
 */
function CanvasClipChrome({
  layout,
  viewportStore,
  selectedIds,
  regenEnabled,
  isClipQueued,
  subcutClipId,
  setSubcutClipId,
}: {
  layout: TimelineLayout
  viewportStore: ViewportStore
  selectedIds: string[]
  regenEnabled?: boolean
  isClipQueued?: (itemId: string) => boolean
  subcutClipId: string | null
  setSubcutClipId: (id: string | null) => void
}) {
  // Subscribed HERE, not lifted to Timeline's top level — see the "Why HTML
  // and not paint" note above this component. This chrome is the only thing
  // that needs a re-render when the viewport pans or zooms (it has to stay
  // pinned to a clip that just moved under it); isolating the subscription to
  // this component means a wheel-zoom frame re-renders ONLY this chrome, not
  // Timeline's whole subtree (`TimelineCanvas`, `TrackGutter`, `Scrubber`,
  // etc). Same isolation `CanvasZoomBadge` already uses in TimelineCanvas.tsx,
  // for the same reason.
  const viewport = useViewportValue(viewportStore)

  // Before the first layout pass there is no scale, so every clip would
  // collapse onto x=0 and the chrome would stack up in the corner.
  if (viewport.pxPerSecond <= 0) return null

  return (
    <>
      {layout.rows.flatMap(row => row.items.flatMap(item => {
        const isSel = selectedIds.includes(item.id)
        const queued = isClipQueued?.(item.id) === true
        // The gate, carried over verbatim from `VisualTrackRow`: the clip is
        // selected, the host has enabled regeneration for this project, the
        // clip still carries its frozen generation provenance, and it is long
        // enough to be worth cutting into sub-shots. Queued is a BADGE, not a
        // disable — a queued clip can be re-opened and re-submitted.
        const showSubcut = isSel && regenEnabled && item.generation && (item.end - item.start) >= 3
        if (!queued && !showSubcut) return []

        const x0 = timeToX(item.start, viewport)
        const x1 = timeToX(item.end, viewport)
        if (x1 <= 0 || x0 >= viewport.widthPx) return []   // scrolled off-surface
        // Right-anchored: the painter writes each clip's label along its LEFT
        // edge, so the right end is the free space. Clamped so a clip whose
        // end is off-surface keeps its chrome at the surface edge rather than
        // parking it out of view.
        const right = Math.max(CLIP_CHROME_RIGHT_PAD_PX, viewport.widthPx - x1 + CLIP_CHROME_RIGHT_PAD_PX)
        // A LEFT bound too, so the box is the clip's own span and
        // `overflow-hidden` can clip to it. The DOM clip rows got this for
        // free: their chrome sat inside a row element that was already
        // `overflow-hidden`. The canvas has no per-clip element to inherit
        // that from, so right-anchored chrome on a very narrow clip used to
        // overhang LEFTWARD past the clip's start and read as the
        // neighbouring clip's badge. Clamped at 0 the same way `right` is, so
        // a clip whose start is off-surface keeps its box on the surface.
        // Content is right-aligned, so a box too narrow for both clips the
        // badge off (it is leftmost) and keeps the button.
        const left = Math.max(0, x0)

        return [(
          <div
            key={item.id}
            className="pointer-events-none absolute z-20 flex items-center justify-end gap-1 overflow-hidden"
            style={{ top: row.y, height: row.height, left, right }}
          >
            {/* Deliberately dark in BOTH modes, not `--editor-*` driven — same
                reasoning as the preview staying black and the canvas' own
                clip labels: this chip sits over the CLIP's pixels (arbitrary
                video/filmstrip content), not over editor chrome, so what it
                has to contrast against is footage brightness, not the host's
                light/dark setting. A dark plate at 70% opacity reliably shows
                its light foreground over footage of any brightness; flipping
                it to a light plate in a light editor theme would remove that
                guarantee for no benefit, since the editor's theme has no
                relationship to what's playing under it. Do not "fix" this to
                use `--editor-surface`. */}
            {queued && (
              <span className="rounded bg-gray-900/70 px-1 text-[10px] font-medium text-amber-300/80">queued</span>
            )}
            {showSubcut && (
              <button
                type="button"
                className="pointer-events-auto cursor-pointer rounded bg-gray-900/70 p-0.5 text-gray-200 opacity-50 transition-opacity hover:opacity-100"
                title="Subcut regenerate"
                aria-label="Subcut regenerate"
                onClick={(e) => { e.stopPropagation(); setSubcutClipId(subcutClipId === item.id ? null : item.id) }}
              ><Scissors size={10} /></button>
            )}
          </div>
        )]
      }))}
    </>
  )
}

/** Human-readable labels for `EASING_NAMES` (@bycrux/timeline-core) — the
 *  keyframe-strip easing picker's six buttons. Kept as a plain lookup rather
 *  than a formatter, since 'ease-in-out' has no mechanical rule that reads
 *  better than a name written out by hand. */
const EASING_LABELS: Record<EasingName, string> = {
  linear: 'Linear',
  ease: 'Ease',
  'ease-in': 'Ease In',
  'ease-out': 'Ease Out',
  'ease-in-out': 'Ease In Out',
  hold: 'Hold',
}

export default function Timeline({ project, clock, onProjectChange, onOverlayEdit, selectedIds = [], onSelectIds, onInspectClip, onInspectAudio, onEditCaption, rippleMode = false, previewAxis = false, onHoverScrub, resolveFilePath, getWaveformPeaks, getFilmstrip, regenEnabled, isClipQueued, renderSubcutRegen, modalOpen = false, onOpenGoToTime, actionsRef, mode = 'dark' }: TimelineProps) {

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

  /**
   * The keyframe-strip popup (SP9b T3.3) — `fadeCurveMenu`'s exact sibling: a
   * small DOM menu that opens on a RIGHT-CLICK of a keyframe-strip diamond
   * (`TimelineCanvas`'s `contextMenu` handler, the only caller of
   * `setKeyframeMenu`). `x`/`y` are CLIENT coordinates for the same
   * `position: fixed` reason. `props` is every keyframe track that has a
   * point at `t` — a diamond can represent several props sharing one instant
   * (the "union of times" the strip draws — see `keyframe-strip.ts`) — so
   * every action below applies to ALL of them at once. `isLast` is true when
   * `t` is the item's LAST keyframe: its easing has no next keyframe to
   * reach, so the picker below disables (not hides) those six buttons then.
   */
  const [keyframeMenu, setKeyframeMenu] = useState<{ itemId: string; t: number; props: KeyframeProp[]; isLast: boolean; x: number; y: number } | null>(null)

  /**
   * The selected keyframe diamond, or null. Kind-agnostic: a diamond is a
   * TIME on an item, so the props at that time are derived when acted on
   * rather than stored here. Lives in Timeline rather than `VideoEditor`
   * because every clearing trigger is already visible here and nothing
   * outside the timeline consumes it.
   */
  const [selectedKeyframe, setSelectedKeyframe] = useState<KeyframeSelection | null>(null)

  // Clear when the owning item stops being selected. A keyframe selection is
  // meaningless without its item selected — the strip is not even drawn then
  // (draw.ts gates on selection), so a stale selection would be invisible and
  // still armed for Delete.
  useEffect(() => {
    if (selectedKeyframe && !selectedIds.includes(selectedKeyframe.itemId)) setSelectedKeyframe(null)
  }, [selectedIds, selectedKeyframe])

  /**
   * Whole-item edit, for an op that derives its own affected props (unlike
   * `applyToKeyframedItem` below, which threads a function per prop) — e.g.
   * `removeKeyframesAt`, which decides itself which prop tracks have a point
   * at `t`. Same commit shape as `applyToKeyframedItem`: one `onProjectChange`
   * + one `onOverlayEdit` = one undo entry. Skips the commit entirely when
   * `fn` returns the SAME item reference (no prop actually had anything to
   * change) — `removeKeyframesAt`'s reference-equality no-op — so a Delete
   * that couldn't find its keyframe never spends an undo entry on nothing.
   */
  function applyToItem(itemId: string, fn: (item: VisualItem) => VisualItem) {
    setKeyframeMenu(null)
    if (!onProjectChange) return
    let changed = false
    const tracks = mapTrackItems(project, items => items.map(item => {
      if (item.id !== itemId) return item
      const next = fn(item)
      if (next !== item) changed = true
      return next
    }))
    if (!changed) return
    const next = { ...project, tracks } as Project
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  /**
   * Apply `fn` to every prop the diamond at `t` represents, on the item
   * `itemId`, as ONE commit — same shape as `handleSetFadeCurve` above: a
   * discrete, one-shot pick, so `onProjectChange` + `onOverlayEdit` fire
   * together as a single undo entry. Routes through `mapTrackItems`, the
   * SAME item-patch mechanism the canvas pointer machine's own keyframe-drag
   * gesture uses (`pointer-machine.ts`'s `replaceVisualItem`) — no second
   * persistence path for keyframe edits.
   */
  function applyToKeyframedItem(itemId: string, props: KeyframeProp[], fn: (prop: KeyframeProp) => (item: VisualItem) => VisualItem) {
    setKeyframeMenu(null)
    if (!onProjectChange) return
    const tracks = mapTrackItems(project, items => items.map(item => {
      if (item.id !== itemId) return item
      let next = item
      for (const prop of props) next = fn(prop)(next)
      return next
    }))
    const next = { ...project, tracks } as Project
    onProjectChange(next)
    onOverlayEdit?.(next)
  }

  function handleRemoveKeyframe(itemId: string, t: number) {
    // Clearing rule 2 (plan Task 3): the keyframe is gone, so the selection
    // naming it must go too — the menu is the OTHER route to the same removal
    // the Delete binding performs, and the two must not disagree.
    if (selectedKeyframe && selectedKeyframe.itemId === itemId && selectedKeyframe.t === t) setSelectedKeyframe(null)
    applyToItem(itemId, item => removeKeyframesAt(item, t))
  }

  function handleSetKeyframeEasing(itemId: string, t: number, props: KeyframeProp[], easing: EasingName) {
    applyToKeyframedItem(itemId, props, prop => item => setKeyframeEasing(item, prop, t, easing))
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

  // The tabIndex={0} root below — Delete/Enter's guards below check focus is
  // inside it before firing (see the useKeymap block), restoring the pre-T9
  // scoping those two bindings had (arrows/Escape were already document-level
  // pre-SP5 and stay that way — see the useKeymap block's own comment).
  const rootRef                               = useRef<HTMLDivElement>(null)

  const [subcutClipId, setSubcutClipId]       = useState<string | null>(null)

  const { scrollRef } = useTimelineZoom()

  // ── Zoom chrome ──
  // The canvas surface pans/zooms a px-per-second viewport; these three
  // buttons drive it through `useCanvasZoomControls`. This used to be an
  // adapter over two zoom models (the retired DOM rows zoomed a scroll
  // container by a multiplier instead) — there is only the one now.
  const viewportStore = useViewportStore()
  const zoomControls: ZoomControls = useCanvasZoomControls(viewportStore, totalDuration)

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
    // Cmd/Ctrl+Arrow jump-to-start/end. `matchesArrowLeft`/`matchesArrowRight`
    // (keymap.ts's `matchesKey`) don't exclude modifiers, so a mod+arrow chord
    // matches BOTH these bindings AND `timeline.frame-step` below — these two
    // are listed FIRST so first-match-wins picks the jump, not a frame step
    // (same precedence pattern documented on `matchesModAltKey` in keymap.ts).
    {
      id: 'timeline.jump-start',
      description: 'Jump to start',
      matches: matchesModKey('ArrowLeft'),
      guard: () => totalDuration > 0,
      action: () => {
        clock.set(0)
      },
    },
    {
      id: 'timeline.jump-end',
      description: 'Jump to end',
      matches: matchesModKey('ArrowRight'),
      guard: () => totalDuration > 0,
      // `contentDuration` is the furthest item's end (max across every clip/
      // overlay/audio track) — NOT `totalDuration`, which pads content with
      // scroll/drop headroom (see computeDerivedTiming in timeline-model.ts).
      // The jump belongs at the last real element, not into that headroom.
      action: () => {
        clock.set(contentDuration)
      },
    },
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
      },
    },
    {
      id: 'timeline.delete-keyframe',
      description: 'Delete selected keyframe',
      matches: matchesDelete,
      // Ordered BEFORE `timeline.delete-selection` and guarded on a keyframe
      // actually being selected: useKeymap is first-match-wins (keymap.ts:80-86),
      // so with no keyframe selected this falls straight through to clip
      // deletion. The focus scope matches the binding below it exactly — a
      // Delete typed outside the timeline must not reach either.
      guard: () => {
        if (!selectedKeyframe || !rootRef.current?.contains(document.activeElement)) return false
        // A selection can go stale WITHOUT its item leaving `selectedIds`:
        // dragging the diamond retimes it, the right-click menu removes it,
        // undo rewinds it, a split moves it to the other half. `drawKeyframeStrip`
        // matches on `t`, so nothing draws as selected then — and Delete must do
        // what the operator SEES (delete the clip) rather than swallow the press
        // on a keyframe that no longer exists.
        const item = trackItems(project).flat().find(i => i.id === selectedKeyframe.itemId)
        return !!item && keyframeUnionTimes(item).includes(selectedKeyframe.t)
      },
      action: () => {
        if (!selectedKeyframe) return
        const { itemId, t } = selectedKeyframe
        setSelectedKeyframe(null)
        applyToItem(itemId, item => removeKeyframesAt(item, t))
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

  // `fadeCurveMenu`'s Escape handling, sibling for sibling.
  useEffect(() => {
    if (!keyframeMenu) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setKeyframeMenu(null) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [keyframeMenu])

  // Hand the zoom action up to a host-level command palette.
  useEffect(() => {
    if (!actionsRef) return
    actionsRef.current = { zoomFit: zoomControls.fit }
    return () => { actionsRef.current = null }
  })

  // Same layout the canvas paints from, so the rail's rows line up with the
  // clips exactly rather than by two independent calculations agreeing.
  const canvasLayout = useMemo(() => computeTimelineLayout(project), [project.tracks, project.audio, project.captions])

  const ctx = useMemo<TimelineContextValue>(() => ({
    contentDuration, clock,
  }), [contentDuration, clock])

  /**
   * Clicks that land on the timeline column but not on any row: the readout
   * strip above the tracks, the gaps between rows, the space under the last
   * one. They are background, and background belongs to the timeline — not
   * dead chrome.
   *
   * This reads the canvas' own x-axis — the only time axis there is now that
   * the scrubber's overview bar is gone — so a background click does exactly
   * what pressing bare canvas does: clear the selection, and seek to the
   * clicked time. Clicks to the left of the canvas (over the track rail,
   * which has no time axis) clear the selection without seeking. The canvas
   * surface itself stops propagation — the pointer machine has already seeked
   * on mousedown — so nothing here double-handles a real timeline click.
   *
   * `pointer-events` note: the controls in the strip (zoom buttons, the go-to
   * time readout) are excluded by the `closest` test below, so isolating them
   * costs nothing beyond it.
   */
  function handleContainerClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button, input, [contenteditable], [data-timeline-chrome]')) return
    if (totalDuration === 0) return

    // Same order the pointer machine emits its effects in for a press on
    // bare canvas: clear the selection, then seek.
    handleSelectItem(null, false)
    const surface = rootRef.current?.querySelector('[data-timeline-canvas]')
    if (!surface) return
    const surfaceRect = surface.getBoundingClientRect()
    const x = e.clientX - surfaceRect.left
    if (x < 0 || x > surfaceRect.width) return   // over the rail — no time here
    // `.get()`, not a subscription: this is an event handler, not something
    // that renders, and `get()` is the more correct read anyway — mid-pan the
    // last value React committed can lag a frame behind the store.
    clock.set(Math.max(0, Math.min(totalDuration, xToTime(x, viewportStore.get()))))
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
      onClick={handleContainerClick}
    >

      {/* Zoom controls */}
      {totalDuration > 0 && (
        <div className="flex items-center justify-end gap-0.5 -mb-1 cursor-pointer">
          <Tooltip label="Zoom out">
            <button
              className="text-[11px] leading-none text-[var(--editor-text)]/45 hover:text-[var(--editor-text)]/80 w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--editor-text)]/10 transition-colors"
              aria-label="Zoom out"
              onClick={(e) => { e.stopPropagation(); zoomControls.zoomOut() }}
            >−</button>
          </Tooltip>
          {zoomControls.badge}
          <Tooltip label="Zoom in">
            <button
              className="text-[11px] leading-none text-[var(--editor-text)]/45 hover:text-[var(--editor-text)]/80 w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--editor-text)]/10 transition-colors"
              aria-label="Zoom in"
              onClick={(e) => { e.stopPropagation(); zoomControls.zoomIn() }}
            >+</button>
          </Tooltip>
          {zoomControls.showFit && (
            <Tooltip label="Fit to view" className="ml-0.5">
              <button
                className="text-[10px] text-[var(--editor-text)]/45 hover:text-[var(--editor-text)]/80 px-1.5 h-5 rounded hover:bg-[var(--editor-text)]/10 transition-colors"
                aria-label="Fit to view"
                onClick={(e) => { e.stopPropagation(); zoomControls.fit() }}
              >fit</button>
            </Tooltip>
          )}
        </div>
      )}

      {/* Horizontal overflow guard. This used to be a zoom viewport: the DOM
          rows were laid out as percentages of the whole project, so zooming
          meant widening an inner div to `zoom × 100%` and scrolling this
          container over it. The canvas surface zooms its own px-per-second
          viewport instead and always fits the width it is given, so nothing
          in here is ever wider than the pane — this stays only as the guard
          that keeps an unexpectedly wide child from stretching the page. */}
      <div ref={scrollRef} className="overflow-x-auto">

      {/* Readout strip + tracks, wrapped in a relative container */}
      <div className="relative flex flex-col gap-2">

      <Scrubber onOpenGoToTime={onOpenGoToTime} />

      {/* ── Tracks ── */}
      <div className="flex flex-col gap-1">
        {project.renderMode === 'ffmpeg-drawtext' && (
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] select-none ${mode === 'light' ? 'bg-amber-50 border border-amber-300 text-amber-800' : 'bg-amber-500/10 border border-amber-500/20 text-amber-400/70'}`}>
            <span>⚡</span>
            <span>ffmpeg render — overlays are preview only, final text is burned by ffmpeg</span>
          </div>
        )}
        {/* The gutter is a sibling COLUMN, not an overlay: it takes width from
            the canvas (which measures its own container) instead of painting
            over the clips at t=0. Captions have their own row PAINTED inside
            `TimelineCanvas` below, not a separate DOM element — the gutter's
            own caption cell is sized from the same layout (`canvasLayout`) so
            the two line up. `showCaptionRow` is left at its default (true)
            here: `TrackGutter` already gates the cell on `resolved.captions`,
            which `computeTimelineLayout` only sets when there ARE captions,
            so passing `!!captionTrack?.segments?.length` on top can never
            change the outcome — it exists as a host knob for other callers,
            not for this one. */}
        <div className="flex gap-1">
            <TrackGutter
              project={project}
              layout={canvasLayout}
              mode={mode}
              onToggleTrackEnabled={handleToggleTrackEnabled}
              onSetTrackVolume={handleSetTrackVolume}
              onSetTrackMuted={handleSetTrackMuted}
              onApplySpeed={handleApplyTrackSpeed}
              onSetLaneVolume={handleSetLaneVolume}
              onSetLaneMuted={handleSetLaneMuted}
              onSetLaneMagnet={handleSetLaneMagnet}
            />
            {/* `relative` makes this column the positioning context for the
                per-clip HTML chrome below — see `CanvasClipChrome`. It holds
                exactly one in-flow child (the canvas surface, `w-full` with an
                explicit height), so its content box IS that surface's box and
                the chrome lands on the same pixels the painter does. */}
            <div className="relative flex min-w-0 flex-1 flex-col gap-1">
            {/* ── Canvas track-row area — one surface carrying the visual
                tracks, audio lanes and caption rows. It owns its own
                zoom/scroll (px-per-second), so the readout strip above it
                stays a whole-project readout rather than tracking canvas
                zoom. ── */}
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
              selectedKeyframe={selectedKeyframe}
              onSelectKeyframe={setSelectedKeyframe}
              onProjectChange={onProjectChange}
              onOverlayEdit={onOverlayEdit}
              onInspectClip={onInspectClip}
              onInspectAudio={onInspectAudio}
              onEditCaption={onEditCaption}
              onFadeCurveMenu={setFadeCurveMenu}
              onKeyframeMenu={setKeyframeMenu}
              getWaveformPeaks={getWaveformPeaks}
              getFilmstrip={getFilmstrip}
              resolveFilePath={resolveFilePath}
              mode={mode}
            />
            {/* ── Per-clip HTML chrome over the canvas ──
                The subcut-regenerate trigger and the "queued" badge, ported
                from the DOM clip rows. Passed the STORE, not a subscribed
                value: unlike the canvas itself, which reads `store.get()`
                inside its draw to avoid re-rendering, this chrome IS a DOM
                node that has to be re-laid-out by React on every viewport
                change or it detaches from its clip the moment you pan or
                zoom — so it subscribes internally, isolated to itself, the
                same way `CanvasZoomBadge` isolates its own subscription in
                TimelineCanvas.tsx. That isolation is the whole point: it
                keeps a wheel-zoom frame from re-rendering Timeline's entire
                subtree (this chrome does NOT share a subscription with the
                zoom badge — each owns its own). */}
            <CanvasClipChrome
              layout={canvasLayout}
              viewportStore={viewportStore}
              selectedIds={selectedIds}
              regenEnabled={regenEnabled}
              isClipQueued={isClipQueued}
              subcutClipId={subcutClipId}
              setSubcutClipId={setSubcutClipId}
            />
            </div>
        </div>

      </div>

      </div>{/* end scrubber+tracks wrapper */}
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

      {/* ── Fade-shape picker — right-click a fade grip (see
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
              /* Written per mode rather than through `--editor-*` tokens: the
                 dark branch is the exact class list this menu has always had,
                 so a light theme gains a light popover without the dark one
                 shifting by a single hairline. */
              className={`fixed z-50 flex gap-1 rounded border p-1 shadow-xl ${mode === 'light' ? 'border-gray-300 bg-white' : 'border-gray-700 bg-gray-900'}`}
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
                  className={`rounded p-0.5 transition-colors ${
                    activeCurve === curve
                      ? (mode === 'light' ? 'bg-gray-200 ring-1 ring-emerald-600/60' : 'bg-gray-700 ring-1 ring-emerald-400/60')
                      : (mode === 'light' ? 'hover:bg-gray-100' : 'hover:bg-gray-800')
                  }`}
                  onClick={() => handleSetFadeCurve(fadeCurveMenu.trackId, fadeCurveMenu.side, curve)}
                >
                  <FadeCurveIcon curve={curve} active={activeCurve === curve} mode={mode} />
                </button>
              ))}
            </div>
          </>
        )
      })()}

      {/* ── Keyframe-strip popup (SP9b T3.3) — right-click a keyframe diamond
          (see `TimelineCanvas`'s `contextMenu` handler). The
          fade-shape picker's exact sibling: same `fixed`-positioned menu at
          the CLIENT coordinates the diamond was clicked at, same full-surface
          dismiss-on-outside-interaction backdrop. Two sections: the six
          EASING_NAMES (labelled "Easing to next keyframe" — easing is
          OUTGOING, see `Keyframe.easing`'s doc in schema.ts, so this is the
          one place that direction has to be said out loud or a user authors
          the wrong curve) and, always available regardless of `isLast`, the
          keyframe's own removal. */}
      {keyframeMenu && (() => {
        const item = trackItems(project).flat().find(i => i.id === keyframeMenu.itemId)
        const easingAt = (prop: KeyframeProp): EasingName => {
          const track = item?.keyframes?.find(kt => kt.prop === prop)
          return track?.points.find(p => p.t === keyframeMenu.t)?.easing ?? 'linear'
        }
        const easings = keyframeMenu.props.map(easingAt)
        const activeEasing: EasingName | null = easings.length > 0 && easings.every(e => e === easings[0]) ? easings[0] : null
        return (
          <>
            <div
              data-timeline-chrome
              data-testid="keyframe-menu-backdrop"
              className="fixed inset-0 z-40"
              onClick={() => setKeyframeMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setKeyframeMenu(null) }}
            />
            <div
              data-timeline-chrome
              /* `fadeCurveMenu`'s exact sibling (see that menu's own comment
                 below) — mode-conditional per class rather than through
                 `--editor-*` tokens, so the dark branch is the exact class
                 list this menu has always had and a light theme gains a
                 light popover without the dark one shifting by a hairline. */
              className={`fixed z-50 flex flex-col gap-1.5 rounded border p-2 shadow-xl ${mode === 'light' ? 'border-gray-300 bg-white' : 'border-gray-700 bg-gray-900'}`}
              style={{ left: keyframeMenu.x, top: keyframeMenu.y }}
            >
              <div className={`px-0.5 text-[10px] ${mode === 'light' ? 'text-gray-600' : 'text-gray-500'}`}>Easing to next keyframe</div>
              <div className="flex flex-wrap gap-1 max-w-[220px]">
                {EASING_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    title={keyframeMenu.isLast ? 'No next keyframe' : EASING_LABELS[name]}
                    aria-label={EASING_LABELS[name]}
                    aria-pressed={activeEasing === name}
                    disabled={keyframeMenu.isLast}
                    className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                      keyframeMenu.isLast
                        ? (mode === 'light' ? 'text-gray-400 cursor-not-allowed' : 'text-gray-600 cursor-not-allowed')
                        : activeEasing === name
                          ? (mode === 'light' ? 'bg-gray-200 text-gray-900 ring-1 ring-emerald-600/60' : 'bg-gray-700 text-gray-100 ring-1 ring-emerald-400/60')
                          : (mode === 'light' ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-800')
                    }`}
                    onClick={() => handleSetKeyframeEasing(keyframeMenu.itemId, keyframeMenu.t, keyframeMenu.props, name)}
                  >
                    {EASING_LABELS[name]}
                  </button>
                ))}
              </div>
              <div className={`h-px ${mode === 'light' ? 'bg-gray-200' : 'bg-gray-700'}`} />
              <button
                type="button"
                className={`rounded px-1.5 py-1 text-left text-[11px] hover:bg-red-500/10 ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}
                onClick={() => handleRemoveKeyframe(keyframeMenu.itemId, keyframeMenu.t)}
              >
                Remove keyframe
              </button>
            </div>
          </>
        )
      })()}

    </div>
    </TimelineContext.Provider>
  )
}
