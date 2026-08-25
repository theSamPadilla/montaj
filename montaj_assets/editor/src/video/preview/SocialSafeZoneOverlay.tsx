/**
 * SocialSafeZoneOverlay — a preview-only viewing aid that draws a REALISTIC
 * mock of a target social platform's in-app chrome (status bar, top nav,
 * engagement rail, caption/credit block, and the app's own bottom tab bar /
 * add-comment bar) semi-transparently over the video preview, so
 * the operator can see roughly what the app's own UI will sit on top of their
 * content once posted. Mirrors CapCut's "Preview your video for social media"
 * picker — TikTok, YouTube Shorts and Instagram Reels, each with its own
 * layout, chosen from `SocialPreviewMenu` (see that file and its trigger in
 * VideoEditor.tsx).
 *
 * Every label/count is GENERIC placeholder content ("Your name", "2.8M",
 * "Music name", …) — this never reads real project/account data, and no
 * platform wordmark or logo is drawn (icons only), so it can't be mistaken
 * for the real app chrome or a real creator's stats.
 *
 * Display-only: this never touches the project, never affects render output,
 * and renders nothing when `platform` is absent/unrecognized. It is purely
 * an editor viewing aid — mounted unconditionally by `PreviewPlayer` (its
 * `socialPreview` prop), a no-op whenever the host doesn't pass a platform.
 *
 * Scaling
 * -------
 * The chrome is authored in a fixed 1080×1920 design canvas (matching the
 * RENDER_W/RENDER_H convention CaptionPreview.tsx and OverlayItemsLayer.tsx
 * use for preview-space UI) and scaled to the actual on-screen box via a
 * ResizeObserver-computed factor applied as a CSS `transform: scale()` — the
 * established pattern for scaling fixed-design-px preview chrome with its
 * container in this codebase, followed here rather than reinvented.
 *
 * One deliberate deviation from that pattern: CaptionPreview/OverlayItemsLayer
 * scale by width alone, because their design canvas is always driven by the
 * SAME resolution as the container they fill — the two aspect ratios can
 * never disagree. This chrome's 1080×1920 canvas is a fixed 9:16 assumption
 * that holds regardless of the project's actual aspect ratio, so a
 * landscape/square preview box must contain-fit (`Math.min` of the two
 * axis ratios) rather than overflow — see the vertical-video constraint
 * below. The scaled canvas is centered in its parent (not pinned top-left)
 * so any leftover space is distributed evenly on both sides.
 *
 * Vertical-video assumption
 * --------------------------
 * This chrome is designed for 9:16. A non-vertical preview box does not
 * break or overflow it — contain-fit just letterboxes/pillarboxes the
 * scaled canvas within the box — but no attempt is made to relayout the
 * chrome to look "correct" for landscape.
 *
 * Legibility
 * ----------
 * Every platform's chrome wraps its content in a single `filter:
 * drop-shadow(...)` div rather than a per-element shadow: a `drop-shadow`
 * filter shadows the alpha silhouette of its whole subtree as one pass, which
 * for a scattering of separate icons/text glyphs reads identically to a
 * per-element shadow (each disjoint shape gets its own shadow copy in place)
 * for a fraction of the styling. `SHADOW_FILTER` chains two such shadows (a
 * tight dark one plus a softer wider one) for a bolder, more "burned-in"
 * look than a single soft blur gives.
 *
 * Icon/text opacity is pushed close to full white (mostly /90–/95, key
 * numbers and names at full white) and every element is sized well above
 * what a literal safe-zone guide needs — both deliberate: this has to read
 * clearly at the NORMAL (non-fullscreen) preview size, not just zoomed in or
 * fullscreened, and a translucent, small-print guide reads as "nothing
 * happened" against real footage rather than as platform UI.
 */

