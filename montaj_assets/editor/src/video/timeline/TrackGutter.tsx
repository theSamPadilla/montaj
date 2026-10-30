import { useRef, useState, type RefObject } from 'react'
import { AudioLines, Box, Captions, Eye, EyeOff, Film, Layers, Magnet, MoveHorizontal, Settings2, Volume2, VolumeX, ZoomIn, ZoomOut } from 'lucide-react'
import { Tooltip } from '../../ui/Tooltip'
import ConfirmDialog from '../../ui/ConfirmDialog'
import TrackContextMenu from './TrackContextMenu'
import { audioLaneItemCount, canRemoveAudioLane, canRemoveVisualTrack, visualTrackItemCount } from './trackRemoval'
import type { Project } from '../../types'
import type { VisualItem } from '../../schema'
import { computeTimelineLayout, timelinePalette, type TimelineLayout, type TimelineMode, type TrackPalette, type VisualRowLayout, type AudioLaneLayout } from './canvas/draw'
import { AUDIO_LANE_HEIGHT_PX, normalizeTracks, trackItems } from './timeline-model'
import TrackSettingsPopover from './TrackSettingsPopover'
import { isScene3dItem } from '../scene3d'

/**
 * The left rail naming each track, aligned row-for-row with the canvas beside
 * it — a real column rather than a badge floating over the clips, so it never
 * covers the first frames of whatever sits at t=0.
 *
 * It carries what every clip used to repeat: the type. A track of twelve video
 * clips said "video" twelve times, which cost a label slot on every block and
 * still didn't tell you what the TRACK was. Saying it once here frees the
 * clip's own label for what's actually particular to it — an overlay's
 * component and copy — and lets a video clip carry no label at all, since its
 * filmstrip identifies it better than a word could.
 *
 * The rail sits OUTSIDE the canvas, so the canvas keeps x=0 ≡ the viewport's
 * scroll position and no coordinate math changes. It shrinks the canvas'
 * measured width instead, which the viewport picks up on its own.
 */

// Icon plus one control, with room to breathe. A written label wide enough not
// to truncate ("Captions", "Overlay") cost ~88px of timeline for a word you
// only need once; the icon carries it and the word is a hover away. But 34px —
// icon alone, hard against both edges — was too tight to read and left nowhere
// for the skip control to live.
// Type glyph plus ONE column of stacked controls. Side-by-side controls forced
// the rail to 84px and still crowded; stacking them uses the height these rows
// already have — the base track is 120px tall and was showing a single row of
// icons in the top 16px of it.
const GUTTER_WIDTH_PX = 46

/**
 * Timeline look B (dark): the quiet rail. No cell boxes, no left accent bar,
 * no borders — the track-kind icon and the row's controls sit straight on the
 * pane's gradient. Light keeps the boxed cells.
 *
 * A row under `QUIET_ROW_MIN_COLUMN_PX` lays the icon and its controls out in
 * a row; a taller one stacks them in a column under the icon, and when the
 * column would overflow the row (the 64px audio lane's three controls) the
 * controls wrap two to a line.
 */
const QUIET_ICON_COLOR = '#99ABBD'
const QUIET_ROW_MIN_COLUMN_PX = 50
const QUIET_PAD_TOP_PX = 8
const QUIET_ICON_PX = 15
const QUIET_CONTROL_PX = 16
const QUIET_COLUMN_GAP_PX = 7

/** Do `count` controls fit one under another below the icon in `height`? */
export function quietColumnFits(height: number, count: number): boolean {
  if (count === 0) return true
  return QUIET_PAD_TOP_PX + QUIET_ICON_PX + count * (QUIET_CONTROL_PX + QUIET_COLUMN_GAP_PX) <= height
}

/** Idle and hover colours for a rail control, per mode. Dark is look B's
 *  muted slate; light keeps the `--editor-text` mixes it always had. */
function idleControlClass(mode: TimelineMode, gear = false): string {
  // Whole literals, never assembled, so Tailwind's scanner sees every class.
  if (mode !== 'light') return 'text-[rgba(153,171,189,0.65)] hover:text-[#B6C9D9]'
  return gear
    ? 'text-[color-mix(in_srgb,var(--editor-text)_40%,transparent)] hover:text-[color-mix(in_srgb,var(--editor-text)_90%,transparent)]'
    : 'text-[color-mix(in_srgb,var(--editor-text)_35%,transparent)] hover:text-[color-mix(in_srgb,var(--editor-text)_80%,transparent)]'
}

