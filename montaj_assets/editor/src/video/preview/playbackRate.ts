/**
 * The one way this editor sets a media element's `playbackRate`.
 *
 * Chrome accepts only `[0.0625, 16]` and THROWS (`NotSupportedError`) on
 * anything else, so a clip the AI slowed to a near-freeze (`speed: 0.05`) or
 * sped past 16x used to crash the whole preview panel. Every assignment goes
 * through `setPlaybackRate`, which clamps into that range and never throws.
 *
 * Clamping alone keeps the panel alive but plays an out-of-range clip at the
 * wrong rate, so callers also ask `rateFits`: a clip whose speed does not fit
 * is driven by seeking a paused element to `inPoint + S·(t − start)` instead of
 * by letting it play (see `useVideoPlayback`'s held clip and `OverlayVideo`).
 */
export const MIN_ELEMENT_RATE = 0.0625
export const MAX_ELEMENT_RATE = 16

/** Whether an element can play at `rate` as is. */
export function rateFits(rate: number): boolean {
  return Number.isFinite(rate) && rate >= MIN_ELEMENT_RATE && rate <= MAX_ELEMENT_RATE
}

/** `rate` clamped into what an element accepts; a non-finite or non-positive rate reads as 1. */
export function safeRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1
  return Math.min(MAX_ELEMENT_RATE, Math.max(MIN_ELEMENT_RATE, rate))
}

/** Sets `el.playbackRate` to `safeRate(rate)`. Never throws. */
export function setPlaybackRate(el: HTMLMediaElement, rate: number): void {
  try {
    el.playbackRate = safeRate(rate)
  } catch {
    // An engine with a narrower range than Chrome's: keep the preview alive.
  }
}

/**
 * Source seconds between a held element's frame and its target before a
 * re-seek: about one frame at 60 fps, so a near-freeze seeks only when the
 * picture would actually change, and a fast clip seeks every animation frame.
 */
export const HELD_SEEK_EPS = 1 / 60
