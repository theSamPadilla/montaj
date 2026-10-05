import { describe, it, expect } from 'vitest'
import type { Note, ProjectNote, SlideNote } from '../../schema'
import {
  addSlideNote,
  isSlideNote,
  removeSlideNotes,
  setSlideNoteDone,
  setSlideNotePoint,
  setSlideNoteText,
  sortedSlideNotes,
} from '../notes'

// A time note sharing the array: every slide function must leave it alone, in place.
const timeNote: Note = { id: 'tn', t: 3, text: 'video note' }

function withTimeNote(): { notes: ProjectNote[]; a: string; b: string } {
  const first = addSlideNote([timeNote], { slideId: 's1', text: 'a' })
  const second = addSlideNote(first.notes, { slideId: 's2', x: 0.4, y: 0.25, text: 'b' })
  return { notes: second.notes, a: first.id, b: second.id }
}

function slideNote(notes: ProjectNote[] | null | undefined, id: string): SlideNote {
  return (notes ?? []).find((n): n is SlideNote => isSlideNote(n) && n.id === id)!
}

describe('addSlideNote', () => {
  it('adds a whole-slide note with empty text by default and returns its id', () => {
    const { notes, id } = addSlideNote(undefined, { slideId: 's1' })
    expect(id).toMatch(/^note-/)
    expect(notes).toEqual([{ id, slideId: 's1', text: '' }])
    expect('x' in notes[0]).toBe(false)
    expect('y' in notes[0]).toBe(false)
  })
  it('adds a note at a point, with the given text and id', () => {
    const { notes, id } = addSlideNote(null, { slideId: 's1', x: 0.4, y: 0.25, text: 'logo too small', id: 'n1' })
    expect(id).toBe('n1')
    expect(notes).toEqual([{ id: 'n1', slideId: 's1', x: 0.4, y: 0.25, text: 'logo too small' }])
  })
  it('clamps a point into 0..1, and drops a half point', () => {
    expect(addSlideNote([], { slideId: 's1', x: 1.5, y: -0.2 }).notes[0]).toMatchObject({ x: 1, y: 0 })
    const half = addSlideNote([], { slideId: 's1', x: 0.5 }).notes[0]
    expect('x' in half || 'y' in half).toBe(false)
  })
  it('appends after a time note, leaving it untouched and in place', () => {
    const { notes } = addSlideNote([timeNote], { slideId: 's1' })
    expect(notes[0]).toBe(timeNote)
    expect(notes).toHaveLength(2)
  })
})

describe('setSlideNoteText', () => {
  it('updates text, and returns the same reference when unchanged or unknown', () => {
    const { notes, a } = withTimeNote()
    const next = setSlideNoteText(notes, a, 'move the title up')
    expect(slideNote(next, a).text).toBe('move the title up')
    expect(setSlideNoteText(next, a, 'move the title up')).toBe(next)
    expect(setSlideNoteText(next, 'nope', 'x')).toBe(next)
  })
  it('never touches a time note, even one with the same id', () => {
    const notes = [timeNote]
    expect(setSlideNoteText(notes, 'tn', 'changed')).toBe(notes)
    const { notes: mixed, a } = withTimeNote()
    expect(setSlideNoteText(mixed, a, 'x')![0]).toBe(timeNote)
  })
})

describe('setSlideNoteDone', () => {
  it('true sets done; false removes the key; unchanged is the same reference', () => {
    const { notes, a } = withTimeNote()
    const done = setSlideNoteDone(notes, a, true)
    expect(slideNote(done, a).done).toBe(true)
    expect(setSlideNoteDone(done, a, true)).toBe(done)
    expect('done' in slideNote(setSlideNoteDone(done, a, false), a)).toBe(false)
    expect(done![0]).toBe(timeNote)
  })
  it('never touches a time note', () => {
    const notes = [timeNote]
    expect(setSlideNoteDone(notes, 'tn', true)).toBe(notes)
  })
})

describe('setSlideNotePoint', () => {
  it('sets a point on a whole-slide note, clamped', () => {
    const { notes, a } = withTimeNote()
    const next = setSlideNotePoint(notes, a, { x: 0.1, y: 1.2 })
    expect(slideNote(next, a)).toMatchObject({ x: 0.1, y: 1 })
    expect(next![0]).toBe(timeNote)
  })
  it('null clears the point (the note is about the whole slide again)', () => {
    const { notes, b } = withTimeNote()
    const cleared = slideNote(setSlideNotePoint(notes, b, null), b)
    expect('x' in cleared || 'y' in cleared).toBe(false)
    expect(cleared.text).toBe('b')
  })
  it('the same point, null on no point, an unknown id or a non-finite point return the same reference', () => {
    const { notes, a, b } = withTimeNote()
    expect(setSlideNotePoint(notes, b, { x: 0.4, y: 0.25 })).toBe(notes)
    expect(setSlideNotePoint(notes, a, null)).toBe(notes)
    expect(setSlideNotePoint(notes, 'nope', { x: 0, y: 0 })).toBe(notes)
    expect(setSlideNotePoint(notes, a, { x: Number.NaN, y: 0 })).toBe(notes)
    expect(setSlideNotePoint(notes, 'tn', { x: 0, y: 0 })).toBe(notes)
  })
})

