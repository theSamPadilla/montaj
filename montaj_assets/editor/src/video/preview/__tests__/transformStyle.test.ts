/// <reference types="vitest/globals" />
import { videoTransformContainerStyle, videoTransformBoxPct } from '../transformStyle'

describe('videoTransformContainerStyle', () => {
  it('identity transform → empty style (no-op)', () => {
    expect(videoTransformContainerStyle({})).toEqual({})
    expect(videoTransformContainerStyle({ scale: 1, offsetX: 0, offsetY: 0 })).toEqual({})
    // Identity spelled per-axis is still identity.
    expect(videoTransformContainerStyle({ scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 })).toEqual({})
  })

  it('a single non-identity axis defeats the no-op early return', () => {
    expect(videoTransformContainerStyle({ scaleX: 2 }).transform).toBe('translate(0%, 0%) scale(2, 1)')
    expect(videoTransformContainerStyle({ scaleY: 2 }).transform).toBe('translate(0%, 0%) scale(1, 2)')
  })

  it('scale + offset → translate then scale, origin center', () => {
    const s = videoTransformContainerStyle({ scale: 2, offsetX: 10, offsetY: -5 })
    // Uniform `scale` fills BOTH arguments — same box the one-argument form drew.
    expect(s.transform).toBe('translate(10%, -5%) scale(2, 2)')
    expect(s.transformOrigin).toBe('center center')
  })

  it('per-axis scale emits each axis independently', () => {
    const s = videoTransformContainerStyle({ scaleX: 1.5, scaleY: 0.5, offsetX: 10, offsetY: -5 })
    expect(s.transform).toBe('translate(10%, -5%) scale(1.5, 0.5)')
    expect(s.transformOrigin).toBe('center center')
  })

  it('per-axis wins over the uniform `scale`, one axis at a time', () => {
    expect(videoTransformContainerStyle({ scale: 3, scaleY: 0.25 }).transform)
      .toBe('translate(0%, 0%) scale(3, 0.25)')
    expect(videoTransformContainerStyle({ scale: 3, scaleX: 0.25 }).transform)
      .toBe('translate(0%, 0%) scale(0.25, 3)')
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

  // Inherited for free: geometryFor resolves scaleX/scaleY, toCssBoxPct takes
  // width/left from the X scale and height/top from the Y scale.
  it('per-axis scale sizes width and height independently', () => {
    expect(videoTransformBoxPct({ scaleX: 2, scaleY: 0.5 }))
      .toEqual({ width: 200, height: 50, left: -50, top: 25 })
  })
})
