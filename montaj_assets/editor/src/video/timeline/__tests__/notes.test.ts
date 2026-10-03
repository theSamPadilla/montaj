import { describe, it, expect } from 'vitest'
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
    expect(b.notes!.map(n => n.t)).toEqual([1, 3])
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
  it('drops the key entirely when the last note goes', () => {
    const { project, id } = addNote(base, 1)
    expect('notes' in removeNotes(project, new Set([id]))).toBe(false)
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
