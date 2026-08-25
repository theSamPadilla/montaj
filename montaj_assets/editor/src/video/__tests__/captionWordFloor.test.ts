import { describe, it, expect } from 'vitest'
import { floorWordDurations, MIN_WORD_DURATION_S } from '../captionWordFloor'
import type { Word } from '../../schema'

// Mirrors tests/steps/test_caption.py's waterfall matrix for
// steps/lyrics/caption.py::floor_word_durations. The only behavioral
// difference under test is the segment-final word: here it's clamped at
// `segEnd` instead of extended unconditionally (this mirror runs
// per-segment, not at the transcript flatten — see captionWordFloor.ts).

function w(start: number, end: number, word = 'w'): Word {
  return { word, start, end }
}

describe('floorWordDurations', () => {
  it('is 50ms', () => {
    expect(MIN_WORD_DURATION_S).toBe(0.05)
  })

  it('is a no-op on an empty list', () => {
    expect(floorWordDurations([], 1)).toEqual([])
  })

  it('extends a single-word list (n==1) to the floor when segEnd allows it', () => {
    // Pins the n==1 path: with no words after it, `i + 1 >= n` is already
    // true at i=0, routing straight into the segment-final branch.
    const words = [w(0, 0.02)]
    const out = floorWordDurations(words, 1, 0.05)
    expect(out[0].start).toBeCloseTo(0)
    expect(out[0].end).toBeCloseTo(0.05)
  })

  it('clamps a single-word list (n==1) at a tight segEnd', () => {
    const words = [w(0, 0.02)]
    const out = floorWordDurations(words, 0.03, 0.05)
    expect(out[0].start).toBeCloseTo(0)
    expect(out[0].end).toBeCloseTo(0.03)
  })

  it('accepts a donation when the successor retains >= floor', () => {
    // successor retains 0.400 - 0.050 = 0.350 >= floor
    const words = [w(0, 0.02), w(0.02, 0.4)]
    const out = floorWordDurations(words, 0.4, 0.05)
    expect(out[0].start).toBeCloseTo(0)
    expect(out[0].end).toBeCloseTo(0.05)
    expect(out[1].start).toBeCloseTo(0.05)
    expect(out[1].end).toBeCloseTo(0.4)
  })

  it('accepts a donation when the successor retains EXACTLY the floor (inclusive boundary)', () => {
    // Pins the >= in the donation gate: the spec is "retain >= floor_s", not
    // "> floor_s" — no other case in this matrix distinguishes the two, so
    // without this one a regression to `>` would leave the suite green.
    // Exact, not float-luck: candidateBoundary = 0 + 0.05 = 0.05;
    // successorNewDur = 0.10 - 0.05 = 0.05 === floor exactly at these
    // values. Word 1's own original duration (0.08) is already >= floor, so
    // it never enters the "short" branch itself, pre- or post-donation —
    // this case is clean of the segment-final clamp too.
    const words = [w(0, 0.02), w(0.02, 0.1)]
    const out = floorWordDurations(words, 0.1, 0.05)
    expect(out[0].start).toBeCloseTo(0)
    expect(out[0].end).toBeCloseTo(0.05)
    expect(out[1].start).toBeCloseTo(0.05)
    expect(out[1].end).toBeCloseTo(0.1)
  })

  it('refuses a donation when the successor would drop below floor, leaving word i unchanged', () => {
    // successor would retain only 0.060 - 0.050 = 0.010 < floor: refused.
    // Word 1 here is the segment-final word (clamped at segEnd=0.06, so no
    // room to extend) — it stays exactly as-is too, unlike the Python
    // mirror's unconditional-extension case tested separately below.
    const words = [w(0, 0.02), w(0.02, 0.06)]
    const out = floorWordDurations(words, 0.06, 0.05)
    expect(out[0]).toEqual(w(0, 0.02))
    expect(out[1]).toEqual(w(0.02, 0.06))
  })

  it('does not touch a final word at exactly the floor duration, even with room past segEnd to spare', () => {
    // Pins the TRIGGER condition, not just the segEnd clamp: with segEnd far
    // past the word's current end there is plenty of room to extend, yet a
    // word already AT the floor never qualifies as short in the first
    // place (the `dur >= floorS` skip fires before any extension logic).
    const words = [w(0, 0.5), w(0.5, 0.55)] // duration exactly 0.05 == floor
    const out = floorWordDurations(words, 10, 0.05)
    expect(out).toEqual(words)
  })

  it('does not touch a final word comfortably above the floor', () => {
    const words = [w(0, 0.5), w(0.5, 0.62)] // duration 0.12
    const out = floorWordDurations(words, 10, 0.05)
    expect(out).toEqual(words)
  })

  it('leaves an entirely starved run unchanged when every donation is refused and the last word is not short', () => {
    const words = [w(0, 0.02), w(0.02, 0.04), w(0.04, 0.06), w(0.06, 0.11)]
    const out = floorWordDurations(words, 0.11, 0.05)
    expect(out).toEqual(words)
  })

  it('rescues only the starved run\'s last boundary when it is followed by a long word (per-boundary, not per-run)', () => {
    const words = [w(0, 0.02), w(0.02, 0.04), w(0.04, 0.06), w(0.06, 0.5)]
    const out = floorWordDurations(words, 0.5, 0.05)
    expect(out[0]).toEqual(w(0, 0.02))
    expect(out[1]).toEqual(w(0.02, 0.04))
    expect(out[2].start).toBeCloseTo(0.04)
    expect(out[2].end).toBeCloseTo(0.09)
    expect(out[3].start).toBeCloseTo(0.09)
    expect(out[3].end).toBeCloseTo(0.5)
  })

  it('extends a non-contiguous word into an existing gap without touching the successor start', () => {
    const words = [w(0, 0.02), w(0.1, 0.2)]
    const out = floorWordDurations(words, 0.2, 0.05)
    expect(out[0].start).toBeCloseTo(0)
    expect(out[0].end).toBeCloseTo(0.05)
    expect(out[1]).toEqual(w(0.1, 0.2))
  })

  it('caps the non-contiguous extension at the gap size, not the full floor deficit', () => {
    const words = [w(0, 0.02), w(0.03, 0.2)]
    const out = floorWordDurations(words, 0.2, 0.05)
    expect(out[0].start).toBeCloseTo(0)
    expect(out[0].end).toBeCloseTo(0.03)
    expect(out[1]).toEqual(w(0.03, 0.2))
  })

  it('leaves already-long words untouched (identical values out)', () => {
    const words = [w(0, 0.5), w(0.5, 1.0), w(1.0, 1.8)]
    const out = floorWordDurations(words, 1.8, 0.05)
    expect(out).toEqual(words)
  })

  it('never creates overlap', () => {
    const matrices: Word[][] = [
      [w(0, 0.02), w(0.02, 0.4)],
      [w(0, 0.02), w(0.02, 0.06)],
      [w(0, 0.02), w(0.02, 0.04), w(0.04, 0.06), w(0.06, 0.11)],
      [w(0, 0.02), w(0.02, 0.04), w(0.04, 0.06), w(0.06, 0.5)],
      [w(0, 0.02), w(0.1, 0.2)],
      [w(0, 0.02), w(0.03, 0.2)],
    ]
    for (const words of matrices) {
      const segEnd = words[words.length - 1].end
      const out = floorWordDurations(words, segEnd, 0.05)
      for (let i = 0; i < out.length - 1; i++) {
        expect(out[i].end).toBeLessThanOrEqual(out[i + 1].start + 1e-9)
      }
    }
  })

  it('never introduces a gap where words were previously flush', () => {
    // word-by-word.jsx falls back to rendering the segment's LAST word when
    // no word matches the current time — a gap introduced mid-segment would
    // make the caption visibly jump to its final word and back. The
    // waterfall must never do this: it only moves a shared boundary forward
    // together, and the non-contiguous branch only ever shrinks a gap.
    const matrices: Word[][] = [
      [w(0, 0.02), w(0.02, 0.4)],
      [w(0, 0.02), w(0.02, 0.06)],
      [w(0, 0.02), w(0.02, 0.04), w(0.04, 0.06), w(0.06, 0.11)],
      [w(0, 0.02), w(0.02, 0.04), w(0.04, 0.06), w(0.06, 0.5)],
    ]
    for (const words of matrices) {
      const segEnd = words[words.length - 1].end
      const flushBefore = words.slice(0, -1).map((word, i) => word.end === words[i + 1].start)
      const out = floorWordDurations(words, segEnd, 0.05)
      flushBefore.forEach((wasFlush, i) => {
        if (wasFlush) expect(out[i].end).toBe(out[i + 1].start)
      })
    }
  })

  it('does not mutate the input', () => {
    const words = [w(0, 0.02), w(0.02, 0.4)]
    const snapshot = words.map((word) => ({ ...word }))
    floorWordDurations(words, 0.4, 0.05)
    expect(words).toEqual(snapshot)
  })

  describe('segment-final clamp (divergence from the Python mirror)', () => {
    it('extends a short segment-final word only up to segEnd, never past it', () => {
      const words = [w(0, 0.4), w(0.4, 0.42)]
      const out = floorWordDurations(words, 0.42, 0.05)
      expect(out[0]).toEqual(w(0, 0.4))
      // Deficit would be 0.03 (→ 0.45) but segEnd caps it at 0.42.
      expect(out[1].start).toBeCloseTo(0.4)
      expect(out[1].end).toBeCloseTo(0.42)
    })

    it('extends a short segment-final word up to the floor when segEnd leaves enough room', () => {
      const words = [w(0, 0.4), w(0.4, 0.42)]
      const out = floorWordDurations(words, 0.46, 0.05)
      expect(out[1].start).toBeCloseTo(0.4)
      expect(out[1].end).toBeCloseTo(0.45)
    })
  })

  describe('uniform spread (the actual editor-side call site)', () => {
    it('is a no-op on a uniform segDur / n spread: the donation gate can never fire', () => {
      // 4 words uniformly spread across 0.12s → 0.03s each, all sub-floor.
      // For a contiguous run of equal-duration words, successorNewDur works
      // out to 2*dur - floor, so the gate (successorNewDur >= floor)
      // reduces to dur >= floor -- which contradicts dur < floor, the
      // precondition for a word entering the donation branch at all. So no
      // boundary in a uniform spread is ever eligible: this is not "starves
      // gracefully", it is a hard no-op. (The segment-final word is a
      // separate no-op too: a uniform spread's last word already ends
      // exactly at segEnd, so the clamp there is a no-op by construction.)
      // This pins that the editor-side call sites (captionRepair.ts,
      // makeCaptionEdit.ts) are currently inert, not that they work. That is
      // the intended behaviour, not a latent bug: a uniform editor spread is
      // deliberately left unfloored to match CapCut (edited caption text
      // never changes the caption's duration; lengthen or split it instead).
      // Don't "fix" this test by making it non-vacuous in the direction of
      // asserting the floor should fire here — that would be reintroducing
      // the behaviour this test exists to keep out.
      const n = 4
      const segStart = 0
      const segEnd = 0.12
      const wordDur = (segEnd - segStart) / n
      const spread = Array.from({ length: n }, (_, i) =>
        w(segStart + i * wordDur, segStart + (i + 1) * wordDur, `w${i}`),
      )
      const out = floorWordDurations(spread, segEnd, 0.05)
      expect(out).toEqual(spread)
    })
  })
})
