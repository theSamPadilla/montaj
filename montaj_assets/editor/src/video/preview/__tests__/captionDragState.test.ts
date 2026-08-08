import { describe, it, expect } from 'vitest'
import {
  CAPTION_DRAG_SLOP_PX,
  CAPTION_MAX_SCALE,
  CAPTION_MIN_SCALE,
  captionDragGeometry,
  captionDragPatch,
  hasEscapedClickSlop,
  readCaptionGeometry,
  screenDeltaToFramePercent,
  type CaptionDragState,
  type CaptionFrameMetrics,
} from '../captionDragState'

const RENDER_W = 1080
const RENDER_H = 1920

/** Preview scale for a player rendered `px` wide (the ResizeObserver value). */
function metrics(onScreenWidth: number): CaptionFrameMetrics {
  return { previewScale: onScreenWidth / RENDER_W, renderW: RENDER_W, renderH: RENDER_H }
}

function drag(over: Partial<CaptionDragState> = {}): CaptionDragState {
  return {
    id: 'cap-0', type: 'move',
    initX: 100, initY: 200,
    initOffsetX: 0, initOffsetY: 0, initScale: 1,
    ...over,
  }
}

describe('readCaptionGeometry', () => {
  it('applies the schema defaults', () => {
    expect(readCaptionGeometry(undefined)).toEqual({ offsetX: 0, offsetY: 0, scale: 1 })
    expect(readCaptionGeometry({})).toEqual({ offsetX: 0, offsetY: 0, scale: 1 })
  })

  it('preserves explicit zeros rather than falling back to the default', () => {
    expect(readCaptionGeometry({ offsetX: 0, offsetY: -12, scale: 0.5 }))
      .toEqual({ offsetX: 0, offsetY: -12, scale: 0.5 })
  })
})

describe('screenDeltaToFramePercent', () => {
  it('divides by the preview scale then converts to percent of frame', () => {
    // Half-size preview: 54 screen px = 108 design px = 10% of 1080.
    const { dx, dy } = screenDeltaToFramePercent(54, 96, metrics(540))
    expect(dx).toBeCloseTo(10, 10)
    expect(dy).toBeCloseTo(10, 10)
  })

  it('is independent of window size — the same fraction of the player is the same percent', () => {
    // A drag of 25% of the player width must read 25% at any preview size.
    for (const w of [270, 540, 1080, 1600]) {
      const { dx } = screenDeltaToFramePercent(w * 0.25, 0, metrics(w))
      expect(dx).toBeCloseTo(25, 10)
    }
  })

  it('uses the frame HEIGHT for the vertical axis (non-square frames)', () => {
    // 192 screen px at 1:1 = 192 design px = 10% of 1920, not 17.8% of 1080.
    const { dy } = screenDeltaToFramePercent(0, 192, metrics(RENDER_W))
    expect(dy).toBeCloseTo(10, 10)
  })

  it('returns a zero delta for degenerate metrics instead of NaN/Infinity', () => {
    expect(screenDeltaToFramePercent(50, 50, { previewScale: 0, renderW: RENDER_W, renderH: RENDER_H })).toEqual({ dx: 0, dy: 0 })
    expect(screenDeltaToFramePercent(50, 50, { previewScale: 1, renderW: 0, renderH: RENDER_H })).toEqual({ dx: 0, dy: 0 })
    expect(screenDeltaToFramePercent(50, 50, { previewScale: NaN, renderW: RENDER_W, renderH: RENDER_H })).toEqual({ dx: 0, dy: 0 })
  })
})

