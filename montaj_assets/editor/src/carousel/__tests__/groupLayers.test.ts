import { describe, it, expect } from 'vitest'
import type { CarouselElement, ImageElement, Slide } from '../../types'
import { moveToLayer, reorderSelection } from '../layerOrder'
import { copyElements, duplicateCopies, insertCopies, pasteElements } from '../clipboard'

// Groups (§587) in layer order and copies: a group moves through the stack as
// one, its members reorder among themselves, and every copy of a whole group is
// a new group of its own.

function el(id: string, group?: string): ImageElement {
  return { id, type: 'image', src: `${id}.png`, x: 0, y: 0, w: 10, h: 10, rotation: 0, ...(group ? { group } : {}) }
}
const ids = (elements: CarouselElement[]) => elements.map((e) => e.id)
const slide = (elements: CarouselElement[]): Slide => ({ id: 's', base_color: '#fff', elements })

describe('reorderSelection with groups', () => {
  // a, [g1 g2], b: the group is one step.
  const els = [el('a'), el('g1', 'g'), el('g2', 'g'), el('b')]

  it('an element passing a group passes all of it', () => {
    expect(ids(reorderSelection(els, ['a'], 'forward'))).toEqual(['g1', 'g2', 'a', 'b'])
    expect(ids(reorderSelection(els, ['b'], 'backward'))).toEqual(['a', 'b', 'g1', 'g2'])
  })

  it('a whole group moves as one block', () => {
    expect(ids(reorderSelection(els, ['g1', 'g2'], 'forward'))).toEqual(['a', 'b', 'g1', 'g2'])
    expect(ids(reorderSelection(els, ['g2', 'g1'], 'back'))).toEqual(['g1', 'g2', 'a', 'b'])
  })

  it('one member alone (inside its group) reorders among the members only', () => {
    expect(ids(reorderSelection(els, ['g1'], 'forward'))).toEqual(['a', 'g2', 'g1', 'b'])
    expect(ids(reorderSelection(els, ['g1'], 'front'))).toEqual(['a', 'g2', 'g1', 'b'])
    expect(reorderSelection(els, ['g2'], 'forward')).toBe(els)
  })

  it('with no groups it is the plain reorder, the same array when nothing moves', () => {
    const plain = [el('a'), el('b')]
    expect(reorderSelection(plain, ['b'], 'forward')).toBe(plain)
    expect(ids(reorderSelection(plain, ['a'], 'forward'))).toEqual(['b', 'a'])
  })
})

describe('moveToLayer with groups', () => {
  // Layers lists front first: b, [g2 g1], a.
  const els = [el('a'), el('g1', 'g'), el('g2', 'g'), el('b')]

  it('dropped onto a member of a group it is not in, an element lands beside the whole group', () => {
    expect(ids(moveToLayer(els, ['b'], 'g1', 'above'))).toEqual(['a', 'g1', 'g2', 'b'])
    expect(ids(moveToLayer(els, ['b'], 'g1', 'below'))).toEqual(['a', 'b', 'g1', 'g2'])
    expect(ids(moveToLayer(els, ['a'], 'g2', 'above'))).toEqual(['g1', 'g2', 'a', 'b'])
  })

  it('a member moves only among its own group', () => {
    expect(ids(moveToLayer(els, ['g1'], 'g2', 'above'))).toEqual(['a', 'g2', 'g1', 'b'])
    expect(moveToLayer(els, ['g1'], 'b', 'above')).toBe(els)
  })

  it('a whole group moves as one block', () => {
    expect(ids(moveToLayer(els, ['g1', 'g2'], 'a', 'below'))).toEqual(['g1', 'g2', 'a', 'b'])
    expect(ids(moveToLayer(els, ['g2', 'g1'], 'b', 'above'))).toEqual(['a', 'b', 'g1', 'g2'])
  })
})

describe('copies of a group', () => {
  const els = [el('a'), el('g1', 'g'), el('g2', 'g'), el('b')]

  it('a paste of a whole group is a new group, the same new id on every copy', () => {
    const clip = copyElements(slide(els), ['g1', 'g2'])!
    const pasted = pasteElements(clip, slide(els))
    expect(pasted.map((e) => e.group)).toEqual([pasted[0].group, pasted[0].group])
    expect(pasted[0].group).toBeTruthy()
    expect(pasted[0].group).not.toBe('g')
  })

  it('a duplicate of a whole group is a new group, gathered in front of the original group', () => {
    const copies = duplicateCopies(els, ['g1', 'g2'])
    const next = insertCopies(els, copies)
    const c1 = copies.get('g1')!
    const c2 = copies.get('g2')!
    expect(ids(next)).toEqual(['a', 'g1', 'g2', c1.id, c2.id, 'b'])
    expect(c1.group).toBe(c2.group)
    expect(c1.group).not.toBe('g')
  })

  it('a duplicate of one member alone stays in its group, just in front of it', () => {
    const copies = duplicateCopies(els, ['g1'])
    const c = copies.get('g1')!
    expect(c.group).toBe('g')
    expect(ids(insertCopies(els, copies))).toEqual(['a', 'g1', c.id, 'g2', 'b'])
  })
})
