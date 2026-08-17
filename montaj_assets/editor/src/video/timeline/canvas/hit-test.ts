/**
 * Canvas timeline hit-testing (SP5 T5) — point → target, and nothing else.
 *
 * The DOM timeline never needed this: each clip was an element, so the browser
 * did the hit-testing and every gesture arrived pre-addressed. On canvas there
 * is one surface and one pointer stream, so the address has to be computed.
 *
 * Two rules keep this honest:
 *
 * 1. **Layout is read, never re-derived.** Rows and lanes come from
 *    `computeTimelineLayout` (draw.ts) — the same rectangles the painter fills.
 *    A hit-test that computed its own geometry would drift from the picture the
 *    moment a row height changed, and the drift would show up as "I clicked the
 *    clip and nothing happened".
 * 2. **No DOM.** The point is already surface-relative CSS pixels. Everything
 *    here is arithmetic over the layout and the viewport, so every case is a
 *    unit test rather than a browser session.
 *
 * Edge tolerances are the DOM resize-handle widths, so a trim grab that worked
 * on the old timeline works here: `w-2.5` (10px) on VisualTrackRow's handles,
 * `w-1.5` (6px) on AudioTrackRow's.
 */

import type { AudioTrack, VisualItem } from '../../../schema'
import { AUDIO_ITEM_INSET_PX, type TimelineLayout } from './draw'
import { timeToX, xToTime, type Viewport } from './viewport'

export interface Point {
  x: number
  y: number
}

/** VisualTrackRow's `w-2.5` resize handles. */
export const VISUAL_EDGE_TOLERANCE_PX = 10

/** AudioTrackRow's `w-1.5` resize handles. */
export const AUDIO_EDGE_TOLERANCE_PX = 6

export interface HitTestOptions {
  visualEdgeTolerancePx?: number
  audioEdgeTolerancePx?: number
}

export type HitKind =
  /** Inside a visual clip, away from its trim handles. */
  | 'item-body'
  /** Inside a visual clip's in/out trim handle. */
  | 'item-edge'
  /** Inside an audio bar, away from its trim handles. */
  | 'audio-body'
  | 'audio-edge'
  /** A visual row, but no clip under the point. */
  | 'empty-row'
  /** An audio lane, but no bar under the point (includes the lane's inset). */
  | 'empty-lane'
  /** Outside every row: the gaps between rows, and anything past the last one. */
  | 'background'

export interface HitResult {
  kind: HitKind
  /** Time at the point's x. Always present — every gesture needs it, and a
   *  point outside the rows is still a point in time. */
  t: number
  itemId?: string
  /** Which trim handle, on the two `*-edge` kinds. `in` is the left/start
   *  handle, `out` the right/end one — the vocabulary `cuts.ts` uses for source
   *  windows, rather than the DOM hook's `start`/`end`. */
  edge?: 'in' | 'out'
  /** Visual track index (project.tracks[trackIdx]) for row and item hits. */
  trackIdx?: number
  /** Audio lane index (the `lane` field / grouping index) for lane hits. */
  laneIdx?: number
  /** The hit item itself, so callers don't re-scan the project. Captured at
   *  press time by the pointer machine and used as the gesture's origin. */
  item?: VisualItem
  track?: AudioTrack
}

/** Which part of a horizontal span [x0, x1] a point falls in, given the handle
 *  width. Returns null when the point is outside the span entirely.
 *
 *  Handles sit INSIDE the span, exactly as the DOM's absolutely-positioned
 *  `left-0`/`right-0` handle divs do. When a clip is narrower than two handles
 *  the two zones overlap, and the out handle wins — matching the DOM, where the
 *  right handle is painted last and therefore hit-tests first. */
function spanZone(x: number, x0: number, x1: number, tolerance: number): 'body' | 'in' | 'out' | null {
  if (x < x0 || x > x1) return null
  if (x >= x1 - tolerance) return 'out'
  if (x <= x0 + tolerance) return 'in'
  return 'body'
}

/**
 * Resolve a surface-space point to what sits under it.
 *
 * Items within a row are scanned back-to-front (last in the array first), which
 * is the order the painter draws them and therefore the order the DOM stacked
 * them: the clip drawn on top is the clip you grab. Row bounds are half-open on
 * the bottom edge so the 4px inter-row gap belongs to neither neighbour.
 */
export function hitTest(
  point: Point,
  layout: TimelineLayout,
  viewport: Viewport,
  opts: HitTestOptions = {},
): HitResult {
  const t = xToTime(point.x, viewport)
  const visualTolerance = opts.visualEdgeTolerancePx ?? VISUAL_EDGE_TOLERANCE_PX
  const audioTolerance = opts.audioEdgeTolerancePx ?? AUDIO_EDGE_TOLERANCE_PX

  for (const row of layout.rows) {
    if (point.y < row.y || point.y >= row.y + row.height) continue
    for (let i = row.items.length - 1; i >= 0; i--) {
      const item = row.items[i]
      const zone = spanZone(point.x, timeToX(item.start, viewport), timeToX(item.end, viewport), visualTolerance)
      if (zone === null) continue
      if (zone === 'body') return { kind: 'item-body', t, itemId: item.id, trackIdx: row.trackIdx, item }
      return { kind: 'item-edge', t, itemId: item.id, edge: zone, trackIdx: row.trackIdx, item }
    }
    return { kind: 'empty-row', t, trackIdx: row.trackIdx }
  }

  for (const lane of layout.lanes) {
    if (point.y < lane.y || point.y >= lane.y + lane.height) continue
    // Audio bars are inset vertically (`top-1 bottom-1`); the inset strip is
    // lane background in the DOM too, not part of the bar.
    const barTop = lane.y + AUDIO_ITEM_INSET_PX
    const barBottom = lane.y + lane.height - AUDIO_ITEM_INSET_PX
    if (point.y >= barTop && point.y < barBottom) {
      for (let i = lane.tracks.length - 1; i >= 0; i--) {
        const track = lane.tracks[i]
        const zone = spanZone(point.x, timeToX(track.start, viewport), timeToX(track.end, viewport), audioTolerance)
        if (zone === null) continue
        if (zone === 'body') return { kind: 'audio-body', t, itemId: track.id, laneIdx: lane.laneIndex, track }
        return { kind: 'audio-edge', t, itemId: track.id, edge: zone, laneIdx: lane.laneIndex, track }
      }
    }
    return { kind: 'empty-lane', t, laneIdx: lane.laneIndex }
  }

  return { kind: 'background', t }
}

/** Do the two `*-edge` kinds and their `edge` field describe a trim grab? */
export function isEdgeHit(hit: HitResult): boolean {
  return hit.kind === 'item-edge' || hit.kind === 'audio-edge'
}

/** Is this a hit on a clip or an audio bar (either body or edge)? */
export function isItemHit(hit: HitResult): boolean {
  return hit.kind === 'item-body' || hit.kind === 'item-edge'
    || hit.kind === 'audio-body' || hit.kind === 'audio-edge'
}

/** Nothing under the point but timeline: every kind that means "seek here". */
export function isEmptyHit(hit: HitResult): boolean {
  return hit.kind === 'empty-row' || hit.kind === 'empty-lane' || hit.kind === 'background'
}