/** Hit-area size for a rail control: 16px on the quiet rail, 14px light. */
function controlSizeClass(mode: TimelineMode): string {
  return mode === 'light' ? 'h-3.5 w-3.5' : 'h-4 w-4'
}

/**
 * What a visual track is *for*, from what it holds. Tracks aren't typed in the
 * schema — a track is just an array — so this reads the items: the type shared
 * by all of them, or the first item's type when a track mixes (rare; an overlay
 * track that also holds a still, say). An empty track has no answer, and says
 * so rather than guessing "video".
 */
export function visualTrackKind(items: VisualItem[]): 'video' | 'overlay' | 'image' | null {
  if (items.length === 0) return null
  // The first item's type, whether or not the track is homogeneous — a mixed
  // track (an overlay track that also holds a still, say) is named for what it
  // mostly is rather than refusing to answer.
  return items[0].type
}

/**
 * What the rail shows for a track: `visualTrackKind`, except a track whose every
 * item is a 3D scene reads as 'scene3d' (the 3D mark). A track that mixes 3D with
 * other items keeps its first item's kind, so it is still the overlay icon.
 */
export function trackIconKind(items: VisualItem[]): 'scene3d' | 'video' | 'overlay' | 'image' | null {
  if (items.length > 0 && items.every(i => isScene3dItem(i))) return 'scene3d'
  return visualTrackKind(items)
}

const KIND_LABEL: Record<string, string> = {
  scene3d: '3D',
  video: 'Video',
  overlay: 'Overlay',
  image: 'Image',
}

/**
 * The track's shared clip speed, for the settings popover's display value —
 * same "read the items, not track-level settings" approach `visualTrackKind`
 * above uses, since speed lives on each video `VisualItem`, not the track.
 * Returns 1 when the track holds no video clips or its clips disagree, same
 * "representative value, actual apply always writes the real thing"
 * convention `AudioLaneRailRow` already uses for a lane's volume.
 */
function commonTrackSpeed(items: VisualItem[]): number {
  const speeds = items.filter(i => i.type === 'video').map(i => i.speed ?? 1)
  if (speeds.length === 0) return 1
  return speeds.every(s => s === speeds[0]) ? speeds[0] : 1
}

function KindIcon({ kind, className }: { kind: string | null; className?: string }) {
  if (kind === 'scene3d') return <Box size={15} className={className} />
  if (kind === 'overlay' || kind === 'image') return <Layers size={15} className={className} />
  return <Film size={15} className={className} />
}

interface RailCellProps {
  height: number
  /** Left edge accent, matching the hue the clips on this row are drawn in.
   *  Light only: the quiet dark rail has no accent bar. */
  accent?: string
  icon: React.ReactNode
  label: string
  /** The row's inline controls — skip, mute, magnet — in display order. The
   *  settings gear, when there is one, follows them. */
  controls?: React.ReactNode[]
  /** Dim the cell to match a skipped track's dimmed clips. */
  dimmed?: boolean
  /** Which rail to draw: the boxed light cell, or look B's quiet dark one. */
  mode?: TimelineMode
  /**
   * Makes the icon itself a button that opens the track-settings popover
   * (TrackSettingsPopover). Absent → the icon stays the plain, non-interactive
   * label it always was — the Captions row, or a visual/audio row when no
   * settings callback at all is wired (same "no dead button" rule the skip
   * toggle already follows).
   */
  settingsButton?: {
    onClick: () => void
    open: boolean
    buttonRef: RefObject<HTMLButtonElement | null>
    /** Names the button for screen readers — the gear alone says nothing. */
    label: string
  }
}

