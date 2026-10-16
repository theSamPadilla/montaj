// A 3D item (`src: 'engine:scene3d'`) shows its 3D's frame at `props.inPoint +
// (t - start)`. Edits that move its head while its content stays where it was
// on the timeline move `inPoint` with it, so the picture never jumps: the right
// half of a split continues where the left half ended, and a head trim shows
// the same 3D frame at the same timeline time as before.
import { describe, it, expect } from 'vitest'
import { applyCutToItem, applyCutToTracks, rollEdit, slideItem, splitAtTime } from '../cuts'
import { computeResizedItem, type Draggable } from '../timeline/useItemDragDrop'
import { SCENE3D_SRC } from '../scene3d'
import type { EditorProject as Project, VisualItem } from '../../schema'

const scene = (id: string, start: number, end: number, props: Record<string, unknown> = { scene: 'lab', inPoint: 1 }): VisualItem =>
  ({ id, type: 'overlay', src: SCENE3D_SRC, start, end, props })

/** The 3D time an item shows at timeline time `t`. */
const sceneTime = (item: { start: number; props?: Record<string, unknown> }, t: number) =>
  ((item.props?.inPoint as number | undefined) ?? 0) + (t - item.start)

const project = (...tracks: VisualItem[][]): Project => ({
  id: 'p', status: 'draft', settings: { resolution: [1080, 1920] },
  tracks: tracks.map((items, i) => ({ id: `trk-${i}`, items })),
})
const itemsOf = (p: Project, track: number) => (p.tracks![track] as { items: VisualItem[] }).items

describe('a 3D item keeps its picture in place', () => {
  it('a head trim moves the in point with the edge', () => {
    const item = scene('s', 2, 6)
    const trimmed = computeResizedItem(item as Draggable, 'start', 3)
    expect(trimmed).toMatchObject({ start: 3, end: 6, props: { scene: 'lab', inPoint: 2 } })
    for (const t of [3, 4.5, 5.9]) expect(sceneTime(trimmed, t)).toBeCloseTo(sceneTime(item, t))
    expect(item.props).toEqual({ scene: 'lab', inPoint: 1 }) // the input is not mutated
  })

  it('a head extended earlier stops where its 3D begins', () => {
    expect(computeResizedItem(scene('s', 2, 6) as Draggable, 'start', 0)).toMatchObject({ start: 1, props: { inPoint: 0 } })
    expect(computeResizedItem(scene('s', 2, 6, { scene: 'lab' }) as Draggable, 'start', 0)).toMatchObject({ start: 2 })
    const extended = computeResizedItem(scene('s', 2, 6) as Draggable, 'start', 1.5)
    expect(extended).toMatchObject({ start: 1.5, props: { inPoint: 0.5 } })
  })

  it('a tail trim leaves the in point alone', () => {
    const item = scene('s', 2, 6)
    const trimmed = computeResizedItem(item as Draggable, 'end', 4)
    expect(trimmed).toMatchObject({ start: 2, end: 4 })
    expect(trimmed.props).toBe(item.props)
  })

  it('any other overlay trims as it always did', () => {
    const plain = { id: 'o', type: 'overlay', src: '/p/card.jsx', start: 2, end: 6, props: { inPoint: 1 } }
    expect(computeResizedItem(plain, 'start', 0)).toEqual({ ...plain, start: 0 })
  })

  it('the right half of a split continues the 3D where the left half ended', () => {
    const item = scene('s', 2, 6)
    const [left, right] = itemsOf(splitAtTime(project([item]), 3.5, 's'), 0)
    expect(left).toMatchObject({ start: 2, end: 3.5, props: { inPoint: 1 } })
    expect(right).toMatchObject({ start: 3.5, end: 6, props: { scene: 'lab', inPoint: 2.5 } })
    expect(sceneTime(right, right.start)).toBeCloseTo(sceneTime(left, left.end))
    for (const t of [4, 5.5]) expect(sceneTime(right, t)).toBeCloseTo(sceneTime(item, t))
  })

  it('a split with no in point yet gives the right half one', () => {
    const [, right] = itemsOf(splitAtTime(project([scene('s', 2, 6, { scene: 'lab' })]), 3, 's'), 0)
    expect(right.props).toEqual({ scene: 'lab', inPoint: 1 })
  })

  it('a lift cut on the base track trims and splits a 3D item in place', () => {
    const cut = applyCutToTracks(project([scene('a', 0, 4), scene('b', 5, 10)]), { start: 3, end: 6 })
    const [a, b] = itemsOf(cut, 0)
    expect(a).toMatchObject({ start: 0, end: 3, props: { inPoint: 1 } })
    expect(b).toMatchObject({ start: 6, end: 10, props: { inPoint: 2 } })
    const spans = itemsOf(applyCutToTracks(project([scene('s', 0, 10)]), { start: 3, end: 6 }), 0)
    expect(spans.map(i => [i.start, i.end, i.props?.inPoint])).toEqual([[0, 3, 1], [6, 10, 7]])
  })

  it('a collapse cut picks the 3D up where the removed range ended', () => {
    const [left, right] = itemsOf(applyCutToItem(project([], [scene('s', 2, 8)]), 's', { start: 3, end: 5 }), 1)
    expect(left).toMatchObject({ start: 2, end: 3, props: { inPoint: 1 } })
    expect(right).toMatchObject({ start: 3, end: 6, props: { inPoint: 4 } })
  })

  it('a roll carries the right item\'s in point, and stops where its 3D begins', () => {
    const p = project([scene('l', 0, 4, { scene: 'a', inPoint: 0 }), scene('r', 4, 8, { scene: 'b', inPoint: 1 })])
    const later = itemsOf(rollEdit(p, 'l', 'r', 0.5), 0)
    expect(later[1]).toMatchObject({ start: 4.5, props: { scene: 'b', inPoint: 1.5 } })
    expect(later[0].props).toEqual({ scene: 'a', inPoint: 0 })
    const earlier = itemsOf(rollEdit(p, 'l', 'r', -3), 0)
    expect(earlier[1]).toMatchObject({ start: 3, props: { inPoint: 0 } })
  })

  it('a slide carries the next neighbour\'s in point', () => {
    const p = project([scene('a', 0, 2), scene('b', 2, 4), scene('c', 4, 8, { scene: 'c', inPoint: 0.5 })])
    const [, , c] = itemsOf(slideItem(p, 'b', 0.25), 0)
    expect(c).toMatchObject({ start: 4.25, props: { inPoint: 0.75 } })
    const [, , back] = itemsOf(slideItem(p, 'b', -1), 0)
    expect(back).toMatchObject({ start: 3.5, props: { inPoint: 0 } })
  })
})
