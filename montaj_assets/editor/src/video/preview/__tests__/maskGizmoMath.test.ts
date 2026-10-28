/// <reference types="vitest/globals" />
import { maskAt, maskPolygon } from '@bycrux/timeline-core'
import type { VisualItem } from '../../../schema'
import {
  clientToBox,
  edgeDistance,
  featherRings,
  maskGestureChanges,
  maskHandles,
  wipeLine,
} from '../maskGizmoMath'

// §616 U2: the mask gizmo's geometry, pure. Every gesture works in BOX pixels
// (the clip's own box before rotation, the space maskPolygon draws in), so the
// one conversion that matters is client pixels -> box pixels: undo the clip's
// offset, its rotation and its scale.

const resolve = (mask: Record<string, unknown>) =>
  maskAt({ mask } as unknown as VisualItem, 0)!

const FRAME = { left: 0, top: 0, width: 100, height: 100 }

describe('clientToBox', () => {
  it('is the identity on an unmoved, unscaled, unrotated clip whose box is the frame', () => {
    const clip = { offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1 }
    expect(clientToBox({ x: 30, y: 70 }, FRAME, clip, 100, 100)).toEqual({ x: 30, y: 70 })
  })

  it('undoes the clip offset (a % of the frame)', () => {
    const clip = { offsetX: 10, offsetY: -20, rotation: 0, scaleX: 1, scaleY: 1 }
    const p = clientToBox({ x: 60, y: 30 }, FRAME, clip, 100, 100)
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeCloseTo(50)
  })

  it('undoes the clip rotation: a screen drag down on a clip turned 90° is +x in its box', () => {
    const clip = { offsetX: 0, offsetY: 0, rotation: 90, scaleX: 0.5, scaleY: 0.5 }
    // The box is 50 x 50 preview pixels, centred on the frame.
    const p = clientToBox({ x: 50, y: 60 }, FRAME, clip, 50, 50)
    expect(p.x).toBeCloseTo(35)
    expect(p.y).toBeCloseTo(25)
  })

  it('undoes the clip scale: box pixels are the box size over its size on screen', () => {
    // The frame is drawn at 200 x 200 client pixels; the box in preview pixels
    // is 50 x 100 (scaleX 0.5, scaleY 1 of a 100 x 100 frame).
    const clip = { offsetX: 0, offsetY: 0, rotation: 0, scaleX: 0.5, scaleY: 1 }
    const big = { left: 0, top: 0, width: 200, height: 200 }
    // 20 client pixels right of the centre is 20 / (200 * 0.5) of the box width.
    const p = clientToBox({ x: 120, y: 100 }, big, clip, 50, 100)
    expect(p.x).toBeCloseTo(25 + 50 * (20 / 100))
    expect(p.y).toBeCloseTo(50)
  })
})

describe('maskGestureChanges', () => {
  const W = 200
  const H = 100
  const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.6 })

  it('move: the box-pixel delta over the box size, on x and y', () => {
    const c = maskGestureChanges('move', m, { x: 100, y: 50 }, { x: 120, y: 40 }, W, H)
    expect(c.maskX).toBeCloseTo(0.6)
    expect(c.maskY).toBeCloseTo(0.4)
  })

  it('resize from a corner: both axes about the centre, so twice the drag', () => {
    const c = maskGestureChanges('resize-se', m, { x: 140, y: 80 }, { x: 150, y: 85 }, W, H)
    expect(c.maskW).toBeCloseTo(0.4 + 20 / W)
    expect(c.maskH).toBeCloseTo(0.6 + 10 / H)
    expect(c.maskX).toBeUndefined()
  })

  it('resize from an edge: one axis only', () => {
    const e = maskGestureChanges('resize-w', m, { x: 60, y: 50 }, { x: 50, y: 70 }, W, H)
    expect(e.maskW).toBeCloseTo(0.4 + 20 / W)
    expect(e.maskH).toBeUndefined()
    const n = maskGestureChanges('resize-n', m, { x: 100, y: 20 }, { x: 130, y: 10 }, W, H)
    expect(n.maskH).toBeCloseTo(0.6 + 20 / H)
    expect(n.maskW).toBeUndefined()
  })

  it('resize on a rotated mask reads the drag along the mask own axes', () => {
    const r = resolve({ shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.6, rotation: 90 })
    // Turned 90°, the mask's +x points down the screen.
    const c = maskGestureChanges('resize-e', r, { x: 100, y: 90 }, { x: 100, y: 100 }, W, H)
    expect(c.maskW).toBeCloseTo(0.4 + 20 / W)
  })

  it('resize never collapses the mask', () => {
    const c = maskGestureChanges('resize-e', m, { x: 140, y: 50 }, { x: -500, y: 50 }, W, H)
    expect(c.maskW).toBeGreaterThan(0)
  })

  it('rotate: the turn of the pointer about the mask centre, added to the rotation', () => {
    const r = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, rotation: 10 })
    const c = maskGestureChanges('rotate', r, { x: 100, y: 0 }, { x: 150, y: 50 }, W, H)
    expect(c.maskRotation).toBeCloseTo(100)
  })

  it('feather: the distance from the edge is 2 sigma, so sigma = d / 2', () => {
    const f = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.6, feather: 0.1 })
    // The right edge is at x = 140. Sigma 10 px puts the outer ring at 160.
    const c = maskGestureChanges('feather', f, { x: 160, y: 50 }, { x: 170, y: 50 }, W, H)
    expect(c.maskFeather).toBeCloseTo(15 / 100)
  })

  it('feather clamps to 0..0.5', () => {
    const f = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.6, feather: 0.1 })
    expect(maskGestureChanges('feather', f, { x: 160, y: 50 }, { x: 140, y: 50 }, W, H).maskFeather).toBe(0)
    expect(maskGestureChanges('feather', f, { x: 160, y: 50 }, { x: 900, y: 50 }, W, H).maskFeather).toBe(0.5)
  })

  it('a wipe moves along x and y like any shape', () => {
    const wipe = resolve({ shape: 'wipe', x: 0.3, y: 0.5 })
    const c = maskGestureChanges('move', wipe, { x: 60, y: 10 }, { x: 80, y: 30 }, W, H)
    expect(c.maskX).toBeCloseTo(0.4)
    expect(c.maskY).toBeCloseTo(0.7)
  })
})

