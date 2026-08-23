// Sidebar caption editor (SP5-captions Phase 5). Replaces the bottom
// TranscriptPanel + its "Expand" TranscriptModal: instead of a two-line
// vicinity strip at the bottom of the timeline pane, every caption segment
// lives in a searchable, numbered list in the right rail, with the track-level
// style/size/color controls tucked behind a collapsible subsection so the list
// stays the prominent thing in a ~300px-wide column.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Search, Trash2 } from 'lucide-react'
import type { Project } from '../types'
import type { PlaybackClock } from './playback-clock'
import type { CaptionEditPatch } from './timeline/makeCaptionEdit'
import { EditableSegment } from './timeline/EditableSegment'
import { formatTime } from './timeline/utils'
import { SwatchInput } from '../ui'
import { reviveBoolean, usePersistentState } from '../ui/usePersistentState'

/** Whether the "Caption style" subsection (size/color/preset controls) is
 *  expanded. A DIFFERENT key than the retired TranscriptPanel's
 *  'montaj.editor.captionsPanelExpanded' — that key gated the whole old
 *  bottom panel (controls + transcript body together); reusing it here would
 *  make this list inherit a stale on/off state that meant something else. */
const CAPTION_STYLE_STORAGE_KEY = 'montaj.editor.captionListStyleExpanded'

const STYLES = ['word-by-word', 'pop', 'karaoke', 'subtitle', 'highlight-box', 'outline', 'clean'] as const

// ── Ported from TranscriptPanel.tsx (that file is being deleted) ──
// Each caption style reads a different accent-color prop in its render template
// (see render/templates/captions/*.jsx). The color control writes whichever field
// the active style uses; `clean` and `word-by-word` have no accent (omitted here).
type CaptionStyle = NonNullable<Project['captions']>['style']
type AccentField = 'accentColor' | 'highlightColor' | 'activeColor' | 'backgroundColor'
const ACCENT: Partial<Record<CaptionStyle, { field: AccentField; label: string; def: string }>> = {
  karaoke:         { field: 'highlightColor',  label: 'Highlight', def: '#ffffff' },
  pop:             { field: 'activeColor',     label: 'Active',    def: '#ffe600' },
  'highlight-box': { field: 'accentColor',     label: 'Accent',    def: '#fbbf24' },
  outline:         { field: 'accentColor',     label: 'Accent',    def: '#fbbf24' },
  subtitle:        { field: 'backgroundColor', label: 'Box',       def: '#000000' },
}

// The native <input type="color"> only accepts #rrggbb. Stored values are always
// hex once picked; fall back to the style default for unset / non-hex (e.g. an
// rgba() template default) so the swatch never gets an invalid value.
const HEX = /^#[0-9a-f]{6}$/i
const toHex = (v: unknown, fallback: string): string =>
  typeof v === 'string' && HEX.test(v) ? v : fallback

/** A double-click-to-edit request from the canvas timeline (Phase 6). `nonce`
 *  changes on every request even if `id` repeats, so re-double-clicking the
 *  same segment re-triggers the scroll + focus instead of being a no-op. */
export interface CaptionEditFocusRequest {
  id: string
  nonce: number
}

/** Builds the NEXT edit-focus request from whatever VideoEditor's `editFocusId`
 *  state currently holds. Pure and exported (rather than inlined at the one
 *  call site, VideoEditor.tsx's `handleEditCaption`) so the increment can be
 *  unit-tested directly instead of only through source-text matching, which
 *  pins formatting rather than behaviour and would miss a wrong-operator bug.
 *  The nonce climbs off the PREVIOUS request regardless of id — not a
 *  per-id counter — so double-clicking the SAME caption twice always produces
 *  two distinct requests (see the doc comment on the type above). */
export function nextEditFocus(prev: CaptionEditFocusRequest | null, id: string): CaptionEditFocusRequest {
  return { id, nonce: (prev?.nonce ?? 0) + 1 }
}

