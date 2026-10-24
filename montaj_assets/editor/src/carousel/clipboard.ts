import type { CarouselElement, Slide } from '../types'

/** Pixels a copy steps down and right: Duplicate, and each paste onto the slide
 *  the elements were copied from. */
export const COPY_OFFSET = 20

/** `el` as a new, independent element: a deep copy (no crop, overlay props or
 *  fonts shared with it) under a fresh id. */
export function cloneElement(el: CarouselElement): CarouselElement {
  return { ...structuredClone(el), id: crypto.randomUUID() }
}

/** `el` `by` px further down and right. */
function stepped(el: CarouselElement, by: number): CarouselElement {
  return { ...el, x: el.x + by, y: el.y + by }
}

/** What Copy and Cut hold, until the next copy. */
export interface ElementClipboard {
  /** The slide the elements were copied from. */
  slideId: string
  /** Independent copies, in slide order, as they were when copied. */
  elements: CarouselElement[]
  /** Pastes so far onto each slide, to place the next one. */
  pastes: Map<string, number>
}

/** The selected elements of `slide`, in slide order, as a fresh clipboard (no
 *  pastes counted). Null when none of them is on the slide. */
export function copyElements(slide: Slide, selectedIds: Iterable<string>): ElementClipboard | null {
  const selected = new Set(selectedIds)
  const elements = slide.elements.filter((el) => selected.has(el.id)).map((el) => structuredClone(el))
  return elements.length > 0 ? { slideId: slide.id, elements, pastes: new Map() } : null
}

/**
 * New elements for pasting the clipboard onto `slideId`, and counts the paste.
 * On the slide they came from each paste steps 20 px further down and right
 * (+20, +40, ...), so it never lands on the originals. On any other slide the
 * first paste keeps the copied position, and each further paste onto that slide
 * steps 20 px from the last. Every paste has fresh ids and shares nothing.
 */
export function pasteElements(clipboard: ElementClipboard, slideId: string): CarouselElement[] {
  const pasted = clipboard.pastes.get(slideId) ?? 0
  clipboard.pastes.set(slideId, pasted + 1)
  const steps = slideId === clipboard.slideId ? pasted + 1 : pasted
  return clipboard.elements.map((el) => stepped(cloneElement(el), steps * COPY_OFFSET))
}

/**
 * `elements` with a copy of each selected element directly above it (in front
 * of it, next in the array), 20 px down and right, and the ids of those copies.
 * With nothing selected on the list, the same array and no ids.
 */
export function duplicateElements(
  elements: CarouselElement[],
  selectedIds: Iterable<string>,
): { elements: CarouselElement[]; copyIds: string[] } {
  const selected = new Set(selectedIds)
  if (!elements.some((el) => selected.has(el.id))) return { elements, copyIds: [] }
  const out: CarouselElement[] = []
  const copyIds: string[] = []
  for (const el of elements) {
    out.push(el)
    if (!selected.has(el.id)) continue
    const copy = stepped(cloneElement(el), COPY_OFFSET)
    out.push(copy)
    copyIds.push(copy.id)
  }
  return { elements: out, copyIds }
}
