import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop, Info, Magnet, Pencil, Redo2, Undo2 } from 'lucide-react'
import type { Project, VideoEditorProps } from '../types'
import { useProjectSync, type UseProjectSync } from '../state/use-project-sync'
import { VideoSourceCropModal } from '../crop/VideoSourceCropModal'
import ControlsInfoModal, { VIDEO_CONTROLS } from '../ControlsInfoModal'
import { getOverlayDesignCanvas } from './design-canvas'
import { applyTheme, defaultMontajTheme } from '../theme'
import { applyCutToItem, applyCutToTracks, collapseGaps, rippleDelete, splitAtTime } from './cuts'
import { repairCaptionWords } from './captionRepair'
import Timeline, { type TimelineActions } from './timeline/Timeline'
import { computeDerivedTiming } from './timeline/timeline-model'
import { makeCaptionEdit, type CaptionEditPatch } from './timeline/makeCaptionEdit'
import PreviewPlayer, { type TransportHandle } from './preview/PreviewPlayer'
import { createPlaybackClock, type PlaybackClock } from './playback-clock'
import type { OverlayChanges } from './preview/useDragOverlay'
import VersionPanel from './VersionPanel'
import RenderModal from './RenderModal'
import ImageToneMenu from './ImageToneMenu'
import type { ImageTone } from './imageTone'
import CaptionRegenModal from './CaptionRegenModal'
import OverlayPropsModal from './preview/OverlayPropsModal'
import CommandPalette, { type PaletteCommand } from './CommandPalette'
import { createShuttleController } from './shuttle'
import { useKeymap, matchesKey, matchesModKey, matchesPlainKey, matchesRedo, matchesShiftDelete, matchesUndo } from './keymap'

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
  renderClipInspector,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
  onProvideRenderTrigger,
  onProvideImageTone,
  engine,
  timeline,
}: Props<P>) {
  const emit = onProjectChange ?? (() => {})

  // Shared save/undo/SSE core. Created once at the top so there is exactly one
  // subscription per editor and `sync.project` is the single source of truth for
  // both the surface switch and the surface contents. `project` (the prop) is
  // only the initial value — after mount the core owns state and reconciles live
  // frames itself (video-shaped → default plain-replace reconcile).
  const sync = useProjectSync<P>(adapter, project.id, project)

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
  // `applyExternal` — no save, no undo push: this is normalization of loaded
  // data, not a user edit, so it must not dirty the project or contend with the
  // undo stack; the ids persist naturally the next time the operator makes a
  // real edit.
  useEffect(() => {
    const backfilled = backfillCaptionIds(sync.project)
    if (backfilled !== sync.project) sync.applyExternal(backfilled)
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
  const getWaveformChunks = adapter.getWaveformChunks
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
          getWaveformChunks={getWaveformChunks}
          resolveFilePath={resolveFilePath}
          getWaveformPeaks={getWaveformPeaks}
          getFilmstrip={getFilmstrip}
          engine={engine}
          timeline={timeline}
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <ReviewSurface
        sync={sync}
        emit={emit}
        adapter={adapter}
        slots={slots}
        assetsPlacement={assetsPlacement}
        renderProgressView={renderProgressView}
        getWaveformChunks={getWaveformChunks}
        resolveFilePath={resolveFilePath}
        getWaveformPeaks={getWaveformPeaks}
        getFilmstrip={getFilmstrip}
        renderClipInspector={renderClipInspector}
        renderSubcutRegen={renderSubcutRegen}
        regenEnabled={regenEnabled}
        isClipQueued={isClipQueued}
        onProvideRenderTrigger={onProvideRenderTrigger}
        onProvideImageTone={onProvideImageTone}
        engine={engine}
        timeline={timeline}
      />
    </div>
  )
}

// ── Version-history hook (shared by both surfaces) ───────────────────────────

function useVersionHistory<P extends Project>(adapter: VideoEditorProps<P>['adapter'], project: P) {
  const [versions, setVersions]   = useState<{ hash: string; message: string; timestamp: string }[]>([])
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    adapter.listVersionHistory?.(project.id).then(setVersions).catch(() => {})
  }, [adapter, project.id, project.status])

  return { versions, restoring, setRestoring }
}

// ── Pending / processing surface (former LiveView) ───────────────────────────