export interface CaptionListPanelProps {
  captionTrack: Project['captions'] | undefined
  project: Project
  /** Playhead time — drives the active-segment highlight. Supplied by a
   *  clock-subscribing wrapper at the mount site (see VideoEditor.tsx's
   *  `CaptionListPanelWithClock`, mirroring Timeline.tsx's
   *  `TranscriptPanelWithClock`) so only this leaf re-renders per tick. */
  currentTime: number
  /** Unified selection (D1: caption ids share `selectedIds` with clips and
   *  audio). Used only to derive which segment (if any) is selected. */
  selectedIds: string[]
  onSelectCaption: (id: string | null) => void
  /** Commit a single-segment patch — text edits and the per-segment color
   *  swatch. */
  onCaptionSegmentChange?: (segmentId: string, patch: CaptionEditPatch) => void
  /** Whole-project commit — style/fontsize/track-color changes and "Remove
   *  all". */
  onCaptionEdit?: (project: Project) => void
  /** Live preview only, no save, no undo entry — fontsize drag and
   *  track/segment color picks fire this on every intermediate value. */
  onProjectChange?: (project: Project) => void
  /** Delete one segment by id, via the whole-track channel. There is no add
   *  counterpart (R4): captions come from transcription, and Regenerate
   *  rebuilds the whole track. */
  onCaptionSegmentDelete?: (segmentId: string) => void
  /** Opens the caption-regeneration modal. Provided only when the host
   *  adapter supports `generateCaptions`; absent → the button is hidden. */
  onRegenerateCaptions?: () => void
  fps: number
  /** Imperative seek target for a row click (see the half-frame comment
   *  below) — separate from `currentTime`, which only drives the highlight. */
  clock: PlaybackClock
  /** Phase 6 wires the canvas double-click into this; scrolls the target row
   *  into view and focuses its `EditableSegment` when `nonce` changes. */
  editFocusId?: CaptionEditFocusRequest | null
}

export default function CaptionListPanel({
  captionTrack,
  project,
  currentTime,
  selectedIds,
  onSelectCaption,
  onCaptionSegmentChange,
  onCaptionEdit,
  onProjectChange,
  onCaptionSegmentDelete,
  onRegenerateCaptions,
  fps,
  clock,
  editFocusId,
}: CaptionListPanelProps) {
  const segs = captionTrack?.segments ?? []

  // Nothing to show and nothing to offer — no captions yet, and the host
  // doesn't support generating them from here either.
  if (segs.length === 0 && !captionTrack && !onRegenerateCaptions) return null

  return (
    <CaptionListPanelBody
      captionTrack={captionTrack}
      project={project}
      currentTime={currentTime}
      selectedIds={selectedIds}
      onSelectCaption={onSelectCaption}
      onCaptionSegmentChange={onCaptionSegmentChange}
      onCaptionEdit={onCaptionEdit}
      onProjectChange={onProjectChange}
      onCaptionSegmentDelete={onCaptionSegmentDelete}
      onRegenerateCaptions={onRegenerateCaptions}
      fps={fps}
      clock={clock}
      editFocusId={editFocusId}
    />
  )
}

