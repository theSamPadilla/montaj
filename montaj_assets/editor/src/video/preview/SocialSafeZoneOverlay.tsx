/**
 * SocialSafeZoneOverlay — a preview-only viewing aid that draws a target
 * social platform's UI chrome (status bar, nav, engagement rail, caption
 * area) semi-transparently over the video preview, so the operator can see
 * what platform UI will sit on top of their content. Mirrors CapCut's
 * "TikTok" preview toggle.
 *
 * Display-only: this never touches the project, never affects render output,
 * and renders nothing when `platform` is absent/unrecognized. It is purely
 * an editor viewing aid — mounted unconditionally by `PreviewPlayer` (its
 * `safeZone` prop), a no-op whenever the host doesn't pass a platform.
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
 */

import { useEffect, useRef, useState } from 'react'
import { Bookmark, Heart, MessageCircle, Music, Search, Share2, Signal, User, Wifi, BatteryFull } from 'lucide-react'

/** Platforms with an implemented chrome. Currently only `'tiktok'`. */
export type SocialSafeZonePlatform = 'tiktok'

export interface SocialSafeZoneOverlayProps {
  /**
   * Which platform's chrome to draw. Any value that isn't a key of
   * `PLATFORM_CHROME` below — including `undefined`, `null`, or an
   * unrecognized string — renders nothing. Typed loosely (not just the
   * `SocialSafeZonePlatform` union) so an unknown value is a safe no-op
   * rather than a type error at call sites that pass a dynamic value.
   */
  platform?: SocialSafeZonePlatform | string | null
}

// Design canvas the chrome is authored against — see the file-level doc
// comment for why this is fixed rather than sourced from the project's
// actual render resolution.
const DESIGN_W = 1080
const DESIGN_H = 1920

/** One platform's chrome, as a data entry — adding Reels/Shorts is adding a
 *  render function here, not restructuring this component. */
const PLATFORM_CHROME: Partial<Record<string, typeof TikTokChrome>> = {
  tiktok: TikTokChrome,
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
  }, [])

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
      // `isolation: isolate` container — see the `safeZone` prop doc and its
      // render site in preview/PreviewPlayer.tsx. That placement is load-
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

// ── TikTok chrome ────────────────────────────────────────────────────────

function RailAction({ icon: Icon, label }: { icon: typeof Heart; label: string }) {
  return (
    <div className="flex flex-col items-center" style={{ gap: 6 }}>
      <Icon size={54} strokeWidth={2} className="text-white/85" />
      <span className="text-white/80" style={{ fontSize: 24, fontWeight: 600 }}>{label}</span>
    </div>
  )
}

function TikTokChrome() {
  return (
    <>
      {/* Status bar */}
      <div
        className="absolute flex items-center justify-between text-white/75"
        style={{ top: 36, left: 40, right: 40, fontSize: 30, fontWeight: 600 }}
      >
        <span>9:41</span>
        <div className="flex items-center" style={{ gap: 14 }}>
          <Signal size={28} strokeWidth={2.25} />
          <Wifi size={28} strokeWidth={2.25} />
          <BatteryFull size={30} strokeWidth={2.25} />
        </div>
      </div>

      {/* Nav row — Explore / Following / For You (active) / search */}
      <div
        className="absolute flex items-center justify-center text-white/60"
        style={{ top: 122, left: 40, right: 40, fontSize: 30, fontWeight: 600, gap: 48 }}
      >
        <span>Explore</span>
        <span>Following</span>
        <span className="relative text-white/95">
          For You
          <span
            className="absolute bg-white/95"
            style={{ left: 0, right: 0, bottom: -12, height: 4, borderRadius: 2 }}
          />
        </span>
        <Search size={28} strokeWidth={2.25} className="text-white/70" style={{ marginLeft: 20 }} />
      </div>

      {/* Right rail — avatar, engagement counts, sound disc */}
      <div className="absolute flex flex-col items-center" style={{ right: 36, top: 1060, gap: 40 }}>
        <div
          className="rounded-full border-2 border-white/85 bg-white/25 flex items-center justify-center"
          style={{ width: 96, height: 96 }}
        >
          <User size={52} strokeWidth={2} className="text-white/90" />
        </div>
        <RailAction icon={Heart} label="2.8M" />
        <RailAction icon={MessageCircle} label="2.8M" />
        <RailAction icon={Bookmark} label="2.8M" />
        <RailAction icon={Share2} label="2.8M" />
        <div
          className="rounded-full border border-white/70 bg-white/20 flex items-center justify-center"
          style={{ width: 72, height: 72 }}
        >
          <Music size={34} strokeWidth={2} className="text-white/85" />
        </div>
      </div>

      {/* Bottom-left — name, description, original-audio credit */}
      <div className="absolute text-white/85" style={{ left: 40, right: 260, bottom: 140 }}>
        <div style={{ fontSize: 36, fontWeight: 700 }}>Your name</div>
        <div className="text-white/70" style={{ fontSize: 28, marginTop: 14 }}>
          Here are some descriptions about videos
        </div>
        <div className="text-white/60" style={{ fontSize: 26, marginTop: 10 }}>
          See original
        </div>
      </div>
    </>
  )
}
