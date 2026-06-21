/// <reference types="vitest/globals" />
import { videoTransformContainerStyle, videoTransformBoxPct } from '../transformStyle'

describe('videoTransformContainerStyle', () => {
  it('identity transform → empty style (no-op)', () => {
    expect(videoTransformContainerStyle({})).toEqual({})
    expect(videoTransformContainerStyle({ scale: 1, offsetX: 0, offsetY: 0 })).toEqual({})
  })

  it('scale + offset → translate then scale, origin center', () => {
    const s = videoTransformContainerStyle({ scale: 2, offsetX: 10, offsetY: -5 })
    expect(s.transform).toBe('translate(10%, -5%) scale(2)')
    expect(s.transformOrigin).toBe('center center')
  })
})

describe('videoTransformBoxPct', () => {
  it('scale 1, no offset → fills the frame', () => {
    expect(videoTransformBoxPct({})).toEqual({ width: 100, height: 100, left: 0, top: 0 })
  })

  it('scale 2 centered → 200% box, centered (offset -50%)', () => {
    expect(videoTransformBoxPct({ scale: 2 })).toEqual({ width: 200, height: 200, left: -50, top: -50 })
  })

  it('scale 0.5 → 50% box centered at 25%,25%', () => {
    expect(videoTransformBoxPct({ scale: 0.5 })).toEqual({ width: 50, height: 50, left: 25, top: 25 })
  })

  it('offset shifts the centered box by frame percent', () => {
    expect(videoTransformBoxPct({ scale: 2, offsetX: 10, offsetY: -5 }))
      .toEqual({ width: 200, height: 200, left: -40, top: -55 })
  })
})
