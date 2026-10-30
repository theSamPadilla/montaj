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
//
// LINEAR (`blurType: 'linear'`, `blurAngle`): a Gaussian along one direction.
// An SVG filter blurs along its own x only (`stdDeviation="s 0"`), so it runs
// in a frame turned by the angle. The media box's children sit in two
// wrappers, always rendered so a blur turning on or changing type never
// remounts the media (a base clip's <video> carries its audio routing):
//
//   media box     clip-path: the picture's rect (axis-aligned, so the
//                 picture's edges stay hard), and the mask, as ever
//     turn        rotate(+angle), filter: blur along its x (the direction),
//                 renormalise (feColorMatrix), the cut source's alpha grown
//                 by a screen pixel (feMorphology) put back, so the turn's
//                 antialiased edge does not fade the picture's edge rows
//       back      rotate(-angle), filter: the source cut to the picture's
//                 rect (as step 1), in the media's own frame: cut there,
//                 not in the turned one, so black bars around the picture
//                 never bleed into its turned edge
//         media
//
// Every filter runs in its element's own frame, before its transform, and
// before the media box's mask. Without a linear blur the wrappers are
// `display: contents`: no box, nothing drawn differently. Measured against
// the export in Chromium at 0, 30, 90 and 135 degrees: within 13 codes, mean
// under 1.6, edge rows within 3 (render/test/item-blur-preview-parity.test.mjs).
//
// SPIN AND ZOOM (`blurType: 'spin' | 'zoom'`) draw on a canvas, not with SVG:
// a RadialBlurSurface (the shared WebGL2 pass, radialBlurGL.ts) after the two
// wrappers, filling the media box, so the box's mask and the wrapper's blend
// apply to it ({@link BlurWrappers}). It reads the media inside the wrappers
// (the overlay <video>, the <img>, the base clip's active <video> slot, the
// engine's canvas, redrawn on each engine paint), which stays mounted at
// opacity 0 once the surface draws; on failure the media shows sharp. The
// picture's rect and the part of the source that fills it come from
// {@link radialBlurSpec}. Measured against the export in Chromium: worst 8
// codes, mean under 1 (editor/browser/radial-blur.test.mjs).

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { blurAngleOf, blurCenterOf, blurOf, blurTypeOf, pictureRectInBox } from '@bycrux/timeline-core'
import RadialBlurSurface, { type RadialBlurSurfaceHandle } from './RadialBlurSurface'
import type { FracRect, RadialBlurSource } from './radialBlurGL'
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
  /** The source is the engine's canvas, which spans the box (the picture inside it, black bars around):
   *  a spin or zoom blur reads the picture's rect of it. */
  engineCanvas?: boolean
  /** Playback is running (a spin or zoom blur may drop to half resolution on long frames). */
  playing?: boolean
}

/** The SVG filter for a blur: its sigma in the media box's own pixels, the
 *  picture's rect as fractions of the box, and the box in its own pixels. */
