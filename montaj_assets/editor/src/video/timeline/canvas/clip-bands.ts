/**
 * The horizontal split inside a video clip: frames on top, waveform below.
 *
 * Its own module rather than a helper in `draw.ts` because all three painters
 * need it and `draw.ts` already imports values FROM `waveforms.ts` — putting
 * the split there and importing it back would make that cycle a real one
 * rather than the type-only edge it is today.
 *
 * One function owning the split is the point: `filmstrips.ts` sizes its tile
 * grid from `frames.height` and `waveforms.ts` scales its bars to
 * `waveform.height`, so the two bands cannot drift out of alignment or
 * overlap at any row height. Non-video items (overlays, images) ask for
 * neither band and are unaffected.
 */
import type { Rect } from './draw'

/**
 * Share of a clip's height given to the waveform; the frames band takes the
 * rest. An even split is a deliberate departure from CapCut's frames-heavy
 * ~70/30 — audio is what you actually cut against in a talking-head edit, and
 * the frames band stays legible at half of a 120px row.
 */
export const CLIP_WAVEFORM_FRACTION = 0.5

/** Hairline left clear at the clip's top and bottom edge so neither band
 *  paints over the 1px border/selection ring `drawClipRect` strokes there. */
export const CLIP_BAND_INSET_PX = 1

export interface ClipBands {
  /** Filmstrip tiles. */
  frames: Rect
  /** Waveform bars, directly below `frames` with no gap. */
  waveform: Rect
}

/**
 * Split `rect` into its two bands. Total height is conserved exactly (the
 * frames band absorbs the rounding remainder), so the bands always tile the
 * inset rect with no seam gap and no overlap.
 *
 * Degenerate rects are handled rather than special-cased by the callers: a
 * rect too short to inset drops the inset, and a zero-height rect yields two
 * zero-height bands that every painter already skips on its own
 * `height <= 0` guard.
 */
export function clipBands(rect: Rect): ClipBands {
  const inset = rect.height >= CLIP_BAND_INSET_PX * 4 ? CLIP_BAND_INSET_PX : 0
  const inner = Math.max(0, rect.height - inset * 2)
  const waveformHeight = Math.round(inner * CLIP_WAVEFORM_FRACTION)
  const framesHeight = Math.max(0, inner - waveformHeight)
  const top = rect.y + inset
  return {
    frames: { x: rect.x, y: top, width: rect.width, height: framesHeight },
    waveform: { x: rect.x, y: top + framesHeight, width: rect.width, height: waveformHeight },
  }
}