import { useEffect, useRef, useState } from 'react'
import {
  BatteryFull,
  Bookmark,
  Camera,
  ChevronLeft,
  Clapperboard,
  Heart,
  Home,
  Inbox,
  MessageCircle,
  MoreHorizontal,
  MoreVertical,
  Music,
  Play,
  Plus,
  Repeat2,
  Search,
  Send,
  Share,
  Share2,
  Signal,
  ThumbsDown,
  ThumbsUp,
  User,
  Users,
  Wifi,
  type LucideIcon,
} from 'lucide-react'

/** Platforms with an implemented chrome. */
export type SocialPreviewPlatform = 'tiktok' | 'youtube' | 'instagram'

export interface SocialSafeZoneOverlayProps {
  /**
   * Which platform's chrome to draw. Any value that isn't a key of
   * `PLATFORM_CHROME` below — including `undefined`, `null`, or an
   * unrecognized string — renders nothing. Typed loosely (not just the
   * `SocialPreviewPlatform` union) so an unknown value is a safe no-op
   * rather than a type error at call sites that pass a dynamic value.
   */
  platform?: SocialPreviewPlatform | string | null
}

// Design canvas the chrome is authored against — see the file-level doc
// comment for why this is fixed rather than sourced from the project's
// actual render resolution.
const DESIGN_W = 1080
const DESIGN_H = 1920

/**
 * Applied once, to the whole chrome subtree — see the "Legibility" doc above.
 * Two layered shadows (CSS `filter` chains multiple `drop-shadow()`s): a
 * tight, dark contact shadow that reads as a hard edge against bright
 * footage, plus a softer, larger ambient shadow that keeps legibility over
 * busier/noisier footage — closer to how real burned-in platform UI text
 * is rendered than a single soft blur.
 */
const SHADOW_FILTER = 'drop-shadow(0 1px 2px rgba(0,0,0,0.85)) drop-shadow(0 4px 10px rgba(0,0,0,0.6))'

/** One platform's chrome, as a data entry — adding another platform is
 *  adding a render function here, not restructuring this component. */
const PLATFORM_CHROME: Partial<Record<string, typeof TikTokChrome>> = {
  tiktok: TikTokChrome,
  youtube: YouTubeShortsChrome,
  instagram: InstagramReelsChrome,
}

export default function SocialSafeZoneOverlay({ platform }: SocialSafeZoneOverlayProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number | null>(null)

  // Re-measure whenever the preview box resizes — pane drags, fullscreen
  // toggles, window resizes. See the file-level doc comment for why this is
  // a contain-fit (`Math.min`) rather than CaptionPreview's plain width ratio.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setScale(Math.min(width / DESIGN_W, height / DESIGN_H))
    })
    obs.observe(el)
    return () => obs.disconnect()
    // Keyed on `platform`, not `[]`: the observed `wrapRef` div only exists
    // while a recognized platform is active (the `!renderChrome` early-return
    // below unmounts it otherwise). Tying the observer's lifecycle to
    // `platform` re-attaches it the instant the chrome mounts — without this,
    // switching from "None" to a platform mounts the div but never re-runs
    // this effect, so `scale` stays null and the chrome never paints until a
    // full reload remounts the component with the platform already set.
  }, [platform])

  const renderChrome = platform ? PLATFORM_CHROME[platform] : undefined
  if (!renderChrome) return null

  return (
    <div
      ref={wrapRef}
      data-testid="social-safe-zone-overlay"
      className="absolute inset-0 pointer-events-none overflow-hidden"
      // z 48. This component is mounted by PreviewPlayer's `PreviewSurface`
      // (video path) or directly by `PreviewPlayer` (carousel path) as a
      // SIBLING of the video/overlay/caption layers, inside the same
      // `isolation: isolate` container — see the `socialPreview` prop doc and
      // its render site in preview/PreviewPlayer.tsx. That placement is load-
      // bearing: z-index only orders siblings within the SAME stacking
      // context, so mounting this anywhere else (e.g. as a sibling of
      // `PreviewPlayer` itself, outside its isolated container) makes this
      // z-index compare against that whole container's z-index instead —
      // which is `auto`, so a positive value here would paint above the
      // ENTIRE player, play button included, no matter what it's set to.
      //
      // Within this container, 48 sits above the video (z 1), the
      // play-toggle click layer (z 10), the base-video transform handles
      // (z 11), overlay items (z ~12–20) and captions (z 45) — a viewing aid
      // over the fully-composited frame has to sit above everything that
      // composites into the picture, or it wouldn't show what actually gets
      // covered. It sits below the paused play glyph (z 100), which is
      // editor chrome, not content, and must stay legible on top of a
      // chrome preview that is itself just a viewing aid.
      style={{ zIndex: 48 }}
    >
      {scale !== null && (
        <div
          data-testid="social-safe-zone-canvas"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: DESIGN_W,
            height: DESIGN_H,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        >
          {renderChrome()}
        </div>
      )}
    </div>
  )
}

