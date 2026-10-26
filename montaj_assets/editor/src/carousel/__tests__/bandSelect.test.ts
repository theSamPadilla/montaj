import { describe, it, expect } from 'vitest'
import { bandRect, bandTouches } from '../bandSelect'

describe('bandRect', () => {
  it('spans the two points whichever way it was dragged', () => {
    expect(bandRect({ x: 50, y: 40 }, { x: 10, y: 90 })).toEqual({ x: 10, y: 40, w: 40, h: 50 })
  })
})

describe('bandTouches (§586 M6)', () => {
  const box = { x: 100, y: 100, w: 200, h: 100, rotation: 0 }

  it('an unturned box is touched by an overlapping, containing or contained band', () => {
    expect(bandTouches(box, { x: 250, y: 150, w: 100, h: 100 })).toBe(true)
    expect(bandTouches(box, { x: 0, y: 0, w: 1000, h: 1000 })).toBe(true)
    expect(bandTouches(box, { x: 150, y: 120, w: 10, h: 10 })).toBe(true)
  })

  it('a band clear of the box does not touch it', () => {
    expect(bandTouches(box, { x: 301, y: 100, w: 50, h: 50 })).toBe(false)
    expect(bandTouches(box, { x: 100, y: 201, w: 50, h: 50 })).toBe(false)
  })

  it('edges that meet touch', () => {
    expect(bandTouches(box, { x: 300, y: 100, w: 50, h: 50 })).toBe(true)
  })

  it('a turned box is its turned outline, not its bounding box', () => {
    // 45 degrees: a 200 x 100 box at (100,100), centre (200,150), turned.
    const turned = { ...box, rotation: 45 }
    // The bounding box's top-left corner area is empty of the turned shape.
    const corner = { x: 100 + 200 / 2 - 106 - 5, y: 150 - 106 - 5, w: 8, h: 8 }
    expect(bandTouches({ ...box, rotation: 0 }, corner)).toBe(false)
    const aabbCorner = { x: 200 - 106, y: 150 - 106, w: 12, h: 12 }
    expect(bandTouches(turned, aabbCorner)).toBe(false)
    // Over its centre it is touched.
    expect(bandTouches(turned, { x: 195, y: 145, w: 10, h: 10 })).toBe(true)
  })

  it('a tall box turned a quarter turn covers the width it was tall', () => {
    const tall = { x: 100, y: 100, w: 20, h: 200, rotation: 90 }
    // Centre (110, 200): turned, it spans x 10..210, y 190..210.
    expect(bandTouches(tall, { x: 190, y: 195, w: 5, h: 5 })).toBe(true)
    expect(bandTouches(tall, { x: 105, y: 110, w: 5, h: 5 })).toBe(false)
  })
})
