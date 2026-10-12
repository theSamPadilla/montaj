import { describe, it, expect } from 'vitest'
import { groupDragMove } from '../groupDrag'

const SLIDE = { w: 1080, h: 1080 }
const A = { id: 'a', x: 100, y: 100, w: 200, h: 100, rotation: 0 }
const B = { id: 'b', x: 400, y: 300, w: 100, h: 100, rotation: 0 }

describe('groupDragMove', () => {
  it('moves every member by the same delta, in canvas units', () => {
    const r = groupDragMove([A, B], { dx: 100, dy: 50 }, 0.5, SLIDE)
    expect(r.positions).toEqual([{ id: 'a', x: 300, y: 200 }, { id: 'b', x: 600, y: 400 }])
    expect(r.guides).toEqual([])
  })

  it('inside the dead zone nothing snaps', () => {
    // The group's left edge is 5 from the slide's: a snap would pull it, the dead zone does not.
    const near = { ...A, x: 5 }
    const r = groupDragMove([near, B], { dx: 3, dy: 0 }, 1, SLIDE)
    expect(r.dx).toBe(3)
    expect(r.guides).toEqual([])
  })

  it('snaps the box the group covers, so the members keep their spacing', () => {
    // Drag left 95: the union's left edge would sit at 5, and snaps to 0.
    const r = groupDragMove([A, B], { dx: -95, dy: 0 }, 1, SLIDE)
    expect(r.dx).toBe(-100)
    expect(r.positions).toEqual([{ id: 'a', x: 0, y: 100 }, { id: 'b', x: 300, y: 300 }])
    expect(r.guides).toEqual([{ axis: 'x', at: 0 }])
  })

  it('a rotated member snaps by what it covers', () => {
    // 200 x 100 turned 90 around (200, 150): covers 150..250 x 50..250.
    const turned = { ...A, rotation: 90 }
    const r = groupDragMove([turned, B], { dx: 0, dy: -45 }, 1, SLIDE)
    // Union top 50 would land at 5 and snaps to 0: delta -50, not the frame's -100.
    expect(r.dy).toBe(-50)
    expect(r.positions[0]).toEqual({ id: 'a', x: 100, y: 50 })
  })
})
