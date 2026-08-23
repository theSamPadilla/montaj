import { useRef, useState, type RefObject } from 'react'
import { AudioLines, Captions, Eye, EyeOff, Film, Layers, Settings2, Volume2, VolumeX } from 'lucide-react'
import { Tooltip } from '../../ui/Tooltip'
import type { Project } from '../../types'
import type { VisualItem } from '../../schema'
import { computeTimelineLayout, TRACK_PALETTE, type TimelineLayout, type TrackPalette, type VisualRowLayout, type AudioLaneLayout } from './canvas/draw'
import { AUDIO_LANE_HEIGHT_PX, ROW_GAP_PX, normalizeTracks, trackItems } from './timeline-model'
import TrackSettingsPopover from './TrackSettingsPopover'

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

/** Caption row height — the `h-10` on `trackRow` (utils.ts). */
const CAPTION_ROW_HEIGHT_PX = 40

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

const KIND_LABEL: Record<string, string> = {
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
  if (kind === 'overlay' || kind === 'image') return <Layers size={15} className={className} />
  return <Film size={15} className={className} />
}

interface RailCellProps {
  height: number
  /** Left edge accent, matching the hue the clips on this row are drawn in. */
  accent?: string
  icon: React.ReactNode
  label: string
  /** Optional control rendered beside the icon — the skip toggle today. */
  action?: React.ReactNode
  /** Dim the cell to match a skipped track's dimmed clips. */
  dimmed?: boolean
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

/**
 * One row of the rail. Content sits at the TOP rather than centred: rows vary
 * from 40px to 120px, and a centred icon on the tall base track floats in the
 * middle of nothing while the short rows look fine. Top-aligned, every cell
 * reads as the same control at the same place.
 */
function RailCell({ height, accent, icon, label, action, dimmed, settingsButton }: RailCellProps) {
  return (
    <div
      className={`flex items-start gap-1 rounded overflow-hidden bg-[var(--editor-surface)] border border-[var(--editor-border)] px-1 py-0.5 select-none transition-opacity ${dimmed ? 'opacity-40' : ''}`}
      style={{ height, borderLeft: accent ? `2px solid ${accent}` : undefined }}
    >
      {/* The type icon identifies the row and is NOT interactive. It used to
          double as the settings trigger, which made it impossible to tell which
          icons could be clicked — a decorative-looking glyph that happened to
          open a dialog. Settings moved to the gear beside it. */}
      <Tooltip label={label}>
        <span aria-label={label} className="flex h-4 w-4 items-center justify-center text-[var(--editor-text)]/50">
          {icon}
        </span>
      </Tooltip>
      {/* One COLUMN of controls, not a row: the rows are 40-120px tall and were
          wasting all of that height on a single line of icons, which forced the
          rail wide enough to crowd the timeline.

          The gap is a single constant across every row height, so the audio
          lane's controls and the base track's controls read as the same
          spacing rather than "cramped" vs. "spread". Content stays top-aligned,
          so the tall base track just has unused space below the stack —
          harmless — instead of gap scaling to fill it. */}
      <div className="flex min-w-0 flex-col gap-1.5">
        {action}
        {settingsButton && (
          <Tooltip label={settingsButton.label}>
            <button
              ref={settingsButton.buttonRef}
              type="button"
              aria-label={settingsButton.label}
              aria-haspopup="dialog"
              aria-expanded={settingsButton.open}
              onClick={settingsButton.onClick}
              className={`flex h-3.5 w-3.5 items-center justify-center rounded transition-colors ${
                settingsButton.open
                  ? 'text-[var(--editor-text)]/90 bg-[var(--editor-text)]/10'
                  : 'text-[var(--editor-text)]/40 hover:text-[var(--editor-text)]/90 hover:bg-[var(--editor-text)]/10'
              }`}
            >
              <Settings2 size={13} />
            </button>
          </Tooltip>
        )}
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
function MuteToggle({ muted, onToggle, trackLabel }: { muted: boolean; onToggle: () => void; trackLabel: string }) {
  return (
    <Tooltip label={muted ? `Unmute ${trackLabel}` : `Mute ${trackLabel}`}>
      <button
        type="button"
        aria-label={`Mute ${trackLabel}`}
        aria-pressed={muted}
        onClick={onToggle}
        className={`flex h-3.5 w-3.5 items-center justify-center rounded transition-colors ${
          muted
            ? 'text-amber-400/90 hover:text-amber-300'
            : 'text-[var(--editor-text)]/35 hover:text-[var(--editor-text)]/80'
        }`}
      >
        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
    </Tooltip>
  )
}

/** The per-track skip switch. Eye/EyeOff rather than a checkbox: it reads at
 *  14px and says "shown / not shown" without a word. */
function SkipToggle({ enabled, onToggle, trackLabel }: { enabled: boolean; onToggle: () => void; trackLabel: string }) {
  return (
    <Tooltip label={enabled ? `Skip ${trackLabel} track` : `Un-skip ${trackLabel} track`}>
      <button
        type="button"
        aria-label={`Skip ${trackLabel} track`}
        aria-pressed={!enabled}
        onClick={onToggle}
        className={`flex h-3.5 w-3.5 items-center justify-center rounded transition-colors ${
          enabled
            ? 'text-[var(--editor-text)]/35 hover:text-[var(--editor-text)]/80'
            : 'text-amber-400/80 hover:text-amber-300'
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
}: {
  row: VisualRowLayout
  palette: TrackPalette
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
    <div className="absolute inset-x-0" style={{ top: row.y, height: row.height }}>
      <RailCell
        height={row.height}
        accent={palette.border}
        icon={<KindIcon kind={kind} />}
        label={label}
        dimmed={!enabled}
        settingsButton={hasSettings ? { onClick: () => setOpen(o => !o), open, buttonRef, label: `${label} track settings` } : undefined}
        action={
          <>
            {/* Visibility on top — it is the control you reach for most, and the
                one whose state you scan a whole column of rows for. Mute sits
                under it so the two state toggles stay together, with the
                settings gear last. */}
            {onToggleTrackEnabled && (
              <SkipToggle
                enabled={enabled}
                trackLabel={trackLabel}
                onToggle={() => onToggleTrackEnabled(row.trackIdx, !enabled)}
              />
            )}
            {hasAudio && onSetTrackMuted && (
              <MuteToggle
                muted={muted}
                trackLabel={`${trackLabel} track`}
                onToggle={() => onSetTrackMuted(row.trackIdx, !muted)}
              />
            )}
          </>
        }
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
  onSetLaneVolume,
  onSetLaneMuted,
}: {
  lane: AudioLaneLayout
  onSetLaneVolume?: (trackIds: string[], volume: number, commit: boolean) => void
  onSetLaneMuted?: (trackIds: string[], muted: boolean) => void
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
  const trackIds = lane.tracks.map(t => t.id)

  return (
    <div className="absolute inset-x-0" style={{ top: lane.y, height: lane.height }}>
      <RailCell
        height={AUDIO_LANE_HEIGHT_PX}
        accent="rgba(16,185,129,0.6)"
        icon={<AudioLines size={15} />}
        label="Audio"
        settingsButton={hasSettings ? { onClick: () => setOpen(o => !o), open, buttonRef, label: 'Audio lane settings' } : undefined}
        action={onSetLaneMuted && (
          <MuteToggle
            muted={muted}
            trackLabel="audio lane"
            onToggle={() => onSetLaneMuted(trackIds, !muted)}
          />
        )}
      />
      {open && hasSettings && (
        <TrackSettingsPopover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          title="Audio"
          volume={volume}
          onVolumeChange={(v, commit) => onSetLaneVolume!(trackIds, v, commit)}
          volumeAriaLabel="Audio lane volume"
        />
      )}
    </div>
  )
}

export interface TrackGutterProps {
  project: Project
  /** Rendered under the track rail, aligned with the caption row. Omit when the
   *  caption row isn't shown. */
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
}

export default function TrackGutter({
  project,
  showCaptionRow = true,
  layout,
  onToggleTrackEnabled,
  onSetTrackVolume,
  onSetTrackMuted,
  onApplySpeed,
  onSetLaneVolume,
  onSetLaneMuted,
}: TrackGutterProps) {
  const resolved = layout ?? computeTimelineLayout(project)
  const tracks = trackItems(project)
  // Read `enabled`/`volume`/`muted` off the normalized tracks — `trackItems`
  // gives items only, and a legacy-shaped project has no settings at all
  // (every track enabled, unity volume, unmuted).
  const trackSettings = normalizeTracks(project).tracks ?? []

  return (
    <div className="flex shrink-0 flex-col" style={{ width: GUTTER_WIDTH_PX, gap: ROW_GAP_PX }}>
      {/* Absolute positioning mirrors the canvas' own layout pass, so a row's
          label sits at exactly the y its clips do — including the base track's
          extra height. */}
      <div className="relative" style={{ height: resolved.height }}>
        {resolved.rows.map(row => {
          const kind = visualTrackKind(tracks[row.trackIdx] ?? [])
          const palette = TRACK_PALETTE[row.trackIdx % TRACK_PALETTE.length]
          const label = kind ? KIND_LABEL[kind] ?? kind : 'Track'
          const settings = trackSettings[row.trackIdx]
          const enabled = settings?.enabled !== false
          return (
            <VisualTrackRailRow
              key={`row-${row.trackIdx}`}
              row={row}
              palette={palette}
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
            />
          )
        })}
        {resolved.lanes.map(lane => (
          <AudioLaneRailRow
            key={`lane-${lane.laneIndex}`}
            lane={lane}
            onSetLaneVolume={onSetLaneVolume}
            onSetLaneMuted={onSetLaneMuted}
          />
        ))}
      </div>

      {showCaptionRow && (
        <RailCell
          height={CAPTION_ROW_HEIGHT_PX}
          accent="rgba(168,85,247,0.6)"
          icon={<Captions size={15} />}
          label="Captions"
        />
      )}
    </div>
  )
}
