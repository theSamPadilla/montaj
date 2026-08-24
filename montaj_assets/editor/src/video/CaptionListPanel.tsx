// Sidebar caption editor (SP5-captions Phase 5). Replaces the bottom
// TranscriptPanel + its "Expand" TranscriptModal: instead of a two-line
// vicinity strip at the bottom of the timeline pane, every caption segment
// lives in a searchable, numbered list in the right rail, with the track-level
// style/size/color controls tucked behind a collapsible subsection so the list
// stays the prominent thing in a ~300px-wide column.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, ChevronDown, ChevronRight, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { Project } from '../types'
import type { Captions } from '../schema'
import type { PlaybackClock } from './playback-clock'
import type { CaptionEditPatch } from './timeline/makeCaptionEdit'
import { EditableSegment } from './timeline/EditableSegment'
import { formatTime } from './timeline/utils'
import { SwatchInput } from '../ui'
import { reviveBoolean, usePersistentState } from '../ui/usePersistentState'
import { groupCaptionLanes, laneOf } from './captionLanes'
import { FontFamilyPicker, findFontOption } from '../text/FontPicker'
import CaptionSpecimen from './CaptionSpecimen'
import { CAPTION_STYLE_LETTER_SPACING, CAPTION_STYLE_LINE_HEIGHT, CAPTION_STYLE_TEXT_TRANSFORM } from './captionStyleDefaults'

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

// ── Text styling: case + alignment button groups ──
// Glyph labels only (the rail is ~300px), so each carries an aria-label — "TT"
// is not a word a screen reader can announce usefully.
const CASES = [
  { value: 'uppercase', glyph: 'TT', label: 'Uppercase' },
  { value: 'lowercase', glyph: 'tt', label: 'Lowercase' },
  { value: 'capitalize', glyph: 'Tt', label: 'Capitalize' },
] as const

const ALIGNMENTS = [
  { value: 'left', Icon: AlignLeft, label: 'Align left' },
  { value: 'center', Icon: AlignCenter, label: 'Align center' },
  { value: 'right', Icon: AlignRight, label: 'Align right' },
] as const

/** The panel's one chip look, matching the STYLES preset row. The inactive
 *  foreground is `text-[var(--editor-text)] opacity-60` rather than
 *  `text-[var(--editor-text)]/60` — Tailwind cannot generate an opacity
 *  modifier on an arbitrary var() color, so that class is a silent no-op (see
 *  the longer note on the row index span at the bottom of this file). The
 *  preset row's own inactive class predates that finding and is left alone. */
const chipClass = (active: boolean): string =>
  `text-[10px] rounded px-2 py-0.5 transition-all border ${
    active
      ? 'bg-[var(--editor-accent)]/20 border-[var(--editor-accent)]/60 text-[var(--editor-accent)]'
      : 'bg-[var(--editor-surface)] border-[var(--editor-border)] text-[var(--editor-text)] opacity-60 hover:opacity-100'
  }`

/** Display value for the letter-spacing stepper: the numeric part of a stored
 *  CSS length, read as em. Tolerates absent, '0.02em', '-0.02em', '.02em',
 *  ' 0.02 em ' and a bare number. A value stored in some OTHER unit ('2px')
 *  deliberately reads as EMPTY rather than as "2" — showing it would silently
 *  re-interpret it as 2em the moment the operator nudges the stepper. */
function parseEmValue(value: string | undefined): string {
  if (!value) return ''
  const m = /^\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:em)?\s*$/i.exec(value)
  return m ? m[1] : ''
}

/** Display value for the line-height stepper. `Captions.lineHeight` is
 *  `number | string`; a string is accepted only when it is unitless, which is
 *  the form CSS reads as a multiple of the font size and the only form this
 *  stepper writes. Anything else ('120%', '1.3em') reads as empty, same
 *  reasoning as above. */
function parseUnitlessValue(value: number | string | undefined): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (!value) return ''
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*$/.exec(value)
  return m ? m[1] : ''
}

/** Strip float-step noise (0.1 + 0.01 = 0.11000000000000001) before the value
 *  is written into the project — and, for letter spacing, before it is
 *  stringified into a CSS length that ends up in the saved JSON. */
const roundTo = (n: number, places: number): number => Number(n.toFixed(places))

