/// <reference types="vitest/globals" />
import { startResize, nextResizeBox, roundResizedBox, type ResizeHandle, type ResizeState } from '../resize'

type Box = { x: number; y: number; w: number; h: number }
type Point = { x: number; y: number }

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CORNERS: ResizeHandle[] = ['nw', 'ne', 'se', 'sw']
const SIDES: ResizeHandle[] = ['n', 'e', 's', 'w']
const ROTATIONS = [0, 30, 90, -135]
const SCALE = 0.5
const START: Box = { x: 100, y: 200, w: 300, h: 150 }
const PRESS: Point = { x: 500, y: 500 }
// Cursor travel in screen px: out, in and across, small enough that no side
// reaches the minimum size.
const MOVES: Point[] = [
  { x: 37, y: -22 },
  { x: -45, y: 18 },
  { x: 12, y: 51 },
  { x: -30, y: -40 },
]

// Which way a handle sits from the box centre, in the box's own axes.
function signs(handle: ResizeHandle) {
  return {
    sx: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    sy: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0,
  }
}

// Where the point (sx * w/2, sy * h/2) from the centre of a box turned
// `rotation` degrees clockwise about its centre lands on the slide (y down).
function at(box: Box, rotation: number, sx: number, sy: number): Point {
  const t = (rotation * Math.PI) / 180
  const u = (sx * box.w) / 2
  const v = (sy * box.h) / 2
  return {
    x: box.x + box.w / 2 + Math.cos(t) * u - Math.sin(t) * v,
    y: box.y + box.h / 2 + Math.sin(t) * u + Math.cos(t) * v,
  }
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const slideUnits = (move: Point): Point => ({ x: move.x / SCALE, y: move.y / SCALE })

function resize(handle: ResizeHandle, rotation: number, move: Point, keepRatio: boolean, box: Box = START): Box {
  const state = startResize('el', handle, PRESS, { ...box, rotation })
  return nextResizeBox(state, { x: PRESS.x + move.x, y: PRESS.y + move.y }, SCALE, { keepRatio })
}

// The resize before §556 M3, verbatim: the cursor's travel applied straight to
// the unrotated box.
function before(state: ResizeState, cursor: Point, scale: number): Box {
  const dx = (cursor.x - state.startCursor.x) / scale
  const dy = (cursor.y - state.startCursor.y) / scale
  let { x, y, w, h } = state.startBox
  if (state.handle.includes('w')) {
    const proposedW = state.startBox.w - dx
    if (proposedW < 1) {
      x = state.startBox.x + state.startBox.w - 1
      w = 1
    } else {
      x = state.startBox.x + dx
      w = proposedW
    }
  }
  if (state.handle.includes('e')) {
    w = state.startBox.w + dx
  }
  if (state.handle.includes('n')) {
    const proposedH = state.startBox.h - dy
    if (proposedH < 1) {
      y = state.startBox.y + state.startBox.h - 1
      h = 1
    } else {
      y = state.startBox.y + dy
      h = proposedH
    }
  }
  if (state.handle.includes('s')) {
    h = state.startBox.h + dy
  }
  return { x, y, w: Math.max(w, 1), h: Math.max(h, 1) }
}

describe.each(ROTATIONS)('nextResizeBox, box turned %i°', (rotation) => {
  it.each(HANDLES)('%s: the opposite point stays put, and after the commit rounding it is off by at most 1 px', (handle) => {
    const { sx, sy } = signs(handle)
    const pin = at(START, rotation, -sx, -sy)
    for (const keepRatio of [true, false]) {
      for (const move of MOVES) {
        const next = resize(handle, rotation, move, keepRatio)
        expect(dist(at(next, rotation, -sx, -sy), pin)).toBeLessThan(1e-6)

        const kept = roundResizedBox(next, handle, rotation)
        for (const v of Object.values(kept)) expect(Number.isInteger(v)).toBe(true)
        expect(dist(at(kept, rotation, -sx, -sy), pin)).toBeLessThanOrEqual(1)
      }
    }
  })

  it.each(CORNERS)('%s, ratio free: the dragged corner lands on the cursor', (handle) => {
    const { sx, sy } = signs(handle)
    const corner = at(START, rotation, sx, sy)
    for (const move of MOVES) {
      const d = slideUnits(move)
      const next = resize(handle, rotation, move, false)
      expect(dist(at(next, rotation, sx, sy), { x: corner.x + d.x, y: corner.y + d.y })).toBeLessThan(1e-6)
    }
  })

  it.each(SIDES)('%s: the dragged side follows the cursor along its own axis, and lands on it when the cursor moves along that axis', (handle) => {
    const { sx, sy } = signs(handle)
    const t = (rotation * Math.PI) / 180
    // The box's own x axis for e and w, its own y axis for n and s.
    const axis = sx !== 0 ? { x: Math.cos(t), y: Math.sin(t) } : { x: -Math.sin(t), y: Math.cos(t) }
    const side = at(START, rotation, sx, sy)
    for (const keepRatio of [true, false]) {
      for (const move of MOVES) {
        const d = slideUnits(move)
        const along = d.x * axis.x + d.y * axis.y
        const next = resize(handle, rotation, move, keepRatio)
        expect(dist(at(next, rotation, sx, sy), { x: side.x + along * axis.x, y: side.y + along * axis.y })).toBeLessThan(1e-6)
      }
      // 40 slide units straight out along the axis: exactly on the cursor.
      const out = { x: axis.x * 40 * (sx || sy) * SCALE, y: axis.y * 40 * (sx || sy) * SCALE }
      const next = resize(handle, rotation, out, keepRatio)
      const d = slideUnits(out)
      expect(dist(at(next, rotation, sx, sy), { x: side.x + d.x, y: side.y + d.y })).toBeLessThan(1e-6)
    }
  })

  it.each(SIDES)('%s changes only its own axis, whatever keepRatio says', (handle) => {
    const { sx } = signs(handle)
    for (const keepRatio of [true, false]) {
      for (const move of MOVES) {
        const next = resize(handle, rotation, move, keepRatio)
        if (sx !== 0) expect(next.h).toBe(START.h)
        else expect(next.w).toBe(START.w)
      }
    }
  })

  it.each(CORNERS)('%s keeps w/h, its corner on the cursor\'s projection onto the diagonal from the pinned corner; keepRatio off does not', (handle) => {
    const { sx, sy } = signs(handle)
    const pin = at(START, rotation, -sx, -sy)
    const corner = at(START, rotation, sx, sy)
    const diag = { x: corner.x - pin.x, y: corner.y - pin.y }
    for (const move of MOVES) {
      const next = resize(handle, rotation, move, true)
      expect(next.w / next.h).toBeCloseTo(START.w / START.h, 9)

      const d = slideUnits(move)
      const cursor = { x: corner.x + d.x, y: corner.y + d.y }
      const k = ((cursor.x - pin.x) * diag.x + (cursor.y - pin.y) * diag.y) / (diag.x * diag.x + diag.y * diag.y)
      expect(dist(at(next, rotation, sx, sy), { x: pin.x + k * diag.x, y: pin.y + k * diag.y })).toBeLessThan(1e-6)
    }
    const free = resize(handle, rotation, MOVES[0], false)
    expect(Math.abs(free.w / free.h - START.w / START.h)).toBeGreaterThan(0.01)
  })

  it.each(CORNERS)('%s: a 1:20 box dragged past the minimum stops at 1 x 20 on its pinned corner', (handle) => {
    const thin: Box = { x: 50, y: 60, w: 10, h: 200 }
    const { sx, sy } = signs(handle)
    const pin = at(thin, rotation, -sx, -sy)
    const corner = at(thin, rotation, sx, sy)
    // Twice the way from the dragged corner to the pinned one: well past it.
    const move = { x: 2 * (pin.x - corner.x) * SCALE, y: 2 * (pin.y - corner.y) * SCALE }
    const next = resize(handle, rotation, move, true, thin)
    expect(next.w).toBeCloseTo(1, 9)
    expect(next.h).toBeCloseTo(20, 9)
    expect(dist(at(next, rotation, -sx, -sy), pin)).toBeLessThan(1e-6)
  })
})

describe('nextResizeBox without rotation and with the ratio free', () => {
  // Includes moves far enough to hit the 1 px minimum from either side.
  const moves = [...MOVES, { x: 0, y: 0 }, { x: 400, y: 300 }, { x: -400, y: -300 }, { x: 0.3, y: -0.7 }]
  const boxes: Box[] = [START, { x: 100.3, y: 200.7, w: 300.1, h: 150.9 }]

  it.each(HANDLES)('%s: exactly the box it gave before', (handle) => {
    for (const box of boxes) {
      for (const move of moves) {
        const cursor = { x: PRESS.x + move.x, y: PRESS.y + move.y }
        // No rotation on the box at all, and no options: the old call.
        const old = startResize('el', handle, PRESS, box)
        expect(nextResizeBox(old, cursor, SCALE)).toEqual(before(old, cursor, SCALE))
        expect(nextResizeBox(old, cursor, SCALE, { keepRatio: false })).toEqual(before(old, cursor, SCALE))
        const zero = startResize('el', handle, PRESS, { ...box, rotation: 0 })
        expect(nextResizeBox(zero, cursor, SCALE, { keepRatio: false })).toEqual(before(zero, cursor, SCALE))
      }
    }
  })
})

describe('roundResizedBox', () => {
  it('rounds w and h first, then places x and y from the pinned point', () => {
    // se pins the top-left: x and y round in place.
    expect(roundResizedBox({ x: 100.4, y: 99.6, w: 250.5, h: 120.2 }, 'se')).toEqual({ x: 100, y: 100, w: 251, h: 120 })
    // nw pins the bottom-right (100, 100): rounding x and w on their own would put it at (101, 101).
    expect(roundResizedBox({ x: 10.5, y: 10.5, w: 89.5, h: 89.5 }, 'nw')).toEqual({ x: 10, y: 10, w: 90, h: 90 })
    // e pins the left side's midpoint; y stays where it is.
    expect(roundResizedBox({ x: 10, y: 20, w: 99.6, h: 50 }, 'e')).toEqual({ x: 10, y: 20, w: 100, h: 50 })
  })

  it('never goes below 1 x 1', () => {
    expect(roundResizedBox({ x: 0, y: 0, w: 0.2, h: 0.4 }, 'se')).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('a turned box keeps its pinned corner within a pixel', () => {
    const box = { x: 300.37, y: 120.81, w: 199.49, h: 99.51 }
    for (const rotation of [30, 90, -135, 400]) {
      const kept = roundResizedBox(box, 'ne', rotation)
      expect(dist(at(kept, rotation, -1, 1), at(box, rotation, -1, 1))).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-9)
    }
  })
})
