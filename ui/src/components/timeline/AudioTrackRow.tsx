// AudioTrackRow — renders one audio lane on the timeline.
//
// A lane can contain one or more AudioTrack items (e.g. two voiceover segments
// at different times sharing the same row). Supports: drag-to-reposition,
// cross-lane drag, edge trim, mute toggle, inline volume, delete,
// click-to-select, and inspect button.

import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX, Trash2, Info } from 'lucide-react'
import type { AudioTrack, Project } from '@/lib/types/schema'
import { pct } from './utils'
import { useTimelineContext } from './TimelineContext'
import { useItemDragDrop } from './useItemDragDrop'
import type { Draggable, DragEventContext } from './useItemDragDrop'
import AudioWaveformLayer from './AudioWaveformLayer'

interface AudioTrackRowProps {
  tracks: AudioTrack[]
  laneIndex: number
  laneCount: number
  project: Project
  onProjectChange?: (p: Project) => void
  onOverlayEdit?: (p: Project) => void
  selectedTrackId?: string | null
  onSelect?: (id: string | null) => void
  onInspect?: (id: string) => void
}

const LANE_HEIGHT_PX = 40 // must match the h-10 (2.5rem = 40px) on the row container

function updateAudioTrack(project: Project, trackId: string, changes: Partial<AudioTrack>): Project {
  return {
    ...project,
    audio: {
      ...project.audio,
      tracks: (project.audio?.tracks ?? []).map(t =>
        t.id === trackId ? { ...t, ...changes } : t,
      ),
    },
  }
}

export default function AudioTrackRow({
  tracks,
  laneIndex,
  laneCount,
  project,
  onProjectChange,
  onOverlayEdit,
  selectedTrackId,
  onSelect,
  onInspect,
}: AudioTrackRowProps) {
  const {
    totalDuration,
    currentTime,
    snapBoundaries,
    scrollRef,
    overlayDraggedRef,
  } = useTimelineContext()

  const { beginDrag, beginResize } = useItemDragDrop({
    totalDuration,
    snapBoundaries,
    scrollRef,
    draggedFlagRef: overlayDraggedRef,
  })

  return (
    <div className="relative h-10 bg-gray-100 dark:bg-gray-900 rounded overflow-hidden cursor-pointer">
      {/* Playhead line */}
      <div
        className="absolute top-0 bottom-0 w-[2px] bg-red-500 pointer-events-none z-10"
        style={{ left: `${pct(currentTime, totalDuration)}%` }}
      />
      {tracks.map(track => (
        <AudioTrackItem
          key={track.id}
          track={track}
          laneIndex={laneIndex}
          laneCount={laneCount}
          project={project}
          totalDuration={totalDuration}
          selected={selectedTrackId === track.id}
          onSelect={onSelect}
          onInspect={onInspect}
          onProjectChange={onProjectChange}
          onOverlayEdit={onOverlayEdit}
          beginDrag={beginDrag}
          beginResize={beginResize}
          overlayDraggedRef={overlayDraggedRef}
        />
      ))}
    </div>
  )
}

// ── Single audio item within a lane ──────────────────────────────────────────

interface AudioTrackItemProps {
  track: AudioTrack
  laneIndex: number
  laneCount: number
  project: Project
  totalDuration: number
  selected: boolean
  onSelect?: (id: string | null) => void
  onInspect?: (id: string) => void
  onProjectChange?: (p: Project) => void
  onOverlayEdit?: (p: Project) => void
  beginDrag: ReturnType<typeof useItemDragDrop>['beginDrag']
  beginResize: ReturnType<typeof useItemDragDrop>['beginResize']
  overlayDraggedRef: React.RefObject<boolean>
}