describe('edgeDistance', () => {
  it('is the distance to the outline for a shape, and to the edge line for a wipe', () => {
    const rect = resolve({ shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    expect(edgeDistance(rect, { x: 90, y: 50 }, 100, 100)).toBeCloseTo(15)
    expect(edgeDistance(rect, { x: 50, y: 50 }, 100, 100)).toBeCloseTo(25)
    const wipe = resolve({ shape: 'wipe', x: 0.5, y: 0.5, rotation: 0 })
    expect(edgeDistance(wipe, { x: 20, y: 90 }, 100, 100)).toBeCloseTo(30)
  })
})

describe('featherRings', () => {
  it('none at feather 0', () => {
    expect(featherRings(resolve({ shape: 'ellipse' }), 100, 100)).toEqual([])
  })

  it('grows and shrinks w and h by 4 sigma over the box, so each ring is 2 sigma off the edge', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.05 })
    // sigma = 0.05 * 200 = 10 px.
    const rings = featherRings(m, 200, 400)
    expect(rings).toHaveLength(2)
    expect(rings[0]).toEqual(maskPolygon({ ...m, w: 0.5 + 40 / 200, h: 0.5 + 40 / 400 }, 200, 400))
    expect(rings[1]).toEqual(maskPolygon({ ...m, w: 0.5 - 40 / 200, h: 0.5 - 40 / 400 }, 200, 400))
  })

  it('drops the inner ring once it would collapse', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.1, h: 0.1, feather: 0.1 })
    expect(featherRings(m, 100, 100)).toHaveLength(1)
  })

  it('a wipe gets two lines parallel to its edge at +/- 2 sigma', () => {
    const m = resolve({ shape: 'wipe', x: 0.5, y: 0.5, feather: 0.1 })
    const rings = featherRings(m, 100, 100)
    expect(rings).toHaveLength(2)
    expect(rings[0].every(([x]) => Math.abs(x - 70) < 1e-9)).toBe(true)
    expect(rings[1].every(([x]) => Math.abs(x - 30) < 1e-9)).toBe(true)
  })
})

describe('wipeLine', () => {
  it('is the edge line clipped to the box', () => {
    const m = resolve({ shape: 'wipe', x: 0.25, y: 0.5, rotation: 0 })
    const seg = wipeLine(m, 100, 100)!
    const xs = seg.map(p => p[0])
    const ys = seg.map(p => p[1]).sort((a, b) => a - b)
    expect(xs.every(x => Math.abs(x - 25) < 1e-9)).toBe(true)
    expect(ys[0]).toBeCloseTo(0)
    expect(ys[1]).toBeCloseTo(100)
  })
})

describe('maskHandles', () => {
  it('puts the squares on the mask box corners and edge midpoints, rotate above the top edge, feather on the outer ring', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.2 })
    const h = maskHandles(m, 100, 100)
    expect(h.resize.find(r => r.handle === 'nw')!.at).toEqual([25, 25])
    expect(h.resize.find(r => r.handle === 'e')!.at).toEqual([75, 50])
    expect(h.resize).toHaveLength(8)
    expect(h.rotate.at[0]).toBeCloseTo(50)
    expect(h.rotate.at[1]).toBeLessThan(25)
    // sigma 20 px: the outer ring is 40 px right of the right edge.
    expect(h.feather.at[0]).toBeCloseTo(75 + 40)
    expect(h.feather.at[1]).toBeCloseTo(50)
  })

  it('with feather 0 the feather handle sits just outside the right edge', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    const at = maskHandles(m, 100, 100).feather.at
    expect(at[0]).toBeGreaterThan(75)
    expect(at[0]).toBeLessThan(100)
    expect(at[1]).toBeCloseTo(50)
  })

  it('a wipe has no resize squares and its rotate handle on the edge line', () => {
    const m = resolve({ shape: 'wipe', x: 0.5, y: 0.5, rotation: 0 })
    const h = maskHandles(m, 100, 100)
    expect(h.resize).toEqual([])
    expect(h.rotate.at[0]).toBeCloseTo(50)
    expect(h.feather.at[0]).toBeGreaterThan(50)
  })
})
