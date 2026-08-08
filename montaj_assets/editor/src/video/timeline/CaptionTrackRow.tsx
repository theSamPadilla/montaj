// CaptionTrackRow — the caption track's own row in the timeline.
//
// Captions are NOT part of `tracks[]` (see schema.ts / the plan) — this row
// reads and writes `project.captions` directly, keeping that special-track
// data model intact. One block per segment, positioned on the shared timeline
// scale exactly like VisualTrackRow/AudioTrackRow (same `pct()` + context —
// never a locally-computed px-per-second).
//
// Selection is unified with the preview's caption selection box
// (`selectedCaptionId`/`onSelectCaption`, both owned by VideoEditor — see
// ReviewSurface) and is mutually exclusive with the normal item-selection
// model (`selectedIds`): the two never show handles at once. This row only
// owns the caption→item half of that rule at the CALL site (clicking a block
// below calls `onSelectCaption`, same as the preview's click); the actual
// "also clear selectedIds" side effect lives in VideoEditor's wrapped
// `onSelectCaption`, since a caption can be selected from the preview too,
// outside this row entirely. Timeline.handleSelectItem owns the other half
// (clearing `selectedCaptionId` when a normal item is selected).
//
// Editing a segment's text (double-click) and retiming it (drag an edge) both
// funnel through the single `onCaptionSegmentChange(id, patch)` callback
// (VideoEditor's `handleCaptionSegmentChange`, which wraps `makeCaptionEdit` +
// `sync.mutate`). That function pushes ONE undo entry and enqueues ONE save
// PER CALL, so — unlike VisualTrackRow, which calls its per-tick
// `onProjectChange` on every mousemove during a resize — a drag here stays
// entirely in local state (`live`) until mouseup, where `onCaptionSegmentChange`
// fires exactly once. This mirrors CaptionPreview's drag lifecycle (the
// sibling caption-editing surface), which does the same for the same reason.
import { useEffect, useRef, useState } from 'react'
import type { CaptionSegment, Captions } from '../../schema'
import { pct, trackRow } from './utils'
import { useTimelineContext } from './TimelineContext'
import PlayheadLine from './PlayheadLine'
import { useItemDragDrop } from './useItemDragDrop'
import type { Draggable, DragEventContext } from './useItemDragDrop'
import { EditableSegment } from './EditableSegment'
import type { CaptionEditPatch } from './makeCaptionEdit'

interface CaptionTrackRowProps {
  captionTrack: Captions | undefined
  /** Project frame rate — needed only to make the click-seek land INSIDE the
   *  clicked segment once the preview quantizes the clock (see the click
   *  handler below). */
  fps: number
  /** Shared selection id — see the file header. Null when nothing is selected. */
  selectedCaptionId: string | null
  onSelectCaption?: (id: string | null) => void
  /** The single commit channel for both text edits and retiming. */
  onCaptionSegmentChange?: (segmentId: string, patch: CaptionEditPatch) => void
}

