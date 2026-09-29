/**
 * Where an item's media lands on the canvas, worked out two ways so tests can
 * hold the preview to the export.
 *
 *   previewPlacement — reads what the preview ACTUALLY rendered: walks the DOM
 *     from the frame down to the <img>/<video>/<canvas>, applying each
 *     element's box (left/top/width/height, `inset-0`/`w-full`/`h-full`) and
 *     CSS transform (translate %, scale, about the element's centre), then the
 *     media's object-fit. jsdom does no layout, so this is the layout.
 *   exportPlacement — what encode-segment.js's filter chain does: the box is
 *     `toPixelBox(geometryFor(item))` (the very call the export makes), then an
 *     image is fit to it by `scale=…:force_original_aspect_ratio=increase,crop`
 *     (cover) / `decrease,pad` (contain) / plain `scale` (fill), and a video is
 *     `crop=`ped (even-rounded dims) and then decrease-fit and padded.
 *
 * Both return the rect the FULL source lands on (for a crop or a cover, larger
 * than what shows) and the rect it is clipped to, in canvas pixels. A letterbox
 * is transparent on both sides (the export's `pad` since the transparent-pad
 * fix, the preview's element background), so it does not narrow the clip.
 */
import { geometryFor, toPixelBox } from '@bycrux/timeline-core'
import type { VisualItem } from '../../../schema'

export interface Rect { x: number; y: number; w: number; h: number }
export interface Placement { content: Rect; clip: Rect }
export type Fit = 'cover' | 'contain' | 'fill'

/** x' = ax·x + bx, y' = ay·y + by. Rotation is refused, so this is all a transform can be here. */
interface Affine { ax: number; bx: number; ay: number; by: number }
const IDENTITY: Affine = { ax: 1, bx: 0, ay: 1, by: 0 }
/** `outer ∘ inner`: apply inner, then outer. */
const compose = (outer: Affine, inner: Affine): Affine => ({
  ax: outer.ax * inner.ax, bx: outer.ax * inner.bx + outer.bx,
  ay: outer.ay * inner.ay, by: outer.ay * inner.by + outer.by,
})
const mapRect = (a: Affine, r: Rect): Rect => ({ x: a.ax * r.x + a.bx, y: a.ay * r.y + a.by, w: a.ax * r.w, h: a.ay * r.h })
const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y }
}

/** A length as the preview would lay it out: `N%` of the parent, `Npx`, or bare `0`. */
function length(v: string, parentDim: number): number | null {
  if (!v) return null
  if (v.endsWith('%')) return (parseFloat(v) / 100) * parentDim
  if (v.endsWith('px') || /^-?\d*\.?\d+$/.test(v)) return parseFloat(v)
  throw new Error(`placementModel: unsupported length "${v}"`)
}

/** The element's layout box in its parent's coordinates. */
function layoutBox(el: HTMLElement, pw: number, ph: number): Rect {
  const cls = el.classList
  const inset = cls.contains('inset-0')
  const x = length(el.style.left, pw) ?? 0
  const y = length(el.style.top, ph) ?? 0
  const w = length(el.style.width, pw) ?? (cls.contains('w-full') || inset ? pw : null)
  const h = length(el.style.height, ph) ?? (cls.contains('h-full') || inset ? ph : null)
  if (w == null || h == null) throw new Error(`placementModel: <${el.tagName.toLowerCase()} class="${el.className}"> has no size`)
  return { x, y, w, h }
}

/** The element's own `transform`, as a map from its layout box into its parent's coordinates. */
function transformOf(el: HTMLElement, box: Rect): Affine {
  const origin = el.style.transformOrigin
  if (origin && origin !== 'center center' && origin !== '50% 50%') {
    throw new Error(`placementModel: unsupported transform-origin "${origin}"`)
  }
  let m = IDENTITY
  const fns = el.style.transform.match(/[a-zA-Z]+\([^)]*\)/g) ?? []
  for (const fn of fns) {
    const name = fn.slice(0, fn.indexOf('('))
    const args = fn.slice(name.length + 1, -1).split(',').map((s) => s.trim())
    let f: Affine
    if (name === 'translate') {
      f = { ax: 1, bx: length(args[0], box.w) ?? 0, ay: 1, by: length(args[1] ?? '0', box.h) ?? 0 }
    } else if (name === 'scale') {
      const sx = parseFloat(args[0])
      const sy = args[1] != null ? parseFloat(args[1]) : sx
      f = { ax: sx, bx: 0, ay: sy, by: 0 }
    } else if (name === 'rotate') {
      if (parseFloat(args[0]) % 360 !== 0) throw new Error(`placementModel: rotation is not modelled (${fn})`)
      continue
    } else {
      throw new Error(`placementModel: unsupported transform "${fn}"`)
    }
    m = compose(m, f)
  }
  // Layout box → parent: move to the box, then apply `m` about the box's centre.
  const ox = box.w / 2
  const oy = box.h / 2
  return { ax: m.ax, bx: box.x + ox + m.bx - m.ax * ox, ay: m.ay, by: box.y + oy + m.by - m.ay * oy }
}

/** The fitted content inside a `w`×`h` box, in that box's coordinates. */
export function fitInto(mediaW: number, mediaH: number, w: number, h: number, fit: Fit): Rect {
  if (fit === 'fill') return { x: 0, y: 0, w, h }
  const f = fit === 'cover' ? Math.max(w / mediaW, h / mediaH) : Math.min(w / mediaW, h / mediaH)
  return { x: (w - mediaW * f) / 2, y: (h - mediaH * f) / 2, w: mediaW * f, h: mediaH * f }
}

