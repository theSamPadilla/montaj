import type { CarouselElement, Slide } from '../types'

/** Pixels a copy steps down and right: Duplicate, and each paste past the one
 *  before it on the same slide. */
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
  /** Independent copies, in slide order, as they were when copied. They keep the
   *  originals' ids, so a paste can see whether the originals are still on a slide. */
  elements: CarouselElement[]
  /** Where the last paste onto each slide landed, in COPY_OFFSET steps. A slide
   *  with no entry has had no paste yet. */
  lastSteps: Map<string, number>
}

/** The selected elements of `slide`, in slide order, as a fresh clipboard (no
 *  pastes counted). Null when none of them is on the slide. */
export function copyElements(slide: Slide, selectedIds: Iterable<string>): ElementClipboard | null {
  const selected = new Set(selectedIds)
  const elements = slide.elements.filter((el) => selected.has(el.id)).map((el) => structuredClone(el))
  return elements.length > 0 ? { slideId: slide.id, elements, lastSteps: new Map() } : null
}

/**
 * New elements for pasting the clipboard onto `slide`, and records where they
 * land. Pastes onto a slide step 20 px down and right each time, so they fan out
 * and never stack. The first one lands where the elements were copied from,
 * unless it is the slide they came from and one of them is still on it: then it
 * steps past them, so it does not land on top. A Cut takes them away, so the
 * first paste back lands where they were. Every paste has fresh ids and shares
 * nothing.
 */
export function pasteElements(clipboard: ElementClipboard, slide: Slide): CarouselElement[] {
  const last = clipboard.lastSteps.get(slide.id)
  const steps = last !== undefined ? last + 1 : firstPasteSteps(clipboard, slide)
  clipboard.lastSteps.set(slide.id, steps)
  return clipboard.elements.map((el) => stepped(cloneElement(el), steps * COPY_OFFSET))
}

/** Steps for the first paste onto `slide`: one when it is the slide the elements
 *  were copied from and one of their originals (same ids) is still on it, else none. */
function firstPasteSteps(clipboard: ElementClipboard, slide: Slide): number {
  if (slide.id !== clipboard.slideId) return 0
  const originals = new Set(clipboard.elements.map((el) => el.id))
  return slide.elements.some((el) => originals.has(el.id)) ? 1 : 0
}

/**
 * A copy of each selected element of `elements`, 20 px down and right under a
 * fresh id, by the id of the element it copies, in list order. Empty when none
 * of `selectedIds` is on the list. Making the copies apart from putting them in
 * lets a caller know their ids before the write that adds them lands.
 */
export function duplicateCopies(
  elements: CarouselElement[],
  selectedIds: Iterable<string>,
): Map<string, CarouselElement> {
  const selected = new Set(selectedIds)
  const copies = new Map<string, CarouselElement>()
  for (const el of elements) {
    if (selected.has(el.id)) copies.set(el.id, stepped(cloneElement(el), COPY_OFFSET))
  }
  return copies
}

/**
 * `elements` with each copy in `copies` directly above the element it copies
 * (in front of it, next in the array). A copy whose source is not on the list
 * is left out; with no source on it, the same array comes back.
 */
export function insertCopies(
  elements: CarouselElement[],
  copies: ReadonlyMap<string, CarouselElement>,
): CarouselElement[] {
  if (!elements.some((el) => copies.has(el.id))) return elements
  return elements.flatMap((el) => {
    const copy = copies.get(el.id)
    return copy ? [el, copy] : [el]
  })
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
  const copies = duplicateCopies(elements, selectedIds)
  return { elements: insertCopies(elements, copies), copyIds: Array.from(copies.values(), (copy) => copy.id) }
}
