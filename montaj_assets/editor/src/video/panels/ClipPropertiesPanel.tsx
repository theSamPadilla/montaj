import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Crop } from 'lucide-react'
import type { AudioTrack, EditorProject, VisualItem } from '../../schema'
import { setClipSpeed } from '../cuts'
import SpeedControl from '../timeline/SpeedControl'
import VolumeControl from '../timeline/VolumeControl'
import { cn, inspectorInputClass, Switch } from '../../ui'
import { usePersistentState } from '../../ui/usePersistentState'
import TabNav, { type TabNavTab } from './TabNav'

/**
 * `<ClipPropertiesPanel>` — the editor's contextual right-hand properties
 * panel for a selected VIDEO CLIP or AUDIO TRACK. The sibling of
 * `OverlayInspector` (the overlay Transform panel, which this panel now also
 * hosts as its clip Transform tab): the two mount in the same column and
 * share its visual language — `var(--editor-*)` custom properties,
 * `inspectorInputClass` inputs, the same section chrome — so the column
 * reads as one system no matter which one is showing.
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
  /** Transform tab body for a selected clip: the host's `OverlayInspector`
   *  instance, wired to the playback clock and the host's own sync/seek
   *  handlers — none of which this props-driven package has on hand, so the
   *  host builds it and hands it in rather than this panel importing and
   *  wiring `OverlayInspector` itself. Absent -> no Transform tab. */
  transformSlot?: ReactNode
  /** Present -> a Crop tab appears whose body is a single button that calls
   *  this. The caller decides WHETHER cropping applies to the current
   *  selection (e.g. only a tracks[0] video) — this panel just renders the
   *  tab it's offered and defers to a host-owned crop tool. Absent -> no
   *  Crop tab. */
  onOpenCrop?: () => void
  /** Generate tab body when a video clip is selected. Montaj puts its AI
   *  generation / regenerate surface here: that reads and writes
   *  `project.regenQueue`, a host-only field this package deliberately knows
   *  nothing about (see schema.ts's EditorProject index-signature comment).
   *  Absent -> no Generate tab. */
  generationSlot?: ReactNode
}

const SECTION_CLASS = 'shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden'
const ROW_LABEL_CLASS = 'w-16 shrink-0 text-[11px] text-[var(--editor-text)]/55'

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** One collapsible section frame, shared by the Audio track section and its
 *  Fades/Ducking sub-groups (via `nested`). Mirrors OverlayInspector's
 *  Transform section header exactly (chevron + uppercase label), scaled
 *  down for a nested sub-group. The Clip side used to share this too, before
 *  its fields became tabbed (a tab has nothing to fold). */
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

// ── Clip properties tabs ────────────────────────────────────────────────
// Which of the selected clip's tabs is showing. Persisted per browser like
// every other panel preference, so the operator's habit survives a reload.
// 'transform' is the default — geometry is what an operator reaches for
// first when a clip is selected, matching OverlayInspector's own Transform
// tab for overlays.
const CLIP_PANEL_TAB_STORAGE_KEY = 'montaj.editor.clipPanelTab'
type ClipPanelTab = 'transform' | 'speed' | 'volume' | 'crop' | 'generate'
const CLIP_PANEL_TAB_IDS: readonly ClipPanelTab[] = ['transform', 'speed', 'volume', 'crop', 'generate']
const reviveClipPanelTab = (raw: unknown): ClipPanelTab | null =>
  typeof raw === 'string' && (CLIP_PANEL_TAB_IDS as readonly string[]).includes(raw) ? (raw as ClipPanelTab) : null

interface ClipTabsProps {
  item: VisualItem
  onPreviewClip: (item: VisualItem) => void
  onCommitClip: () => void
  onChangeClip: (item: VisualItem) => void
  transformSlot?: ReactNode
  onOpenCrop?: () => void
  generationSlot?: ReactNode
}

/**
 * A selected clip's properties, tabbed: **Transform · Speed · Volume · Crop
 * · Generate**, in that fixed order. A tab appears only when it has
 * something to show for THIS selection — an image clip with no generation
 * slot offers only Transform and Volume; a main-track video with both slots
 * offers all five. Replaces the old flat `ClipSection` (Volume + Mute +
 * video-only Speed stacked above the host's `generationSlot`).
 */
