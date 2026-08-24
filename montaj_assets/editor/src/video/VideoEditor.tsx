import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Captions, Crop, Ear, EarOff, Film, HelpCircle, History, Magnet, Maximize2, Minimize2, Pencil, Redo2, SeparatorVertical, Smartphone, Undo2, Wand2 } from 'lucide-react'
import type { Project, VideoEditorProps } from '../types'
import type { AudioTrack, VisualItem } from '../schema'
import { useProjectSync, type UseProjectSync } from '../state/use-project-sync'
import { VideoSourceCropModal } from '../crop/VideoSourceCropModal'
import ControlsInfoModal, { VIDEO_CONTROLS } from '../ControlsInfoModal'
import { Tooltip } from '../ui/Tooltip'
import { reviveNumberInRange, usePersistentState } from '../ui/usePersistentState'
import { getOverlayDesignCanvas } from './design-canvas'
import { availableResolutionTiers, availableFpsTiers, currentResolutionTier, maxExportFps } from './export-limits'
import { applyTheme, defaultMontajTheme } from '../theme'
import { collapseGaps, rippleDelete, splitAtTime } from './cuts'
import { repairCaptionWords } from './captionRepair'
import { maxCaptionLane, normalizeCaptionLanes } from './captionLanes'
import Timeline, { type TimelineActions } from './timeline/Timeline'
import { computeAutoCrossfade, computeDerivedTiming, enabledTrackItems, mapTrackItems, trackItems } from './timeline/timeline-model'
import { makeCaptionEdit, type CaptionEditPatch } from './timeline/makeCaptionEdit'
import PreviewPlayer, { type TransportHandle, type ScrubHandle } from './preview/PreviewPlayer'
import SocialPreviewMenu, { PlatformGlyph, platformOption } from './preview/SocialPreviewMenu'
import type { SocialPreviewPlatform } from './preview/SocialSafeZoneOverlay'
import { createPlaybackClock, usePlaybackTime, type PlaybackClock } from './playback-clock'
import { createHoverScrub } from './hover-scrub'
import { createScrubSource, type ScrubSource } from '../engine/scrub-source'
import { createScrubResolver } from '../engine/scrub-resolve'
import { useSourcePreview, type SourcePreviewStore } from './source-preview'
import { formatTimecode } from './timecode'
import type { OverlayChanges } from './preview/useDragOverlay'
import VersionPanel, { listVersions } from './VersionPanel'
import OverlayInspector from './OverlayInspector'
import LeftPanelTabs, { type LeftPanelTab } from './panels/LeftPanelTabs'
import ClipPropertiesPanel, { type ClipSelection } from './panels/ClipPropertiesPanel'
import VersionCompare from './VersionCompare'
import CaptionListPanel, { type CaptionListPanelProps, type CaptionEditFocusRequest, nextEditFocus } from './CaptionListPanel'
import RenderModal from './RenderModal'
import ImageToneMenu from './ImageToneMenu'
import type { ImageTone } from './imageTone'
import CaptionRegenModal from './CaptionRegenModal'
import AudioPolishModal from './AudioPolishModal'
import OverlayPropsModal from './preview/OverlayPropsModal'
import CommandPalette, { type PaletteCommand } from './CommandPalette'
import { createShuttleController } from './shuttle'
import { useKeymap, matchesKey, matchesModAltKey, matchesModKey, matchesPlainKey, matchesRedo, matchesShiftDelete, matchesUndo } from './keymap'
import { useReportContext } from './use-report-context'
import { copySelection, duplicateSelection, pasteAt, pasteAttributes, type ClipboardPayload } from './clipboard-ops'

// ── Layout preferences ───────────────────────────────────────────────────
// Persisted per browser (not per project): how tall the timeline pane is, and
// whether the caption row is shown. Keys are namespaced so they can't collide
// with a host's own localStorage.

const TIMELINE_PANE_STORAGE_KEY = 'montaj.editor.timelinePaneHeight'
/** Starting height of the timeline pane — roughly the base track, one overlay
 *  row, an audio lane and the caption row, which is what the fixed layout used
 *  to come out at. */
const DEFAULT_TIMELINE_PANE_PX = 300
/** Floor: the toolbar plus enough of the scrubber to still aim at. Below this
 *  the pane stops being a timeline. */
const MIN_TIMELINE_PANE_PX = 140
/** Ceiling, so a stored height from a much taller window can't open the editor
 *  with the preview pushed off-screen. */
const MAX_TIMELINE_PANE_PX = 1200
/** Always left to the preview, so the divider can never strand the picture at
 *  zero height. */
const MIN_PREVIEW_PANE_PX = 160

const RAIL_WIDTH_STORAGE_KEY = 'montaj.editor.railWidth'
/** Floor/ceiling for the right rail, and the width always left to the editor
 *  beside it — the vertical counterpart of the timeline pane's clamps. */
const MIN_RAIL_PX = 150
const MAX_RAIL_PX = 720
/** Default/reset rail width, wide enough for the sidebar CaptionListPanel's
 *  list and controls (previously 224 in 'sidebar' placement, 192 elsewhere —
 *  now one shared default across placements). */
const DEFAULT_RAIL_PX = 300
const MIN_MAIN_PX = 320

// ── CapCut media-panel width (opt-in via slots.mediaPanel) ─────────────────
// The left media column's width, mirroring the right rail on the same axis.
// Only consulted by the CapCut layout branch; classic layouts never read it.
const MEDIA_PANEL_WIDTH_STORAGE_KEY = 'montaj.editor.mediaPanelWidth'
/** Default matches today's `w-72` assets column so the switch feels familiar. */
const DEFAULT_MEDIA_PANEL_PX = 288
const MIN_MEDIA_PANEL_PX = 200
const MAX_MEDIA_PANEL_PX = 640

// Generic over the host's concrete project type `P` (default = the package's
// own `Project`). Montaj passes its richer Project; the index signature on
// EditorProject absorbs host-only pipeline fields so a full host Project
// round-trips through edit→save (and `onProjectChange`) without casts.
type Props<P extends Project = Project> = VideoEditorProps<P>

// Fills in a stable `cap-<n>` id for any caption segment that doesn't already
// have one (id was added to the schema after captions already existed on saved
// projects, and `steps/lyrics/caption.py` still writes segments without one).
// Never overwrites an existing id.
//
// Ids are minted against the ids already in use, NOT from the array index. A
// track can hold a mix of already-backfilled segments and fresh id-less ones —
// caption regeneration produces exactly that — so a literal `cap-1` sitting at
// index 4 would make an index-derived mint hand out `cap-1` a second time. Ids
// are the selection key for the preview drag and the timeline caption row, so a
// duplicate means clicking one segment highlights and moves a different one.
// The counter only ever moves forward, so the result is deterministic (a pure
// function of the input segments) and, for the common all-id-less track, is
// still exactly `cap-<index>`.
//
// Returns the same project reference when every segment already has an id, so
// callers can skip applying a no-op update — the property the backfill effect's
// loop-safety rests on.
export function backfillCaptionIds<P extends Project>(project: P): P {
  const captions = project.captions
  if (!captions) return project
  const { segments } = captions
  if (!segments.length || segments.every((seg) => seg.id)) return project

  const used = new Set(segments.map((seg) => seg.id).filter((id): id is string => !!id))
  let counter = 0
  const mint = () => {
    let id = `cap-${counter++}`
    while (used.has(id)) id = `cap-${counter++}`
    used.add(id)
    return id
  }

  return {
    ...project,
    captions: { ...captions, segments: segments.map((seg) => (seg.id ? seg : { ...seg, id: mint() })) },
  }
}

/**
 * `<VideoEditor>` — the assembled, host-agnostic video editor.
 *
 * Absorbs Montaj's former LiveView (pending/processing surface) and ReviewView
 * (draft/final surface) into one component driven by the `EditorAdapter`.
 * Controlled like `<CarouselEditor>`: the host owns the initial `project` and is
 * notified of edits via `onProjectChange`; persistence flows through the shared
 * `useProjectSync` core (queued saves, SSE echo protection, undo/redo).
 *
 * The sync core is created ONCE here (not per-surface) so it owns a single SSE
 * subscription and so `sync.project.status` drives the Pending↔Review switch —
 * the editor now subscribes to live frames itself instead of receiving them as a
 * prop, so a status transition (agent finishes → 'draft') must come from the
 * core's own stream, not the host re-rendering with a new prop.
 *
 * ProjectHeader is lifted out (the host renders it in its shell). This component
 * renders: timeline + preview + version panel + render modal + the host-supplied
 * inspector/subcut render-prop seams + an optional back-to-setup affordance.
 */
export default function VideoEditor<P extends Project = Project>({
  project,
  adapter,
  onProjectChange,
  theme,
  slots,
  onBackToSetup,
  assetsPlacement = 'right',
  renderProgressView = 'phases',
  renderGenerationPanel,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
  onProvideRenderTrigger,
  onProvideImageTone,
  engine,
  sourcePreview,
}: Props<P>) {
  const emit = onProjectChange ?? (() => {})

  // Shared save/undo/SSE core. Created once at the top so there is exactly one
  // subscription per editor and `sync.project` is the single source of truth for
  // both the surface switch and the surface contents. `project` (the prop) is
  // only the initial value — after mount the core owns state and reconciles live
  // frames itself (video-shaped → default plain-replace reconcile).
  const sync = useProjectSync<P>(adapter, project.id, project)

  // Set for the duration of a caption drag gesture (ReviewSurface's
  // `handleProjectChange` → `commitTimelineEdit`), read by the lane-
  // normalization effect just below. A cross-row drag deliberately leaves a
  // HOLE lane open for the whole gesture (pointer-machine.ts normalizes only
  // at commit, so the vacated lane's band stays visible as a drop target and
  // the timeline doesn't jump under the pointer). Every `handleProjectChange`
  // frame is a fresh `mutateTransient` call, which gives `captions` a new
  // identity each mousemove — without this flag the effect below would see
  // that hole on the very first move and call `sync.applyExternal`, which
  // clears the sync core's transient baseline (`use-project-sync.ts`) and
  // costs the whole gesture its single undo entry (`commitTimelineEdit`
  // would then re-seed the baseline from the already-moved mid-drag state).
  // A ref, not state: this must be readable synchronously inside the same
  // handlers that flip it, with no re-render in between.
  const captionGestureRef = useRef(false)

  // Every caption segment needs a stable `id` for selection (preview drag,
  // clickable timeline row). Segments saved before `id` existed on the schema
  // are missing it, and `steps/lyrics/caption.py` still writes segments without
  // one, so backfill `cap-<index>` whenever the caption track changes identity.
  //
  // Keyed on `sync.project.id` AND `sync.project.captions` so it covers every
  // entry point a caption track reaches state through:
  //   - the `initial` value seeded into useProjectSync's reducer above (only
  //     consulted on this component's first mount — React ignores later changes
  //     to a useReducer initial arg);
  //   - a same-mounted-instance swap to a different project id, which arrives
  //     via the SSE subscription's `applyExternal` (e.g. client-side navigation
  //     between two projects without VideoEditor unmounting);
  //   - a caption REGENERATION inside a live session (CaptionRegenModal →
  //     applyExternal with a whole new, id-less `captions` object). The project
  //     id does not change there, so an id-keyed effect would not re-fire and
  //     every segment would silently become unselectable.
  //
  // Loop-proof: `backfillCaptionIds` returns the *same* project reference when
  // every segment already has an id, so the pass that follows our own
  // `applyExternal` (which necessarily produces a new `captions` reference, and
  // therefore re-fires this effect exactly once) finds nothing to do and stops.
  // Every other re-fire — one per caption edit — is a cheap `.every()` no-op.
  //
  // The SECOND pass in the same effect is caption LANES. A project.json can
  // arrive with sparse or hand-authored lanes (`lane: 7` on the only segment
  // that has one, written by an agent or edited by hand), and every reader
  // downstream — the bands the painter emits, the row the hit-test addresses,
  // the fan-out a cross-row drag searches — assumes lanes are dense from 0. So
  // normalize on load: `lane: 7` opens as row 1, not as eight rows of mostly
  // nothing. `normalizeCaptionLanes` honours the same same-reference contract
  // as `backfillCaptionIds`, so it is loop-proof for the same reason.
  //
  // Both passes share ONE effect, and the lane pass reads the BACKFILLED
  // project rather than `sync.project`, on purpose: two effects with the same
  // deps both close over the same pre-effect `sync.project`, so the second
  // `applyExternal` of a commit lands a project derived from the state as it
  // was BEFORE the first one and drops the ids the backfill just minted. It
  // recovers on the next pass (the effect re-fires and re-mints), but only
  // after publishing a half-normalized project to the host through
  // `onProjectChange` and paying an extra render for it. Chained, the host only
  // ever sees the input or the finished result.
  //
  // `applyExternal` — no save, no undo push: this is normalization of loaded
  // data, not a user edit, so it must not dirty the project or contend with the
  // undo stack; the ids and lanes persist naturally the next time the operator
  // makes a real edit.
  useEffect(() => {
    const backfilled = backfillCaptionIds(sync.project)
    // Lane normalization is for captions ARRIVING from outside (mount, SSE, regen,
    // a hand-authored project.json) -- never for a mid-gesture transient frame. A
    // cross-row drag deliberately leaves a HOLE lane open for the whole gesture
    // (pointer-machine normalizes at commit), and `applyExternal` clears the sync
    // core's transient baseline, which would cost the gesture its single undo entry.
    const captions = captionGestureRef.current
      ? backfilled.captions
      : normalizeCaptionLanes(backfilled.captions)
    const normalized = captions === backfilled.captions ? backfilled : { ...backfilled, captions }
    if (normalized !== sync.project) sync.applyExternal(normalized)
  }, [sync.project.id, sync.project.captions])

  // Notify the host of every authoritative change — edits, undo/redo, and SSE
  // frames — so its non-editor chrome (title, status pill) stays in sync. Mirrors
  // CarouselEditor. `emit` is read via a ref so the effect only fires on state
  // change, not when the host passes a new `onProjectChange` identity.
  const emitRef = useRef(emit)
  emitRef.current = emit
  useEffect(() => {
    emitRef.current(sync.project)
  }, [sync.project])

  // ── Theme: apply tokens onto the editor container. ──
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (containerRef.current) applyTheme(containerRef.current, theme ?? defaultMontajTheme)
  }, [theme])

  const isPending = sync.project.status === 'pending'

  // ── Shared injected adapter fns, threaded to Timeline + PreviewPlayer. ──
  const resolveFilePath   = adapter.fileUrl
  // T6 — canvas-timeline waveforms; absent → Timeline renders none (graceful).
  const getWaveformPeaks  = adapter.getWaveformPeaks
  // T7 — canvas-timeline filmstrips + hover-scrub; absent → Timeline renders none (graceful).
  const getFilmstrip      = adapter.getFilmstrip

  if (isPending) {
    return (
      <div ref={containerRef} className="flex flex-col h-full bg-[var(--editor-bg)]">
        <PendingSurface
          sync={sync}
          adapter={adapter}
          slots={slots}
          onBackToSetup={onBackToSetup}
          resolveFilePath={resolveFilePath}
          getWaveformPeaks={getWaveformPeaks}
          getFilmstrip={getFilmstrip}
          engine={engine}
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <ReviewSurface
        sync={sync}
        captionGestureRef={captionGestureRef}
        emit={emit}
        adapter={adapter}
        slots={slots}
        assetsPlacement={assetsPlacement}
        renderProgressView={renderProgressView}
        resolveFilePath={resolveFilePath}
        getWaveformPeaks={getWaveformPeaks}
        getFilmstrip={getFilmstrip}
        renderGenerationPanel={renderGenerationPanel}
        renderSubcutRegen={renderSubcutRegen}
        regenEnabled={regenEnabled}
        isClipQueued={isClipQueued}
        onProvideRenderTrigger={onProvideRenderTrigger}
        onProvideImageTone={onProvideImageTone}
        engine={engine}
        sourcePreview={sourcePreview}
      />
    </div>
  )
}

