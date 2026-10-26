import type { CarouselElement } from '../types'

/** Whether `el` is locked (§586 M5): selectable and styleable, not placeable. */
export const isLocked = (el: CarouselElement | undefined): boolean => el?.locked === true

/**
 * `elements` with the ones in `ids` locked, or unlocked when any of them is
 * already locked. An unlocked element has no `locked` field at all. The same
 * array comes back when none of `ids` is on the list.
 */
export function toggleLock(elements: CarouselElement[], ids: Iterable<string>): CarouselElement[] {
  const picked = new Set(ids)
  const targets = elements.filter((el) => picked.has(el.id))
  if (targets.length === 0) return elements
  const unlock = targets.some(isLocked)
  return elements.map((el) => {
    if (!picked.has(el.id)) return el
    if (unlock) {
      const { locked: _locked, ...free } = el
      return free as CarouselElement
    }
    return { ...el, locked: true }
  })
}
