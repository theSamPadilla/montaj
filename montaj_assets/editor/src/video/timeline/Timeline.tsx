import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type MutableRefObject, type ReactNode } from 'react'
import AudioTrackRow from './AudioTrackRow'
import type { GetWaveformChunks, ResolveFilePath } from './AudioWaveformLayer'
import type { FilmstripIndex, GetFilmstripArgs, GetWaveformPeaksArgs, PeaksData, Project } from '../../types'
import { collapseGaps } from '../cuts'
import { ratioFromClientX } from './utils'
import { useTimelineZoom } from './useTimelineZoom'
import { TimelineContext, type TimelineContextValue } from './TimelineContext'
import { usePlaybackTime, type PlaybackClock } from '../playback-clock'
import Scrubber from './Scrubber'
import TranscriptPanel from './TranscriptPanel'
import TranscriptModal from './TranscriptModal'
import VisualTrackRow from './VisualTrackRow'
import CaptionTrackRow from './CaptionTrackRow'
import { deleteSelection, toggleSelection } from './multiSelectOps'
import type { CaptionEditPatch } from './makeCaptionEdit'
import { computeAutoCrossfade, computeDerivedTiming, groupAudioLanes } from './timeline-model'
import TimelineCanvas, { useCanvasZoomControls, type ZoomControls } from './canvas/TimelineCanvas'
import { useViewportStore } from './canvas/viewport'
import { useKeymap, matchesArrowLeft, matchesArrowRight, matchesDelete, matchesEnter, matchesEscape } from '../keymap'

/** Imperative actions a host-level command palette can trigger on markers/
 *  zoom without lifting Timeline's local state up. Filled via `actionsRef`
 *  (SP5 T9) — mirrors `transportRef`'s "ref threaded down, written by the
 *  owner" shape used for PreviewPlayer. */
export interface TimelineActions {
  clearMarkers: () => void
  setMarkerAtPlayhead: () => void
  zoomFit: () => void
}

interface TimelineProps {
  project: Project
  clock: PlaybackClock
  onProjectChange?: (p: Project) => void
  onCaptionEdit?: (p: Project) => void
  onOverlayEdit?: (p: Project) => void
  /** Open the overlay props dialog (owned by VideoEditor). Threaded to each
   *  VisualTrackRow so a selected overlay block can offer an edit button. */
  onEditOverlay?: (id: string) => void
  /** Unified selection — covers both visual items and audio tracks. */
  selectedIds?: string[]
  onSelectIds?: (ids: string[]) => void
  /** Selected caption segment id — shared with the preview's selection box.
   *  Mutually exclusive with `selectedIds` (see CaptionTrackRow). */
  selectedCaptionId?: string | null
  onSelectCaption?: (id: string | null) => void
  /** Commit a caption segment patch — text edit or edge-drag retime. Threaded
   *  straight to CaptionTrackRow (see makeCaptionEdit.ts). */
  onCaptionSegmentChange?: (segmentId: string, patch: CaptionEditPatch) => void
  onSplit?: (at: number) => void
  onCut?: (cut: { start: number; end: number }) => void
  onInspectClip?: (id: string) => void
  onInspectAudio?: (id: string) => void
  rippleMode?: boolean
  /**
   * SP5 — opt into the canvas track-row area. Mirrors the `engine` (SP4)
   * host-knob precedent. Absent or `{ canvas: false }`: the existing DOM
   * track rows (visual tracks + audio lanes), unchanged — this is the
   * non-regression guarantee SP5 tests against. `{ canvas: true }`: the DOM
   * track rows are replaced by one `TimelineCanvas` surface with its own
   * px-per-second viewport; the caption row stays DOM either way (inline
   * contentEditable editing can't move to canvas) and mounts below it.
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
  /** Opens the caption-regeneration modal. Threaded down to TranscriptPanel.
   *  Provided only when the host adapter supports `generateCaptions`; absent →
   *  the "Regenerate" button is hidden. */
  onRegenerateCaptions?: () => void
  /**
   * SP5 T9 — true while a HOST-level dialog (RenderModal, the command
   * palette, etc.) is open, so Timeline's own keymap (arrows/delete/enter/
   * escape) doesn't fire underneath it. ORed with Timeline's own
   * `transcriptModalOpen`, which already guarded arrows/escape before T9.
   * Absent (PendingSurface today has no such dialogs) → only the local
   * transcript-modal check applies, unchanged.
   */
  modalOpen?: boolean
  /** Opens the command palette's "go to time" input directly. Wired to the
   *  scrubber's time readout; absent → the readout is plain text. */
  onOpenGoToTime?: () => void
  /** Imperative marker/zoom actions for a host-level command palette. */
  actionsRef?: MutableRefObject<TimelineActions | null>
}