function SettingsGear({ settingsButton, mode }: { settingsButton: NonNullable<RailCellProps['settingsButton']>; mode: TimelineMode }) {
  return (
    <Tooltip label={settingsButton.label}>
      <button
        ref={settingsButton.buttonRef}
        type="button"
        aria-label={settingsButton.label}
        aria-haspopup="dialog"
        aria-expanded={settingsButton.open}
        onClick={settingsButton.onClick}
        className={`flex ${controlSizeClass(mode)} items-center justify-center rounded transition-colors ${
          settingsButton.open
            ? (mode === 'light'
              ? 'text-[color-mix(in_srgb,var(--editor-text)_90%,transparent)] bg-[color-mix(in_srgb,var(--editor-text)_10%,transparent)]'
              : 'text-[#B6C9D9] bg-[rgba(153,171,189,0.15)]')
            : `${idleControlClass(mode, true)} ${mode === 'light' ? 'hover:bg-[color-mix(in_srgb,var(--editor-text)_10%,transparent)]' : 'hover:bg-[rgba(153,171,189,0.12)]'}`
        }`}
      >
        <Settings2 size={13} />
      </button>
    </Tooltip>
  )
}

/**
 * One row of the rail. Content sits at the TOP rather than centred: rows vary
 * from 48px to 120px, and a centred icon on the tall base track floats in the
 * middle of nothing while the short rows look fine. Top-aligned, every cell
 * reads as the same control at the same place.
 */
