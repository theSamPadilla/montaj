import type { CarouselElement } from '../types'
import { isLocked } from './lock'

/**
 * `elements` with image `elementId` made the slide's background: it covers the
 * slide (x 0, y 0, the slide's size, no rotation), shows a crop at the slide's
 * aspect centred on the part it showed, goes to the back and is locked. The
 * source's shape is read off the box and crop (they share an aspect), so no
 * file load is needed. The same array comes back when the element is missing,
 * not an image, or locked.
 */
export function setImageAsBackground(elements: CarouselElement[], elementId: string, slideW: number, slideH: number): CarouselElement[] {
  const el = elements.find((e) => e.id === elementId)
  if (!el || el.type !== 'image' || isLocked(el) || !(el.w > 0) || !(el.h > 0) || !(slideW > 0) || !(slideH > 0)) return elements
  const cur = el.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  // Source aspect from: box aspect = (cur.w * W) / (cur.h * H).
  const srcAspect = (el.w / el.h) * (cur.h / cur.w)
  const slideAspect = slideW / slideH
  // The largest window of the slide's shape that fits the source, in 0..1 fractions.
  const w = srcAspect > slideAspect ? slideAspect / srcAspect : 1
  const h = srcAspect > slideAspect ? 1 : srcAspect / slideAspect
  const clamp = (v: number, size: number) => Math.min(Math.max(v, 0), 1 - size)
  const crop = { x: clamp(cur.x + cur.w / 2 - w / 2, w), y: clamp(cur.y + cur.h / 2 - h / 2, h), w, h }
  const full = w > 0.995 && h > 0.995
  const { crop: _old, ...rest } = el
  const covered = { ...rest, x: 0, y: 0, w: slideW, h: slideH, rotation: 0, ...(full ? {} : { crop }), locked: true as const }
  return [covered, ...elements.filter((e) => e.id !== elementId)]
}
