import { describe, it, expect } from 'vitest'
import { activeCaptionSegments } from '@bycrux/timeline-core'
import { playheadInside } from '../captionSeek'

// s1 of the pointer-machine fixture: 3.44 is frame 103.2 at 30fps, so the
// frame grid and the raw time disagree near the start.
const SEG = { start: 3.44, end: 4.5 }

describe('playheadInside', () => {
  it('is true for a playhead well inside the caption', () => {
    expect(playheadInside(SEG, 4, 30)).toBe(true)
  })

  it('is false before the caption and after it', () => {
    expect(playheadInside(SEG, 1, 30)).toBe(false)
    expect(playheadInside(SEG, 6, 30)).toBe(false)
  })

  it('is false at exactly the end: the caption is not on screen there', () => {
    expect(playheadInside(SEG, 4.5, 30)).toBe(false)
  })

  it('snaps to the frame grid first, as the on-screen test does', () => {
    // Raw 3.445 is past `start`, but it snaps to frame 103 (3.4333), which is
    // before it: the caption is not yet on screen.
    expect(playheadInside(SEG, 3.445, 30)).toBe(false)
    // Raw 4.49 is before `end`, but it snaps to frame 135 (4.5), which is not.
    expect(playheadInside(SEG, 4.49, 30)).toBe(false)
    // Half a frame past start lands inside, which is where the seek puts it.
    expect(playheadInside(SEG, 3.44 + 0.5 / 30, 30)).toBe(true)
  })

  it('agrees with activeCaptionSegments frame by frame', () => {
    const captions = { segments: [SEG] }
    for (let frame = 90; frame <= 140; frame++) {
      const t = frame / 30 + 0.004
      expect(playheadInside(SEG, t, 30)).toBe(activeCaptionSegments(captions, t, 30).length === 1)
    }
  })

  it('falls back to 30fps for a zero or non-finite fps', () => {
    expect(playheadInside(SEG, 4, 0)).toBe(true)
    expect(playheadInside(SEG, 4, Number.NaN)).toBe(true)
    expect(playheadInside(SEG, 4.5, 0)).toBe(false)
  })
})