// Split from the default export so the early `return null` above stays a
// clean guard clause — the hooks below can't run conditionally, and this
// component only mounts once that guard has already passed.
function CaptionListPanelBody({
  captionTrack,
  project,
  currentTime,
  selectedIds,
  onSelectCaption,
  onCaptionSegmentChange,
  onCaptionEdit,
  onProjectChange,
  onCaptionSegmentDelete,
  onRegenerateCaptions,
  fps,
  clock,
  editFocusId,
}: CaptionListPanelProps) {
  const segs = captionTrack?.segments ?? []
  const [search, setSearch] = useState('')
  const [styleExpanded, setStyleExpanded] = usePersistentState(CAPTION_STYLE_STORAGE_KEY, false, reviveBoolean)

  // ── Remove all (confirm-twice, ported from TranscriptPanel) ──
  const [confirmRemove, setConfirmRemove] = useState(false)
  const removeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (removeTimeoutRef.current) clearTimeout(removeTimeoutRef.current)
    }
  }, [])

  // Live slider value during a drag — only committed (persisted) on
  // pointer-up/key-up so mid-drag ticks don't each trigger a server PUT.
  const [fontsize, setFontsize] = useState(captionTrack?.fontsize ?? 46)
  useEffect(() => {
    setFontsize(captionTrack?.fontsize ?? 46)
  }, [captionTrack?.fontsize])

  // The selected segment, if any — derived from the unified `selectedIds`
  // the same way VideoEditor derives its own `selectedCaptionId` mirror: a
  // marquee can put more than one caption id in there, but only the preview's
  // single selection box (and this swatch) needs to pick one, so take the
  // first that resolves to a real segment.
  const selectedSeg = useMemo(() => {
    if (!captionTrack) return undefined
    const idSet = new Set(selectedIds)
    return captionTrack.segments.find(s => s.id && idSet.has(s.id))
  }, [captionTrack, selectedIds])

  const filtered = useMemo(() => {
    const indexed = segs.map((seg, index) => ({ seg, index }))
    const q = search.trim().toLowerCase()
    return q ? indexed.filter(({ seg }) => seg.text.toLowerCase().includes(q)) : indexed
  }, [segs, search])

  // ── editFocusId: scroll + focus the target row (Phase 6's canvas
  // double-click wires into this). `lastHandledNonce` guards against
  // re-focusing on every unrelated re-render once a given request has been
  // served — only a NEW nonce (even for the same segment id) re-triggers it. ──
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const lastHandledNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!editFocusId || editFocusId.nonce === lastHandledNonceRef.current) return
    const seg = segs.find(s => s.id === editFocusId.id)
    if (!seg) return
    // A live search filtering the target row out of the DOM would make the
    // row-ref lookup below miss. Clear it and let this effect re-run once the
    // list re-renders with the row present.
    const q = search.trim().toLowerCase()
    if (q && !seg.text.toLowerCase().includes(q)) {
      setSearch('')
      return
    }
    const el = rowRefs.current.get(editFocusId.id)
    if (!el) return
    lastHandledNonceRef.current = editFocusId.nonce
    el.scrollIntoView({ block: 'nearest' })
    el.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
  }, [editFocusId, search, segs])

  function handleRowClick(segId: string | undefined, start: number) {
    if (!segId) return
    onSelectCaption(segId)
    // `CaptionPreview` snaps the clock to the frame grid (`round(t*fps)/fps`)
    // BEFORE testing `t >= start && t < end` against it. Caption starts are
    // arbitrary floats from transcription, not frame-aligned, so seeking to
    // exactly `start` rounds DOWN into the previous segment about half the
    // time once snapped. The half-frame nudge lands inside the segment after
    // rounding, every time.
    //
    // `fps` comes from `project.settings?.fps ?? 30`, which passes an
    // explicit `0` through untouched (falsy, but not nullish) — and
    // `0.5 / 0` is `Infinity`, which parks the playhead at `totalDuration`
    // instead of inside the segment. Guarded here too.
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30
    clock.set(start + 0.5 / safeFps)
  }

  function handleDelete(segId: string | undefined) {
    if (!segId) return
    onCaptionSegmentDelete?.(segId)
  }

  function handleRemoveAllClick() {
    if (!confirmRemove) {
      setConfirmRemove(true)
      if (removeTimeoutRef.current) clearTimeout(removeTimeoutRef.current)
      removeTimeoutRef.current = setTimeout(() => setConfirmRemove(false), 3000)
      return
    }
    if (removeTimeoutRef.current) clearTimeout(removeTimeoutRef.current)
    setConfirmRemove(false)
    // Persistence needs an explicit `null` to clear the field server-side (a
    // live PUT test confirmed `undefined` is dropped from the JSON body).
    onCaptionEdit?.({ ...project, captions: null as unknown as undefined })
  }

  const accent = captionTrack ? ACCENT[captionTrack.style] : undefined

  // onChange = live preview only (cheap, no PUT); onCommit persists once.
  const liveTrack = (patch: Record<string, string>) => {
    if (!project.captions) return
    onProjectChange?.({ ...project, captions: { ...project.captions, ...patch } })
  }
  const commitTrack = (patch: Record<string, string>) => {
    if (!project.captions) return
    onCaptionEdit?.({ ...project, captions: { ...project.captions, ...patch } })
  }
  // Per-segment color: when a real segment is selected, the base swatch
  // targets ITS color instead of the track's. Live preview still flows
  // through `onProjectChange` — a locally patched project, exactly the
  // channel every other control here uses for live preview — but the commit
  // goes through `onCaptionSegmentChange`, the single-segment patch channel,
  // instead of rewriting the whole captions object through `onCaptionEdit`.
  // Each fires from exactly one of SwatchInput's onChange/onCommit, so one
  // gesture produces exactly one commit — never both channels for one value.
  const liveSegColor = (v: string) => {
    if (!project.captions || !selectedSeg) return
    onProjectChange?.({
      ...project,
      captions: {
        ...project.captions,
        segments: project.captions.segments.map(s => s.id === selectedSeg.id ? { ...s, color: v } : s),
      },
    })
  }
  const commitSegColor = (v: string) => {
    if (!selectedSeg?.id) return
    onCaptionSegmentChange?.(selectedSeg.id, { color: v })
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Toolbar header ── */}
      <div className="shrink-0 border-b border-[var(--editor-border)] px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[var(--editor-text)]/60 uppercase tracking-wide">
            Captions
            {segs.length > 0 && (
              <span className="ml-1.5 text-[var(--editor-text)]/40 normal-case tracking-normal">{segs.length}</span>
            )}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {onRegenerateCaptions && (
              <button
                className="text-[10px] text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] border border-[var(--editor-border)] hover:border-[var(--editor-text)]/30 bg-[var(--editor-surface)] rounded px-1.5 py-0.5 transition-colors"
                onClick={onRegenerateCaptions}
              >
                Regenerate
              </button>
            )}
            {captionTrack && segs.length > 0 && (
              <button
                className={`text-[10px] rounded px-1.5 py-0.5 transition-all border ${
                  confirmRemove
                    ? 'bg-red-500/20 border-red-500/60 text-red-400'
                    : 'text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] border-[var(--editor-border)] hover:border-[var(--editor-text)]/30 bg-[var(--editor-surface)]'
                }`}
                onClick={handleRemoveAllClick}
              >
                {confirmRemove ? 'Really remove?' : 'Remove all'}
              </button>
            )}
          </div>
        </div>

        {/* ── Collapsible "Caption style" subsection ── */}
        {captionTrack && (
          <div>
            <button
              type="button"
              onClick={() => setStyleExpanded(!styleExpanded)}
              aria-expanded={styleExpanded}
              aria-label="Caption style controls"
              className="flex items-center gap-1 text-[10px] text-[var(--editor-text)]/50 uppercase tracking-wider hover:text-[var(--editor-text)]/80 transition-colors"
            >
              {styleExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Caption style
            </button>
            {styleExpanded && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex flex-wrap gap-1">
                  {STYLES.map(style => {
                    const active = captionTrack.style === style
                    return (
                      <button
                        key={style}
                        className={`text-[10px] rounded px-2 py-0.5 transition-all border ${
                          active
                            ? 'bg-[var(--editor-accent)]/20 border-[var(--editor-accent)]/60 text-[var(--editor-accent)]'
                            : 'bg-[var(--editor-surface)] border-[var(--editor-border)] text-[var(--editor-text)]/50 hover:text-[var(--editor-text)]/80 hover:border-[var(--editor-text)]/30'
                        }`}
                        onClick={() => {
                          if (!project.captions) return
                          onCaptionEdit?.({ ...project, captions: { ...project.captions, style } })
                        }}
                      >
                        {style}
                      </button>
                    )
                  })}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="range"
                    aria-label="Caption font size"
                    min={28}
                    max={120}
                    step={2}
                    value={fontsize}
                    className="flex-1 accent-[var(--editor-accent)]"
                    onChange={e => {
                      if (!project.captions) return
                      const v = Number(e.target.value)
                      setFontsize(v)
                      // Live preview only — cheap local-state update, no save.
                      onProjectChange?.({ ...project, captions: { ...project.captions, fontsize: v } })
                    }}
                    onPointerUp={e => {
                      if (!project.captions) return
                      const v = Number((e.target as HTMLInputElement).value)
                      onCaptionEdit?.({ ...project, captions: { ...project.captions, fontsize: v } })
                    }}
                    onKeyUp={e => {
                      if (!project.captions) return
                      const v = Number((e.target as HTMLInputElement).value)
                      onCaptionEdit?.({ ...project, captions: { ...project.captions, fontsize: v } })
                    }}
                  />
                  <span className="text-[10px] text-[var(--editor-text)]/50 font-mono w-9 text-right">{fontsize}px</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <SwatchInput
                    size="sm"
                    showValue={false}
                    title={selectedSeg ? 'Selected segment text color' : 'Caption text color'}
                    ariaLabel={selectedSeg ? 'Selected segment text color' : 'Caption text color'}
                    value={toHex(selectedSeg ? (selectedSeg.color ?? captionTrack.color) : captionTrack.color, '#ffffff')}
                    onChange={v => selectedSeg ? liveSegColor(v) : liveTrack({ color: v })}
                    onCommit={v => selectedSeg ? commitSegColor(v) : commitTrack({ color: v })}
                  />
                  {accent && (
                    <SwatchInput
                      size="sm"
                      showValue={false}
                      title={`Caption ${accent.label.toLowerCase()} color`}
                      ariaLabel={`Caption ${accent.label.toLowerCase()} color`}
                      value={toHex(captionTrack[accent.field], accent.def)}
                      onChange={v => liveTrack({ [accent.field]: v })}
                      onCommit={v => commitTrack({ [accent.field]: v })}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Search ── */}
        {segs.length > 0 && (
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--editor-text)]/40 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search captions…"
              aria-label="Search captions"
              className="w-full h-7 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] pl-6 pr-2 text-xs text-[var(--editor-text)] placeholder-[var(--editor-text)]/40 focus:outline-none focus:border-[var(--editor-accent)]"
            />
          </div>
        )}
      </div>

      {/* ── Scrollable numbered list ── */}
      <div role="list" aria-label="Caption segments" className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-1">
        {segs.length === 0 ? (
          <p className="text-xs text-[var(--editor-text)]/50 italic text-center mt-4 px-2 leading-relaxed">
            No captions yet. Captions are generated during transcription.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-[var(--editor-text)]/50 italic text-center mt-4 px-2">No matching captions.</p>
        ) : (
          filtered.map(({ seg, index }) => {
            const isActive = currentTime >= seg.start && currentTime < seg.end
            const isSelected = !!seg.id && selectedIds.includes(seg.id)
            return (
              <div
                key={seg.id ?? index}
                role="listitem"
                // `aria-current`, not `aria-selected`: each row contains a
                // contenteditable and a delete button, and ARIA forbids
                // interactive descendants inside `option`/`listbox` — a
                // screen reader could not reliably reach either control. A
                // plain `list`/`listitem` has no such restriction.
                aria-current={isSelected ? 'true' : undefined}
                ref={el => {
                  if (!seg.id) return
                  if (el) rowRefs.current.set(seg.id, el)
                  else rowRefs.current.delete(seg.id)
                }}
                onClick={() => handleRowClick(seg.id, seg.start)}
                className={`group flex items-start gap-2 rounded px-2 py-1.5 cursor-pointer transition-colors border ${
                  isSelected
                    ? 'bg-[var(--editor-accent)]/15 border-[var(--editor-accent)]/60'
                    : isActive
                    ? 'bg-[var(--editor-surface)] border-[var(--editor-border)]'
                    : 'border-transparent hover:bg-[var(--editor-surface)]'
                }`}
              >
                {/* Index + timestamp, stacked — the two labels are complementary
                    (R3: nothing from the retired TranscriptPanel/TranscriptModal
                    dropped). The index gives ordinal position; the timestamp
                    gives where in the video the line actually lands, which is
                    what you navigate by. Both small/mono/muted so neither
                    competes with the caption text beside them. */}
                <div className="shrink-0 flex flex-col items-end gap-0.5 pt-0.5 w-10">
                  <span className="text-[10px] font-mono text-[var(--editor-text)]/40">{index + 1}</span>
                  <span className="text-[9px] font-mono text-[var(--editor-text)]/35">{formatTime(seg.start)}</span>
                </div>
                <span className="flex-1 min-w-0 text-xs text-[var(--editor-text)] leading-snug">
                  <EditableSegment
                    seg={seg}
                    onEdit={text => { if (seg.id) onCaptionSegmentChange?.(seg.id, { text }) }}
                  />
                </span>
                <button
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--editor-text)]/40 hover:text-red-400 transition-opacity"
                  onClick={e => { e.stopPropagation(); handleDelete(seg.id) }}
                  title="Delete caption"
                  aria-label="Delete caption"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
