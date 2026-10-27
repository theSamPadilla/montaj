import type { CarouselElement } from '../types'
import type { ReorderDirection } from '../state/project-reducer'
import { expandToGroups, groupMemberIds, groupOf, normalizeGroups } from './groups'

/** The group `picked` lie inside: some members of one group, not all of it, nothing else. */
function insideGroup(elements: readonly CarouselElement[], picked: readonly CarouselElement[]): string | undefined {
  const g = groupOf(picked[0])
  if (!g || !picked.every((el) => groupOf(el) === g)) return undefined
  return groupMemberIds(elements, g).length > picked.length ? g : undefined
}

/** `list` with `next` in place of the run of `group`'s members. */
function withGroupRun(list: CarouselElement[], group: string, next: CarouselElement[]): CarouselElement[] {
  const start = list.findIndex((el) => groupOf(el) === group)
  return [...list.slice(0, start), ...next, ...list.slice(start + next.length)]
}

/** `next`, or `elements` itself when it is the same order. */
function sameOr(elements: CarouselElement[], next: CarouselElement[]): CarouselElement[] {
  return next.length === elements.length && next.every((el, i) => el === elements[i]) ? elements : next
}

/** The stack as steps: each group (contiguous) is one, each other element one. */
function unitsOf(list: CarouselElement[]): CarouselElement[][] {
  const units: CarouselElement[][] = []
  for (const el of list) {
    const g = groupOf(el)
    const last = units[units.length - 1]
    if (g && last && groupOf(last[0]) === g) last.push(el)
    else units.push([el])
  }
  return units
}

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
  const picked = elements.filter((el) => selected.has(el.id))
  if (picked.length === 0) return elements
  // Groups (§587): a group is one step of the stack; members picked alone move among their group.
  const base = normalizeGroups(elements)
  const inside = insideGroup(elements, picked)
  if (inside) {
    const run = base.filter((el) => groupOf(el) === inside)
    return sameOr(elements, withGroupRun(base, inside, reorderSteps(run.map((el) => [el]), (u) => selected.has(u[0].id), direction).flat()))
  }
  return sameOr(elements, reorderSteps(unitsOf(base), (u) => u.some((el) => selected.has(el.id)), direction).flat())
}

/** The reorder itself, over steps: see `reorderSelection`. */
function reorderSteps<T>(steps: T[], isSelected: (step: T) => boolean, direction: ReorderDirection): T[] {
  if (direction === 'front' || direction === 'back') {
    const picked = steps.filter(isSelected)
    const others = steps.filter((s) => !isSelected(s))
    return direction === 'front' ? [...others, ...picked] : [...picked, ...others]
  }
  const next = [...steps]
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
  return next
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
  const asked = new Set(ids)
  const picked = elements.filter((el) => asked.has(el.id))
  const target = elements.find((el) => el.id === targetId)
  if (asked.has(targetId) || !target || picked.length === 0) return elements
  // Groups (§587): members picked alone move among their own group only.
  const base = normalizeGroups(elements)
  const inside = insideGroup(elements, picked)
  if (inside) {
    if (groupOf(target) !== inside) return elements
    const run = base.filter((el) => groupOf(el) === inside)
    return sameOr(elements, withGroupRun(base, inside, moveAmong(run, asked, targetId, where)))
  }
  // Anything else moves whole groups, and lands beside a group it is dropped on.
  const moving = new Set(expandToGroups(elements, [...asked]))
  if (moving.has(targetId)) return elements
  const tg = groupOf(target)
  const members = tg ? base.filter((el) => groupOf(el) === tg) : [target]
  const edge = where === 'above' ? members[members.length - 1] : members[0]
  return sameOr(elements, moveAmong(base, moving, edge.id, where))
}

/** `list` with `moving` just above or below `targetId` as Layers lists them (front first), in their own order. */
function moveAmong(list: CarouselElement[], moving: ReadonlySet<string>, targetId: string, where: 'above' | 'below'): CarouselElement[] {
  const front = [...list].reverse()
  const picked = front.filter((el) => moving.has(el.id))
  const rest = front.filter((el) => !moving.has(el.id))
  const at = rest.findIndex((el) => el.id === targetId)
  if (at < 0) return list
  rest.splice(where === 'above' ? at : at + 1, 0, ...picked)
  return rest.reverse()
}