describe('captionDragGeometry — move', () => {
  it('adds the total delta to the offset captured at drag start', () => {
    const d = drag({ initOffsetX: 5, initOffsetY: -10 })
    // 270 screen px right at half scale = 540 design px = 50% of 1080.
    const g = captionDragGeometry(d, d.initX + 270, d.initY + 192, metrics(540))
    expect(g.offsetX).toBeCloseTo(5 + 50, 10)
    expect(g.offsetY).toBeCloseTo(-10 + 20, 10)
    expect(g.scale).toBe(1)
  })

  it('accumulates from the gesture start, not from the previous sample (no drift)', () => {
    const d = drag({ initOffsetX: 5 })
    const m = metrics(540)
    // Sampling the same pointer position twice, and sampling it after a detour,
    // must both give the same answer — the function is a pure map from pointer
    // position to geometry.
    const a = captionDragGeometry(d, 400, 200, m)
    captionDragGeometry(d, 999, 999, m)
    const b = captionDragGeometry(d, 400, 200, m)
    expect(b).toEqual(a)
  })

  it('is a no-op at the starting pointer position', () => {
    const d = drag({ initOffsetX: 12, initOffsetY: 34, initScale: 1.5 })
    expect(captionDragGeometry(d, d.initX, d.initY, metrics(540)))
      .toEqual({ offsetX: 12, offsetY: 34, scale: 1.5 })
  })
})

describe('captionDragGeometry — corner resize', () => {
  const m = metrics(RENDER_W)  // 1:1, so screen px == design px

  it('grows when dragging a corner outward and shrinks when dragging inward', () => {
    const se = drag({ type: 'resize-se' })
    expect(captionDragGeometry(se, se.initX + 108, se.initY, m).scale).toBeCloseTo(1.1, 10)
    expect(captionDragGeometry(se, se.initX - 108, se.initY, m).scale).toBeCloseTo(0.9, 10)

    // The NW corner's outward direction is up-left, so the signs invert.
    const nw = drag({ type: 'resize-nw' })
    expect(captionDragGeometry(nw, nw.initX - 108, nw.initY, m).scale).toBeCloseTo(1.1, 10)
    expect(captionDragGeometry(nw, nw.initX + 108, nw.initY, m).scale).toBeCloseTo(0.9, 10)
  })

  it('sums both axes and scales proportionally from the starting scale', () => {
    const d = drag({ type: 'resize-se', initScale: 2 })
    // +10% of width and +10% of height → delta 0.2 → 2 * 1.2.
    const g = captionDragGeometry(d, d.initX + 108, d.initY + 192, m)
    expect(g.scale).toBeCloseTo(2.4, 10)
  })

  it('leaves the offsets untouched', () => {
    const d = drag({ type: 'resize-ne', initOffsetX: 7, initOffsetY: -3 })
    const g = captionDragGeometry(d, d.initX + 500, d.initY - 500, m)
    expect(g.offsetX).toBe(7)
    expect(g.offsetY).toBe(-3)
  })

  it('clamps to the scale bounds', () => {
    const shrink = drag({ type: 'resize-se', initScale: 1 })
    expect(captionDragGeometry(shrink, shrink.initX - 100_000, shrink.initY, m).scale).toBe(CAPTION_MIN_SCALE)
    const grow = drag({ type: 'resize-se', initScale: 1 })
    expect(captionDragGeometry(grow, grow.initX + 100_000, grow.initY, m).scale).toBe(CAPTION_MAX_SCALE)
  })
})

describe('hasEscapedClickSlop', () => {
  it('treats a small wobble as a click, not a drag', () => {
    const d = drag()
    expect(hasEscapedClickSlop(d, d.initX, d.initY)).toBe(false)
    expect(hasEscapedClickSlop(d, d.initX + 2, d.initY + 2)).toBe(false)   // 2.83px
    expect(hasEscapedClickSlop(d, d.initX + 3, d.initY + 3)).toBe(true)    // 4.24px
  })

  it('measures radially, not per axis', () => {
    const d = drag()
    expect(hasEscapedClickSlop(d, d.initX, d.initY + CAPTION_DRAG_SLOP_PX + 1)).toBe(true)
    expect(hasEscapedClickSlop(d, d.initX - CAPTION_DRAG_SLOP_PX - 1, d.initY)).toBe(true)
  })
})

describe('captionDragPatch', () => {
  it('a move writes only the offsets', () => {
    expect(captionDragPatch(drag(), { offsetX: 3, offsetY: 4, scale: 2 }))
      .toEqual({ offsetX: 3, offsetY: 4 })
  })

  it('a resize writes only the scale', () => {
    expect(captionDragPatch(drag({ type: 'resize-sw' }), { offsetX: 3, offsetY: 4, scale: 2 }))
      .toEqual({ scale: 2 })
  })
})
