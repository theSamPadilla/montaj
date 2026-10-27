import type { CarouselElement } from '../types'
import { coveredUnion } from './AlignControls'
import { isLocked } from './lock'

// Groups (§587): elements that share a `group` id act as one on the canvas.
// The elements stay flat (the export is unchanged); a group's members sit next
// to each other in `elements`, at the place of its frontmost member. Index 0
// is the back of the slide, the last index the front.

type Box = { x: number; y: number; w: number; h: number }

/** A member's box after a group gesture, and the ratio its text scales by (1: none). */
export type MemberBox = Box & { id: string; rotation: number; ratio: number }

/** The element's group id, or undefined when it is in none (absent, empty or not a string). */
export function groupOf(el: CarouselElement | undefined): string | undefined {
  const g = (el as { group?: unknown } | undefined)?.group
  return typeof g === 'string' && g !== '' ? g : undefined
}

/** The ids of group `group`'s members, back to front. */
export function groupMemberIds(elements: readonly CarouselElement[], group: string): string[] {
  return elements.filter((el) => groupOf(el) === group).map((el) => el.id)
}

/** The group `ids` are exactly the members of, in any order; null when they are not one whole group. */
export function wholeGroup(elements: readonly CarouselElement[], ids: readonly string[]): string | null {
  if (ids.length === 0) return null
  const first = groupOf(elements.find((el) => el.id === ids[0]))
  if (!first) return null
  const members = groupMemberIds(elements, first)
  return members.length === new Set(ids).size && ids.every((id) => members.includes(id)) ? first : null
}

/** `ids` with each grouped one replaced by its whole group (back to front), each id once, in order. */
export function expandToGroups(elements: readonly CarouselElement[], ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const g = groupOf(elements.find((el) => el.id === id))
    for (const m of g ? groupMemberIds(elements, g) : [id]) if (!out.includes(m)) out.push(m)
  }
  return out
}

/** The group the selection is inside: one member of a group, selected alone. */
function enteredGroup(elements: readonly CarouselElement[], selected: readonly string[]): string | undefined {
  return selected.length === 1 ? groupOf(elements.find((el) => el.id === selected[0])) : undefined
}

/**
 * What a plain press on `id` selects: its whole group, or `id` alone when it is
 * in no group or the selection is already inside its group (one member of it
 * selected), where a press picks one member.
 */
export function selectionAfterPress(elements: readonly CarouselElement[], id: string, selected: readonly string[]): string[] {
  const g = groupOf(elements.find((el) => el.id === id))
  if (!g || g === enteredGroup(elements, selected)) return [id]
  return groupMemberIds(elements, g)
}

/** A shift-press on `id`: its whole group (or it) joins the selection, or leaves it when all of it is in. */
export function toggleGroupSelection(elements: readonly CarouselElement[], id: string, selected: readonly string[]): string[] {
  const unit = expandToGroups(elements, [id])
  if (unit.every((m) => selected.includes(m))) return selected.filter((s) => !unit.includes(s))
  return [...selected, ...unit.filter((m) => !selected.includes(m))]
}

/** Whether `el` is held in place by a lock: its own, or one on any member of its group. */
export function heldByLock(elements: readonly CarouselElement[], el: CarouselElement): boolean {
  if (isLocked(el)) return true
  const g = groupOf(el)
  return !!g && elements.some((o) => groupOf(o) === g && isLocked(o))
}

/** Whether `ids` can be grouped: two or more, not already exactly one group, none locked. */
export function canGroup(elements: readonly CarouselElement[], ids: readonly string[]): boolean {
  const picked = elements.filter((el) => ids.includes(el.id))
  return picked.length >= 2 && wholeGroup(elements, ids) === null && !picked.some(isLocked)
}

/** The groups wholly inside `ids`. */
function groupsIn(elements: readonly CarouselElement[], ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const g = groupOf(elements.find((el) => el.id === id))
    if (g && !out.includes(g) && groupMemberIds(elements, g).every((m) => ids.includes(m))) out.push(g)
  }
  return out
}

/** Whether `ids` hold a whole group to ungroup, with no locked member (a lock protects the group too). */
export function canUngroup(elements: readonly CarouselElement[], ids: readonly string[]): boolean {
  const gs = groupsIn(elements, ids)
  return gs.length > 0 && !elements.some((el) => gs.includes(groupOf(el) ?? '') && isLocked(el))
}

/**
 * `elements` with every group made contiguous: its members, in their order,
 * at the place of its frontmost member. The same array when nothing moves.
 */
