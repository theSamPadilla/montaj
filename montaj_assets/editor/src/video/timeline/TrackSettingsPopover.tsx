import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Switch } from '../../ui/switch'

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

/** `20 * log10(v)` dB, matching `ClipInspectModal.tsx`'s (host `montaj_assets/ui`
 *  package) per-clip volume readout exactly. Copied rather than imported — the
 *  `editor` package can't reach across into a host package's `src`. */
function volumeToDb(v: number): string {
  if (v === 0) return '−∞ dB'
  return `${(20 * Math.log10(v)).toFixed(1)} dB`
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
   *  TranscriptPanel's fontsize slider); `commit: true` once, on
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
}: TrackSettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)

  const showVolume = volume !== undefined && !!onVolumeChange
  const showMute = muted !== undefined && !!onMutedChange

  // Live slider value during a drag — local state so a mid-drag frame doesn't
  // stutter waiting on a round trip through the project. Reset whenever the
  // committed value changes under us (e.g. undo while the popover is open).
  // Exactly TranscriptPanel's `fontsize` pattern.
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
        <div className="flex flex-col gap-1">
          <label className="flex items-center justify-between text-[11px] text-[var(--editor-text)]/70">
            <span>Volume</span>
            <span className="font-mono text-[10px] text-[var(--editor-text)]/50">
              {liveVolume.toFixed(2)} ({volumeToDb(liveVolume)})
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={liveVolume}
            aria-label={volumeAriaLabel}
            className="w-full accent-[var(--editor-accent)]"
            onChange={e => {
              const v = Number(e.target.value)
              setLiveVolume(v)
              onVolumeChange!(v, false)
            }}
            onPointerUp={e => onVolumeChange!(Number((e.target as HTMLInputElement).value), true)}
            onKeyUp={e => onVolumeChange!(Number((e.target as HTMLInputElement).value), true)}
          />
        </div>
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
