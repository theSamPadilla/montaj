/**
 * SP4 T6/T7 — the engine's picture surface: one canvas, the Preparing
 * placeholder for the state where there is nothing to paint yet, and the
 * debug HUD.
 *
 * It renders INSIDE `PreviewPlayer`'s existing transform container, in the
 * position the two `<video>` slots occupy on the legacy path, with the same
 * `z-index: 1` the active slot carries. The container keeps owning
 * `scale`/`offsetX`/`offsetY` in CSS (plan decision 3: transform container,
 * sourceCrop semantics, z-order and handles stay in CSS unchanged), so nothing
 * about drag, resize or the selection outline changes between the two paths.
 *
 * The canvas is deliberately style-only-sized: `engine.attach()` sets the
 * BACKING STORE to the project's design canvas and the painter re-reads
 * `canvas.width`/`height` on every paint, so the element can be stretched to
 * the frame box without touching the engine. `sourceCrop` is NOT applied here —
 * the engine reproduces `sourceCropStyle.ts`'s algebra as a `drawImage` source
 * rect (`scheduler.ts`'s `sourceCropDrawPlan`), so a second CSS crop on top
 * would double-apply it.
 *
 * ── The Preparing placeholder (T7) ──
 * Reachable ONLY for a clip that loses its proxy AFTER engine mode already
 * started for this session — a mid-session addition, or a proxy that is still
 * encoding, or one that failed to load/decode (`scheduler.ts`'s `picture ===
 * 'preparing'` branch routes all three through the same state). A project
 * that was ineligible at LOAD stays on the legacy player for the whole session
 * (plan decision 2, enforced in `PreviewPlayer.tsx`'s `useEngineMode`) and
 * never mounts this component at all — so "ineligible at load" can never reach
 * this placeholder either.
 *
 * Shown only after `PREPARING_SHOW_DELAY_MS` of SUSTAINED `preparing` — an
 * ordinary boundary swap can pass through `preparing` for a single tick while
 * the next clip's session finishes attaching (prewarm usually lands it before
 * the cut, but not always), and a placeholder that blinked on and off for one
 * frame at every such swap would read as a glitch rather than as information.
 * A proxy that is genuinely still encoding, or genuinely failed, is preparing
 * for whole seconds — comfortably past the delay either way.
 */
import { useEffect, useState } from 'react'
import type { EngineStats, Picture } from '../../engine'
import DebugHud from '../../engine/debug-hud'

/**
 * How long `picture` must stay `preparing` before the placeholder shows.
 * Short enough that a genuinely-stuck clip still reads as "preparing" almost
 * immediately; long enough that a one-tick transitional `preparing` during a
 * boundary swap never paints at all (React's effect cleanup cancels the timer
 * the instant `picture` moves on — see the effect below).
 */
const PREPARING_SHOW_DELAY_MS = 200

interface EngineSurfaceProps {
  /**
   * The hook's `attachCanvas`. Passed straight to `ref`, so it MUST be stable —
   * a fresh identity each render makes React detach (`null`) and re-attach on
   * every tick, which would unbind the engine's painter sixty times a second.
   */
  attach: (canvas: HTMLCanvasElement | null) => void
  picture: Picture
  /** Why the picture is `preparing`, when it is. Shown as a hover title only — some reasons (decode error text, the src-precedence message) are not end-user copy. */
  reason?: string
  /** `engine.debugHud`, threaded from `PreviewPlayer`'s `engine` prop. Absent/false: no HUD, no polling. */
  debugHud?: boolean
  /** The hook's `getStats`. Read by the HUD on its own timer; unused when `debugHud` is falsy. */
  getStats: () => EngineStats | null
}

export default function EngineSurface({ attach, picture, reason, debugHud, getStats }: EngineSurfaceProps) {
  const [showPreparing, setShowPreparing] = useState(false)

  useEffect(() => {
    if (picture !== 'preparing') {
      setShowPreparing(false)
      return
    }
    const timer = setTimeout(() => setShowPreparing(true), PREPARING_SHOW_DELAY_MS)
    // Cleanup fires the instant `picture` changes away from `preparing` (or on
    // unmount) — a swap that resolves inside the delay window never shows.
    return () => clearTimeout(timer)
  }, [picture])

  return (
    <>
      <canvas
        ref={attach}
        data-montaj-engine-canvas=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 1 }}
      />
      {showPreparing && (
        <div
          className="montaj-engine-preparing absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80"
          style={{ zIndex: 2 }}
          title={reason}
        >
          <span
            className="h-6 w-6 rounded-full border-2 border-white/30 border-t-white/80 animate-spin"
            aria-hidden="true"
          />
          <span className="text-sm">Preparing preview…</span>
        </div>
      )}
      {debugHud && <DebugHud getStats={getStats} />}
    </>
  )
}
