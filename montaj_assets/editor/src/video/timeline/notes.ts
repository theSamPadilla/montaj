import type { EditorProject, Note } from '../../schema'

export function noteId(): string {
  return `note-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** A time note: string `id` and `text`, finite `t`. The only kind video code reads;
 *  a `SlideNote` (or anything else) in `project.notes` is skipped. */
export function isNote(n: unknown): n is Note {
  return !!n && typeof (n as Note).id === 'string' && typeof (n as Note).t === 'number' && Number.isFinite((n as Note).t)
    && typeof (n as Note).text === 'string'
}

export function sortedNotes(project: Pick<EditorProject, 'notes'>): Note[] {
  return (project.notes ?? []).filter(isNote).slice().sort((a, b) => a.t - b.t)
}

function withNotes(project: EditorProject, notes: Note[]): EditorProject {
  // An empty list is sent as an explicit null: serve shallow-merges a PUT, so an
  // omitted key would keep the old notes on disk (PL43).
  if (notes.length === 0) return { ...project, notes: null }
  return { ...project, notes }
}

export function addNote(project: EditorProject, t: number): { project: EditorProject; id: string } {
  const id = noteId()
  const notes = [...sortedNotes(project), { id, t: Math.max(0, t), text: '' }].sort((a, b) => a.t - b.t)
  return { project: withNotes(project, notes), id }
}

export function setNoteText(project: EditorProject, id: string, text: string): EditorProject {
  const notes = sortedNotes(project)
  const i = notes.findIndex(n => n.id === id)
  if (i < 0 || notes[i].text === text) return project
  notes[i] = { ...notes[i], text }
  return withNotes(project, notes)
}

export function setNoteDone(project: EditorProject, id: string, done: boolean): EditorProject {
  const notes = sortedNotes(project)
  const i = notes.findIndex(n => n.id === id)
  if (i < 0 || !!notes[i].done === done) return project
  const { done: _d, ...rest } = notes[i]
  notes[i] = done ? { ...rest, done: true } : rest
  return withNotes(project, notes)
}

export function removeNotes(project: EditorProject, ids: Set<string>): EditorProject {
  const notes = sortedNotes(project)
  const kept = notes.filter(n => !ids.has(n.id))
  if (kept.length === notes.length) return project
  return withNotes(project, kept)
}
