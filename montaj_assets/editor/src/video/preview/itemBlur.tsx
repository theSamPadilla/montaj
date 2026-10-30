// A clip's blur in the preview: the `blur` the export draws with ffmpeg's
// `gblur` (montaj_assets/render/item-blur.js), here an SVG `feGaussianBlur`
// referenced from the clip's media box as a CSS `filter`.
//
// Three things make the two agree:
//
//   - THE SIGMA. `blur` is a standard deviation in design-canvas pixels (1080
//     on the short edge, timeline-core `blurOf`). On screen that is
//     `blur * renderScale`. The filter runs in the media box's own CSS pixels,
//     and a uniform clip's media box sits under the wrapper's `scale(s)`
//     (`mediaBoxStyle`), so its sigma is divided by `s` to land on screen at
//     the same size. A per-axis clip's media box is counter-scaled to a net
//     scale of 1 and takes the screen sigma as is.
//   - THE EDGES. The export blurs the fitted picture before its transparent pad
//     and reads past the picture's edge as the edge pixel again. Here the
//     filter region is the picture's rect in the box (timeline-core
//     `pictureRectInBox`: a contain-fitted video or image, the whole box for a
//     cover or fill image) and `edgeMode="duplicate"` repeats the edge pixel,
//     so a clip that fills the frame never shows dark or see-through edges.
//     CSS `filter: blur()` cannot do this: it blurs transparent pixels in.
//   - THE COLOURS. `color-interpolation-filters="sRGB"`: an SVG filter blurs in
//     linear light by default, and the export blurs the encoded values.
//
// The filter goes on the media box, the element that also carries the mask:
// CSS applies an element's filter before its mask, and the export blurs before
// it masks too.

import { useId, type CSSProperties, type ReactNode } from 'react'
import { blurOf, pictureRectInBox } from '@bycrux/timeline-core'
import type { VisualItem } from '../../schema'
import { useVideoNaturalSize } from '../useVideoNaturalSize'
import { useImageNaturalSize } from '../useImageNaturalSize'

type Size = { w: number; h: number }
type Crop = { x: number; y: number; w: number; h: number }

/** What a clip's blur needs from the layer that draws it. */
export interface ItemBlurInput {
  /** The clip (reads `blur`, `type`, `sourceWidth`/`sourceHeight`). */
  item: VisualItem
  /** The URL its picture loads: the natural size is probed from it when the item stores none. */
  src?: string
  /** The crop at the playhead (`geometryAt(...).sourceCrop`). */
  crop?: Crop
  /** An image's fit. Videos are always contain-fitted, as the export fits them. */
  fit?: 'cover' | 'contain' | 'fill'
  /** Screen pixels per design-canvas pixel. */
  renderScale: number
  /** The design canvas, RENDER_W x RENDER_H. */
  canvasW: number
  canvasH: number
  /** The clip's box scale on screen. */
  scaleX: number
  scaleY: number
  /** A fallback for the picture's size until the probe of `src` answers (the base clip's loaded `<video>`). */
  knownSize?: Size | null
}

/** The SVG filter for a blur: its sigma in the media box's own pixels and its region in the box. */
export interface BlurFilterSpec {
  sigma: number
  rect: { x: number; y: number; w: number; h: number }
}

const drawable = (s: number) => s > 0 && Number.isFinite(s)
const known = (s: Size | null | undefined): s is Size => !!s && drawable(s.w) && drawable(s.h)

/**
 * The size of the picture that fills the clip's box, after its crop: a
 * video's footage, a `contain` image's pixels; null when it fills the whole box
 * (a `cover` or `fill` image) or is not known yet.
 */
export function pictureSizeFor(item: VisualItem, crop: Crop | undefined, fit: ItemBlurInput['fit'], natural: Size | null | undefined): Size | null {
  if (item.type === 'image' && fit !== 'contain') return null
  const stored = item.type === 'video' && drawable(item.sourceWidth ?? 0) && drawable(item.sourceHeight ?? 0)
    ? { w: item.sourceWidth as number, h: item.sourceHeight as number }
    : null
  const size = stored ?? (known(natural) ? natural : null)
  if (!size) return null
  // A video's crop needs its stored size, as the export's does; without one it renders uncropped.
  const cropApplies = crop && drawable(crop.w) && drawable(crop.h) && (item.type === 'image' || stored)
  return cropApplies ? { w: size.w * crop.w, h: size.h * crop.h } : size
}

/**
 * The blur's SVG filter, or null when the clip has none. Pure: the hook
 * {@link useItemBlur} renders it.
 */
export function blurFilterSpec(input: Omit<ItemBlurInput, 'src' | 'knownSize'>, picture: Size | null): BlurFilterSpec | null {
  const b = blurOf(input.item)
  if (b === 0 || !drawable(input.renderScale)) return null
  const { scaleX: sx, scaleY: sy } = input
  // mediaBoxStyle: a uniform box (or one it cannot draw per axis) is the full
  // frame under the wrapper's scale(s); a per-axis one has a net scale of 1.
  const uniform = sx === sy || !drawable(sx) || !drawable(sy)
  const local = uniform && drawable(sx) ? sx : 1
  const sigma = (b * input.renderScale) / local
  const rect = pictureRectInBox(input.canvasW * sx, input.canvasH * sy, picture?.w, picture?.h)
  return { sigma, rect }
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000)

/**
 * The clip's blur as a style for its media box (`filter: url(#…)`) and the
 * SVG that defines the filter, to render inside that box. `{}` and null for a
 * clip with no blur. Always call it (it holds hooks); pass null for no clip.
 */
export function useItemBlur(input: ItemBlurInput | null): { style: CSSProperties; defs: ReactNode } {
  const id = 'montaj-blur-' + useId().replace(/[^A-Za-z0-9_-]/g, '')
  const wants = !!input && blurOf(input.item) > 0
  const item = input?.item
  const needsVideo = wants && item?.type === 'video'
    && !(drawable(item.sourceWidth ?? 0) && drawable(item.sourceHeight ?? 0))
  const needsImage = wants && item?.type === 'image' && input?.fit === 'contain'
  const videoSize = useVideoNaturalSize(needsVideo ? input?.src : undefined)
  const imageSize = useImageNaturalSize(needsImage ? input?.src : undefined)
  if (!input || !wants) return { style: {}, defs: null }
  const natural = item?.type === 'image' ? imageSize : (known(videoSize) ? videoSize : input.knownSize)
  const spec = blurFilterSpec(input, pictureSizeFor(input.item, input.crop, input.fit, natural))
  if (!spec) return { style: {}, defs: null }
  const { sigma, rect } = spec
  return {
    style: { filter: `url(#${id})` },
    defs: (
      <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <filter
          id={id}
          data-montaj-blur=""
          filterUnits="objectBoundingBox"
          x={fmt(rect.x)}
          y={fmt(rect.y)}
          width={fmt(rect.w)}
          height={fmt(rect.h)}
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation={fmt(sigma)} edgeMode="duplicate" />
        </filter>
      </svg>
    ),
  }
}
