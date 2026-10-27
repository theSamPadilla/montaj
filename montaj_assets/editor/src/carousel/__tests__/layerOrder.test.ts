import { describe, it, expect } from 'vitest'
import type { CarouselElement } from '../../types'
import { moveToLayer, reorderSelection } from '../layerOrder'

// Index 0 is the back of the slide, the last index the front (the canvas draws
// elements in array order).

function el(id: string): CarouselElement {
  return { id, type: 'image', src: `${id}.png`, x: 0, y: 0, w: 10, h: 10, rotation: 0 }
}
const list = (...ids: string[]) => ids.map(el)
const ids = (elements: CarouselElement[]) => elements.map((e) => e.id)

describe('reorderSelection: one element', () => {
  it('forward swaps it with the element in front of it', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c'), ['a'], 'forward'))).toEqual(['b', 'a', 'c'])
    expect(ids(reorderSelection(list('a', 'b', 'c'), ['b'], 'forward'))).toEqual(['a', 'c', 'b'])
  })

  it('backward swaps it with the element behind it', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c'), ['c'], 'backward'))).toEqual(['a', 'c', 'b'])
    expect(ids(reorderSelection(list('a', 'b', 'c'), ['b'], 'backward'))).toEqual(['b', 'a', 'c'])
  })

  it('front moves it to the end and back to the start', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c'), ['a'], 'front'))).toEqual(['b', 'c', 'a'])
    expect(ids(reorderSelection(list('a', 'b', 'c'), ['c'], 'back'))).toEqual(['c', 'a', 'b'])
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd'), ['b'], 'front'))).toEqual(['a', 'c', 'd', 'b'])
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd'), ['c'], 'back'))).toEqual(['c', 'a', 'b', 'd'])
  })
})

describe('reorderSelection: several elements keep their own relative order', () => {
  it('an adjacent pair moves forward one step as a pair', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd'), ['b', 'c'], 'forward'))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('an adjacent pair moves backward one step as a pair', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd'), ['b', 'c'], 'backward'))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('apart, each passes its own unselected neighbour', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['a', 'c'], 'forward'))).toEqual(['b', 'a', 'd', 'c', 'e'])
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['c', 'e'], 'backward'))).toEqual(['a', 'c', 'b', 'e', 'd'])
  })

  it('one that cannot move does not hold back the others', () => {
    // E is already in front; B still passes c.
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['b', 'e'], 'forward'))).toEqual(['a', 'c', 'b', 'd', 'e'])
    // A is already at the back; D still passes c.
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['a', 'd'], 'backward'))).toEqual(['a', 'b', 'd', 'c', 'e'])
  })

  it('front sends them all to the end in their own order, back to the start', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['a', 'c'], 'front'))).toEqual(['b', 'd', 'e', 'a', 'c'])
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['c', 'e'], 'back'))).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('the order the ids are given in does not matter', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['c', 'a'], 'front'))).toEqual(['b', 'd', 'e', 'a', 'c'])
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd', 'e'), ['e', 'c'], 'back'))).toEqual(['c', 'e', 'a', 'b', 'd'])
    expect(ids(reorderSelection(list('a', 'b', 'c', 'd'), ['c', 'b'], 'forward'))).toEqual(['a', 'd', 'b', 'c'])
  })
})

describe('reorderSelection: nothing to change', () => {
  it('returns the very same array when the order would not change', () => {
    const elements = list('a', 'b', 'c')
    expect(reorderSelection(elements, ['c'], 'forward')).toBe(elements)
    expect(reorderSelection(elements, ['a'], 'backward')).toBe(elements)
    expect(reorderSelection(elements, ['c'], 'front')).toBe(elements)
    expect(reorderSelection(elements, ['a'], 'back')).toBe(elements)
    // A selection already sitting at the front, or at the back.
    expect(reorderSelection(elements, ['b', 'c'], 'forward')).toBe(elements)
    expect(reorderSelection(elements, ['b', 'c'], 'front')).toBe(elements)
    expect(reorderSelection(elements, ['a', 'b'], 'backward')).toBe(elements)
    expect(reorderSelection(elements, ['a', 'b'], 'back')).toBe(elements)
  })

  it('returns the same array for an empty selection, ids that are not there, and everything selected', () => {
    const elements = list('a', 'b', 'c')
    for (const direction of ['forward', 'backward', 'front', 'back'] as const) {
      expect(reorderSelection(elements, [], direction)).toBe(elements)
      expect(reorderSelection(elements, ['ghost'], direction)).toBe(elements)
      expect(reorderSelection(elements, ['a', 'b', 'c'], direction)).toBe(elements)
    }
    expect(reorderSelection([], ['a'], 'front')).toEqual([])
  })

  it('ignores ids that are not there when others are', () => {
    expect(ids(reorderSelection(list('a', 'b', 'c'), ['a', 'ghost'], 'front'))).toEqual(['b', 'c', 'a'])
  })

  it('never mutates its input, and moves the same element objects', () => {
    const elements = list('a', 'b', 'c')
    const before = [...elements]
    const out = reorderSelection(elements, ['a'], 'front')
    expect(elements).toEqual(before)
    expect(elements.every((e, i) => e === before[i])).toBe(true)
    expect(out).not.toBe(elements)
    expect(out[2]).toBe(elements[0])
  })
})

describe('moveToLayer: a Layers row dropped (front first on screen)', () => {
  it('puts the ids just above or below the target row', () => {
    // On screen: c, b, a.
    expect(ids(moveToLayer(list('a', 'b', 'c'), ['c'], 'a', 'below'))).toEqual(['c', 'a', 'b'])
    expect(ids(moveToLayer(list('a', 'b', 'c'), ['a'], 'c', 'above'))).toEqual(['b', 'c', 'a'])
  })
  it('keeps the moved ids in their own order, whatever order they come in', () => {
    expect(ids(moveToLayer(list('a', 'b', 'c', 'd'), ['b', 'd'], 'a', 'below'))).toEqual(['b', 'd', 'a', 'c'])
  })
  it('gives the same array back when nothing would change', () => {
    const els = list('a', 'b', 'c')
    expect(moveToLayer(els, ['b'], 'b', 'above')).toBe(els)
    expect(moveToLayer(els, ['b'], 'c', 'below')).toBe(els)
    expect(moveToLayer(els, ['b'], 'x', 'below')).toBe(els)
    expect(moveToLayer(els, [], 'a', 'below')).toBe(els)
  })
})
