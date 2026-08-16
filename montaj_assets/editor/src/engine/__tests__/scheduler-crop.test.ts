/**
 * SP4 T5 — `sourceCrop` parity between the engine's `drawImage` rect and the
 * legacy `<video>` CSS.
 *
 * `sourceCropStyle.ts` and its tests are the spec (plan decision 3: "the file
 * and its tests stay as the spec"), so this suite does not re-derive the
 * expected numbers — it runs `sourceCropVideoStyle` for each vector, works out
 * where on the frame that CSS actually puts the crop sub-rect, and asserts the
 * engine's destination rect lands in the same place. If either implementation
 * drifts, the equality breaks; a shared bug in a shared formula cannot hide
 * here because the two formulas are written differently (CSS oversizes the
 * whole video and translates it; the canvas draws only the sub-rect).
 *
 * The vector table starts with the four cases `sourceCropStyle.test.ts` already
 * pins, then adds the ones that file does not cover: the opposite aspect
 * relationship, an offset crop, and the invalid/degenerate inputs.
 */
import { describe, expect, it } from 'vitest'
import { sourceCropVideoStyle } from '../../video/preview/sourceCropStyle'
import { containFitPlan, drawPlanFor, sourceCropDrawPlan } from '../scheduler'

interface Vector {
  name: string
  crop: { x: number; y: number; w: number; h: number }
  sourceWidth: number
  sourceHeight: number
  frameWidth: number
  frameHeight: number
  /** The engine decodes a PROXY — a different resolution, same aspect. */
  codedWidth: number
  codedHeight: number
}

/** Vectors that must produce a crop on BOTH paths. */
const CROPPING: Vector[] = [
  {
    // sourceCropStyle.test.ts: "center vertical-strip crop of a landscape
    // source fills a portrait frame".
    name: 'centre vertical strip, landscape source → portrait frame',
    crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameWidth: 1080,
    frameHeight: 1920,
    codedWidth: 1280,
    codedHeight: 720,
  },
  {
    // sourceCropStyle.test.ts: "crop region matching frame aspect fills the
    // frame exactly (no letterbox)".
    name: 'crop matching frame aspect, no letterbox',
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    sourceWidth: 1080,
    sourceHeight: 1920,
    frameWidth: 1080,
    frameHeight: 1920,
    codedWidth: 720,
    codedHeight: 1280,
  },
  {
    // The `cropAspect < frameAspect` branch, which neither existing vector
    // exercises: a tall sliver of a portrait source inside a landscape frame,
    // so the crop fills the frame's HEIGHT and pillarboxes horizontally.
    name: 'tall sliver, portrait source → landscape frame (pillarboxed)',
    crop: { x: 0.4, y: 0, w: 0.2, h: 1 },
    sourceWidth: 1080,
    sourceHeight: 1920,
    frameWidth: 1920,
    frameHeight: 1080,
    codedWidth: 406,
    codedHeight: 720,
  },
  {
    name: 'offset crop in both axes',
    crop: { x: 0.3, y: 0.45, w: 0.4, h: 0.35 },
    sourceWidth: 3840,
    sourceHeight: 2160,
    frameWidth: 1080,
    frameHeight: 1920,
    codedWidth: 1280,
    codedHeight: 720,
  },
  {
    name: 'crop touching the far edge',
    crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameWidth: 1080,
    frameHeight: 1080,
    codedWidth: 1280,
    codedHeight: 720,
  },
]

