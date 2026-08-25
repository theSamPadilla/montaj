import { describe, it, expect } from 'vitest'
import { geometryAt, geometryFor } from '@bycrux/timeline-core'

/**
 * SP9d — clips animate their geometry in the preview, and their opacity does not.
 *
 * OverlayItemsLayer resolves an item's live transform through the same two
 * timeline-core calls asserted here; this pins the RULE those calls encode, which
 * is the part that must not drift from the renderer.
 */
describe('SP9d — preview geometry for clips', () => {
  const clip = {
    id: 'v1', type: 'video' as const, src: '/tmp/a.mp4', start: 0, end: 3,
    scale: 0.75, offsetX: 0, offsetY: 0, opacity: 0.4,
    keyframes: [
      { prop: 'offsetX' as const, points: [{ t: 0, value: -20 }, { t: 3, value: 20 }] },
      { prop: 'scale' as const, points: [{ t: 0, value: 0.5 }, { t: 3, value: 1 }] },
      { prop: 'rotation' as const, points: [{ t: 0, value: 0 }, { t: 3, value: 30 }] },
      { prop: 'opacity' as const, points: [{ t: 0, value: 0 }, { t: 3, value: 1 }] },
    ],
  }

  // Exactly what OverlayItemsLayer computes for a non-overlay item.
  const previewGeometry = (t: number) => ({
    ...geometryAt(clip, 'video', t - clip.start),
    opacity: geometryFor(clip, 'video').opacity,
  })

  it('position, scale and rotation all advance with the playhead', () => {
    const a = previewGeometry(0)
    const b = previewGeometry(1.5)
    const c = previewGeometry(3)
    expect(a.offsetX).toBeLessThan(b.offsetX)
    expect(b.offsetX).toBeLessThan(c.offsetX)
    expect(a.scale).toBeLessThan(c.scale)
    expect(a.rotation).toBeLessThan(c.rotation)
  })

  it('opacity does NOT animate — ffmpeg cannot express it, so neither may the preview', () => {
    // The whole point: an opacity curve exists on this clip and is ignored.
    expect(previewGeometry(0).opacity).toBe(0.4)
    expect(previewGeometry(1.5).opacity).toBe(0.4)
    expect(previewGeometry(3).opacity).toBe(0.4)
    // ...while the curve itself would very much have moved.
    expect(geometryAt(clip, 'video', 1.5).opacity).not.toBe(0.4)
  })

  it('an overlay still animates opacity, because its render path can', () => {
    const ov = { ...clip, type: 'overlay' as const }
    expect(geometryAt(ov, 'overlay', 0).opacity).toBe(0)
    expect(geometryAt(ov, 'overlay', 3).opacity).toBe(1)
  })

  it('a clip with no keyframes resolves exactly as it always did', () => {
    const plain = { id: 'v2', type: 'video' as const, src: '/tmp/b.mp4', start: 0, end: 3, scale: 0.6, offsetX: 4, offsetY: -2, opacity: 0.9 }
    const g = { ...geometryAt(plain, 'video', 1), opacity: geometryFor(plain, 'video').opacity }
    expect(g).toMatchObject({ scale: 0.6, offsetX: 4, offsetY: -2, opacity: 0.9 })
  })
})