interface SurfaceProps<P extends Project> {
  sync: UseProjectSync<P>
  adapter: VideoEditorProps<P>['adapter']
  slots?: VideoEditorProps<P>['slots']
  assetsPlacement?: VideoEditorProps<P>['assetsPlacement']
  renderProgressView?: VideoEditorProps<P>['renderProgressView']
  getWaveformChunks?: VideoEditorProps<P>['adapter']['getWaveformChunks']
  resolveFilePath: (path: string) => string
  getWaveformPeaks?: VideoEditorProps<P>['adapter']['getWaveformPeaks']
  getFilmstrip?: VideoEditorProps<P>['adapter']['getFilmstrip']
  onProvideRenderTrigger?: VideoEditorProps<P>['onProvideRenderTrigger']
  onProvideImageTone?: VideoEditorProps<P>['onProvideImageTone']
  engine?: VideoEditorProps<P>['engine']
  timeline?: VideoEditorProps<P>['timeline']
}

function PendingSurface<P extends Project>({
  sync,
  adapter,
  slots,
  onBackToSetup,
  getWaveformChunks,
  resolveFilePath,
  getWaveformPeaks,
  getFilmstrip,
  engine,
  timeline,
}: SurfaceProps<P> & { onBackToSetup?: () => void }) {
  const project = sync.project
  // The playhead lives in an external store (not useState) so ~60Hz ticks only
  // re-render the leaves that display time — not this whole surface.
  const clockRef = useRef<PlaybackClock | null>(null)
  if (!clockRef.current) clockRef.current = createPlaybackClock()
  const clock = clockRef.current
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { versions, restoring, setRestoring } = useVersionHistory(adapter, project)

  useEffect(() => {
    adapter.getInfo?.().then(info => setSkillPath(info.root_skill_path ?? null)).catch(() => {})
  }, [adapter])

  const clips           = project.tracks?.[0] ?? []
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
    }
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
            getWaveformChunks={getWaveformChunks}
            resolveFilePath={resolveFilePath}
            getWaveformPeaks={getWaveformPeaks}
            getFilmstrip={getFilmstrip}
            timeline={timeline}
          />
        </div>
      </div>

      {/* Right sidebar — version history (hidden when the capability is absent) */}
      {adapter.listVersionHistory && (
        <div className="w-48 shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden">
          <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />
        </div>
      )}
    </div>
  )
}

// ── Draft / final surface (former ReviewView) ────────────────────────────────