export function normalizeGroups(elements: CarouselElement[]): CarouselElement[] {
  let next = elements
  const seen = new Set<string>()
  for (const el of elements) {
    const g = groupOf(el)
    if (!g || seen.has(g)) continue
    seen.add(g)
    const members = next.filter((e) => groupOf(e) === g)
    const front = next.lastIndexOf(members[members.length - 1])
    const before = next.slice(0, front + 1).filter((e) => groupOf(e) !== g)
    const after = next.slice(front + 1)
    const gathered = [...before, ...members, ...after]
    if (gathered.some((e, i) => e !== next[i])) next = gathered
  }
  return next
}

/**
 * `elements` with `ids` (two or more) made one new group `group`: groups taken
 * in whole join it. The members are gathered at the frontmost one's place in
 * their own order; no box changes. The same array for fewer than two.
 */
export function groupElements(elements: CarouselElement[], ids: readonly string[], group: string): CarouselElement[] {
  const picked = new Set(expandToGroups(elements, ids))
  if (elements.filter((el) => picked.has(el.id)).length < 2) return elements
  return normalizeGroups(elements.map((el) => (picked.has(el.id) ? { ...el, group } : el)))
}

/** `elements` with every group `ids` touch ungrouped: its members lose `group`. The same array when none. */
export function ungroupElements(elements: CarouselElement[], ids: readonly string[]): CarouselElement[] {
  const gs = new Set(ids.map((id) => groupOf(elements.find((el) => el.id === id))).filter((g): g is string => !!g))
  if (gs.size === 0) return elements
  return elements.map((el) => {
    if (!gs.has(groupOf(el) ?? '')) return el
    const { group: _group, ...free } = el
    return free as CarouselElement
  })
}

/** `elements` with each group under a new id, the same one for all its members: a copy is its own group. */
export function freshGroupIds(elements: CarouselElement[], newId: () => string = () => crypto.randomUUID()): CarouselElement[] {
  const ids = new Map<string, string>()
  return elements.map((el) => {
    const g = groupOf(el)
    if (!g) return el
    if (!ids.has(g)) ids.set(g, newId())
    return { ...el, group: ids.get(g)! }
  })
}

/** The box a group covers: the union of its members as drawn, turned ones by the box they cover. */
export function groupBox(members: readonly (Box & { rotation?: number })[]): Box {
  const u = coveredUnion(members)
  return { x: u.left, y: u.top, w: u.right - u.left, h: u.bottom - u.top }
}

/**
 * Each member after the group box `from` is resized to `to`: its centre keeps
 * its place in the box, and its size scales with the box along its own axes
 * (a turned member keeps its turn). A uniform scale also gives the ratio its
 * text scales by, as a corner drag of one text box does; a stretch gives 1.
 */
export function scaleMembers(members: readonly CarouselElement[], from: Box, to: Box): MemberBox[] {
  const sx = from.w > 0 ? to.w / from.w : 1
  const sy = from.h > 0 ? to.h / from.h : 1
  const uniform = Math.abs(sx - sy) < 1e-9
  return members.map((el) => {
    const rotation = el.rotation ?? 0
    const cx = to.x + (el.x + el.w / 2 - from.x) * sx
    const cy = to.y + (el.y + el.h / 2 - from.y) * sy
    let w = el.w * sx
    let h = el.h * sy
    if (!uniform && rotation % 180 !== 0) {
      const t = (rotation * Math.PI) / 180
      const c = Math.cos(t)
      const s = Math.sin(t)
      w = el.w * Math.hypot(sx * c, sy * s)
      h = el.h * Math.hypot(sx * s, sy * c)
    }
    return { id: el.id, x: cx - w / 2, y: cy - h / 2, w, h, rotation, ratio: uniform ? sx : 1 }
  })
}

/** Each member turned `degrees` clockwise about `center`: its centre goes round it and its own turn adds the same. */
export function rotateMembers(members: readonly CarouselElement[], center: { x: number; y: number }, degrees: number): MemberBox[] {
  const t = (degrees * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return members.map((el) => {
    const dx = el.x + el.w / 2 - center.x
    const dy = el.y + el.h / 2 - center.y
    const cx = center.x + dx * c - dy * s
    const cy = center.y + dx * s + dy * c
    const rotation = ((((el.rotation ?? 0) + degrees) % 360) + 360) % 360
    return { id: el.id, x: cx - el.w / 2, y: cy - el.h / 2, w: el.w, h: el.h, rotation, ratio: 1 }
  })
}

/** Whole slide pixels for a commit: w and h round first (at least 1), then x and y from the centre. */
export function roundedMemberBoxes(boxes: readonly MemberBox[]): MemberBox[] {
  return boxes.map((b) => {
    const w = Math.max(1, Math.round(b.w))
    const h = Math.max(1, Math.round(b.h))
    return { ...b, x: Math.round(b.x + b.w / 2 - w / 2), y: Math.round(b.y + b.h / 2 - h / 2), w, h }
  })
}
