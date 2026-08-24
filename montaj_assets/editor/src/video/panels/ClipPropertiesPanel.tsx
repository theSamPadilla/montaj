import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AudioTrack, EditorProject, VisualItem } from '../../schema'
import { setClipSpeed } from '../cuts'
import SpeedControl from '../timeline/SpeedControl'
import VolumeControl from '../timeline/VolumeControl'
import { cn, inspectorInputClass, Switch } from '../../ui'

/**
 * `<ClipPropertiesPanel>` — the editor's contextual right-hand properties
 * panel for a selected VIDEO CLIP or AUDIO TRACK. The sibling of
 * `OverlayInspector` (which covers a selected overlay's Transform
 * properties): the two mount in the same column and share its visual
 * language — a collapsible section, `var(--editor-*)` custom properties,
 * `inspectorInputClass` inputs — so the column reads as one system no matter
 * which one is showing.
 *
 * These fields used to live only in the host-side `ClipInspectModal`
 * (`montaj_assets/ui`), opened by double-click. This panel reimplements the
 * editor-managed subset of that modal's fields (NOT the AI-generation /
 * regenerate surface, which stays host-owned and is injected via
 * `generationSlot`; NOT delete, which stays modal-only — see the doc comment
 * on `AudioSection` for why).
 *
 * Props-driven and host-agnostic, like the rest of this package: it never
 * reaches into a store. All persistence flows back through the six
 * preview/commit/change callbacks, which the host wires to its own sync core.
 */
export type ClipSelection = { kind: 'clip'; item: VisualItem } | { kind: 'audio'; track: AudioTrack } | null

export interface ClipPropertiesPanelProps {
  selection: ClipSelection
  /** Live-preview a continuously-changing clip edit (slider drag): no undo
   *  entry, no save yet. Mirrors OverlayInspector's onPreview. */
  onPreviewClip: (item: VisualItem) => void
  /** Commit the last previewed clip edit as one undo step + queued save. */
  onCommitClip: () => void
  /** A discrete, already-final clip edit (a toggle, a preset chip). */
  onChangeClip: (item: VisualItem) => void
  /** Same three, for a selected audio track. */
  onPreviewAudio: (track: AudioTrack) => void
  onCommitAudio: () => void
  onChangeAudio: (track: AudioTrack) => void
  /** Host-injected section rendered BELOW the editor-managed properties when
   *  a video clip is selected. Montaj puts its AI generation / regenerate
   *  surface here: that reads and writes `project.regenQueue`, a host-only
   *  field this package deliberately knows nothing about (see schema.ts's
   *  EditorProject index-signature comment). Absent -> nothing renders. */
  generationSlot?: ReactNode
}

const SECTION_CLASS = 'shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden'
const ROW_LABEL_CLASS = 'w-16 shrink-0 text-[11px] text-[var(--editor-text)]/55'

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** One collapsible section frame, shared by the Clip and Audio track
 *  sections and by Audio's Fades/Ducking sub-groups (via `nested`). Mirrors
 *  OverlayInspector's Transform section header exactly (chevron + uppercase
 *  label), scaled down for a nested sub-group. */
function CollapsibleSection({
  label,
  collapsed,
  onToggle,
  nested,
  badge,
  children,
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  nested?: boolean
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={nested ? 'rounded-md border border-[var(--editor-border)] overflow-hidden' : SECTION_CLASS}>
      <div
        className={
          nested
            ? 'shrink-0 flex items-center gap-1 px-2 py-1.5'
            : 'shrink-0 flex items-center gap-1 border-b border-[var(--editor-border)] px-2 py-1.5'
        }
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[var(--editor-text)]/60 transition-colors hover:text-[var(--editor-text)]"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className={nested ? 'text-[11px] font-medium' : 'text-xs font-medium uppercase tracking-wide'}>{label}</span>
        </button>
        {badge && <div className="ml-auto">{badge}</div>}
      </div>
      {!collapsed && <div className={nested ? 'flex flex-col gap-2 border-t border-[var(--editor-border)] p-2' : 'flex flex-col gap-3 p-2'}>{children}</div>}
    </div>
  )
}

