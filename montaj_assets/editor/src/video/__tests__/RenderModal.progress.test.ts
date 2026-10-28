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

  it('does not jump on an early SDR line (a sliced --export both prepares its SDR clips before capture)', () => {
    const p = parseLogProgress([
      '[montaj render] rendering in SDR: hlg_bt2020 is only the project default and no video on screen is HDR',
      '[montaj render] SDR pass: normalized IMG_0042.MOV in 12.4s',
      '[montaj derive-sdr] WARNING: this ffmpeg build is missing zscale',
      '[montaj render] slicing: 3 slice(s) of <=9000 MB (budget used 9000 MB, wanted 27000 MB, free 40000 MB)',
      '[montaj render] slice 1/3 (0.00-40.00s): capturing 4 overlay window(s)',
    ])!
    expect(p).toBeLessThan(0.1)
    expect(parseLogProgress(['[montaj render] deriving SDR rendition → out.sdr.mp4 (per layer)...'])!).toBeGreaterThanOrEqual(0.92)
  })

  it('reads the frame counter over the per-job one, which restarts every slice', () => {
    const p = parseLogProgress([
      '[montaj render] slicing: 3 slice(s) of <=9000 MB (budget used 9000 MB, wanted 27000 MB, free 40000 MB)',
      '[montaj render] baked 100/3000 frames',
      '[montaj render] encoded overlay-1 (3/3 done)',
    ])!
    expect(p).toBeCloseTo(0.05 + 0.5 * (100 / 3000), 5)
  })

  it('moves through every slice of a sliced render, capture weighted by frames', () => {
    const seq = ['[montaj render] slicing: 3 slice(s) of <=9000 MB (budget used 9000 MB, wanted 27000 MB, free 40000 MB)']
    const marks: number[] = []
    for (let k = 0; k < 3; k++) {
      seq.push(`[montaj render] slice ${k + 1}/3 (${k * 40}.00-${k * 40 + 40}.00s): capturing 4 overlay window(s)`)
      for (let f = 1; f <= 10; f++) seq.push(`[montaj render] baked ${k * 1000 + f * 100}/3000 frames`)
      seq.push(`[montaj render] encoded captions (4/4 done)`)
      marks.push(parseLogProgress(seq)!)
      seq.push(`[montaj render] slice ${k + 1}/3 (${k * 40}.00-${k * 40 + 40}.00s): encoding`)
      for (let i = 1; i <= 4; i++) seq.push(`[montaj compose] segment ${k * 4 + i}/12 (${k * 40 + i * 10 - 10}.00-${k * 40 + i * 10}.00s): 1 item(s), 1 overlay(s)`)
      marks.push(parseLogProgress(seq)!)
    }
    // Each slice's capture and each slice's encode moves the bar a share of the whole job.
    expect(marks[0]).toBeCloseTo(0.05 + 0.5 / 3, 5)
    expect(marks[1]).toBeCloseTo(0.05 + 0.5 / 3 + 0.35 / 3, 5)
    expect(marks[2]).toBeCloseTo(0.05 + 0.5 * 2 / 3 + 0.35 / 3, 5)
    for (let i = 1; i < marks.length; i++) expect(marks[i]).toBeGreaterThan(marks[i - 1])
    expect(marks[5]).toBeCloseTo(0.9, 5)
    seq.push('[montaj render] composing final video...', '[montaj compose] concatenating 12 segment(s)...')
    expect(parseLogProgress(seq)!).toBeCloseTo(0.9, 5)
  })
})