export interface BlurFilterSpec {
  sigma: number
  rect: { x: number; y: number; w: number; h: number }
  box: Size
  /** The media box's own pixels per screen pixel (1 over the wrapper's uniform scale; 1 per axis). */
  perScreenPx: number
  /** A linear blur's direction in degrees (timeline-core blurAngleOf); null for a uniform blur. */
  angle: number | null
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

const isRadial = (item: VisualItem) => {
  const type = blurTypeOf(item)
  return type === 'spin' || type === 'zoom'
}

/** Whether the preview draws the clip's blur at all: an SVG filter (uniform, linear) or the WebGL surface (spin, zoom). */
export function drawsBlur(item: VisualItem): boolean {
  return blurOf(item) > 0
}

/**
 * The blur's SVG filter, or null when the clip has none or its blur is a
 * spin or zoom (those draw on a canvas: {@link radialBlurSpec}). Pure: the
 * hook {@link useItemBlur} renders it.
 */
export function blurFilterSpec(input: Omit<ItemBlurInput, 'src' | 'knownSize'>, picture: Size | null): BlurFilterSpec | null {
  const b = blurOf(input.item)
  if (!drawsBlur(input.item) || isRadial(input.item) || !drawable(input.renderScale)) return null
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
  const angle = blurTypeOf(input.item) === 'linear' ? blurAngleOf(input.item) : null
  return { sigma, rect, box, perScreenPx: 1 / local, angle }
}

/** What a spin or zoom blur's surface needs (RadialBlurSurface's props). */
export interface RadialBlurSpec {
  type: 'spin' | 'zoom'
  amount: number
  center: { x: number; y: number }
  /** The picture's rect in the media box, fractions. */
  pictureRect: FracRect
  /** The part of the source element that fills the picture, fractions of it; the whole source when absent. */
  sourceRect?: FracRect
  /** The media box's own on-screen scale (the wrapper's uniform scale; 1 for a per-axis box). */
  scale: number
}

/**
 * A spin or zoom blur's surface (see {@link BlurWrappers}), or null for any
 * other blur, or while the picture's size is not known yet (the clip then
 * shows sharp until it is). Pure.
 *
 * `natural` is the source's own size before its crop (a video's footage, an
 * image's pixels). The picture: a video, and a `contain` image, contain-fitted
 * in the box; a `cover` or `fill` image is the whole box. The source rect: the
 * crop (a video's only with its stored size, as the export), narrowed for a
 * `cover` image to the part of it the box shows; on the engine canvas, which
 * spans the box and draws the crop itself, the picture's rect.
 */
export function radialBlurSpec(input: Omit<ItemBlurInput, 'src' | 'knownSize'>, natural: Size | null): RadialBlurSpec | null {
  const { item, crop, fit, scaleX: sx, scaleY: sy } = input
  if (!isRadial(item) || !(blurOf(item) > 0)) return null
  const type = blurTypeOf(item) as 'spin' | 'zoom'
  const uniform = sx === sy || !drawable(sx) || !drawable(sy)
  const scale = uniform && drawable(sx) ? sx : 1
  const boxW = input.canvasW * (drawable(sx) ? sx : 1)
  const boxH = input.canvasH * (drawable(sy) ? sy : 1)
  const base = { type, amount: blurOf(item), center: blurCenterOf(item), scale }
  const whole: FracRect = { x: 0, y: 0, w: 1, h: 1 }
  const cropRect = crop && drawable(crop.w) && drawable(crop.h) ? crop : null
  if (item.type === 'image' && fit !== 'contain') {
    if (fit === 'fill') return { ...base, pictureRect: whole, sourceRect: cropRect ?? undefined }
    // cover: the centred part of the (cropped) image at the box's aspect.
    if (!known(natural)) return null
    const c = cropRect ?? whole
    const a = (natural.w * c.w) / (natural.h * c.h)
    const boxA = boxW / boxH
    const sourceRect = a > boxA
      ? { x: c.x + (c.w * (1 - boxA / a)) / 2, y: c.y, w: (c.w * boxA) / a, h: c.h }
      : { x: c.x, y: c.y + (c.h * (1 - a / boxA)) / 2, w: c.w, h: (c.h * a) / boxA }
    return { ...base, pictureRect: whole, sourceRect }
  }
  const picture = pictureSizeFor(item, crop, fit, natural)
  if (!picture) return null
  const pictureRect = pictureRectInBox(boxW, boxH, picture.w, picture.h)
  if (input.engineCanvas) return { ...base, pictureRect, sourceRect: pictureRect }
  const stored = item.type === 'video' && drawable(item.sourceWidth ?? 0) && drawable(item.sourceHeight ?? 0)
  const cropApplies = cropRect && (item.type === 'image' || stored)
  return { ...base, pictureRect, sourceRect: cropApplies ? cropRect : undefined }
}

/**
 * A linear blur's filter region on the turned wrapper, as fractions of its
 * box (the media box, `box` pixels): the picture's rect as that wrapper sees
 * it, turned by -`deg` about the box's centre, its bounds plus 2 pixels.
 */
export function linearBlurRegion(rect: BlurFilterSpec['rect'], box: Size, deg: number): BlurFilterSpec['rect'] {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const xs: number[] = []
  const ys: number[] = []
  for (const [fx, fy] of [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]]) {
    const x = (fx - 0.5) * box.w
    const y = (fy - 0.5) * box.h
    xs.push(x * c + y * s + box.w / 2)
    ys.push(-x * s + y * c + box.h / 2)
  }
  const x0 = Math.min(...xs) - 2
  const y0 = Math.min(...ys) - 2
  return { x: x0 / box.w, y: y0 / box.h, w: (Math.max(...xs) + 2 - x0) / box.w, h: (Math.max(...ys) + 2 - y0) / box.h }
}

