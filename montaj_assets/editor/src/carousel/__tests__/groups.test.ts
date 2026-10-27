import { describe, it, expect } from 'vitest'
import type { CarouselElement, ImageElement, OverlayElement } from '../../types'
import {
  canGroup,
  canUngroup,
  expandToGroups,
  freshGroupIds,
  groupBox,
  groupElements,
  groupMemberIds,
  groupOf,
  normalizeGroups,
  rotateMembers,
  roundedMemberBoxes,
  scaleMembers,
  selectionAfterPress,
  toggleGroupSelection,
  ungroupElements,
  wholeGroup,
} from '../groups'

// Index 0 is the back of the slide, the last index the front.
function el(id: string, extra: Partial<ImageElement> = {}): ImageElement {
  return { id, type: 'image', src: `${id}.png`, x: 0, y: 0, w: 10, h: 10, rotation: 0, ...extra }
}
function text(id: string, extra: Partial<OverlayElement> = {}): OverlayElement {
  return { id, type: 'overlay', overlay: { template: 't.jsx', props: { text: 'Hi', fontSize: '80' } }, frame: 0, x: 0, y: 0, w: 100, h: 50, rotation: 0, ...extra }
}
const ids = (elements: CarouselElement[]) => elements.map((e) => e.id)
const groups = (elements: CarouselElement[]) => elements.map((e) => e.group ?? '-')

describe('groupOf / groupMemberIds / wholeGroup', () => {
  const els = [el('a', { group: 'g' }), el('b'), el('c', { group: 'g' }), el('d', { group: 'h' }), el('e', { group: 'h' })]

  it('reads the group id; an empty or non-string one is no group', () => {
    expect(groupOf(els[0])).toBe('g')
    expect(groupOf(els[1])).toBeUndefined()
    expect(groupOf(el('x', { group: '' }))).toBeUndefined()
    expect(groupOf({ ...el('x'), group: 3 } as unknown as CarouselElement)).toBeUndefined()
  })

  it('lists a group\'s members back to front', () => {
    expect(groupMemberIds(els, 'g')).toEqual(['a', 'c'])
    expect(groupMemberIds(els, 'nope')).toEqual([])
  })

  it('names the group when the ids are exactly its members, in any order', () => {
    expect(wholeGroup(els, ['c', 'a'])).toBe('g')
    expect(wholeGroup(els, ['a'])).toBeNull()
    expect(wholeGroup(els, ['a', 'c', 'b'])).toBeNull()
    expect(wholeGroup(els, ['a', 'c', 'd', 'e'])).toBeNull()
    expect(wholeGroup(els, [])).toBeNull()
  })
})

describe('expandToGroups', () => {
  const els = [el('a', { group: 'g' }), el('b'), el('c', { group: 'g' }), el('d')]
  it('replaces each grouped id with its whole group, once, the rest kept in order', () => {
    expect(expandToGroups(els, ['b', 'c'])).toEqual(['b', 'a', 'c'])
    expect(expandToGroups(els, ['a', 'c', 'd'])).toEqual(['a', 'c', 'd'])
    expect(expandToGroups(els, ['d'])).toEqual(['d'])
  })
})

describe('selectionAfterPress: a press on an element selects its whole group', () => {
  const els = [el('a', { group: 'g' }), el('b', { group: 'g' }), el('c')]
  it('a member of a group not entered selects the group', () => {
    expect(selectionAfterPress(els, 'a', [])).toEqual(['a', 'b'])
    expect(selectionAfterPress(els, 'b', ['c'])).toEqual(['a', 'b'])
  })
  it('inside an entered group (one member selected) a press on a member selects that member', () => {
    expect(selectionAfterPress(els, 'b', ['a'])).toEqual(['b'])
  })
  it('an ungrouped element is selected alone', () => {
    expect(selectionAfterPress(els, 'c', ['a', 'b'])).toEqual(['c'])
  })
})