interface StepperFieldProps {
  label: string
  ariaLabel: string
  /** Display value, already parsed out of whatever the project stored. */
  value: string
  min: number
  max: number
  step: number
  /** Rendered beside the field, e.g. 'em'. The operator never types the unit —
   *  the same contract as FontSizePicker (text/FontPicker.tsx), which appends
   *  `px` itself. */
  unit?: string
  /** Shown when the field is empty (the project has no explicit value) —
   *  the active style's OWN default for this field, so the input reports the
   *  effective value that will actually render instead of looking blank.
   *  Never written into the project; a style with no default for this field
   *  passes `''`, which is a no-op placeholder. */
  placeholder?: string
  onLive: (n: number) => void
  onCommit: (n: number) => void
}

/** Numeric stepper for the caption text-styling block, on the same live/commit
 *  split as the fontsize slider above it: every intermediate value (a
 *  keystroke, a spinner arrow, a held spinner) previews through `onLive` only,
 *  and the settled value persists ONCE through `onCommit`, on blur or Enter.
 *
 *  `dirtyRef` is what makes "once" true, and why this doesn't just compare the
 *  field against the incoming `value` prop: live preview has ALREADY written
 *  the pending number into the project, so by the time blur fires the prop
 *  equals the pending value and a value-comparison guard would skip the commit
 *  entirely, silently losing the edit. "Did the operator change anything" is
 *  the only signal that survives live preview. It also means a bare focus/blur
 *  commits nothing, and Enter-then-blur commits once rather than twice. */
