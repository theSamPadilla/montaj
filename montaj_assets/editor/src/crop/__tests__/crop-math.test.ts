/// <reference types="vitest/globals" />
import { renderedSourceRect, translateCropPx, cropForAspect, maxZoomForAspect, aspectLockedCornerResize } from '../crop-math'
import { fractionToWrapperPx, wrapperPxToFraction } from '../crop-math'

describe('renderedSourceRect', () => {
  it('1. fits source to width when source is wider than wrapper (letterboxes top/bottom)', () => {
    // wrapper 400x500 (aspect 0.8), source 1920x1080 (aspect 1.78)
    const result = renderedSourceRect({ wrapperW: 400, wrapperH: 500, srcWidth: 1920, srcHeight: 1080 })
    expect(result.width).toBeCloseTo(400)
    expect(result.height).toBeCloseTo(400 / (1920 / 1080)) // ≈ 225
    expect(result.offsetX).toBeCloseTo(0)
    expect(result.offsetY).toBeCloseTo((500 - 225) / 2) // ≈ 137.5
  })

  it('2. fits source to height when source is taller than wrapper (letterboxes left/right)', () => {
    // wrapper 500x400 (aspect 1.25), source 1080x1920 (aspect 0.5625)
    const result = renderedSourceRect({ wrapperW: 500, wrapperH: 400, srcWidth: 1080, srcHeight: 1920 })
    expect(result.height).toBeCloseTo(400)
    expect(result.width).toBeCloseTo(400 * (1080 / 1920)) // ≈ 225
    expect(result.offsetY).toBeCloseTo(0)
    expect(result.offsetX).toBeCloseTo((500 - 225) / 2) // ≈ 137.5
  })

  it('3. exact aspect match — no letterbox', () => {
    const result = renderedSourceRect({ wrapperW: 400, wrapperH: 500, srcWidth: 800, srcHeight: 1000 })
    expect(result.width).toBeCloseTo(400)
    expect(result.height).toBeCloseTo(500)
    expect(result.offsetX).toBeCloseTo(0)
    expect(result.offsetY).toBeCloseTo(0)
  })
})

describe('fractionToWrapperPx', () => {
  it('4. maps source-fraction crop to wrapper pixels via the rendered source rect', () => {
    const rendered = { offsetX: 0, offsetY: 137.5, width: 400, height: 225 }
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }
    const px = fractionToWrapperPx({ crop, rendered })
    expect(px.x).toBeCloseTo(0 + 0.1 * 400)        // 40
    expect(px.y).toBeCloseTo(137.5 + 0.2 * 225)     // 182.5
    expect(px.w).toBeCloseTo(0.5 * 400)             // 200
    expect(px.h).toBeCloseTo(0.6 * 225)             // 135
  })
})

describe('wrapperPxToFraction', () => {
  it('5. round-trips with fractionToWrapperPx', () => {
    const rendered = { offsetX: 50, offsetY: 0, width: 300, height: 400 }
    const orig = { x: 0.25, y: 0.4, w: 0.3, h: 0.5 }
    const px = fractionToWrapperPx({ crop: orig, rendered })
    const back = wrapperPxToFraction({ px, rendered })
    expect(back.x).toBeCloseTo(orig.x)
    expect(back.y).toBeCloseTo(orig.y)
    expect(back.w).toBeCloseTo(orig.w)
    expect(back.h).toBeCloseTo(orig.h)
  })
})

describe('video-source round-trip (regression lock: helpers are element-agnostic)', () => {
  it('12. round-trips a CropFraction through fractionToWrapperPx → wrapperPxToFraction for a 1920×1080 source in a 1080×1920 wrapper', () => {
    // 1920×1080 landscape video rendered inside a 1080×1920 portrait wrapper.
    // Source is much wider than the wrapper, so it letterboxes left/right.
    const rendered = renderedSourceRect({ wrapperW: 1080, wrapperH: 1920, srcWidth: 1920, srcHeight: 1080 })
    const orig: import('../crop-math').CropFraction = { x: 0.1, y: 0.2, w: 0.6, h: 0.5 }
    const px = fractionToWrapperPx({ crop: orig, rendered })
    const back = wrapperPxToFraction({ px, rendered })
    expect(back.x).toBeCloseTo(orig.x)
    expect(back.y).toBeCloseTo(orig.y)
    expect(back.w).toBeCloseTo(orig.w)
    expect(back.h).toBeCloseTo(orig.h)
  })
})

import { applyCropHandleDrag } from '../crop-math'

// Standard fixture: 400x500 element, 800x1000 source — aspect-matched so the
// rendered source fills the wrapper. Crop fractions map 1:1 to wrapper px on
// the x axis (400 px wide) and on the y axis (500 px tall) since there's no
// letterbox.
const FIXTURE = {
  wrapperW: 400,
  wrapperH: 500,
  srcWidth: 800,
  srcHeight: 1000,
  initialCrop: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, // pixel: (80, 100)–(320, 400), 240×300
}