describe('toggleGroupSelection: shift on a member adds or takes out its whole group', () => {
  const els = [el('a', { group: 'g' }), el('b', { group: 'g' }), el('c')]
  it('adds the group when any member is out', () => {
    expect(toggleGroupSelection(els, 'a', ['c'])).toEqual(['c', 'a', 'b'])
    expect(toggleGroupSelection(els, 'a', ['c', 'b'])).toEqual(['c', 'b', 'a'])
  })
  it('takes it out when all are in', () => {
    expect(toggleGroupSelection(els, 'b', ['a', 'c', 'b'])).toEqual(['c'])
  })
})

describe('canGroup / canUngroup', () => {
  const els = [el('a'), el('b'), el('c', { group: 'g' }), el('d', { group: 'g' }), el('e', { locked: true })]
  it('groups two or more that are not already exactly one group, none locked', () => {
    expect(canGroup(els, ['a', 'b'])).toBe(true)
    expect(canGroup(els, ['a'])).toBe(false)
    expect(canGroup(els, ['c', 'd'])).toBe(false)
    expect(canGroup(els, ['a', 'c', 'd'])).toBe(true)
    expect(canGroup(els, ['a', 'e'])).toBe(false)
  })
  it('ungroups a selection holding a whole group with no locked member', () => {
    expect(canUngroup(els, ['c', 'd'])).toBe(true)
    expect(canUngroup(els, ['a', 'b'])).toBe(false)
    const locked = els.map((e) => (e.id === 'd' ? { ...e, locked: true } : e))
    expect(canUngroup(locked, ['c', 'd'])).toBe(false)
  })
})

describe('groupElements', () => {
  it('gives the members the group id and gathers them at the frontmost member, in their order', () => {
    const next = groupElements([el('a'), el('b'), el('c'), el('d'), el('e')], ['d', 'b'], 'g')
    expect(ids(next)).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(groups(next)).toEqual(['-', '-', 'g', 'g', '-'])
  })

  it('merges groups it takes in whole: their members join the new group', () => {
    const next = groupElements([el('a', { group: 'h' }), el('b', { group: 'h' }), el('c'), el('d')], ['a', 'b', 'd'], 'g')
    expect(ids(next)).toEqual(['c', 'a', 'b', 'd'])
    expect(groups(next)).toEqual(['-', 'g', 'g', 'g'])
  })

  it('changes nothing for fewer than two elements', () => {
    const els = [el('a'), el('b')]
    expect(groupElements(els, ['a'], 'g')).toBe(els)
  })

  it('never touches the boxes', () => {
    const next = groupElements([el('a', { x: 5, y: 6 }), el('b', { x: 7, y: 8, rotation: 30 })], ['a', 'b'], 'g')
    expect(next.map((e) => [e.x, e.y, e.w, e.h, e.rotation])).toEqual([[5, 6, 10, 10, 0], [7, 8, 10, 10, 30]])
  })
})

describe('ungroupElements', () => {
  it('drops the group field from every member of each group the ids touch', () => {
    const next = ungroupElements([el('a', { group: 'g' }), el('b', { group: 'g' }), el('c', { group: 'h' })], ['a'])
    expect(groups(next)).toEqual(['-', '-', 'h'])
    expect('group' in next[0]).toBe(false)
  })
  it('gives the same array back when nothing is grouped', () => {
    const els = [el('a'), el('b')]
    expect(ungroupElements(els, ['a'])).toBe(els)
  })
})

describe('normalizeGroups', () => {
  it('makes each group contiguous at its frontmost member', () => {
    const next = normalizeGroups([el('a', { group: 'g' }), el('x'), el('b', { group: 'g' }), el('y')])
    expect(ids(next)).toEqual(['x', 'a', 'b', 'y'])
  })
  it('gives the same array back when every group already is', () => {
    const els = [el('a', { group: 'g' }), el('b', { group: 'g' }), el('c')]
    expect(normalizeGroups(els)).toBe(els)
  })
})

describe('freshGroupIds', () => {
  it('gives each group a new id, the same new id to all its members', () => {
    let n = 0
    const next = freshGroupIds([el('a', { group: 'g' }), el('b', { group: 'g' }), el('c'), el('d', { group: 'h' })], () => `n${++n}`)
    expect(groups(next)).toEqual(['n1', 'n1', '-', 'n2'])
  })
})

