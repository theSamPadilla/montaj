import { describe, it, expect } from 'vitest'
import { canKeyframe, canKeyframeProp, transformProps } from '../keyframeOps'
import type { VisualItem } from '../../schema'

/** SP9d — keyframeability is per property per kind. */
describe('canKeyframe / canKeyframeProp', () => {
  const mk = (type: string, over: Partial<VisualItem> = {}) =>
    ({ id: 'x', type, src: '/tmp/a', start: 0, end: 3, ...over } as unknown as VisualItem)

  const FIVE = ['offsetX', 'offsetY', 'scale', 'rotation', 'opacity'] as const

  it('overlays keep every property', () => {
    const ov = mk('overlay')
    expect(canKeyframe(ov)).toBe(true)
    for (const p of FIVE) expect(canKeyframeProp(ov, p)).toBe(true)
  })

  for (const kind of ['video', 'image'] as const) {
    it(`${kind} clips animate geometry but NOT opacity`, () => {
      const clip = mk(kind)
      expect(canKeyframe(clip)).toBe(true)
      for (const p of ['offsetX', 'offsetY', 'scale', 'rotation'] as const) {
        expect(canKeyframeProp(clip, p)).toBe(true)
      }
      expect(canKeyframeProp(clip, 'opacity')).toBe(false)
    })
  }

  it('an unknown or missing kind is keyframeable nowhere', () => {
    expect(canKeyframe(null)).toBe(false)
    expect(canKeyframe(undefined)).toBe(false)
    expect(canKeyframe(mk('audio'))).toBe(false)
    expect(canKeyframeProp(mk('audio'), 'scale')).toBe(false)
    expect(canKeyframeProp(null, 'scale')).toBe(false)
  })

  it('canKeyframe is true iff SOME property is keyframeable', () => {
    for (const kind of ['overlay', 'video', 'image', 'audio', 'caption']) {
      const item = mk(kind)
      const anyProp = FIVE.some(p => canKeyframeProp(item, p))
      expect(canKeyframe(item)).toBe(anyProp)
    }
  })

  it('transformProps drops opacity for a clip and keeps it for an overlay', () => {
    expect(transformProps(mk('overlay'))).toContain('opacity')
    expect(transformProps(mk('video'))).not.toContain('opacity')
    expect(transformProps(mk('image'))).not.toContain('opacity')
    // ...and still carries the geometry props, so keying a clip does something.
    expect(transformProps(mk('video'))).toContain('scale')
    expect(transformProps(mk('video'))).toContain('rotation')
  })

  it('a per-axis clip drops opacity too, and keeps scaleX/scaleY', () => {
    const clip = mk('video', { scaleX: 1.2, scaleY: 0.8 } as Partial<VisualItem>)
    const props = transformProps(clip)
    expect(props).not.toContain('opacity')
    expect(props).toContain('scaleX')
    expect(props).toContain('scaleY')
  })
})