export default function CaptionTrackRow({ captionTrack, fps, selectedCaptionId, onSelectCaption, onCaptionSegmentChange }: CaptionTrackRowProps) {
  const { totalDuration, snapBoundaries, scrollRef, zoomRef, overlayDraggedRef, clock } = useTimelineContext()
  const { beginResize } = useItemDragDrop({
    totalDuration,
    snapBoundaries,
    scrollRef,
    zoomRef,
    draggedFlagRef: overlayDraggedRef,
  })

  // In-flight edge-drag geometry for the dragged segment only, keyed by id so a
  // stale `live` from a previous gesture can never leak onto a different
  // segment. Never written to the project mid-drag — see file header.
  const [live, setLive] = useState<{ id: string; start: number; end: number } | null>(null)
  // Which segment's text is currently in the contentEditable state (double-
  // click to enter, blur to exit). At most one at a time — no multi-edit.
  const [editingId, setEditingId] = useState<string | null>(null)

  const segments = captionTrack?.segments ?? []

  // Empty state: no `project.captions`, or a track with zero segments. Still
  // rendered (not `null`) so the operator can see captions exist as a concept
  // even before any exist.
  if (segments.length === 0) {
    return (
      <div className={trackRow}>
        <PlayheadLine />
        <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
          <span className="text-[10px] text-gray-500 italic select-none">Captions</span>
        </div>
      </div>
    )
  }

  function handleEdgeDrag(e: React.MouseEvent, seg: CaptionSegment, edge: 'start' | 'end') {
    if (!seg.id || !onCaptionSegmentChange) return
    const segId = seg.id
    const origStart = seg.start
    const origEnd = seg.end
    let committedValue = edge === 'start' ? origStart : origEnd

    beginResize(e, seg as Draggable, edge, {
      onLivePreview: ({ item: resized }: DragEventContext) => {
        // `resized` is the hook's `{ ...seg, [edge]: <new value> }` — it spreads
        // the full segment (text, words, offsets) because the hook is generic
        // and doesn't know it's a caption. Read ONLY the one numeric field that
        // changed; the rest of `resized` is discarded, never persisted.
        committedValue = edge === 'start' ? resized.start : resized.end
        setLive({
          id: segId,
          start: edge === 'start' ? committedValue : origStart,
          end: edge === 'end' ? committedValue : origEnd,
        })
      },
      onCommit: () => {
        // `beginResize` commits unconditionally on mouseup — unlike `beginDrag`
        // it has no travel threshold — so a bare click on the 6px edge handle
        // lands here with the edge untouched. Committing that would push an
        // undo entry and queue a save for an unchanged project, since
        // onCaptionSegmentChange is a full `sync.mutate` (see file header).
        if (committedValue === (edge === 'start' ? origStart : origEnd)) {
          setLive(null)
          return
        }
        // Patch carries ONLY the dragged edge — never `text` — so
        // makeCaptionEdit never respreads word timings on a pure retime.
        onCaptionSegmentChange(segId, edge === 'start' ? { start: committedValue } : { end: committedValue })
        setLive(null)
      },
    })
  }

  return (
    <div className={trackRow}>
      <PlayheadLine />
      {segments.map((seg) => {
        // `live` must be checked for null FIRST: an id-less segment (seg.id
        // === undefined, e.g. before backfillCaptionIds runs) would otherwise
        // compare equal to a null `live` (undefined === undefined), making
        // isLive true and dereferencing null on the next two lines.
        const isLive = live !== null && live.id === seg.id
        const start = isLive ? live.start : seg.start
        const end = isLive ? live.end : seg.end
        const isSelected = !!seg.id && selectedCaptionId === seg.id
        const isEditing = !!seg.id && editingId === seg.id
        // A segment briefly lacks an id in the window before VideoEditor's
        // backfillCaptionIds effect mints one — `handleCaptionSegmentChange`
        // only accepts a string id, so stay non-interactive until then (same
        // guard CaptionPreview uses for its selection box).
        const canInteract = !!seg.id

        return (
          <div
            key={seg.id ?? `${seg.start}-${seg.end}`}
            className={`absolute top-1 bottom-1 rounded flex items-center overflow-hidden
              ${canInteract ? 'cursor-pointer' : ''}
              ${isSelected ? 'bg-purple-600/70 ring-1 ring-inset ring-purple-300/80' : 'bg-purple-700/40 hover:bg-purple-600/50 border border-purple-500/40'}`}
            style={{ left: `${pct(start, totalDuration)}%`, width: `${pct(end - start, totalDuration)}%` }}
            onClick={(e) => {
              e.stopPropagation()
              if (!canInteract || overlayDraggedRef.current) return
              onSelectCaption?.(seg.id!)
              // Seek to the segment on a fresh select (not on re-clicking an
              // already-selected block). Load-bearing: the preview only shows
              // drag handles for the segment active AT THE PLAYHEAD, so
              // selecting from here without seeking would select a segment the
              // preview can't yet act on.
              //
              // Half a frame IN, not to `start` itself. CaptionPreview snaps the
              // clock to the frame grid before running the templates' own
              // `t >= start && t < end` test (`t = Math.round(currentTime * fps)
              // / fps`), and caption starts are arbitrary floats out of Whisper.
              // Seeking to exactly `start` rounds DOWN into the PREVIOUS segment
              // whenever `start * fps` has a fractional part below 0.5 — about
              // half of all segments (e.g. start 3.44 at 30fps → frame 103 →
              // t 3.4333 < 3.44). `start + 0.5 / fps` puts `t` in
              // [start, start + 1/fps), always inside: `beginResize` enforces a
              // 0.1s floor on segment duration, so no segment is under a frame.
              if (!isSelected) clock.set(start + 0.5 / fps)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (!canInteract) return
              setEditingId(seg.id!)
            }}
          >
            {canInteract && (
              <div
                className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-10 hover:bg-purple-300/40"
                onMouseDown={(e) => handleEdgeDrag(e, seg, 'start')}
              />
            )}
            <span className="text-[10px] text-purple-100 truncate flex-1 min-w-0 px-2">
              {isEditing ? (
                <EditableSegmentAutofocus
                  seg={seg}
                  onEdit={(text) => onCaptionSegmentChange?.(seg.id!, { text })}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                seg.text
              )}
            </span>
            {canInteract && (
              <div
                className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-10 hover:bg-purple-300/40"
                onMouseDown={(e) => handleEdgeDrag(e, seg, 'end')}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// Wraps EditableSegment (unmodified — the same component TranscriptPanel uses)
// with focus-on-mount. Double-click swaps a plain label for this contentEditable
// span on the NEXT render, by which point the browser's native dblclick text
// selection has already resolved against the old, non-editable element — so
// without this the operator would need a third click just to place a cursor.
function EditableSegmentAutofocus({ seg, onEdit, onDone }: { seg: CaptionSegment; onEdit: (text: string) => void; onDone: () => void }) {
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = wrapRef.current?.querySelector<HTMLElement>('[contenteditable]')
    if (!el) return
    el.focus()
    // Place the caret at the end rather than leaving it at the browser default
    // (start), so continuing to type appends instead of interrupting mid-word.
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, [])

  return (
    <span ref={wrapRef} onBlur={onDone} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <EditableSegment seg={seg} onEdit={onEdit} />
    </span>
  )
}
