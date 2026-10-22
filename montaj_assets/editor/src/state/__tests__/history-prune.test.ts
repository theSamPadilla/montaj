import { describe, it, expect } from 'vitest'
import { pruneHistory, type HistoryEntry } from '../history-prune'
import type { Project } from '../../types'

// §482 U-1: `pruneHistory` on its own. A sync pull turned `known` (the document the
// history knew) into `reloaded`. Each step that changed a unit the pull changed is
// dropped, the drop cascades outwards, every kept step is rebuilt on the reloaded
// document, a step that cannot be rebuilt without inventing or silently deleting a
// clip is dropped too, and nothing passed in is ever written to.

type Clip = { id: string; start: number; end: number; [k: string]: unknown }
type Track = { id: string; items: Clip[]; [k: string]: unknown }
type Entry = HistoryEntry<Project>

const clip = (id: string, start: number, end: number): Clip => ({ id, start, end })
const doc = (tracks: Track[], extra: Record<string, unknown> = {}): Project =>
  ({ id: 'p', name: 'Project', ...extra, tracks }) as unknown as Project
const tracksOf = (p: Project) => p.tracks as unknown as Track[]
const ids = (p: Project) => tracksOf(p).map((t) => t.items.map((c) => c.id))
const clipOf = (p: Project, id: string) => tracksOf(p).flatMap((t) => t.items).find((c) => c.id === id)
const setClip = (p: Project, id: string, patch: Partial<Clip>): Project => ({
  ...p,
  tracks: tracksOf(p).map((t) => ({ ...t, items: t.items.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
} as unknown as Project)
const setTrack = (p: Project, id: string, patch: Partial<Track>): Project => ({
  ...p,
  tracks: tracksOf(p).map((t) => (t.id === id ? { ...t, ...patch } : t)),
} as unknown as Project)

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(deepFreeze)
    Object.freeze(v)
  }
  return v
}

/** Top-level keys whose value differs by reference, as the hook records them. */
function keysOf(a: Project, b: Project): string[] {
  const all = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...all].filter((k) => (a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k])
}

/** The undo stack (oldest first) of `edits` made in order from `start`, frozen, and the document after them. */
function history(start: Project, edits: Array<(p: Project) => Project>): { undo: Entry[]; now: Project } {
  let now = deepFreeze(start)
  const undo: Entry[] = []
  for (const edit of edits) {
    const next = deepFreeze(edit(now))
    undo.push({ before: now, after: next, keys: keysOf(now, next) })
    now = next
  }
  return { undo, now }
}

/** Undo the top step of `undo` on `current` the way the hook does: its keys from `before`. */
function undoTop(undo: Entry[], current: Project): Project {
  const entry = undo[undo.length - 1]
  const next = { ...current } as Record<string, unknown>
  for (const k of entry.keys) next[k] = (entry.before as Record<string, unknown>)[k]
  return next as unknown as Project
}

const base = () => doc([{ id: 'trk-0', items: [clip('A', 0, 5), clip('B', 5, 10)] }])

