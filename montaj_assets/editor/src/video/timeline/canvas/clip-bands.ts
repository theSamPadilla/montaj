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
 * overlap at any row height. Overlays ask for neither band and are
 * unaffected. Images ask for the frames band only — a still has no audio, so
 * `filmstrips.ts` tiles its one decoded photo into `frames` the same way a
 * video's sheet tiles go there, and the waveform band stays empty.
 */
import type { Rect } from './draw'

/**
 * Share of a clip's height given to the waveform; the frames band takes the
 * rest. A third (40px of the 120px base row): timeline look B gives the
 * picture the room and keeps the waveform as a slim band under it, still
 * tall enough to cut against.
 */
export const CLIP_WAVEFORM_FRACTION = 1 / 3

/** Edge left clear at the clip's top and bottom. Zero: the frames fill the
 *  clip edge to edge, and `drawClipRect` strokes its 2px border over them
 *  after the content, so nothing needs to stay clear of it. */
export const CLIP_BAND_INSET_PX = 0

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
  const inset = CLIP_BAND_INSET_PX > 0 && rect.height >= CLIP_BAND_INSET_PX * 4 ? CLIP_BAND_INSET_PX : 0
  const inner = Math.max(0, rect.height - inset * 2)
  const waveformHeight = Math.round(inner * CLIP_WAVEFORM_FRACTION)
  const framesHeight = Math.max(0, inner - waveformHeight)
  const top = rect.y + inset
  return {
    frames: { x: rect.x, y: top, width: rect.width, height: framesHeight },
    waveform: { x: rect.x, y: top + framesHeight, width: rect.width, height: waveformHeight },
  }
}
