import type { EditorProject, ProjectNote, SlideNote } from '../schema'
import { noteId } from '../video/timeline/notes'

// Slide note model (PL70): pure mutations over a carousel's `project.notes`.
//
// Same contract as the video note model (`video/timeline/notes.ts`), over the
// notes array rather than the project: a write that changes nothing returns
// the SAME reference, and removing the last note returns `null`, the explicit
// clear serve needs (it shallow-merges a PUT, so an omitted key keeps the old
// notes on disk, PL43). Every function touches slide notes only: a time `Note`
// in the same array is left untouched and in place.

type Notes = EditorProject['notes']

function isFraction(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** A point as stored: both coordinates finite (clamped into 0..1), or none. */
function toPoint(x: unknown, y: unknown): { x: number; y: number } | null {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: clamp01(x), y: clamp01(y) }
}

/** A note pinned to a slide: string `id`, `slideId` and `text`, and `x`/`y`
 *  both fractions in 0..1 or both absent. A time note (one carrying `t`) is
 *  never a slide note, so the two kinds never overlap. */
export function isSlideNote(n: unknown): n is SlideNote {
  if (!n || typeof n !== 'object') return false
  const s = n as Record<string, unknown>
  if (typeof s.id !== 'string' || typeof s.slideId !== 'string' || typeof s.text !== 'string') return false
  if (s.t !== undefined) return false
  if (s.x === undefined && s.y === undefined) return true
  return isFraction(s.x) && isFraction(s.y)
}

function settle(notes: ProjectNote[]): ProjectNote[] | null {
  return notes.length === 0 ? null : notes
}

/** Index of the slide note `id`, or -1. Time notes never match. */
function indexOf(notes: Notes, id: string): number {
  return (notes ?? []).findIndex(n => isSlideNote(n) && n.id === id)
}

function replaceAt(notes: ProjectNote[], i: number, note: SlideNote): ProjectNote[] {
  const next = notes.slice()
  next[i] = note
  return next
}

/** Appends a note on `slideId`, about the whole slide unless both `x` and `y`
 *  are given (fractions, clamped into 0..1; a half point is dropped). */
export function addSlideNote(
  notes: Notes,
  { slideId, x, y, text = '', id = noteId() }: { slideId: string; x?: number; y?: number; text?: string; id?: string },
): { notes: ProjectNote[]; id: string } {
  const point = toPoint(x, y)
  const note: SlideNote = point ? { id, slideId, x: point.x, y: point.y, text } : { id, slideId, text }
  return { notes: [...(notes ?? []), note], id }
}

export function setSlideNoteText(notes: Notes, id: string, text: string): Notes {
  const i = indexOf(notes, id)
  if (i < 0) return notes
  const note = notes![i] as SlideNote
  if (note.text === text) return notes
  return replaceAt(notes!, i, { ...note, text })
}

export function setSlideNoteDone(notes: Notes, id: string, done: boolean): Notes {
  const i = indexOf(notes, id)
  if (i < 0) return notes
  const note = notes![i] as SlideNote
  if (!!note.done === done) return notes
  const { done: _d, ...rest } = note
  return replaceAt(notes!, i, done ? { ...rest, done: true } : rest)
}

/** Pins the note to a point on its slide (clamped into 0..1), or with `null`
 *  makes it about the whole slide. A non-finite point changes nothing. */
export function setSlideNotePoint(notes: Notes, id: string, point: { x: number; y: number } | null): Notes {
  const i = indexOf(notes, id)
  if (i < 0) return notes
  const note = notes![i] as SlideNote
  const { x: _x, y: _y, ...rest } = note
  if (point === null) {
    if (note.x === undefined && note.y === undefined) return notes
    return replaceAt(notes!, i, rest)
  }
  const p = toPoint(point.x, point.y)
  if (!p || (note.x === p.x && note.y === p.y)) return notes
  return replaceAt(notes!, i, { ...rest, x: p.x, y: p.y })
}

export function removeSlideNotes(notes: Notes, ids: Set<string>): Notes {
  const list = notes ?? []
  const kept = list.filter(n => !(isSlideNote(n) && ids.has(n.id)))
  if (kept.length === list.length) return notes
  return settle(kept)
}

/** The slide notes in reading order: by the slide's index in `slideOrder` (a
 *  note whose slide is gone sorts last, kept), then `y` (a whole-slide note
 *  before any point), then `x`, then `id`. Time notes and malformed entries
 *  are left out. The stored array is not reordered. */
export function sortedSlideNotes(notes: Notes, slideOrder: string[]): SlideNote[] {
  const rank = new Map(slideOrder.map((slideId, i) => [slideId, i]))
  const slideRank = (n: SlideNote) => rank.get(n.slideId) ?? Number.POSITIVE_INFINITY
  const coord = (v: number | undefined) => v ?? Number.NEGATIVE_INFINITY
  return (notes ?? []).filter(isSlideNote).sort((a, b) =>
    // A difference of two infinities is NaN, which falls through like 0.
    (slideRank(a) - slideRank(b))
    || (coord(a.y) - coord(b.y))
    || (coord(a.x) - coord(b.x))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}