describe('pruneHistory (§482 U-1)', () => {
  it('a step on a clip, when the pull changed another field: kept, and its undo carries the pulled field', () => {
    const { undo, now } = history(base(), [(p) => setClip(p, 'A', { end: 4 })])
    const reloaded = deepFreeze({ ...now, name: 'Pulled' } as Project)
    const out = pruneHistory(undo, [], now, reloaded)!
    expect(out.dropped).toEqual({ undo: 0, redo: 0 })
    expect(out.undo).toHaveLength(1)
    expect(out.undo[0].after).toBe(reloaded)
    expect(out.undo[0].before.name).toBe('Pulled')
    expect(clipOf(out.undo[0].before, 'A')?.end).toBe(5)
  })

  it('a step on the clip the pull changed is dropped, even when they changed different properties of it', () => {
    const { undo, now } = history(base(), [(p) => setClip(p, 'B', { end: 9 })])
    const out = pruneHistory(undo, [], now, deepFreeze(setClip(now, 'B', { start: 6 })))!
    expect(out.undo).toEqual([])
    expect(out.dropped).toEqual({ undo: 1, redo: 0 })
  })

  it('a drop cascades across two steps: each older step that changed what a dropped step changed goes too, an unrelated one stays', () => {
    const start = doc([{ id: 'trk-0', items: [clip('A', 0, 5), clip('B', 5, 10), clip('X', 10, 15), clip('Y', 15, 20)] }])
    const { undo, now } = history(start, [
      (p) => ({ ...p, name: 'Renamed' }),
      (p) => setClip(p, 'X', { end: 14 }),
      (p) => setClip(setClip(p, 'X', { end: 13 }), 'Y', { start: 13 }),
      (p) => setClip(setClip(p, 'Y', { end: 19 }), 'B', { start: 6 }),
    ])
    const reloaded = deepFreeze(setClip(now, 'B', { end: 12 }))
    const out = pruneHistory(undo, [], now, reloaded)!
    // B drops the newest, Y the one before it, X the one before that.
    expect(out.dropped).toEqual({ undo: 3, redo: 0 })
    expect(out.undo).toHaveLength(1)
    expect(out.undo[0].keys).toEqual(['name'])
    expect(undoTop(out.undo, reloaded).name).toBe('Project')
  })

  it('a rebased step keeps the pulled end of another clip, in its snapshot and in what its undo restores', () => {
    const { undo, now } = history(base(), [(p) => setClip(p, 'A', { start: 1 })])
    const reloaded = deepFreeze(setClip(now, 'B', { end: 12 }))
    const out = pruneHistory(undo, [], now, reloaded)!
    expect(out.undo).toHaveLength(1)
    expect(clipOf(out.undo[0].before, 'B')?.end).toBe(12)
    const undone = undoTop(out.undo, reloaded)
    expect(clipOf(undone, 'A')).toEqual(clip('A', 0, 5))
    expect(clipOf(undone, 'B')?.end).toBe(12)
  })

  it('tracks that do not split (a clip with no id) are one unit: every step on tracks drops, others stay', () => {
    const loose = doc([{ id: 'trk-0', items: [{ start: 0, end: 5 } as Clip, clip('B', 5, 10)] }])
    const { undo, now } = history(loose, [
      (p) => ({ ...p, name: 'Renamed' }),
      (p) => setClip(p, 'B', { end: 9 }),
    ])
    const reloaded = deepFreeze({
      ...now,
      tracks: tracksOf(now).map((t) => ({ ...t, items: t.items.map((c, i) => (i === 0 ? { ...c, end: 4 } : c)) })),
    } as unknown as Project)
    const out = pruneHistory(undo, [], now, reloaded)!
    expect(out.dropped).toEqual({ undo: 1, redo: 0 })
    expect(out.undo.map((e) => e.keys)).toEqual([['name']])
  })

  it('a clip add, then a pull that removes its neighbour from the same track: the add is dropped and B is not invented back', () => {
    const { undo, now } = history(base(), [(p) => ({
      ...p,
      tracks: tracksOf(p).map((t) => ({ ...t, items: [...t.items, clip('X', 10, 12)] })),
    } as unknown as Project)])
    const reloaded = deepFreeze({
      ...now,
      tracks: tracksOf(now).map((t) => ({ ...t, items: t.items.filter((c) => c.id !== 'B') })),
    } as unknown as Project)
    const out = pruneHistory(undo, [], now, reloaded)!
    expect(out.dropped).toEqual({ undo: 1, redo: 0 })
    expect(out.undo).toEqual([])
  })

  it('a clip add, then a pull that removes a clip from ANOTHER track: the add is kept and its undo removes only the added clip', () => {
    const two = doc([
      { id: 'trk-0', items: [clip('A', 0, 5)] },
      { id: 'trk-1', items: [clip('M', 0, 5), clip('N', 5, 10)] },
    ])
    const { undo, now } = history(two, [(p) => ({
      ...p,
      tracks: tracksOf(p).map((t, i) => (i === 0 ? { ...t, items: [...t.items, clip('X', 5, 8)] } : t)),
    } as unknown as Project)])
    const reloaded = deepFreeze({
      ...now,
      tracks: tracksOf(now).map((t, i) => (i === 1 ? { ...t, items: t.items.filter((c) => c.id !== 'N') } : t)),
    } as unknown as Project)
    const out = pruneHistory(undo, [], now, reloaded)!
    expect(out.dropped).toEqual({ undo: 0, redo: 0 })
    expect(ids(undoTop(out.undo, reloaded))).toEqual([['A'], ['M']])
  })

  it('the unknown state: a kept step whose restored list names a clip nobody has any more (it would be invented) is dropped', () => {
    // The step added Y. A frame outside the history then removed B, so the list the
    // step's undo restores, [A, B], names a clip neither the step nor the pulled
    // document holds. Rebuilding it would invent B; dropping B silently would be a
    // guess too. The step goes, so the undo refuses.
    const { undo } = history(base(), [(p) => ({
      ...p,
      tracks: tracksOf(p).map((t) => ({ ...t, items: [...t.items, clip('Y', 10, 12)] })),
    } as unknown as Project)])
    const known = deepFreeze(doc([{ id: 'trk-0', items: [clip('A', 0, 5), clip('Y', 10, 12)] }]))
    const reloaded = deepFreeze(setClip(known, 'A', { end: 4 }))
    const out = pruneHistory(undo, [], known, reloaded)!
    expect(out.dropped).toEqual({ undo: 1, redo: 0 })
    expect(out.undo).toEqual([])
  })

  it('the unknown state, the other way: the document holds a clip no restored list names (dropping it would be a guess), so the step is dropped', () => {
    // The step added Y. A frame outside the history then added Z beside it. The list
    // the step's undo restores, [A, B], leaves Z out.
    const { undo } = history(base(), [(p) => ({
      ...p,
      tracks: tracksOf(p).map((t) => ({ ...t, items: [...t.items, clip('Y', 10, 12)] })),
    } as unknown as Project)])
    const known = deepFreeze({
      ...undo[0].after,
      tracks: tracksOf(undo[0].after).map((t) => ({ ...t, items: [...t.items, clip('Z', 12, 14)] })),
    } as unknown as Project)
    const out = pruneHistory(undo, [], known, deepFreeze({ ...known, name: 'Pulled' } as Project))!
    expect(out.dropped).toEqual({ undo: 1, redo: 0 })
    expect(out.undo).toEqual([])
  })

  it('redo is the mirror: a redo step on the pulled clip drops, one on another clip is kept and redoes onto the pulled document', () => {
    const { undo, now: after } = history(base(), [
      (p) => setClip(p, 'A', { end: 4 }),
      (p) => setClip(p, 'B', { end: 9 }),
    ])
    // Both undone: the redo stack holds them, the A step on top (it redoes first).
    const known = undo[0].before
    const reloaded = deepFreeze(setClip(known, 'B', { end: 12 }))
    const out = pruneHistory([], [...undo].reverse(), known, reloaded)!
    expect(out.dropped).toEqual({ undo: 0, redo: 1 })
    expect(out.redo).toHaveLength(1)
    expect(out.redo[0].before).toBe(reloaded)
    const redone = { ...reloaded, tracks: out.redo[0].after.tracks } as Project
    expect(clipOf(redone, 'A')?.end).toBe(clipOf(after, 'A')?.end)
    expect(clipOf(redone, 'B')?.end).toBe(12)
  })

  it('track order and a track own fields are units of their own: a pull of a clip keeps a reorder and a mute; a pull of the order drops the reorder', () => {
    const two = doc([
      { id: 'trk-0', items: [clip('A', 0, 5)] },
      { id: 'trk-1', items: [clip('M', 0, 5)] },
    ])
    const { undo, now } = history(two, [
      (p) => setTrack(p, 'trk-0', { muted: true }),
      (p) => ({ ...p, tracks: [...tracksOf(p)].reverse() } as unknown as Project),
    ])
    const clipPull = pruneHistory(undo, [], now, deepFreeze(setClip(now, 'A', { end: 4 })))!
    expect(clipPull.dropped).toEqual({ undo: 0, redo: 0 })
    const orderPull = pruneHistory(undo, [], now, deepFreeze({ ...now, tracks: [...tracksOf(now)].reverse() } as unknown as Project))!
    expect(orderPull.dropped).toEqual({ undo: 1, redo: 0 })
    expect(orderPull.undo).toHaveLength(1)
  })

  it('an empty history: nothing to drop, and a pull that changed nothing is null', () => {
    const now = deepFreeze(base())
    expect(pruneHistory([], [], now, deepFreeze(setClip(now, 'A', { end: 4 })))).toEqual({
      undo: [], redo: [], dropped: { undo: 0, redo: 0 },
    })
    const { undo } = history(base(), [(p) => setClip(p, 'A', { end: 4 })])
    expect(pruneHistory(undo, [], undo[0].after, deepFreeze(JSON.parse(JSON.stringify(undo[0].after))))).toBeNull()
  })
})