/** The wrappers' style when there is no linear blur: no box of their own. */
const INERT: CSSProperties = { display: 'contents' }

/** What {@link useItemBlur} hands its layer: the media box's style, the two
 *  wrappers' (see the header; inert without a linear blur), the SVG, and a
 *  spin or zoom blur's surface (null for any other). */
export interface ItemBlurParts {
  style: CSSProperties
  turnStyle: CSSProperties
  backStyle: CSSProperties
  defs: ReactNode
  radial: (RadialBlurSpec & { playing: boolean }) | null
}

const NONE: ItemBlurParts = { style: {}, turnStyle: INERT, backStyle: INERT, defs: null, radial: null }

/** The back wrapper while a spin or zoom surface draws: the media stays mounted and decoding, unseen. */
const HIDDEN: CSSProperties = { position: 'absolute', inset: 0, opacity: 0 }

/**
 * The element a spin or zoom blur reads: the one marked
 * `data-montaj-blur-source` (the base clip's active `<video>` slot), else the
 * only `<video>`, else the `<img>`, else the engine's canvas.
 */
export function blurSourceIn(root: Element | null): RadialBlurSource | null {
  if (!root) return null
  const marked = root.querySelector('[data-montaj-blur-source]')
  if (marked) return marked as RadialBlurSource
  const videos = root.querySelectorAll('video')
  if (videos.length === 1) return videos[0]
  return (root.querySelector('img') ?? root.querySelector('canvas[data-montaj-engine-canvas]')) as RadialBlurSource | null
}

/**
 * The media box's children inside the two blur wrappers. Always render it,
 * blur or not, so the media never remounts.
 *
 * SPIN AND ZOOM. With `blur.radial`, a RadialBlurSurface (a canvas filling the
 * media box, after the wrappers, so the box's mask and the wrapper's blend
 * apply to it) draws the blur from the media inside: {@link blurSourceIn}.
 * Once it draws, the back wrapper turns to opacity 0, so the media stays
 * mounted, decoding and firing its frame callbacks (and a base clip's
 * `<video>` keeps its audio routing) while only the surface shows. On
 * failure ('unsupported', 'lost', 'blocked') the surface renders nothing and
 * the media shows sharp. `redraw` subscribes the surface to a source that
 * changes without events of its own (the engine canvas: `onPaint`).
 * `backing` paints under the surface what the hidden media painted around
 * the picture (the engine canvas's black bars).
 */
export function BlurWrappers({ blur, children, redraw, backing }: {
  blur: ItemBlurParts
  children: ReactNode
  redraw?: (listener: () => void) => () => void
  backing?: string
}) {
  const backRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<RadialBlurSurfaceHandle | null>(null)
  const [source, setSource] = useState<RadialBlurSource | null>(null)
  const [drawing, setDrawing] = useState(false)
  const radial = blur.radial
  const on = !!radial
  // The source can change under any render (the base clip's active slot, an
  // image's crop wrapper), so look again after each one.
  useLayoutEffect(() => {
    const next = on ? blurSourceIn(backRef.current) : null
    if (next !== source) setSource(next)
  })
  useEffect(() => { if (!on) setDrawing(false) }, [on])
  useEffect(() => {
    if (!on || !redraw) return
    return redraw(() => surfaceRef.current?.draw())
  }, [on, redraw])
  const onStatus = useCallback((ok: boolean) => setDrawing(ok), [])
  const hide = !!radial && drawing && !!source
  return (
    <>
      <div data-montaj-blur-turn="" style={blur.turnStyle}>
        <div ref={backRef} data-montaj-blur-back="" style={hide ? HIDDEN : blur.backStyle}>{children}</div>
      </div>
      {radial && source && (
        <>
          {backing && hide && <div data-montaj-blur-backing="" style={{ position: 'absolute', inset: 0, background: backing }} />}
          <RadialBlurSurface
            ref={surfaceRef}
            source={source}
            type={radial.type}
            amount={radial.amount}
            center={radial.center}
            pictureRect={radial.pictureRect}
            sourceRect={radial.sourceRect}
            playing={radial.playing}
            scale={radial.scale}
            onStatus={onStatus}
          />
        </>
      )}
    </>
  )
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000)