export default function Timeline({ project, clock, onProjectChange, onCaptionEdit, onOverlayEdit, onEditOverlay, selectedIds = [], onSelectIds, selectedCaptionId = null, onSelectCaption, onCaptionSegmentChange, onSplit, onCut, onInspectClip, onInspectAudio, rippleMode = false, getWaveformChunks, resolveFilePath, getWaveformPeaks, getFilmstrip, regenEnabled, isClipQueued, renderSubcutRegen, onRegenerateCaptions, timeline, modalOpen = false, onOpenGoToTime, actionsRef }: TimelineProps) {
  const primarySelectedId = selectedIds[0] ?? null

  // Click/shift-click handler — additive selection on shift or meta (cmd/ctrl).
  // Also enforces the item→caption half of the two selection models' mutual
  // exclusivity: selecting a real item clears `selectedCaptionId`, and so does
  // clicking empty track space (id === null) — otherwise a "deselect all" click
  // would clear the item handles but leave the caption's preview handles up,
  // and since nothing else clears caption selection there would be no way to
  // put a caption down at all. The other half (caption select clears
  // `selectedIds`) lives in VideoEditor's wrapped `onSelectCaption`, since a
  // caption can be selected from the preview too — outside Timeline entirely —
  // not just from CaptionTrackRow.
  function handleSelectItem(id: string | null, additive: boolean) {
    if (!onSelectIds) return
    onSelectCaption?.(null)
    if (id === null) { onSelectIds([]); return }
    onSelectIds(toggleSelection(selectedIds, id, additive))
  }
  const allTracks      = project.tracks ?? []
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
    if (!onProjectChange) return
    const next = computeAutoCrossfade(project)
    if (next) onProjectChange(next)
  // Intentionally keyed on a stable digest of audio-track timing/mute rather
  // than the array identity, so the crossfade pass only re-runs on real edits.
  }, [audioTracks.map(t => `${t.id}:${t.start}:${t.end}:${t.muted}`).join('|')])

  const [hoverPct, setHoverPct]               = useState<number | null>(null)
  const [draggingPlayhead, setDraggingPlayhead] = useState(false)
  const [markers, setMarkers]                 = useState<[number | null, number | null]>([null, null])
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false)

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

  // Place (or extend/reset) the two-marker selection at the current playhead —
  // the original Enter handler's exact three-way branch. Shared with the
  // Enter binding below and with `actionsRef`'s palette-facing action, so
  // there is exactly one place that encodes the marker state machine.
  const setMarkerAtPlayhead = useCallback(() => {
    const t = clock.get()
    setMarkers(([a, b]) => {
      if (a === null) return [t, null]
      if (b === null) return [a, t]
      return [t, null]
    })
  }, [clock])

  const clearMarkers = useCallback(() => setMarkers([null, null]), [])

  // ── Timeline's own keymap — arrows (frame-step), delete (two-step:
  // deleteSelection + conditional collapseGaps), enter (place marker),
  // escape (clear markers). SP5 T9: these four bindings replace Timeline's
  // old ad hoc document listener (arrows/escape, gated on totalDuration>0 by
  // not registering at all) and its container-scoped onKeyDown (delete/enter)
  // with the shared registry — one guarded document listener instead of two
  // different attachment mechanisms with two different guard sets.
  //
  // Mounted HERE, not lifted into VideoEditor's keymap: this instance runs in
  // BOTH the pending and review surfaces (PendingSurface and ReviewSurface
  // each render their own `<Timeline>` with their own `PlaybackClock`), same
  // as the listeners it replaces. `modalOpen` ORs the host's dialogs
  // (ReviewSurface's RenderModal/palette/etc — absent in PendingSurface) with
  // Timeline's own `transcriptModalOpen`, which already guarded arrows/escape
  // pre-T9.
  const fps = project.settings?.fps ?? 30
  const frameStep = 1 / fps
  useKeymap([
    {
      id: 'timeline.frame-step',
      description: 'Step one frame',
      matches: (e) => matchesArrowLeft(e) || matchesArrowRight(e),
      guard: () => totalDuration > 0,
      action: (e) => {
        const step = e.shiftKey ? 1 : frameStep
        const dir  = matchesArrowRight(e) ? 1 : -1
        const next = Math.max(0, Math.min(totalDuration, clock.get() + dir * step))
        clock.set(next)
        setKeyNavTime(next)
        if (keyNavTimerRef.current) clearTimeout(keyNavTimerRef.current)
        keyNavTimerRef.current = setTimeout(() => setKeyNavTime(null), 1500)
      },
    },
    {
      id: 'timeline.clear-markers',
      description: 'Clear markers',
      matches: matchesEscape,
      guard: () => totalDuration > 0,
      // The original Escape handler never called preventDefault — kept exact.
      preventDefault: false,
      action: clearMarkers,
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
        if (rippleMode) updated = collapseGaps(updated)
        onProjectChange(updated)
        onOverlayEdit?.(updated)
        onSelectIds?.([])
      },
    },
    {
      id: 'timeline.set-marker',
      description: 'Set marker at playhead',
      matches: matchesEnter,
      // Focus-scoped, same rationale as delete-selection above — pre-SP5 this
      // lived on the container's own onKeyDown too.
      guard: () => totalDuration > 0 && !!rootRef.current?.contains(document.activeElement),
      action: setMarkerAtPlayhead,
    },
  ], { modalOpen: transcriptModalOpen || modalOpen })

  // Hand the marker/zoom actions up to a host-level command palette.
  useEffect(() => {
    if (!actionsRef) return
    actionsRef.current = { clearMarkers, setMarkerAtPlayhead, zoomFit: zoomControls.fit }
    return () => { actionsRef.current = null }
  })

  // Derive selection from two placed markers
  const selection = markers[0] !== null && markers[1] !== null
    ? { start: Math.min(markers[0], markers[1]), end: Math.max(markers[0], markers[1]) }
    : null

  const ctx = useMemo<TimelineContextValue>(() => ({
    totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, clock, markers, setMarkers, selection,
  }), [totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, clock, markers, setMarkers, selection])

  function handleContainerClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button, input, [contenteditable]')) return
    if (totalDuration === 0) return
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

  const cutButtonLabel = primarySelectedId
    ? `Cut ${allTracks.flat().find(i => i.id === primarySelectedId)?.type ?? 'item'}`
    : 'Cut primary'

  // ── Caption track — its own row, NOT part of tracks[]; reads/writes
  // project.captions directly (see CaptionTrackRow's file header for the
  // special-track rationale). Stays DOM in BOTH timeline modes — inline
  // contentEditable editing can't move to canvas — so it's shared between
  // the two track-row-area branches below rather than duplicated.
  const captionRow = (
    <CaptionTrackRow
      captionTrack={captionTrack}
      fps={project.settings?.fps ?? 30}
      selectedCaptionId={selectedCaptionId}
      onSelectCaption={onSelectCaption}
      onCaptionSegmentChange={onCaptionSegmentChange}
    />
  )

  return (
    <TimelineContext.Provider value={ctx}>
    <div
      ref={rootRef}
      className="flex flex-col gap-2 px-3 py-3 select-none outline-none"
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
        <div className="flex items-center justify-end gap-0.5 -mb-1">
          <button
            className="text-[11px] leading-none text-gray-500 hover:text-gray-300 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
            title="Zoom out"
            onClick={(e) => { e.stopPropagation(); zoomControls.zoomOut() }}
          >−</button>
          {zoomControls.badge}
          <button
            className="text-[11px] leading-none text-gray-500 hover:text-gray-300 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
            title="Zoom in"
            onClick={(e) => { e.stopPropagation(); zoomControls.zoomIn() }}
          >+</button>
          {zoomControls.showFit && (
            <button
              className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 h-5 rounded hover:bg-gray-800 transition-colors ml-0.5"
              title="Fit to view"
              onClick={(e) => { e.stopPropagation(); zoomControls.fit() }}
            >fit</button>
          )}
        </div>
      )}

      {/* Scroll container for zoomed tracks */}
      <div ref={scrollRef} className="overflow-x-auto">
      <div style={{ width: zoom > 1 ? `${zoom * 100}%` : '100%' }} className="min-w-full">

      {/* Scrubber + tracks wrapped in a relative container so the hover indicator spans the full height */}
      <div className="relative flex flex-col gap-2">
        {hoverPct !== null && totalDuration > 0 && (
          <div
            className="absolute inset-y-0 w-px bg-yellow-400/80 pointer-events-none z-20"
            style={{ left: `${hoverPct}%` }}
          />
        )}

      <Scrubber
        hoverPct={hoverPct}
        draggingPlayhead={draggingPlayhead}
        setDraggingPlayhead={setDraggingPlayhead}
        keyNavTime={keyNavTime}
        onSplit={onSplit}
        onCut={onCut}
        cutButtonLabel={cutButtonLabel}
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
          <>
            {/* ── Canvas track-row area — one surface in place of the visual
                tracks + audio lanes the DOM branch renders below. It owns its
                own zoom/scroll (px-per-second), so the scrubber above it stays
                a whole-project overview rather than tracking canvas zoom. ── */}
            <TimelineCanvas
              project={project}
              clock={clock}
              store={viewportStore}
              totalDuration={totalDuration}
              selectedIds={selectedIds}
              markers={markers}
              snapBoundaries={snapBoundaries}
              rippleMode={rippleMode}
              onSelectItem={handleSelectItem}
              onProjectChange={onProjectChange}
              onOverlayEdit={onOverlayEdit}
              onInspectClip={onInspectClip}
              onInspectAudio={onInspectAudio}
              setMarkers={setMarkers}
              getWaveformPeaks={getWaveformPeaks}
              getFilmstrip={getFilmstrip}
              resolveFilePath={resolveFilePath}
            />
            {captionRow}
          </>
        ) : (
          <>
            {captionRow}

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
              const lanes = groupAudioLanes(audioTracks)

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

      {/* ── Transcript editor ── */}
      {/* Wrapped in a clock-subscribing child so the active-segment highlight
          tracks the playhead WITHOUT Timeline (and its track rows) re-rendering
          every tick. */}
      <TranscriptPanelWithClock
        clock={clock}
        project={project}
        captionTrack={captionTrack}
        onCaptionEdit={onCaptionEdit}
        onProjectChange={onProjectChange}
        onExpand={() => setTranscriptModalOpen(true)}
        onRegenerateCaptions={onRegenerateCaptions}
        selectedCaptionId={selectedCaptionId}
        onCaptionSegmentChange={onCaptionSegmentChange}
      />

      {/* ── Transcript modal ── */}
      {transcriptModalOpen && (
        <TranscriptModalWithClock
          clock={clock}
          project={project}
          captionTrack={captionTrack}
          onCaptionEdit={onCaptionEdit}
          onClose={() => setTranscriptModalOpen(false)}
        />
      )}

    </div>
    </TimelineContext.Provider>
  )
}

// The transcript views highlight the active caption segment, so they genuinely
// display time and must re-render every tick. Subscribing HERE (rather than in
// Timeline) keeps the per-tick re-render scoped to these leaves — Timeline and
// the track rows are unaffected.
function TranscriptPanelWithClock({
  clock,
  ...rest
}: { clock: PlaybackClock } & Omit<ComponentProps<typeof TranscriptPanel>, 'currentTime'>) {
  const currentTime = usePlaybackTime(clock)
  return <TranscriptPanel currentTime={currentTime} {...rest} />
}

function TranscriptModalWithClock({
  clock,
  ...rest
}: { clock: PlaybackClock } & Omit<ComponentProps<typeof TranscriptModal>, 'currentTime'>) {
  const currentTime = usePlaybackTime(clock)
  return <TranscriptModal currentTime={currentTime} {...rest} />
}
