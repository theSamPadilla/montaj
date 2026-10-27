import type { CarouselElement } from '../types'
import { isLocked } from './lock'

import { shownCrop } from '../crop/crop-math'

/**
 * `elements` with image `elementId` made the slide's background: it covers the
 * slide (x 0, y 0, the slide's size, no rotation), shows the largest window of
 * the slide's shape that fits the source, centred on the part it showed (as
 * drawn today, `shownCrop`), goes to the back and is locked. `src` is the
 * source's real size: an uncropped image is drawn contain and a side resize
 * changes a crop's shape, so the box says nothing about it. The same array
 * comes back when the element is missing, not an image, or locked.
 *
 * It replaces the slide's current background: the back-most element, when it
 * is a locked, unrotated image covering the whole slide, goes (Sam, 2026-10-26:
 * a second pick swaps, it does not stack hidden covers). One write, so one undo
 * brings the previous background back.
 */
export function setImageAsBackground(
  elements: CarouselElement[],
  elementId: string,
  slideW: number,
  slideH: number,
  src: { width: number; height: number },
): CarouselElement[] {
  const el = elements.find((e) => e.id === elementId)
  if (!el || el.type !== 'image' || isLocked(el) || !(el.w > 0) || !(el.h > 0) || !(slideW > 0) || !(slideH > 0) || !(src.width > 0) || !(src.height > 0)) return elements
  const cur = shownCrop({ w: el.w, h: el.h }, el.crop, src)
  const srcAspect = src.width / src.height
  const slideAspect = slideW / slideH
  const w = srcAspect > slideAspect ? slideAspect / srcAspect : 1
  const h = srcAspect > slideAspect ? 1 : srcAspect / slideAspect
  const clamp = (v: number, size: number) => Math.min(Math.max(v, 0), 1 - size)
  const crop = { x: clamp(cur.x + cur.w / 2 - w / 2, w), y: clamp(cur.y + cur.h / 2 - h / 2, h), w, h }
  const full = w > 0.995 && h > 0.995
  const { crop: _old, ...rest } = el
  const covered = { ...rest, x: 0, y: 0, w: slideW, h: slideH, rotation: 0, ...(full ? {} : { crop }), locked: true as const }
  const back = elements[0]
  const replaces = back && back.id !== elementId && isBackground(back, slideW, slideH)
  return [covered, ...elements.filter((e) => e.id !== elementId && !(replaces && e.id === back.id))]
}

/** A slide background as `setImageAsBackground` leaves one: a locked, unrotated image covering the whole slide. */
export function isBackground(el: CarouselElement, slideW: number, slideH: number): boolean {
  return el.type === 'image' && isLocked(el) && !el.rotation && el.x <= 0 && el.y <= 0 && el.x + el.w >= slideW && el.y + el.h >= slideH
}
