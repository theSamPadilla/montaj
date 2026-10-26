import type { CarouselElement } from '../types'

type Point = { x: number; y: number }

/** Whether `point` (slide units) lies in the element's box as drawn, turned about its middle. */
export function pointInElement(point: Point, el: CarouselElement): boolean {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  const turn = -((el.rotation ?? 0) * Math.PI) / 180
  const dx = point.x - cx
  const dy = point.y - cy
  // Into the box's own, unturned frame.
  const lx = dx * Math.cos(turn) - dy * Math.sin(turn)
  const ly = dx * Math.sin(turn) + dy * Math.cos(turn)
  return Math.abs(lx) <= el.w / 2 && Math.abs(ly) <= el.h / 2
}

/**
 * The ids of the elements under `point` (slide units), front to back. `elements`
 * runs back to front. Each is hit by its turned box; hidden ones are skipped.
 */
export function elementsAt(point: Point, elements: CarouselElement[], hidden?: ReadonlySet<string> | null): string[] {
  const ids: string[] = []
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]
    if (hidden?.has(el.id)) continue
    if (pointInElement(point, el)) ids.push(el.id)
  }
  return ids
}

/** Whether the press is the layer-reaching one: Cmd on a Mac (where Ctrl-click is a right-click), Ctrl elsewhere. */
export function isLayerPress(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return mac ? e.metaKey : e.ctrlKey
}

/**
 * The element a layer press selects: the next one below the frontmost selected
 * element under the pointer, wrapping from the bottom to the top; the topmost
 * when none of the selection is there. `stack` is `elementsAt`'s, front to back.
 */
export function nextLayerDown(stack: string[], selected: readonly string[]): string | null {
  if (stack.length === 0) return null
  const at = stack.findIndex((id) => selected.includes(id))
  return at < 0 ? stack[0] : stack[(at + 1) % stack.length]
}