/** Vectors both paths must decline to crop. */
const NO_CROP: Vector[] = [
  {
    // sourceCropStyle.test.ts: "returns null for a full-frame (default) crop".
    name: 'full-frame default crop',
    crop: { x: 0, y: 0, w: 1, h: 1 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameWidth: 1080,
    frameHeight: 1920,
    codedWidth: 1280,
    codedHeight: 720,
  },
  {
    // sourceCropStyle.test.ts: "returns null without source dims". THE parity
    // guard: KNOWN-DIVERGENCES entry 8 — render drops the crop filter entirely
    // when the item carries no dims, and both preview paths follow it.
    name: 'no item source dims',
    crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
    sourceWidth: 0,
    sourceHeight: 0,
    frameWidth: 1080,
    frameHeight: 1920,
    codedWidth: 1280,
    codedHeight: 720,
  },
  {
    name: 'zero-width crop',
    crop: { x: 0.25, y: 0, w: 0, h: 1 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameWidth: 1080,
    frameHeight: 1920,
    codedWidth: 1280,
    codedHeight: 720,
  },
  {
    name: 'negative-height crop',
    crop: { x: 0.25, y: 0, w: 0.5, h: -0.2 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameWidth: 1080,
    frameHeight: 1920,
    codedWidth: 1280,
    codedHeight: 720,
  },
  {
    name: 'unmeasured frame box',
    crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameWidth: 0,
    frameHeight: 0,
    codedWidth: 1280,
    codedHeight: 720,
  },
]

/**
 * Where the CSS actually puts the crop sub-rect, in frame pixels.
 *
 * The `<video>` is sized `width`/`height` and positioned `left`/`top`, all as
 * percentages of the frame; the crop sub-rect is `crop.x/y/w/h` of THAT box
 * (the element is `object-fit: fill`, so source ratios map linearly onto it).
 */
function cssCropBox(
  style: Record<string, unknown>,
  crop: { x: number; y: number; w: number; h: number },
  frameWidth: number,
  frameHeight: number,
) {
  const pct = (v: unknown) => parseFloat(String(v)) / 100
  const videoW = pct(style.width) * frameWidth
  const videoH = pct(style.height) * frameHeight
  const left = pct(style.left) * frameWidth
  const top = pct(style.top) * frameHeight
  return {
    x: left + crop.x * videoW,
    y: top + crop.y * videoH,
    w: crop.w * videoW,
    h: crop.h * videoH,
  }
}

describe('sourceCropDrawPlan — parity with sourceCropStyle.ts', () => {
  for (const v of CROPPING) {
    it(`places the crop sub-rect exactly where the CSS does: ${v.name}`, () => {
      const style = sourceCropVideoStyle({
        crop: v.crop,
        sourceWidth: v.sourceWidth,
        sourceHeight: v.sourceHeight,
        frameWidth: v.frameWidth,
        frameHeight: v.frameHeight,
      })
      expect(style).not.toBeNull()

      const plan = sourceCropDrawPlan(v)
      expect(plan).not.toBeNull()

      const css = cssCropBox(
        style as unknown as Record<string, unknown>,
        v.crop,
        v.frameWidth,
        v.frameHeight,
      )
      // 1e-6 of a frame pixel: the two formulas are algebraically identical, so
      // only float association separates them.
      expect(plan!.dx).toBeCloseTo(css.x, 6)
      expect(plan!.dy).toBeCloseTo(css.y, 6)
      expect(plan!.dw).toBeCloseTo(css.w, 6)
      expect(plan!.dh).toBeCloseTo(css.h, 6)
    })

    it(`reads the crop sub-rect out of the decoded frame: ${v.name}`, () => {
      const plan = sourceCropDrawPlan(v)!
      // Source rect is expressed against the DECODED (proxy) dims, not the
      // item's original `sourceWidth`/`sourceHeight` — `sourceCrop` is stored
      // as ratios of the source precisely so it survives the re-encode.
      expect(plan.sx).toBeCloseTo(v.crop.x * v.codedWidth, 9)
      expect(plan.sy).toBeCloseTo(v.crop.y * v.codedHeight, 9)
      expect(plan.sw).toBeCloseTo(v.crop.w * v.codedWidth, 9)
      expect(plan.sh).toBeCloseTo(v.crop.h * v.codedHeight, 9)
      // …and it stays inside the frame.
      expect(plan.sx + plan.sw).toBeLessThanOrEqual(v.codedWidth + 1e-9)
      expect(plan.sy + plan.sh).toBeLessThanOrEqual(v.codedHeight + 1e-9)
    })

    it(`fits the crop inside the frame with at most one letterbox axis: ${v.name}`, () => {
      const plan = sourceCropDrawPlan(v)!
      expect(plan.dx).toBeGreaterThanOrEqual(-1e-9)
      expect(plan.dy).toBeGreaterThanOrEqual(-1e-9)
      expect(plan.dx + plan.dw).toBeLessThanOrEqual(v.frameWidth + 1e-9)
      expect(plan.dy + plan.dh).toBeLessThanOrEqual(v.frameHeight + 1e-9)
      // Contain-fit: exactly one axis is flush unless the aspects match.
      const flushW = Math.abs(plan.dw - v.frameWidth) < 1e-9
      const flushH = Math.abs(plan.dh - v.frameHeight) < 1e-9
      expect(flushW || flushH).toBe(true)
    })
  }

  for (const v of NO_CROP) {
    it(`declines to crop wherever the CSS declines: ${v.name}`, () => {
      const style = sourceCropVideoStyle({
        crop: v.crop,
        sourceWidth: v.sourceWidth,
        sourceHeight: v.sourceHeight,
        frameWidth: v.frameWidth,
        frameHeight: v.frameHeight,
      })
      expect(style).toBeNull()
      expect(sourceCropDrawPlan(v)).toBeNull()
    })
  }

  it('declines when the item carries no sourceCrop at all', () => {
    expect(
      sourceCropDrawPlan({
        crop: undefined,
        sourceWidth: 1920,
        sourceHeight: 1080,
        codedWidth: 1280,
        codedHeight: 720,
        frameWidth: 1080,
        frameHeight: 1920,
      }),
    ).toBeNull()
  })

  it('declines when the decoded frame has no dims yet', () => {
    expect(
      sourceCropDrawPlan({
        crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
        sourceWidth: 1920,
        sourceHeight: 1080,
        codedWidth: 0,
        codedHeight: 0,
        frameWidth: 1080,
        frameHeight: 1920,
      }),
    ).toBeNull()
  })
})

describe('containFitPlan — the no-crop default', () => {
  it('letterboxes a landscape source into a portrait frame', () => {
    // PreviewPlayer's `baseVideoStyle` fallback is `objectFit: 'contain'` over
    // the whole frame; this is that, as a rect.
    const plan = containFitPlan(1280, 720, 1080, 1920)
    expect(plan.sx).toBe(0)
    expect(plan.sy).toBe(0)
    expect(plan.sw).toBe(1280)
    expect(plan.sh).toBe(720)
    expect(plan.dw).toBeCloseTo(1080, 9)
    expect(plan.dh).toBeCloseTo(607.5, 9)
    expect(plan.dx).toBeCloseTo(0, 9)
    expect(plan.dy).toBeCloseTo((1920 - 607.5) / 2, 9)
  })

  it('pillarboxes a portrait source into a landscape frame', () => {
    const plan = containFitPlan(720, 1280, 1920, 1080)
    expect(plan.dh).toBeCloseTo(1080, 9)
    expect(plan.dw).toBeCloseTo(607.5, 9)
    expect(plan.dy).toBeCloseTo(0, 9)
    expect(plan.dx).toBeCloseTo((1920 - 607.5) / 2, 9)
  })

  it('fills exactly when the aspects match', () => {
    const plan = containFitPlan(720, 1280, 1080, 1920)
    expect(plan.dx).toBeCloseTo(0, 9)
    expect(plan.dy).toBeCloseTo(0, 9)
    expect(plan.dw).toBeCloseTo(1080, 9)
    expect(plan.dh).toBeCloseTo(1920, 9)
  })

  it('degrades to an empty rect rather than NaN when nothing is measured', () => {
    expect(containFitPlan(0, 0, 1080, 1920)).toEqual({
      sx: 0,
      sy: 0,
      sw: 0,
      sh: 0,
      dx: 0,
      dy: 0,
      dw: 0,
      dh: 0,
    })
  })
})

describe('drawPlanFor — crop when it can, contain when it cannot', () => {
  const item = {
    sourceCrop: { x: 0.25, y: 0, w: 0.5, h: 1 },
    sourceWidth: 1920,
    sourceHeight: 1080,
  }

  it('uses the crop rect when the item is fully specified', () => {
    expect(drawPlanFor(item, 1280, 720, 1080, 1920)).toEqual(
      sourceCropDrawPlan({
        crop: item.sourceCrop,
        sourceWidth: item.sourceWidth,
        sourceHeight: item.sourceHeight,
        codedWidth: 1280,
        codedHeight: 720,
        frameWidth: 1080,
        frameHeight: 1920,
      }),
    )
  })

  it('falls back to contain-fit when the item has a crop but no dims', () => {
    const plan = drawPlanFor({ sourceCrop: item.sourceCrop }, 1280, 720, 1080, 1920)
    expect(plan).toEqual(containFitPlan(1280, 720, 1080, 1920))
  })

  it('falls back to contain-fit when the item has no crop', () => {
    const plan = drawPlanFor({ sourceWidth: 1920, sourceHeight: 1080 }, 1280, 720, 1080, 1920)
    expect(plan).toEqual(containFitPlan(1280, 720, 1080, 1920))
  })
})