function AudioTrackItem({
  track,
  laneIndex,
  laneCount: _laneCount,
  project,
  totalDuration,
  selected,
  onSelect,
  onInspect,
  onProjectChange,
  onOverlayEdit,
  beginDrag,
  beginResize,
  overlayDraggedRef,
}: AudioTrackItemProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current) }, [])

  const left = pct(track.start, totalDuration)
  const width = pct(track.end - track.start, totalDuration)
  const label = track.label ?? track.src.split('/').pop() ?? 'audio'

  // ── Drag to reposition (horizontal + cross-lane) ──
  function handleDragStart(e: React.MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('cursor-ew-resize')) return
    if (!onProjectChange) return
    let lastUpdated = project

    beginDrag(e, track as Draggable, {
      onLivePreview: ({ item: moved, dy }: DragEventContext) => {
        // Cross-lane: compute target lane from vertical drag.
        // Positive dy = dragged down = higher lane index.
        const laneDelta = Math.round(dy / LANE_HEIGHT_PX)
        const targetLane = Math.max(0, laneIndex + laneDelta)

        const next = updateAudioTrack(project, track.id, {
          start: moved.start,
          end: moved.end,
          lane: targetLane,
        })
        lastUpdated = next
        onProjectChange!(next)
      },
      onCommit: () => {
        onOverlayEdit?.(lastUpdated)
      },
    })
  }

  // ── Edge trim ──
  function handleResizeStart(e: React.MouseEvent, edge: 'start' | 'end') {
    if (!onProjectChange) return
    let lastUpdated = project

    const origStart = track.start
    const origEnd = track.end
    const origInPoint = track.inPoint ?? 0
    const origOutPoint = track.outPoint ?? (origInPoint + (origEnd - origStart))
    const srcDur = track.sourceDuration ?? Infinity

    beginResize(e, track as Draggable, edge, {
      onLivePreview: ({ item: resized }: DragEventContext) => {
        let newInPoint = origInPoint
        let newOutPoint = origOutPoint

        if (edge === 'start') {
          const dt = resized.start - origStart
          newInPoint = Math.max(0, Math.min(origInPoint + dt, origOutPoint - 0.1))
        } else {
          const dt = resized.end - origEnd
          newOutPoint = Math.max(origInPoint + 0.1, Math.min(origOutPoint + dt, srcDur))
        }

        const next = updateAudioTrack(project, track.id, {
          start: resized.start,
          end: resized.end,
          inPoint: newInPoint,
          outPoint: newOutPoint,
        })
        lastUpdated = next
        onProjectChange!(next)
      },
      onCommit: () => {
        onOverlayEdit?.(lastUpdated)
      },
    })
  }

  // ── Mute toggle ──
  function handleToggleMute(e: React.MouseEvent) {
    e.stopPropagation()
    if (!onProjectChange) return
    const updated = updateAudioTrack(project, track.id, { muted: !track.muted })
    onProjectChange(updated)
    onOverlayEdit?.(updated)
  }

  // ── Delete (two-step confirm) ──
  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (confirmingDelete) {
      if (!onProjectChange) return
      const updated: Project = {
        ...project,
        audio: {
          ...project.audio,
          tracks: (project.audio?.tracks ?? []).filter(t => t.id !== track.id),
        },
      }
      onProjectChange(updated)
      onOverlayEdit?.(updated)
      onSelect?.(null)
      setConfirmingDelete(false)
    } else {
      setConfirmingDelete(true)
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = setTimeout(() => setConfirmingDelete(false), 3000)
    }
  }

  // ── Click to select ──
  function handleBarClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (overlayDraggedRef.current) return
    onSelect?.(selected ? null : track.id)
  }

  // ── Double-click to open inspector ──
  function handleBarDoubleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (overlayDraggedRef.current) return
    onInspect?.(track.id)
  }

  return (
    <div
      className={`absolute top-1 bottom-1 rounded cursor-grab active:cursor-grabbing flex items-center overflow-hidden
        ${track.muted ? 'bg-white/10' : 'bg-emerald-500/40 border border-emerald-500/60'}
        ${selected ? 'ring-1 ring-inset ring-emerald-300/80' : ''}`}
      style={{ left: `${left}%`, width: `${width}%` }}
      title={label}
      onClick={handleBarClick}
      onDoubleClick={handleBarDoubleClick}
      onMouseDown={handleDragStart}
    >
      {/* Waveform layer */}
      <AudioWaveformLayer track={track} projectId={project.id} />

      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-10 hover:bg-emerald-300/40"
        onMouseDown={(e) => handleResizeStart(e, 'start')}
      />

      {/* Mute toggle */}
      <button
        className="shrink-0 ml-2 z-10 cursor-pointer"
        onClick={handleToggleMute}
        title={track.muted ? 'Unmute' : 'Mute'}
      >
        {track.muted
          ? <VolumeX className="w-3.5 h-3.5 text-white/30" />
          : <Volume2 className="w-3.5 h-3.5 text-emerald-200" />}
      </button>

      {/* Track type label */}
      <span className="text-[10px] text-emerald-200 truncate flex-1 min-w-0 ml-1.5 pointer-events-none z-[1] drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]">
        {track.type === 'voiceover' ? 'Voiceover' : track.type === 'music' ? 'Music' : label}
      </span>

      {/* Info button when selected */}
      {selected && onInspect && (
        <button
          className="shrink-0 ml-1 z-10 cursor-pointer opacity-50 hover:opacity-100 text-emerald-200"
          onClick={(e) => { e.stopPropagation(); onInspect(track.id) }}
          title="Inspect audio track"
        >
          <Info size={12} />
        </button>
      )}

      {/* Delete button when selected (two-step confirm) */}
      {selected && (
        <button
          className={`shrink-0 ml-1 mr-2 z-10 cursor-pointer transition-colors ${
            confirmingDelete
              ? 'opacity-100 text-red-400'
              : 'opacity-60 hover:opacity-100 text-emerald-200'
          }`}
          onClick={handleDeleteClick}
          title={confirmingDelete ? 'Click again to confirm delete' : 'Delete audio track'}
        >
          <Trash2 size={12} />
        </button>
      )}

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-10 hover:bg-emerald-300/40"
        onMouseDown={(e) => handleResizeStart(e, 'end')}
      />
    </div>
  )
}
