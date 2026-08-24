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
 * `w-1.5` (6px) on AudioTrackRow's — and on the retired CaptionTrackRow's,
 * which is why captions hit-test at the audio tolerance.
 */

import type { AudioTrack, CaptionSegment, VisualItem } from '../../../schema'
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

/** Grab band (half-width, px) around the 2px playhead line. Matches the audio
 *  trim-handle tolerance so the playhead is no harder to grab than an audio
 *  edge. A press within this many px of where the playhead is drawn starts a
 *  scrub, exactly as pressing the ruler does. */
export const PLAYHEAD_GRAB_PX = 6

/** Half-width (px) of an audio bar's fade-GRIP zone — small on purpose,
 *  matching `draw.ts`'s `FADE_GRIP_SIZE_PX` triangle it's the hit zone for.
 *  See `audioFadeGripZone`'s doc for the precedence this creates against the
 *  full-height trim edge. */
export const FADE_GRIP_HALF_WIDTH_PX = 5

/** How far down from the TOP of an audio bar the fade-grip zone reaches.
 *  Confines the grip to a small top-corner target rather than the bar's
 *  full height — which is what keeps it from swallowing the trim edge
 *  (`audio-edge`), grabbable across the bar's full height everywhere below
 *  this. */
export const FADE_GRIP_ZONE_HEIGHT_PX = 10

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
  /** On an audio bar's fade-in or fade-out GRIP — a small zone at the TOP of
   *  the bar near the fade's inner edge (or the bar's own corner, when no
   *  fade is set). Takes precedence over `audio-edge`/`audio-body` within
   *  its own small zone; see `audioFadeGripZone`'s doc for the precedence
   *  this creates and why it doesn't swallow the trim edge. */
  | 'audio-fade'
  /** Inside a caption block, away from its trim handles. */
  | 'caption-body'
  /** Inside a caption block's in/out trim handle. */
  | 'caption-edge'
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
  /** Which fade grip, on `audio-fade` hits. `in` is the fade-in grip
   *  (top-left corner or its inner edge), `out` the fade-out grip
   *  (top-right). A field of its own, deliberately NOT a reuse of `edge` —
   *  a fade grip is not a trim handle, and `isEdgeHit` (which several
   *  callers use to mean "this is a trim grab") must not go true for it. */
  side?: 'in' | 'out'
  /** Visual track index (project.tracks[trackIdx]) for row and item hits. */
  trackIdx?: number
  /** Audio lane index (the `lane` field / grouping index) for lane hits. */
  laneIdx?: number
  /** Which caption lane a caption hit resolved in — the `lane` of the band the
   *  point fell inside (see `CaptionRowLayout` in draw.ts).
   *
   *  A field of its own, deliberately NOT a reuse of `laneIdx`. That one is an
   *  AUDIO lane index and is handed straight to `tieredBoundaries`, which ranks
   *  the boundaries of THAT audio lane STRONG for the whole gesture. A caption
   *  lane and an audio lane that happen to share a number have nothing to do
   *  with each other, so passing one through the other would give a caption
   *  drag the magnets of an unrelated row. */
  captionLane?: number
  /** The hit item itself, so callers don't re-scan the project. Captured at
   *  press time by the pointer machine and used as the gesture's origin. */
  item?: VisualItem
  track?: AudioTrack
  /** The hit caption segment, for the same reason `item`/`track` are here: the
   *  pointer machine captures it at press time and reads its `start`/`end` for
   *  the whole gesture, rather than re-scanning `project.captions` per move. */
  segment?: CaptionSegment
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

/** The screen x of an audio bar's fade GRIP for one side — at the fade's
 *  inner edge when a fade is set, or at the bar's own corner when it isn't
 *  (drag inward from there to create one). Expressed in TIME-then-`timeToX`,
 *  the same convention `resolveRow` uses for every other audio-lane zone:
 *  the gutter `clipBodyRect` insets the DRAWN body by is paint, not a dead
 *  zone, so hit-testing always works over the raw span. Shares this math
 *  with `draw.ts`'s own grip placement (there expressed in already-converted
 *  px, since the painter works from a `rect` rather than a `track`) only in
 *  spirit — the two are kept independently computed because they start from
 *  different inputs, not duplicated by accident. */
function audioFadeGripX(track: AudioTrack, side: 'in' | 'out', viewport: Viewport): number {
  return side === 'in'
    ? timeToX(track.start + Math.max(0, track.fadeIn ?? 0), viewport)
    : timeToX(track.end - Math.max(0, track.fadeOut ?? 0), viewport)
}

/**
 * Does `point` fall in one of `track`'s two fade-grip zones? Returns the
 * matching side, or null.
 *
 * Confined to the TOP `FADE_GRIP_ZONE_HEIGHT_PX` of the bar (`barTop` is the
 * same y the caller already computed for the bar's vertical inset) — this,
 * not a separate x-tolerance trick, is what keeps the grip from swallowing
 * the trim edge. `audio-edge` is grabbable across the bar's FULL height; a
 * fade grip only claims a small target at the very top, near the same
 * corner, so the two zones barely overlap and where they do (no fade set,
 * grip sitting exactly at the corner) the grip wins — it is the smaller,
 * more deliberate target, the same reasoning `grabsPlayhead` already gives
 * trim edges over the playhead grab.
 */
