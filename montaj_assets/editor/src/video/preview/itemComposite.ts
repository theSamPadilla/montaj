// A clip's compositing in the preview (§616): its opacity at an instant, its
// mask and its blend mode, as CSS.
//
// Nothing is computed here. Every value is read off @bycrux/timeline-core, the
// functions the export samples too: `opacityAt` for the fade, `maskAt` for the
// mask at the instant (keyframes over stored fields over defaults), `maskSvg`
// for its shape (THE polygon the render rasterizes, feathered by the same
// Gaussian sigma), and `blendModeOf` / `cssBlendMode` for the blend. So a mask
// or a fade cannot look one way here and another in the export.
//
// Three parts, because they belong on different elements (see compositeParts):
//
//   - `opacity` and the blend go on the element that is a direct child of the
//     preview frame (an item's wrapper, the base clip's transform container).
//     `mix-blend-mode` blends with what is already painted in the nearest
//     isolated group, and every stacking context is one: put on anything
//     nested deeper, the blend would see only its own parent and do nothing.
//   - the mask goes on the element whose CSS box IS the clip's box, the media
//     box (`mediaBoxStyle`). The SVG's viewBox is that box, so it maps on
//     without distortion and a round feather stays round under a per-axis
//     scale; and the selection outline and handles, which the wrapper carries,
//     stay unmasked.
//
// Overlays take none of this: callers pass clips only.

import type { CSSProperties } from 'react'
import { blendModeOf, cssBlendMode, maskAt, maskSvg, opacityAt } from '@bycrux/timeline-core'
import type { VisualItem } from '../../schema'

/** The mask style keys. `WebkitMaskMode` is not in React's CSS types. */
export type MaskStyle = Pick<CSSProperties,
  'maskImage' | 'maskSize' | 'maskRepeat' | 'maskMode' | 'WebkitMaskImage' | 'WebkitMaskSize' | 'WebkitMaskRepeat'
> & { WebkitMaskMode?: string }

export interface CompositeParts {
  /** `opacityAt` at the instant: the track when there is one, else the static opacity, else 1. */
  opacity: number
  /** `{ mixBlendMode }`, or empty for `normal`. */
  blend: Pick<CSSProperties, 'mixBlendMode'>
  /** The mask as a CSS mask image over the element, or empty for no mask. */
  mask: MaskStyle
}

/**
 * The item's compositing at item-relative `localT`, split by the element that
 * carries each part. `boxW` x `boxH` is the clip's box in preview pixels (the
 * frame times scaleX by the frame times scaleY): the mask's fractions and its
 * feather are relative to it.
 */
export function compositeParts(item: VisualItem, localT: number, boxW: number, boxH: number): CompositeParts {
  const mode = blendModeOf(item)
  const blend: CompositeParts['blend'] = mode === 'normal'
    ? {}
    : { mixBlendMode: cssBlendMode(mode) as CSSProperties['mixBlendMode'] }

  const resolved = maskAt(item, localT)
  let mask: MaskStyle = {}
  // An empty box draws nothing whatever the mask; an SVG over it has no shape.
  if (resolved && boxW > 0 && boxH > 0 && Number.isFinite(boxW) && Number.isFinite(boxH)) {
    const image = `url("data:image/svg+xml,${encodeURIComponent(maskSvg(resolved, boxW, boxH))}")`
    // Luminance: the SVG is opaque black and white, so the default (the
    // image's alpha) would show everything.
    mask = {
      maskImage: image,
      maskSize: '100% 100%',
      maskRepeat: 'no-repeat',
      maskMode: 'luminance',
      WebkitMaskImage: image,
      WebkitMaskSize: '100% 100%',
      WebkitMaskRepeat: 'no-repeat',
      WebkitMaskMode: 'luminance',
    }
  }

  return { opacity: opacityAt(item, localT), blend, mask }
}

/**
 * The item's compositing at item-relative `localT` as ONE style: `opacity`
 * (a string, only when below 1), `mixBlendMode` (only when not `normal`) and the
 * mask keys (only with a mask). `{}` for a plain item. Pure.
 */
export function itemCompositeStyle(item: VisualItem, localT: number, boxW: number, boxH: number): CSSProperties & MaskStyle {
  const { opacity, blend, mask } = compositeParts(item, localT, boxW, boxH)
  return { ...(opacity !== 1 ? { opacity: String(opacity) } : null), ...blend, ...mask }
}