describe('removeSlideNotes', () => {
  it('removes slide notes by id and keeps the time note in place', () => {
    const { notes, a, b } = withTimeNote()
    const out = removeSlideNotes(notes, new Set([a]))
    expect(out).toEqual([timeNote, slideNote(notes, b)])
    expect(out![0]).toBe(timeNote)
  })
  it('never removes a time note, even by its id', () => {
    const { notes } = withTimeNote()
    expect(removeSlideNotes(notes, new Set(['tn']))).toBe(notes)
  })
  it('the last note removed: notes is null (the clear serve needs), JSON-serialized too', () => {
    const { notes, id } = addSlideNote(undefined, { slideId: 's1' })
    const out = removeSlideNotes(notes, new Set([id]))
    expect(out).toBeNull()
    expect(JSON.parse(JSON.stringify({ notes: out }))).toHaveProperty('notes', null)
  })
  it('unknown ids return the same reference', () => {
    const { notes } = withTimeNote()
    expect(removeSlideNotes(notes, new Set(['nope']))).toBe(notes)
    expect(removeSlideNotes(undefined, new Set(['nope']))).toBeUndefined()
  })
})

describe('sortedSlideNotes', () => {
  const n = (id: string, slideId: string, p?: [number, number]): SlideNote =>
    p ? { id, slideId, x: p[0], y: p[1], text: id } : { id, slideId, text: id }

  it('orders by slide order, then y (whole-slide first), then x, then id', () => {
    const notes: ProjectNote[] = [
      timeNote,
      n('e', 's1', [0.2, 0.9]),
      n('d', 's1', [0.8, 0.5]),
      n('c', 's1', [0.1, 0.5]),
      n('z', 's2'),
      n('b', 's1'),
      n('a', 's1'),
    ]
    expect(sortedSlideNotes(notes, ['s1', 's2']).map(x => x.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'z'])
    expect(sortedSlideNotes(notes, ['s2', 's1']).map(x => x.id)).toEqual(['z', 'a', 'b', 'c', 'd', 'e'])
  })
  it('keeps a note on a removed slide and sorts it last', () => {
    const notes: ProjectNote[] = [n('gone', 'sX'), n('kept', 's2', [0.9, 0.9])]
    expect(sortedSlideNotes(notes, ['s1', 's2']).map(x => x.id)).toEqual(['kept', 'gone'])
  })
  it('leaves time notes out, skips malformed entries and treats null as empty', () => {
    expect(sortedSlideNotes([timeNote, { id: 'bad' } as never, n('a', 's1')], ['s1']).map(x => x.id)).toEqual(['a'])
    expect(sortedSlideNotes(null, ['s1'])).toEqual([])
    expect(sortedSlideNotes(undefined, [])).toEqual([])
  })
  it('does not reorder the stored array', () => {
    const notes: ProjectNote[] = [n('b', 's1'), n('a', 's1')]
    sortedSlideNotes(notes, ['s1'])
    expect(notes.map(x => x.id)).toEqual(['b', 'a'])
  })
})

describe('isSlideNote', () => {
  it('accepts a whole-slide note and a note with a point in 0..1', () => {
    expect(isSlideNote({ id: 'a', slideId: 's', text: '' })).toBe(true)
    expect(isSlideNote({ id: 'a', slideId: 's', x: 0, y: 1, text: 'x', done: true })).toBe(true)
  })
  it('rejects x without y, y without x, an out-of-range or non-finite point', () => {
    expect(isSlideNote({ id: 'a', slideId: 's', x: 0.5, text: '' })).toBe(false)
    expect(isSlideNote({ id: 'a', slideId: 's', y: 0.5, text: '' })).toBe(false)
    expect(isSlideNote({ id: 'a', slideId: 's', x: 1.1, y: 0.5, text: '' })).toBe(false)
    expect(isSlideNote({ id: 'a', slideId: 's', x: -0.1, y: 0.5, text: '' })).toBe(false)
    expect(isSlideNote({ id: 'a', slideId: 's', x: Number.NaN, y: 0.5, text: '' })).toBe(false)
    expect(isSlideNote({ id: 'a', slideId: 's', x: '0.5', y: 0.5, text: '' })).toBe(false)
  })
  it('rejects a missing id, slideId or text, a non-object, and a time note', () => {
    expect(isSlideNote({ slideId: 's', text: '' })).toBe(false)
    expect(isSlideNote({ id: 'a', text: '' })).toBe(false)
    expect(isSlideNote({ id: 'a', slideId: 's' })).toBe(false)
    expect(isSlideNote(null)).toBe(false)
    expect(isSlideNote('note')).toBe(false)
    expect(isSlideNote(timeNote)).toBe(false)
    expect(isSlideNote({ id: 'a', slideId: 's', t: 1, text: '' })).toBe(false)
  })
})