/** A label + control row, matching OverlayInspector's `ROW_LABEL_CLASS` rows. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className={ROW_LABEL_CLASS}>{label}</span>
      {children}
    </div>
  )
}

interface DraftFieldProps {
  ariaLabel: string
  type: 'text' | 'number'
  value: string
  min?: number
  step?: number
  disabled?: boolean
  /** Raw text as the operator types it. Validate/parse here, not in this
   *  component — different fields want different rules (e.g. an empty
   *  string or a lone "-" mid-number is not yet a value to preview). */
  onInput: (raw: string) => void
  /** Fired on blur, or on Enter (via the same blur path). Carries the exact
   *  string on screen at that moment, so a caller that needs to resolve a
   *  final value (e.g. an empty label falling back to the source basename)
   *  can do so without keeping its own shadow copy of what was typed. */
  onCommit: (raw: string) => void
  className?: string
}

/**
 * One text/number box, split out so it can hold its OWN `useState` — every
 * field in this panel needs independent "am I mid-edit" state, exactly like
 * `OverlayInspectorField` in the sibling panel.
 *
 * `draft` is the fix for a real, previously-shipped bug: this whole panel can
 * re-render from outside (a playback tick, an unrelated field's edit) while
 * the operator is mid-keystroke. A controlled input bound straight to the
 * incoming prop gets its keystrokes clobbered by that re-render. `draft` goes
 * non-null the moment the operator types and stays the single source of truth
 * for what's ON SCREEN until blur/Enter commits it, so an outside re-render
 * arriving mid-edit can't overwrite what's displayed. While `draft` is null
 * (not currently being typed into) the field tracks `value` live, exactly as
 * it always did.
 */
function DraftField({ ariaLabel, type, value, min, step, disabled, onInput, onCommit, className }: DraftFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value

  function commit() {
    const raw = shown
    setDraft(null)
    onCommit(raw)
  }

  return (
    <input
      type={type}
      aria-label={ariaLabel}
      min={type === 'number' ? min : undefined}
      step={type === 'number' ? step : undefined}
      disabled={disabled}
      value={shown}
      onChange={e => { setDraft(e.target.value); onInput(e.target.value) }}
      onBlur={commit}
      // Enter closes the typing gesture the same way blur does — it does not
      // duplicate the commit logic, just triggers the same onBlur path.
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className={cn(inspectorInputClass, disabled && 'opacity-50 cursor-not-allowed', className)}
    />
  )
}

/** Parses a number-field's raw text, rejecting mid-typing states (empty
 *  field, lone minus) rather than writing `NaN` or `0` over whatever the
 *  operator hasn't finished typing yet. Mirrors OverlayInspector's
 *  `handleInput`. `floor` clamps below (e.g. seconds fields can't go
 *  negative); omit it for a field with no lower bound. */
function parseNumberInput(raw: string, floor: number | undefined, apply: (value: number) => void) {
  if (raw === '' || raw === '-') return
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  apply(floor !== undefined ? Math.max(floor, value) : value)
}

/**
 * `setClipSpeed` (cuts.ts) operates on a whole Project — it looks the clip up
 * by id and rewrites its track — because a speed change also re-fits the
 * clip's timeline `end` to keep the same source window at the new rate. This
 * panel only ever sees the single `VisualItem` it's editing, with no project
 * in scope. Wrapping the item in a throwaway single-item, single-track
 * project reuses `setClipSpeed`'s exact duration math with no project on
 * hand, rather than re-deriving it here — the same "minimal project, only
 * the fields the function touches" shape `cuts.test.ts`'s own `makeProject`
 * fixture uses for the same function.
 */
function withResolvedSpeed(item: VisualItem, speed: number): VisualItem {
  const scratch: EditorProject = {
    id: 'clip-properties-panel-scratch',
    status: 'draft',
    settings: { resolution: [0, 0] },
    tracks: [{ id: 'scratch', items: [item] }],
  }
  const next = setClipSpeed(scratch, item.id, speed)
  return next.tracks?.[0]?.items[0] ?? item
}

