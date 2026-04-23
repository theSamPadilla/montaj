import { useEffect, useMemo, useRef, useState } from 'react'
import AudioTrackRow from './AudioTrackRow'
import type { Project } from '@/lib/types/schema'
import SubcutRegenTool from './SubcutRegenTool'
import { ratioFromClientX } from './utils'
import { useTimelineZoom } from './useTimelineZoom'
import { TimelineContext, type TimelineContextValue } from './TimelineContext'
import Scrubber from './Scrubber'
import TranscriptPanel from './TranscriptPanel'
import TranscriptModal from './TranscriptModal'
import VisualTrackRow from './VisualTrackRow'

interface TimelineProps {
  project: Project
  currentTime: number
  onTimeUpdate: (t: number) => void
  onProjectChange?: (p: Project) => void
  onCaptionEdit?: (p: Project) => void
  onOverlayEdit?: (p: Project) => void
  selectedOverlayId?: string
  onSelectOverlay?: (id: string | null) => void
  onSplit?: (at: number) => void
  onCut?: (cut: { start: number; end: number }) => void
  onInspectClip?: (id: string) => void
  onInspectAudio?: (id: string) => void
  onSaveProject?: (p: Project) => Promise<unknown>
  rippleMode?: boolean
}


export default function Timeline({ project, currentTime, onTimeUpdate, onProjectChange, onCaptionEdit, onOverlayEdit, selectedOverlayId, onSelectOverlay, onSplit, onCut, onInspectClip, onInspectAudio, onSaveProject, rippleMode = false }: TimelineProps) {
  const allTracks      = project.tracks ?? []
  const captionTrack   = project.captions
  const snapBoundaries = [...new Set(allTracks.flat().flatMap(c => [c.start, c.end]))]
  const audioTracks    = project.audio?.tracks ?? []
  const contentDuration = Math.max(
    allTracks.flat().reduce((m, i) => Math.max(m, i.end ?? 0), 0),
    audioTracks.reduce((m, t) => Math.max(m, t.end ?? 0), 0),
  )
  // Add 20% padding beyond content so the rightmost item can always be
  // dragged or resized further out. Minimum 5s headroom.
  const totalDuration  = contentDuration + Math.max(5, contentDuration * 0.2)

  const [hoverPct, setHoverPct]               = useState<number | null>(null)
  const [draggingPlayhead, setDraggingPlayhead] = useState(false)
  const [markers, setMarkers]                 = useState<[number | null, number | null]>([null, null])
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false)

  const scrubberRef                           = useRef<HTMLDivElement>(null)
  const overlayDraggedRef                     = useRef(false)
  const [keyNavTime, setKeyNavTime]           = useState<number | null>(null)
  const keyNavTimerRef                        = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [subcutClipId, setSubcutClipId]       = useState<string | null>(null)
  const [selectedAudioTrackId, setSelectedAudioTrackId] = useState<string | null>(null)

  const { zoom, zoomRef, scrollRef, zoomTo, handleTimelineWheel } = useTimelineZoom(totalDuration)

  useEffect(() => {
    if (totalDuration === 0) return
    const fps = project.settings?.fps ?? 30
    const frame = 1 / fps
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Escape') { setMarkers([null, null]); return }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const step = e.shiftKey ? 1 : frame
      const dir  = e.key === 'ArrowRight' ? 1 : -1
      const next = Math.max(0, Math.min(totalDuration, currentTime + dir * step))
      onTimeUpdate(next)
      setKeyNavTime(next)
      if (keyNavTimerRef.current) clearTimeout(keyNavTimerRef.current)
      keyNavTimerRef.current = setTimeout(() => setKeyNavTime(null), 1500)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [totalDuration, currentTime, onTimeUpdate, project.settings?.fps])

  // Derive selection from two placed markers
  const selection = markers[0] !== null && markers[1] !== null
    ? { start: Math.min(markers[0], markers[1]), end: Math.max(markers[0], markers[1]) }
    : null

  const ctx = useMemo<TimelineContextValue>(() => ({
    totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, currentTime, onTimeUpdate, markers, setMarkers, selection,
  }), [totalDuration, contentDuration, snapBoundaries, zoom, zoomRef, scrollRef, scrubberRef,
    overlayDraggedRef, currentTime, onTimeUpdate, markers, setMarkers, selection])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).isContentEditable) return

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedOverlayId) {
      e.preventDefault()
      if (!onProjectChange) return
      const updated = {
        ...project,
        tracks: (project.tracks ?? [])
          .map(track => track.filter(item => item.id !== selectedOverlayId))
          .filter(track => track.length > 0),
      }
      onProjectChange(updated)
      onOverlayEdit?.(updated)
      onSelectOverlay?.(null)
      return
    }

    if (e.key !== 'Enter' || totalDuration === 0) return
    e.preventDefault()
    setMarkers(([a, b]) => {
      if (a === null) return [currentTime, null]
      if (b === null) return [a, currentTime]
      return [currentTime, null]
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
      if (Math.abs(clickedTime - b) < snapThreshold) { onTimeUpdate(b); return }
    }
    onTimeUpdate(clickedTime)
  }

  const cutButtonLabel = selectedOverlayId
    ? `Cut ${allTracks.flat().find(i => i.id === selectedOverlayId)?.type ?? 'item'}`
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
      <div ref={scrollRef} className="overflow-x-auto" onWheel={handleTimelineWheel}>
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
        {[...allTracks].reverse().map((trackItems, reversedIdx) => {
          const trackIdx = allTracks.length - 1 - reversedIdx
          return (
            <VisualTrackRow
              key={trackIdx}
              trackItems={trackItems}
              trackIdx={trackIdx}
              project={project}
              selectedOverlayId={selectedOverlayId}
              rippleMode={rippleMode}
              onProjectChange={onProjectChange}
              onOverlayEdit={onOverlayEdit}
              onSelectOverlay={(id) => {
                onSelectOverlay?.(id)
                if (id) setSelectedAudioTrackId(null)
              }}
              onInspectClip={onInspectClip}
              subcutClipId={subcutClipId}
              setSubcutClipId={setSubcutClipId}
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
              selectedTrackId={selectedAudioTrackId}
              onSelect={(id) => {
                setSelectedAudioTrackId(id)
                if (id) onSelectOverlay?.(null)
              }}
              onInspect={onInspectAudio}
            />
          ))
        })()}

      </div>

      </div>{/* end scrubber+tracks wrapper */}
      </div>{/* end inner zoom div */}
      </div>{/* end scroll container */}

      {/* ── Subcut regen tool ── */}
      {subcutClipId && (() => {
        const subcutClip = allTracks[0]?.find(c => c.id === subcutClipId)
        if (!subcutClip || !subcutClip.generation || project.projectType !== 'ai_video') return null
        return (
          <SubcutRegenTool
            project={project}
            clip={subcutClip}
            onClose={() => setSubcutClipId(null)}
            onProjectChange={(p) => { onProjectChange?.(p); setSubcutClipId(null) }}
            onSave={onSaveProject ?? (async () => {})}
          />
        )
      })()}

      {/* ── Transcript editor ── */}
      <TranscriptPanel
        project={project}
        captionTrack={captionTrack}
        currentTime={currentTime}
        onCaptionEdit={onCaptionEdit}
        onProjectChange={onProjectChange}
        onExpand={() => setTranscriptModalOpen(true)}
      />

      {/* ── Transcript modal ── */}
      {transcriptModalOpen && (
        <TranscriptModal
          project={project}
          captionTrack={captionTrack}
          currentTime={currentTime}
          onProjectChange={onProjectChange}
          onCaptionEdit={onCaptionEdit}
          onClose={() => setTranscriptModalOpen(false)}
        />
      )}

    </div>
    </TimelineContext.Provider>
  )
}
