import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Volume2, VolumeX } from 'lucide-react'
import type { CaptionSegment, VisualItem, Project } from '@/lib/project'

interface TimelineProps {
  project: Project
  currentTime: number
  onTimeUpdate: (t: number) => void
  onProjectChange?: (p: Project) => void
  onCaptionEdit?: (p: Project) => void
  onOverlayEdit?: (p: Project) => void
  selectedOverlayId?: string
  onSelectOverlay?: (id: string | null) => void
  onCut?: (cut: { start: number; end: number }) => void
}


function formatTime(s: number): string {
  const m   = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1)
  return `${m}:${sec.padStart(4, '0')}`
}

function EditableSegment({ seg, onEdit }: { seg: CaptionSegment; onEdit: (text: string) => void }) {
  const spanRef = useRef<HTMLSpanElement>(null)

  function handleBlur() {
    const text = spanRef.current?.textContent?.trim() ?? ''
    if (!text) { if (spanRef.current) spanRef.current.textContent = seg.text; return }
    if (text !== seg.text) onEdit(text)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLSpanElement>) {
    if (e.key === 'Enter') { e.preventDefault(); spanRef.current?.blur() }
    if (e.key === 'Escape') { if (spanRef.current) spanRef.current.textContent = seg.text; spanRef.current?.blur() }
  }

  return (
    <span
      ref={spanRef}
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className="cursor-text rounded px-0.5 hover:bg-white/5 focus:bg-white/10 focus:outline-none focus:ring-1 focus:ring-purple-500/40"
    >
      {seg.text}
    </span>
  )
}


