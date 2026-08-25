import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Switch } from '../../ui/switch'
import SpeedControl from './SpeedControl'
import VolumeControl from './VolumeControl'

/**
 * Track-wide settings, opened from the rail's icon button (see TrackGutter.tsx).
 *
 * Portaled to `document.body`, exactly like `Tooltip.tsx` and for the same
 * reason: the rail sits inside the timeline's `overflow-x-auto` scroll
 * container, so a popover positioned `absolute` inside its own row would be
 * clipped the moment it grew past the row's own bounds. Positioning is a
 * two-pass "render once off-screen, measure, place" — same shape Tooltip uses
 * for its horizontal clamp, extended here to both axes since this panel is
 * tall enough to run past the bottom of the viewport on a row near the end of
 * a long timeline.
 *
 * Each section is independently optional and renders only when ITS OWN
 * value+callback pair is given — the same "no dead control" rule the rail's
 * skip toggle already follows (a control wired to nothing is worse than no
 * control). In practice `Timeline.tsx` wires all of them together, but the
 * component itself doesn't assume that.
 */

/** Gap in px between the trigger's edge and the popover. */
const OFFSET_PX = 6
/** Keeps the popover from hanging off any edge of the window. */
const VIEWPORT_MARGIN_PX = 8

interface Position {
  left: number
  top: number
  /** True when there wasn't room to open downward, so the popover is anchored
   *  from its own BOTTOM edge (opens upward) instead. */
  flipped: boolean
}

export interface TrackSettingsPopoverProps {
  /** The rail button this popover is anchored to and positioned against. */
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  /** Names WHICH row this is, e.g. "Video track" / "Overlay track" / "Audio" —
   *  shown as the popover's own heading and its `aria-label`. */
  title: string
  /** Volume section — give both `volume` and `onVolumeChange` to show it. */
  volume?: number
  /** `commit: false` on every drag tick (live preview only, mirrors
   *  CaptionListPanel's fontsize slider); `commit: true` once, on
   *  release/keyup — the same preview-then-commit split every continuous
   *  timeline control uses, so a drag never produces one undo entry per
   *  pixel. */
  onVolumeChange?: (volume: number, commit: boolean) => void
  /** Distinct wording from `title` on purpose — "Mute audio lane" needs to
   *  read differently from AudioTrackRow's own per-clip "Mute"/"Unmute"
   *  button, which already exists and is a different control. */
  volumeAriaLabel?: string
  /** Mute section — give both `muted` and `onMutedChange` to show it. A mute
   *  click is a single, already-complete gesture — no preview/commit split
   *  needed, same as the rail's existing skip toggle. */
  muted?: boolean
  onMutedChange?: (muted: boolean) => void
  muteAriaLabel?: string
  /** Present only for visual tracks — audio lanes have no skip concept. When
   *  given, `onToggle` is the SAME callback the rail's inline eye icon calls;
   *  this is a second surface for it, not a second mutation path. */
  skip?: { skipped: boolean; onToggle: () => void; ariaLabel: string }
  /**
   * Speed section — give both `speed` and `onApplySpeed` to show it. Present
   * only for visual (video) tracks; speed is a video-only concept, same as
   * volume/mute above.
   *
   * Applies directly, no button: it is a track control, so touching it is the
   * intent to set the whole track. It previews into local state during a slider
   * drag and commits `onApplySpeed` on release (and immediately on a chip
   * click) — the same live-preview-then-commit split the volume fader uses,
   * just committing to every clip instead of a track-level value.
   */
  speed?: number
  /** Applies `speed` to EVERY clip on the track. Fired on slider release and on
   *  a preset-chip click (via SpeedControl's `onCommit`), not per drag tick. */
  onApplySpeed?: (speed: number) => void
}