describe('applyCropHandleDrag', () => {
  it('6. SE handle: only the dragged axis moves (free-form, no aspect lock)', () => {
    const next = applyCropHandleDrag({
      handle: 'se',
      initialCrop: FIXTURE.initialCrop,
      deltaPx: { x: -50, y: 0 },
      wrapperW: FIXTURE.wrapperW,
      wrapperH: FIXTURE.wrapperH,
      srcWidth: FIXTURE.srcWidth,
      srcHeight: FIXTURE.srcHeight,
    })
    // NW corner anchored. dx=-50 in 400-px-wide rendered = 0.125 in fractions.
    expect(next.x).toBeCloseTo(0.2)
    expect(next.y).toBeCloseTo(0.2)
    expect(next.w).toBeCloseTo(0.6 - 50 / 400) // 0.475
    expect(next.h).toBeCloseTo(0.6)             // unchanged — no aspect coupling
  })

  it('7. NW handle: dragging inward shrinks from the top-left only on the dragged axes', () => {
    const next = applyCropHandleDrag({
      handle: 'nw',
      initialCrop: FIXTURE.initialCrop,
      deltaPx: { x: 40, y: 0 },
      wrapperW: FIXTURE.wrapperW,
      wrapperH: FIXTURE.wrapperH,
      srcWidth: FIXTURE.srcWidth,
      srcHeight: FIXTURE.srcHeight,
    })
    // SE corner anchored at (0.8, 0.8). Only x changed — y/h untouched.
    expect(next.x).toBeCloseTo(0.3)
    expect(next.w).toBeCloseTo(0.5)
    expect(next.y).toBeCloseTo(0.2)
    expect(next.h).toBeCloseTo(0.6)
    expect(next.x + next.w).toBeCloseTo(0.8)
  })

  it('8. N handle: only top edge moves; width is unchanged (free-form)', () => {
    const next = applyCropHandleDrag({
      handle: 'n',
      initialCrop: FIXTURE.initialCrop,
      deltaPx: { x: 0, y: 50 }, // drag top edge down 50 px in 500-px-tall rendered
      wrapperW: FIXTURE.wrapperW,
      wrapperH: FIXTURE.wrapperH,
      srcWidth: FIXTURE.srcWidth,
      srcHeight: FIXTURE.srcHeight,
    })
    expect(next.y).toBeCloseTo(0.3)
    expect(next.h).toBeCloseTo(0.5)
    // width/x untouched
    expect(next.x).toBeCloseTo(0.2)
    expect(next.w).toBeCloseTo(0.6)
  })

  it('9. clamps so the crop never extends past source bounds', () => {
    const next = applyCropHandleDrag({
      handle: 'se',
      initialCrop: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
      deltaPx: { x: 200, y: 200 },
      wrapperW: FIXTURE.wrapperW,
      wrapperH: FIXTURE.wrapperH,
      srcWidth: FIXTURE.srcWidth,
      srcHeight: FIXTURE.srcHeight,
    })
    expect(next.x + next.w).toBeLessThanOrEqual(1.0 + 1e-9)
    expect(next.y + next.h).toBeLessThanOrEqual(1.0 + 1e-9)
    expect(next.x).toBeGreaterThanOrEqual(-1e-9)
    expect(next.y).toBeGreaterThanOrEqual(-1e-9)
  })

  it('10. enforces a minimum size (no zero-width / zero-height crop)', () => {
    const next = applyCropHandleDrag({
      handle: 'se',
      initialCrop: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      deltaPx: { x: -1000, y: -1000 },
      wrapperW: FIXTURE.wrapperW,
      wrapperH: FIXTURE.wrapperH,
      srcWidth: FIXTURE.srcWidth,
      srcHeight: FIXTURE.srcHeight,
    })
    expect(next.w).toBeGreaterThan(0)
    expect(next.h).toBeGreaterThan(0)
  })

  it('11. aspect-mismatched source: free-form drag still respects letterbox bounds', () => {
    // Source wider than wrapper → rendered letterboxes top/bottom. Initial crop
    // is fully inside rendered bounds; a small inward drag should land inside
    // [0, 1] on both axes.
    const next = applyCropHandleDrag({
      handle: 'se',
      initialCrop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      deltaPx: { x: -20, y: 0 },
      wrapperW: 400,
      wrapperH: 500,
      srcWidth: 1920,
      srcHeight: 1080,
    })
    expect(next.x).toBeCloseTo(0.1)
    expect(next.y).toBeCloseTo(0.1)
    // dx=-20 px in 400-px-wide rendered = -0.05 in fractions
    expect(next.w).toBeCloseTo(0.45)
    expect(next.h).toBeCloseTo(0.5)
  })
})