function StepperField({ label, ariaLabel, value, min, max, step, unit, placeholder, onLive, onCommit }: StepperFieldProps) {
  const [text, setText] = useState(value)
  const focusedRef = useRef(false)
  const dirtyRef = useRef(false)

  // Don't stomp what the operator is part-way through typing; re-sync from the
  // project only while the field is unfocused (same guard as FontSizePicker).
  useEffect(() => {
    if (!focusedRef.current) setText(value)
  }, [value])

  /** The clamped number this field currently holds, or `null` while it holds
   *  nothing usable (empty mid-edit, a lone '-'). min/max on the element are a
   *  spinner hint only — a typed value can exceed them — so the clamp lives
   *  here, on the path everything is written through. */
  const numeric = (raw: string): number | null => {
    if (raw.trim() === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
  }

  function commit() {
    if (!dirtyRef.current) return
    const n = numeric(text)
    if (n === null) return
    dirtyRef.current = false
    onCommit(n)
  }

  return (
    <label className="flex items-center gap-1 min-w-0">
      <span className="text-[10px] text-[var(--editor-text)] opacity-60 shrink-0">{label}</span>
      <input
        type="number"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={text}
        onChange={e => {
          const raw = e.target.value
          setText(raw)
          const n = numeric(raw)
          if (n === null) return
          dirtyRef.current = true
          onLive(n)
        }}
        onFocus={() => { focusedRef.current = true }}
        onBlur={() => {
          focusedRef.current = false
          commit()
          // Left empty or unparseable: nothing was committed, so snap the
          // display back to what the project actually holds rather than
          // leaving a blank field that misreports the caption's real value.
          if (numeric(text) === null) setText(value)
        }}
        onKeyUp={e => { if (e.key === 'Enter') commit() }}
        className="w-12 h-6 rounded border border-[var(--editor-border)] bg-[var(--editor-surface)] px-1 text-[10px] font-mono text-[var(--editor-text)] focus:outline-none focus:border-[var(--editor-accent)]"
      />
      {unit && <span className="text-[10px] text-[var(--editor-text)] opacity-40 shrink-0">{unit}</span>}
    </label>
  )
}

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
  /** Whether a generate/regenerate job is currently streaming (the
   *  `CaptionRegenModal` is open and running). Disables the trigger so it
   *  can't be fired twice from this panel; the modal itself owns the
   *  progress UI, so this panel does nothing more than go inert. Optional
   *  and defaults to falsy — a host that never passes it (or that stops
   *  passing `true` once a job ends, including a failed one) leaves the
   *  trigger enabled exactly as it is today. */
  captionsGenerating?: boolean
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
  captionsGenerating,
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
      captionsGenerating={captionsGenerating}
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
  captionsGenerating,
  fps,
  clock,
  editFocusId,
}: CaptionListPanelProps) {
  const segs = captionTrack?.segments ?? []
  const [search, setSearch] = useState('')
  // `null` = the "All" chip (no row filter). Set to a lane index by clicking
  // a "Row N" chip. Lives beside `search` rather than folded into it — they
  // compose (both apply) instead of one being a mode that disables the other.
  const [rowFilter, setRowFilter] = useState<number | null>(null)
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

  // One group per lane (0..maxLane, holes included) via the same module the
  // canvas timeline reads lanes through — see captionLanes.ts. `multiLane`
  // gates ONLY the header/chip UI below; the grouping, search and index math
  // run unconditionally so a single-lane project (every project has exactly
  // one lane until Phase 3/4's drag gesture is used) takes the exact same
  // code path as a multi-lane one, rather than a separate `length === 1`
  // branch — with one group, its segments ARE `segs` in original order, so
  // the per-group index below already equals the pre-Phase-5 global index.
  const captionGroups = useMemo(() => (segs.length > 0 ? groupCaptionLanes(segs) : []), [segs])
  const multiLane = captionGroups.length > 1

  // Chip filter and search compose: a group is dropped by the chip (lane
  // mismatch) before its rows are tested against the search query, and a row
  // survives only if it passes both. Per-group index restarts at 0 within
  // each group (group.segments is that lane's slice, in original order), so
  // in the single-lane case it's identical to the old global `segs` index.
  // A group with zero surviving rows is dropped entirely rather than kept
  // with an empty body — this way search never leaves a dangling "Row N"
  // header with nothing under it, and neither does a would-be hole lane.
  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    return captionGroups
      .filter(g => rowFilter === null || g.lane === rowFilter)
      .map(g => ({
        lane: g.lane,
        rows: g.segments
          .map((seg, index) => ({ seg, index }))
          .filter(({ seg }) => !q || seg.text.toLowerCase().includes(q)),
      }))
      .filter(g => g.rows.length > 0)
  }, [captionGroups, rowFilter, search])
  const totalVisible = useMemo(() => visibleGroups.reduce((sum, g) => sum + g.rows.length, 0), [visibleGroups])

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
    // Same guard, extended to the row chip: a canvas double-click can target
    // a caption in a lane the active "Row N" chip has filtered out (e.g. a
    // double-click on a row-2 caption while "Row 1" is selected), which would
    // otherwise leave the row-ref lookup below silently missing forever. Each
    // `setState` here only clears ONE filter and returns; if both are
    // blocking the target, this effect just re-runs (via the `search` /
    // `rowFilter` deps below) and clears the other on the next pass.
    if (rowFilter !== null && laneOf(seg) !== rowFilter) {
      setRowFilter(null)
      return
    }
    const el = rowRefs.current.get(editFocusId.id)
    if (!el) return
    lastHandledNonceRef.current = editFocusId.nonce
    el.scrollIntoView({ block: 'nearest' })
    el.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
  }, [editFocusId, search, rowFilter, segs])

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

  // Bold reads "on" whenever `fontWeight` is ABSENT — each of the seven JSX
  // caption templates then renders at its OWN designed weight (outline's 900
  // stencil stamp, subtitle's lighter 600), which is what every existing
  // project renders today, so bold has to read as "on" by default. It also
  // reads "on" for anything already stored at 600+ (a project that happens to
  // carry an explicit weight there). Off is the single explicit value 400.
  //
  // `fontWeight` is `number | string` (schema.ts) and CSS accepts the string
  // keywords 'bold'/'bolder' as legal values — `Number('bold')` is `NaN`,
  // which fails the `>= 600` check, so a project carrying the keyword read as
  // OFF even though it renders bold. Checked as its own case rather than
  // folded into the numeric one.
  const isBoldKeyword = typeof captionTrack?.fontWeight === 'string'
    && ['bold', 'bolder'].includes(captionTrack.fontWeight.trim().toLowerCase())
  const boldOn = captionTrack
    ? (captionTrack.fontWeight == null || isBoldKeyword || Number(captionTrack.fontWeight) >= 600)
    : false

  // onChange = live preview only (cheap, no PUT); onCommit persists once.
  // `Partial<Captions>`, not `Record<string, string>`: the text-styling
  // controls below write a `string[]` (googleFonts) and a number
  // (lineHeight), and stringifying those to fit a narrower patch type would
  // put values in the project that the caption templates can't read.
  const liveTrack = (patch: Partial<Captions>) => {
    if (!project.captions) return
    onProjectChange?.({ ...project, captions: { ...project.captions, ...patch } })
  }
  const commitTrack = (patch: Partial<Captions>) => {
    if (!project.captions) return
    onCaptionEdit?.({ ...project, captions: { ...project.captions, ...patch } })
  }
  // Deletes a key from the persisted captions object entirely, rather than
  // overwriting it. `commitTrack` above can only ADD/OVERWRITE keys via its
  // patch spread — writing `{ [key]: undefined }` through it would leave the
  // key present (with an `undefined` value) in the live-preview project, but
  // JSON.stringify DROPS `undefined` keys on the way to the server, so the
  // preview and the persisted project would end up disagreeing about whether
  // the field is set at all. Building the object explicitly and destructuring
  // the key out of it is the only way both paths agree. Used by the Bold
  // toggle: switching bold back ON has to DELETE `fontWeight`, not write 700
  // (see the toggle's own comment for why a flat 700 is wrong).
  const commitTrackOmitting = (key: keyof Captions) => {
    if (!project.captions) return
    const { [key]: _dropped, ...rest } = project.captions
    onCaptionEdit?.({ ...project, captions: rest as Captions })
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

                {/* ── Text styling ──
                    Every control here writes a track-level `Captions` field
                    that all seven JSX caption templates already read as a
                    prop, so one write reaches the editor preview and the
                    export together — no separate render-side plumbing. */}
                <div className="flex flex-col gap-1.5 border-t border-[var(--editor-border)] pt-2">
                  <CaptionSpecimen
                    captions={captionTrack}
                    currentTime={currentTime}
                    selectedSegmentId={selectedSeg?.id}
                    fontFamily={captionTrack.fontFamily}
                    // The LIVE slider value, not `captionTrack.fontsize`, so
                    // the specimen scales continuously during a fontsize drag
                    // instead of jumping only when the drag is committed.
                    fontSize={fontsize}
                    textTransform={captionTrack.textTransform}
                    letterSpacing={captionTrack.letterSpacing}
                    fontWeight={captionTrack.fontWeight}
                  />

                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[var(--editor-text)] opacity-60 shrink-0">Font</span>
                    <FontFamilyPicker
                      value={captionTrack.fontFamily ?? ''}
                      onChange={value => {
                        // `fontFamily` and `googleFonts` MUST be written in ONE
                        // patch. A family whose font file is never fetched
                        // renders as the fallback face — in the preview AND in
                        // the export — which is the exact failure this control
                        // exists to prevent; and two patches would also stack
                        // two undo entries and could interleave with another
                        // edit between them. The System option carries no
                        // `spec`, and `[]` is the right write for it:
                        // explicitly empty, so a previously picked family's
                        // spec cannot linger and keep being fetched.
                        //
                        // The spec is resolved here rather than handed over by
                        // `FontFamilyPicker` (whose onChange gives only the CSS
                        // value) so its signature — and its other caller,
                        // text/TextFormattingToolbar.tsx — stays untouched.
                        // `findFontOption` is an exact round-trip on an
                        // option's own `value`, so this always finds the option
                        // the operator just clicked.
                        const opt = findFontOption(value)
                        commitTrack({ fontFamily: value, googleFonts: opt?.spec ? [opt.spec] : [] })
                      }}
                      className="flex-1 min-w-0"
                      buttonClassName="flex h-7 w-full items-center gap-1 rounded border border-[var(--editor-border)] bg-[var(--editor-surface)] px-1.5 text-[11px] text-[var(--editor-text)] hover:border-[var(--editor-accent)] focus:outline-none focus:border-[var(--editor-accent)]"
                    />
                    <button
                      type="button"
                      aria-pressed={boldOn}
                      aria-label="Bold"
                      // Surprising on first read, so said explicitly: ON means
                      // the key is ABSENT, not "set to some bold number". Each
                      // of the seven caption templates has its own designed
                      // weight (outline's 900 stencil, subtitle's 600, …), and
                      // that only comes through when `fontWeight` isn't in the
                      // project at all. Writing 700 here would flatten every
                      // style onto the same weight and quietly break each
                      // style's look — so turning bold back ON has to DELETE
                      // the key (via `commitTrackOmitting`), never re-write it.
                      onClick={() => boldOn ? commitTrack({ fontWeight: 400 }) : commitTrackOmitting('fontWeight')}
                      className={`${chipClass(boldOn)} font-bold shrink-0`}
                    >
                      B
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-1.5">
                    <div role="group" aria-label="Caption text case" className="flex items-center gap-1">
                      {/* Absent `textTransform` seeds from the active style's
                          own default (same reasoning as `boldOn` above) — a
                          fresh `outline` caption renders uppercase before any
                          case chip is ever clicked, so the chip has to read
                          pressed for that to be true rather than lying about
                          the caption's real on-screen case. An EXPLICIT
                          'none' (written when the operator turns a case back
                          off) is not "absent" and never falls back. */}
                      {CASES.map(({ value, glyph, label }) => {
                        const effectiveTransform = captionTrack.textTransform ?? CAPTION_STYLE_TEXT_TRANSFORM[captionTrack.style]
                        const active = effectiveTransform === value
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-label={label}
                            aria-pressed={active}
                            // Re-clicking the active case clears it. Writes
                            // 'none' rather than dropping the key: an absent
                            // field can't overwrite the value already saved on
                            // the project, so "off" has to be said out loud.
                            onClick={() => commitTrack({ textTransform: active ? 'none' : value })}
                            className={`${chipClass(active)} font-mono`}
                          >
                            {glyph}
                          </button>
                        )
                      })}
                    </div>
                    <div role="group" aria-label="Caption text alignment" className="flex items-center gap-1">
                      {ALIGNMENTS.map(({ value, Icon, label }) => {
                        const active = captionTrack.textAlign === value
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-label={label}
                            aria-pressed={active}
                            onClick={() => commitTrack({ textAlign: value })}
                            className={`${chipClass(active)} flex items-center justify-center px-1.5`}
                          >
                            <Icon size={11} />
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <StepperField
                      label="Spacing"
                      ariaLabel="Caption letter spacing"
                      value={parseEmValue(captionTrack.letterSpacing)}
                      placeholder={parseEmValue(CAPTION_STYLE_LETTER_SPACING[captionTrack.style])}
                      min={-0.1}
                      max={0.5}
                      step={0.01}
                      unit="em"
                      onLive={n => liveTrack({ letterSpacing: `${roundTo(n, 3)}em` })}
                      onCommit={n => commitTrack({ letterSpacing: `${roundTo(n, 3)}em` })}
                    />
                    <StepperField
                      label="Line"
                      ariaLabel="Caption line height"
                      value={parseUnitlessValue(captionTrack.lineHeight)}
                      placeholder={parseUnitlessValue(CAPTION_STYLE_LINE_HEIGHT[captionTrack.style])}
                      min={0.8}
                      max={2.5}
                      step={0.05}
                      onLive={n => liveTrack({ lineHeight: roundTo(n, 2) })}
                      onCommit={n => commitTrack({ lineHeight: roundTo(n, 2) })}
                    />
                  </div>
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

        {/* ── Row filter chips (only when there's more than one lane to filter
            between — a single-lane project never mounts this, keeping its
            toolbar byte-for-byte what it was before lanes existed). Composes
            with search rather than replacing it: both narrow the same
            `visibleGroups` computation above. Same button look as the
            "Caption style" preset row above, for one visual chip language
            in this panel. ── */}
        {multiLane && (
          <div role="group" aria-label="Filter captions by row" className="flex flex-wrap gap-1">
            <button
              type="button"
              aria-pressed={rowFilter === null}
              onClick={() => setRowFilter(null)}
              className={`text-[10px] rounded px-2 py-0.5 transition-all border ${
                rowFilter === null
                  ? 'bg-[var(--editor-accent)]/20 border-[var(--editor-accent)]/60 text-[var(--editor-accent)]'
                  : 'bg-[var(--editor-surface)] border-[var(--editor-border)] text-[var(--editor-text)]/50 hover:text-[var(--editor-text)]/80 hover:border-[var(--editor-text)]/30'
              }`}
            >
              All
            </button>
            {captionGroups.map(g => (
              <button
                key={g.lane}
                type="button"
                aria-pressed={rowFilter === g.lane}
                onClick={() => setRowFilter(g.lane)}
                className={`text-[10px] rounded px-2 py-0.5 transition-all border ${
                  rowFilter === g.lane
                    ? 'bg-[var(--editor-accent)]/20 border-[var(--editor-accent)]/60 text-[var(--editor-accent)]'
                    : 'bg-[var(--editor-surface)] border-[var(--editor-border)] text-[var(--editor-text)]/50 hover:text-[var(--editor-text)]/80 hover:border-[var(--editor-text)]/30'
                }`}
              >
                {`Row ${g.lane + 1}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Scrollable numbered list ── */}
      <div role="list" aria-label="Caption segments" className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-1">
        {segs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 text-center mt-4 px-2">
            <p className="text-xs text-[var(--editor-text)]/50 leading-relaxed">
              {onRegenerateCaptions
                ? "Captions are generated from the timeline's audio."
                : 'No captions yet. Captions are generated during transcription.'}
            </p>
            {/* Primary action — the only thing to do on an otherwise empty
                panel, so it gets the accent treatment rather than the small
                ghost buttons in the header above. Absent entirely when the
                host has no `generateCaptions` (Hub/LP): a button with no
                working handler is worse than no button. */}
            {onRegenerateCaptions && (
              <button
                type="button"
                onClick={onRegenerateCaptions}
                disabled={captionsGenerating}
                className="text-xs font-medium rounded-md px-3 py-1.5 bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50"
              >
                Generate captions
              </button>
            )}
          </div>
        ) : totalVisible === 0 ? (
          <p className="text-xs text-[var(--editor-text)]/50 italic text-center mt-4 px-2">No matching captions.</p>
        ) : (
          visibleGroups.map(group => (
            // A single-lane project has exactly one entry here, so this
            // Fragment (which renders no DOM node of its own) is the only
            // thing standing between this map and a bare `rows.map(...)` —
            // the header below stays unmounted (`multiLane` false), leaving
            // the row markup underneath byte-for-byte what it was pre-Phase-5.
            <Fragment key={group.lane}>
              {multiLane && (
                // No "move to row" control here (v1, deliberate): row
                // membership is a timeline DRAG gesture (Phase 3/4's
                // resolveDropLane), and a sidebar dropdown doing the same
                // move by a different mechanism invites the two to disagree
                // about what a drag means. Follow-up, not YAGNI-scope here.
                <div className="sticky top-0 z-10 -mx-2 px-2 py-1 bg-[var(--editor-surface)] border-b border-[var(--editor-border)] text-[10px] font-medium text-[var(--editor-text)]/50 uppercase tracking-wide">
                  {`Row ${group.lane + 1}`}
                </div>
              )}
              {group.rows.map(({ seg, index }) => {
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
                      {/* NOT `text-[var(--editor-text)]/N` — Tailwind cannot generate a
                          rule for an opacity modifier on an arbitrary var() color, so
                          that class is a silent no-op and these spans inherit the row's
                          own (near-identical) foreground color instead. `opacity-N` is a
                          real utility and, on a plain text span with no background,
                          renders identically to the alpha-blended color that was
                          intended. See CaptionListPanel.test.tsx for the regression
                          guard. */}
                      <span className="text-[10px] font-mono text-[var(--editor-text)] opacity-60">{index + 1}</span>
                      <span className="text-[9px] font-mono text-[var(--editor-text)] opacity-50">{formatTime(seg.start)}</span>
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
              })}
            </Fragment>
          ))
        )}
      </div>

      {/* ── Actions footer ──
          The generate/remove triggers live at the BOTTOM of the panel, out of
          the way of the list, and only when there is something to act on. The
          "there's nothing yet" state keeps its own primary button in the empty
          body above, so the panel never shows two competing triggers. */}
      {segs.length > 0 && (
        <div className="shrink-0 border-t border-[var(--editor-border)] px-3 py-2.5 flex items-center gap-2">
          {onRegenerateCaptions && (
            <button
              type="button"
              onClick={onRegenerateCaptions}
              disabled={captionsGenerating}
              className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] text-xs font-medium text-[var(--editor-text)] transition-colors hover:border-[var(--editor-accent)] hover:text-[var(--editor-accent)] disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
            >
              <RefreshCw size={13} className={captionsGenerating ? 'animate-spin' : undefined} />
              Regenerate captions
            </button>
          )}
          {captionTrack && (
            <button
              type="button"
              onClick={handleRemoveAllClick}
              className={`flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border text-xs font-medium transition-colors ${
                confirmRemove
                  ? 'bg-red-500/15 border-red-500/60 text-red-400'
                  : 'border-[var(--editor-border)] bg-[var(--editor-surface)] text-[var(--editor-text)]/70 hover:border-red-500/50 hover:text-red-400'
              }`}
            >
              <Trash2 size={13} />
              {confirmRemove ? 'Really remove?' : 'Remove all'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
