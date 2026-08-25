import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, Instagram, Music2, Slash, Youtube, type LucideIcon } from 'lucide-react'
import type { SocialPreviewPlatform } from './SocialSafeZoneOverlay'

/**
 * Platform picker for the realistic social-media preview chrome — mirrors
 * CapCut's "Preview your video for social media" menu. Opened from the
 * preview controls-row button (see VideoEditor.tsx); lists TikTok, YouTube
 * Shorts and Instagram Reels, plus a "None" entry that clears the selection.
 *
 * Positioning is the same "render once off-screen, measure, place" two-pass
 * shape `TrackSettingsPopover.tsx` uses (portaled to `document.body` for the
 * same reason: this trigger sits inside `previewRegion`'s `overflow-hidden`
 * box, which would clip an `absolute`-positioned popover the moment it grew
 * past the row's own bounds). It DEFAULTS to opening upward rather than
 * `TrackSettingsPopover`'s downward-by-default: the trigger lives in the
 * BOTTOM preview controls row, so there's rarely room below it, and this is
 * the same "icon variant opens upward" call `ImageToneMenu.tsx` makes for its
 * own bottom-toolbar placement.
 */

const OFFSET_PX = 6
const VIEWPORT_MARGIN_PX = 8

interface Position {
  left: number
  top: number
}

export interface SocialPreviewMenuProps {
  /** The controls-row button this popover is anchored to and positioned against. */
  anchorRef: RefObject<HTMLButtonElement | null>
  /** Currently selected platform. `null` = "None" is the active entry. */
  value: SocialPreviewPlatform | null
  /** Persist a new selection (or clear it, via `null`). */
  onChange: (platform: SocialPreviewPlatform | null) => void
  onClose: () => void
  /** Editor theme mode — light/dark. This popover portals onto
   *  `--editor-surface`, NOT over the black video canvas like the rest of
   *  `preview/`, so its accents have to read on a light ground: the selected
   *  checkmark's sky-400 is ~2.9:1 on white. Defaults to `'dark'`, so a caller
   *  that omits it renders exactly as before. */
  mode?: 'light' | 'dark'
}

/**
 * A platform's small identifying mark: a nominative "this is the TikTok/
 * YouTube/Instagram row" glyph, NOT a pixel-exact reproduction of the
 * official trademarked logo. `Youtube`/`Instagram` are lucide's own
 * simplified brand glyphs (already generic outline icons, not hand-traced
 * copies of the real marks); TikTok has no such lucide glyph, so it gets a
 * generic music-note icon instead, which is enough to read as "TikTok" next
 * to the plain-text label without drawing the note/logo itself.
 */
export interface PlatformOption {
  id: SocialPreviewPlatform
  label: string
  icon: LucideIcon
  /** Tailwind background for the small badge behind the glyph — a solid
   *  color for YouTube's red, a two-stop gradient standing in for TikTok's
   *  cyan/pink and Instagram's purple/pink duotone marks. */
  badgeClassName: string
}

export const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: 'tiktok', label: 'TikTok', icon: Music2, badgeClassName: 'bg-gradient-to-br from-cyan-400 to-pink-500' },
  { id: 'youtube', label: 'YouTube Shorts', icon: Youtube, badgeClassName: 'bg-red-600' },
  { id: 'instagram', label: 'Instagram Reels', icon: Instagram, badgeClassName: 'bg-gradient-to-br from-purple-500 to-pink-500' },
]

/** `PLATFORM_OPTIONS` entry for a platform, or `null` for "None"/unset — the
 *  lookup VideoEditor's trigger button uses to show the active selection's
 *  glyph (falling back to its own Smartphone icon on `null`). */
export function platformOption(platform: SocialPreviewPlatform | null): PlatformOption | null {
  return platform ? PLATFORM_OPTIONS.find(o => o.id === platform) ?? null : null
}

/** The glyph itself — a small colored badge, decorative only. The
 *  accessible name is always the platform's plain-text label (on the menu
 *  row) or the trigger's own `aria-label` — never this glyph, hence
 *  `aria-hidden`. */