describe('translateCropPx (pan)', () => {
  const SRC = { wrapperW: 400, wrapperH: 400, srcWidth: 1000, srcHeight: 1000 } // square, no letterbox

  it('moves the crop by the pixel delta in fractions', () => {
    const next = translateCropPx({
      crop: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
      deltaPx: { x: 40, y: -20 }, // 40/400 = +0.1 x, -20/400 = -0.05 y
      ...SRC,
    })
    expect(next.x).toBeCloseTo(0.3)
    expect(next.y).toBeCloseTo(0.15)
    expect(next.w).toBeCloseTo(0.4)
    expect(next.h).toBeCloseTo(0.4)
  })

  it('clamps so the crop stays fully inside the source (no size change)', () => {
    const next = translateCropPx({
      crop: { x: 0.7, y: 0.7, w: 0.4, h: 0.4 }, // right/bottom edge at 1.1 — already overflowing intent
      deltaPx: { x: 1000, y: 1000 },
      ...SRC,
    })
    // pinned to the far corner: x = 1 - w, y = 1 - h
    expect(next.x).toBeCloseTo(0.6)
    expect(next.y).toBeCloseTo(0.6)
    expect(next.w).toBeCloseTo(0.4)
    expect(next.h).toBeCloseTo(0.4)
  })
})

describe('cropForAspect + maxZoomForAspect', () => {
  it('9:16 crop from a 16:9 source → full height, narrow centered width', () => {
    // source 1920x1080 (aspect 1.778), target 9/16=0.5625 < srcAspect → full height
    const c = cropForAspect({ aspect: 9 / 16, zoom: 1, srcWidth: 1920, srcHeight: 1080 })
    expect(c.h).toBeCloseTo(1)
    // w = aspect/srcAspect = 0.5625 / 1.7778 = 0.3164
    expect(c.w).toBeCloseTo((9 / 16) / (1920 / 1080), 3)
    expect(c.x).toBeCloseTo((1 - c.w) / 2) // centered
    expect(c.y).toBeCloseTo(0)
  })

  it('16:9 crop from a 16:9 source → the whole frame at zoom 1', () => {
    const c = cropForAspect({ aspect: 16 / 9, zoom: 1, srcWidth: 1920, srcHeight: 1080 })
    expect(c.w).toBeCloseTo(1)
    expect(c.h).toBeCloseTo(1)
  })

  it('zoom shrinks the crop around its center', () => {
    const c1 = cropForAspect({ aspect: 1, zoom: 1, srcWidth: 1000, srcHeight: 1000 })
    const c2 = cropForAspect({ aspect: 1, zoom: 2, srcWidth: 1000, srcHeight: 1000 })
    expect(c1.w).toBeCloseTo(1)
    expect(c2.w).toBeCloseTo(0.5) // half size at 2×
    expect(c2.x).toBeCloseTo(0.25) // still centered
    expect(c2.y).toBeCloseTo(0.25)
  })

  it('maxZoomForAspect keeps the crop at/above the 2% floor', () => {
    // 1:1 on a square source: base w=h=1, floor 0.02 → max zoom 50
    const z = maxZoomForAspect({ aspect: 1, srcWidth: 1000, srcHeight: 1000 })
    expect(z).toBeCloseTo(50)
  })
})

describe('aspectLockedCornerResize', () => {
  it('keeps the locked pixel aspect and anchors the opposite corner (se drag)', () => {
    // square source 1000x1000 in a 400x400 frame → rendered fills the frame.
    const next = aspectLockedCornerResize({
      handle: 'se',
      initialCrop: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, // nw corner anchored at (0.2,0.2)
      deltaPx: { x: 100, y: 0 },                        // drag se corner right
      wrapperW: 400, wrapperH: 400, srcWidth: 1000, srcHeight: 1000,
      aspect: 16 / 9,
    })
    expect(next.x).toBeCloseTo(0.2) // anchor held
    expect(next.y).toBeCloseTo(0.2)
    const pixelAspect = (next.w * 1000) / (next.h * 1000)
    expect(pixelAspect).toBeCloseTo(16 / 9, 2)
  })

  it('shrinks to fit when the locked box would overflow the source bounds', () => {
    const next = aspectLockedCornerResize({
      handle: 'se',
      initialCrop: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      deltaPx: { x: 100000, y: 0 }, // absurd outward drag
      wrapperW: 400, wrapperH: 400, srcWidth: 1000, srcHeight: 1000,
      aspect: 16 / 9,
    })
    // stays within [0,1] and keeps the aspect
    expect(next.x + next.w).toBeLessThanOrEqual(1.0001)
    expect(next.y + next.h).toBeLessThanOrEqual(1.0001)
    expect((next.w * 1000) / (next.h * 1000)).toBeCloseTo(16 / 9, 2)
  })
})