// ── Version-history hook (shared by both surfaces) ───────────────────────────

function useVersionHistory<P extends Project>(adapter: VideoEditorProps<P>['adapter'], project: P) {
  const [versions, setVersions]   = useState<{ hash: string; message: string; timestamp: string }[]>([])
  const [restoring, setRestoring] = useState<string | null>(null)
  const [saving, setSaving]       = useState(false)

  // Extracted so ad-hoc callers (post-restore, post-save, post-render) can
  // re-run the same fetch on demand via `refresh`, without duplicating the
  // adapter call or bypassing the auto-refetch effect below.
  const fetchVersions = useCallback(() => {
    return adapter.listVersionHistory?.(project.id).then(setVersions).catch(() => {}) ?? Promise.resolve()
  }, [adapter, project.id])

  useEffect(() => {
    void fetchVersions()
  }, [fetchVersions, project.status])

  return { versions, restoring, setRestoring, saving, setSaving, refresh: fetchVersions }
}

// ── Footage-bin source-scrub overlay (opt-in) ────────────────────────────────

/**
 * A paused `<video>` overlaid on the main preview stage, driven by the host's
 * footage bin: while a bin clip card is hovered the host writes `{ url, fraction }`
 * to the `sourcePreview` store and this parks the video on `fraction × duration`,
 * so the operator source-scrubs an OFF-TIMELINE clip in the big preview without
 * disturbing the playhead or PreviewPlayer's own clock.
 *
 * Structurally a sibling of `hover-scrub`: the subscription lives HERE, in a leaf
 * that renders one element, so a high-frequency hover over a card repaints only
 * this overlay — never ReviewSurface (toolbar + timeline + every context
 * consumer). The seek is imperative (an effect subscribed to the store writes
 * `currentTime` directly) rather than React state, so a fraction move never
 * re-mounts or reloads the `<video>`; only a url change (a different clip) does.
 *
 * Entirely inert when the host omits the store: `useSourcePreview(undefined)`
 * returns null, so this renders nothing and the classic/Hub/LP preview is
 * unchanged.
 */
function SourcePreviewOverlay({ store }: { store?: SourcePreviewStore }) {
  const value = useSourcePreview(store)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Imperative seek. Re-subscribes only when the url changes (a different clip);
  // fraction moves flow through the store subscription without a dep change, and
  // the `<video>` element/src stay put. A fresh src resets metadata, so seeking
  // is deferred to `loadedmetadata` when `duration` isn't finite yet — that
  // handler reads the CURRENT fraction, so a hover that moved while the proxy
  // loaded still lands on the right frame.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !store) return
    const applySeek = () => {
      const cur = store.get()
      if (!cur) return
      const dur = v.duration
      if (Number.isFinite(dur) && dur > 0) v.currentTime = cur.fraction * dur
    }
    v.addEventListener('loadedmetadata', applySeek)
    const unsub = store.subscribe(applySeek)
    applySeek()
    return () => {
      v.removeEventListener('loadedmetadata', applySeek)
      unsub()
    }
  }, [store, value?.url])

  if (!value) return null
  return (
    <video
      ref={videoRef}
      src={value.url}
      muted
      playsInline
      preload="metadata"
      // Display-only frame scrubber: never `.play()`, never steal pointer
      // interaction from the preview beneath it.
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        background: 'black',
        zIndex: 20,
        pointerEvents: 'none',
      }}
    />
  )
}

// ── Pending / processing surface (former LiveView) ───────────────────────────

interface SurfaceProps<P extends Project> {
  sync: UseProjectSync<P>
  adapter: VideoEditorProps<P>['adapter']
  slots?: VideoEditorProps<P>['slots']
  assetsPlacement?: VideoEditorProps<P>['assetsPlacement']
  renderProgressView?: VideoEditorProps<P>['renderProgressView']
  resolveFilePath: (path: string) => string
  getWaveformPeaks?: VideoEditorProps<P>['adapter']['getWaveformPeaks']
  getFilmstrip?: VideoEditorProps<P>['adapter']['getFilmstrip']
  onProvideRenderTrigger?: VideoEditorProps<P>['onProvideRenderTrigger']
  onProvideImageTone?: VideoEditorProps<P>['onProvideImageTone']
  engine?: VideoEditorProps<P>['engine']
}

