import type { CaptionSegment } from '../schema'

/**
 * Is the playhead at `t` already inside `seg`, by the rule that decides
 * whether a caption is on screen?
 *
 * Selecting a caption (a timeline click, a captions-list row click) jumps the
 * playhead to the caption's start so the preview can show it and offer its
 * drag handles. When the caption is already on screen that jump only loses the
 * operator's place, so both sites skip it when this returns true.
 *
 * The test is the one `activeCaptionSegments` (timeline-core) applies: snap
 * `t` to the frame grid, then `start <= t < end`, half-open. At exactly
 * `t == end` the caption is not on screen, so this is false and the jump
 * still fires. `fps` falls back to 30 when it is not a positive finite number,
 * the same guard both seek sites apply to their half-frame nudge.
 */
export function playheadInside(
  seg: Pick<CaptionSegment, 'start' | 'end'>,
  t: number,
  fps: number,
): boolean {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30
  const snapped = Math.round(t * safeFps) / safeFps
  return snapped >= seg.start && snapped < seg.end
}
