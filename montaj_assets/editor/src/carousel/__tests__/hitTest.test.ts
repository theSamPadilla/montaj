import { describe, it, expect } from 'vitest'
import type { CarouselElement } from '../../types'
import { elementsAt, nextLayerDown } from '../hitTest'

const box = (id: string, x: number, y: number, w: number, h: number, rotation = 0): CarouselElement =>
  ({ id, type: 'image', src: `${id}.png`, x, y, w, h, rotation }) as CarouselElement

describe('elementsAt (§586 M1)', () => {
  it('lists the elements under the point front to back', () => {
    const els = [box('back', 0, 0, 100, 100), box('mid', 20, 20, 100, 100), box('front', 40, 40, 100, 100), box('far', 500, 500, 10, 10)]
    expect(elementsAt({ x: 60, y: 60 }, els)).toEqual(['front', 'mid', 'back'])
    expect(elementsAt({ x: 10, y: 10 }, els)).toEqual(['back'])
    expect(elementsAt({ x: 300, y: 300 }, els)).toEqual([])
  })

  it('skips hidden elements', () => {
    const els = [box('a', 0, 0, 100, 100), box('b', 0, 0, 100, 100)]
    expect(elementsAt({ x: 50, y: 50 }, els, new Set(['b']))).toEqual(['a'])
  })

  it('hits a turned element by its turned box, not the box it had before turning', () => {
    // 200 x 20 centred on (100, 100), turned a quarter: it now stands 20 wide, 200 tall.
    const bar = box('bar', 0, 90, 200, 20, 90)
    expect(elementsAt({ x: 100, y: 10 }, [bar])).toEqual(['bar'])
    expect(elementsAt({ x: 100, y: 190 }, [bar])).toEqual(['bar'])
    expect(elementsAt({ x: 10, y: 100 }, [bar])).toEqual([])
    expect(elementsAt({ x: 190, y: 100 }, [bar])).toEqual([])
  })

  it('hits a 45 degree box at its middle and misses the corner of its unturned frame', () => {
    const sq = box('sq', 0, 0, 100, 100, 45)
    expect(elementsAt({ x: 50, y: 50 }, [sq])).toEqual(['sq'])
    expect(elementsAt({ x: 2, y: 2 }, [sq])).toEqual([])
    expect(elementsAt({ x: 50, y: -10 }, [sq])).toEqual(['sq'])
  })
})

describe('nextLayerDown (§586 M1)', () => {
  const stack = ['c', 'b', 'a']
  it('starts at the topmost with nothing selected, or a selection not under the pointer', () => {
    expect(nextLayerDown(stack, [])).toBe('c')
    expect(nextLayerDown(stack, ['z'])).toBe('c')
  })
  it('goes one down and wraps from the bottom', () => {
    expect(nextLayerDown(stack, ['c'])).toBe('b')
    expect(nextLayerDown(stack, ['b'])).toBe('a')
    expect(nextLayerDown(stack, ['a'])).toBe('c')
  })
  it('starts from the frontmost selected one under the pointer', () => {
    expect(nextLayerDown(stack, ['a', 'b'])).toBe('a')
  })
  it('is null with nothing under the pointer', () => {
    expect(nextLayerDown([], ['a'])).toBeNull()
  })
})