function PendingSurface<P extends Project>({
  sync,
  adapter,
  slots,
  onBackToSetup,
  resolveFilePath,
  getWaveformPeaks,
  getFilmstrip,
  engine,
}: SurfaceProps<P> & { onBackToSetup?: () => void }) {
  const project = sync.project
  // The playhead lives in an external store (not useState) so ~60Hz ticks only
  // re-render the leaves that display time — not this whole surface.
  const clockRef = useRef<PlaybackClock | null>(null)
  if (!clockRef.current) clockRef.current = createPlaybackClock()
  const clock = clockRef.current
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { versions, restoring, setRestoring, saving, setSaving, refresh: refreshVersions } = useVersionHistory(adapter, project)
  // The version-compare view: the LEFT hash it was opened for, or null when
  // closed. Lives beside `versions` since VersionCompare's picker is seeded
  // from the same list VersionPanel renders.
  const [compareOpen, setCompareOpen] = useState<string | null>(null)

  useEffect(() => {
    adapter.getInfo?.().then(info => setSkillPath(info.root_skill_path ?? null)).catch(() => {})
  }, [adapter])

  const clips           = trackItems(project)[0] ?? []
  const hasTrimmedClips = clips.some(c => c.inPoint !== undefined && c.outPoint !== undefined)
  // The back-to-setup affordance is gated on the host supplying it AND the
  // project being safe to discard (no manual trims yet). Mirrors LiveView's
  // canGoBack rule.
  const canGoBack = !hasTrimmedClips && !!onBackToSetup

  async function handleRestoreVersion(hash: string) {
    if (!adapter.restoreVersion) return
    setRestoring(hash)
    try {
      const restored = await adapter.restoreVersion(project.id, hash)
      // Server-authored, already persisted — apply without a save or undo push.
      sync.applyExternal(restored)
    } catch (e) {
      console.error(e)
    } finally {
      setRestoring(null)
      await refreshVersions()
    }
  }

  async function handleSaveVersion(name?: string) {
    if (!adapter.saveVersion) return
    setSaving(true)
    try {
      await adapter.saveVersion(project.id, name)
      await refreshVersions()
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  function handleCompareVersion(hash: string) {
    setCompareOpen(hash)
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 flex items-center justify-center bg-black overflow-hidden p-4">
          {hasTrimmedClips ? (
            <PreviewPlayer
              project={project}
              clock={clock}
              compileOverlay={adapter.compileOverlay}
              clearOverlayCache={adapter.clearOverlayCache}
              watchFile={adapter.watchFile}
              fileUrl={adapter.fileUrl}
              resolveCaptionTemplate={adapter.resolveCaptionTemplate}
              engine={engine}
            />
          ) : (
            <div className="flex flex-col items-center gap-6 text-center max-w-lg w-full">
              {/* Host feeds live agent progress through the pendingStatus slot;
                  absent → skill-path card (if info available) or a minimal default. */}
              {slots?.pendingStatus ?? (
                <>
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-[var(--editor-text)] text-lg font-semibold">Message your agent to start</p>
                    <p className="text-[var(--editor-text)]/60 text-sm">Nothing will happen automatically. Copy this and send it to your agent.</p>
                  </div>
                  {skillPath && (
                    <div className="w-full rounded-xl border-2 border-[var(--editor-accent)]/50 bg-[var(--editor-surface)] p-5 flex flex-col gap-3 text-left shadow-lg shadow-[var(--editor-accent)]/10">
                      <p className="text-[var(--editor-accent)] text-xs font-bold uppercase tracking-widest">Send this to your agent</p>
                      <div className="flex items-start justify-between bg-black/60 border border-transparent rounded-lg px-3 py-3 font-mono gap-3">
                        <span className="text-gray-200 text-[12px] leading-relaxed break-all">
                          There is a new project pending: &quot;{project.name ?? project.id}&quot;. Please see @{skillPath} and start. Talk to me if you run into questions.
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(
                              `There is a new project pending: "${project.name ?? project.id}". Please see @${skillPath} and start. Talk to me if you run into questions.`
                            )
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                          }}
                          className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                            copied ? 'bg-green-700 text-green-200' : 'bg-[var(--editor-text)]/10 text-[var(--editor-text)]/80 hover:bg-[var(--editor-text)]/20 hover:text-[var(--editor-text)]'
                          }`}
                          title="Copy prompt"
                        >
                          {copied ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              <p className="text-[var(--editor-text)]/40 text-xs font-mono">project id: {project.id}</p>
              {canGoBack && (
                <button
                  onClick={onBackToSetup}
                  className="text-xs text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors underline underline-offset-2"
                >
                  ← Back to setup
                </button>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
          <Timeline
            project={project}
            clock={clock}
            resolveFilePath={resolveFilePath}
            getWaveformPeaks={getWaveformPeaks}
            getFilmstrip={getFilmstrip}
          />
        </div>
      </div>

      {/* Right sidebar — version history (hidden when the capability is absent) */}
      {adapter.listVersionHistory && (
        <div className="w-48 shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden">
          <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} onSaveVersion={handleSaveVersion} saving={saving} onCompareVersion={adapter.versionFrameUrl ? handleCompareVersion : undefined} />
        </div>
      )}

      {/* Visual A/B version compare — opened from a VersionPanel entry's
          Compare button. Gated on the adapter capability so a host without
          `versionFrameUrl` never sees an unusable Compare affordance's modal. */}
      {compareOpen != null && adapter.versionFrameUrl && (
        <VersionCompare
          projectId={project.id}
          versions={listVersions(versions)}
          initialLeftHash={compareOpen}
          frameUrl={adapter.versionFrameUrl}
          onClose={() => setCompareOpen(null)}
        />
      )}
    </div>
  )
}

// ── Draft / final surface (former ReviewView) ────────────────────────────────

// Every visual item id (across all tracks) plus every audio track id in a
// project. Used by the clipboard paste/duplicate handlers below to diff
// before/after a `pasteAt`/`duplicateSelection` call and find the ids those
// pure ops minted (`newClipId()`), so the freshly pasted/duplicated items can
// be selected — neither op returns the new ids directly.
function collectAllIds(project: Project): Set<string> {
  const ids = new Set<string>()
  for (const item of trackItems(project).flat()) ids.add(item.id)
  for (const track of project.audio?.tracks ?? []) ids.add(track.id)
  return ids
}

function ReviewSurface<P extends Project>({
  sync,
  captionGestureRef,
  emit,
  adapter,
  slots,
  assetsPlacement = 'right',
  renderProgressView = 'phases',
  resolveFilePath,
  getWaveformPeaks,
  getFilmstrip,
  renderGenerationPanel,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
  onProvideRenderTrigger,
  onProvideImageTone,
  engine,
  sourcePreview,
}: SurfaceProps<P> & {
  // See the definition beside `sync` in VideoEditor above — set for the
  // duration of a caption drag gesture so the lane-normalization effect
  // (also up in VideoEditor) leaves a mid-drag hole lane alone.
  captionGestureRef: MutableRefObject<boolean>
  emit: (p: P) => void
  renderGenerationPanel?: VideoEditorProps<P>['renderGenerationPanel']
  renderSubcutRegen?: VideoEditorProps<P>['renderSubcutRegen']
  regenEnabled?: boolean
  isClipQueued?: (itemId: string) => boolean
  sourcePreview?: VideoEditorProps<P>['sourcePreview']
}) {
  const project = sync.project
  // Playhead in an external store, not useState — ~60Hz ticks re-render only the
  // leaves that display time (preview, scrubber, transcript) instead of the whole
  // review surface (toolbar + timeline + every context consumer).
  const clockRef = useRef<PlaybackClock | null>(null)
  if (!clockRef.current) clockRef.current = createPlaybackClock()
  const clock = clockRef.current
  // Multi-select: all currently-selected timeline item ids. Single-select
  // consumers (canvas preview, cut/split) use primarySelectedId, derived below
  // once captionIdSet exists — it has to skip caption ids, so it can't just be
  // selectedIds[0].
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // Canvas-timeline double-click → sidebar focus request (Phase 6). `nonce`
  // is load-bearing: CaptionListPanel only re-focuses a row when `nonce`
  // CHANGES (see its `lastHandledNonceRef` guard), so double-clicking the
  // SAME caption twice must still produce two distinct requests — the bare
  // id would be identical both times and the second double-click would be a
  // silent no-op. Incrementing off the previous state (not a plain counter
  // ref) keeps this correct even if two edits interleave with other renders.
  const [editFocusId, setEditFocusId] = useState<CaptionEditFocusRequest | null>(null)
  // Ids present in project.captions.segments — memoized so DERIVING
  // selectedCaptionId below doesn't rescan every segment on every render, only
  // when captions actually change.
  const captionIdSet = useMemo(
    () => new Set((project.captions?.segments ?? []).map(s => s.id).filter((id): id is string => !!id)),
    [project.captions?.segments],
  )
  // The first NON-caption id in the selection, deliberately. Under D1 captions
  // share `selectedIds` with clips and audio (see Timeline.tsx's
  // `handleSelectItem`), but every consumer of this value — cropTarget,
  // selectedOverlayItem, handleSplit's scope, PreviewPlayer's overlay
  // selection box — speaks clip/audio vocabulary. Taking selectedIds[0]
  // verbatim let a caption id at index 0 blank the selected clip's crop and
  // overlay-edit affordances, and scoped Split to an id no track item
  // matches, so `splitAtTime` returned its input unchanged and `S` silently
  // did nothing. Captions are addressed separately, via `selectedCaptionId`
  // below.
  const primarySelectedId = selectedIds.find(id => !captionIdSet.has(id)) ?? null
  // Selected caption segment id — DERIVED from `selectedIds`, not tracked as
  // its own state. Under D1 a caption id is just another member of
  // `selectedIds` (selected on the canvas timeline exactly like a clip or
  // audio track — see Timeline.tsx's `handleSelectItem`); this is
  // VideoEditor's mirror of "the first caption id in there, if any" for
  // PreviewPlayer's selection box, the one remaining consumer that predates
  // D1 and only understands a single id (CaptionListPanel, its other former
  // sibling, derives its own selected segment straight from `selectedIds`
  // instead of taking this prop). A marquee can legitimately put more than
  // one caption id in `selectedIds` — taking the first is correct, the
  // preview only ever shows one box.
  const selectedCaptionId = selectedIds.find(id => captionIdSet.has(id)) ?? null
  // Publish what we are looking at, so an agent can resolve "this section".
  // No-ops entirely on a host that does not implement reportContext.
  useReportContext({
    adapter,
    projectId: project.id,
    clock,
    selectedIds,
    selectedCaptionId,
  })
  const [rippleMode, setRippleMode]   = useState(false)
  // CapCut's "preview axis", off by default. Off changes nothing: clicking the
  // timeline moves the red playhead and the preview follows it, as always. On,
  // a yellow cursor line tracks the pointer across the timeline and the preview
  // shows THAT frame while the playhead stays put — hover to look around, click
  // to actually go there.
  const [previewAxis, setPreviewAxis] = useState(false)

  // Copy/paste/duplicate clipboard (T2). A ref, not state: nothing in this
  // surface needs to re-render when it changes — the keymap guards below read
  // it synchronously at keydown time, and `paletteCommands` (built fresh every
  // render) reads it whenever the palette's own `setPaletteOpen` call triggers
  // that render.
  const clipboardRef = useRef<ClipboardPayload | null>(null)

  // ── Preview / timeline split ───────────────────────────────────────────
  // The timeline pane owns an explicit height and the preview takes the rest,
  // so one number describes the whole split. Persisted per browser, not per
  // project: it's a property of the screen you're working on.
  const splitRef = useRef<HTMLDivElement | null>(null)
  const [timelinePaneHeight, setTimelinePaneHeight] = usePersistentState(
    TIMELINE_PANE_STORAGE_KEY,
    DEFAULT_TIMELINE_PANE_PX,
    reviveNumberInRange(MIN_TIMELINE_PANE_PX, MAX_TIMELINE_PANE_PX),
  )
  // The right rail's width, same deal on the other axis. 300px (up from
  // 224/192) is the new default so the sidebar CaptionListPanel's list and
  // its "Caption style" controls aren't cramped — persisted per browser, so
  // only a fresh/cleared localStorage picks up the new default.
  const workAreaRef = useRef<HTMLDivElement | null>(null)
  const [railWidth, setRailWidth] = usePersistentState(
    RAIL_WIDTH_STORAGE_KEY,
    DEFAULT_RAIL_PX,
    reviveNumberInRange(MIN_RAIL_PX, MAX_RAIL_PX),
  )
  // The left media column's width (CapCut layout only). Same persist/clamp
  // pattern as the rail; ignored entirely unless `slots.mediaPanel` is present.
  const [mediaPanelWidth, setMediaPanelWidth] = usePersistentState(
    MEDIA_PANEL_WIDTH_STORAGE_KEY,
    DEFAULT_MEDIA_PANEL_PX,
    reviveNumberInRange(MIN_MEDIA_PANEL_PX, MAX_MEDIA_PANEL_PX),
  )

  /** Drag the rail divider. Mirrors `startSplitDrag` on the horizontal axis;
   *  dragging LEFT widens the rail, hence the inverted delta. */
  const startRailDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = railWidth
    const available = workAreaRef.current?.getBoundingClientRect().width ?? 0
    const max = Math.max(MIN_RAIL_PX, Math.min(MAX_RAIL_PX, available - MIN_MAIN_PX))

    let latest = startWidth
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(MIN_RAIL_PX, Math.min(max, startWidth - (ev.clientX - startX)))
      setRailWidth(latest, { persist: false })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setRailWidth(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [railWidth, setRailWidth])

  /** Drag the media-column divider (CapCut layout). The divider sits on the
   *  column's RIGHT edge, so dragging RIGHT must WIDEN it — hence the delta is
   *  ADDED (the mirror image of `startRailDrag`, whose rail grows leftward).
   *  `MIN_MAIN_PX` still guards the preview column's minimum width. */
  const startMediaPanelDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = mediaPanelWidth
    const available = workAreaRef.current?.getBoundingClientRect().width ?? 0
    const max = Math.max(MIN_MEDIA_PANEL_PX, Math.min(MAX_MEDIA_PANEL_PX, available - MIN_MAIN_PX))

    let latest = startWidth
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(MIN_MEDIA_PANEL_PX, Math.min(max, startWidth + (ev.clientX - startX)))
      setMediaPanelWidth(latest, { persist: false })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setMediaPanelWidth(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [mediaPanelWidth, setMediaPanelWidth])

  /**
   * Drag the divider. Bound to `document` rather than the handle so the drag
   * survives the pointer outrunning a 5px target — the same reason the timeline's
   * own gestures listen on the document.
   *
   * The clamp has two jobs: keep the timeline usable (`MIN_TIMELINE_PANE_PX`),
   * and always leave the preview a real area to draw in, so the divider can
   * never be dragged to the top of the window and strand the picture at zero
   * height. `document.body.style.cursor` holds the resize cursor for the whole
   * drag, otherwise it flickers back whenever the pointer crosses a child that
   * sets its own.
   */
  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = timelinePaneHeight
    const available = splitRef.current?.getBoundingClientRect().height ?? 0
    const max = Math.max(MIN_TIMELINE_PANE_PX, Math.min(MAX_TIMELINE_PANE_PX, available - MIN_PREVIEW_PANE_PX))

    let latest = startHeight
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(MIN_TIMELINE_PANE_PX, Math.min(max, startHeight - (ev.clientY - startY)))
      setTimelinePaneHeight(latest, { persist: false })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setTimelinePaneHeight(latest) // the write that actually persists
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [timelinePaneHeight, setTimelinePaneHeight])

  // The hovered frame, in an external store so a mousemove repaints the preview
  // and nothing else — see `hover-scrub.ts` for why this is not the clock.
  const hoverScrubRef = useRef(createHoverScrub())
  const hoverScrub = hoverScrubRef.current

  // Any real playhead movement cancels the hover preview: a playback tick, an
  // arrow-key step, a scrubber drag, a click that seeks. Without this a hover
  // left standing would pin the preview to a frame the playhead has since left,
  // and pressing Space would play audio against a frozen picture.
  useEffect(() => clock.subscribe(() => hoverScrub.set(null)), [clock, hoverScrub])

  const handleHoverScrub = useCallback((time: number | null) => {
    // Never while playing: the playback hooks drive the frame themselves, and
    // an override would fight them for the <video>/engine's seek position.
    if (time !== null && transportRef.current?.isPlaying()) return
    hoverScrub.set(time)
  }, [hoverScrub])
  const [showControls, setShowControls] = useState(false)
  // Source-crop mode: when on, the VideoSourceCropModal opens for the selected
  // tracks[0] video item. Cleared when selection changes.
  const [cropMode, setCropMode]       = useState(false)
  const [renderOpen, setRenderOpen]   = useState(false)
  const [regenCaptionsOpen, setRegenCaptionsOpen] = useState(false)
  // Opens the caption-regeneration modal — CaptionListPanel's toolbar button.
  // Provided only when the host adapter supports `generateCaptions`; absent →
  // the "Regenerate" button is hidden there.
  const handleRegenerateCaptions = adapter.generateCaptions ? () => setRegenCaptionsOpen(true) : undefined
  const [polishOpen, setPolishOpen] = useState(false)
  // Opens AudioPolishModal — toolbar button and command palette entry.
  // Provided only when the host adapter supports `analyzeAudioPolish`; absent →
  // neither entry point renders, exactly like `handleRegenerateCaptions` above.
  const handleAudioPolish = adapter.analyzeAudioPolish ? () => setPolishOpen(true) : undefined
  // SP5 T9 — command palette (Cmd/Ctrl+K). `'goto'` opens straight into the
  // timecode input (the scrubber's time-readout click); `'list'` opens the
  // filtered command list.
  const [paletteOpen, setPaletteOpen] = useState<false | 'list' | 'goto'>(false)

  // ── T9 keymap plumbing (continued after `editingOverlayItem`, below) ──
  // The transport seam — filled by PreviewPlayer from whichever playback path
  // (legacy or engine) is active. The keymap and palette use it for play/
  // pause; the shuttle polls `isPlaying()` to detect a real transport change.
  const transportRef = useRef<TransportHandle | null>(null)
  // The audible drag-scrub source's engine seam — mirrors `transportRef`.
  // Filled by PreviewPlayer only on the WebCodecs engine path; stays null on
  // the legacy `<video>` fallback (see the scrub-source effect below).
  const scrubHandleRef = useRef<ScrubHandle | null>(null)
  // Marker/zoom actions Timeline exposes for the palette, mirroring
  // `transportRef`'s shape.
  const timelineActionsRef = useRef<TimelineActions | null>(null)

  // Declared ahead of the scrub effect below (rather than alongside
  // currentSocialPreview/currentImageTone further down) because that effect
  // reads it to seed the scrubber's initial enabled state.
  const currentAudibleScrub = project.settings?.audibleScrub ?? false

  // Audible drag-scrub: one grain-per-move scrubber for the life of the
  // surface, attached to the same hover store the preview reads. `resolve`
  // re-checks `scrubHandleRef.current` on every call (not just at
  // construction) so it stays silent — same as a gap or a canvas project —
  // until PreviewPlayer's own effect fills the ref, and goes silent again if
  // the project is on the legacy `<video>` fallback, which never fills it.
  const scrubberRef = useRef<ScrubSource | null>(null)
  useEffect(() => {
    const resolve = createScrubResolver(() => sync.projectRef.current)
    const scrubber = createScrubSource({
      acquireDemux: (src) => scrubHandleRef.current!.acquireDemux(src),
      resolve: (projectS) => (scrubHandleRef.current ? resolve(projectS) : null),
      onError: (message) => console.error('[montaj] scrub-source:', message),
    })
    scrubber.setEnabled(currentAudibleScrub)
    scrubberRef.current = scrubber
    const detach = scrubber.attach(hoverScrub)
    return () => {
      detach()
      scrubber.dispose()
      scrubberRef.current = null
    }
  }, [hoverScrub, sync.projectRef])

  // Flip the live scrubber's enabled flag when the settings toggle changes,
  // without tearing down and recreating it — `setEnabled` also stops any
  // in-flight grain on disable (scrub-source.ts).
  useEffect(() => {
    scrubberRef.current?.setEnabled(currentAudibleScrub)
  }, [currentAudibleScrub])

  // Duration for shuttle clamping and the palette's "go to time" clamp —
  // read fresh off the sync core's project ref rather than captured once, so
  // neither goes stale across edits.
  const getTotalDuration = useCallback(
    () => computeDerivedTiming(sync.projectRef.current).totalDuration,
    [sync.projectRef],
  )

  // J/K/L shuttle. Created once (lazy ref init) — its deps are all stable
  // (clock, transportRef, the duration getter above), so there's nothing to
  // recreate it over. See shuttle.ts for the rate-stepping/cancellation design.
  const shuttleRef = useRef<ReturnType<typeof createShuttleController> | null>(null)
  if (!shuttleRef.current) {
    shuttleRef.current = createShuttleController({
      clock,
      getDuration: getTotalDuration,
      isPlaying: () => transportRef.current?.isPlaying() ?? false,
      play: () => { if (!transportRef.current?.isPlaying()) transportRef.current?.togglePlay() },
      pause: () => { if (transportRef.current?.isPlaying()) transportRef.current.togglePlay() },
      setRate: (rate) => transportRef.current?.setRate(rate),
    })
  }
  const shuttle = shuttleRef.current
  // The loop is rAF-driven and neither of its cancellation guards fires after
  // unmount (nothing is playing, and nothing else writes the clock), so stop it
  // explicitly rather than let it run out the timeline against a dead clock.
  useEffect(() => () => shuttle.stop(), [shuttle])

  // Render trigger — marks the project final, saves, and opens the RenderModal.
  // Kept stable (the sync mutators/ref are stable; `emit` read via ref) so a host
  // that places Render in its own header (onProvideRenderTrigger) can store the
  // callback once without it going stale. `emit(final)` fires synchronously so
  // the host's chrome flips to "final" immediately; the queued `mutate` makes it
  // canonical and persists it.
  const { mutate: syncMutate, projectRef: syncProjectRef } = sync
  const emitRef = useRef(emit); emitRef.current = emit

  // Persist the HDR image color mapping into project settings. A real user
  // edit: goes through sync.mutate so it saves and participates in undo.
  const handleImageToneChange = useCallback((tone: ImageTone) => {
    void syncMutate(() => {
      const cur = syncProjectRef.current
      return { ...cur, settings: { ...cur.settings, imageTone: tone } } as P
    })
  }, [syncMutate, syncProjectRef])

  // Persist the audible drag-scrub toggle into project settings — same
  // save-then-sync idiom as handleImageToneChange above. SET-always (unlike
  // handleSocialPreviewChange's omit-key below): a boolean has no natural
  // "unset" state, and default-off means an explicit `true` has to persist
  // the operator's opt-in.
  const handleAudibleScrubChange = useCallback((on: boolean) => {
    void syncMutate(() => {
      const cur = syncProjectRef.current
      return { ...cur, settings: { ...cur.settings, audibleScrub: on } } as P
    })
  }, [syncMutate, syncProjectRef])

  // Persist the social-media preview platform into project settings — same
  // shape as handleImageToneChange above. `null` clears it (the picker's
  // "None" entry), which the settings-spread below has to do by explicitly
  // OMITTING the key rather than writing `socialPreview: undefined`: a
  // spread with an `undefined` value still enumerates the key, so a
  // JSON-serialized save would round-trip it back as `null`/absent
  // inconsistently across hosts — omitting it keeps "no selection" and
  // "field never written" the same on-disk shape.
  const handleSocialPreviewChange = useCallback((platform: SocialPreviewPlatform | null) => {
    void syncMutate(() => {
      const cur = syncProjectRef.current
      const { socialPreview: _drop, ...restSettings } = cur.settings
      return {
        ...cur,
        settings: platform ? { ...restSettings, socialPreview: platform } : restSettings,
      } as P
    })
  }, [syncMutate, syncProjectRef])
  const currentSocialPreview = project.settings?.socialPreview ?? null
  // The active pick's glyph/badge, for the controls-row trigger button
  // (see its render site below) — `null` on "None", same as `platformOption`
  // itself returns for a `null` platform.
  const activeSocialPreviewOption = platformOption(currentSocialPreview)

  // Host-chrome placement of the image-tone setting (mirrors
  // onProvideRenderTrigger): push the current state up whenever it changes,
  // and null for SDR projects so the host hides the control.
  const isHdrProject = !!project.settings?.colorSpace?.startsWith('hdr')
  const currentImageTone = project.settings?.imageTone
  useEffect(() => {
    if (!onProvideImageTone) return
    onProvideImageTone(isHdrProject ? { value: currentImageTone ?? 'vivid', set: handleImageToneChange } : null)
  }, [onProvideImageTone, isHdrProject, currentImageTone, handleImageToneChange])

  // Pre-render options for the export dialog (RenderModal). `keeps` are the
  // track-0 video windows the modal samples cover/thumbnail frames from —
  // memoized so the modal sees a stable list. `name`/`durationSec` seed the
  // dialog's Name field and duration footer (duration = the video spine's last
  // frame, which defines the render length). `isHdr` gates the HDR-only controls
  // (export format, image color, SDR tone curve); the dialog itself now opens for
  // every project the montaj editor renders.
  //
  // Enabled tracks only (`enabledTrackItems`, not `trackItems`): render.js
  // computes the exported duration and poster frames from the same enabled
  // family, so a skipped base track must not leave this dialog advertising a
  // duration or cover/thumbnail windows the exported file won't actually have.
  const renderKeeps = useMemo(
    () => (enabledTrackItems(project)[0] ?? [])
      .filter(item => item.type === 'video')
      .map(item => ({ start: item.start, end: item.end })),
    [project.tracks],
  )
  // Persist the export resolution / fps tier into project settings — same
  // save-then-sync idiom as handleImageToneChange above. Mutating
  // settings.resolution to a same-aspect higher tier doesn't perturb the
  // editor preview (design-canvas only reads it for aspect), so this is safe
  // to fire straight from the export dialog's tier picker.
  const handleExportResolutionChange = useCallback((res: [number, number]) => {
    void syncMutate(() => {
      const cur = syncProjectRef.current
      return { ...cur, settings: { ...cur.settings, resolution: res } } as P
    })
  }, [syncMutate, syncProjectRef])

  const handleExportFpsChange = useCallback((fps: number) => {
    void syncMutate(() => {
      const cur = syncProjectRef.current
      return { ...cur, settings: { ...cur.settings, fps } } as P
    })
  }, [syncMutate, syncProjectRef])

  // Source-capped tier lists for the export dialog's resolution/fps pickers.
  // Memoized separately from preRenderOptions so a project mutation unrelated
  // to tracks/resolution/fps doesn't recompute the (mildly more expensive)
  // source-scan in availableResolutionTiers.
  const availableRes = useMemo(() => availableResolutionTiers(project), [project])
  const availableFpsList = useMemo(() => availableFpsTiers(project), [project])

  const preRenderOptions = useMemo(() => ({
    isHdr: isHdrProject,
    keeps: renderKeeps,
    imageTone: { value: currentImageTone ?? 'vivid', set: handleImageToneChange },
    name: project.name?.trim() || undefined,
    durationSec: renderKeeps.reduce((m, k) => Math.max(m, k.end), 0),
    aspectRatio: (() => {
      const r = project.settings?.resolution
      return r && r[0] > 0 && r[1] > 0 ? r[0] / r[1] : undefined
    })(),
    resolution: {
      value: currentResolutionTier(project) ?? project.settings.resolution,
      available: availableRes,
      set: handleExportResolutionChange,
    },
    fps: {
      value: maxExportFps(project),
      available: availableFpsList,
      set: handleExportFpsChange,
    },
  }), [
    isHdrProject, renderKeeps, currentImageTone, handleImageToneChange,
    project.name, project.settings?.resolution, project.settings?.fps,
    availableRes, availableFpsList, handleExportResolutionChange, handleExportFpsChange,
  ])

  const openRender = useCallback(() => {
    const final = { ...syncProjectRef.current, status: 'final' } as P
    emitRef.current(final)
    void syncMutate(() => final)
    setRenderOpen(true)
  }, [syncMutate, syncProjectRef])
  useEffect(() => { onProvideRenderTrigger?.(openRender) }, [onProvideRenderTrigger, openRender])

  const { versions, restoring, setRestoring, saving, setSaving, refresh: refreshVersions } = useVersionHistory(adapter, project)
  // The version-compare view: the LEFT hash it was opened for, or null when
  // closed. Mirrors PendingSurface's `compareOpen` — each surface mounts its
  // own VersionPanel, so each owns its own compare state.
  const [compareOpen, setCompareOpen] = useState<string | null>(null)

  // Repair caption segments whose words[] text has diverged from edited seg.text.
  // Inline caption edits update seg.text but not seg.words; this normalizes the
  // data so PreviewPlayer's word-level timing is correct.
  //
  // Keyed on BOTH project.id and project.captions — mirrors the id-backfill
  // effect above for the identical reason: `CaptionRegenModal`'s `onDone`
  // replaces project.captions via applyExternal WITHOUT changing project.id, so
  // an id-keyed-only effect would miss mid-session caption regeneration and
  // freshly regenerated captions would skip repair until a remount.
  //
  // Applied via `applyExternal` (no save, no undo push): it's a local
  // reconciliation, not a user edit — pushing an undo entry on load would make the
  // operator's first Cmd-Z undo the repair, and the normalized captions persist on
  // the next real save anyway.
  //
  // Loop-proof: `repairCaptionWords` returns `null` (a true no-op) once every
  // segment's words[] already matches its text — see captionRepair.ts, which
  // whitespace-normalizes the comparison specifically so this holds even when
  // the edited/regenerated text itself contains irregular internal spacing
  // (without that normalization, repairing never reaches a fixed point and this
  // effect would applyExternal forever). The pass that follows our own
  // applyExternal (which necessarily produces a new `captions` reference, and
  // therefore re-fires this effect exactly once) finds nothing left to repair
  // and stops. Every other re-fire — one per caption edit — is a cheap no-op scan.
  useEffect(() => {
    const captions = project.captions
    if (!captions?.segments?.length) return
    const repaired = repairCaptionWords(captions)
    if (!repaired) return
    sync.applyExternal({ ...project, captions: repaired } as P)
  }, [project.id, project.captions])

  const clips      = trackItems(project)[0] ?? []
  const hasContent = clips.length > 0 || (trackItems(project).slice(1).flat().length ?? 0) > 0 || (project.captions?.segments?.length ?? 0) > 0

  // Preview controls row's timecode readout. `currentTime` is the same
  // `usePlaybackTime(clock)` subscription `CaptionListPanelWithClock` uses
  // lower down — a second, independent call here rather than threading its
  // value up, since it's a plain hook and this is a different render leaf.
  // `previewDuration` is the actual playable length (contentDuration), NOT
  // `getTotalDuration()`'s zoom/scroll-padded value used for shuttle/seek
  // clamping — that one runs ~20% past the last clip so the timeline canvas
  // has room to drag into, which would read as a wrong total here.
  const currentTime = usePlaybackTime(clock)
  const previewDuration = useMemo(() => computeDerivedTiming(project).contentDuration, [project])

  // The selected tracks[0] video item, if any — the only thing source-crop mode
  // can target. Source crop is a tracks[0]-video primitive (the renderer applies
  // it to the original clip before compositing).
  const cropTarget = primarySelectedId
    ? clips.find(c => c.id === primarySelectedId && c.type === 'video' && !!c.src) ?? null
    : null

  // Selecting a different item (or nothing croppable) exits crop mode.
  useEffect(() => {
    if (!cropTarget && cropMode) setCropMode(false)
  }, [cropTarget, cropMode])

  // Overlay props dialog — opened from the preview (double-click), the controls
  // bar, or the timeline block. VideoEditor owns the state so all three surfaces
  // share one modal. Edits ride the sync core's transient/commit gesture path
  // (live preview + one undo step on Save).
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null)
  // Project snapshot taken when the dialog opens, so Cancel reverts to the
  // pre-edit state even though edits preview live in between.
  const editOriginalRef = useRef<P | null>(null)
  const requestEditOverlay = useCallback((id: string) => {
    editOriginalRef.current = syncProjectRef.current
    setEditingOverlayId(id)
  }, [syncProjectRef])
  const allVisualItems = trackItems(project).flat()
  const editingOverlayItem = editingOverlayId
    ? allVisualItems.find(i => i.id === editingOverlayId) ?? null
    : null

  // T9 keymap plumbing: every dialog/panel this surface can have open, ORed
  // into one flag so the keymap (and Timeline's own arrows/delete/enter/
  // escape keymap, via the `modalOpen` prop passed to it below) suppresses
  // every binding while any of them is up — including the palette itself, so
  // typing in a filter field elsewhere can't leak into a single-key
  // shortcut. There is no general "is a modal open" concept anywhere else in
  // the codebase (today's handlers didn't check this at all); this derives
  // it from state ReviewSurface already owns rather than inventing new
  // cross-file plumbing.
  const anyModalOpen = renderOpen || regenCaptionsOpen || polishOpen || !!editingOverlayItem
    || showControls || cropMode || !!paletteOpen

  function withItemProps(base: P, id: string, nextProps: Record<string, unknown>): P {
    return {
      ...base,
      tracks: mapTrackItems(base, items =>
        items.map(item => (item.id !== id ? item : { ...item, props: nextProps })),
      ),
    } as P
  }
  // Live preview: reflect the in-progress edit locally (transient — no save, no
  // undo push) so the overlay re-renders as the operator tweaks. `commit()` on
  // Save persists the accumulated transient state as one undo step.
  function previewOverlayProps(id: string, nextProps: Record<string, unknown>) {
    sync.mutateTransient(p => withItemProps(p, id, nextProps))
  }
  // Commit on Save: the last preview already applied the final props transiently,
  // so committing persists them and records one undo step (the pre-edit baseline).
  function commitOverlayEdit() {
    void sync.commit()
    editOriginalRef.current = null
    setEditingOverlayId(null)
  }
  // Cancel/Esc/close: discard the live preview by restoring the pre-edit snapshot
  // (no save, no undo push).
  function cancelOverlayEdit() {
    if (editOriginalRef.current) sync.applyExternal(editOriginalRef.current)
    editOriginalRef.current = null
    setEditingOverlayId(null)
  }
  // The primary-selected JSX overlay, if any — drives the controls-bar edit button.
  const selectedOverlayItem = primarySelectedId
    ? allVisualItems.find(i => i.id === primarySelectedId && i.type === 'overlay' && !!i.src) ?? null
    : null

  // The right properties panel's non-overlay target, resolved from the SAME
  // primary selection `selectedOverlayItem` above uses and derived the same
  // way — against `trackItems(project)` for a visual item, then against
  // `project.audio.tracks`. Precedence is overlay → clip → audio: an overlay
  // IS a visual item, so the clip branch has to exclude `type === 'overlay'`
  // or a selected overlay would show clip properties instead of its Transform
  // inspector. Audio is reached only when the id names no visual item at all —
  // ids are unique across the project, so that is a plain fallback, not a
  // guess. Exactly one of {overlay, clip, audio, nothing} holds at a time.
  const selectedVisualItem = primarySelectedId
    ? allVisualItems.find(i => i.id === primarySelectedId) ?? null
    : null
  const selectedAudioTrack = primarySelectedId && !selectedVisualItem
    ? project.audio?.tracks.find(t => t.id === primarySelectedId) ?? null
    : null
  const clipSelection: ClipSelection =
    selectedVisualItem && selectedVisualItem.type !== 'overlay'
      ? { kind: 'clip', item: selectedVisualItem }
      : selectedAudioTrack
        ? { kind: 'audio', track: selectedAudioTrack }
        : null

  // Edits coming from the timeline (drag/move/track changes): route through the
  // sync core — one undo step + queued save + rollback-on-failure.
  /**
   * A LIVE, uncommitted edit — one per mousemove of a timeline gesture (and per
   * tick of the caption font slider). Transient: applied locally, but no save
   * and no undo entry.
   *
   * This used to be a full `mutate`, which pushed an undo entry per move. A
   * single drag across the timeline therefore recorded dozens of them, and undo
   * walked the clip back a few pixels at a time instead of putting it where it
   * started. `commitTimelineEdit` closes the gesture with ONE entry covering
   * the whole motion.
   *
   * Sets `captionGestureRef` BEFORE the transient apply: the lane-
   * normalization effect in VideoEditor is a dep of `sync.project.captions`,
   * so it can fire off the very state update `mutateTransient` triggers here —
   * the flag has to already be true when that happens, or the first mousemove
   * of a cross-row caption drag collapses the hole lane and clears the sync
   * core's transient baseline (see the comment beside `captionGestureRef`).
   */
  function handleProjectChange(p: Project) {
    captionGestureRef.current = true
    sync.mutateTransient(() => p as P)
  }

  /**
   * The end of a gesture: persist the accumulated transient state as one save
   * and one undo step, taken from the snapshot before the gesture's first move.
   *
   * Applies `p` transiently first rather than trusting the last preview to have
   * been identical — a few callers (ripple delete, auto-crossfade) compute the
   * final project themselves and hand it straight here, and a caller that DID
   * already preview it lands a no-op.
   *
   * Clears `captionGestureRef` BEFORE the transient apply, for the same
   * before-the-state-update reason `handleProjectChange` sets it: this commit
   * IS the point a cross-row drag's hole lane should collapse, and the lane-
   * normalization effect must see the flag already false when it re-fires off
   * this project update.
   *
   * Known limitation: a gesture that calls `handleProjectChange` but never
   * reaches a commit (e.g. the component unmounts mid-drag) leaves the flag
   * stuck true. The only cost is that lane normalization for an externally-
   * arrived sparse project (SSE, regen, a hand-authored project.json) waits
   * one more caption edit before it applies — the next real `commitTimelineEdit`
   * clears the flag and the effect catches up.
   */
  function commitTimelineEdit(p: Project) {
    captionGestureRef.current = false
    // Fold the auto-crossfade into the SAME commit as the gesture, so an audio
    // drag/trim that ends overlapping a neighbour lands as ONE undo step (the
    // move and its derived fade together) rather than the move here plus a
    // separate fade commit. Idempotent — a project needing no fade comes back
    // unchanged — so video moves and non-overlapping audio moves are untouched.
    const faded = computeAutoCrossfade(p) ?? p
    sync.mutateTransient(() => faded as P)
    void sync.commit()
  }

  function handleOverlayChange(id: string, changes: OverlayChanges) {
    void sync.mutate(p => ({
      ...p,
      tracks: mapTrackItems(p, items =>
        items.map(item => item.id !== id ? item : { ...item, ...changes })
      ),
    } as P))
  }

  // OverlayInspector edits (T3.2). Unlike handleOverlayChange above, this
  // takes a WHOLE replacement item rather than a partial-changes patch:
  // OverlayInspector itself decides (via keyframeOps) whether an edit writes
  // a static scalar or drops a keyframe, and disabling keyframing has to
  // REMOVE `item.keyframes` entirely (see keyframeOps.withTrack) — something
  // a `{ ...item, ...changes }` merge can't express, since spreading in
  // `keyframes: undefined` leaves the key present rather than absent.
  // Shared with the clip properties panel below: a whole-item replacement is
  // exactly what that one needs too (a speed change rewrites `end` alongside
  // `speed`), so both inspectors write back through this.
  function replaceVisualItem(p: P, nextItem: VisualItem): P {
    return {
      ...p,
      tracks: mapTrackItems(p, items => items.map(item => (item.id === nextItem.id ? nextItem : item))),
    } as P
  }
  // Live preview for a continuously-typed number field: no undo entry, no
  // save yet. Mirrors previewOverlayProps below.
  function previewOverlayInspectorChange(nextItem: VisualItem) {
    sync.mutateTransient(p => replaceVisualItem(p, nextItem))
  }
  // Closes a typing gesture (fired on the field's blur) as one undo step +
  // queued save. Mirrors commitOverlayEdit below — the last preview already
  // applied the final value, so this only has to persist it.
  function commitOverlayInspectorChange() {
    void sync.commit()
  }
  // A discrete, already-final edit (the keyframe diamond toggle) — there is
  // no separate blur to commit on, so preview + commit fire back to back as
  // one user-visible action.
  function applyOverlayInspectorChange(nextItem: VisualItem) {
    previewOverlayInspectorChange(nextItem)
    commitOverlayInspectorChange()
  }

  // Move the playhead to an absolute timeline time, clamped to the project —
  // the same clamp the command palette's "go to time" applies. `clock.set` is
  // the whole of "seek" in this surface: audible drag-scrub hangs off the
  // hover store, not the clock (a clock tick CANCELS a hover preview, see the
  // subscription above), so there is no extra side effect to route through.
  // OverlayInspector's keyframe-nav arrows are the only caller; without it
  // they render disabled.
  const seekTo = useCallback(
    (time: number) => clock.set(Math.max(0, Math.min(getTotalDuration(), time))),
    [clock, getTotalDuration],
  )

  // ── Clip / audio properties-panel edits ────────────────────────────────────
  // The same preview/commit/change trio as the overlay inspector above, on the
  // same `sync` machinery — ClipPropertiesPanel is its sibling in the right
  // column and hands back a whole replacement item / track the same way.

  /** Set by a preview that changed the selected clip's timeline DURATION
   *  (today only a speed change does). Read and cleared by the commit below,
   *  which is where ripple has to run. A ref, not state: it is gesture
   *  bookkeeping, and flipping it must not re-render mid-drag. */
  const clipDurationChangedRef = useRef(false)

  // Cleared whenever the selection changes. Today `SpeedControl` sets the flag
  // and commits atomically, so it cannot survive a gesture — but nothing in
  // the type system says so, and a future control that previews a duration
  // change WITHOUT committing (an abandoned drag, a discarded transient, a
  // selection change mid-gesture) would leave it set and ripple the timeline
  // on the next unrelated commit. Resetting here makes that impossible rather
  // than merely unlikely.
  useEffect(() => { clipDurationChangedRef.current = false }, [primarySelectedId])

  function previewClipChange(nextItem: VisualItem) {
    const before = trackItems(sync.projectRef.current).flat().find(i => i.id === nextItem.id)
    if (before && (before.end - before.start) !== (nextItem.end - nextItem.start)) {
      clipDurationChangedRef.current = true
    }
    sync.mutateTransient(p => replaceVisualItem(p, nextItem))
  }
  function commitClipChange() {
    // Ripple, which the retired ClipInspectModal used to do itself: shrinking a
    // clip (a speed-up) leaves a gap, and with the magnet on the timeline
    // closes it. ClipPropertiesPanel cannot — it only ever sees the one item,
    // and `collapseGaps` moves that item's SIBLINGS — so the commit handler
    // owns it. Folded into the same transient gesture, so the speed change and
    // the gap it closed undo as one step.
    if (clipDurationChangedRef.current && rippleMode) {
      sync.mutateTransient(p => collapseGaps(p))
    }
    clipDurationChangedRef.current = false
    void sync.commit()
  }
  function applyClipChange(nextItem: VisualItem) {
    previewClipChange(nextItem)
    commitClipChange()
  }

  function replaceAudioTrack(p: P, nextTrack: AudioTrack): P {
    return {
      ...p,
      audio: { ...p.audio, tracks: (p.audio?.tracks ?? []).map(t => (t.id === nextTrack.id ? nextTrack : t)) },
    } as P
  }
  function previewAudioChange(nextTrack: AudioTrack) {
    sync.mutateTransient(p => replaceAudioTrack(p, nextTrack))
  }
  function commitAudioChange() {
    void sync.commit()
  }
  function applyAudioChange(nextTrack: AudioTrack) {
    previewAudioChange(nextTrack)
    commitAudioChange()
  }

  // Commit a per-segment caption change (preview drag → offsetX/offsetY/scale).
  // Routed through `makeCaptionEdit` so there is exactly one project-mutation
  // path for caption edits — it addresses the segment by id and leaves the
  // fields the patch omits alone — and through `sync.mutate` so a finished drag
  // lands as one undo step plus a queued save, same as a timeline caption edit.
  // Only ONE of makeCaptionEdit's two callbacks is supplied: both are invoked
  // with the same updated project, so passing both would mutate twice.
  const handleCaptionSegmentChange = useCallback((segmentId: string, patch: CaptionEditPatch) => {
    makeCaptionEdit(segmentId, syncProjectRef.current, (p) => void syncMutate(() => p as P))(patch)
  }, [syncProjectRef, syncMutate])

  // Delete one caption segment by id — CaptionListPanel's per-row trash
  // button. Captions have no "add" affordance (R4: they come from
  // transcription; Regenerate rebuilds the whole track), so this is the only
  // track-mutating action the sidebar list performs beyond per-segment
  // patches — narrow enough to get its own channel rather than stretching
  // `onCaptionEdit`'s whole-project-commit signature for a single id.
  const handleCaptionSegmentDelete = useCallback((segmentId: string) => {
    const base = syncProjectRef.current
    // Captured into a local rather than re-read as `base.captions` below: a
    // property narrowing does NOT survive into the `syncMutate` closure, since
    // the compiler cannot prove the property was not reassigned in between, so
    // the spread there would widen `style` back to optional and no longer
    // satisfy `Captions`.
    const captions = base.captions
    if (!captions) return
    const segments = captions.segments.filter(s => s.id !== segmentId)
    if (segments.length === captions.segments.length) return
    // `normalizeCaptionLanes` (same call Timeline.tsx's Delete keymap makes)
    // so deleting the LAST caption in a row collapses that hole lane in the
    // same commit, instead of persisting a sparse lane to disk that only the
    // canvas timeline's own Delete key used to close.
    void syncMutate(() => ({ ...base, captions: normalizeCaptionLanes({ ...captions, segments }) } as P))
  }, [syncProjectRef, syncMutate])

  // Selecting a caption from the preview (click the selection box) is just
  // setting the unified selection — `selectedCaptionId` above is DERIVED from
  // `selectedIds`, so there is no second selection model left to keep in
  // sync. `id !== null` replaces the whole array with just that caption
  // (matching a plain, non-additive click anywhere else on the timeline);
  // `null` clears it.
  const handleSelectCaption = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : [])
  }, [])

  // Canvas double-click on a caption (Timeline's `onEditCaption`, Phase 6):
  // selects it exactly like a click would, AND asks the sidebar to scroll to
  // and focus that segment's text field — `nextEditFocus` (CaptionListPanel.tsx)
  // is what makes a second double-click on the same segment re-focus it (see
  // `editFocusId` above for why the bare id can't carry that signal alone).
  // Extracted to a pure, unit-tested function rather than inlined here, since
  // this increment is load-bearing and a source-level test alone can't prove
  // it does the right arithmetic, only that it looks like it does.
  const handleEditCaption = useCallback((id: string) => {
    handleSelectCaption(id)
    setEditFocusId(prev => nextEditFocus(prev, id))
  }, [handleSelectCaption])

  function handleSplit(at?: number) {
    const base = syncProjectRef.current
    const time = at ?? clock.get()
    // With nothing selected, split ONLY the main video track (tracks[0]) at
    // `time` — NOT every track under it. Passing `null` to `splitAtTime`
    // razors every visual track AND every audio track at once, which is not
    // what "Split with nothing selected" should do (Sam: main track only). So
    // resolve the base-track clip under `time` and scope the split to its id;
    // if nothing on the main track sits under `time`, there's nothing to split
    // — a no-op, rather than cutting overlays/audio too.
    let targetId = primarySelectedId ?? null
    if (targetId === null) {
      const mainItem = (trackItems(base)[0] ?? []).find(it => time > it.start && time < it.end)
      if (!mainItem) return
      targetId = mainItem.id
    }
    let updated = splitAtTime(base, time, targetId)
    if (updated === base) return
    // `splitAtTime` reaches `applyCutToCaptions`, which can DROP a caption
    // segment at the cut instead of splitting it; dropping a row's last
    // caption leaves a hole lane, so densify in the same commit — same guard
    // `handleRippleDelete` uses, and free when nothing changed
    // (`normalizeCaptionLanes` returns the same reference).
    if (updated.captions) {
      const dense = normalizeCaptionLanes(updated.captions)
      if (dense !== updated.captions) updated = { ...updated, captions: dense } as P
    }
    void sync.mutate(() => updated as P)
  }

  function handleRippleToggle() {
    const next = !rippleMode
    setRippleMode(next)
    if (next) {
      const base = syncProjectRef.current
      const collapsed = collapseGaps(base)
      if (collapsed !== base) void sync.mutate(() => collapsed as P)
    }
  }

  // Ripple-delete the primary selection (T8's `rippleDelete`) — Shift+Delete
  // and the palette's "Ripple-delete selection" entry. Goes through
  // `sync.mutate` directly (one undo step, one queued save), the same commit
  // path every other destructive edit in this surface uses (handleSplit,
  // handleRippleToggle above).
  function handleRippleDelete() {
    if (!primarySelectedId) return
    const base = syncProjectRef.current
    let updated = rippleDelete(base, primarySelectedId)
    if (updated === base) return
    // `rippleDelete` reaches `applyCutToCaptions`, which DROPS caption segments
    // falling inside the removed span rather than shifting them. Dropping the last
    // caption in a row leaves a hole lane, so densify in the same commit. Free when
    // nothing changed: `normalizeCaptionLanes` returns the same reference.
    if (updated.captions) {
      const dense = normalizeCaptionLanes(updated.captions)
      if (dense !== updated.captions) updated = { ...updated, captions: dense } as P
    }
    void sync.mutate(() => updated as P)
    setSelectedIds([])
  }

  // Copy the current selection into `clipboardRef` (T2). Visual items and
  // audio tracks only — `copySelection` (clipboard-ops.ts) ignores caption
  // ids by construction. Not a `sync.mutate`: nothing about the project
  // changes, only local clipboard state.
  function handleCopy() {
    if (selectedIds.length === 0) return
    clipboardRef.current = copySelection(syncProjectRef.current, selectedIds)
  }

  // Paste the clipboard at the playhead. One `sync.mutate`, same
  // `if (updated === base) return` no-op guard `handleRippleDelete` uses
  // above. `pasteAt` mints fresh ids for every pasted item, which
  // `collectAllIds` doesn't get back directly — diffing the id sets before
  // and after is what selects the newly pasted items afterward.
  function handlePaste() {
    const payload = clipboardRef.current
    if (!payload) return
    const base = syncProjectRef.current
    const beforeIds = collectAllIds(base)
    const updated = pasteAt(base, payload, clock.get())
    if (updated === base) return
    void sync.mutate(() => updated as P)
    setSelectedIds([...collectAllIds(updated)].filter(id => !beforeIds.has(id)))
  }

  // Duplicate the current selection in place. Same commit + id-diff pattern
  // as `handlePaste` above.
  function handleDuplicate() {
    if (selectedIds.length === 0) return
    const base = syncProjectRef.current
    const beforeIds = collectAllIds(base)
    const updated = duplicateSelection(base, selectedIds)
    if (updated === base) return
    void sync.mutate(() => updated as P)
    setSelectedIds([...collectAllIds(updated)].filter(id => !beforeIds.has(id)))
  }

  // Copy the clipboard's "look" attributes onto every selected item
  // (`pasteAttributes`, clipboard-ops.ts — type-gated per item/track kind).
  // No selection change: unlike paste/duplicate this never creates items.
  function handlePasteAttributes() {
    const payload = clipboardRef.current
    if (!payload || selectedIds.length === 0) return
    const base = syncProjectRef.current
    const updated = pasteAttributes(base, payload, selectedIds)
    if (updated === base) return
    void sync.mutate(() => updated as P)
  }

  const openPalette = useCallback(() => setPaletteOpen('list'), [])
  const openGoToTime = useCallback(() => setPaletteOpen('goto'), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  // Fullscreen preview (T5). `previewRegionRef` is attached to the
  // `previewRegion` wrapper div below — the ONE shared node both editor
  // layouts (CapCut and classic) render, so a single ref/toggle covers both.
  // `isFullscreen` is kept in sync with the REAL fullscreen state via the
  // `fullscreenchange` listener, not just set optimistically on toggle: the
  // browser can exit fullscreen on its own (Escape, tab switch) without ever
  // calling `toggleFullscreen`, and the button/palette label would otherwise
  // go stale. No Escape handling of our own — that's native.
  const previewRegionRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === previewRegionRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void previewRegionRef.current?.requestFullscreen()
  }, [])

  // Social-media preview chrome (mirrors CapCut's "Preview your video for
  // social media" picker) — a viewing aid only, off ("None") by default.
  // Drawn inside the aspect-ratio box (over the video) rather than the
  // controls row below it, by SocialSafeZoneOverlay itself. Persisted into
  // project settings (see handleSocialPreviewChange below) the same way
  // handleImageToneChange persists the HDR image-tone pick — a real user
  // preference, not per-render state, so it survives a reload.
  const [socialPreviewMenuOpen, setSocialPreviewMenuOpen] = useState(false)
  const socialPreviewTriggerRef = useRef<HTMLButtonElement>(null)

  // Command palette. Bindings for split/undo/redo/ripple-delete/palette-open
  // double as their own registry entries here; a few are palette-only
  // (zoom-fit, go-to-time, marker set/clear) — see `paletteCommands` below.
  // Cmd/Ctrl+K, and the J/K/L shuttle, are new to T9 and only ever lived at
  // this ReviewSurface level (same scope split/undo/redo already had — the
  // pending surface has no editing chrome).
  useKeymap([
    {
      id: 'video.split',
      description: 'Split at the playhead, or the preview axis when it is on',
      keyHint: ['S'],
      matches: matchesKey('s'),
      // When the preview axis (⌘A) is on, `S` splits at the AXIS time
      // (`hoverScrub`) rather than the playhead — split where you're looking,
      // as CapCut does. Falls back to the playhead when the axis is off or
      // nothing is being hovered (`get()` is null). Targeting is unchanged:
      // `handleSplit` → `splitAtTime(base, at, primarySelectedId ?? null)`
      // splits the selected item at that time, or the base track when nothing
      // is selected (a no-op if the axis isn't over the item).
      action: () => handleSplit(previewAxis ? (hoverScrub.get() ?? undefined) : undefined),
    },
    {
      id: 'video.undo',
      description: 'Undo',
      keyHint: ['⌘', 'Z'],
      matches: matchesUndo,
      action: () => sync.undo(),
    },
    {
      id: 'video.redo',
      description: 'Redo',
      keyHint: ['⌘', '⇧', 'Z'],
      matches: matchesRedo,
      action: () => sync.redo(),
    },
    {
      id: 'video.ripple-delete',
      description: 'Ripple-delete selection',
      keyHint: ['⇧', 'Delete'],
      matches: matchesShiftDelete,
      guard: () => !!primarySelectedId,
      action: () => handleRippleDelete(),
    },
    {
      // `preventDefault: false` so the browser's own text copy is untouched —
      // this only ever ADDS a project-level copy on top, it never replaces
      // whatever native selection copy would otherwise do.
      id: 'video.copy',
      description: 'Copy selection',
      keyHint: ['⌘', 'C'],
      matches: matchesModKey('c'),
      guard: () => selectedIds.length > 0,
      preventDefault: false,
      action: () => handleCopy(),
    },
    {
      // MUST be registered before `video.paste`: `matchesModKey('v')` does
      // NOT exclude `altKey`, so Cmd+Opt+V matches BOTH this binding and the
      // plain-paste one below — first match wins, so paste-attributes has to
      // come first or Cmd+Opt+V would silently fall through to a plain paste.
      // See keymap.ts's `matchesModAltKey` doc comment for the same note.
      id: 'video.paste-attributes',
      description: 'Paste attributes',
      keyHint: ['⌘', '⌥', 'V'],
      matches: matchesModAltKey('v'),
      guard: () => !!clipboardRef.current && selectedIds.length > 0,
      action: () => handlePasteAttributes(),
    },
    {
      id: 'video.paste',
      description: 'Paste',
      keyHint: ['⌘', 'V'],
      matches: matchesModKey('v'),
      guard: () => !!clipboardRef.current,
      action: () => handlePaste(),
    },
    {
      id: 'video.duplicate',
      description: 'Duplicate selection',
      keyHint: ['⌘', 'D'],
      matches: matchesModKey('d'),
      guard: () => selectedIds.length > 0,
      action: () => handleDuplicate(),
    },
    {
      id: 'video.fullscreen',
      description: 'Toggle fullscreen preview',
      keyHint: ['F'],
      matches: matchesPlainKey('f'),
      action: () => toggleFullscreen(),
    },
    {
      // A for Axis. CapCut binds this to plain `S`, which Split owns here —
      // and `video.split` is `matchesKey('s')`, a bare key test with no
      // modifier check (deliberately: it reproduces the pre-keymap split
      // handler verbatim), so any S-based chord would be swallowed by it.
      //
      // `matchesModKey` is meta-OR-ctrl (keymap.ts's `mod`), so this is Cmd+A
      // and Ctrl+A alike. That shadows the browser's Select All, which this
      // surface has no use for — and only outside a typing surface: every
      // binding sits behind `isTypingTarget`, so Cmd+A in a caption, an input,
      // or a textarea still selects text natively.
      id: 'video.preview-axis',
      description: 'Toggle preview axis',
      keyHint: ['⌘', 'A'],
      matches: matchesModKey('a'),
      action: () => setPreviewAxis(v => !v),
    },
    {
      id: 'video.open-palette',
      description: 'Open command palette',
      keyHint: ['⌘', 'K'],
      matches: matchesModKey('k'),
      guard: () => !paletteOpen,
      action: () => openPalette(),
      paletteHidden: true,
    },
    {
      id: 'video.shuttle-forward',
      description: 'Shuttle forward',
      keyHint: ['L'],
      matches: matchesPlainKey('l'),
      action: () => shuttle.press(1),
      paletteHidden: true,
    },
    {
      id: 'video.shuttle-backward',
      description: 'Shuttle backward',
      keyHint: ['J'],
      matches: matchesPlainKey('j'),
      action: () => shuttle.press(-1),
      paletteHidden: true,
    },
    {
      id: 'video.shuttle-stop',
      description: 'Stop shuttle',
      keyHint: ['K'],
      matches: matchesPlainKey('k'),
      action: () => shuttle.stop(),
      paletteHidden: true,
    },
  // No `modalOpen` gating here — split/undo/redo never had a modal guard
  // (see the file-header note above `anyModalOpen`), and RenderModal being
  // open mid-render is a real flow that still needs Cmd+Z to work (the
  // existing "undo restores the pre-mutation project" test drives exactly
  // that: click Render → RenderModal opens → Cmd+Z must still undo). The
  // typing-surface guard alone (shared by every binding, unconditionally)
  // already keeps these from firing while the palette's own filter input has
  // focus — modal-gating would only add protection for the edge case of a
  // dialog open with focus OUTSIDE it, which isn't worth the regression risk.
  ])

  // The palette's command list — split/undo/redo/ripple-delete/play-pause
  // read live state so entries only appear when they'd actually do
  // something (no selection → no ripple-delete row; nothing to undo → no
  // undo row). Zoom-fit routes through `timelineActionsRef` (Timeline-local
  // state — see Timeline.tsx's `TimelineActions`). Roll/slip/
  // slide are drag gestures and deliberately have no palette variant.
  const paletteCommands: PaletteCommand[] = [
    { id: 'play-pause', label: 'Play/Pause', keyHint: ['Space'], run: () => transportRef.current?.togglePlay() },
    { id: 'split', label: 'Split at playhead', keyHint: ['S'], run: () => handleSplit() },
  ]
  if (primarySelectedId) {
    paletteCommands.push({ id: 'ripple-delete', label: 'Ripple-delete selection', keyHint: ['⇧', 'Delete'], run: () => handleRippleDelete() })
  }
  if (selectedIds.length > 0) {
    paletteCommands.push({ id: 'copy', label: 'Copy', keyHint: ['⌘', 'C'], run: () => handleCopy() })
    paletteCommands.push({ id: 'duplicate', label: 'Duplicate', keyHint: ['⌘', 'D'], run: () => handleDuplicate() })
  }
  if (clipboardRef.current) {
    paletteCommands.push({ id: 'paste', label: 'Paste', keyHint: ['⌘', 'V'], run: () => handlePaste() })
    if (selectedIds.length > 0) {
      paletteCommands.push({ id: 'paste-attributes', label: 'Paste attributes', keyHint: ['⌘', '⌥', 'V'], run: () => handlePasteAttributes() })
    }
  }
  if (sync.canUndo) paletteCommands.push({ id: 'undo', label: 'Undo', keyHint: ['⌘', 'Z'], run: () => sync.undo() })
  if (sync.canRedo) paletteCommands.push({ id: 'redo', label: 'Redo', keyHint: ['⌘', '⇧', 'Z'], run: () => sync.redo() })
  paletteCommands.push({
    id: 'preview-axis',
    label: previewAxis ? 'Preview axis: turn off' : 'Preview axis: turn on',
    keyHint: ['⌘', 'A'],
    run: () => setPreviewAxis(v => !v),
  })
  paletteCommands.push({
    id: 'fullscreen',
    label: isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen',
    keyHint: ['F'],
    run: () => toggleFullscreen(),
  })
  paletteCommands.push({ id: 'zoom-fit', label: 'Zoom to fit', run: () => timelineActionsRef.current?.zoomFit() })
  paletteCommands.push({ id: 'goto', label: 'Go to time…', run: () => openGoToTime() })
  if (handleAudioPolish) {
    paletteCommands.push({ id: 'audio-polish', label: 'Polish audio…', run: () => handleAudioPolish() })
  }

  async function handleRestoreVersion(hash: string) {
    if (!adapter.restoreVersion) return
    setRestoring(hash)
    try {
      const restored = await adapter.restoreVersion(project.id, hash)
      // Server-authored, already persisted — apply without a save or undo push.
      sync.applyExternal(restored)
    } catch (e) {
      console.error(e)
    } finally {
      setRestoring(null)
      await refreshVersions()
    }
  }

  async function handleSaveVersion(name?: string) {
    if (!adapter.saveVersion) return
    setSaving(true)
    try {
      await adapter.saveVersion(project.id, name)
      await refreshVersions()
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  function handleCompareVersion(hash: string) {
    setCompareOpen(hash)
  }

  // ── Shared layout pieces ─────────────────────────────────────────────────
  // The preview, row divider, timeline pane and right rail are identical in both
  // layouts; only their arrangement differs (classic column vs. CapCut top-row +
  // full-width timeline). Factoring them into local render values keeps the
  // classic path byte-for-byte unchanged and lets the CapCut branch reuse the
  // exact same nodes rather than duplicating this JSX.

  // The preview column: video area on top, a slim controls row on chrome
  // underneath it. `previewRegionRef` stays on this outermost node — it is
  // both the fullscreen target and the one shared node both editor layouts
  // render, and keeping the controls row INSIDE it means the row is still
  // reachable once fullscreened (a bare video with no chrome at all would
  // leave fullscreen viewers with no way back out except Escape).
  //
  // The fullscreen button used to be a 28px corner overlay on the video
  // itself (`absolute top-2 right-2`, bg-black/50 for contrast against
  // whatever frame happened to be playing) — invisible on bright footage
  // and competing with the picture. It now lives as a normal child of this
  // row, on chrome, sized and styled like every other row button below
  // (the track-controls bar's Ripple/Crop toggles) rather than floating.
  const previewRegion = (
    <div ref={previewRegionRef} className="flex-1 min-h-0 flex flex-col bg-black overflow-hidden">
      {hasContent ? (
        <>
          <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden p-2">
            <div
              className="relative h-full max-w-full"
              style={{ aspectRatio: (() => { const [w, h] = getOverlayDesignCanvas(project.settings?.resolution); return `${w} / ${h}` })() }}
            >
              <PreviewPlayer
                project={project}
                clock={clock}
                selectedOverlayId={primarySelectedId ?? undefined}
                onOverlayChange={handleOverlayChange}
                onEditOverlay={requestEditOverlay}
                compileOverlay={adapter.compileOverlay}
                clearOverlayCache={adapter.clearOverlayCache}
                watchFile={adapter.watchFile}
                fileUrl={adapter.fileUrl}
                resolveCaptionTemplate={adapter.resolveCaptionTemplate}
                selectedCaptionId={selectedCaptionId ?? undefined}
                onSelectCaption={handleSelectCaption}
                onCaptionSegmentChange={handleCaptionSegmentChange}
                engine={engine}
                transportRef={transportRef}
                scrubHandleRef={scrubHandleRef}
                hoverScrub={hoverScrub}
                // Social-media preview chrome (mirrors CapCut's "Preview your
                // video for social media" picker) — it previews what platform
                // UI would sit ON TOP of the picture, so PreviewPlayer mounts
                // it INSIDE its own preview surface (same coordinate space AND
                // stacking context as the picture, rather than as a sibling
                // here) — see the `socialPreview` prop doc on
                // PreviewPlayerProps. "None" (null) by default; the component
                // itself no-ops on an unset/unknown platform.
                socialPreview={currentSocialPreview ?? undefined}
              />
              {/* Footage-bin source scrub (opt-in). A paused <video> parked above the
                  timeline preview, showing an OFF-TIMELINE clip's frame while the
                  host hovers a bin card. Inert unless a host supplies `sourcePreview`
                  AND sets a value — see SourcePreviewOverlay / source-preview.ts. */}
              <SourcePreviewOverlay store={sourcePreview} />
            </div>
          </div>
          {/* Preview controls row — chrome, not video. Timecode readout on the
              left; zoom-to-fit, safe-zone preview and fullscreen on the right,
              styled like the track-controls bar's toggles below (Ripple/Crop):
              w-5 h-5 icon buttons, `aria-pressed` colouring for true toggles,
              a styled `Tooltip` on every button instead of a native `title=`. */}
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
            <span
              data-testid="preview-timecode"
              className="mr-auto text-[10px] font-mono tabular-nums text-[var(--editor-text)]/60 select-none"
            >
              {/* The playhead can sit past `previewDuration` while parked in
                  `getTotalDuration()`'s ~20% trailing headroom (drag room for
                  the timeline canvas) — clamp the DISPLAYED current time only,
                  so the readout never shows e.g. "1:10.0 / 1:00.0". The clock
                  itself and the total are untouched. */}
              {formatTimecode(Math.min(currentTime, previewDuration))} / {formatTimecode(previewDuration)}
            </span>
            {/* Zoom-to-fit lives in the timeline zoom chrome ("fit" next to the
                +/- zoom buttons, Timeline.tsx) — no duplicate control here. */}
            <Tooltip label="Preview for social media">
              <button
                ref={socialPreviewTriggerRef}
                onClick={() => setSocialPreviewMenuOpen(v => !v)}
                aria-label="Preview for social media"
                aria-haspopup="menu"
                aria-expanded={socialPreviewMenuOpen}
                aria-pressed={currentSocialPreview !== null}
                className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
                  currentSocialPreview !== null
                    ? 'text-sky-400 bg-sky-400/15 hover:bg-sky-400/25'
                    : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
                }`}
              >
                {/* Trigger reflects the active selection: the platform's own
                    glyph (TikTok/YouTube/Instagram) once one is picked, the
                    plain Smartphone icon otherwise. */}
                {activeSocialPreviewOption
                  ? <PlatformGlyph icon={activeSocialPreviewOption.icon} badgeClassName={activeSocialPreviewOption.badgeClassName} size={14} />
                  : <Smartphone size={12} />}
              </button>
            </Tooltip>
            {socialPreviewMenuOpen && (
              <SocialPreviewMenu
                anchorRef={socialPreviewTriggerRef}
                value={currentSocialPreview}
                onChange={handleSocialPreviewChange}
                onClose={() => setSocialPreviewMenuOpen(false)}
              />
            )}
            <Tooltip label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} keys={['F']}>
              <button
                onClick={toggleFullscreen}
                aria-label="Toggle fullscreen"
                aria-pressed={isFullscreen}
                className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]"
              >
                {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            </Tooltip>
          </div>
        </>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center p-2">
          <p className="text-[var(--editor-text)]/60 text-sm">No clips</p>
        </div>
      )}
    </div>
  )

  // The divider. `row-resize` plus a hairline that lights up on hover is the
  // whole affordance — a 5px hit area is comfortable to grab without stealing a
  // visible row from either pane. Double-click restores the default split.
  const rowDivider = (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize timeline"
      onMouseDown={startSplitDrag}
      onDoubleClick={() => setTimelinePaneHeight(DEFAULT_TIMELINE_PANE_PX)}
      className="group shrink-0 h-[5px] cursor-row-resize bg-transparent"
    >
      <div className="h-px w-full bg-[var(--editor-border)] transition-colors group-hover:bg-[var(--editor-accent)]" />
    </div>
  )

  // Timeline pane — the half the divider sizes.
  const timelinePane = (
    <div className="shrink-0 flex flex-col overflow-hidden" style={{ height: timelinePaneHeight }}>

      {/* Track controls bar — controls + undo/redo + preview axis + ripple +
          crop + render. Split is deliberately NOT here: it is a one-key verb
          (S, listed in the controls modal), and a glyph for it only crowded a
          row whose other buttons are modes you can't type your way into.
          Every button carries a styled `Tooltip` instead of a native `title=`:
          the native one is delayed ~1s and rendered in OS chrome, which on a
          row of 12px glyphs meant the affordances were effectively unlabelled.
          `aria-label` stays on each button — the tooltip is a hover affordance,
          not an accessible name. Disabled buttons get `pointer-events-none` so
          hover still reaches the wrapper and can explain WHY they're disabled,
          and fade to 50% rather than 30%: at 30% a 12px glyph on this surface
          reads as ABSENT, and Crop is disabled whenever no clip is selected —
          which is most of the time, so the control looked like it had been
          removed rather than like it was waiting on a selection. */}
      <div className="shrink-0 flex items-center justify-end gap-1.5 px-3 py-1 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
        <Tooltip label="Controls & shortcuts" className="mr-auto">
          <button
            onClick={() => setShowControls(true)}
            aria-label="Editor controls & shortcuts"
            className="flex items-center gap-1 px-1.5 h-5 rounded transition-colors text-[var(--editor-text)]/75 bg-transparent hover:text-[var(--editor-text)] hover:bg-[var(--editor-text)]/10"
          >
            <HelpCircle size={14} />
            <span className="text-[10px] leading-none">Controls</span>
          </button>
        </Tooltip>
        <Tooltip label="Undo" keys={['⌘', 'Z']}>
          <button
            onClick={sync.undo}
            disabled={!sync.canUndo}
            aria-label="Undo"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)] disabled:opacity-50 disabled:pointer-events-none"
          >
            <Undo2 size={12} />
          </button>
        </Tooltip>
        <Tooltip label="Redo" keys={['⌘', '⇧', 'Z']}>
          <button
            onClick={sync.redo}
            disabled={!sync.canRedo}
            aria-label="Redo"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)] disabled:opacity-50 disabled:pointer-events-none"
          >
            <Redo2 size={12} />
          </button>
        </Tooltip>
        <Tooltip label={previewAxis ? 'Preview axis on — hover to preview' : 'Preview axis off'} keys={['⌘', 'A']}>
          <button
            onClick={() => setPreviewAxis(v => !v)}
            aria-label="Preview axis"
            aria-pressed={previewAxis}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
              previewAxis
                ? 'text-yellow-400 bg-yellow-400/15 hover:bg-yellow-400/25'
                : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
            }`}
          >
            <SeparatorVertical size={12} />
          </button>
        </Tooltip>
        <Tooltip label={rippleMode ? 'Ripple on — gaps close' : 'Ripple: close the gap'}>
          <button
            onClick={handleRippleToggle}
            aria-label="Ripple mode"
            aria-pressed={rippleMode}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
              rippleMode
                ? 'text-teal-400 bg-teal-400/15 hover:bg-teal-400/25'
                : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
            }`}
          >
            <Magnet size={12} />
          </button>
        </Tooltip>
        <Tooltip
          label={!cropTarget ? 'Select a clip to crop' : cropMode ? 'Exit crop' : 'Crop source'}
        >
          <button
            onClick={() => setCropMode(m => !m)}
            disabled={!cropTarget}
            aria-label="Crop source"
            aria-pressed={cropMode}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors disabled:opacity-50 disabled:pointer-events-none ${
              cropMode
                ? 'text-amber-400 bg-amber-400/15 hover:bg-amber-400/25'
                : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
            }`}
          >
            <Crop size={12} />
          </button>
        </Tooltip>
        {selectedOverlayItem && (
          <Tooltip label="Edit overlay">
            <button
              onClick={() => requestEditOverlay(selectedOverlayItem.id)}
              aria-label="Edit overlay"
              className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]"
            >
              <Pencil size={12} />
            </button>
          </Tooltip>
        )}
        {/* Image color mapping. HDR projects only (the tone has no effect on
            SDR renders). Hidden when the host surfaces the setting in its own
            chrome via onProvideImageTone, mirroring the Render button. */}
        {!onProvideImageTone && isHdrProject && (
          <ImageToneMenu
            value={currentImageTone}
            onChange={handleImageToneChange}
          />
        )}
        {/* Audio polish — silence/fillers/loudness/voice cleanup. Hidden when the
            host adapter doesn't implement `analyzeAudioPolish`, exactly like the
            caption-regen entry point above. */}
        {handleAudioPolish && (
          <Tooltip label="Polish audio">
            <button
              onClick={handleAudioPolish}
              aria-label="Polish audio"
              className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]"
            >
              <Wand2 size={12} />
            </button>
          </Tooltip>
        )}
        {/* Audible drag-scrub toggle — sits next to Polish audio as the
            other audio tool in this row (moved out of the preview's
            controls row, which is chrome, not editing tools). */}
        <Tooltip label={currentAudibleScrub ? 'Mute drag-scrub audio' : 'Unmute drag-scrub audio'}>
          <button
            onClick={() => handleAudibleScrubChange(!currentAudibleScrub)}
            aria-label="Toggle audible drag-scrub"
            aria-pressed={currentAudibleScrub}
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]"
          >
            {currentAudibleScrub ? <Ear size={12} /> : <EarOff size={12} />}
          </button>
        </Tooltip>
        {/* Default placement. A host that sets onProvideRenderTrigger renders
            Render in its own chrome instead, so the toolbar button is hidden. */}
        {!onProvideRenderTrigger && (
          <button
            onClick={openRender}
            className="text-xs px-2.5 py-1 rounded-md bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] hover:opacity-90 transition-colors"
          >
            Render →
          </button>
        )}
      </div>

      {/* `data-timeline-scroll`: the canvas timeline measures against this
          viewport to grow its surface down into the empty space below the
          tracks (see TimelineCanvas's pane-fill effect). Its height is fixed by
          the resizable pane, so the measurement never feeds back. */}
      <div data-timeline-scroll className="flex-1 min-h-0 overflow-y-auto border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
        <Timeline
          project={project}
          clock={clock}
          onProjectChange={handleProjectChange}
          onOverlayEdit={commitTimelineEdit}
          previewAxis={previewAxis}
          onHoverScrub={handleHoverScrub}
          selectedIds={selectedIds}
          onSelectIds={setSelectedIds}
          // No `onInspectClip` / `onInspectAudio`: the clip-inspect modal they
          // opened is retired. Single-click selection now populates the right
          // properties panel, so a double-click on a clip/audio bar is simply a
          // no-op. The Timeline props still exist (that is its API) — this
          // editor just has nothing left to do with them.
          onEditCaption={handleEditCaption}
          rippleMode={rippleMode}
          resolveFilePath={resolveFilePath}
          getWaveformPeaks={getWaveformPeaks}
          getFilmstrip={getFilmstrip}
          regenEnabled={regenEnabled}
          isClipQueued={isClipQueued}
          renderSubcutRegen={renderSubcutRegen}
          modalOpen={anyModalOpen}
          onOpenGoToTime={openGoToTime}
          actionsRef={timelineActionsRef}
        />
      </div>
    </div>
  )

  // Assets — dedicated separate column to the LEFT of the version rail
  // (assetsPlacement: 'right'). Classic layouts only.
  const assetsColumn = assetsPlacement === 'right' && slots?.assetsPanel && (
    <div className="w-72 shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden">
      {slots.assetsPanel}
    </div>
  )

  // ── Pieces shared by the two layouts' side columns ────────────────────────
  // The caption editor and the version list live in the CLASSIC right rail and
  // in the CapCut LEFT panel's Captions / Versions tabs. Built once here, with
  // one set of props, so the two layouts can never drift apart — only one of
  // them mounts per render, so sharing the element is free.
  const captionListPanel = (
    <CaptionListPanelWithClock
      captionTrack={project.captions}
      project={project}
      selectedIds={selectedIds}
      onSelectCaption={handleSelectCaption}
      onCaptionSegmentChange={handleCaptionSegmentChange}
      onCaptionEdit={(p) => void sync.mutate(() => p as P)}
      onProjectChange={handleProjectChange}
      onCaptionSegmentDelete={handleCaptionSegmentDelete}
      onRegenerateCaptions={handleRegenerateCaptions}
      // Disables the panel's generate/regenerate trigger for the life of
      // the modal. Defensive rather than load-bearing: CaptionRegenModal
      // is a full-screen blocking portal, so the panel underneath can't
      // be clicked anyway. It keeps the panel honest on its own terms —
      // and re-enables on close, so a failed job never leaves a
      // permanently dead button.
      captionsGenerating={regenCaptionsOpen}
      fps={project.settings?.fps ?? 30}
      clock={clock}
      editFocusId={editFocusId}
    />
  )
  const versionPanel = adapter.listVersionHistory && (
    <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} onSaveVersion={handleSaveVersion} saving={saving} onCompareVersion={adapter.versionFrameUrl ? handleCompareVersion : undefined} />
  )

  // Right rail — CLASSIC LAYOUTS ONLY (Hub / LP). The CapCut layout replaces it
  // with the properties-only `propertiesPanel` below and moves this rail's
  // captions and versions into the left panel's tabs.
  // Version history + run history slot, the sidebar caption list,
  // and (in 'sidebar' placement) the assets panel stacked beneath them in the
  // SAME column (its own col-resize divider is
  // included). `!!project.captions || !!handleRegenerateCaptions` is a new
  // disjunct (SP5-captions Phase 5): CaptionListPanel now lives in this rail
  // instead of a bottom panel, so the rail must appear whenever THAT panel
  // has anything to offer — either existing captions, or (on a host that
  // supports `generateCaptions`) the means to create them from scratch. The
  // second half matters even with zero captions: the retired bottom
  // TranscriptPanel showed "Regenerate" whenever the host supported it,
  // regardless of caption count, and dropping that would make caption
  // generation unreachable from the editor on a bare project with no other
  // rail content.
  // `!!selectedOverlayItem` is a further disjunct (SP9b T3.2): the overlay
  // inspector below lives in this same rail, so the rail must appear whenever
  // an overlay is selected — even on a project with no versions, captions, or
  // assets to otherwise justify the rail's existence.
  const rightRail = (adapter.listVersionHistory || slots?.runHistory ||
    (assetsPlacement === 'sidebar' && slots?.assetsPanel) ||
    !!project.captions || !!handleRegenerateCaptions || !!selectedOverlayItem) && (
    <>
      {/* Vertical divider, the same affordance as the preview/timeline one. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={startRailDrag}
        onDoubleClick={() => setRailWidth(DEFAULT_RAIL_PX)}
        className="group shrink-0 w-[5px] cursor-col-resize bg-transparent"
      >
        <div className="w-px h-full bg-[var(--editor-border)] transition-colors group-hover:bg-[var(--editor-accent)]" />
      </div>

      <div
        style={{ width: railWidth }}
        className="shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden"
      >

        {/* SP9b T3.2 — numeric property fields + per-property keyframe
            diamonds for the selected overlay's transform props. Above
            VersionPanel: it's the thing the operator is actively editing,
            versions/captions/assets are reference material below it. Renders
            its own "Select an overlay…" empty state when nothing, or a
            non-overlay, is selected. */}
        <OverlayInspector
          item={selectedOverlayItem}
          clock={clock}
          onPreview={previewOverlayInspectorChange}
          onCommit={commitOverlayInspectorChange}
          onChange={applyOverlayInspectorChange}
          onSeek={seekTo}
        />

        {versionPanel}

        {/* Sidebar caption editor, directly below version history. Its own
            flex-1 wrapper so the list scrolls independently of the rest of
            the rail — mirrors the assetsPanel wrapper just below. Gated the
            same way that one is: nothing to show, nothing rendered, rather
            than an empty bordered box (CaptionListPanel has its own internal
            guard too, for callers that can't check this ahead of time). */}
        {(project.captions || handleRegenerateCaptions) && (
          <div className="flex-1 min-h-0 overflow-hidden border-t border-[var(--editor-border)] flex flex-col">
            {captionListPanel}
          </div>
        )}
        {/* Host injects the Montaj-flavored "Previous runs" snapshot list here.
            RunSnapshot / project.history are host-only types — the package never
            reads them. When absent nothing is rendered. */}
        {slots?.runHistory}
        {/* Assets stacked below versions/runs (assetsPlacement: 'sidebar'). The
            host's panel manages its own scroll; flex-1 lets it take the
            remaining rail height. A top border separates it from the runs. */}
        {assetsPlacement === 'sidebar' && slots?.assetsPanel && (
          <div className="flex-1 min-h-0 overflow-hidden border-t border-[var(--editor-border)] flex flex-col">
            {slots.assetsPanel}
          </div>
        )}
      </div>
    </>
  )

  // Project media / assets — full-width region stacked BELOW the editor
  // (assetsPlacement: 'bottom'). Classic layouts only.
  const bottomAssets = assetsPlacement === 'bottom' && slots?.assetsPanel && (
    <div className="shrink-0 border-t border-[var(--editor-border)] w-full flex flex-col max-h-[45%] overflow-hidden">
      {slots.assetsPanel}
    </div>
  )

  // Left panel (CapCut layout only): the editor's browser column — Media,
  // Captions and Versions behind a vertical icon rail — in a width-resizable
  // column, with a col-resize divider on its RIGHT edge. Captions and version
  // history used to stack into the right rail; in this layout that rail is
  // properties-only, so they live here now. Each tab is added only when it has
  // something to show, so the rail never offers a dead icon.
  const leftPanelTabs: LeftPanelTab[] = []
  if (slots?.mediaPanel) {
    leftPanelTabs.push({ id: 'media', label: 'Media', icon: <Film size={16} />, content: slots.mediaPanel })
  }
  // Same gate the classic rail uses for its caption section — existing
  // captions, or (on a host that supports `generateCaptions`) the means to
  // create them from scratch.
  if (project.captions || handleRegenerateCaptions) {
    leftPanelTabs.push({
      id: 'captions',
      label: 'Captions',
      icon: <Captions size={16} />,
      // The same flex-1 wrapper the rail gives it, minus the rail's top
      // border: inside a tab panel there is nothing above to divide from.
      content: <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{captionListPanel}</div>,
    })
  }
  if (adapter.listVersionHistory || slots?.runHistory) {
    leftPanelTabs.push({
      id: 'versions',
      label: 'Versions',
      icon: <History size={16} />,
      content: (
        <>
          {versionPanel}
          {/* The host's "Previous runs" list, directly beneath version history —
              the same adjacency it had in the rail. RunSnapshot / project.history
              are host-only types; the package never reads them. */}
          {slots?.runHistory}
        </>
      ),
    })
  }

  const leftPanel = (
    <>
      <div
        style={{ width: mediaPanelWidth }}
        className="shrink-0 border-r border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden min-h-0"
      >
        <LeftPanelTabs tabs={leftPanelTabs} defaultTabId="captions" className="flex-1 min-h-0" />
      </div>
      {/* Divider on the left panel's RIGHT edge — drag right widens the column.
          Kept under its original "Resize media panel" name: it is the same
          affordance on the same persisted width, and renaming it would break
          every host/test that reaches for it. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize media panel"
        onMouseDown={startMediaPanelDrag}
        onDoubleClick={() => setMediaPanelWidth(DEFAULT_MEDIA_PANEL_PX)}
        className="group shrink-0 w-[5px] cursor-col-resize bg-transparent"
      >
        <div className="w-px h-full bg-[var(--editor-border)] transition-colors group-hover:bg-[var(--editor-accent)]" />
      </div>
    </>
  )

  // Right properties panel (CapCut layout only) — the contextual inspector for
  // whatever is selected, in place of the classic stacked rail.
  //
  // ALWAYS rendered, never gated on the selection (Sam): a column that came and
  // went would resize the preview every time the operator clicked from a clip
  // to empty space, so it holds its width and each panel shows its own empty
  // state instead. That is also why there is no third "nothing selected" node
  // here — OverlayInspector already has one, and inventing another would give
  // the same column two different ways of saying nothing is selected.
  const propertiesPanel = (
    <>
      {/* Vertical divider, the same affordance as the preview/timeline one. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={startRailDrag}
        onDoubleClick={() => setRailWidth(DEFAULT_RAIL_PX)}
        className="group shrink-0 w-[5px] cursor-col-resize bg-transparent"
      >
        <div className="w-px h-full bg-[var(--editor-border)] transition-colors group-hover:bg-[var(--editor-accent)]" />
      </div>

      <div
        style={{ width: railWidth }}
        className="shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden"
      >
        {/* Scrolls as one: both panels are stacks of shrink-0 sections, and the
            audio track's fades/ducking groups (or a tall generationSlot) run
            past the bottom of a short window. */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          {clipSelection ? (
            <ClipPropertiesPanel
              selection={clipSelection}
              onPreviewClip={previewClipChange}
              onCommitClip={commitClipChange}
              onChangeClip={applyClipChange}
              onPreviewAudio={previewAudioChange}
              onCommitAudio={commitAudioChange}
              onChangeAudio={applyAudioChange}
              // The host's generation panel is per-CLIP — it draws that clip's
              // prompt/model/refImages — so the editor, which owns the
              // selection, resolves the node here rather than taking a static
              // one the host would have to track selection to build. Video
              // only: generation does not exist on an image clip or an audio
              // track, the same reason the panel hides Speed for non-video.
              // KEYED ON THE CLIP ID, and that key is load-bearing. The host's
              // panel seeds its regen form (prompt, model, duration, ref
              // images) from the clip in `useState` initializers, which run
              // ONCE per mount. Selecting a different video clip keeps
              // `clipSelection.kind === 'clip'`, so without a key React
              // reconciles this subtree IN PLACE and the form keeps the
              // PREVIOUS clip's content while `clipId` points at the new one —
              // queueing a regeneration that spends credits rendering the
              // wrong clip's prompt. The retired modal never hit this because
              // it remounted on every double-click. Keying here rather than in
              // the host means every host gets that guarantee from the seam
              // itself instead of having to know about it.
              generationSlot={
                clipSelection.kind === 'clip' && clipSelection.item.type === 'video'
                  ? <Fragment key={clipSelection.item.id}>{renderGenerationPanel?.({ clipId: clipSelection.item.id })}</Fragment>
                  : undefined
              }
            />
          ) : (
            /* An overlay's Transform properties — or, with nothing selected,
               this component's own empty state. */
            <OverlayInspector
              item={selectedOverlayItem}
              clock={clock}
              onPreview={previewOverlayInspectorChange}
              onCommit={commitOverlayInspectorChange}
              onChange={applyOverlayInspectorChange}
              onSeek={seekTo}
            />
          )}
        </div>
      </div>
    </>
  )

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {slots?.mediaPanel ? (
        /* CapCut layout (opt-in via slots.mediaPanel): three columns across the
           top — [left panel | preview | properties] — with a full-width timeline
           strip below. `splitRef` wraps the WHOLE top-row + timeline region so the
           row divider trades height between them (MIN_PREVIEW_PANE_PX now guards
           the entire top row); `workAreaRef` is the top row, so the rail/media
           width drags still measure against the space those three columns share.
           `previewRegion` / `timelinePane` / `rowDivider` are the exact same nodes
           the classic layout renders. The two side columns are NOT shared: this
           layout browses (media/captions/versions) on the left and inspects the
           selection on the right, where the classic layout stacks all of it into
           one right rail. */
        <div ref={splitRef} className="flex flex-col flex-1 overflow-hidden min-h-0">
          <div ref={workAreaRef} className="flex flex-1 overflow-hidden min-h-0">
            {leftPanel}
            {previewRegion}
            {propertiesPanel}
          </div>
          {rowDivider}
          {timelinePane}
        </div>
      ) : (
      /* Classic layout — byte-for-byte the pre-media-panel editor (Hub / LP). */
      <>
      {/* Work area — editor body + version rail, side by side */}
      <div ref={workAreaRef} className="flex flex-1 overflow-hidden min-h-0">
      {/* Main: preview + timeline, split by a draggable divider. The preview
          takes whatever the timeline pane does not — so dragging the divider up
          trades preview area for timeline area and vice versa. */}
      <div ref={splitRef} className="flex flex-col flex-1 overflow-hidden">
        {previewRegion}

        {rowDivider}

        {timelinePane}
      </div>

      {/* Assets — dedicated separate column to the LEFT of the version rail
          (assetsPlacement: 'right', two distinct columns). The Montaj-local OS
          layout uses 'sidebar' instead (stacked into the version rail below).
          The host's panel manages its own scroll. */}
      {assetsColumn}

      {/* Right rail — version history + run history slot, and (in 'sidebar'
          placement) the assets panel stacked beneath them in the SAME column.
          This is the historical Montaj-local OS layout: versions on top, assets
          right below, one column — not a separate assets column. */}
      {rightRail}
      </div>

      {/* Project media / assets — full-width region stacked BELOW the editor
          (assetsPlacement: 'bottom'). Preferred by width-constrained hosts (Hub).
          The host's panel manages its own scroll. */}
      {bottomAssets}
      </>
      )}

      {/* Source-crop modal — drag-to-pan, aspect presets, zoom. Commits
          sourceCrop (+ source dims) to the selected tracks[0] video on Apply. */}
      {cropMode && cropTarget && (
        <VideoSourceCropModal
          item={cropTarget}
          // Prefer the conformed per-window cache (short, starts at the clip's
          // first frame → loads instantly and shows a representative frame).
          // Falls back to the bg-removed proxy, then the raw source.
          resolveSrc={(it) => adapter.fileUrl(it.nobg_preview_src ?? it.normalizedSrc ?? it.src ?? '')}
          onApply={(next) => handleOverlayChange(cropTarget.id, {
            sourceCrop: {
              x: Math.min(1, Math.max(0, next.x)),
              y: Math.min(1, Math.max(0, next.y)),
              w: Math.min(1, Math.max(0, next.w)),
              h: Math.min(1, Math.max(0, next.h)),
            },
          })}
          onSrcDimsLoaded={(dims) => {
            if (cropTarget.sourceWidth && cropTarget.sourceHeight) return
            handleOverlayChange(cropTarget.id, { sourceWidth: dims.width, sourceHeight: dims.height })
          }}
          onClose={() => setCropMode(false)}
        />
      )}

      {/* Controls & shortcuts reference */}
      {showControls && (
        <ControlsInfoModal
          title="Editor controls"
          sections={VIDEO_CONTROLS}
          onClose={() => setShowControls(false)}
        />
      )}

      {/* Command palette — Cmd/Ctrl+K, or the scrubber's time-readout click
          (opens straight into "go to time"). */}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          initialMode={paletteOpen === 'goto' ? 'goto' : 'list'}
          onGoToTime={(seconds) => clock.set(Math.max(0, Math.min(getTotalDuration(), seconds)))}
          onClose={closePalette}
        />
      )}

      {/* Render modal — adapter.render stream + host export controls */}
      {renderOpen && (
        <RenderModal
          projectId={project.id}
          adapter={adapter}
          exportActions={slots?.exportActions}
          progressView={renderProgressView}
          preRenderOptions={preRenderOptions}
          onClose={() => setRenderOpen(false)}
          onCancel={() => setRenderOpen(false)}
          onRenderComplete={() => { void refreshVersions() }}
        />
      )}

      {/* Visual A/B version compare — opened from a VersionPanel entry's
          Compare button. Gated on the adapter capability so a host without
          `versionFrameUrl` never sees an unusable Compare affordance's modal.
          `durationSeconds` reuses `preRenderOptions.durationSec` — the same
          "video spine's last frame" figure RenderModal's export dialog
          already computes, so the scrub slider covers the real project
          length without a second duration pass. */}
      {compareOpen != null && adapter.versionFrameUrl && (
        <VersionCompare
          projectId={project.id}
          versions={listVersions(versions)}
          initialLeftHash={compareOpen}
          frameUrl={adapter.versionFrameUrl}
          durationSeconds={preRenderOptions.durationSec}
          onClose={() => setCompareOpen(null)}
        />
      )}

      {/* Caption regen modal — adapter.generateCaptions stream. On done we patch
          project.captions via applyExternal only. We deliberately do NOT save:
          montaj persists the regenerated captions server-side and the SSE frame
          reconciles, so a saveProject here would double-write. applyExternal keeps
          it out of the undo stack (server-authored, not a user edit). */}
      {regenCaptionsOpen && adapter.generateCaptions && (
        <CaptionRegenModal
          adapter={adapter}
          projectId={project.id}
          existingRowCount={maxCaptionLane(project.captions?.segments ?? []) + 1}
          onClose={() => setRegenCaptionsOpen(false)}
          onDone={(captions) => {
            sync.applyExternal({ ...syncProjectRef.current, captions } as P)
            setRegenCaptionsOpen(false)
          }}
        />
      )}

      {/* Audio polish modal — owns its own transient/commit/discard cycle via
          `sync`'s three primitives, passed individually (not as a `sync` object:
          that's the modal's own prop contract). `project={sync.project}` sources
          the modal's baseline snapshot AND its watch for an external (SSE) frame
          landing over the preview mid-review; it cannot be re-derived from a prop
          that changes as drafts are pushed. */}
      {polishOpen && adapter.analyzeAudioPolish && (
        <AudioPolishModal
          projectId={project.id}
          adapter={adapter}
          project={sync.project}
          selectionIds={selectedIds}
          mutateTransient={sync.mutateTransient}
          commit={sync.commit}
          discardTransient={sync.discardTransient}
          onClose={() => setPolishOpen(false)}
        />
      )}

      {/* Overlay props dialog — edits the selected overlay's primitive props
          (text, colors, numbers, toggles). Opened from the preview double-click,
          the controls bar, or a timeline block. Edits preview live (transient) and
          undo as one step on Save. */}
      {editingOverlayItem && (
        <OverlayPropsModal
          itemProps={editingOverlayItem.props ?? {}}
          fileUrl={adapter.fileUrl}
          uploadFile={(file) => adapter.uploadFile(file, project.id)}
          onPreview={(next) => previewOverlayProps(editingOverlayItem.id, next)}
          onSave={() => commitOverlayEdit()}
          onClose={cancelOverlayEdit}
        />
      )}
    </div>
  )
}

// CaptionListPanel displays the active-segment highlight, so it genuinely
// needs to re-render every tick. Subscribing HERE (rather than inside
// ReviewSurface) keeps that per-tick re-render scoped to this leaf instead of
// the whole review surface (toolbar + timeline + every context consumer) —
// the same reasoning, and the same shape, as Timeline.tsx's
// `TranscriptPanelWithClock` for the now-retired bottom transcript panel.
function CaptionListPanelWithClock({ clock, ...rest }: Omit<CaptionListPanelProps, 'currentTime'>) {
  const currentTime = usePlaybackTime(clock)
  return <CaptionListPanel currentTime={currentTime} clock={clock} {...rest} />
}