/**
 * A linear blur's parts (see the header): the media box cut to the picture,
 * the turned wrapper's blur, the turned-back wrapper's cut.
 */
function linearParts(id: string, spec: BlurFilterSpec): ItemBlurParts {
  const { sigma, rect, box, perScreenPx } = spec
  const angle = spec.angle ?? 0
  const pct = (n: number) => `${fmt(n * 100)}%`
  const region = linearBlurRegion(rect, box, angle)
  return {
    radial: null,
    style: { clipPath: `inset(${pct(rect.y)} ${pct(1 - rect.x - rect.w)} ${pct(1 - rect.y - rect.h)} ${pct(rect.x)})` },
    turnStyle: { position: 'absolute', inset: 0, transform: `rotate(${fmt(angle)}deg)`, filter: `url(#${id})` },
    backStyle: { position: 'absolute', inset: 0, transform: `rotate(${fmt(-angle)}deg)`, filter: `url(#${id}-cut)` },
    defs: (
      <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <filter id={`${id}-cut`} data-montaj-blur-cut="" filterUnits="objectBoundingBox"
          x={fmt(rect.x)} y={fmt(rect.y)} width={fmt(rect.w)} height={fmt(rect.h)} colorInterpolationFilters="sRGB">
          <feFlood floodColor="#fff" x={fmt(rect.x * box.w)} y={fmt(rect.y * box.h)}
            width={fmt(rect.w * box.w)} height={fmt(rect.h * box.h)} result="picture-rect" />
          <feComposite in="SourceGraphic" in2="picture-rect" operator="in" />
        </filter>
        <filter id={id} data-montaj-blur="" data-montaj-blur-angle={fmt(angle)} filterUnits="objectBoundingBox"
          x={fmt(region.x)} y={fmt(region.y)} width={fmt(region.w)} height={fmt(region.h)} colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation={`${fmt(sigma)} 0`} result="blurred" />
          <feColorMatrix in="blurred" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="renormalised" />
          <feMorphology in="SourceGraphic" operator="dilate" radius={fmt(perScreenPx)} result="picture" />
          <feComposite in="renormalised" in2="picture" operator="in" />
        </filter>
      </svg>
    ),
  }
}

/**
 * The clip's blur as a style for its media box (`filter: url(#…)`, or for a
 * linear blur the cut to the picture), the two wrappers' styles
 * ({@link BlurWrappers}) and the SVG that defines the filters, to render
 * inside that box. Inert for a clip with no blur. Always call it (it holds
 * hooks); pass null for no clip.
 */
export function useItemBlur(input: ItemBlurInput | null): ItemBlurParts {
  const id = 'montaj-blur-' + useId().replace(/[^A-Za-z0-9_-]/g, '')
  const wants = !!input && drawsBlur(input.item)
  const item = input?.item
  const needsVideo = wants && item?.type === 'video'
    && !(drawable(item.sourceWidth ?? 0) && drawable(item.sourceHeight ?? 0))
  // A spin or zoom over a cover image needs its size too (the part the box shows).
  const needsImage = wants && item?.type === 'image' && (input?.fit === 'contain' || (isRadial(item) && input?.fit !== 'fill'))
  const videoSize = useVideoNaturalSize(needsVideo ? input?.src : undefined)
  const imageSize = useImageNaturalSize(needsImage ? input?.src : undefined)
  if (!input || !wants) return NONE
  const natural = item?.type === 'image' ? imageSize : (known(videoSize) ? videoSize : input.knownSize)
  if (isRadial(input.item)) {
    const radial = radialBlurSpec(input, natural ?? null)
    return radial ? { ...NONE, radial: { ...radial, playing: !!input.playing } } : NONE
  }
  const spec = blurFilterSpec(input, pictureSizeFor(input.item, input.crop, input.fit, natural))
  if (!spec) return NONE
  const { sigma, rect, box } = spec
  if (spec.angle !== null) return linearParts(id, spec)
  return {
    radial: null,
    turnStyle: INERT,
    backStyle: INERT,
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