function objectFitOf(el: HTMLElement): Fit {
  const f = el.style.objectFit
  if (f === 'cover' || f === 'contain' || f === 'fill') return f
  if (!f && el.classList.contains('object-contain')) return 'contain'
  if (!f) return 'fill' // CSS's own default
  throw new Error(`placementModel: unsupported object-fit "${f}"`)
}

/**
 * Where the preview draws `media`, which must sit inside `frame`. The frame is
 * taken to be `frameW`×`frameH` and clips (the player root is overflow-hidden).
 * `mediaW`/`mediaH` are the source's intrinsic size — the element's for an
 * <img>/<video>, the decoded frame's for a <canvas>, which also needs its
 * backing-store size and the `drawImage` plan the engine painted with.
 */
export function previewPlacement(
  media: HTMLElement,
  frame: HTMLElement,
  frameW: number,
  frameH: number,
  source: {
    mediaW: number
    mediaH: number
    canvas?: { backingW: number; backingH: number; plan: { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } }
  },
): Placement {
  const chain: HTMLElement[] = []
  for (let el: HTMLElement | null = media; el !== frame; el = el.parentElement) {
    if (!el) throw new Error('placementModel: media is not inside frame')
    chain.unshift(el)
  }
  let toFrame = IDENTITY
  let clip: Rect = { x: 0, y: 0, w: frameW, h: frameH }
  let parent = { w: frameW, h: frameH }
  let box: Rect = { x: 0, y: 0, w: frameW, h: frameH }
  for (const el of chain) {
    box = layoutBox(el, parent.w, parent.h)
    toFrame = compose(toFrame, transformOf(el, box))
    // From here on, coordinates are this element's own (its box at the origin).
    const own: Rect = { x: 0, y: 0, w: box.w, h: box.h }
    if (el.style.overflow === 'hidden' || el === media) clip = intersect(clip, mapRect(toFrame, own))
    parent = { w: box.w, h: box.h }
  }
  let content: Rect
  if (media.tagName === 'CANVAS') {
    if (!source.canvas) throw new Error('placementModel: a <canvas> needs its backing store and draw plan')
    const { backingW, backingH, plan: p } = source.canvas
    // The plan draws source rect (sx,sy,sw,sh) at (dx,dy,dw,dh); extend that to
    // the whole decoded frame, then stretch the backing store over the box.
    const px = p.dw / p.sw
    const py = p.dh / p.sh
    const kx = box.w / backingW
    const ky = box.h / backingH
    content = {
      x: (p.dx - p.sx * px) * kx, y: (p.dy - p.sy * py) * ky,
      w: source.mediaW * px * kx, h: source.mediaH * py * ky,
    }
  } else {
    content = fitInto(source.mediaW, source.mediaH, box.w, box.h, objectFitOf(media))
  }
  return { content: mapRect(toFrame, content), clip }
}

/**
 * Where the export draws the item. `mediaW`/`mediaH` are the source's display
 * size (the probe's, or the item's `sourceWidth`/`sourceHeight`).
 */
export function exportPlacement(item: VisualItem, vw: number, vh: number, mediaW: number, mediaH: number): Placement {
  const kind = item.type === 'image' ? 'image' : 'video'
  const b = toPixelBox(geometryFor(item, kind), vw, vh)
  const box: Rect = { x: b.x, y: b.y, w: b.width, h: b.height }
  const canvas: Rect = { x: 0, y: 0, w: vw, h: vh }
  if (kind === 'image') {
    const f = fitInto(mediaW, mediaH, box.w, box.h, item.fit ?? 'cover')
    return { content: { ...f, x: box.x + f.x, y: box.y + f.y }, clip: intersect(canvas, box) }
  }
  // Video: the crop runs only when the item records its source dims, exactly
  // as encode-segment.js gates it; crop dims are even-rounded, the origin not.
  const sc = item.sourceCrop
  const cropped = !!(sc && item.sourceWidth && item.sourceHeight)
  const cw = cropped ? Math.round((mediaW * sc!.w) / 2) * 2 : mediaW
  const ch = cropped ? Math.round((mediaH * sc!.h) / 2) * 2 : mediaH
  const cx = cropped ? Math.round(mediaW * sc!.x) : 0
  const cy = cropped ? Math.round(mediaH * sc!.y) : 0
  // decrease-fit, then `pad=…:(ow-iw)/2:(oh-ih)/2` centres it in the box. The
  // pad is transparent, as the preview's letterbox is, so the clip is the box.
  const fitted = fitInto(cw, ch, box.w, box.h, 'contain')
  const k = fitted.w / cw
  return {
    content: { x: box.x + fitted.x - cx * k, y: box.y + fitted.y - cy * k, w: mediaW * k, h: mediaH * k },
    clip: intersect(canvas, box),
  }
}

/** Per-field closeness, so a failure names the rect and field that drifted. */
export function expectPlacementClose(actual: Placement, expected: Placement, tolPx: number) {
  const round = (r: Rect) => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2) })
  const ok = (['content', 'clip'] as const).every((k) =>
    (['x', 'y', 'w', 'h'] as const).every((f) => Math.abs(actual[k][f] - expected[k][f]) <= tolPx))
  if (!ok) {
    throw new Error(
      `preview placement differs from export by more than ${tolPx}px\n` +
      `  preview: content ${JSON.stringify(round(actual.content))} clip ${JSON.stringify(round(actual.clip))}\n` +
      `  export:  content ${JSON.stringify(round(expected.content))} clip ${JSON.stringify(round(expected.clip))}`,
    )
  }
}