function ReviewSurface<P extends Project>({
  sync,
  emit,
  adapter,
  slots,
  assetsPlacement = 'right',
  renderProgressView = 'phases',
  getWaveformChunks,
  resolveFilePath,
  getWaveformPeaks,
  getFilmstrip,
  renderClipInspector,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
  onProvideRenderTrigger,
  onProvideImageTone,
  engine,
  timeline,
}: SurfaceProps<P> & {
  emit: (p: P) => void
  renderClipInspector?: VideoEditorProps<P>['renderClipInspector']
  renderSubcutRegen?: VideoEditorProps<P>['renderSubcutRegen']
  regenEnabled?: boolean
  isClipQueued?: (itemId: string) => boolean
}) {
  const project = sync.project
  // Playhead in an external store, not useState — ~60Hz ticks re-render only the
  // leaves that display time (preview, scrubber, transcript) instead of the whole
  // review surface (toolbar + timeline + every context consumer).
  const clockRef = useRef<PlaybackClock | null>(null)
  if (!clockRef.current) clockRef.current = createPlaybackClock()
  const clock = clockRef.current
  // Multi-select: all currently-selected timeline item ids. Single-select
  // consumers (canvas preview, cut/split) use selectedIds[0] as the primary.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const primarySelectedId = selectedIds[0] ?? null
  // Selected caption segment id. Deliberately owned here rather than inside the
  // preview: it is shared selection state. The preview draws the selection box /
  // drag handles for it, and the timeline's caption row (later task) highlights
  // and seeks to the same segment — that sibling only needs `selectedCaptionId`
  // and `setSelectedCaptionId` passed down, no lifting required.
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null)
  const [rippleMode, setRippleMode]   = useState(false)
  const [showControls, setShowControls] = useState(false)
  // Source-crop mode: when on, the VideoSourceCropModal opens for the selected
  // tracks[0] video item. Cleared when selection changes.
  const [cropMode, setCropMode]       = useState(false)
  const [renderOpen, setRenderOpen]   = useState(false)
  const [regenCaptionsOpen, setRegenCaptionsOpen] = useState(false)
  // The clip/audio inspector target — derived from the timeline's inspect
  // callbacks. A Montaj-agnostic { kind, id } selector, not a project entity.
  const [inspecting, setInspecting]   = useState<{ kind: 'clip' | 'audio'; id: string } | null>(null)
  // SP5 T9 — command palette (Cmd/Ctrl+K). `'goto'` opens straight into the
  // timecode input (the scrubber's time-readout click); `'list'` opens the
  // filtered command list.
  const [paletteOpen, setPaletteOpen] = useState<false | 'list' | 'goto'>(false)

  // ── T9 keymap plumbing (continued after `editingOverlayItem`, below) ──
  // The transport seam — filled by PreviewPlayer from whichever playback path
  // (legacy or engine) is active. The keymap and palette use it for play/
  // pause; the shuttle polls `isPlaying()` to detect a real transport change.
  const transportRef = useRef<TransportHandle | null>(null)
  // Marker/zoom actions Timeline exposes for the palette, mirroring
  // `transportRef`'s shape.
  const timelineActionsRef = useRef<TimelineActions | null>(null)

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
      pause: () => { if (transportRef.current?.isPlaying()) transportRef.current.togglePlay() },
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

  // Host-chrome placement of the image-tone setting (mirrors
  // onProvideRenderTrigger): push the current state up whenever it changes,
  // and null for SDR projects so the host hides the control.
  const isHdrProject = !!project.settings?.colorSpace?.startsWith('hdr')
  const currentImageTone = project.settings?.imageTone
  useEffect(() => {
    if (!onProvideImageTone) return
    onProvideImageTone(isHdrProject ? { value: currentImageTone ?? 'vivid', set: handleImageToneChange } : null)
  }, [onProvideImageTone, isHdrProject, currentImageTone, handleImageToneChange])

  const openRender = useCallback(() => {
    const final = { ...syncProjectRef.current, status: 'final' } as P
    emitRef.current(final)
    void syncMutate(() => final)
    setRenderOpen(true)
  }, [syncMutate, syncProjectRef])
  useEffect(() => { onProvideRenderTrigger?.(openRender) }, [onProvideRenderTrigger, openRender])

  const { versions, restoring, setRestoring } = useVersionHistory(adapter, project)

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

  const clips      = project.tracks?.[0] ?? []
  const hasContent = clips.length > 0 || (project.tracks?.slice(1).flat().length ?? 0) > 0 || (project.captions?.segments?.length ?? 0) > 0

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
  const allVisualItems = (project.tracks ?? []).flat()
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
  const anyModalOpen = renderOpen || regenCaptionsOpen || !!editingOverlayItem
    || showControls || cropMode || !!inspecting || !!paletteOpen

  function withItemProps(base: P, id: string, nextProps: Record<string, unknown>): P {
    return {
      ...base,
      tracks: (base.tracks ?? []).map(track =>
        track.map(item => (item.id !== id ? item : { ...item, props: nextProps })),
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

  // Edits coming from the timeline (drag/move/track changes): route through the
  // sync core — one undo step + queued save + rollback-on-failure.
  function handleProjectChange(p: Project) {
    void sync.mutate(() => p as P)
  }

  function handleCut(cut: { start: number; end: number }) {
    void sync.mutate(p => {
      let updated = primarySelectedId
        ? applyCutToItem(p, primarySelectedId, cut)
        : applyCutToTracks(p, cut)
      if (rippleMode) updated = collapseGaps(updated)
      return updated as P
    })
    setSelectedIds([])
  }

  function handleOverlayChange(id: string, changes: OverlayChanges) {
    void sync.mutate(p => ({
      ...p,
      tracks: (p.tracks ?? []).map(track =>
        track.map(item => item.id !== id ? item : { ...item, ...changes })
      ),
    } as P))
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

  // Selecting a caption segment and selecting a normal timeline item are
  // mutually exclusive selection models — never show both sets of handles at
  // once (see CaptionTrackRow's file header). A caption can be selected from
  // either the preview (click the selection box) or the timeline's caption
  // row, so this wrapper — not Timeline — is the one place that must clear
  // `selectedIds` on every caption selection; Timeline's own
  // `handleSelectItem` handles the reverse (selecting an item clears this).
  const handleSelectCaption = useCallback((id: string | null) => {
    setSelectedCaptionId(id)
    if (id !== null) setSelectedIds([])
  }, [])

  function handleSplit(at?: number) {
    const base = syncProjectRef.current
    const updated = splitAtTime(base, at ?? clock.get(), primarySelectedId ?? null)
    if (updated === base) return
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
  // handleCut, handleRippleToggle above).
  function handleRippleDelete() {
    if (!primarySelectedId) return
    const base = syncProjectRef.current
    const updated = rippleDelete(base, primarySelectedId)
    if (updated === base) return
    void sync.mutate(() => updated as P)
    setSelectedIds([])
  }

  const openPalette = useCallback(() => setPaletteOpen('list'), [])
  const openGoToTime = useCallback(() => setPaletteOpen('goto'), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  // Command palette. Bindings for split/undo/redo/ripple-delete/palette-open
  // double as their own registry entries here; a few are palette-only
  // (zoom-fit, go-to-time, marker set/clear) — see `paletteCommands` below.
  // Cmd/Ctrl+K, and the J/K/L shuttle, are new to T9 and only ever lived at
  // this ReviewSurface level (same scope split/undo/redo already had — the
  // pending surface has no editing chrome).
  useKeymap([
    {
      id: 'video.split',
      description: 'Split at playhead',
      keyHint: ['S'],
      matches: matchesKey('s'),
      action: () => handleSplit(),
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
  // undo row). Zoom-fit and the marker ops route through `timelineActionsRef`
  // (Timeline-local state — see Timeline.tsx's `TimelineActions`). Roll/slip/
  // slide are drag gestures and deliberately have no palette variant.
  const paletteCommands: PaletteCommand[] = [
    { id: 'play-pause', label: 'Play/Pause', keyHint: ['Space'], run: () => transportRef.current?.togglePlay() },
    { id: 'split', label: 'Split at playhead', keyHint: ['S'], run: () => handleSplit() },
  ]
  if (primarySelectedId) {
    paletteCommands.push({ id: 'ripple-delete', label: 'Ripple-delete selection', keyHint: ['⇧', 'Delete'], run: () => handleRippleDelete() })
  }
  if (sync.canUndo) paletteCommands.push({ id: 'undo', label: 'Undo', keyHint: ['⌘', 'Z'], run: () => sync.undo() })
  if (sync.canRedo) paletteCommands.push({ id: 'redo', label: 'Redo', keyHint: ['⌘', '⇧', 'Z'], run: () => sync.redo() })
  paletteCommands.push({ id: 'zoom-fit', label: 'Zoom to fit', run: () => timelineActionsRef.current?.zoomFit() })
  paletteCommands.push({ id: 'goto', label: 'Go to time…', run: () => openGoToTime() })
  paletteCommands.push({ id: 'set-marker', label: 'Set marker at playhead', run: () => timelineActionsRef.current?.setMarkerAtPlayhead() })
  paletteCommands.push({ id: 'clear-markers', label: 'Clear markers', run: () => timelineActionsRef.current?.clearMarkers() })

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
    }
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Work area — editor body + version rail, side by side */}
      <div className="flex flex-1 overflow-hidden min-h-0">
      {/* Main: preview + timeline */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 flex items-center justify-center bg-black overflow-hidden p-2">
          {hasContent ? (
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
              />
            </div>
          ) : (
            <p className="text-[var(--editor-text)]/60 text-sm">No clips</p>
          )}
        </div>

        {/* Track controls bar — info + undo/redo + split + ripple + render */}
        <div className="shrink-0 flex items-center justify-end gap-1.5 px-3 py-1 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
          <button
            onClick={() => setShowControls(true)}
            title="Editor controls & shortcuts"
            aria-label="Editor controls & shortcuts"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)] mr-auto"
          >
            <Info size={12} />
          </button>
          <button
            onClick={sync.undo}
            disabled={!sync.canUndo}
            title="Undo (Cmd/Ctrl+Z)"
            aria-label="Undo"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Undo2 size={12} />
          </button>
          <button
            onClick={sync.redo}
            disabled={!sync.canRedo}
            title="Redo (Cmd/Ctrl+Shift+Z)"
            aria-label="Redo"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Redo2 size={12} />
          </button>
          <button
            onClick={() => handleSplit()}
            title="Split at playhead (S) — selected item or all clips"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="6" y1="0" x2="6" y2="12" />
              <polyline points="3,3 6,6 9,3" />
              <polyline points="3,9 6,6 9,9" />
            </svg>
          </button>
          <button
            onClick={handleRippleToggle}
            title={rippleMode ? 'Ripple mode on — edits close the gap' : 'Ripple mode off — edits leave a gap'}
            aria-pressed={rippleMode}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
              rippleMode
                ? 'text-teal-400 bg-teal-400/15 hover:bg-teal-400/25'
                : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
            }`}
          >
            <Magnet size={12} />
          </button>
          <button
            onClick={() => setCropMode(m => !m)}
            disabled={!cropTarget}
            title={
              !cropTarget
                ? 'Select a video clip to crop its source'
                : cropMode ? 'Exit source crop' : 'Crop source — non-destructively crop the selected clip'
            }
            aria-pressed={cropMode}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              cropMode
                ? 'text-amber-400 bg-amber-400/15 hover:bg-amber-400/25'
                : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
            }`}
          >
            <Crop size={12} />
          </button>
          {selectedOverlayItem && (
            <button
              onClick={() => requestEditOverlay(selectedOverlayItem.id)}
              title="Edit overlay — text, colors, and other properties"
              aria-label="Edit overlay"
              className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]"
            >
              <Pencil size={12} />
            </button>
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

        <div className="shrink-0 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
          <Timeline
            project={project}
            clock={clock}
            onProjectChange={handleProjectChange}
            onCaptionEdit={(p) => void sync.mutate(() => p as P)}
            onOverlayEdit={(p) => void sync.mutate(() => p as P)}
            onEditOverlay={requestEditOverlay}
            selectedIds={selectedIds}
            onSelectIds={setSelectedIds}
            selectedCaptionId={selectedCaptionId}
            onSelectCaption={handleSelectCaption}
            onCaptionSegmentChange={handleCaptionSegmentChange}
            onSplit={handleSplit}
            onCut={handleCut}
            onInspectClip={(id) => setInspecting({ kind: 'clip', id })}
            onInspectAudio={(id) => setInspecting({ kind: 'audio', id })}
            rippleMode={rippleMode}
            getWaveformChunks={getWaveformChunks}
            resolveFilePath={resolveFilePath}
            getWaveformPeaks={getWaveformPeaks}
            getFilmstrip={getFilmstrip}
            regenEnabled={regenEnabled}
            isClipQueued={isClipQueued}
            renderSubcutRegen={renderSubcutRegen}
            onRegenerateCaptions={adapter.generateCaptions ? () => setRegenCaptionsOpen(true) : undefined}
            timeline={timeline}
            modalOpen={anyModalOpen}
            onOpenGoToTime={openGoToTime}
            actionsRef={timelineActionsRef}
          />
        </div>
      </div>

      {/* Assets — dedicated separate column to the LEFT of the version rail
          (assetsPlacement: 'right', two distinct columns). The Montaj-local OS
          layout uses 'sidebar' instead (stacked into the version rail below).
          The host's panel manages its own scroll. */}
      {assetsPlacement === 'right' && slots?.assetsPanel && (
        <div className="w-72 shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden">
          {slots.assetsPanel}
        </div>
      )}

      {/* Right rail — version history + run history slot, and (in 'sidebar'
          placement) the assets panel stacked beneath them in the SAME column.
          This is the historical Montaj-local OS layout: versions on top, assets
          right below, one column — not a separate assets column. */}
      {(adapter.listVersionHistory || slots?.runHistory ||
        (assetsPlacement === 'sidebar' && slots?.assetsPanel)) && (
        <div className={`${assetsPlacement === 'sidebar' ? 'w-56' : 'w-48'} shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden`}>
          {adapter.listVersionHistory && (
            <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />
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
      )}
      </div>

      {/* Project media / assets — full-width region stacked BELOW the editor
          (assetsPlacement: 'bottom'). Preferred by width-constrained hosts (Hub).
          The host's panel manages its own scroll. */}
      {assetsPlacement === 'bottom' && slots?.assetsPanel && (
        <div className="shrink-0 border-t border-[var(--editor-border)] w-full flex flex-col max-h-[45%] overflow-hidden">
          {slots.assetsPanel}
        </div>
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
          onClose={() => setRenderOpen(false)}
          onCancel={() => setRenderOpen(false)}
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
          onClose={() => setRegenCaptionsOpen(false)}
          onDone={(captions) => {
            sync.applyExternal({ ...syncProjectRef.current, captions } as P)
            setRegenCaptionsOpen(false)
          }}
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

      {/* Clip / audio inspector — host-rendered via render-prop seam. */}
      {inspecting && renderClipInspector?.({
        item: inspecting,
        onClose: () => setInspecting(null),
      })}
    </div>
  )
}