// ── Shared pieces ────────────────────────────────────────────────────────

/** Phone status bar — identical across all three platforms. Sized and
 *  opacity'd to read as burned-in UI, not a faint guide — see the file-level
 *  "Legibility" doc comment. */
function StatusBar() {
  return (
    <div
      className="absolute flex items-center justify-between text-white/95"
      style={{ top: 44, left: 48, right: 48, fontSize: 42, fontWeight: 700 }}
    >
      <span>9:41</span>
      <div className="flex items-center" style={{ gap: 20 }}>
        <Signal size={38} strokeWidth={2.5} />
        <Wifi size={38} strokeWidth={2.5} />
        <BatteryFull size={42} strokeWidth={2.5} />
      </div>
    </div>
  )
}

/** One engagement-rail entry — an icon stacked over its (generic) count. */
function RailAction({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex flex-col items-center" style={{ gap: 8 }}>
      <Icon size={74} strokeWidth={2.25} className="text-white/95" />
      <span className="text-white/95" style={{ fontSize: 32, fontWeight: 700 }}>{label}</span>
    </div>
  )
}

/** App bottom tab bar — evenly spaced icon-over-label tabs pinned to the very
 *  bottom of the frame, the way TikTok and YouTube Shorts both draw their app
 *  nav. It belongs in a "what covers my content" aid precisely because it
 *  occupies the bottom strip a caption placed too low would collide with. The
 *  middle "create" tab is a filled white chip with no label, matching how both
 *  apps draw their + button. */
function BottomNav({ tabs }: { tabs: { icon: LucideIcon; label?: string; create?: boolean }[] }) {
  return (
    <div className="absolute flex items-end justify-between" style={{ left: 44, right: 44, bottom: 28 }}>
      {tabs.map((t, i) => (
        <div key={i} className="flex flex-col items-center" style={{ gap: 7 }}>
          {t.create ? (
            <div className="flex items-center justify-center rounded-xl bg-white/95" style={{ width: 78, height: 54 }}>
              <t.icon size={38} strokeWidth={3} className="text-black" />
            </div>
          ) : (
            <t.icon size={46} strokeWidth={2.25} className="text-white/95" />
          )}
          {t.label && <span className="text-white/90" style={{ fontSize: 25, fontWeight: 600 }}>{t.label}</span>}
        </div>
      ))}
    </div>
  )
}

// ── TikTok chrome ────────────────────────────────────────────────────────

