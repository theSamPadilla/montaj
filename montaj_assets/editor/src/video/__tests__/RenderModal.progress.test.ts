/// <reference types="vite/client" />
/**
 * `parseLogProgress` — the SSE/log-transport render progress estimate. It reads
 * the render's two real running counters (frame-baking jobs and composition
 * segments) so the bar tracks total work. The load-bearing case these pin: the
 * renderer logs `encoded <job> (jobsDone/total done)` after EVERY job, and the
 * "done" in "(N/M done)" is a per-job counter — it must NOT be read as the
 * render finishing, which pinned the bar at ~98% for the entire render.
 */
import { describe, it, expect } from 'vitest'
import { parseLogProgress } from '../RenderModal'

describe('parseLogProgress', () => {
  it('is null before any line lands (indeterminate bar)', () => {
    expect(parseLogProgress([])).toBeNull()
  })

  it('does NOT read a per-job "(N/M done)" counter as the render finishing', () => {
    // THE regression: the first "encoded ... (1/12 done)" used to leap the bar to
    // ~98% and freeze it there for the whole render.
    const p = parseLogProgress([
      '[render] rendering captions chunk 1/10 (120 frames)...',
      '[render] encoded captions chunk 1/10 (1/12 done)',
    ])!
    expect(p).toBeLessThan(0.15) // 1 of 12 jobs baked — early, not near-full
  })

  it('climbs through frame-baking via jobsDone/total', () => {
    const early = parseLogProgress(['[render] encoded overlay-1 (2/12 done)'])!
    const late = parseLogProgress(['[render] encoded captions chunk 10/10 (11/12 done)'])!
    expect(early).toBeGreaterThan(0.05)
    expect(late).toBeGreaterThan(early)
    expect(late).toBeLessThan(0.55) // baking tops at ~0.55, before composition
  })

  it('climbs through composition via "[montaj compose] segment i/N"', () => {
    const start = parseLogProgress(['[render] composing final video...'])!
    const early = parseLogProgress(['[montaj compose] segment 2/30 (0.1-0.2s): 1 item(s)'])!
    const late = parseLogProgress(['[montaj compose] segment 27/30 (5.0-5.1s): 1 item(s)'])!
    expect(start).toBeGreaterThanOrEqual(0.55)
    expect(early).toBeGreaterThanOrEqual(0.55)
    expect(late).toBeGreaterThan(early)
    expect(late).toBeGreaterThan(0.85) // deep into composition
  })

  it('is monotonic across a full baking → composition → finalize sequence', () => {
    const seq = [
      '[render] rendering overlay-1 chunk 1/2 (72 frames)...',
      '[render] encoded overlay-1 chunk 1/2 (1/12 done)',
      '[render] encoded captions chunk 5/10 (6/12 done)',
      '[render] encoded captions chunk 10/10 (12/12 done)',
      '[render] composing final video...',
      '[montaj compose] segment 15/30 (2.0s): 1 item(s)',
      '[montaj compose] segment 30/30 (5.0s): 1 item(s)',
      '[montaj compose] concatenating 30 segment(s)...',
    ]
    let prev = 0
    for (let i = 1; i <= seq.length; i++) {
      const p = parseLogProgress(seq.slice(0, i))!
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
    expect(prev).toBeGreaterThan(0.85)
  })
})
