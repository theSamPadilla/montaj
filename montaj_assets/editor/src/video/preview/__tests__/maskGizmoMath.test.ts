/// <reference types="vitest/globals" />
import { MASK_FEATHER_MAX, maskAt, maskPolygon } from '@bycrux/timeline-core'
import type { VisualItem } from '../../../schema'
import {
  clientToBox,
  coversBox,
  insideDistance,
  featherRings,
  OUTER_RING_MIN_PX,
  maskGestureChanges,
  maskHandles,
  pinHandles,
  PIN_INSET_PX,
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

  it('feather: the band follows the outer ring, widening by twice the outward drag', () => {
    const f = resolve({ shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.8, feather: 0.1 })
    // Short side 100: band 10, the right edge at x = 140, the outer ring at 145.
    const out = maskGestureChanges('feather', f, { x: 145, y: 50 }, { x: 155, y: 50 }, W, H)
    expect(out.maskFeather).toBeCloseTo(0.3)
    const inward = maskGestureChanges('feather', f, { x: 145, y: 50 }, { x: 142, y: 50 }, W, H)
    expect(inward.maskFeather).toBeCloseTo(0.04)
    // A press that does not move changes nothing, wherever it lands.
    expect(maskGestureChanges('feather', f, { x: 170, y: 50 }, { x: 170, y: 50 }, W, H).maskFeather).toBeCloseTo(0.1)
  })

  it('feather clamps to 0..MASK_FEATHER_MAX', () => {
    const f = resolve({ shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.8, feather: 0.1 })
    expect(maskGestureChanges('feather', f, { x: 145, y: 50 }, { x: 100, y: 50 }, W, H).maskFeather).toBe(0)
    expect(maskGestureChanges('feather', f, { x: 145, y: 50 }, { x: 400, y: 50 }, W, H).maskFeather).toBe(MASK_FEATHER_MAX)
  })

  it('feather on a wipe: dragging away from the visible side widens the band', () => {
    const w = resolve({ shape: 'wipe', x: 0.5, y: 0.5, rotation: 0, feather: 0.1 })
    // Visible side is x <= 100; the outer line is at 100 + 5 = 105.
    expect(maskGestureChanges('feather', w, { x: 105, y: 50 }, { x: 115, y: 50 }, W, H).maskFeather).toBeCloseTo(0.3)
    expect(maskGestureChanges('feather', w, { x: 105, y: 50 }, { x: 95, y: 50 }, W, H).maskFeather).toBe(0)
  })

  it('a wipe moves along x and y like any shape', () => {
    const wipe = resolve({ shape: 'wipe', x: 0.3, y: 0.5 })
    const c = maskGestureChanges('move', wipe, { x: 60, y: 10 }, { x: 80, y: 30 }, W, H)
    expect(c.maskX).toBeCloseTo(0.4)
    expect(c.maskY).toBeCloseTo(0.7)
  })
})