export default function Timeline({ project, currentTime, onTimeUpdate, onProjectChange, onCaptionEdit, onOverlayEdit, selectedOverlayId, onSelectOverlay, onCut }: TimelineProps) {
  const clips         = [...(project.tracks?.[0] ?? [])]
  const captionTrack  = project.captions
  const overlayTracks = project.tracks?.slice(1) ?? []
  const clipsDuration  = clips.length > 0 ? Math.max(...clips.map(c => c.end)) : 0
  const totalDuration  = clipsDuration > 0
    ? clipsDuration
    : overlayTracks.flat().reduce((m, i) => Math.max(m, i.end ?? 0), 0)

  const [hoverPct, setHoverPct]               = useState<number | null>(null)
  const [draggingPlayhead, setDraggingPlayhead] = useState(false)
  const [markers, setMarkers]                 = useState<[number | null, number | null]>([null, null])
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false)

  const scrubberRef                           = useRef<HTMLDivElement>(null)
  const overlayDraggedRef                     = useRef(false)
  const [keyNavTime, setKeyNavTime]           = useState<number | null>(null)
  const keyNavTimerRef                        = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!transcriptModalOpen) return
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setTranscriptModalOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [transcriptModalOpen])

  useEffect(() => {
    if (totalDuration === 0) return
    const fps = project.settings?.fps ?? 30
    const frame = 1 / fps
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
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


  function pct(t: number) { return totalDuration > 0 ? (t / totalDuration) * 100 : 0 }

  function handleOverlayResizeStart(e: React.MouseEvent, item: VisualItem, edge: 'start' | 'end') {
    e.stopPropagation()
    e.preventDefault()
    if (!onProjectChange) return

    const initX    = e.clientX
    const initTime = edge === 'start' ? item.start : item.end
    let lastUpdated = project

    function buildUpdated(moveE: MouseEvent): Project {
      if (!scrubberRef.current) return project
      const rect = scrubberRef.current.getBoundingClientRect()
      const dt   = ((moveE.clientX - initX) / rect.width) * totalDuration
      const t    = Math.max(0, Math.min(totalDuration, initTime + dt))
      const primaryTrack = project.tracks?.[0] ?? []
      const overlayTs = project.tracks?.slice(1) ?? []
      return {
        ...project,
        tracks: [primaryTrack, ...overlayTs.map(track =>
          track.map(ov =>
            ov.id !== item.id ? ov :
            edge === 'start'
              ? { ...ov, start: Math.min(t, ov.end - 0.1) }
              : { ...ov, end: Math.max(t, ov.start + 0.1) }
          )
        )],
      }
    }

    function onMove(moveE: MouseEvent) {
      lastUpdated = buildUpdated(moveE)
      onProjectChange!(lastUpdated)
    }

    function onUp() {
      onOverlayEdit?.(lastUpdated)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function handleDeleteOverlay(id: string) {
    if (!onProjectChange) return
    const primaryTrack = project.tracks?.[0] ?? []
    const overlayTs = project.tracks?.slice(1) ?? []
    const updated = {
      ...project,
      tracks: [primaryTrack, ...overlayTs
        .map(track => track.filter(ov => ov.id !== id))
        .filter(track => track.length > 0)],
    }
    onProjectChange(updated)
    onOverlayEdit?.(updated)
    onSelectOverlay?.(null)
  }

  function handleToggleMute(id: string) {
    if (!onProjectChange) return
    const primaryTrack = project.tracks?.[0] ?? []
    const overlayTs = project.tracks?.slice(1) ?? []
    const updated = {
      ...project,
      tracks: [primaryTrack, ...overlayTs.map(track =>
        track.map(item => item.id === id ? { ...item, muted: !item.muted } : item)
      )],
    }
    onProjectChange(updated)
    onOverlayEdit?.(updated)
  }

  function handleOverlayDragStart(e: React.MouseEvent, item: VisualItem, sourceTrackIdx: number) {
    if ((e.target as HTMLElement).classList.contains('cursor-ew-resize')) return
    if (!onProjectChange) return
    const projectChange = onProjectChange
    e.stopPropagation()

    const initX = e.clientX
    const initY = e.clientY
    const initStart = item.start
    const initEnd   = item.end
    const duration  = initEnd - initStart
    const ROW_HEIGHT_PX = 24
    let lastUpdated = project

    function onMove(moveE: MouseEvent) {
      overlayDraggedRef.current = true
      const rect = scrubberRef.current?.getBoundingClientRect()
      const dx = rect ? ((moveE.clientX - initX) / rect.width) * totalDuration : 0
      const dy = moveE.clientY - initY

      const newStart = Math.max(0, Math.min(totalDuration - duration, initStart + dx))
      const newEnd   = newStart + duration
      const movedItem = { ...item, start: newStart, end: newEnd }

      const trackDelta = Math.round(dy / ROW_HEIGHT_PX)
      const targetIdx  = Math.max(0, sourceTrackIdx + trackDelta)
      const primaryTrack = lastUpdated.tracks?.[0] ?? []
      const overlayTracks = lastUpdated.tracks?.slice(1) ?? []

      function hasOverlap(track: VisualItem[]): boolean {
        return track.some(ov => ov.id !== item.id && ov.start < newEnd && ov.end > newStart)
      }

      let bestIdx = targetIdx
      for (let i = targetIdx; i <= overlayTracks.length; i++) {
        const candidateTrack = i < overlayTracks.length ? overlayTracks[i] : []
        if (!hasOverlap(candidateTrack)) { bestIdx = i; break }
      }

      const removed = overlayTracks.map(t => t.filter(ov => ov.id !== item.id))
      const final = bestIdx >= removed.length
        ? [...removed, [movedItem]]
        : removed.map((t, i) => i === bestIdx ? [...t, movedItem] : t)

      const next = { ...lastUpdated, tracks: [primaryTrack, ...final.filter(t => t.length > 0)] }
      projectChange(next)
      lastUpdated = next
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (overlayDraggedRef.current) {
        onOverlayEdit?.(lastUpdated)
        // reset after click event fires
        setTimeout(() => { overlayDraggedRef.current = false }, 0)
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function ratioFromClientX(clientX: number): number {
    if (!scrubberRef.current) return 0
    const rect = scrubberRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  function handleScrubClick(e: React.MouseEvent<HTMLDivElement>) {
    if (totalDuration === 0) return
    onTimeUpdate(ratioFromClientX(e.clientX) * totalDuration)
  }

  function handleScrubDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (totalDuration === 0) return
    e.preventDefault()
    const t = ratioFromClientX(e.clientX) * totalDuration
    setMarkers(([a, b]) => {
      if (a === null) return [t, null]       // place first marker
      if (b === null) return [a, t]          // place second → selection complete
      return [t, null]                       // reset: start fresh with new first marker
    })
  }

  const playheadLine = (
    <div
      className="absolute top-0 bottom-0 w-px bg-red-500/80 pointer-events-none z-10"
      style={{ left: `${pct(currentTime)}%` }}
    />
  )

  const hoverLine = hoverPct !== null ? (
    <div
      className="absolute top-0 bottom-0 w-px bg-white/20 pointer-events-none z-10"
      style={{ left: `${hoverPct}%` }}
    />
  ) : null

  const trackRow = 'relative h-10 bg-gray-100 dark:bg-gray-900 rounded overflow-hidden cursor-pointer'

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).isContentEditable) return

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedOverlayId) {
      e.preventDefault()
      handleDeleteOverlay(selectedOverlayId)
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

  function handleTrackClick(e: React.MouseEvent) {
    if (totalDuration === 0) return
    onTimeUpdate(ratioFromClientX(e.clientX) * totalDuration)
  }

  function makeCaptionEdit(globalIdx: number) {
    return (text: string) => {
      if (!project.captions) return
      const updated = {
        ...project,
        captions: {
          ...project.captions,
          segments: project.captions.segments.map((s, j) => {
            if (j !== globalIdx) return s
            const newWords = text.split(/\s+/).filter(Boolean)
            const segDur = s.end - s.start
            const wordDur = segDur / (newWords.length || 1)
            const words = newWords.map((w, wi) => ({
              word: w,
              start: s.start + wi * wordDur,
              end: s.start + (wi + 1) * wordDur,
            }))
            return { ...s, text, words }
          }),
        },
      }
      onProjectChange?.(updated)
      onCaptionEdit?.(updated)
    }
  }

  return (
    <div
      className="flex flex-col gap-2 px-3 py-3 select-none outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseMove={(e) => setHoverPct(ratioFromClientX(e.clientX) * 100)}
      onMouseLeave={() => setHoverPct(null)}
    >

      {/* ── Scrubber ── */}
      <div
        ref={scrubberRef}
        className={`relative h-4 rounded-full bg-gray-200 dark:bg-gray-800 group ${markers[0] !== null && markers[1] === null ? 'cursor-cell' : 'cursor-crosshair'}`}
        onClick={handleScrubClick}
        onDoubleClick={handleScrubDoubleClick}
      >
        {/* Elapsed fill */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gray-400 dark:bg-gray-600 pointer-events-none"
          style={{ width: `${pct(currentTime)}%` }}
        />

        {/* Selection range fill (both markers placed) */}
        {selection && (
          <div
            className="absolute inset-y-0 bg-amber-500/25 pointer-events-none"
            style={{ left: `${pct(selection.start)}%`, width: `${pct(selection.end - selection.start)}%` }}
          />
        )}

        {/* Marker A */}
        {markers[0] !== null && (
          <div className="absolute top-0 bottom-0 w-px bg-amber-400 pointer-events-none" style={{ left: `${pct(markers[0])}%` }}>
            <div className="absolute -top-0.5 -translate-x-1/2 w-2 h-2 bg-amber-400 rotate-45" />
          </div>
        )}

        {/* Marker B */}
        {markers[1] !== null && (
          <div className="absolute top-0 bottom-0 w-px bg-amber-400 pointer-events-none" style={{ left: `${pct(markers[1])}%` }}>
            <div className="absolute -top-0.5 -translate-x-1/2 w-2 h-2 bg-amber-400 rotate-45" />
          </div>
        )}

        {/* Hover ghost */}
        {hoverLine}

        {/* Playhead handle */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-red-500 ring-2 ring-red-500/30 transition-transform group-hover:scale-125 ${draggingPlayhead ? 'cursor-grabbing scale-125' : 'cursor-grab'}`}
          style={{ left: `${pct(currentTime)}%` }}
          onMouseDown={(e) => {
            e.stopPropagation()
            if (totalDuration === 0) return
            setDraggingPlayhead(true)
            function onMove(me: MouseEvent) {
              onTimeUpdate(ratioFromClientX(me.clientX) * totalDuration)
            }
            function onUp() {
              setDraggingPlayhead(false)
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            handleScrubDoubleClick(e as React.MouseEvent<HTMLDivElement>)
          }}
        >
          {keyNavTime !== null && (
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-gray-800 border border-gray-700 text-white text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap z-20">
              {formatTime(keyNavTime)}
            </div>
          )}
        </div>

        {/* Time tooltip */}
        {hoverPct !== null && totalDuration > 0 && (
          <div
            className="absolute -top-7 -translate-x-1/2 bg-gray-800 border border-gray-700 text-white text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap z-20"
            style={{ left: `${hoverPct}%` }}
          >
            {formatTime((hoverPct / 100) * totalDuration)}
          </div>
        )}
      </div>

      {/* Time readout + marker / selection range */}
      <div className="flex items-center justify-between text-[10px] font-mono text-gray-600 -mt-1">
        <span>{formatTime(currentTime)}</span>
        {markers[0] !== null && markers[1] === null && (
          <span className="text-amber-400/80">
            {formatTime(markers[0])} — double-click to set end
            <button
              className="ml-2 text-gray-600 hover:text-gray-400"
              onClick={(e) => { e.stopPropagation(); setMarkers([null, null]) }}
            >✕</button>
          </span>
        )}
        {selection && (
          <span className="flex items-center gap-2 text-amber-400">
            <button
              className="text-gray-600 hover:text-gray-400"
              onClick={(e) => { e.stopPropagation(); setMarkers([null, null]) }}
            >✕</button>
            {formatTime(selection.start)} – {formatTime(selection.end)}
            {onCut && (
              <button
                className="px-2 py-0.5 rounded bg-red-600/80 hover:bg-red-500 text-white text-[10px] font-medium transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onCut(selection)
                  setMarkers([null, null])
                }}
              >
                Cut
              </button>
            )}
          </span>
        )}
        <span>{formatTime(totalDuration)}</span>
      </div>

      {/* ── Tracks ── */}
      <div className="flex flex-col gap-1.5">
        {clips.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Clips</span>
            <div className={`${trackRow} cursor-default`} onClick={handleTrackClick} onDoubleClick={handleScrubDoubleClick}>
              {clips.map((clip) => (
                <div
                  key={clip.id}
                  className="absolute top-0 bottom-0 bg-indigo-700/70 border-r border-indigo-500/40 flex items-center overflow-hidden pointer-events-none"
                  style={{ left: `${pct(clip.start)}%`, width: `${pct(clip.end - clip.start)}%` }}
                >
                  <span className="text-[10px] text-indigo-200 truncate pl-2">▪ clip</span>
                </div>
              ))}
              {hoverLine}
              {playheadLine}
              {selection && (
                <div
                  className="absolute inset-y-0 bg-red-500/20 pointer-events-none"
                  style={{ left: `${pct(selection.start)}%`, width: `${pct(selection.end - selection.start)}%` }}
                />
              )}
            </div>
          </div>
        )}
        {overlayTracks.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Overlays</span>
            {[...overlayTracks].reverse().map((trackItems, reversedIdx) => {
              const trackIdx = overlayTracks.length - 1 - reversedIdx
              // Per-track color palette (cycles for >6 tracks)
              const trackColors = [
                { bg: 'bg-slate-600/80',  bgHov: 'hover:bg-slate-500/80',  bgSel: 'bg-slate-500/90',  ring: 'ring-slate-300/80',  border: 'border-slate-400/50',  text: 'text-slate-200',  resHov: 'hover:bg-slate-300/40'  },
                { bg: 'bg-sky-700/80',    bgHov: 'hover:bg-sky-600/80',    bgSel: 'bg-sky-600/90',    ring: 'ring-sky-300/80',    border: 'border-sky-400/50',    text: 'text-sky-200',    resHov: 'hover:bg-sky-300/40'    },
                { bg: 'bg-violet-700/80', bgHov: 'hover:bg-violet-600/80', bgSel: 'bg-violet-600/90', ring: 'ring-violet-300/80', border: 'border-violet-400/50', text: 'text-violet-200', resHov: 'hover:bg-violet-300/40' },
                { bg: 'bg-emerald-700/80',bgHov: 'hover:bg-emerald-600/80',bgSel: 'bg-emerald-600/90',ring: 'ring-emerald-300/80',border: 'border-emerald-400/50',text: 'text-emerald-200',resHov: 'hover:bg-emerald-300/40'},
                { bg: 'bg-rose-700/80',   bgHov: 'hover:bg-rose-600/80',   bgSel: 'bg-rose-600/90',   ring: 'ring-rose-300/80',   border: 'border-rose-400/50',   text: 'text-rose-200',   resHov: 'hover:bg-rose-300/40'   },
                { bg: 'bg-amber-700/60',  bgHov: 'hover:bg-amber-700/80',  bgSel: 'bg-amber-600/80',  ring: 'ring-amber-400/80',  border: 'border-amber-500/50',  text: 'text-amber-200',  resHov: 'hover:bg-amber-300/40'  },
              ]
              const tc = trackColors[trackIdx % trackColors.length]
              return (
              <div key={trackIdx} className={trackRow} onClick={handleTrackClick} onDoubleClick={handleScrubDoubleClick}>
                {trackItems.map((item) => {
                  const isSel = selectedOverlayId === item.id
                  return (
                    <div
                      key={item.id}
                      className={`absolute top-0 bottom-0 flex items-center overflow-hidden cursor-grab active:cursor-grabbing
                        ${isSel ? `${tc.bgSel} ring-1 ring-inset ${tc.ring}` : `${tc.bg} ${tc.bgHov}`}
                        border-r ${tc.border}`}
                      style={{ left: `${pct(item.start)}%`, width: `${pct(item.end - item.start)}%` }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (overlayDraggedRef.current) return
                        const selecting = !isSel
                        onSelectOverlay?.(selecting ? item.id : null)
                        if (selecting) onTimeUpdate(ratioFromClientX(e.clientX) * totalDuration)
                      }}
                      onMouseDown={(e) => handleOverlayDragStart(e, item, trackIdx)}
                    >
                      <div
                        className={`absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize z-10 ${tc.resHov}`}
                        onMouseDown={(e) => handleOverlayResizeStart(e, item, 'start')}
                      />
                      <span className={`text-[10px] ${tc.text} truncate flex-1 min-w-0 pl-3`}>
                        ▪ {item.type}
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
                      {isSel && (
                        <button
                          className={`shrink-0 ml-1 mr-3 z-10 cursor-pointer opacity-60 hover:opacity-100 ${tc.text} text-[11px] leading-none`}
                          onClick={(e) => { e.stopPropagation(); handleDeleteOverlay(item.id) }}
                          title="Delete overlay"
                        >×</button>
                      )}
                      <div
                        className={`absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize z-10 ${tc.resHov}`}
                        onMouseDown={(e) => handleOverlayResizeStart(e, item, 'end')}
                      />
                    </div>
                  )
                })}
                {hoverLine}
                {playheadLine}
              </div>
            )})}
          </div>
        )}
      </div>

      {/* ── Transcript editor ── */}
      {(() => {
        const segs = captionTrack?.segments ?? []
        // Find active segment index
        const activeIdx = segs.findIndex(s => currentTime >= s.start && currentTime < s.end)
        const nearIdx   = activeIdx !== -1 ? activeIdx
          : segs.reduce((best, s, i) => s.start <= currentTime ? i : best, -1)
        // Vicinity: active ± 2 segments; track start offset for O(1) global index
        const vicinityStart = nearIdx !== -1 ? Math.max(0, nearIdx - 2) : 0
        const vicinitySegs = nearIdx !== -1
          ? segs.slice(vicinityStart, nearIdx + 3)
          : segs.slice(0, 3)

        return (
          <div className="rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">Captions</span>
              <div className="flex items-center gap-2">
                {captionTrack && (['word-by-word', 'pop', 'karaoke', 'subtitle'] as const).map(style => {
                  const active = captionTrack.style === style
                  return (
                    <button
                      key={style}
                      className={`text-[10px] rounded px-2 py-0.5 transition-all border ${
                        active
                          ? 'bg-purple-600/30 border-purple-500/60 text-purple-300'
                          : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500'
                      }`}
                      onClick={() => {
                        if (!project.captions) return
                        const updated = { ...project, captions: { ...project.captions, style } }
                        onCaptionEdit?.(updated)
                      }}
                    >
                      {style}
                    </button>
                  )
                })}
                {segs.length > 0 && (
                  <button
                    className="text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded px-2 py-0.5 transition-all"
                    onClick={() => setTranscriptModalOpen(true)}
                  >
                    Expand ↑
                  </button>
                )}
              </div>
            </div>

            <div className="h-10 overflow-y-auto">
            {segs.length === 0 ? (
              <p className="text-xs text-gray-600 italic">No transcript — captions are generated during the agent pass</p>
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
                {vicinitySegs.map((seg, vi) => {
                  const i = vicinityStart + vi
                  const isActive = currentTime >= seg.start && currentTime < seg.end
                  return (
                    <span key={seg.id ?? i}>
                      {vi > 0 && ' '}
                      <span className="text-gray-500 text-[10px] font-mono mr-1">{formatTime(seg.start)}</span>
                      <span className={isActive ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}>
                        <EditableSegment seg={seg} onEdit={makeCaptionEdit(i)} />
                      </span>
                    </span>
                  )
                })}
              </p>
            )}
            </div>
          </div>
        )
      })()}

      {/* ── Transcript modal ── */}
      {transcriptModalOpen && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setTranscriptModalOpen(false)}
        >
          <div
            className="relative w-full max-w-xl max-h-[70vh] flex flex-col bg-gray-950 border border-gray-800 rounded-lg shadow-2xl mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
              <span className="text-sm font-medium text-gray-200">Transcript</span>
              <button
                className="text-gray-500 hover:text-white transition-colors text-lg leading-none"
                onClick={() => setTranscriptModalOpen(false)}
              >×</button>
            </div>

            {/* Segment list */}
            <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1.5">
              {(captionTrack?.segments ?? []).map((seg, i) => {
                const isActive = currentTime >= seg.start && currentTime < seg.end
                return (
                  <div
                    key={seg.id ?? i}
                    className={`flex gap-3 items-baseline px-2 py-1 rounded transition-colors ${isActive ? 'bg-white/5' : ''}`}
                  >
                    <span className="text-gray-600 text-[10px] font-mono shrink-0 w-12 pt-px">{formatTime(seg.start)}</span>
                    <span className={`text-sm leading-snug ${isActive ? 'text-white' : 'text-gray-300'}`}>
                      <EditableSegment seg={seg} onEdit={makeCaptionEdit(i)} />
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  )
}
