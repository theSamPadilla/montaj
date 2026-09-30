import { describe, it, expect } from 'vitest'
import type { VisualItem } from '../../schema'
import {
  CROP_PROPS, canKeyframeProp, transformProps, valueAt, writeProp,
  writeCrop, cropAt, cropKeyedAt, toggleCropKeyframeAt, isCropKeyframed,
} from '../keyframeOps'

const img = (over: Partial<VisualItem> = {}): VisualItem =>
  ({ id: 'i', type: 'image', src: 'p.jpg', start: 0, end: 4, ...over }) as VisualItem
const RECT = { x: 0.5, y: 0, w: 0.3, h: 1 }

describe('PV55: the crop in keyframeOps', () => {
  it('crop props keyframe on images, and on videos that carry their source size (phase 2)', () => {
    const dims = { sourceWidth: 1920, sourceHeight: 1080 }
    for (const p of CROP_PROPS) {
      expect(canKeyframeProp(img(), p)).toBe(true)
      expect(canKeyframeProp(img({ type: 'video', ...dims }), p)).toBe(true)
      expect(canKeyframeProp(img({ type: 'video' }), p)).toBe(false)
      expect(canKeyframeProp(img({ type: 'video', sourceWidth: 1920 }), p)).toBe(false)
      expect(canKeyframeProp(img({ type: 'overlay', ...dims }), p)).toBe(false)
    }
  })

  it('crop props never join the keyframe-everything set', () => {
    for (const p of CROP_PROPS) {
      expect(transformProps(img())).not.toContain(p)
      expect(transformProps(img({ scaleX: 1.2 }))).not.toContain(p)
    }
  })

  it('valueAt reads the static sourceCrop, else the full frame', () => {
    expect(valueAt(img(), 'cropW', 1)).toBe(1)
    expect(valueAt(img({ sourceCrop: RECT }), 'cropX', 1)).toBe(0.5)
  })

  it('writeProp on an un-animated crop prop writes that one field of sourceCrop', () => {
    expect(writeProp(img({ sourceCrop: RECT }), 'cropY', 0, 0.2).sourceCrop).toEqual({ ...RECT, y: 0.2 })
    expect(writeProp(img(), 'cropW', 0, 0.5).sourceCrop).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
  })

  it('writeCrop on an un-animated crop writes the static sourceCrop and no keyframes', () => {
    const next = writeCrop(img(), 1, RECT)
    expect(next.sourceCrop).toEqual(RECT)
    expect(next.keyframes).toBeUndefined()
  })

  it('the diamond keys all four at the playhead, holding the current crop', () => {
    const next = toggleCropKeyframeAt(img({ sourceCrop: RECT }), 1)
    expect(isCropKeyframed(next)).toBe(true)
    expect(cropKeyedAt(next, 1)).toBe(true)
    for (const p of CROP_PROPS) expect(next.keyframes?.find(k => k.prop === p)?.points.map(pt => pt.t)).toEqual([1])
    expect(cropAt(next, 1)).toEqual(RECT)
  })

  it('writeCrop on an animated crop keys all four at the playhead and leaves sourceCrop alone', () => {
    const start = { x: 0, y: 0, w: 0.3, h: 1 }
    const next = writeCrop(toggleCropKeyframeAt(img({ sourceCrop: start }), 0), 2, RECT)
    expect(next.sourceCrop).toEqual(start)
    expect(cropAt(next, 0)).toEqual(start)
    expect(cropAt(next, 2)).toEqual(RECT)
    expect(cropAt(next, 1).x).toBeCloseTo(0.25, 12)
  })

  it('writeCrop at an existing keyframe updates it instead of adding one', () => {
    const keyed = toggleCropKeyframeAt(img(), 0)
    const next = writeCrop(keyed, 0, RECT)
    expect(next.keyframes?.find(k => k.prop === 'cropX')?.points).toEqual([{ t: 0, value: 0.5 }])
  })

  it('removing the only crop keyframe writes its framing into sourceCrop: nothing moves', () => {
    const keyed = writeCrop(toggleCropKeyframeAt(img(), 0), 0, RECT)
    const off = toggleCropKeyframeAt(keyed, 0)
    expect(isCropKeyframed(off)).toBe(false)
    expect(off.keyframes).toBeUndefined()
    expect(off.sourceCrop).toEqual(RECT)
  })

  it('the diamond with a frame keys the frame, not the untrimmed crop (F10 D1)', () => {
    const frame = { x: 0.35, y: 0, w: 0.3, h: 1 }
    const next = toggleCropKeyframeAt(img(), 1, frame)
    for (const p of CROP_PROPS) expect(next.keyframes?.find(k => k.prop === p)?.points.map(pt => pt.t)).toEqual([1])
    expect(cropAt(next, 1)).toEqual(frame)
    expect(next.sourceCrop).toBeUndefined()
  })

  it('a frame changes nothing when the diamond removes', () => {
    const keyed = toggleCropKeyframeAt(img(), 0)
    const off = toggleCropKeyframeAt(keyed, 0, { x: 0.35, y: 0, w: 0.3, h: 1 })
    expect(off.keyframes).toBeUndefined()
    expect(off.sourceCrop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})