describe('insideDistance', () => {
  it('is the distance in from the outline, negative outside', () => {
    const rect = resolve({ shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    expect(insideDistance(rect, { x: 90, y: 50 }, 100, 100)).toBeCloseTo(-15)
    expect(insideDistance(rect, { x: 50, y: 50 }, 100, 100)).toBeCloseTo(25)
    expect(insideDistance(rect, { x: 70, y: 40 }, 100, 100)).toBeCloseTo(5)
  })

  it('a wipe: the distance in from the edge line on the side that shows (the left at rotation 0)', () => {
    const wipe = resolve({ shape: 'wipe', x: 0.5, y: 0.5, rotation: 0 })
    expect(insideDistance(wipe, { x: 20, y: 90 }, 100, 100)).toBeCloseTo(30)
    expect(insideDistance(wipe, { x: 80, y: 0 }, 100, 100)).toBeCloseTo(-30)
  })
})

describe('featherRings', () => {
  it('at feather 0 there is an outer ring 8 px out and no inner ring', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    const r = featherRings(m, 100, 100)
    expect(r.inner).toBeNull()
    expect(r.outer).toEqual(maskPolygon({ ...m, w: 0.5 + 16 / 100, h: 0.5 + 16 / 100 }, 100, 100))
    expect(OUTER_RING_MIN_PX).toBe(8)
  })

  it('the rings sit half the band outside and inside the edge', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.2 })
    // Short side 200: band 40 px, so the rings are 20 px off the edge (4 sigma, sigma 10).
    const r = featherRings(m, 200, 400)
    expect(r.outer).toEqual(maskPolygon({ ...m, w: 0.5 + 40 / 200, h: 0.5 + 40 / 400 }, 200, 400))
    expect(r.inner).toEqual(maskPolygon({ ...m, w: 0.5 - 40 / 200, h: 0.5 - 40 / 400 }, 200, 400))
  })

  it('drops the inner ring once it would collapse', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.1, h: 0.1, feather: 0.4 })
    const r = featherRings(m, 100, 100)
    expect(r.inner).toBeNull()
    expect(r.outer).not.toBeNull()
  })

  it('a wipe gets two lines parallel to its edge, outer on the hidden side', () => {
    const m = resolve({ shape: 'wipe', x: 0.5, y: 0.5, feather: 0.2 })
    const r = featherRings(m, 100, 100)
    // Band 20: outer at 50 + 10, inner at 50 - 10.
    expect(r.outer!.every(([x]) => Math.abs(x - 60) < 1e-9)).toBe(true)
    expect(r.inner!.every(([x]) => Math.abs(x - 40) < 1e-9)).toBe(true)
  })

  it('a wipe at feather 0 still has its outer line, 8 px out', () => {
    const r = featherRings(resolve({ shape: 'wipe', x: 0.5, y: 0.5 }), 100, 100)
    expect(r.inner).toBeNull()
    expect(r.outer!.every(([x]) => Math.abs(x - 58) < 1e-9)).toBe(true)
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
  it('puts the squares on the mask box corners and edge midpoints, rotate above the top edge', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.1 })
    const h = maskHandles(m, 100, 100)
    expect(h.resize.find(r => r.handle === 'nw')!.at).toEqual([25, 25])
    expect(h.resize.find(r => r.handle === 'e')!.at).toEqual([75, 50])
    expect(h.resize).toHaveLength(8)
    expect(h.rotate.at[0]).toBeCloseTo(50)
    expect(h.rotate.at[1]).toBeLessThan(25)
    expect('feather' in h).toBe(false)
  })

  it('a wipe has no resize squares and its rotate handle on the edge line', () => {
    const m = resolve({ shape: 'wipe', x: 0.5, y: 0.5, rotation: 0 })
    const h = maskHandles(m, 100, 100)
    expect(h.resize).toEqual([])
    expect(h.rotate.at[0]).toBeCloseTo(50)
  })
})

describe('pinHandles', () => {
  it('leaves handles inside the box where they are', () => {
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.1 })
    const h = maskHandles(m, 100, 100)
    const p = pinHandles(h, 100, 100)
    expect(p.resize.map(r => r.at)).toEqual(h.resize.map(r => r.at))
    expect(p.resize.every(r => !r.pinned)).toBe(true)
    expect(p.rotate).toEqual({ ...h.rotate, pinned: false })
  })

  it('pins every handle of a mask grown past the box just inside it, apart from each other', () => {
    // A reveal's end: 160% of a 9:16 box, feathered.
    const m = resolve({ shape: 'ellipse', x: 0.5, y: 0.5, w: 1.6, h: 1.6, feather: 0.03 })
    const p = pinHandles(maskHandles(m, 108, 192), 108, 192)
    const all = [...p.resize.map(r => r.at), p.rotate.at]
    for (const [x, y] of all) {
      expect(x).toBeGreaterThanOrEqual(PIN_INSET_PX)
      expect(x).toBeLessThanOrEqual(108 - PIN_INSET_PX)
      expect(y).toBeLessThanOrEqual(192 - PIN_INSET_PX)
      expect(y).toBeGreaterThanOrEqual(PIN_INSET_PX)
    }
    expect(p.resize.find(r => r.handle === 'nw')!.at).toEqual([PIN_INSET_PX, PIN_INSET_PX])
    expect(p.resize.find(r => r.handle === 'e')!.at).toEqual([108 - PIN_INSET_PX, 96])
    expect(p.resize.every(r => r.pinned)).toBe(true)
    // n and rotate both pin to the top middle; rotate slides along the edge, stalkless.
    expect(p.rotate.pinned).toBe(true)
    expect(p.rotate.stalkFrom).toBeNull()
    expect(p.rotate.at[1]).toBe(PIN_INSET_PX)
    expect(p.rotate.at[0]).not.toBe(54)
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(Math.hypot(all[i][0] - all[j][0], all[i][1] - all[j][1])).toBeGreaterThan(12)
      }
    }
  })
})

