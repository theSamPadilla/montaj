import { describe, it, expect } from 'vitest'
import { markerDropTime } from '../VideoEditor'

describe('markerDropTime', () => {
  it('uses the playhead when the preview axis is off', () => {
    expect(markerDropTime(false, 12, 4)).toBe(4)
  })

  it('uses the hovered time when the axis is on', () => {
    // The yellow line is what the operator is looking at, so that is where the
    // marker goes.
    expect(markerDropTime(true, 12, 4)).toBe(12)
  })

  it('falls back to the playhead when the axis is on but nothing is hovered', () => {
    // Axis on with the pointer off the timeline: hoverScrub reads null.
    expect(markerDropTime(true, null, 4)).toBe(4)
  })

  it('treats a hovered 0 as a real position, not as absent', () => {
    // The bug a `||` instead of `??` would introduce: the very start of the
    // timeline is a perfectly ordinary place to mark.
    expect(markerDropTime(true, 0, 4)).toBe(0)
  })
})