function audioFadeGripZone(
  point: Point,
  track: AudioTrack,
  barTop: number,
  viewport: Viewport,
): 'in' | 'out' | null {
  if (point.y < barTop || point.y > barTop + FADE_GRIP_ZONE_HEIGHT_PX) return null
  const x0 = timeToX(track.start, viewport)
  const x1 = timeToX(track.end, viewport)
  if (point.x < x0 - FADE_GRIP_HALF_WIDTH_PX || point.x > x1 + FADE_GRIP_HALF_WIDTH_PX) return null
  const inX = audioFadeGripX(track, 'in', viewport)
  if (Math.abs(point.x - inX) <= FADE_GRIP_HALF_WIDTH_PX) return 'in'
  const outX = audioFadeGripX(track, 'out', viewport)
  if (Math.abs(point.x - outX) <= FADE_GRIP_HALF_WIDTH_PX) return 'out'
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

  // The caption bands. Their y-ranges are disjoint from every row and lane
  // (and from each other), so this could sit anywhere among the scans below;
  // it goes here because it was a single optional rectangle like the ruler
  // before multi-lane captions existed, and this keeps that spot.
  //
  // The loop finds WHICH band the point falls in and then runs the same
  // single-band logic against that band, reporting the band's `lane` back as
  // `captionLane` so a drag knows which row it started on. With exactly one
  // band this is byte-for-byte the pre-lanes behaviour, plus a `captionLane`
  // of 0 that nothing which doesn't care ever reads.
  for (const caption of layout.captions ?? []) {
    if (point.y < caption.y || point.y >= caption.y + caption.height) continue
    // Id-less segments are never hittable. `backfillCaptionIds` mints an id
    // shortly after captions arrive, but until it has, a segment has nothing
    // to select BY — the same guard the retired CaptionTrackRow spelled `canInteract`.
    const hittable = caption.segments.filter(
      (seg): seg is CaptionSegment & { id: string } => typeof seg.id === 'string',
    )
    // Deliberately the FULL band height, unlike the audio-lane branch below,
    // which treats its inset strip as lane background. The painter insets
    // caption blocks by the same `AUDIO_ITEM_INSET_PX`, so this is a 4px
    // cosmetic mismatch at the top and bottom — and that is much the lesser
    // evil: a 40px row whose outer 8px silently miss reads as a broken row,
    // while an audio LANE is tall enough that its inset is visibly gutter.
    //
    // The AUDIO tolerance, not a third one of its own: the retired DOM row's
    // handles were `w-1.5` like AudioTrackRow's, and the painter draws
    // caption handles at `AUDIO_HANDLE_WIDTH_PX`. Captions borrow the audio
    // handle vocabulary wholesale, so they borrow its grab width too.
    const hit = resolveRow(point.x, hittable, viewport, audioTolerance)
    if (hit === null) {
      // Not `empty-caption-row`. `background` already means exactly what the
      // gaps between caption blocks should do — marquee from here, seek here,
      // clear the selection — and a new kind would only force `isEmptyHit`
      // and `resolveGesture` to learn about it for no behavioural gain.
      return { kind: 'background', t }
    }
    if (hit.edge === null) return { kind: 'caption-body', t, itemId: hit.item.id, segment: hit.item, captionLane: caption.lane }
    return { kind: 'caption-edge', t, itemId: hit.item.id, edge: hit.edge, segment: hit.item, captionLane: caption.lane }
  }

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
      // Fade grips take precedence within their own small top-corner zone —
      // see `audioFadeGripZone`'s doc for why. Scanned back-to-front like
      // `resolveRow`, so a grip on a higher-stacked (later-drawn, crossfaded)
      // bar wins ties the same way a body/edge hit would.
      for (let i = lane.tracks.length - 1; i >= 0; i--) {
        const track = lane.tracks[i]
        const side = audioFadeGripZone(point, track, barTop, viewport)
        if (side !== null) return { kind: 'audio-fade', t, itemId: track.id, side, laneIdx: lane.laneIndex, track }
      }
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

  // Captions first, mirroring `hitTest`'s order. Id-less segments are skipped
  // for the same reason they are unhittable: an id is what a selection is.
  // One pass per band, same as the row/lane scans below — a marquee spanning
  // several caption lanes picks up segments from every band it touches.
  for (const caption of layout.captions ?? []) {
    if (!overlaps(caption.y, caption.y + caption.height, top, bottom)) continue
    for (const seg of caption.segments) {
      if (typeof seg.id === 'string' && overlaps(seg.start, seg.end, left, right)) ids.push(seg.id)
    }
  }
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

/** Do the three `*-edge` kinds and their `edge` field describe a trim grab?
 *
 *  Captions are in here deliberately, and it is load-bearing in both callers:
 *  `grabsPlayhead` lets a caption EDGE beat a playhead grab while a caption
 *  BODY yields to it, and TimelineCanvas's hover pass uses this to decide
 *  which trim handle to light up — handles the painter already draws on a
 *  selected caption. */
export function isEdgeHit(hit: HitResult): boolean {
  return hit.kind === 'item-edge' || hit.kind === 'audio-edge' || hit.kind === 'caption-edge'
}

/** Is this a hit on a clip or an audio bar (either body or edge)?
 *
 *  Captions are deliberately NOT folded in, unlike `isEdgeHit` above. This
 *  predicate has no non-test callers, so widening it would change a documented
 *  meaning that nothing currently reads, on a guess about what a future caller
 *  wants. Ask the caption question with `isCaptionHit`; a caller that wants
 *  "anything grabbable" can OR the two, and does so knowingly. */
export function isItemHit(hit: HitResult): boolean {
  return hit.kind === 'item-body' || hit.kind === 'item-edge'
    || hit.kind === 'audio-body' || hit.kind === 'audio-edge'
}

/** Is this a hit on a caption block (either body or edge)? */
export function isCaptionHit(hit: HitResult): boolean {
  return hit.kind === 'caption-body' || hit.kind === 'caption-edge'
}

/** Nothing under the point but timeline: every kind that means "seek here". */
export function isEmptyHit(hit: HitResult): boolean {
  return hit.kind === 'empty-row' || hit.kind === 'empty-lane' || hit.kind === 'background'
}
