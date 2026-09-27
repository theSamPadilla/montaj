// Exercises `springStep` and `springSum` through the ACTUAL preview
// compilation path (compileOverlay), not a hand-rolled stand-in. Modelled on
// overlay-eval-canvas2d.test.tsx (same fetch stub and clearOverlayCache
// teardown pattern).
//
// This is the preview-parity proof: overlay-eval.ts's compileOverlay injects
// globals as parameters of `new Function(...globalNames, body)`
// (montaj_assets/ui/src/lib/overlay-eval.ts), a different mechanism from
// render's `window` assignment (montaj_assets/render/bundle.js). Both read
// from the same `makeOverlayGlobals()` (montaj_assets/overlay-runtime/index.js),
// so an overlay that calls `springStep`/`springSum` as bare globals here must
// resolve to the exact same values `springStep`/`springSum` produce when
// imported directly from `montaj-overlay-runtime`, proving the preview
// resolved the real global and not something else.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { compileOverlay, clearOverlayCache } from '@/lib/overlay-eval'
import { springStep, springSum } from 'montaj-overlay-runtime'

const OVERLAY_PATH = '/api/files?path=%2Ftmp%2Fsprings-eval-test.jsx'

const OVERLAY_SOURCE = `
export default function SpringsEvalTest() {
  const x = springStep(frame, fps, { from: 10, to: 200, at: 5, stiffness: 300, damping: 20 })
  const y = springSum({
    frame,
    fps,
    changes: [
      { at: 0, to: 100 },
      { at: 30, to: 50 },
    ],
    stiffness: 300,
    damping: 20,
  })
  return <div data-testid="spring-box" style={{ left: \`\${x}px\`, top: \`\${y}px\` }} />
}
`

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => OVERLAY_SOURCE,
  })) as unknown as typeof fetch
})

afterEach(() => {
  clearOverlayCache(OVERLAY_PATH)
  vi.restoreAllMocks()
})

describe('springStep and springSum through the real preview compilation path', () => {
  test('resolves both as bare globals, matching the runtime import, at an integer and a fractional frame', async () => {
    const fps = 30
    const factory = await compileOverlay(OVERLAY_PATH)

    const cases: Array<{ frame: number }> = [
      { frame: 20 },     // integer frame, mid-response to springStep's single change
      { frame: 45.5 },   // fractional frame, after both springSum changes have fired
    ]

    for (const { frame } of cases) {
      const element = factory(frame, fps, 90, {})
      expect(element).not.toBeNull()
      const { getByTestId, unmount } = render(element!)
      const box = getByTestId('spring-box')

      const expectedX = springStep(frame, fps, { from: 10, to: 200, at: 5, stiffness: 300, damping: 20 })
      const expectedY = springSum({
        frame,
        fps,
        changes: [
          { at: 0, to: 100 },
          { at: 30, to: 50 },
        ],
        stiffness: 300,
        damping: 20,
      })

      expect(box.style.left).toBe(`${expectedX}px`)
      expect(box.style.top).toBe(`${expectedY}px`)

      unmount()
    }
  })
})
