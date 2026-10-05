import { describe, it, expect } from 'vitest'
import type { Note } from '../../../schema'
import { addNote, setNoteText, setNoteDone, removeNotes, sortedNotes } from '../notes'

const base = { id: 'p', tracks: [] } as any

describe('addNote', () => {
  it('adds a note at t with empty text and returns its id', () => {
    const { project, id } = addNote(base, 1.5)
    expect(project.notes).toEqual([{ id, t: 1.5, text: '' }])
  })
  it('keeps notes sorted by t', () => {
    const a = addNote(base, 3).project
    const b = addNote(a, 1).project
    expect(b.notes!.map(n => (n as Note).t)).toEqual([1, 3])
  })
})
describe('setNoteText / setNoteDone', () => {
  it('updates text, and returns the same reference when unchanged', () => {
    const { project, id } = addNote(base, 1)
    const p2 = setNoteText(project, id, 'caption covers face')
    expect(p2.notes![0].text).toBe('caption covers face')
    expect(setNoteText(p2, id, 'caption covers face')).toBe(p2)
  })
  it('done true sets it; false removes the key', () => {
    const { project, id } = addNote(base, 1)
    const d = setNoteDone(project, id, true)
    expect(d.notes![0].done).toBe(true)
    expect('done' in setNoteDone(d, id, false).notes![0]).toBe(false)
  })
})
describe('removeNotes', () => {
  it('last note removed: notes is null (the clear serve needs), JSON-serialized too', () => {
    // serve shallow-merges a PUT: an OMITTED key keeps the old value on disk (PL43).
    const { project, id } = addNote(base, 1)
    const out = removeNotes(project, new Set([id]))
    expect(out.notes).toBeNull()
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty('notes', null)
  })
  it('removing one of two keeps the other', () => {
    const a = addNote(base, 1)
    const b = addNote(a.project, 2)
    expect(removeNotes(b.project, new Set([a.id])).notes!.map(n => n.id)).toEqual([b.id])
  })
  it('a note added after the last was removed starts a fresh list', () => {
    const { project, id } = addNote(base, 1)
    expect(addNote(removeNotes(project, new Set([id])), 4).project.notes).toHaveLength(1)
  })
  it('sortedNotes treats null as empty', () => {
    expect(sortedNotes({ notes: null })).toEqual([])
  })
  it('unknown ids return the same reference', () => {
    const { project } = addNote(base, 1)
    expect(removeNotes(project, new Set(['nope']))).toBe(project)
  })
})
describe('sortedNotes', () => {
  it('skips malformed entries', () => {
    expect(sortedNotes({ notes: [{ id: 'a', t: 2, text: 'x' }, { t: 'bad' }] } as any)).toHaveLength(1)
  })
})
