import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import AudioTrackRow from './AudioTrackRow'
import type { GetWaveformChunks, ResolveFilePath } from './AudioWaveformLayer'
import type { Project } from '../../types'
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
  onSaveProject?: (p: Project) => Promise<unknown>
  rippleMode?: boolean
  /** Audio-waveform fetcher, threaded to every AudioWaveformLayer. In V4 the
   *  VideoEditor wires this from `adapter.getWaveformChunks`. Absent → no
   *  waveforms render (graceful). */
  getWaveformChunks?: GetWaveformChunks
  /** Resolves a waveform chunk's host path into a displayable URL. */
  resolveFilePath?: ResolveFilePath
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
}


export default function Timeline({ project, clock, onProjectChange, onCaptionEdit, onOverlayEdit, onEditOverlay, selectedIds = [], onSelectIds, selectedCaptionId = null, onSelectCaption, onCaptionSegmentChange, onSplit, onCut, onInspectClip, onInspectAudio, rippleMode = false, getWaveformChunks, resolveFilePath, regenEnabled, isClipQueued, renderSubcutRegen, onRegenerateCaptions }: TimelineProps) {
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
  // when the underlying tracks/audio actually change.
  const { snapBoundaries, contentDuration, totalDuration } = useMemo(() => {
    const snapBoundaries = [...new Set([
      ...allTracks.flat().flatMap(c => [c.start, c.end]),
      ...audioTracks.flatMap(t => [t.start, t.end]),
    ])]
    const contentDuration = Math.max(
      allTracks.flat().reduce((m, i) => Math.max(m, i.end ?? 0), 0),
      audioTracks.reduce((m, t) => Math.max(m, t.end ?? 0), 0),
    )
    // Add 20% padding beyond content so the rightmost item can always be
    // dragged or resized further out. Minimum 5s headroom.
    const totalDuration = contentDuration + Math.max(5, contentDuration * 0.2)
    return { snapBoundaries, contentDuration, totalDuration }
  }, [project.tracks, project.audio])

  // Auto-crossfade: when two audio tracks overlap, apply fade-out on the earlier
  // and fade-in on the later, each equal to the overlap duration.
  useEffect(() => {
    if (!audioTracks.length || !onProjectChange) return
    const sorted = [...audioTracks].sort((a, b) => a.start - b.start)
    let changed = false
    const updated = sorted.map(t => ({ ...t }))

    // We only auto-set fades where overlap exists
    for (let i = 0; i < updated.length - 1; i++) {
      const a = updated[i]
      const b = updated[i + 1]
      if (a.end > b.start && !a.muted && !b.muted) {
        // Overlap detected
        const overlap = Math.min(a.end - b.start, a.end - a.start, b.end - b.start)
        if ((a.fadeOut ?? 0) !== overlap) {
          a.fadeOut = Math.round(overlap * 10) / 10  // round to 0.1s
          changed = true
        }
        if ((b.fadeIn ?? 0) !== overlap) {
          b.fadeIn = Math.round(overlap * 10) / 10
          changed = true
        }
      }
    }

    if (changed) {
      const trackMap = new Map(updated.map(t => [t.id, t]))
      const nextProject: typeof project = {
        ...project,
        audio: {
          ...project.audio,
          tracks: (project.audio?.tracks ?? []).map(t => trackMap.get(t.id) ?? t),
        },
      }
      onProjectChange(nextProject)
    }
  // Intentionally keyed on a stable digest of audio-track timing/mute rather
  // than the array identity, so the crossfade pass only re-runs on real edits.
  }, [audioTracks.map(t => `${t.id}:${t.start}:${t.end}:${t.muted}`).join('|')])

  const [hoverPct, setHoverPct]               = useState<number | null>(null)
  const [draggingPlayhead, setDraggingPlayhead] = useState(false)
  const [markers, setMarkers]                 = useState<[number | null, number | null]>([null, null])
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false)

  const scrubberRef                           = useRef<HTMLDivElement>(null)
  const overlayDraggedRef                     = useRef(false)
  const [keyNavTime, setKeyNavTime]           = useState<number | null>(null)
  const keyNavTimerRef                        = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [subcutClipId, setSubcutClipId]       = useState<string | null>(null)

  const { zoom, zoomRef, scrollRef, zoomTo } = useTimelineZoom(totalDuration)

  useEffect(() => {
    if (totalDuration === 0) return
    const fps = project.settings?.fps ?? 30
    const frame = 1 / fps
    const onKey = (e: globalThis.KeyboardEvent) => {
      // While the transcript modal is open, or the caret is in editable text
      // (caption segments are contentEditable), arrows move the text cursor —
      // never the playhead.
      if (transcriptModalOpen) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if ((e.target as HTMLElement).isContentEditable) return
      if (e.key === 'Escape') { setMarkers([null, null]); return }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const step = e.shiftKey ? 1 : frame
      const dir  = e.key === 'ArrowRight' ? 1 : -1
      const next = Math.max(0, Math.min(totalDuration, clock.get() + dir * step))
      clock.set(next)
      setKeyNavTime(next)
      if (keyNavTimerRef.current) clearTimeout(keyNavTimerRef.current)
      keyNavTimerRef.current = setTimeout(() => setKeyNavTime(null), 1500)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [totalDuration, clock, project.settings?.fps, transcriptModalOpen])

  // Derive selection from two placed markers
  const selection = markers[0] !== null && markers[1] !== null
    ? { start: Math.min(markers[0], markers[1]), end: Math.max(markers[0], markers[1]) }
    : null

  const ctx = useMemo<TimelineContextValue>(() => ({
    totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, clock, markers, setMarkers, selection,
  }), [totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, clock, markers, setMarkers, selection])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).isContentEditable) return

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
      e.preventDefault()
      if (!onProjectChange) return
      let updated = deleteSelection(project, selectedIds)
      if (rippleMode) updated = collapseGaps(updated)
      onProjectChange(updated)
      onOverlayEdit?.(updated)
      onSelectIds?.([])
      return
    }

    if (e.key !== 'Enter' || totalDuration === 0) return
    e.preventDefault()
    const t = clock.get()
    setMarkers(([a, b]) => {
      if (a === null) return [t, null]
      if (b === null) return [a, t]
      return [t, null]
    })
  }

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

  return (
    <TimelineContext.Provider value={ctx}>
    <div
      className="flex flex-col gap-2 px-3 py-3 select-none outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
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
            onClick={(e) => { e.stopPropagation(); zoomTo(zoomRef.current - 1) }}
          >−</button>
          <span className="text-[10px] font-mono text-gray-500 w-7 text-center tabular-nums select-none">{zoom}×</span>
          <button
            className="text-[11px] leading-none text-gray-500 hover:text-gray-300 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
            title="Zoom in"
            onClick={(e) => { e.stopPropagation(); zoomTo(zoomRef.current + 1) }}
          >+</button>
          {zoom > 1 && (
            <button
              className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 h-5 rounded hover:bg-gray-800 transition-colors ml-0.5"
              title="Fit to view"
              onClick={(e) => { e.stopPropagation(); zoomTo(1) }}
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
      />

      {/* ── Tracks ── */}
      <div className="flex flex-col gap-1">
        {project.renderMode === 'ffmpeg-drawtext' && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-400/70 select-none">
            <span>⚡</span>
            <span>ffmpeg render — overlays are preview only, final text is burned by ffmpeg</span>
          </div>
        )}
        {/* ── Caption track — its own row above the visual tracks. NOT part of
            tracks[]; reads/writes project.captions directly (see
            CaptionTrackRow's file header for the special-track rationale). ── */}
        <CaptionTrackRow
          captionTrack={captionTrack}
          fps={project.settings?.fps ?? 30}
          selectedCaptionId={selectedCaptionId}
          onSelectCaption={onSelectCaption}
          onCaptionSegmentChange={onCaptionSegmentChange}
        />

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

        {/* Audio tracks — grouped by lane */}
        {(() => {
          // Group audio tracks by lane. Tracks without a lane get auto-assigned.
          const laneMap = new Map<number, typeof audioTracks>()
          let nextAutoLane = 0
          for (const t of audioTracks) {
            if (t.lane != null && t.lane >= nextAutoLane) nextAutoLane = t.lane + 1
          }
          for (const t of audioTracks) {
            const lane = t.lane ?? nextAutoLane++
            if (!laneMap.has(lane)) laneMap.set(lane, [])
            laneMap.get(lane)!.push(t)
          }
          const lanes = [...laneMap.entries()].sort((a, b) => a[0] - b[0])

          return lanes.map(([laneIdx, laneTracks]) => (
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
