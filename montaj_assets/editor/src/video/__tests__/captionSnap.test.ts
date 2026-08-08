/**
 * Centre/middle snap for the caption move gesture.
 *
 * Regression: the first implementation of `captionDragGeometry` translated the
 * segment with no snapping at all, so captions were the only draggable thing in
 * the preview that would not settle on the frame's centre line — overlays did,
 * captions did not. Edge snap remains deliberately absent (its geometry does
 * not transfer to a content-sized anchor box); only centre/middle is expected.
 */
import { describe, it, expect } from 'vitest'
import {
  captionDragGeometry,
  captionDragPatch,
  CAPTION_SNAP_THRESHOLD,
  type CaptionDragState,
  type CaptionFrameMetrics,
} from '../preview/captionDragState'

// previewScale 1 with a 1080x1920 design frame: 1 screen px == 1 design px, so
// a dx of 10.8px is exactly 1% of frame width.
const METRICS: CaptionFrameMetrics = { previewScale: 1, renderW: 1080, renderH: 1920 }
const PX_PER_PCT_X = 1080 / 100
const PX_PER_PCT_Y = 1920 / 100

function move(initOffsetX: number, initOffsetY: number): CaptionDragState {
  return {
    id: 'cap-1', type: 'move',
    initX: 0, initY: 0,
    initOffsetX, initOffsetY, initScale: 1,
  }
}

describe('captionDragGeometry — centre/middle snap', () => {
  it('snaps offsetX to exactly 0 inside the threshold', () => {
    // Start 5% left of centre, drag right to land 1% past centre (inside 2.5%).
    const g = captionDragGeometry(move(-5, 40), 6 * PX_PER_PCT_X, 0, METRICS)
    expect(g.offsetX).toBe(0)
    expect(g.snapX).toBe(true)
  })

  it('snaps offsetY to exactly 0 inside the threshold', () => {
    const g = captionDragGeometry(move(40, -5), 0, 6 * PX_PER_PCT_Y, METRICS)
    expect(g.offsetY).toBe(0)
    expect(g.snapY).toBe(true)
  })

  it('snaps both axes at once when dragged through the centre point', () => {
    const g = captionDragGeometry(move(-1, -1), PX_PER_PCT_X, PX_PER_PCT_Y, METRICS)
    expect(g).toMatchObject({ offsetX: 0, offsetY: 0, snapX: true, snapY: true })
  })

  it('does NOT snap outside the threshold — the raw offset is preserved', () => {
    // Land 4% right of centre: outside 2.5%, so no snap and no rounding.
    const g = captionDragGeometry(move(0, 40), 4 * PX_PER_PCT_X, 0, METRICS)
    expect(g.offsetX).toBeCloseTo(4, 6)
    expect(g.snapX).toBe(false)
  })

  it('uses the same threshold as the overlay hook', () => {
    // Just inside snaps, just outside does not — pinning the boundary so the
    // two gestures cannot drift apart.
    const inside  = captionDragGeometry(move(0, 40), (CAPTION_SNAP_THRESHOLD - 0.1) * PX_PER_PCT_X, 0, METRICS)
    const outside = captionDragGeometry(move(0, 40), (CAPTION_SNAP_THRESHOLD + 0.1) * PX_PER_PCT_X, 0, METRICS)
    expect(inside.snapX).toBe(true)
    expect(outside.snapX).toBe(false)
  })

  it('commits the snapped value, not the raw pointer position', () => {
    const d = move(-5, 40)
    const g = captionDragGeometry(d, 6 * PX_PER_PCT_X, 0, METRICS)
    expect(captionDragPatch(d, g)).toEqual({ offsetX: 0, offsetY: g.offsetY })
  })

  it('leaves resize gestures unsnapped and untouched', () => {
    const d: CaptionDragState = {
      id: 'cap-1', type: 'resize-se',
      initX: 0, initY: 0, initOffsetX: 1, initOffsetY: 1, initScale: 1,
    }
    const g = captionDragGeometry(d, 20, 20, METRICS)
    // A resize must never move the segment, and must not report a snap.
    expect(g.offsetX).toBe(1)
    expect(g.offsetY).toBe(1)
    expect(g.snapX).toBeUndefined()
    expect(g.snapY).toBeUndefined()
    expect(captionDragPatch(d, g)).toEqual({ scale: g.scale })
  })
})