export function PlatformGlyph({ icon: Icon, badgeClassName, size = 20 }: { icon: LucideIcon; badgeClassName: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={`flex items-center justify-center rounded-md shrink-0 ${badgeClassName}`}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.65)} strokeWidth={2.25} className="text-white" />
    </span>
  )
}

export default function SocialPreviewMenu({ anchorRef, value, onChange, onClose, mode = 'dark' }: SocialPreviewMenuProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)

  // Measure once the popover has a real size, then place it. Anchored from
  // the trigger's right edge (the trigger sits at the right end of the
  // controls row, alongside Zoom-to-fit/Fullscreen) so the menu's right edge
  // lines up with the button rather than running off the right edge of the
  // window. Opens upward by default (see the file-level doc comment); falls
  // back to downward only when there truly isn't room above.
  useLayoutEffect(() => {
    const anchorRect = anchorRef.current?.getBoundingClientRect()
    const popover = popoverRef.current
    if (!anchorRect || !popover) return
    const { width, height } = popover.getBoundingClientRect()

    let left = anchorRect.right - width
    if (left < VIEWPORT_MARGIN_PX) left = VIEWPORT_MARGIN_PX
    if (left + width > window.innerWidth - VIEWPORT_MARGIN_PX) {
      left = window.innerWidth - VIEWPORT_MARGIN_PX - width
    }

    const fitsAbove = anchorRect.top - OFFSET_PX - height >= VIEWPORT_MARGIN_PX
    const top = fitsAbove ? anchorRect.top - OFFSET_PX - height : anchorRect.bottom + OFFSET_PX
    setPosition({ left, top })
  }, [anchorRef])

  // Close on outside click / Escape — same shape as ImageToneMenu.tsx's,
  // extended to exclude the portaled popover itself (which isn't a DOM
  // descendant of the trigger once portaled to document.body).
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
      role="menu"
      aria-label="Preview for social media"
      className="fixed z-[100] w-64 rounded-xl border border-[var(--editor-border)] bg-[var(--editor-surface)] shadow-2xl p-2 flex flex-col gap-1"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        // Invisible until positioned: the first render has nothing measured
        // to position against yet, so it paints once off-screen for the
        // effect above to measure, then becomes visible in its real place —
        // never a visible jump.
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <p className="px-2 pt-1 pb-1.5">
        <span className="block text-[11px] font-semibold text-[var(--editor-text)]/90">Preview for social media</span>
        <span className="block text-[10px] text-[var(--editor-text)]/50">What you see may vary depending on your device.</span>
      </p>

      {PLATFORM_OPTIONS.map(opt => {
        const active = value === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            title={opt.label}
            aria-label={opt.label}
            role="menuitemradio"
            aria-checked={active}
            onClick={() => { onChange(opt.id); onClose() }}
            className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
              active
                ? 'text-[var(--editor-text)] bg-sky-400/10'
                : 'text-[var(--editor-text)]/80 hover:bg-[var(--editor-text)]/5'
            }`}
          >
            <span className="flex items-center gap-2">
              <PlatformGlyph icon={opt.icon} badgeClassName={opt.badgeClassName} />
              <span>{opt.label}</span>
            </span>
            {active && <Check size={13} className={mode === 'light' ? 'text-sky-600' : 'text-sky-400'} />}
          </button>
        )
      })}

      <div className="my-1 h-px bg-[var(--editor-border)]" />

      <button
        type="button"
        title="None"
        aria-label="None"
        role="menuitemradio"
        aria-checked={value === null}
        onClick={() => { onChange(null); onClose() }}
        className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
          value === null
            ? 'text-[var(--editor-text)] bg-sky-400/10'
            : 'text-[var(--editor-text)]/80 hover:bg-[var(--editor-text)]/5'
        }`}
      >
        <span className="flex items-center gap-2">
          <PlatformGlyph icon={Slash} badgeClassName="bg-[var(--editor-text)]/15" />
          <span>None</span>
        </span>
        {value === null && <Check size={13} className={mode === 'light' ? 'text-sky-600' : 'text-sky-400'} />}
      </button>
    </div>,
    document.body,
  )
}
