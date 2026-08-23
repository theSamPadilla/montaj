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
  /** The time ruler strip along the top. Scrubbing lives here, and only here:
   *  the track area's empty space belongs to the marquee now. */
  | 'ruler'
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

/** One row's worth of hit resolution, shared by the visual and audio scans.
 *
 * Edges beat bodies ACROSS the whole row, and the nearest edge wins.
 *
 * The obvious rule — topmost item wins, and within it an edge beats its own
 * body — is what this replaces, and it made the trailing edge of an
 * overlapped clip completely ungrabbable. Where clip B overlaps the end of
 * clip A, every point near A's out edge is also inside B, and B is on top, so
 * the scan returned B's body and stopped. You could see A's edge; you could
 * not trim it. Crossfaded audio bars had the same hole, permanently.
 *
 * Nearest-edge-wins fixes it without disturbing the ordinary case: a point is
 * only ever a candidate for items whose span actually contains it, and for
 * clips that merely touch, the shared boundary is equidistant, so the tie
 * falls to the topmost item exactly as before. Ties resolve to the topmost
 * because the scan runs back-to-front and only a STRICTLY nearer edge
 * displaces the incumbent.
 */
function resolveRow<T extends { id: string; start: number; end: number }>(
  x: number,
  items: readonly T[],
  viewport: Viewport,
  tolerance: number,
): { item: T; edge: 'in' | 'out' } | { item: T; edge: null } | null {
  let bestEdge: { item: T; edge: 'in' | 'out'; dist: number } | null = null
  let topBody: T | null = null

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    const x0 = timeToX(item.start, viewport)
    const x1 = timeToX(item.end, viewport)
    const zone = spanZone(x, x0, x1, tolerance)
    if (zone === null) continue
    if (zone === 'body') {
      if (topBody === null) topBody = item
      continue
    }
    const dist = zone === 'in' ? x - x0 : x1 - x
    if (bestEdge === null || dist < bestEdge.dist) bestEdge = { item, edge: zone, dist }
  }

  if (bestEdge !== null) return { item: bestEdge.item, edge: bestEdge.edge }
  if (topBody !== null) return { item: topBody, edge: null }
  return null
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

  // Before the rows, and including everything above the strip: a pointer that
  // has run off the top of the surface is still aiming at the ruler, and
  // clamping it there keeps a scrub alive when the hand drifts upward
  // mid-drag rather than dropping the gesture on the floor.
  if (point.y < layout.ruler.y + layout.ruler.height) return { kind: 'ruler', t }

  for (const row of layout.rows) {
    if (point.y < row.y || point.y >= row.y + row.height) continue
    const hit = resolveRow(point.x, row.items, viewport, visualTolerance)
    if (hit === null) return { kind: 'empty-row', t, trackIdx: row.trackIdx }
    if (hit.edge === null) return { kind: 'item-body', t, itemId: hit.item.id, trackIdx: row.trackIdx, item: hit.item }
    return { kind: 'item-edge', t, itemId: hit.item.id, edge: hit.edge, trackIdx: row.trackIdx, item: hit.item }
  }

  for (const lane of layout.lanes) {
    if (point.y < lane.y || point.y >= lane.y + lane.height) continue
    // Audio bars are inset vertically (`top-1 bottom-1`); the inset strip is
    // lane background in the DOM too, not part of the bar.
    const barTop = lane.y + AUDIO_ITEM_INSET_PX
    const barBottom = lane.y + lane.height - AUDIO_ITEM_INSET_PX
    if (point.y >= barTop && point.y < barBottom) {
      const hit = resolveRow(point.x, lane.tracks, viewport, audioTolerance)
      if (hit !== null) {
        if (hit.edge === null) return { kind: 'audio-body', t, itemId: hit.item.id, laneIdx: lane.laneIndex, track: hit.item }
        return { kind: 'audio-edge', t, itemId: hit.item.id, edge: hit.edge, laneIdx: lane.laneIndex, track: hit.item }
      }
    }
    return { kind: 'empty-lane', t, laneIdx: lane.laneIndex }
  }

  return { kind: 'background', t }
}

export interface SurfaceRect { x: number; y: number; width: number; height: number }

/** A rect from two corners, in any drag direction. A marquee dragged up-left
 *  is the same box as one dragged down-right; normalizing here means every
 *  consumer can assume non-negative width and height. */
export function normalizeRect(a: Point, b: Point): SurfaceRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/**
 * Every item id the marquee box touches — visual clips and audio bars alike.
 *
 * Touch, not containment: a box only counts items it fully encloses forces you
 * to drag past the ends of long clips to catch them, which on a zoomed-in
 * timeline can mean dragging off-screen. Every NLE uses intersection, and so
 * does the reference this was built from.
 *
 * Rows are tested against the box in surface space and spans in time space, so
 * a tall thin box down one moment in time selects across every track at once —
 * which is the gesture's most useful form.
 */
export function itemsInRect(
  rect: SurfaceRect,
  layout: TimelineLayout,
  viewport: Viewport,
): string[] {
  const ids: string[] = []
  const left = xToTime(rect.x, viewport)
  const right = xToTime(rect.x + rect.width, viewport)
  const top = rect.y
  const bottom = rect.y + rect.height

  for (const row of layout.rows) {
    if (!overlaps(row.y, row.y + row.height, top, bottom)) continue
    for (const item of row.items) {
      if (overlaps(item.start, item.end, left, right)) ids.push(item.id)
    }
  }
  for (const lane of layout.lanes) {
    if (!overlaps(lane.y, lane.y + lane.height, top, bottom)) continue
    for (const track of lane.tracks) {
      if (overlaps(track.start, track.end, left, right)) ids.push(track.id)
    }
  }
  return ids
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