interface ClipSectionProps {
  item: VisualItem
  onPreviewClip: (item: VisualItem) => void
  onCommitClip: () => void
  onChangeClip: (item: VisualItem) => void
}

function ClipSection({ item, onPreviewClip, onCommitClip, onChangeClip }: ClipSectionProps) {
  const [collapsed, setCollapsed] = useState(false)

  const volume = item.volume ?? 1
  const muted = item.muted ?? false
  const speed = item.speed ?? 1

  return (
    <CollapsibleSection label="Clip" collapsed={collapsed} onToggle={() => setCollapsed(c => !c)}>
      <VolumeControl
        value={volume}
        onChange={v => onPreviewClip({ ...item, volume: v })}
        onCommit={() => onCommitClip()}
        label="Volume"
        idBase="clip-properties-volume"
      />
      <Row label="Mute">
        <Switch checked={muted} onCheckedChange={next => onChangeClip({ ...item, muted: next })} aria-label="Mute clip" />
      </Row>
      {/* Speed is video-only, matching the modal this replaces. `setClipSpeed`
          returns the project UNCHANGED for a non-video item (cuts.ts's
          `item.type !== 'video'` early return), so rendering the control for an
          image would give the operator a slider that silently does nothing. */}
      {item.type === 'video' && (
        <SpeedControl
          value={speed}
          // The drag/type gesture only ever shows the SPEED number moving —
          // mirroring ClipInspectModal's slider, which doesn't resize the clip
          // until its Save button is pressed. Duration is re-fit exactly once,
          // in onCommit below, via the real function.
          onChange={v => onPreviewClip({ ...item, speed: v })}
          onCommit={v => {
            onPreviewClip(withResolvedSpeed(item, v))
            onCommitClip()
          }}
          label="Speed"
          idBase="clip-properties-speed"
        />
      )}
    </CollapsibleSection>
  )
}

interface AudioSectionProps {
  track: AudioTrack
  onPreviewAudio: (track: AudioTrack) => void
  onCommitAudio: () => void
  onChangeAudio: (track: AudioTrack) => void
}

/**
 * Every editor-managed audio-track field EXCEPT delete. Deliberate: this
 * panel appears the moment a track is plain-selected, and a destructive
 * action one click away from selecting is a foot-gun. `ClipInspectModal`
 * (host-side, opened by double-click — a more deliberate action) keeps the
 * delete control.
 */