function TikTokChrome() {
  return (
    <div className="absolute inset-0" style={{ filter: SHADOW_FILTER }}>
      <StatusBar />

      {/* Nav row — Following / For You (active), search at the far right */}
      <div
        className="absolute flex items-center justify-center text-white/85"
        style={{ top: 150, left: 48, right: 48, fontSize: 42, fontWeight: 700, gap: 64 }}
      >
        <span>Following</span>
        <span className="relative text-white">
          For You
          <span
            className="absolute bg-white"
            style={{ left: 0, right: 0, bottom: -16, height: 5, borderRadius: 2 }}
          />
        </span>
      </div>
      <Search size={40} strokeWidth={2.5} className="absolute text-white/90" style={{ top: 138, right: 48 }} />

      {/* Right rail — avatar (+ follow badge), engagement counts, sound disc */}
      <div className="absolute flex flex-col items-center" style={{ right: 40, top: 800, gap: 52 }}>
        <div className="relative">
          <div
            className="rounded-full border-2 border-white/90 bg-white/30 flex items-center justify-center"
            style={{ width: 132, height: 132 }}
          >
            <User size={70} strokeWidth={2.25} className="text-white/95" />
          </div>
          <div
            className="absolute rounded-full bg-rose-500 flex items-center justify-center"
            style={{ width: 44, height: 44, left: '50%', bottom: -16, transform: 'translateX(-50%)' }}
          >
            <Plus size={26} strokeWidth={3} className="text-white" />
          </div>
        </div>
        <RailAction icon={Heart} label="2.8M" />
        <RailAction icon={MessageCircle} label="2.8M" />
        <RailAction icon={Bookmark} label="2.8M" />
        <RailAction icon={Share} label="2.8M" />
        <div
          className="rounded-full border border-white/85 bg-white/25 flex items-center justify-center animate-spin"
          style={{ width: 100, height: 100, animationDuration: '3s' }}
        >
          <Music size={46} strokeWidth={2.25} className="text-white/95" />
        </div>
      </div>

      {/* Bottom-left — @handle, caption, music-note credit */}
      <div className="absolute text-white/95" style={{ left: 48, right: 300, bottom: 170 }}>
        <div style={{ fontSize: 50, fontWeight: 700 }}>@Your name</div>
        <div className="text-white/90" style={{ fontSize: 38, marginTop: 20 }}>
          Here are some descriptions about videos
        </div>
        <div className="flex items-center text-white/85" style={{ fontSize: 34, marginTop: 16, gap: 14 }}>
          <Music size={30} strokeWidth={2.25} />
          <span>Music name</span>
        </div>
      </div>

      {/* Bottom app nav — Home / Friends / create / Inbox / Profile */}
      <BottomNav
        tabs={[
          { icon: Home, label: 'Home' },
          { icon: Users, label: 'Friends' },
          { icon: Plus, create: true },
          { icon: Inbox, label: 'Inbox' },
          { icon: User, label: 'Profile' },
        ]}
      />
    </div>
  )
}

// ── YouTube Shorts chrome ────────────────────────────────────────────────

function YouTubeShortsChrome() {
  return (
    <div className="absolute inset-0" style={{ filter: SHADOW_FILTER }}>
      <StatusBar />

      {/* Top-left — back */}
      <ChevronLeft size={48} strokeWidth={2.5} className="absolute text-white/90" style={{ top: 132, left: 40 }} />

      {/* Top-right — search, more (kebab) */}
      <div className="absolute flex items-center text-white/90" style={{ top: 138, right: 48, gap: 36 }}>
        <Search size={40} strokeWidth={2.5} />
        <MoreVertical size={40} strokeWidth={2.5} />
      </div>

      {/* Right rail — thumbs up/down, comments, share, remix, sound thumbnail */}
      <div className="absolute flex flex-col items-center" style={{ right: 40, top: 760, gap: 52 }}>
        <RailAction icon={ThumbsUp} label="2.8M" />
        <ThumbsDown size={74} strokeWidth={2.25} className="text-white/95" />
        <RailAction icon={MessageCircle} label="2.8M" />
        <Share2 size={74} strokeWidth={2.25} className="text-white/95" />
        <Repeat2 size={74} strokeWidth={2.25} className="text-white/95" />
        <div
          className="rounded-lg border border-white/85 bg-white/25 flex items-center justify-center"
          style={{ width: 90, height: 90 }}
        >
          <Music size={42} strokeWidth={2.25} className="text-white/95" />
        </div>
      </div>

      {/* Bottom-left — channel avatar, @channel, Subscribe pill, title line */}
      <div className="absolute text-white/95" style={{ left: 48, right: 300, bottom: 170 }}>
        <div className="flex items-center" style={{ gap: 22 }}>
          <div
            className="rounded-full border-2 border-white/90 bg-white/30 flex items-center justify-center shrink-0"
            style={{ width: 96, height: 96 }}
          >
            <User size={54} strokeWidth={2.25} className="text-white/95" />
          </div>
          <span style={{ fontSize: 46, fontWeight: 700 }}>@channel</span>
          <span
            className="rounded-full bg-white text-black"
            style={{ fontSize: 34, fontWeight: 700, padding: '10px 30px' }}
          >
            Subscribe
          </span>
        </div>
        <div className="text-white/90" style={{ fontSize: 38, marginTop: 22 }}>
          Here are some descriptions about videos
        </div>
      </div>

      {/* Bottom app nav — Home / Shorts / create / Subscriptions / You */}
      <BottomNav
        tabs={[
          { icon: Home, label: 'Home' },
          { icon: Play, label: 'Shorts' },
          { icon: Plus, create: true },
          { icon: Clapperboard, label: 'Subscriptions' },
          { icon: User, label: 'You' },
        ]}
      />
    </div>
  )
}

