import { Volume2, VolumeX, Info, Scissors } from 'lucide-react'
import type { VisualItem, Project } from '@/lib/types/schema'
import { collapseGaps } from '@/lib/cuts'
import { pct, ratioFromClientX, trackRow, trackRowTall } from './utils'
import { useTimelineContext } from './TimelineContext'
import { useItemDragDrop } from './useItemDragDrop'
import type { Draggable, DragEventContext } from './useItemDragDrop'

interface VisualTrackRowProps {
  trackItems: VisualItem[]
  trackIdx: number
  project: Project
  selectedOverlayId?: string
  rippleMode: boolean
  onProjectChange?: (p: Project) => void
  onOverlayEdit?: (p: Project) => void
  onSelectOverlay?: (id: string | null) => void
  onInspectClip?: (id: string) => void
  subcutClipId: string | null
  setSubcutClipId: (id: string | null) => void
}

const trackColors = [
  { bg: 'bg-slate-600/80',  bgHov: 'hover:bg-slate-500/80',  bgSel: 'bg-slate-500/90',  ring: 'ring-slate-300/80',  border: 'border-slate-400/50',  text: 'text-slate-200',  resHov: 'hover:bg-slate-300/40'  },
  { bg: 'bg-sky-700/80',    bgHov: 'hover:bg-sky-600/80',    bgSel: 'bg-sky-600/90',    ring: 'ring-sky-300/80',    border: 'border-sky-400/50',    text: 'text-sky-200',    resHov: 'hover:bg-sky-300/40'    },
  { bg: 'bg-violet-700/80', bgHov: 'hover:bg-violet-600/80', bgSel: 'bg-violet-600/90', ring: 'ring-violet-300/80', border: 'border-violet-400/50', text: 'text-violet-200', resHov: 'hover:bg-violet-300/40' },
  { bg: 'bg-emerald-700/80',bgHov: 'hover:bg-emerald-600/80',bgSel: 'bg-emerald-600/90',ring: 'ring-emerald-300/80',border: 'border-emerald-400/50',text: 'text-emerald-200',resHov: 'hover:bg-emerald-300/40'},
  { bg: 'bg-rose-700/80',   bgHov: 'hover:bg-rose-600/80',   bgSel: 'bg-rose-600/90',   ring: 'ring-rose-300/80',   border: 'border-rose-400/50',   text: 'text-rose-200',   resHov: 'hover:bg-rose-300/40'   },
  { bg: 'bg-amber-700/60',  bgHov: 'hover:bg-amber-700/80',  bgSel: 'bg-amber-600/80',  ring: 'ring-amber-400/80',  border: 'border-amber-500/50',  text: 'text-amber-200',  resHov: 'hover:bg-amber-300/40'  },
]

