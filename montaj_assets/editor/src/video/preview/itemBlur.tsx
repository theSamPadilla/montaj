// A clip's blur in the preview: the `blur` the export draws with ffmpeg
// (montaj_assets/render/item-blur.js), here an SVG filter referenced from the
// clip's media box as a CSS `filter`.
//
// What both compute: a Gaussian blur that averages only the picture's own
// pixels. Near an edge the weights falling outside the picture are dropped and
// the rest renormalised, so the edges stay opaque and keep their own colour,
// and the clip's alpha is kept as it was. The filter:
//
//   1. cuts the source to the picture's rect in the box (an feFlood over that
//      rect, composited `in`): a contain-fitted video or image, the whole box
//      for a cover or fill image (timeline-core `pictureRectInBox`). Whatever
//      is around the picture, a transparent letterbox or the engine canvas's
//      black bars, then weighs nothing. The filter region alone does not cut
//      the source (measured in Chromium: the bars were blurred in);
//   2. blurs it (`feGaussianBlur`, on premultiplied pixels, so colour and
//      alpha blur alike);
//   3. sets alpha to 1 with `feColorMatrix`, which works on unpremultiplied
//      colour: that divides the blurred colour by the blurred alpha, the
//      renormalisation;
//   4. takes the cut source's alpha back (`feComposite in`).
//
// `edgeMode="duplicate"` on feGaussianBlur would repeat the edge pixel instead;
// Chromium ignores it. Measured against the export's graph in Chromium: within
// 10 codes, mean under 2, edge rows equal, on a transparent letterbox and on
// black bars (render/test/item-blur-preview-parity.test.mjs).
//
// THE SIGMA. `blur` is a standard deviation in design-canvas pixels (1080 on
// the short edge, timeline-core `blurOf`). On screen that is
// `blur * renderScale`. The filter runs in the media box's own CSS pixels, and
// a uniform clip's media box sits under the wrapper's `scale(s)`
// (`mediaBoxStyle`), so its sigma is divided by `s` to land on screen at the
// same size (measured: identical pixels). A per-axis clip's media box is
// counter-scaled to a net scale of 1 and takes the screen sigma as is.
//
// THE COLOURS. `color-interpolation-filters="sRGB"`: an SVG filter blurs in
// linear light by default, and the export blurs the encoded values.
//
// The filter goes on the media box, the element that also carries the mask:
// CSS applies an element's filter before its mask, and the export blurs before
// it masks too.

import { useId, type CSSProperties, type ReactNode } from 'react'
import { blurOf, blurTypeOf, pictureRectInBox } from '@bycrux/timeline-core'
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

/** The SVG filter for a blur: its sigma in the media box's own pixels, the
 *  picture's rect as fractions of the box, and the box in its own pixels. */
export interface BlurFilterSpec {
  sigma: number
  rect: { x: number; y: number; w: number; h: number }
  box: Size
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
 * Whether the preview draws the clip's blur at all.
 *
 * SPIN AND ZOOM PLUG IN HERE. They are not drawn yet: until they are, a spin
 * or zoom clip shows sharp (a uniform blur of sigma 0), as the export draws it
 * (render item-blur.js). Pinned by itemBlur.test.tsx "spin and zoom are not
 * drawn yet".
 */
export function drawsBlur(item: VisualItem): boolean {
  const type = blurTypeOf(item)
  if (type === 'spin' || type === 'zoom') return false
  return blurOf(item) > 0
}

/**
 * The blur's SVG filter, or null when the clip has none. Pure: the hook
 * {@link useItemBlur} renders it.
 */
export function blurFilterSpec(input: Omit<ItemBlurInput, 'src' | 'knownSize'>, picture: Size | null): BlurFilterSpec | null {
  const b = blurOf(input.item)
  if (!drawsBlur(input.item) || !drawable(input.renderScale)) return null
  const { scaleX: sx, scaleY: sy } = input
  // mediaBoxStyle: a uniform box (or one it cannot draw per axis) is the full
  // frame under the wrapper's scale(s); a per-axis one has a net scale of 1.
  const uniform = sx === sy || !drawable(sx) || !drawable(sy)
  const local = uniform && drawable(sx) ? sx : 1
  const sigma = (b * input.renderScale) / local
  const rect = pictureRectInBox(input.canvasW * sx, input.canvasH * sy, picture?.w, picture?.h)
  // The media box in its own pixels: the frame under a uniform scale, the
  // clip's box (frame times the scale) on a per-axis one.
  const frameW = input.canvasW * input.renderScale
  const frameH = input.canvasH * input.renderScale
  const box = uniform ? { w: frameW, h: frameH } : { w: frameW * sx, h: frameH * sy }
  return { sigma, rect, box }
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000)

/**
 * The clip's blur as a style for its media box (`filter: url(#…)`) and the
 * SVG that defines the filter, to render inside that box. `{}` and null for a
 * clip with no blur. Always call it (it holds hooks); pass null for no clip.
 */
export function useItemBlur(input: ItemBlurInput | null): { style: CSSProperties; defs: ReactNode } {
  const id = 'montaj-blur-' + useId().replace(/[^A-Za-z0-9_-]/g, '')
  const wants = !!input && drawsBlur(input.item)
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
  const { sigma, rect, box } = spec
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
          <feFlood floodColor="#fff" x={fmt(rect.x * box.w)} y={fmt(rect.y * box.h)}
            width={fmt(rect.w * box.w)} height={fmt(rect.h * box.h)} result="picture-rect" />
          <feComposite in="SourceGraphic" in2="picture-rect" operator="in" result="picture" />
          <feGaussianBlur in="picture" stdDeviation={fmt(sigma)} result="blurred" />
          <feColorMatrix in="blurred" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="renormalised" />
          <feComposite in="renormalised" in2="picture" operator="in" />
        </filter>
      </svg>
    ),
  }
}
