import { describe, it, expect } from 'vitest'
import { maskAt, maskSvg, opacityAt } from '@bycrux/timeline-core'
import type { VisualItem } from '../../../schema'
import { compositeParts, itemCompositeStyle } from '../itemComposite'

/**
 * §616: a clip's opacity, mask and blend mode as CSS, read off the SAME
 * timeline-core functions the export samples (`opacityAt`, `maskAt`,
 * `maskSvg`'s polygon, `blendModeOf`), so the preview cannot draw a different
 * shape or fade than the render.
 */

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'c', type: 'video', src: 'a.mp4', start: 2, end: 12, ...over } as VisualItem
}

const MASK_KEYS = ['maskImage', 'maskSize', 'maskRepeat', 'maskMode', 'WebkitMaskImage', 'WebkitMaskSize', 'WebkitMaskRepeat', 'WebkitMaskMode']

function maskImageFor(item: VisualItem, localT: number, boxW: number, boxH: number): string {
  return `url("data:image/svg+xml,${encodeURIComponent(maskSvg(maskAt(item, localT)!, boxW, boxH))}")`
}

describe('itemCompositeStyle', () => {
  it('is empty for a plain item', () => {
    expect(itemCompositeStyle(clip(), 3, 540, 960)).toEqual({})
    expect(itemCompositeStyle(clip({ opacity: 1, blendMode: 'normal' }), 3, 540, 960)).toEqual({})
  })

  it('samples an opacity track (item-relative time)', () => {
    const item = clip({ keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }] })
    expect(itemCompositeStyle(item, 0.5, 540, 960)).toEqual({ opacity: '0.5' })
  })

  it('carries a static opacity below 1', () => {
    expect(itemCompositeStyle(clip({ opacity: 0.4 }), 3, 540, 960)).toEqual({ opacity: '0.4' })
  })

  it('draws the mask as the shared SVG over the box, luminance, stretched to the element', () => {
    const item = clip({
      mask: { shape: 'ellipse', x: 0.4, y: 0.5, w: 0.6, h: 0.3, feather: 0.05 },
      keyframes: [{ prop: 'maskW', points: [{ t: 0, value: 0.2 }, { t: 2, value: 0.8 }] }],
    })
    const style = itemCompositeStyle(item, 1, 432, 768)
    const image = maskImageFor(item, 1, 432, 768)
    // The keyframed width is what is drawn, not the static 0.6.
    expect(maskAt(item, 1)!.w).toBeCloseTo(0.5)
    expect(style).toEqual({
      maskImage: image,
      maskSize: '100% 100%',
      maskRepeat: 'no-repeat',
      maskMode: 'luminance',
      WebkitMaskImage: image,
      WebkitMaskSize: '100% 100%',
      WebkitMaskRepeat: 'no-repeat',
      WebkitMaskMode: 'luminance',
    })
  })

  it('maps `add` to plus-lighter and passes the other modes through', () => {
    expect(itemCompositeStyle(clip({ blendMode: 'add' }), 0, 100, 100)).toEqual({ mixBlendMode: 'plus-lighter' })
    expect(itemCompositeStyle(clip({ blendMode: 'screen' }), 0, 100, 100)).toEqual({ mixBlendMode: 'screen' })
    // An unknown mode is `normal`, so it emits nothing.
    expect(itemCompositeStyle(clip({ blendMode: 'dodge' as never }), 0, 100, 100)).toEqual({})
  })

  it('emits nothing else, all three at once', () => {
    const item = clip({
      opacity: 0.5,
      blendMode: 'multiply',
      mask: { shape: 'wipe', x: 0.3, rotation: 20 },
    })
    const style = itemCompositeStyle(item, 0, 200, 300)
    expect(Object.keys(style).sort()).toEqual(['mixBlendMode', 'opacity', ...MASK_KEYS].sort())
    expect(style.opacity).toBe('0.5')
    expect(style.mixBlendMode).toBe('multiply')
    expect(style.maskImage).toBe(maskImageFor(item, 0, 200, 300))
  })

  it('ignores mask tracks on an item with no mask', () => {
    const item = clip({ keyframes: [{ prop: 'maskX', points: [{ t: 0, value: 0.2 }] }] })
    expect(itemCompositeStyle(item, 0, 100, 100)).toEqual({})
  })

  it('draws no mask on an empty box', () => {
    const item = clip({ mask: { shape: 'rect' } })
    expect(itemCompositeStyle(item, 0, 0, 100)).toEqual({})
  })
})

describe('compositeParts — the same style, split by the element that carries it', () => {
  it('splits opacity (a number), blend and mask', () => {
    const item = clip({
      blendMode: 'screen',
      mask: { shape: 'rect', radius: 0.5 },
      keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0.2 }, { t: 4, value: 0.6 }] }],
    })
    const parts = compositeParts(item, 2, 300, 200)
    expect(parts.opacity).toBe(opacityAt(item, 2))
    expect(parts.blend).toEqual({ mixBlendMode: 'screen' })
    expect(Object.keys(parts.mask).sort()).toEqual([...MASK_KEYS].sort())
    expect(parts.mask.maskImage).toBe(maskImageFor(item, 2, 300, 200))
    // And together they are exactly itemCompositeStyle.
    expect({ opacity: String(parts.opacity), ...parts.blend, ...parts.mask }).toEqual(itemCompositeStyle(item, 2, 300, 200))
  })
})
