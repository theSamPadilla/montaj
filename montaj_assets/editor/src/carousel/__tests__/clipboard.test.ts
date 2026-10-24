import { describe, it, expect } from 'vitest'
import type { CarouselElement, ImageElement, OverlayElement, Slide } from '../../types'
import { COPY_OFFSET, cloneElement, copyElements, duplicateElements, pasteElements } from '../clipboard'

function image(id: string, x = 100, y = 100, extra: Partial<ImageElement> = {}): ImageElement {
  return { id, type: 'image', src: `${id}.png`, x, y, w: 200, h: 150, rotation: 0, ...extra }
}

function overlay(id: string, x = 50, y = 60): OverlayElement {
  return {
    id,
    type: 'overlay',
    overlay: { template: '/overlays/text.jsx', props: { text: 'Hello', style: { color: 'red', pad: [1, 2] } } },
    frame: 0,
    x,
    y,
    w: 600,
    h: 200,
    rotation: 0,
    googleFonts: ['Syne:wght@800'],
  }
}

function slide(id: string, elements: CarouselElement[]): Slide {
  return { id, base_color: '#ffffff', elements }
}

const ids = (elements: CarouselElement[]) => elements.map((e) => e.id)
const at = (elements: CarouselElement[]) => elements.map((e) => [e.x, e.y])

