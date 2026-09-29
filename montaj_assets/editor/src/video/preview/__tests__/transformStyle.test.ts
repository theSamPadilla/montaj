/// <reference types="vitest/globals" />
import { videoTransformContainerStyle, videoTransformBoxPct, perAxisRatio, mediaBoxStyle, zoomTo } from '../transformStyle'

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

describe('perAxisRatio', () => {
  it('is exactly 1 for a uniform item, however spelled', () => {
    expect(perAxisRatio({})).toBe(1)
    expect(perAxisRatio({ scale: 0.37 })).toBe(1)
    expect(perAxisRatio({ scaleX: 0.3, scaleY: 0.3 })).toBe(1)
  })

  it('is scaleX / scaleY, each falling back to `scale`', () => {
    expect(perAxisRatio({ scaleX: 2, scaleY: 0.5 })).toBe(4)
    expect(perAxisRatio({ scale: 2, scaleY: 0.5 })).toBe(4)
  })

  it('is 1 for a scale the export cannot draw', () => {
    expect(perAxisRatio({ scaleX: 0, scaleY: 1 })).toBe(1)
    expect(perAxisRatio({ scaleX: 1, scaleY: -1 })).toBe(1)
    expect(perAxisRatio({ scaleX: Infinity, scaleY: 1 })).toBe(1)
  })
})

describe('mediaBoxStyle', () => {
  const FULL = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'hidden' }

  it('a uniform item gets the plain full box: no transform, nothing to undo', () => {
    expect(mediaBoxStyle({})).toEqual(FULL)
    expect(mediaBoxStyle({ scale: 0.5 })).toEqual(FULL)
    expect(mediaBoxStyle({ scaleX: 0.5, scaleY: 0.5 })).toEqual(FULL)
  })

  it('a per-axis item gets the box at its own size, centred and counter-scaled', () => {
    expect(mediaBoxStyle({ scaleX: 2, scaleY: 0.5 })).toEqual({
      position: 'absolute',
      left: '-50%', top: '25%', width: '200%', height: '50%',
      transform: 'scale(0.5, 2)', transformOrigin: 'center center', overflow: 'hidden',
    })
  })

  it('a degenerate scale falls back to the full box rather than dividing by zero', () => {
    expect(mediaBoxStyle({ scaleX: 0, scaleY: 1 })).toEqual(FULL)
  })
})

describe('zoomTo', () => {
  it('a uniform item changes only `scale`', () => {
    expect(zoomTo({ scale: 1, offsetX: 5, offsetY: 0 }, 2)).toEqual({ scale: 2, offsetX: 5, offsetY: 0 })
  })

  it('a per-axis item scales both axes by the same factor, keeping its shape', () => {
    const z = zoomTo({ scale: 1, scaleX: 0.9, scaleY: 0.3, offsetY: 30 }, 1.5)
    expect(z.scale).toBe(1.5)
    expect(z.scaleX).toBeCloseTo(1.35, 12)
    expect(z.scaleY).toBeCloseTo(0.45, 12)
    expect(z.offsetY).toBe(30)
    expect(perAxisRatio(z)).toBeCloseTo(3, 12)
  })

  it('an explicitly absent axis stays absent', () => {
    expect(zoomTo({ scale: 1, scaleX: undefined, scaleY: 0.5 }, 2)).toEqual({ scale: 2, scaleX: undefined, scaleY: 1 })
  })
})
