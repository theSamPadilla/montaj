import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  CAPTION_DRAG_SLOP_PX,
  CAPTION_MAX_SCALE,
  CAPTION_MIN_SCALE,
  captionDragGeometry,
  captionDragPatch,
  hasEscapedClickSlop,
  measureCaptionContentRect,
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
    // 12/34 are both well outside the centre-snap radius, so the geometry is
    // the untouched starting offsets. The move branch also reports whether each
    // axis is currently snapped (see captionSnap.test.ts) — asserted here as
    // false so this stays a genuine no-op check rather than an assertion about
    // the return shape.
    const d = drag({ initOffsetX: 12, initOffsetY: 34, initScale: 1.5 })
    expect(captionDragGeometry(d, d.initX, d.initY, metrics(540)))
      .toEqual({ offsetX: 12, offsetY: 34, scale: 1.5, snapX: false, snapY: false })
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

// ── measureCaptionContentRect ───────────────────────────────────────────────
//
// Captions have lanes, so a template can paint several captions at once. The
// selection box must wrap ONE of them, which is what the `segmentId` argument
// is for. These cover the scoping and — just as important — the fallback that
// keeps a template with no `data-caption-id` behaving exactly as it did before
// lanes existed.

/** Client rect with the fields the measurer reads. jsdom does no layout. */
function fixedRect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left, top, right, bottom,
    width: right - left, height: bottom - top,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

// Where each caption's text "paints", keyed by the text itself. Two boxes far
// apart on the frame, so a measurement that accidentally unions them is
// obvious rather than off by a few pixels.
const BOXES: Record<string, [left: number, top: number, right: number, bottom: number]> = {
  bottom: [100, 1700, 300, 1750],  // lane 0 — low on the frame
  top:    [400, 200,  900, 280],   // lane 1 — high on the frame
}
const BOTTOM_RECT = { left: 100, top: 1700, width: 200, height: 50 }
const TOP_RECT    = { left: 400, top: 200,  width: 500, height: 80 }
// What an unscoped walk sees: the union of both, spanning most of the frame.
const UNION_RECT  = { left: 100, top: 200,  width: 800, height: 1550 }

beforeEach(() => {
  // jsdom has no Range.prototype.getBoundingClientRect at all (and Element's
  // returns zeros), so feed the walk a rect table keyed by the text node it is
  // measuring. Assigned directly — vi.spyOn needs a pre-existing method.
  Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
    const text = this.startContainer.nodeValue?.trim() ?? ''
    const box = BOXES[text]
    return box ? fixedRect(box[0], box[1], box[2], box[3]) : fixedRect(0, 0, 0, 0)
  }
})

afterEach(() => {
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
})

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

/** Two marked caption subtrees — what the templates render for two lanes. */
const TWO_LANES =
  '<div data-caption-id="cap-bottom"><div><span>bottom</span></div></div>' +
  '<div data-caption-id="cap-top"><div><span>top</span></div></div>'

/** One caption from a template that predates `data-caption-id`. */
const UNMARKED = '<div><div><span>bottom</span></div></div>'

describe('measureCaptionContentRect — scoping to one caption', () => {
  it('measures only the requested subtree when two are marked', () => {
    const root = mount(TWO_LANES)
    expect(measureCaptionContentRect(root, 'cap-top')).toEqual(TOP_RECT)
    expect(measureCaptionContentRect(root, 'cap-bottom')).toEqual(BOTTOM_RECT)
  })

  it('unions everything under the root when no segment is named', () => {
    // The pre-lane behaviour, kept for callers that have no target in mind.
    expect(measureCaptionContentRect(mount(TWO_LANES))).toEqual(UNION_RECT)
  })

  it('finds a marker nested below the root, not just a direct child', () => {
    const root = mount(`<div class="wrapper">${TWO_LANES}</div>`)
    expect(measureCaptionContentRect(root, 'cap-top')).toEqual(TOP_RECT)
  })
})

describe('measureCaptionContentRect — fallback when the marker is absent', () => {
  it('falls back to the whole root for a template that emits no marker', () => {
    // Today's numbers, unchanged: a host-supplied or pre-lane template must
    // keep its selection box rather than losing it.
    expect(measureCaptionContentRect(mount(UNMARKED), 'cap-0')).toEqual(BOTTOM_RECT)
  })

  it('falls back to the whole root when the named segment is not the one on screen', () => {
    expect(measureCaptionContentRect(mount(TWO_LANES), 'cap-nonexistent')).toEqual(UNION_RECT)
  })

  it('an id containing selector metacharacters cannot throw — it just misses and falls back', () => {
    // project.json is hand-editable, so the lookup compares attributes rather
    // than building a `[data-caption-id="…"]` selector that a quote would break.
    expect(() => measureCaptionContentRect(mount(TWO_LANES), 'cap"]:not(*)')).not.toThrow()
    expect(measureCaptionContentRect(mount(TWO_LANES), 'cap"]:not(*)')).toEqual(UNION_RECT)
  })
})

describe('measureCaptionContentRect — nothing painted', () => {
  it('returns null for an empty subtree, so the caller hides the box', () => {
    expect(measureCaptionContentRect(mount(''))).toBeNull()
    expect(measureCaptionContentRect(mount('<div data-caption-id="cap-0"></div>'), 'cap-0')).toBeNull()
  })

  it('ignores whitespace-only text nodes', () => {
    expect(measureCaptionContentRect(mount('<div data-caption-id="cap-0">   </div>'), 'cap-0')).toBeNull()
  })

  it('returns null for the requested caption even while the OTHER one is painting', () => {
    // `pop` renders no word between two word windows; the box must disappear
    // for that caption rather than snapping onto its neighbour.
    const root = mount(
      '<div data-caption-id="cap-bottom"><div><span>bottom</span></div></div>' +
      '<div data-caption-id="cap-top"></div>',
    )
    expect(measureCaptionContentRect(root, 'cap-top')).toBeNull()
    expect(measureCaptionContentRect(root, 'cap-bottom')).toEqual(BOTTOM_RECT)
  })
})
