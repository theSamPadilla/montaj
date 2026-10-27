import type { CarouselElement } from '../types'
import type { ReorderDirection } from '../state/project-reducer'

/**
 * `elements` with the selected ones moved in the stacking order. Index 0 is the
 * back of the slide and the last index the front, as the canvas draws them.
 *
 * - `forward` / `backward`: each selected element passes the unselected one next
 *   to it, one step toward the front or the back. Selected neighbours move
 *   together, so a block of them keeps its shape; one that is already at the
 *   end does not hold the others back.
 * - `front` / `back`: the whole selection goes to the end or the start.
 *
 * The selected elements always keep their own order among themselves, whatever
 * order `selectedIds` is in. When nothing would move the very same array comes
 * back, so a caller can tell there is nothing to write. Never mutates `elements`.
 */
export function reorderSelection(
  elements: CarouselElement[],
  selectedIds: Iterable<string>,
  direction: ReorderDirection,
): CarouselElement[] {
  const selected = new Set(selectedIds)
  const isSelected = (el: CarouselElement) => selected.has(el.id)
  if (!elements.some(isSelected)) return elements

  let next: CarouselElement[]
  if (direction === 'front' || direction === 'back') {
    const picked = elements.filter(isSelected)
    const others = elements.filter((el) => !isSelected(el))
    next = direction === 'front' ? [...others, ...picked] : [...picked, ...others]
  } else {
    next = [...elements]
    if (direction === 'forward') {
      // From the front down, so an element moves once and a block moves as one.
      for (let i = next.length - 2; i >= 0; i--) {
        if (isSelected(next[i]) && !isSelected(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]]
      }
    } else {
      for (let i = 1; i < next.length; i++) {
        if (isSelected(next[i]) && !isSelected(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]]
      }
    }
  }
  return next.every((el, i) => el === elements[i]) ? elements : next
}

/**
 * `elements` with `ids` moved to sit just above or just below `targetId` as the
 * Layers panel lists them (front first), keeping their own order among
 * themselves. A target among `ids`, an unknown target or nothing to move, or an
 * order that would not change, gives the very same array back. Never mutates
 * `elements`.
 */
export function moveToLayer(
  elements: CarouselElement[],
  ids: Iterable<string>,
  targetId: string,
  where: 'above' | 'below',
): CarouselElement[] {
  const moving = new Set(ids)
  if (moving.has(targetId)) return elements
  const front = [...elements].reverse()
  const picked = front.filter((el) => moving.has(el.id))
  const rest = front.filter((el) => !moving.has(el.id))
  const at = rest.findIndex((el) => el.id === targetId)
  if (at < 0 || picked.length === 0) return elements
  rest.splice(where === 'above' ? at : at + 1, 0, ...picked)
  const next = rest.reverse()
  return next.every((el, i) => el === elements[i]) ? elements : next
}
