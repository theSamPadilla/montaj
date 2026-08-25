/**
 * Keyframe-strip geometry (SP9b T3.3) — the handful of pure helpers shared by
 * the painter (`draw.ts`'s `drawKeyframeStrip`) and the hit-tester
 * (`hit-test.ts`'s keyframe zone), so a diamond's clickable zone is always
 * exactly where it is drawn. Mirrors why `fade-curve.ts` is its own module
 * rather than living inside either caller: one function, two readers, no risk
 * of the two positions drifting apart.
 *
 * The strip draws ONE diamond per DISTINCT keyframe TIME across ALL of an
 * item's keyframe tracks — a merged strip, not one row per property (plan
 * decision 2). `keyframeUnionTimes` is that union; `keyframeDiamondX` is
 * where the diamond for one of those times lands on screen.
 */

import type { VisualItem } from '../../../schema'
import { timeToX, type Viewport } from './viewport'

/** Edge-to-edge size (px) of a drawn diamond. Mirrors `FADE_GRIP_SIZE_PX`'s
 *  role for the fade grip: the one number both the painter and the
 *  hit-tester measure the shape by. */
export const KEYFRAME_DIAMOND_SIZE_PX = 8

/** Half-width (px) of a diamond's CLICKABLE zone — a little roomier than the
 *  diamond itself is drawn, the same margin `FADE_GRIP_HALF_WIDTH_PX` gives
 *  the fade grip over `FADE_GRIP_SIZE_PX`. */
export const KEYFRAME_HIT_HALF_WIDTH_PX = 6

/** Gap (px) between the diamond's own centre and the clip body's bottom
 *  edge, so it doesn't sit flush on the border. */
export const KEYFRAME_STRIP_BOTTOM_PAD_PX = 4

/** How tall the strip's clickable zone is, measured up from the BOTTOM of the
 *  row — mirrors `FADE_GRIP_ZONE_HEIGHT_PX` confining the fade grip to the
 *  bar's top. Confines diamonds to a thin band along the bottom so they never
 *  compete with the trim handles (grabbable across the row's full height) or
 *  the clip label (pinned to the top) anywhere but right at the diamond's own
 *  small target — the same "small dedicated zone wins locally, the rest of
 *  the edge is untouched" precedent `audioFadeGripZone` sets.
 *
 * DERIVED, not a hand-picked number, so it can never drift out of sync with
 * where a diamond is actually drawn (`drawKeyframeStrip`'s `y = body.y +
 * body.height - KEYFRAME_DIAMOND_SIZE_PX / 2 - KEYFRAME_STRIP_BOTTOM_PAD_PX`,
 * with the diamond's own half-height extending `KEYFRAME_DIAMOND_SIZE_PX / 2`
 * above and below that centre). A previous hand-picked `10` put the zone at
 * `[bottom-10, bottom)` against a diamond actually drawn at `[bottom-12,
 * bottom-4]` — the diamond's own top 2px fell OUTSIDE the clickable zone,
 * while 4px of empty space below the diamond fell INSIDE it. This value is
 * exactly `KEYFRAME_DIAMOND_SIZE_PX + KEYFRAME_STRIP_BOTTOM_PAD_PX`, which
 * puts the zone's own top edge exactly at the diamond's top edge (both
 * measured up from the same `bottom` reference), so the diamond's full height
 * is inside the zone with no gap. */
export const KEYFRAME_STRIP_ZONE_HEIGHT_PX = KEYFRAME_DIAMOND_SIZE_PX + KEYFRAME_STRIP_BOTTOM_PAD_PX

/**
 * Every DISTINCT keyframe time (item-relative seconds) across all of `item`'s
 * keyframe tracks, ascending and de-duplicated. This IS the "union of times"
 * plan decision 2 describes: several props sharing a `t` collapse to one
 * diamond, so the strip stays a strip rather than becoming a curve editor.
 */
export function keyframeUnionTimes(item: VisualItem): number[] {
  const seen = new Set<number>()
  for (const track of item.keyframes ?? []) {
    for (const point of track.points) seen.add(point.t)
  }
  return [...seen].sort((a, b) => a - b)
}

/** Screen x for the diamond at item-relative time `t` on `item` — `item.start
 *  + t` run through the SAME seconds→px conversion every other draw/hit-test
 *  call on this surface uses (plan decision 3: never invent a parallel one). */
export function keyframeDiamondX(item: VisualItem, t: number, viewport: Viewport): number {
  return timeToX(item.start + t, viewport)
}