function ClipTabs({ item, onPreviewClip, onCommitClip, onChangeClip, transformSlot, onOpenCrop, generationSlot }: ClipTabsProps) {
  const tabs: TabNavTab<ClipPanelTab>[] = []
  if (transformSlot !== undefined) tabs.push({ value: 'transform', label: 'Transform' })
  // Speed is video-only, matching the modal this replaces. `setClipSpeed`
  // returns the project UNCHANGED for a non-video item (cuts.ts's
  // `item.type !== 'video'` early return), so offering the tab for an image
  // would give the operator a slider that silently does nothing.
  if (item.type === 'video') tabs.push({ value: 'speed', label: 'Speed' })
  tabs.push({ value: 'volume', label: 'Volume' })
  if (onOpenCrop) tabs.push({ value: 'crop', label: 'Crop' })
  if (generationSlot !== undefined) tabs.push({ value: 'generate', label: 'Generate' })

  const [persistedTab, setPersistedTab] = usePersistentState<ClipPanelTab>(
    CLIP_PANEL_TAB_STORAGE_KEY,
    'transform',
    reviveClipPanelTab,
  )

  // Stale-tab safety AT RENDER TIME, not just on load: unlike LeftPanelTabs'
  // static rail, this tab set is DERIVED FROM THE SELECTION — an image has
  // no Speed tab, a clip with no `generationSlot` has no Generate tab — so it
  // changes as the operator selects different clips. A persisted/active tab
  // that isn't in the CURRENT set (persisted 'speed', then the operator
  // selects an image) falls back to 'transform', or to the first tab this
  // selection actually offers if even Transform is missing, rather than
  // rendering a blank pane.
  const currentTab: ClipPanelTab = tabs.some(t => t.value === persistedTab)
    ? persistedTab
    : tabs.some(t => t.value === 'transform')
      ? 'transform'
      : (tabs[0]?.value ?? 'volume')

  // Lazy mount, then KEEP MOUNTED: a tab body isn't rendered until first
  // activated, but once mounted it stays mounted and is only hidden on
  // switch-away — exactly `LeftPanelTabs`' policy, and load-bearing here for
  // the same reason it's load-bearing there. The Generate tab's slot seeds
  // its regen form (prompt, model, duration, reference images) from
  // `useState` initializers that run ONCE per mount; unmounting it on
  // Generate -> Speed -> Generate would silently lose everything the
  // operator had typed. Do not "optimize" this into a plain conditional
  // render.
  const [mountedTabs, setMountedTabs] = useState<Set<ClipPanelTab>>(() => new Set([currentTab]))
  if (!mountedTabs.has(currentTab)) {
    setMountedTabs(prev => {
      const next = new Set(prev)
      next.add(currentTab)
      return next
    })
  }

  const volume = item.volume ?? 1
  const muted = item.muted ?? false
  const speed = item.speed ?? 1

  return (
    <>
      <TabNav
        tabs={tabs}
        value={currentTab}
        onChange={setPersistedTab}
        ariaLabel="Clip panel view"
        className="shrink-0 border-b border-[var(--editor-border)] px-1"
      />
      {tabs
        .filter(tab => mountedTabs.has(tab.value))
        .map(tab => {
          const active = tab.value === currentTab
          return (
            <div
              key={tab.value}
              hidden={!active}
              style={active ? undefined : { display: 'none' }}
              className="flex flex-col overflow-hidden"
            >
              {/* Transform/Generate render the host slot DIRECTLY — each
                  already brings its own section chrome (OverlayInspector
                  wraps itself in the same SECTION_CLASS this file uses).
                  Wrapping them again here would double up borders/padding. */}
              {tab.value === 'transform' && transformSlot}
              {tab.value === 'speed' && (
                <div className="flex flex-col gap-2 p-2">
                  <SpeedControl
                    value={speed}
                    // The drag/type gesture only ever shows the SPEED number
                    // moving — mirroring ClipInspectModal's slider, which
                    // doesn't resize the clip until its Save button is
                    // pressed. Duration is re-fit exactly once, in onCommit
                    // below, via the real function.
                    onChange={v => onPreviewClip({ ...item, speed: v })}
                    onCommit={v => {
                      onPreviewClip(withResolvedSpeed(item, v))
                      onCommitClip()
                    }}
                    label="Speed"
                    idBase="clip-properties-speed"
                  />
                </div>
              )}
              {tab.value === 'volume' && (
                <div className="flex flex-col gap-2 p-2">
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
                </div>
              )}
              {tab.value === 'crop' && onOpenCrop && (
                <div className="flex flex-col items-center gap-3 px-5 pt-8 pb-6 text-center">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
                    <Crop size={20} />
                  </div>
                  <p className="max-w-[220px] text-xs leading-relaxed text-[var(--editor-text)]/60">
                    Reframe this clip by cropping its source video. Pick the part of the frame to keep.
                  </p>
                  <button
                    type="button"
                    onClick={onOpenCrop}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--editor-accent)] px-3 py-1.5 text-xs font-medium text-[var(--editor-accent-foreground)] transition-opacity hover:opacity-90"
                  >
                    <Crop size={13} />
                    Open crop tool
                  </button>
                </div>
              )}
              {tab.value === 'generate' && generationSlot}
            </div>
          )
        })}
    </>
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
  transformSlot,
  onOpenCrop,
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
      <ClipTabs
        item={selection.item}
        onPreviewClip={onPreviewClip}
        onCommitClip={onCommitClip}
        onChangeClip={onChangeClip}
        transformSlot={transformSlot}
        onOpenCrop={onOpenCrop}
        generationSlot={generationSlot}
      />
    )
  }

  return (
    <AudioSection track={selection.track} onPreviewAudio={onPreviewAudio} onCommitAudio={onCommitAudio} onChangeAudio={onChangeAudio} />
  )
}