export default function VisualTrackRow({
  trackItems,
  trackIdx,
  project,
  selectedOverlayId,
  rippleMode,
  onProjectChange,
  onOverlayEdit,
  onSelectOverlay,
  onInspectClip,
  subcutClipId,
  setSubcutClipId,
}: VisualTrackRowProps) {
  const { totalDuration, snapBoundaries, scrollRef, scrubberRef, currentTime, onTimeUpdate, markers, setMarkers, selection, overlayDraggedRef } = useTimelineContext()
  const tc = trackColors[trackIdx % trackColors.length]
  const markerActive = markers[0] !== null || selection !== null
  const dimmed = markerActive && selectedOverlayId !== null && !trackItems.some(i => i.id === selectedOverlayId)

  const { beginDrag, beginResize } = useItemDragDrop({
    totalDuration,
    snapBoundaries,
    scrollRef,
    draggedFlagRef: overlayDraggedRef,
  })

  function handleItemResizeStart(e: React.MouseEvent, item: VisualItem, edge: 'start' | 'end') {
    if (!onProjectChange) return
    let lastUpdated = project

    beginResize(e, item as Draggable, edge, {
      onLivePreview: ({ item: resized }: DragEventContext) => {
        let next: Project = {
          ...project,
          tracks: (project.tracks ?? []).map(track =>
            track.map(ov => ov.id !== item.id ? ov : { ...ov, start: resized.start, end: resized.end, inPoint: resized.inPoint, outPoint: resized.outPoint })
          ),
        }
        if (rippleMode) next = collapseGaps(next)
        lastUpdated = next
        onProjectChange!(next)
      },
      onCommit: () => {
        onOverlayEdit?.(lastUpdated)
      },
    })
  }

  function handleDeleteOverlay(id: string) {
    if (!onProjectChange) return
    const updated = {
      ...project,
      tracks: (project.tracks ?? [])
        .map(track => track.filter(item => item.id !== id))
        .filter(track => track.length > 0),
    }
    onProjectChange(updated)
    onOverlayEdit?.(updated)
    onSelectOverlay?.(null)
  }

  function handleToggleMute(id: string) {
    if (!onProjectChange) return
    const updated = {
      ...project,
      tracks: (project.tracks ?? []).map(track =>
        track.map(item => item.id === id ? { ...item, muted: !item.muted } : item)
      ),
    }
    onProjectChange(updated)
    onOverlayEdit?.(updated)
  }

  function handleOverlayDragStart(e: React.MouseEvent, item: VisualItem, sourceTrackIdx: number) {
    if ((e.target as HTMLElement).classList.contains('cursor-ew-resize')) return
    if (!onProjectChange) return
    const projectChange = onProjectChange
    const ROW_HEIGHT_PX = 24
    let lastUpdated = project

    beginDrag(e, item as Draggable, {
      onLivePreview: ({ item: moved, dy }: DragEventContext) => {
        const trackDelta = Math.round(dy / ROW_HEIGHT_PX)
        const targetIdx = Math.max(0, sourceTrackIdx - trackDelta)
        const duration = moved.end - moved.start
        const overlapMin = duration * 0.3

        function hasOverlap(track: VisualItem[]): boolean {
          return track.some(ov => {
            if (ov.id === item.id) return false
            return Math.min(moved.end, ov.end) - Math.max(moved.start, ov.start) > overlapMin
          })
        }

        const tracks = lastUpdated.tracks ?? []
        let bestIdx = targetIdx
        outer: for (let delta = 0; delta <= tracks.length; delta++) {
          for (const i of delta === 0 ? [targetIdx] : [targetIdx - delta, targetIdx + delta]) {
            if (i < 0) continue
            const candidateTrack = i < tracks.length ? tracks[i] : []
            if (!hasOverlap(candidateTrack)) { bestIdx = i; break outer }
          }
        }

        const removed = tracks.map(t => t.filter(ov => ov.id !== item.id))
        const movedItem = { ...item, start: moved.start, end: moved.end }
        const final = bestIdx >= removed.length
          ? [...removed, [movedItem]]
          : removed.map((t, i) => i === bestIdx ? [...t, movedItem] : t)

        const next = { ...lastUpdated, tracks: final.filter(t => t.length > 0) }
        projectChange(next)
        lastUpdated = next
      },
      onCommit: () => {
        onOverlayEdit?.(lastUpdated)
      },
    })
  }

  function handleScrubDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (totalDuration === 0) return
    e.preventDefault()
    const t = ratioFromClientX(e.clientX, scrubberRef.current!.getBoundingClientRect()) * totalDuration
    setMarkers(([a, b]) => {
      if (a === null) return [t, null]       // place first marker
      if (b === null) return [a, t]          // place second → selection complete
      return [t, null]                       // reset: start fresh with new first marker
    })
  }

  function handleTrackClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (totalDuration === 0) return
    const clickedTime = ratioFromClientX(e.clientX, scrubberRef.current!.getBoundingClientRect()) * totalDuration
    const rect = scrubberRef.current?.getBoundingClientRect()
    const snapThreshold = rect ? (8 / rect.width) * totalDuration : 0
    const boundaries = snapBoundaries
    for (const b of boundaries) {
      if (Math.abs(clickedTime - b) < snapThreshold) { onTimeUpdate(b); return }
    }
    onTimeUpdate(clickedTime)
  }

  const playheadLine = (
    <div
      className="absolute top-0 bottom-0 w-[2px] bg-red-500 pointer-events-none z-10"
      style={{ left: `${pct(currentTime, totalDuration)}%` }}
    />
  )

  return (
    <div className={`${trackIdx === 0 ? trackRowTall : trackRow} transition-opacity ${dimmed ? 'opacity-30 pointer-events-none' : ''}`} onClick={handleTrackClick} onDoubleClick={handleScrubDoubleClick}>
      {trackItems.map((item) => {
        const isSel = selectedOverlayId === item.id
        return (
          <div
            key={item.id}
            className={`absolute top-0 bottom-0 flex items-center overflow-hidden cursor-grab active:cursor-grabbing
              ${isSel ? `${tc.bgSel} ring-1 ring-inset ${tc.ring}` : `${tc.bg} ${tc.bgHov}`}
              border-r ${tc.border}`}
            style={{ left: `${pct(item.start, totalDuration)}%`, width: `${pct(item.end - item.start, totalDuration)}%` }}
            onClick={(e) => {
              e.stopPropagation()
              if (overlayDraggedRef.current) return
              const selecting = !isSel
              onSelectOverlay?.(selecting ? item.id : null)
              if (selecting) onTimeUpdate(ratioFromClientX(e.clientX, scrubberRef.current!.getBoundingClientRect()) * totalDuration)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (item.generation && onInspectClip) onInspectClip(item.id)
            }}
            onMouseDown={(e) => handleOverlayDragStart(e, item, trackIdx)}
          >
            <div
              className={`absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize z-10 ${tc.resHov}`}
              onMouseDown={(e) => handleItemResizeStart(e, item, 'start')}
            />
            <span className={`text-[10px] ${tc.text} truncate flex-1 min-w-0 pl-3`}>
              ▪ {item.type}
              {project.renderMode === 'ffmpeg-drawtext' && trackIdx > 0 && (
                <span className="ml-1.5 text-amber-400/60">preview</span>
              )}
              {(project.regenQueue ?? []).some(e => e.clipId === item.id) && (
                <span className="ml-1.5 text-amber-300/80 font-medium">queued</span>
              )}
            </span>
            {item.type === 'video' && (
              <button
                className={`shrink-0 mr-3 z-10 cursor-pointer transition-opacity ${item.muted ? 'opacity-30 hover:opacity-60' : 'opacity-50 hover:opacity-90'} ${tc.text}`}
                onClick={(e) => { e.stopPropagation(); handleToggleMute(item.id) }}
                title={item.muted ? 'Unmute' : 'Mute'}
              >
                {item.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
              </button>
            )}
            {isSel && onInspectClip && item.type === 'video' && (
              <button
                className={`shrink-0 ml-1 z-10 cursor-pointer opacity-50 hover:opacity-100 ${tc.text}`}
                onClick={(e) => { e.stopPropagation(); onInspectClip(item.id) }}
                title="Inspect generation"
              ><Info size={10} /></button>
            )}
            {isSel && project.projectType === 'ai_video' && item.generation && (item.end - item.start) >= 3 && (
              <button
                className={`shrink-0 ml-1 z-10 cursor-pointer opacity-50 hover:opacity-100 ${tc.text}`}
                onClick={(e) => { e.stopPropagation(); setSubcutClipId(subcutClipId === item.id ? null : item.id) }}
                title="Subcut regenerate"
              ><Scissors size={10} /></button>
            )}
            {isSel && (
              <button
                className={`shrink-0 ml-1 mr-3 z-10 cursor-pointer opacity-60 hover:opacity-100 ${tc.text} text-[11px] leading-none`}
                onClick={(e) => { e.stopPropagation(); handleDeleteOverlay(item.id) }}
                title="Delete"
              >×</button>
            )}
            <div
              className={`absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize z-10 ${tc.resHov}`}
              onMouseDown={(e) => handleItemResizeStart(e, item, 'end')}
            />
          </div>
        )
      })}
      {playheadLine}
      {selection && (
        <div
          className="absolute inset-y-0 bg-red-500/20 pointer-events-none"
          style={{ left: `${pct(selection.start, totalDuration)}%`, width: `${pct(selection.end - selection.start, totalDuration)}%` }}
        />
      )}
    </div>
  )
}