function RailCell({ height, accent, icon, label, controls = [], dimmed, settingsButton, mode = 'dark' }: RailCellProps) {
  const all = settingsButton ? [...controls, <SettingsGear key="settings" settingsButton={settingsButton} mode={mode} />] : controls

  if (mode !== 'light') {
    // Look B: no box, no accent bar, no border. The row's height picks the
    // arrangement (see `QUIET_ROW_MIN_COLUMN_PX` / `quietColumnFits`).
    const inline = height < QUIET_ROW_MIN_COLUMN_PX
    const wrap = !inline && !quietColumnFits(height, all.length)
    return (
      <div
        data-rail-cell="quiet"
        className={`flex select-none items-center overflow-hidden transition-opacity ${inline ? 'flex-row justify-center gap-1' : 'flex-col justify-start'} ${dimmed ? 'opacity-40' : ''}`}
        style={{ height, paddingTop: inline ? 0 : (wrap ? 6 : QUIET_PAD_TOP_PX), gap: inline ? 4 : (wrap ? 4 : QUIET_COLUMN_GAP_PX) }}
      >
        <Tooltip label={label}>
          <span aria-label={label} className="flex h-4 w-4 items-center justify-center" style={{ color: QUIET_ICON_COLOR }}>
            {icon}
          </span>
        </Tooltip>
        {all.length > 0 && (
          <div
            className={`flex items-center ${inline ? 'flex-row gap-1' : wrap ? 'flex-row flex-wrap justify-center gap-1' : 'flex-col'}`}
            style={inline || wrap ? (wrap ? { maxWidth: QUIET_CONTROL_PX * 2 + 4 } : undefined) : { gap: QUIET_COLUMN_GAP_PX }}
          >
            {all}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      data-rail-cell="boxed"
      className={`flex items-start gap-1 rounded overflow-hidden bg-[var(--editor-surface)] border border-[var(--editor-border)] px-1 py-0.5 select-none transition-opacity ${dimmed ? 'opacity-40' : ''}`}
      style={{ height, borderLeft: accent ? `2px solid ${accent}` : undefined }}
    >
      {/* The type icon identifies the row and is NOT interactive. It used to
          double as the settings trigger, which made it impossible to tell which
          icons could be clicked — a decorative-looking glyph that happened to
          open a dialog. Settings moved to the gear beside it. */}
      <Tooltip label={label}>
        <span aria-label={label} className="flex h-4 w-4 items-center justify-center text-[color-mix(in_srgb,var(--editor-text)_50%,transparent)]">
          {icon}
        </span>
      </Tooltip>
      {/* One COLUMN of controls, not a row: the rows are 48-120px tall and were
          wasting all of that height on a single line of icons, which forced the
          rail wide enough to crowd the timeline.

          The gap is a single constant across every row height, so the audio
          lane's controls and the base track's controls read as the same
          spacing rather than "cramped" vs. "spread". Content stays top-aligned,
          so the tall base track just has unused space below the stack —
          harmless — instead of gap scaling to fill it. */}
      <div className="flex min-w-0 flex-col gap-1.5">
        {all}
      </div>
    </div>
  )
}

/**
 * The per-track mute switch, inline in the rail beside skip.
 *
 * Mute lives here rather than behind the settings gear because it is a state
 * you flip constantly while cutting and need to SEE at a glance — the icon is
 * both the control and the indicator. The gear is for the settings you set once
 * and leave (volume today, speed later).
 *
 * Only rendered for rows that can actually carry audio: an overlay-only track
 * has no audio to mute, so offering the control there is a lie.
 */
function MuteToggle({ muted, onToggle, trackLabel, mode }: { muted: boolean; onToggle: () => void; trackLabel: string; mode: TimelineMode }) {
  return (
    <Tooltip label={muted ? `Unmute ${trackLabel}` : `Mute ${trackLabel}`}>
      <button
        type="button"
        aria-label={`Mute ${trackLabel}`}
        aria-pressed={muted}
        onClick={onToggle}
        className={`flex ${controlSizeClass(mode)} items-center justify-center rounded transition-colors ${
          muted
            ? (mode === 'light' ? 'text-amber-600 hover:text-amber-700' : 'text-amber-400/90 hover:text-amber-300')
            : idleControlClass(mode)
        }`}
      >
        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
    </Tooltip>
  )
}

/**
 * The per-lane magnet switch — gapless mode. Modeled directly on `MuteToggle`
 * beside it: same size, same lit-vs-dim shape, the icon doubling as both
 * control and indicator so the row's state reads at a glance without opening
 * the settings gear. Audio-lane only today (see `AudioLaneRailRow`); no
 * visual-track equivalent exists yet.
 */
function MagnetToggle({ magnetic, onToggle, trackLabel, mode }: { magnetic: boolean; onToggle: () => void; trackLabel: string; mode: TimelineMode }) {
  return (
    <Tooltip label="Magnetic track — keep gapless">
      <button
        type="button"
        aria-label={`Magnetic ${trackLabel}`}
        aria-pressed={magnetic}
        onClick={onToggle}
        className={`flex ${controlSizeClass(mode)} items-center justify-center rounded transition-colors ${
          magnetic
            ? (mode === 'light' ? 'text-emerald-600 hover:text-emerald-700' : 'text-emerald-400/90 hover:text-emerald-300')
            : idleControlClass(mode)
        }`}
      >
        <Magnet size={13} />
      </button>
    </Tooltip>
  )
}

/** The per-track skip switch. Eye/EyeOff rather than a checkbox: it reads at
 *  14px and says "shown / not shown" without a word. */
function SkipToggle({ enabled, onToggle, trackLabel, mode }: { enabled: boolean; onToggle: () => void; trackLabel: string; mode: TimelineMode }) {
  return (
    <Tooltip label={enabled ? `Skip ${trackLabel} track` : `Un-skip ${trackLabel} track`}>
      <button
        type="button"
        aria-label={`Skip ${trackLabel} track`}
        aria-pressed={!enabled}
        onClick={onToggle}
        className={`flex ${controlSizeClass(mode)} items-center justify-center rounded transition-colors ${
          enabled
            ? idleControlClass(mode)
            : (mode === 'light' ? 'text-amber-600/90 hover:text-amber-700' : 'text-amber-400/80 hover:text-amber-300')
        }`}
      >
        {enabled ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
    </Tooltip>
  )
}

/**
 * One visual-track row: the rail cell plus, on demand, its settings popover.
 * Pulled out of the row `.map()` in `TrackGutter` because it needs its own
 * `useState`/`useRef` for the popover's open state and anchor — hooks can't
 * live inside a bare map callback.
 */
function VisualTrackRailRow({
  row,
  palette,
  mode,
  label,
  kind,
  enabled,
  volume,
  muted,
  speed,
  onToggleTrackEnabled,
  onSetTrackVolume,
  onSetTrackMuted,
  onApplySpeed,
  onContextMenu,
}: {
  row: VisualRowLayout
  palette: TrackPalette
  mode: TimelineMode
  label: string
  kind: string | null
  enabled: boolean
  volume: number
  muted: boolean
  speed: number
  onToggleTrackEnabled?: (trackIdx: number, enabled: boolean) => void
  onSetTrackVolume?: (trackIdx: number, volume: number, commit: boolean) => void
  onSetTrackMuted?: (trackIdx: number, muted: boolean) => void
  onApplySpeed?: (trackIdx: number, speed: number) => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Audio controls only where there IS audio. An overlay- or image-only track
  // carries none — `VisualItem.volume`/`muted` are documented "video type only" —
  // so a volume slider and a mute button on such a row are controls that cannot
  // do anything. Read the items rather than the track's nominal kind, so a
  // mixed track (an overlay track that also holds a clip) still gets them.
  // Speed is the same video-only concept, so it shares this gate.
  const hasAudio = row.items.some(i => i.type === 'video')

  const hasVolumeControl = hasAudio && !!onSetTrackVolume
  const hasSpeedControl = hasAudio && !!onApplySpeed

  // A button that opens an empty popover is worse than no button.
  const hasSettings = hasVolumeControl || hasSpeedControl
  const trackLabel = label.toLowerCase()

  return (
    <div className="absolute inset-x-0" style={{ top: row.y, height: row.height }} onContextMenu={onContextMenu}>
      <RailCell
        height={row.height}
        accent={palette.border}
        icon={<KindIcon kind={kind} />}
        label={label}
        dimmed={!enabled}
        mode={mode}
        settingsButton={hasSettings ? { onClick: () => setOpen(o => !o), open, buttonRef, label: `${label} track settings` } : undefined}
        // Visibility on top — it is the control you reach for most, and the
        // one whose state you scan a whole column of rows for. Mute sits
        // under it so the two state toggles stay together, with the settings
        // gear last.
        controls={[
          onToggleTrackEnabled && (
            <SkipToggle
              key="skip"
              enabled={enabled}
              mode={mode}
              trackLabel={trackLabel}
              onToggle={() => onToggleTrackEnabled(row.trackIdx, !enabled)}
            />
          ),
          hasAudio && onSetTrackMuted && (
            <MuteToggle
              key="mute"
              muted={muted}
              mode={mode}
              trackLabel={`${trackLabel} track`}
              onToggle={() => onSetTrackMuted(row.trackIdx, !muted)}
            />
          ),
        ].filter(Boolean)}
      />
      {open && hasSettings && (
        <TrackSettingsPopover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          title={`${label} track`}
          volume={hasVolumeControl ? volume : undefined}
          onVolumeChange={hasVolumeControl ? (v, commit) => onSetTrackVolume!(row.trackIdx, v, commit) : undefined}
          volumeAriaLabel={`${label} volume`}
          speed={hasSpeedControl ? speed : undefined}
          onApplySpeed={hasSpeedControl ? s => onApplySpeed!(row.trackIdx, s) : undefined}
          mode={mode}
        />
      )}
    </div>
  )
}

/**
 * One audio-lane row — same shape as `VisualTrackRailRow` minus skip (audio
 * lanes have no enabled/disabled concept; mute IS their skip). A lane can hold
 * several `AudioTrack`s (see `groupAudioLanes` in timeline-model.ts), so the
 * popover's controls apply to every track sharing the lane — Timeline.tsx's
 * `handleSetLaneVolume`/`handleSetLaneMuted` do the fan-out via the ids this
 * component passes up.
 */
function AudioLaneRailRow({
  lane,
  accent,
  mode,
  onSetLaneVolume,
  onSetLaneMuted,
  onSetLaneMagnet,
  onContextMenu,
}: {
  lane: AudioLaneLayout
  /** The emerald edge, handed down rather than hardcoded here: it is the audio
   *  BAR's own border colour, and on a light ground that is a different
   *  emerald. A literal here would have gone on saying the dark one. */
  accent: string
  mode: TimelineMode
  onSetLaneVolume?: (trackIds: string[], volume: number, commit: boolean) => void
  onSetLaneMuted?: (trackIds: string[], muted: boolean) => void
  onSetLaneMagnet?: (trackIds: string[], magnetic: boolean) => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // The gear holds volume only now that mute is inline in the rail.
  const hasSettings = !!onSetLaneVolume

  // Representative displayed value when the lane's tracks disagree: the
  // FIRST track's volume, and "every track muted" for the mute switch's
  // checked state — a half-muted lane reads as unmuted rather than silently
  // implying full mute. This only affects what's shown before you touch it;
  // committing the control always applies the new value to EVERY track in
  // the lane, per the task's own rule, regardless of what was shown.
  const volume = lane.tracks[0]?.volume ?? 1
  const muted = lane.tracks.length > 0 && lane.tracks.every(t => t.muted)
  const magnetic = lane.tracks.length > 0 && lane.tracks.every(t => t.magnetic)
  const trackIds = lane.tracks.map(t => t.id)

  return (
    <div className="absolute inset-x-0" style={{ top: lane.y, height: lane.height }} onContextMenu={onContextMenu}>
      <RailCell
        height={AUDIO_LANE_HEIGHT_PX}
        accent={accent}
        icon={<AudioLines size={15} />}
        label="Audio"
        mode={mode}
        settingsButton={hasSettings ? { onClick: () => setOpen(o => !o), open, buttonRef, label: 'Audio lane settings' } : undefined}
        controls={[
          onSetLaneMuted && (
            <MuteToggle
              key="mute"
              muted={muted}
              mode={mode}
              trackLabel="audio lane"
              onToggle={() => onSetLaneMuted(trackIds, !muted)}
            />
          ),
          onSetLaneMagnet && (
            <MagnetToggle
              key="magnet"
              magnetic={magnetic}
              mode={mode}
              trackLabel="audio lane"
              onToggle={() => onSetLaneMagnet(trackIds, !magnetic)}
            />
          ),
        ].filter(Boolean)}
      />
      {open && hasSettings && (
        <TrackSettingsPopover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          title="Audio"
          volume={volume}
          onVolumeChange={(v, commit) => onSetLaneVolume!(trackIds, v, commit)}
          volumeAriaLabel="Audio lane volume"
          mode={mode}
        />
      )}
    </div>
  )
}

export interface TrackGutterProps {
  project: Project
  /** Gates the caption rail cells, aligned with the canvas' own caption bands
   *  (`layout.captions`). Has no effect when the layout carries no bands at all
   *  (a project with no caption segments) — there is nothing to align a cell
   *  with. Defaults true so a host that hasn't wired the flag still sees the
   *  cells whenever the layout has any. */
  showCaptionRow?: boolean
  /** Layout to align against. Defaults to computing it from `project` — pass the
   *  caller's own so the two can't drift. */
  layout?: TimelineLayout
  /** Toggle a visual track's `enabled`. Absent → no skip controls (a host that
   *  hasn't wired the edit channel shows the rail read-only rather than
   *  offering a button that does nothing). */
  onToggleTrackEnabled?: (trackIdx: number, enabled: boolean) => void
  /** Visual-track volume, from the settings popover. `commit: false` on every
   *  drag tick (live preview only), `commit: true` once on release/keyup —
   *  mirrors `onToggleTrackEnabled`'s "absent ⇒ no control" convention. */
  onSetTrackVolume?: (trackIdx: number, volume: number, commit: boolean) => void
  /** Visual-track mute, from the settings popover. One call per click — mute
   *  is a discrete toggle, not a continuous gesture. */
  onSetTrackMuted?: (trackIdx: number, muted: boolean) => void
  /** Applies a speed to EVERY video clip on the track, from the settings
   *  popover's Speed control — committed on slider release / chip click (no
   *  button), a bulk edit with no `commit` flag (mirrors `onSetTrackMuted`).
   *  The DISPLAYED value isn't a prop — it's read off the track's own clips,
   *  same as `kind` above (see `commonTrackSpeed`). */
  onApplySpeed?: (trackIdx: number, speed: number) => void
  /** Audio-lane volume, from the settings popover — applies to every
   *  `AudioTrack` sharing the lane, hence the id array rather than one id. */
  onSetLaneVolume?: (trackIds: string[], volume: number, commit: boolean) => void
  /** Audio-lane mute, from the settings popover — same fan-out as volume. */
  onSetLaneMuted?: (trackIds: string[], muted: boolean) => void
  /** Audio-lane magnet (gapless mode), from the rail's inline toggle — same
   *  fan-out as mute/volume, and the same "absent ⇒ no control" convention. */
  onSetLaneMagnet?: (trackIds: string[], magnetic: boolean) => void
  /** Which ground the rail's non-token colours are picked for. The cell chrome
   *  itself is `--editor-*` driven and flips on its own; the LEFT-EDGE ACCENTS
   *  are not — they are the canvas' own track/caption/audio hues, and they have
   *  to be resolved from the same palette the canvas paints with or the rail
   *  and the clips beside it stop matching. Threaded from Timeline (never
   *  looked up here) for exactly that reason. Defaults to `'dark'`. */
  mode?: TimelineMode
  /** Remove a visual track and its items, from the header's right-click menu.
   *  Absent → the menu offers hide only. */
  onRemoveTrack?: (trackIdx: number) => void
  /** Remove every `AudioTrack` in a lane, same menu. */
  onRemoveAudioLane?: (laneIndex: number) => void
  /** Zoom out / zoom in / fit, drawn as icons in the rail's ruler corner
   *  (look B, dark only — light keeps Timeline's own "− + fit" row). Absent →
   *  the corner stays empty. */
  zoom?: { zoomIn: () => void; zoomOut: () => void; fit: () => void; badge?: React.ReactNode }
}

/** The three zoom icons in the rail's corner beside the ruler. */
function ZoomCorner({ ruler, zoom }: { ruler: { y: number; height: number }; zoom: NonNullable<TrackGutterProps['zoom']> }) {
  const buttons = [
    { label: 'Zoom out', Icon: ZoomOut, run: zoom.zoomOut },
    { label: 'Zoom in', Icon: ZoomIn, run: zoom.zoomIn },
    { label: 'Fit to view', Icon: MoveHorizontal, run: zoom.fit },
  ]
  return (
    <div
      data-timeline-chrome
      className="absolute inset-x-0 flex items-center justify-center gap-px"
      style={{ top: ruler.y, height: ruler.height }}
    >
      {/* The zoom multiple, kept for assistive tech only: look B shows no
          readout in a corner three icons already fill. */}
      {zoom.badge && <span className="sr-only">{zoom.badge}</span>}
      {buttons.map(({ label, Icon, run }) => (
        <Tooltip key={label} label={label}>
          <button
            type="button"
            aria-label={label}
            onClick={(e) => { e.stopPropagation(); run() }}
            className="flex h-3.5 w-3.5 items-center justify-center rounded text-[#99ABBD] transition-colors hover:text-[#B6C9D9] hover:bg-[rgba(153,171,189,0.12)]"
          >
            <Icon size={12} />
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

export default function TrackGutter({
  project,
  showCaptionRow = true,
  layout,
  mode = 'dark',
  onToggleTrackEnabled,
  onSetTrackVolume,
  onSetTrackMuted,
  onApplySpeed,
  onSetLaneVolume,
  onSetLaneMuted,
  onSetLaneMagnet,
  onRemoveTrack,
  onRemoveAudioLane,
  zoom,
}: TrackGutterProps) {
  const resolved = layout ?? computeTimelineLayout(project)
  const palette = timelinePalette(mode)
  const tracks = trackItems(project)
  // Read `enabled`/`volume`/`muted` off the normalized tracks — `trackItems`
  // gives items only, and a legacy-shaped project has no settings at all
  // (every track enabled, unity volume, unmuted).
  const trackSettings = normalizeTracks(project).tracks ?? []

  // Right-click on a header opens the menu; a non-empty track confirms first.
  type Target = { kind: 'visual' | 'audio'; index: number }
  const [menu, setMenu] = useState<(Target & { x: number; y: number }) | null>(null)
  const [confirm, setConfirm] = useState<(Target & { count: number }) | null>(null)
  const openMenu = (target: Target) => (e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ ...target, x: e.clientX, y: e.clientY })
  }
  const laneOf = (index: number) => resolved.lanes.find(l => l.laneIndex === index)
  const applyRemove = (t: Target) => {
    if (t.kind === 'visual') onRemoveTrack?.(t.index)
    else onRemoveAudioLane?.(t.index)
  }
  const menuHidden = menu
    ? menu.kind === 'visual'
      ? trackSettings[menu.index]?.enabled === false
      : (() => { const l = laneOf(menu.index); return !!l && l.tracks.length > 0 && l.tracks.every(t => t.muted) })()
    : false
  const menuCanHide = menu
    ? menu.kind === 'visual' ? !!onToggleTrackEnabled : !!onSetLaneMuted
    : false
  const menuCanRemove = !menu ? false
    : menu.kind === 'visual'
      ? !!onRemoveTrack && canRemoveVisualTrack(project, menu.index)
      : !!onRemoveAudioLane && canRemoveAudioLane(project, menu.index)

  return (
    <div className="flex shrink-0 flex-col" style={{ width: GUTTER_WIDTH_PX }}>
      {/* Absolute positioning mirrors the canvas' own layout pass, so a row's
          label sits at exactly the y its clips do — including the base track's
          extra height. */}
      <div className="relative" style={{ height: resolved.height }}>
        {zoom && mode !== 'light' && <ZoomCorner ruler={resolved.ruler} zoom={zoom} />}
        {resolved.rows.map(row => {
          const kind = trackIconKind(tracks[row.trackIdx] ?? [])
          const trackPalette = palette.tracks[row.trackIdx % palette.tracks.length]
          const label = kind ? KIND_LABEL[kind] ?? kind : 'Track'
          const settings = trackSettings[row.trackIdx]
          const enabled = settings?.enabled !== false
          return (
            <VisualTrackRailRow
              key={`row-${row.trackIdx}`}
              row={row}
              palette={trackPalette}
              mode={mode}
              label={label}
              kind={kind}
              enabled={enabled}
              volume={settings?.volume ?? 1}
              muted={settings?.muted ?? false}
              speed={commonTrackSpeed(tracks[row.trackIdx] ?? [])}
              onToggleTrackEnabled={onToggleTrackEnabled}
              onSetTrackVolume={onSetTrackVolume}
              onSetTrackMuted={onSetTrackMuted}
              onApplySpeed={onApplySpeed}
              onContextMenu={openMenu({ kind: 'visual', index: row.trackIdx })}
            />
          )
        })}
        {resolved.lanes.map(lane => (
          <AudioLaneRailRow
            key={`lane-${lane.laneIndex}`}
            lane={lane}
            accent={palette.colors.audioBorder}
            mode={mode}
            onSetLaneVolume={onSetLaneVolume}
            onSetLaneMuted={onSetLaneMuted}
            onSetLaneMagnet={onSetLaneMagnet}
            onContextMenu={openMenu({ kind: 'audio', index: lane.laneIndex })}
          />
        ))}
        {/* Same absolute-positioned wrapper every other row uses, keyed off
            each band's own `y` — gutter and canvas read the identical
            rectangles and can never drift apart. Gated on `resolved.captions`
            FIRST: a caption-less project's layout carries no bands at all (see
            TimelineLayout.captions), so `showCaptionRow` defaulting true must
            not conjure cells with nothing to align to.
            One band ⇒ the bare "Captions" label, unchanged from before N
            lanes existed. Several bands ⇒ "Captions 1"…"Captions N" (N =
            lane + 1) so each cell reads which lane it aligns to. */}
        {showCaptionRow && resolved.captions?.map(band => (
          <div key={`caption-${band.lane}`} className="absolute inset-x-0" style={{ top: band.y, height: band.height }}>
            <RailCell
              height={band.height}
              accent={palette.captionRailAccent}
              mode={mode}
              icon={<Captions size={15} />}
              label={resolved.captions!.length > 1 ? `Captions ${band.lane + 1}` : 'Captions'}
            />
          </div>
        ))}
      </div>
      {menu && (
        <TrackContextMenu
          x={menu.x}
          y={menu.y}
          mode={mode}
          hidden={menuHidden}
          hideLabel={menu.kind === 'audio' ? (menuHidden ? 'Unmute track' : 'Mute track') : undefined}
          removeDisabled={!menuCanRemove}
          onClose={() => setMenu(null)}
          onHide={() => {
            if (!menuCanHide) return
            if (menu.kind === 'visual') onToggleTrackEnabled!(menu.index, menuHidden)
            else {
              const l = laneOf(menu.index)
              if (l) onSetLaneMuted!(l.tracks.map(t => t.id), !menuHidden)
            }
          }}
          onRemove={() => {
            const target = { kind: menu.kind, index: menu.index }
            const count = menu.kind === 'visual'
              ? visualTrackItemCount(project, menu.index)
              : audioLaneItemCount(project, menu.index)
            if (count === 0) applyRemove(target)
            else setConfirm({ ...target, count })
          }}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        mode={mode}
        tone="danger"
        title={confirm ? `Remove track and ${confirm.count} ${confirm.count === 1 ? 'clip' : 'clips'}?` : ''}
        confirmLabel="Remove"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) applyRemove(confirm)
          setConfirm(null)
        }}
      />
    </div>
  )
}