function AudioSection({ track, onPreviewAudio, onCommitAudio, onChangeAudio }: AudioSectionProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [fadesOpen, setFadesOpen] = useState(false)
  const [duckingOpen, setDuckingOpen] = useState(false)

  const volume = track.volume ?? 1
  const muted = track.muted ?? false
  const fadeIn = track.fadeIn ?? 0
  const fadeOut = track.fadeOut ?? 0
  const duckingEnabled = track.ducking?.enabled ?? false
  const duckingDepth = track.ducking?.depth ?? -12
  const duckingAttack = track.ducking?.attack ?? 0.3
  const duckingRelease = track.ducking?.release ?? 0.5
  const inPoint = track.inPoint ?? 0
  const outPoint = track.outPoint ?? (track.sourceDuration ?? (track.end - track.start))
  const start = track.start
  const end = track.end

  /** Constraints the retired ClipInspectModal enforced on these same fields.
   *  They are re-applied HERE, on the way out, rather than left to the number
   *  inputs' `min`/`max` attributes: a typed value bypasses those entirely, so
   *  without this an operator can commit `end <= start` (a negative-duration
   *  track), trim points outside the source, or a fade longer than the clip.
   *  Each clamp is applied only when its own field is the one being edited, so
   *  editing one field never silently rewrites another. */
  function clampAudioPatch(patch: Partial<AudioTrack>): Partial<AudioTrack> {
    const next = { ...patch }
    const srcDur = track.sourceDuration ?? Infinity

    // `end` must stay strictly after `start` (and vice versa). EPS rather than
    // equality: a zero-length track is as broken as a negative one.
    const EPS = 0.001
    if (next.end !== undefined) next.end = Math.max(start + EPS, next.end)
    if (next.start !== undefined) next.start = Math.min(end - EPS, Math.max(0, next.start))

    // Trim points stay inside the source and never cross each other.
    if (next.inPoint !== undefined) next.inPoint = Math.max(0, Math.min(next.inPoint, outPoint))
    if (next.outPoint !== undefined) {
      next.outPoint = Math.max(inPoint, srcDur === Infinity ? next.outPoint : Math.min(next.outPoint, srcDur))
    }

    // A fade can't outrun the clip it's fading, and the modal capped it at 5s.
    const maxFade = Math.max(0, Math.min(5, (next.end ?? end) - (next.start ?? start)))
    if (next.fadeIn !== undefined) next.fadeIn = Math.max(0, Math.min(next.fadeIn, maxFade))
    if (next.fadeOut !== undefined) next.fadeOut = Math.max(0, Math.min(next.fadeOut, maxFade))

    return next
  }

  function previewAudio(patch: Partial<AudioTrack>) {
    onPreviewAudio({ ...track, ...clampAudioPatch(patch) })
  }

  function previewDucking(patch: Partial<NonNullable<AudioTrack['ducking']>>) {
    onPreviewAudio({
      ...track,
      ducking: { enabled: duckingEnabled, depth: duckingDepth, attack: duckingAttack, release: duckingRelease, ...patch },
    })
  }

  function toggleDucking(next: boolean) {
    // Enabling seeds every field with its current-or-default value (never a
    // half-empty object); disabling only flips the flag, so re-enabling
    // brings back whatever the operator had tuned.
    onChangeAudio({
      ...track,
      ducking: next
        ? { enabled: true, depth: duckingDepth, attack: duckingAttack, release: duckingRelease }
        : { ...track.ducking, enabled: false },
    })
  }

  return (
    <CollapsibleSection label="Audio track" collapsed={collapsed} onToggle={() => setCollapsed(c => !c)}>
      <Row label="Label">
        <DraftField
          ariaLabel="Track label"
          type="text"
          value={track.label ?? basename(track.src)}
          onInput={raw => previewAudio({ label: raw })}
          onCommit={raw => {
            // Falls back to the source basename on save, exactly like
            // ClipInspectModal's AudioInspect — an emptied label never
            // persists as an unlabeled track.
            const finalLabel = raw.trim() || basename(track.src)
            onPreviewAudio({ ...track, label: finalLabel })
            onCommitAudio()
          }}
        />
      </Row>

      <VolumeControl
        value={volume}
        onChange={v => previewAudio({ volume: v })}
        onCommit={() => onCommitAudio()}
        label="Volume"
        idBase="clip-properties-audio-volume"
      />
      <Row label="Mute">
        <Switch checked={muted} onCheckedChange={next => onChangeAudio({ ...track, muted: next })} aria-label="Mute track" />
      </Row>

      <CollapsibleSection label="Fades" collapsed={!fadesOpen} onToggle={() => setFadesOpen(o => !o)} nested>
        <Row label="Fade in">
          <DraftField
            ariaLabel="Fade in"
            type="number"
            min={0}
            value={String(fadeIn)}
            onInput={raw => parseNumberInput(raw, 0, v => previewAudio({ fadeIn: v }))}
            onCommit={() => onCommitAudio()}
          />
        </Row>
        <Row label="Fade out">
          <DraftField
            ariaLabel="Fade out"
            type="number"
            min={0}
            value={String(fadeOut)}
            onInput={raw => parseNumberInput(raw, 0, v => previewAudio({ fadeOut: v }))}
            onCommit={() => onCommitAudio()}
          />
        </Row>
      </CollapsibleSection>

      <CollapsibleSection
        label="Ducking"
        collapsed={!duckingOpen}
        onToggle={() => setDuckingOpen(o => !o)}
        nested
        badge={duckingEnabled ? <span className="text-[10px] text-[var(--editor-accent)]">On</span> : undefined}
      >
        <Row label="Enabled">
          <Switch checked={duckingEnabled} onCheckedChange={toggleDucking} aria-label="Enable ducking" />
        </Row>
        <Row label="Depth">
          <DraftField
            ariaLabel="Depth"
            type="number"
            step={1}
            disabled={!duckingEnabled}
            value={String(duckingDepth)}
            onInput={raw => parseNumberInput(raw, undefined, v => previewDucking({ depth: v }))}
            onCommit={() => onCommitAudio()}
          />
        </Row>
        <Row label="Attack">
          <DraftField
            ariaLabel="Attack"
            type="number"
            min={0}
            step={0.05}
            disabled={!duckingEnabled}
            value={String(duckingAttack)}
            onInput={raw => parseNumberInput(raw, 0, v => previewDucking({ attack: v }))}
            onCommit={() => onCommitAudio()}
          />
        </Row>
        <Row label="Release">
          <DraftField
            ariaLabel="Release"
            type="number"
            min={0}
            step={0.05}
            disabled={!duckingEnabled}
            value={String(duckingRelease)}
            onInput={raw => parseNumberInput(raw, 0, v => previewDucking({ release: v }))}
            onCommit={() => onCommitAudio()}
          />
        </Row>
      </CollapsibleSection>

      {/* Timeline position. Plain writes, exactly as the modal saved them (no
          derived math, unlike a clip speed change): these are the same values a
          drag on the timeline sets, offered numerically so the panel is full
          parity with the modal it replaces and the modal can retire outright. */}
      <Row label="Start">
        <DraftField
          ariaLabel="Start"
          type="number"
          min={0}
          value={String(start)}
          onInput={raw => parseNumberInput(raw, 0, v => previewAudio({ start: v }))}
          onCommit={() => onCommitAudio()}
        />
      </Row>
      <Row label="End">
        <DraftField
          ariaLabel="End"
          type="number"
          min={0}
          value={String(end)}
          onInput={raw => parseNumberInput(raw, 0, v => previewAudio({ end: v }))}
          onCommit={() => onCommitAudio()}
        />
      </Row>
      <Row label="In point">
        <DraftField
          ariaLabel="In point"
          type="number"
          min={0}
          value={String(inPoint)}
          onInput={raw => parseNumberInput(raw, 0, v => previewAudio({ inPoint: v }))}
          onCommit={() => onCommitAudio()}
        />
      </Row>
      <Row label="Out point">
        <DraftField
          ariaLabel="Out point"
          type="number"
          min={0}
          value={String(outPoint)}
          onInput={raw => parseNumberInput(raw, 0, v => previewAudio({ outPoint: v }))}
          onCommit={() => onCommitAudio()}
        />
      </Row>
    </CollapsibleSection>
  )
}

export default function ClipPropertiesPanel({
  selection,
  onPreviewClip,
  onCommitClip,
  onChangeClip,
  onPreviewAudio,
  onCommitAudio,
  onChangeAudio,
  generationSlot,
}: ClipPropertiesPanelProps) {
  if (!selection) {
    return (
      <div className={SECTION_CLASS}>
        <div className="px-3 py-6 text-center text-[11px] text-[var(--editor-text)]/45">
          Select a clip to edit its properties.
        </div>
      </div>
    )
  }

  if (selection.kind === 'clip') {
    return (
      <>
        <ClipSection item={selection.item} onPreviewClip={onPreviewClip} onCommitClip={onCommitClip} onChangeClip={onChangeClip} />
        {generationSlot}
      </>
    )
  }

  return (
    <AudioSection track={selection.track} onPreviewAudio={onPreviewAudio} onCommitAudio={onCommitAudio} onChangeAudio={onChangeAudio} />
  )
}
