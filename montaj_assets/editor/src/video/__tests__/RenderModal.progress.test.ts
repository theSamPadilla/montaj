/// <reference types="vite/client" />
/**
 * `parseLogProgress` — the SSE/log-transport render progress estimate. It must
 * track TOTAL work (the per-segment counters of the two heavy phases), not just
 * leap on phase mentions. These pin the behaviour the LOG_STAGES re-weighting
 * fixed: composition shows real per-segment progress, and no early heading
 * jumps the bar to near-full.
 */
import { describe, it, expect } from 'vitest'
import { parseLogProgress } from '../RenderModal'

describe('parseLogProgress', () => {
  it('is null before any line lands (indeterminate bar)', () => {
    expect(parseLogProgress([])).toBeNull()
  })

  it('climbs through overlay assembly via "bundling segment i/N"', () => {
    const p = parseLogProgress(['normalized a.mov → a.mp4', 'bundling segment 3/6 (ov-x)...'])!
    // overlay stage: base 0.04 + span 0.42 * (3/6) ≈ 0.25
    expect(p).toBeGreaterThan(0.2)
    expect(p).toBeLessThan(0.35)
  })

  it('composition "segment i/N" refines the COMPOSITION span (the bug fix)', () => {
    // Before: compose.js "[montaj compose] segment i/N" was captured by the
    // overlay stage (bare /segment/) and capped below the composition base, so
    // the bar sat at ~0.5 through the whole composition. Now it climbs.
    const early = parseLogProgress(['composing final video...', '[montaj compose] segment 2/30 (0.1-0.2s): 1 item(s)'])!
    const late = parseLogProgress(['composing final video...', '[montaj compose] segment 27/30 (5.0-5.1s): 1 item(s)'])!
    expect(early).toBeGreaterThan(0.48)  // past the composition base, not stuck on it
    expect(late).toBeGreaterThan(early)  // and it advances with the counter
    expect(late).toBeGreaterThan(0.8)    // deep into the composition span
  })

  it('does not leap to near-full on an early phase mention, and never walks backward', () => {
    const p = parseLogProgress(['rendering 30 segment(s) with Puppeteer...', 'bundling segment 1/30 (a)...'])!
    expect(p).toBeLessThan(0.2)  // still early — the old table leapt to 0.98 on "Assembling…"
    // monotonic: a later composition line only ever increases the estimate
    const before = parseLogProgress(['composing final video...', '[montaj compose] segment 5/30 (x): 1 item(s)'])!
    const after = parseLogProgress(['composing final video...', '[montaj compose] segment 5/30 (x): 1 item(s)', 'concatenating 30 segment(s)...'])!
    expect(after).toBeGreaterThanOrEqual(before)
  })
})