describe('groupBox', () => {
  it('is the union of the members\' boxes as drawn, turned ones by what they cover', () => {
    expect(groupBox([el('a', { x: 10, y: 20, w: 30, h: 40 }), el('b', { x: 100, y: 0, w: 10, h: 10 })])).toEqual({ x: 10, y: 0, w: 100, h: 60 })
    const turned = groupBox([el('a', { x: 0, y: 0, w: 100, h: 20, rotation: 90 })])
    expect(turned.x).toBeCloseTo(40)
    expect(turned.y).toBeCloseTo(-40)
    expect(turned.w).toBeCloseTo(20)
    expect(turned.h).toBeCloseTo(100)
  })
})

describe('scaleMembers', () => {
  const from = { x: 0, y: 0, w: 200, h: 100 }
  const members = [el('a', { x: 0, y: 0, w: 100, h: 100 }), el('b', { x: 150, y: 25, w: 50, h: 50 })]

  it('a uniform scale scales every box and its place about the group box', () => {
    const out = scaleMembers(members, from, { x: 0, y: 0, w: 400, h: 200 })
    expect(out).toEqual([
      { id: 'a', x: 0, y: 0, w: 200, h: 200, rotation: 0, ratio: 2 },
      { id: 'b', x: 300, y: 50, w: 100, h: 100, rotation: 0, ratio: 2 },
    ])
  })

  it('a stretch scales each axis on its own; the ratio is 1 (text keeps its size)', () => {
    const out = scaleMembers(members, from, { x: 100, y: 0, w: 100, h: 100 })
    expect(out[0]).toEqual({ id: 'a', x: 100, y: 0, w: 50, h: 100, rotation: 0, ratio: 1 })
    expect(out[1]).toEqual({ id: 'b', x: 175, y: 25, w: 25, h: 50, rotation: 0, ratio: 1 })
  })

  it('a turned member keeps its turn, and its centre lands where the scale puts it', () => {
    const turned = [el('a', { x: 50, y: 25, w: 100, h: 50, rotation: 90 })]
    const [m] = scaleMembers(turned, from, { x: 0, y: 0, w: 400, h: 200 })
    expect(m.rotation).toBe(90)
    expect(m.x + m.w / 2).toBeCloseTo(200)
    expect(m.y + m.h / 2).toBeCloseTo(100)
    expect(m.w).toBeCloseTo(200)
    expect(m.h).toBeCloseTo(100)
  })
})

describe('rotateMembers', () => {
  it('turns each member about the centre: its centre goes round, its rotation adds the turn', () => {
    const members = [el('a', { x: 0, y: 0, w: 20, h: 20 }), el('b', { x: 80, y: 0, w: 20, h: 20, rotation: 350 })]
    const out = rotateMembers(members, { x: 50, y: 10 }, 90)
    // a's centre (10, 10) is 40 left of (50, 10): a quarter turn clockwise (y down) puts it 40 above.
    expect(out[0].x + 10).toBeCloseTo(50)
    expect(out[0].y + 10).toBeCloseTo(-30)
    expect(out[0].rotation).toBe(90)
    expect(out[1].x + 10).toBeCloseTo(50)
    expect(out[1].y + 10).toBeCloseTo(50)
    expect(out[1].rotation).toBe(80)
  })
})

describe('roundedMemberBoxes', () => {
  it('rounds w and h, then x and y from the centre, and keeps at least 1 px', () => {
    expect(roundedMemberBoxes([{ id: 'a', x: 10.4, y: 0.4, w: 20.6, h: 0.2, rotation: 12.6, ratio: 1 }])).toEqual([
      { id: 'a', x: 10, y: 0, w: 21, h: 1, rotation: 12.6, ratio: 1 },
    ])
  })
})

it('text boxes of a uniform group scale keep a ratio the canvas scales their font by', () => {
  const [m] = scaleMembers([text('t', { x: 0, y: 0, w: 100, h: 50 })], { x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 150, h: 75 })
  expect(m.ratio).toBeCloseTo(1.5)
})
