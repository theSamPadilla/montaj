import { describe, it, expect } from 'vitest'
import { snapToSlide, snapToSlideAndElements } from '../snap'

// Smart guides (§586 M7): a dragged box snaps to the slide and to the other
// elements' edges and centres, both by the box each covers when turned, and
// sits at equal gaps between two neighbours that overlap it on the other axis.

const SLIDE = { w: 1080, h: 1080 }
const T = 8
// A neighbour, 100 square at 500, 500: x and y targets 500, 550, 600.
const N = { x: 500, y: 500, w: 100, h: 100 }

describe('snapToSlideAndElements: a neighbour', () => {
  // A 40 square at y 200 (and x 200 for the y cases) is near nothing else.
  it.each([
    ['left', 497, 500, 500],
    ['centre', 532, 530, 550],
    ['right', 562, 560, 600],
  ])("x snaps to the neighbour's %s", (_side, from, to, at) => {
    const r = snapToSlideAndElements({ x: from, y: 200, w: 40, h: 40 }, SLIDE, [N], T)
    expect(r.position).toEqual({ x: to, y: 200 })
    expect(r.guides).toEqual([{ axis: 'x', at }])
    expect(r.gaps).toEqual([])
  })

  it.each([
    ['top', 497, 500, 500],
    ['middle', 532, 530, 550],
    ['bottom', 562, 560, 600],
  ])("y snaps to the neighbour's %s", (_side, from, to, at) => {
    const r = snapToSlideAndElements({ x: 200, y: from, w: 40, h: 40 }, SLIDE, [N], T)
    expect(r.position).toEqual({ x: 200, y: to })
    expect(r.guides).toEqual([{ axis: 'y', at }])
  })

  it('nothing snaps beyond the threshold', () => {
    const r = snapToSlideAndElements({ x: 491, y: 200, w: 40, h: 40 }, SLIDE, [N], T)
    expect(r.position).toEqual({ x: 491, y: 200 })
    expect(r.guides).toEqual([])
    expect(r.gaps).toEqual([])
  })

  it('a turned neighbour counts by the box it covers', () => {
    // 200 x 100 at 500, 500 turned 90 around (600, 550): covers x 550..650.
    const turned = { x: 500, y: 500, w: 200, h: 100, rotation: 90 }
    const r = snapToSlideAndElements({ x: 647, y: 200, w: 40, h: 40 }, SLIDE, [turned], T)
    expect(r.position.x).toBeCloseTo(650, 9)
    expect(r.guides).toEqual([{ axis: 'x', at: 650 }])
  })

  it('a turned dragged box snaps by what it covers, the offset applied to its x', () => {
    // 200 x 100 at x 453 turned 90 covers x 503..603: its left edge snaps to
    // 500 (and its right to 600). Its own frame, 453..653, is near nothing.
    const neighbour = { x: 500, y: 500, w: 200, h: 100 }
    const r = snapToSlideAndElements({ x: 453, y: 300, w: 200, h: 100, rotation: 90 }, SLIDE, [neighbour], T)
    expect(r.position).toEqual({ x: 450, y: 300 })
    expect(r.guides).toEqual([{ axis: 'x', at: 500 }])
    // Unturned, the same box stays where it is.
    const flat = snapToSlideAndElements({ x: 453, y: 300, w: 200, h: 100 }, SLIDE, [neighbour], T)
    expect(flat.position).toEqual({ x: 453, y: 300 })
  })

  it('the slide still snaps, as snapToSlide does, and a turned box snaps to it by what it covers', () => {
    const box = { x: 5, y: 1080 - 105, w: 200, h: 100 }
    expect(snapToSlideAndElements(box, SLIDE, [], T)).toEqual({ ...snapToSlide(box, SLIDE, T), gaps: [] })
    expect(snapToSlideAndElements(box, SLIDE, [], T).position).toEqual({ x: 0, y: 980 })
    // 200 x 100 turned 90 at x -47 covers x 3..103: its left edge snaps to 0.
    const r = snapToSlideAndElements({ x: -47, y: 300, w: 200, h: 100, rotation: 90 }, SLIDE, [], T)
    expect(r.position.x).toBeCloseTo(-50, 9)
    expect(r.guides).toEqual([{ axis: 'x', at: 0 }])
  })

  it('with skip, nothing snaps and no guide shows', () => {
    const r = snapToSlideAndElements({ x: 497, y: 3, w: 40, h: 40 }, SLIDE, [N], T, { skip: true })
    expect(r).toEqual({ position: { x: 497, y: 3 }, guides: [], gaps: [] })
  })
})

describe('snapToSlideAndElements: equal gaps', () => {
  // Two 100 squares at x 100 and x 500, y 300: a 100 square between them is
  // at equal gaps at x 300.
  const L = { x: 100, y: 300, w: 100, h: 100 }
  const R = { x: 500, y: 300, w: 100, h: 100 }

  it('between two neighbours both overlapping it on y, x snaps to equal gaps, each gap a segment', () => {
    const r = snapToSlideAndElements({ x: 297, y: 320, w: 100, h: 100 }, SLIDE, [L, R], T)
    expect(r.position).toEqual({ x: 300, y: 320 })
    expect(r.guides).toEqual([])
    // Each segment is drawn halfway down the overlap of the box and that neighbour (320..400).
    expect(r.gaps).toEqual([
      { axis: 'x', from: 200, to: 300, at: 360 },
      { axis: 'x', from: 400, to: 500, at: 360 },
    ])
  })

  it('not when one neighbour does not overlap it on y', () => {
    const below = { ...R, y: 700 }
    const r = snapToSlideAndElements({ x: 297, y: 320, w: 100, h: 100 }, SLIDE, [L, below], T)
    expect(r.position).toEqual({ x: 297, y: 320 })
    expect(r.gaps).toEqual([])
  })

  it('not when the gaps differ by more than the threshold', () => {
    const r = snapToSlideAndElements({ x: 280, y: 320, w: 100, h: 100 }, SLIDE, [L, R], T)
    expect(r.position).toEqual({ x: 280, y: 320 })
    expect(r.gaps).toEqual([])
  })

  it('on y too, between neighbours above and below that overlap it on x', () => {
    const above = { x: 300, y: 100, w: 100, h: 100 }
    const below = { x: 300, y: 500, w: 100, h: 100 }
    const r = snapToSlideAndElements({ x: 320, y: 303, w: 100, h: 100 }, SLIDE, [above, below], T)
    expect(r.position).toEqual({ x: 320, y: 300 })
    expect(r.gaps).toEqual([
      { axis: 'y', from: 200, to: 300, at: 360 },
      { axis: 'y', from: 400, to: 500, at: 360 },
    ])
    const aside = snapToSlideAndElements({ x: 320, y: 303, w: 100, h: 100 }, SLIDE, [above, { ...below, x: 700 }], T)
    expect(aside.position).toEqual({ x: 320, y: 303 })
    expect(aside.gaps).toEqual([])
  })
})