describe('cloneElement', () => {
  it('keeps everything but the id, and leaves the source alone', () => {
    const src = image('a', 100, 120, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, mediaId: 'm1' })
    const copy = cloneElement(src)
    expect(copy.id).not.toBe('a')
    expect(copy.id).toBeTruthy()
    expect({ ...copy, id: 'a' }).toEqual(src)
    expect(src.id).toBe('a')
  })

  it('gives every copy its own id', () => {
    const src = image('a')
    expect(new Set([cloneElement(src).id, cloneElement(src).id, cloneElement(src).id]).size).toBe(3)
  })

  it('can be handed straight to map: the index is not an offset', () => {
    const copies = [image('a', 10, 10), image('b', 20, 20), image('c', 30, 30)].map(cloneElement)
    expect(at(copies)).toEqual([[10, 10], [20, 20], [30, 30]])
  })

  it('shares nothing with the source: the crop of an image', () => {
    const src = image('a', 0, 0, { crop: { x: 0, y: 0, w: 1, h: 1 } })
    const copy = cloneElement(src) as ImageElement
    expect(copy.crop).toEqual(src.crop)
    expect(copy.crop).not.toBe(src.crop)
    copy.crop!.x = 0.9
    expect(src.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('shares nothing with the source: overlay props (nested too) and fonts', () => {
    const src = overlay('o')
    const copy = cloneElement(src) as OverlayElement
    expect(copy.overlay).toEqual(src.overlay)
    expect(copy.overlay).not.toBe(src.overlay)
    expect(copy.overlay.props).not.toBe(src.overlay.props)
    expect(copy.overlay.props.style).not.toBe(src.overlay.props.style)
    expect(copy.googleFonts).toEqual(['Syne:wght@800'])
    expect(copy.googleFonts).not.toBe(src.googleFonts)

    ;(copy.overlay.props.style as { color: string }).color = 'blue'
    ;((copy.overlay.props.style as { pad: number[] }).pad).push(3)
    copy.googleFonts!.push('Inter')
    expect(src.overlay.props.style).toEqual({ color: 'red', pad: [1, 2] })
    expect(src.googleFonts).toEqual(['Syne:wght@800'])
  })

  it('an element without optional fields stays without them', () => {
    const copy = cloneElement(image('a'))
    expect('crop' in copy).toBe(false)
    expect('googleFonts' in cloneElement(overlay('o', 0, 0))).toBe(true)
  })
})

describe('copyElements', () => {
  it('takes the selected elements in slide order, whatever order they were picked in', () => {
    const s = slide('s0', [image('a'), image('b'), image('c'), image('d')])
    const clip = copyElements(s, ['d', 'b'])!
    expect(clip.slideId).toBe('s0')
    expect(ids(clip.elements)).toEqual(['b', 'd'])
  })

  it('holds independent copies: the slide changing afterwards does not reach the clipboard', () => {
    const src = image('a', 10, 20, { crop: { x: 0, y: 0, w: 1, h: 1 } })
    const clip = copyElements(slide('s0', [src]), ['a'])!
    expect(clip.elements[0]).not.toBe(src)
    ;(clip.elements[0] as ImageElement).crop!.w = 0.2
    expect(src.crop!.w).toBe(1)
    src.x = 999
    expect(clip.elements[0].x).toBe(10)
  })

  it('is null when nothing selected is on the slide', () => {
    const s = slide('s0', [image('a')])
    expect(copyElements(s, [])).toBeNull()
    expect(copyElements(s, ['ghost'])).toBeNull()
  })
})

describe('pasteElements', () => {
  // The two elements copied from slide s0, and s0 with both still on it.
  const originals = () => [image('a', 100, 100), overlay('o', 50, 60)]
  const clip = () => copyElements(slide('s0', originals()), ['a', 'o'])!
  const onSource = () => slide('s0', originals())
  const elsewhere = (id: string) => slide(id, [])

  it('on the slide they came from, each paste moves 20 px further down and right', () => {
    const c = clip()
    expect(COPY_OFFSET).toBe(20)
    expect(at(pasteElements(c, onSource()))).toEqual([[120, 120], [70, 80]])
    expect(at(pasteElements(c, onSource()))).toEqual([[140, 140], [90, 100]])
    expect(at(pasteElements(c, onSource()))).toEqual([[160, 160], [110, 120]])
  })

  it('on another slide, the first paste keeps the copied position and each further one moves 20 px from the last', () => {
    const c = clip()
    expect(at(pasteElements(c, elsewhere('s1')))).toEqual([[100, 100], [50, 60]])
    expect(at(pasteElements(c, elsewhere('s1')))).toEqual([[120, 120], [70, 80]])
    expect(at(pasteElements(c, elsewhere('s1')))).toEqual([[140, 140], [90, 100]])
  })

  it('counts each slide on its own', () => {
    const c = clip()
    pasteElements(c, onSource())
    expect(at(pasteElements(c, elsewhere('s1')))[0]).toEqual([100, 100])
    expect(at(pasteElements(c, elsewhere('s2')))[0]).toEqual([100, 100])
    expect(at(pasteElements(c, onSource()))[0]).toEqual([140, 140])
    expect(at(pasteElements(c, elsewhere('s1')))[0]).toEqual([120, 120])
  })

  it('a new copy starts the counts again', () => {
    const c = clip()
    pasteElements(c, onSource())
    pasteElements(c, onSource())
    const again = clip()
    expect(at(pasteElements(again, onSource()))[0]).toEqual([120, 120])
  })

  it('gives fresh ids, in the copied order, and never the clipboard\'s own objects', () => {
    const c = clip()
    const first = pasteElements(c, elsewhere('s1'))
    const second = pasteElements(c, elsewhere('s1'))
    expect(first.map((e) => e.type)).toEqual(['image', 'overlay'])
    // New ids: not the source's (the clipboard still holds those), not each other's.
    expect(ids(c.elements)).toEqual(['a', 'o'])
    const all = [...ids(first), ...ids(second), 'a', 'o']
    expect(new Set(all).size).toBe(all.length)
    expect(first[0]).not.toBe(c.elements[0])
    expect(first[1]).not.toBe(c.elements[1])
    // The clipboard keeps the position it was copied at.
    expect(at(c.elements)).toEqual([[100, 100], [50, 60]])
  })

  it('pasted elements are independent of each other and of the clipboard', () => {
    const c = clip()
    const [, o1] = pasteElements(c, elsewhere('s1')) as [CarouselElement, OverlayElement]
    const [, o2] = pasteElements(c, elsewhere('s1')) as [CarouselElement, OverlayElement]
    ;(o1.overlay.props.style as { color: string }).color = 'green'
    o1.googleFonts!.length = 0
    expect((o2.overlay.props.style as { color: string }).color).toBe('red')
    expect(o2.googleFonts).toEqual(['Syne:wght@800'])
    expect(((c.elements[1] as OverlayElement).overlay.props.style as { color: string }).color).toBe('red')
  })

  it('a slide that is not the source counts as another slide, also when the source is gone', () => {
    const c = clip()
    expect(at(pasteElements(c, elsewhere('deleted-slide')))[0]).toEqual([100, 100])
  })

  it('while an original is still on the slide it was copied from, the first paste steps 20 px', () => {
    expect(at(pasteElements(clip(), onSource()))).toEqual([[120, 120], [70, 80]])
    // One of them is enough.
    expect(at(pasteElements(clip(), slide('s0', [image('a', 100, 100)])))).toEqual([[120, 120], [70, 80]])
  })

  it('once the originals are gone, the first paste lands where they were', () => {
    expect(at(pasteElements(clip(), slide('s0', [image('x', 0, 0)])))).toEqual([[100, 100], [50, 60]])
  })

  it('originals deleted between two pastes: the second steps past the first, not onto it', () => {
    const c = clip()
    expect(at(pasteElements(c, onSource()))).toEqual([[120, 120], [70, 80]])
    expect(at(pasteElements(c, slide('s0', [])))).toEqual([[140, 140], [90, 100]])
  })

  it('after a cut, the first paste lands where the elements were, then each one steps 20 px', () => {
    const c = clip()
    const afterCut = slide('s0', [])
    expect(at(pasteElements(c, afterCut))).toEqual([[100, 100], [50, 60]])
    expect(at(pasteElements(c, afterCut))).toEqual([[120, 120], [70, 80]])
    expect(at(pasteElements(c, afterCut))).toEqual([[140, 140], [90, 100]])
  })

  it('after a cut, a paste onto another slide is counted as it is after a copy', () => {
    const c = clip()
    expect(at(pasteElements(c, elsewhere('s1')))).toEqual([[100, 100], [50, 60]])
    expect(at(pasteElements(c, elsewhere('s1')))).toEqual([[120, 120], [70, 80]])
  })

  it('after a copy, the first paste onto the slide it was copied from is still +20, then +40', () => {
    const c = clip()
    expect(at(pasteElements(c, onSource()))).toEqual([[120, 120], [70, 80]])
    expect(at(pasteElements(c, onSource()))).toEqual([[140, 140], [90, 100]])
  })
})

describe('duplicateElements', () => {
  it('puts a copy 20 px down and right directly above its own source', () => {
    const elements = [image('a', 10, 10), image('b', 200, 200), image('c', 300, 300)]
    const out = duplicateElements(elements, ['a', 'c'])
    expect(out.elements.map((e) => e.id).filter((i) => !out.copyIds.includes(i))).toEqual(['a', 'b', 'c'])
    expect(out.elements).toHaveLength(5)
    expect(out.elements[0]).toBe(elements[0])
    expect(out.elements[2]).toBe(elements[1])
    expect(out.elements[3]).toBe(elements[2])
    // a, copy of a, b, c, copy of c
    expect(out.copyIds).toEqual([out.elements[1].id, out.elements[4].id])
    expect(at([out.elements[1], out.elements[4]])).toEqual([[30, 30], [320, 320]])
    expect(out.elements[1].type).toBe('image')
    expect((out.elements[1] as ImageElement).src).toBe('a.png')
    expect((out.elements[4] as ImageElement).src).toBe('c.png')
  })

  it('copies share nothing with their sources', () => {
    const elements = [overlay('o', 0, 0)]
    const out = duplicateElements(elements, ['o'])
    const copy = out.elements[1] as OverlayElement
    expect(copy.overlay.props).not.toBe((elements[0] as OverlayElement).overlay.props)
    expect(copy.googleFonts).not.toBe((elements[0] as OverlayElement).googleFonts)
  })

  it('does not touch its input, and returns the same array when nothing is selected', () => {
    const elements = [image('a'), image('b')]
    const snapshot = [...elements]
    duplicateElements(elements, ['a'])
    expect(elements).toEqual(snapshot)
    const none = duplicateElements(elements, ['ghost'])
    expect(none.elements).toBe(elements)
    expect(none.copyIds).toEqual([])
  })
})