export default function TrackSettingsPopover({
  anchorRef,
  onClose,
  title,
  volume,
  onVolumeChange,
  volumeAriaLabel,
  muted,
  onMutedChange,
  muteAriaLabel,
  skip,
  speed,
  onApplySpeed,
}: TrackSettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)

  const showVolume = volume !== undefined && !!onVolumeChange
  const showMute = muted !== undefined && !!onMutedChange
  const showSpeed = speed !== undefined && !!onApplySpeed

  // Local slider value during a drag, seeded from the committed `speed` and
  // reset whenever it changes under us — same shape as `liveVolume` below. The
  // bulk apply to every clip runs on commit (slider release / chip click) via
  // SpeedControl's `onCommit`, not on each drag tick.
  const [localSpeed, setLocalSpeed] = useState(speed ?? 1)
  useEffect(() => {
    if (speed !== undefined) setLocalSpeed(speed)
  }, [speed])

  // Live slider value during a drag — local state so a mid-drag frame doesn't
  // stutter waiting on a round trip through the project. Reset whenever the
  // committed value changes under us (e.g. undo while the popover is open).
  // Exactly CaptionListPanel's `fontsize` pattern.
  const [liveVolume, setLiveVolume] = useState(volume ?? 1)
  useEffect(() => {
    if (volume !== undefined) setLiveVolume(volume)
  }, [volume])

  // Measure once the popover has a real size, then place it. Anchored from
  // the trigger's top-left by default (NOT centered — the rail sits at the
  // left edge of the timeline pane, so centering a wider panel under a 16px
  // icon would push its left edge off-screen as often as not). Flips to open
  // upward when there isn't room below before the viewport's bottom edge;
  // only ever needs a LEFTWARD horizontal clamp, since the rail is the
  // leftmost UI element and the trigger's own left edge is always ≥ 0.
  useLayoutEffect(() => {
    const anchorRect = anchorRef.current?.getBoundingClientRect()
    const popover = popoverRef.current
    if (!anchorRect || !popover) return
    const { width, height } = popover.getBoundingClientRect()

    let left = anchorRect.left
    if (left + width > window.innerWidth - VIEWPORT_MARGIN_PX) {
      left = window.innerWidth - VIEWPORT_MARGIN_PX - width
    }

    const fitsBelow = anchorRect.bottom + OFFSET_PX + height <= window.innerHeight - VIEWPORT_MARGIN_PX
    const top = fitsBelow ? anchorRect.bottom + OFFSET_PX : anchorRect.top - OFFSET_PX
    setPosition({ left, top, flipped: !fitsBelow })
  }, [anchorRef])

  // Close on outside click / Escape — same shape as ImageToneMenu.tsx's.
  // "Outside" excludes both the trigger (a click on it is the button's own
  // toggle, handled by TrackGutter) and the popover's own portaled content.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (anchorRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={title}
      className="fixed z-[100] w-64 rounded-lg border border-[var(--editor-border)] bg-[var(--editor-surface)] shadow-2xl p-3 flex flex-col gap-3"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        // Invisible until positioned: the first render has nothing measured
        // to position against yet, so it paints once off-screen for the
        // effect above to measure, then becomes visible in its real place —
        // never a visible jump.
        visibility: position ? 'visible' : 'hidden',
        transform: position?.flipped ? 'translateY(-100%)' : undefined,
      }}
    >
      <p className="text-xs font-semibold text-[var(--editor-text)]/90">{title}</p>

      {showVolume && (
        <VolumeControl
          value={liveVolume}
          onChange={v => { setLiveVolume(v); onVolumeChange!(v, false) }}
          onCommit={v => onVolumeChange!(v, true)}
          label="Volume"
          ariaLabel={volumeAriaLabel}
          idBase="track-volume"
        />
      )}

      {showSpeed && (
        <SpeedControl
          value={localSpeed}
          onChange={setLocalSpeed}
          onCommit={onApplySpeed}
          label="Speed"
          idBase="track-speed"
        />
      )}

      {showMute && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--editor-text)]/70">Mute</span>
          <Switch checked={!!muted} onCheckedChange={onMutedChange!} aria-label={muteAriaLabel} />
        </div>
      )}

      {skip && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--editor-text)]/70">Skip</span>
          <Switch checked={skip.skipped} onCheckedChange={() => skip.onToggle()} aria-label={skip.ariaLabel} />
        </div>
      )}
    </div>,
    document.body,
  )
}