// ── Instagram Reels chrome ───────────────────────────────────────────────

function InstagramReelsChrome() {
  return (
    <div className="absolute inset-0" style={{ filter: SHADOW_FILTER }}>
      <StatusBar />

      {/* Top row — Reels title (left), camera (right) */}
      <div
        className="absolute flex items-center justify-between text-white/95"
        style={{ top: 136, left: 48, right: 48, fontSize: 48, fontWeight: 700 }}
      >
        <span>Reels</span>
        <Camera size={42} strokeWidth={2.5} className="text-white/90" />
      </div>

      {/* Right rail — likes, comments, reshare, send, more, audio thumbnail */}
      <div className="absolute flex flex-col items-center" style={{ right: 40, top: 800, gap: 52 }}>
        <RailAction icon={Heart} label="2.8M" />
        <RailAction icon={MessageCircle} label="2.8M" />
        <RailAction icon={Repeat2} label="2.8M" />
        <RailAction icon={Send} label="2.8M" />
        <MoreHorizontal size={74} strokeWidth={2.25} className="text-white/95" />
        <div
          className="rounded-lg border border-white/85 bg-white/25 flex items-center justify-center"
          style={{ width: 90, height: 90 }}
        >
          <Music size={42} strokeWidth={2.25} className="text-white/95" />
        </div>
      </div>

      {/* Bottom-left — avatar, username, Follow pill, caption, audio credit */}
      <div className="absolute text-white/95" style={{ left: 48, right: 300, bottom: 170 }}>
        <div className="flex items-center" style={{ gap: 22 }}>
          <div
            className="rounded-full border-2 border-white/90 bg-white/30 flex items-center justify-center shrink-0"
            style={{ width: 90, height: 90 }}
          >
            <User size={50} strokeWidth={2.25} className="text-white/95" />
          </div>
          <span style={{ fontSize: 46, fontWeight: 700 }}>Your name</span>
          <span
            className="rounded-full border border-white/85 text-white"
            style={{ fontSize: 32, fontWeight: 700, padding: '8px 26px' }}
          >
            Follow
          </span>
        </div>
        <div className="text-white/90" style={{ fontSize: 38, marginTop: 22 }}>
          Here are some descriptions about videos
        </div>
        <div className="flex items-center text-white/85" style={{ fontSize: 34, marginTop: 16, gap: 14 }}>
          <Music size={30} strokeWidth={2.25} />
          <span>Music name</span>
        </div>
      </div>

      {/* Bottom — add-comment bar + save */}
      <div className="absolute flex items-center" style={{ left: 44, right: 44, bottom: 34, gap: 22 }}>
        <div
          className="flex-1 flex items-center rounded-full border border-white/40 bg-white/10 text-white/80"
          style={{ height: 84, paddingLeft: 40, fontSize: 34 }}
        >
          Add comment...
        </div>
        <Bookmark size={60} strokeWidth={2.25} className="text-white/95" />
      </div>
    </div>
  )
}
