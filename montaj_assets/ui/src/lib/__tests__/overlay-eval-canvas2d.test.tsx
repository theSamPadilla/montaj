// Exercises `useCanvas2DFrame` through the ACTUAL preview compilation path
// (compileOverlay), not a hand-rolled stand-in. This matters because
// overlay-eval.ts's own file comment states overlays "must not use React
// hooks ... because the component function is called directly, not through
// React's reconciler" — the compiled factory is called as `__Component({...})`
// inside another component's render, not mounted via `React.createElement`.
// useThreeFrame sidesteps this by only ever running inside a `<FrameBridge/>`
// child that IS mounted through r3f's own reconciler (skills/write-overlay's
// mandated pattern). useCanvas2DFrame takes a different approach — it returns
// a REF CALLBACK, not a hook that calls useRef/useLayoutEffect at the
// compiled function's top level — specifically so it's safe to call directly
// in that same "raw function call" position. This test proves it: it mounts
// a real <OverlayHost> component (mirroring OverlaysPage.tsx's
// `OverlayPreview`) that calls `factory(frame, ...)` on every one of ITS OWN
// re-renders, across many frames, and asserts no React hook-order error is
// thrown and the canvas draw call receives the correct frame every time.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useState } from 'react'
import { compileOverlay, clearOverlayCache, type OverlayFactory } from '@/lib/overlay-eval'

const OVERLAY_PATH = '/api/files?path=%2Ftmp%2Fcanvas2d-eval-test.jsx'

const OVERLAY_SOURCE = `
export default function Canvas2DEvalTest() {
  const draw = (ctx, { frame, fps, duration }) => {
    ctx.fillRect(0, 0, 10, 10)
    window.__draws.push({ frame, fps, duration })
  }
  const ref = useCanvas2DFrame(draw, frame, fps, duration)
  return <canvas ref={ref} width={10} height={10} />
}
`

let realGetContext: typeof HTMLCanvasElement.prototype.getContext

beforeEach(() => {
  ;(globalThis as unknown as { __draws: unknown[] }).__draws = []
  realGetContext = HTMLCanvasElement.prototype.getContext
  // Minimal stand-in 2D context — the draw calls in this fixture only need
  // fillRect to exist, matching the no-op-context convention used elsewhere
  // in this package's canvas tests (EditorPage.manualStart.test.tsx).
  HTMLCanvasElement.prototype.getContext = function (kind: string) {
    if (kind !== '2d') return null
    return { fillRect: () => {} } as unknown as CanvasRenderingContext2D
  } as typeof HTMLCanvasElement.prototype.getContext

  global.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => OVERLAY_SOURCE,
  })) as unknown as typeof fetch
})

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext
  clearOverlayCache(OVERLAY_PATH)
  vi.restoreAllMocks()
})

// Mirrors OverlaysPage.tsx's OverlayPreview: calls `factory(frame, fps,
// duration, props)` directly inside ITS OWN render, driven by frame state
// that changes on every re-render — the exact shape that would surface a
// hook-order violation if useCanvas2DFrame used useRef/useLayoutEffect
// internally instead of a ref callback.
function OverlayHost({ factory, frame }: { factory: OverlayFactory; frame: number }) {
  let element: React.ReactElement | null = null
  try {
    element = factory(frame, 30, 90, {})
  } catch (err) {
    ;(globalThis as unknown as { __hostError: unknown }).__hostError = err
  }
  return <div data-testid="host">{element}</div>
}

describe('useCanvas2DFrame through the real preview compilation path', () => {
  test('draws on every frame across many re-renders with no hook-order error', async () => {
    ;(globalThis as unknown as { __hostError: unknown }).__hostError = undefined
    const factory = await compileOverlay(OVERLAY_PATH)

    function Wrapper() {
      const [frame, setFrame] = useState(0)
      ;(globalThis as unknown as { __setFrame: (f: number) => void }).__setFrame = setFrame
      return <OverlayHost factory={factory} frame={frame} />
    }

    render(<Wrapper />)

    const bump = (globalThis as unknown as { __setFrame: (f: number) => void }).__setFrame
    // Re-render across a run of frames — a hook-order mismatch (the failure
    // mode useRef/useLayoutEffect would risk here) would throw synchronously
    // on one of these renders.
    for (let f = 1; f <= 20; f++) {
      act(() => { bump(f) })
    }

    expect((globalThis as unknown as { __hostError: unknown }).__hostError).toBeUndefined()

    const draws = (globalThis as unknown as { __draws: Array<{ frame: number; fps: number; duration: number }> }).__draws
    // Frame 0 (initial mount) + frames 1..20 = 21 draws, each with the exact
    // frame/fps/duration in scope at that render — proves the ref callback
    // re-fires every frame rather than only on mount.
    expect(draws.length).toBe(21)
    expect(draws.map((d) => d.frame)).toEqual(Array.from({ length: 21 }, (_, i) => i))
    for (const d of draws) {
      expect(d.fps).toBe(30)
      expect(d.duration).toBe(90)
    }
  })
})