// §616: a path mask. Its polygon can be concave, so `insideDistance` decides
// the sign by even-odd, not by the convex same-side test.
describe('a path mask', () => {
  // A "U": arms x 0-0.3 and 0.7-1 down to the bottom, joined across the top;
  // the notch (x 0.3-0.7, y 0.4-1) is outside the shape.
  const U = [[0, 0], [1, 0], [1, 1], [0.7, 1], [0.7, 0.4], [0.3, 0.4], [0.3, 1], [0, 1]]
  const path = resolve({ shape: 'path', points: U, x: 0.5, y: 0.5, w: 1, h: 1 })

  it('insideDistance is negative in the notch and positive inside an arm', () => {
    // 100 x 100 box, mask box = the whole box.
    expect(insideDistance(path, { x: 50, y: 80 }, 100, 100)).toBeCloseTo(-20) // 20 px from either arm
    expect(insideDistance(path, { x: 50, y: 60 }, 100, 100)).toBeCloseTo(-20) // 20 px under the bar
    expect(insideDistance(path, { x: 15, y: 60 }, 100, 100)).toBeCloseTo(15) // mid left arm, to its edge at x 0
    expect(insideDistance(path, { x: 50, y: 20 }, 100, 100)).toBeCloseTo(20) // in the bar, 20 above the notch
    expect(insideDistance(path, { x: 150, y: 50 }, 100, 100)).toBeCloseTo(-50) // outside
  })

  it('a convex polygon read the old way would call the notch inside; the path does not', () => {
    // Same-side test on the notch point: edges of the U disagree on sides, so only even-odd is right.
    expect(insideDistance(path, { x: 50, y: 90 }, 100, 100)).toBeLessThan(0)
  })

  it('coversBox: a notch between the corners keeps the fill a move area; a convex path past the box covers it', () => {
    expect(coversBox(path, 100, 100)).toBe(false) // all four corners are in, the bottom middle is not
    const square = [[0, 0], [1, 0], [1, 1], [0, 1]]
    expect(coversBox(resolve({ shape: 'path', points: square, x: 0.5, y: 0.5, w: 1.2, h: 1.2 }), 100, 100)).toBe(true)
    expect(coversBox(resolve({ shape: 'path', points: square, x: 0.5, y: 0.5, w: 0.5, h: 0.5 }), 100, 100)).toBe(false)
  })

  it('the gestures read like an ellipse: move, resize about the centre, rotate', () => {
    expect(maskGestureChanges('move', path, { x: 50, y: 50 }, { x: 60, y: 40 }, 100, 100)).toEqual({ maskX: 0.6, maskY: 0.4 })
    const r = maskGestureChanges('resize-se', path, { x: 100, y: 100 }, { x: 110, y: 110 }, 100, 100)
    expect(r.maskW).toBeCloseTo(1.2)
    expect(r.maskH).toBeCloseTo(1.2)
    expect(maskGestureChanges('rotate', path, { x: 100, y: 50 }, { x: 50, y: 100 }, 100, 100).maskRotation).toBeCloseTo(90)
  })

  it('feather rings grow and shrink the polygon with the box, like the other shapes', () => {
    const m = resolve({ shape: 'path', points: U, x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.2 })
    const r = featherRings(m, 100, 100)
    expect(r.outer).toEqual(maskPolygon({ ...m, w: m.w + (2 * Math.max(2 * (0.2 * 100) / 4, OUTER_RING_MIN_PX)) / 100, h: m.h + (2 * Math.max(2 * (0.2 * 100) / 4, OUTER_RING_MIN_PX)) / 100 }, 100, 100))
    expect(r.inner).not.toBeNull()
  })

  it('a feather drag outward from the notch edge widens the band like an ellipse', () => {
    const m = resolve({ shape: 'path', points: U, x: 0.5, y: 0.5, w: 1, h: 1 })
    // From 5 px into the notch (d = 5 out of the shape) to 15 px: +10 out, band +20 of the 100 px short side.
    const c = maskGestureChanges('feather', m, { x: 35, y: 80 }, { x: 45, y: 80 }, 100, 100)
    expect(c.maskFeather).toBeCloseTo(0.2)
  })
})
