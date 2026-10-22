/**
 * editor-core / state / history-prune: what a sync pull does to undo and redo.
 *
 * An undo or redo step restores whole top-level fields from snapshots taken
 * before the pull (all of `tracks`, say), so taking it after a teammate's pull
 * would put the pre-pull values back. When the host marks a reloaded frame as a
 * sync pull, the history is pruned instead. Editor saves stay advisory: nothing
 * here refuses a save, it only decides which steps remain and what they hold.
 *
 *   - Units. Documents are compared in units: each top-level field is one unit,
 *     except `tracks`, which splits into the track order, each track's own
 *     fields, each track's item list, and each item by id. A `tracks` value that
 *     does not split (not an array of `{ id, items: [{ id }] }` with unique ids)
 *     is one unit, which overlaps every `tracks` unit.
 *   - Drop. A step whose edit changed a unit the pull changed is dropped.
 *   - Cascade. Each stack is walked from the step nearest the present outwards;
 *     a step that changed a unit a dropped step changed is dropped too, so no
 *     step undoes (or redoes) half of a dropped edit.
 *   - Rebase. Every kept step is rebuilt on the reloaded document, in order: its
 *     `before` (undo) or `after` (redo) is the next state along the chain with
 *     only the step's own units taken from its snapshot. So undoing a kept step
 *     changes what that step changed and nothing the pull changed.
 *   - Unknown state. A kept step whose rebuilt snapshot would need a value that
 *     neither the step nor the rebuilt document holds cannot be rebuilt without
 *     guessing: an item list the step restores names a clip the step never
 *     changed and the document no longer has, or the document holds a clip or
 *     track that no restored list names (a frame outside the history removed or
 *     added it). That step is dropped, and cascades, like a conflicting one: the
 *     undo or redo that would have crossed it refuses.
 *
 * Pure: the reloaded document and the old snapshots are only read, and every
 * rebuilt snapshot is a new object.
 */
import { deepEqual } from './deep-equal'
import type { FrameWriter, HistoryPruned, Project } from '../types'

// One undo/redo step. `before` and `after` are the project either side of the
// EDIT this step belongs to; `keys` are the top-level keys that edit changed
// (by reference, plus added and removed), fixed when the edit was made. Undo
// restores only those keys from `before`, redo only those from `after`, each on
// top of a copy of the CURRENT project, so a field another writer changed since
// (an AI save, an external frame, a later edit that failed and rolled back) is
// never reverted. A restored key the source lacks is deleted, and travels in
// the save body as `null` so the host drops it.
export interface HistoryEntry<P> {
  before: P
  after: P
  keys: string[]
}

/** The default trigger: a frame written by a `tool` with origin `sync`. */
export function isSyncPull(writer?: FrameWriter): boolean {
  return writer?.writer === 'tool' && writer.origin === 'sync'
}

type Keyed = Record<string, unknown>
type Units = Map<string, unknown>

const TRACKS = 'tracks'
const SUB = `${TRACKS}\u0000`
const ORDER = `${SUB}order`
const trackKey = (id: string) => `${SUB}track\u0000${id}`
const listKey = (id: string) => `${SUB}items\u0000${id}`
const itemKey = (id: string) => `${SUB}item\u0000${id}`

function isRecord(v: unknown): v is Keyed {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `tracks` as units, or null when it does not split. A track's own fields are
 *  the track with `items` set to undefined (absent to `deepEqual`, and it keeps
 *  the key's place when the track is rebuilt). */
function splitTracks(tracks: unknown): Units | null {
  if (!Array.isArray(tracks)) return null
  const units: Units = new Map()
  const order: string[] = []
  for (const track of tracks) {
    if (!isRecord(track) || typeof track.id !== 'string' || !Array.isArray(track.items)) return null
    if (units.has(trackKey(track.id))) return null
    order.push(track.id)
    units.set(trackKey(track.id), { ...track, items: undefined })
    const ids: string[] = []
    for (const item of track.items) {
      if (!isRecord(item) || typeof item.id !== 'string') return null
      if (units.has(itemKey(item.id))) return null
      units.set(itemKey(item.id), item)
      ids.push(item.id)
    }
    units.set(listKey(track.id), ids)
  }
  units.set(ORDER, order)
  return units
}

type Splitter = (tracks: unknown) => Units | null

/** `splitTracks`, memoised on the array for one pruning (consecutive steps
 *  share snapshots). */
function splitter(): Splitter {
  const memo = new WeakMap<object, Units | null>()
  return (tracks) => {
    if (typeof tracks !== 'object' || tracks === null) return splitTracks(tracks)
    if (!memo.has(tracks)) memo.set(tracks, splitTracks(tracks))
    return memo.get(tracks) ?? null
  }
}

/** The units that differ between `a` and `b`, over the top-level `keys`. */
function changedUnits(a: Project, b: Project, keys: Iterable<string>, split: Splitter): Set<string> {
  const out = new Set<string>()
  for (const key of keys) {
    const av = (a as Keyed)[key]
    const bv = (b as Keyed)[key]
    if (av === bv) continue
    if (key === TRACKS) {
      const as = split(av)
      const bs = split(bv)
      if (as && bs) {
        for (const unit of new Set([...as.keys(), ...bs.keys()])) {
          if (!deepEqual(as.get(unit), bs.get(unit))) out.add(unit)
        }
        continue
      }
    }
    if (!deepEqual(av, bv)) out.add(key)
  }
  return out
}

function overlaps(units: Set<string>, seen: Set<string>): boolean {
  for (const unit of units) {
    if (seen.has(unit)) return true
    if (unit.startsWith(SUB) && seen.has(TRACKS)) return true
    if (unit === TRACKS && [...seen].some((u) => u.startsWith(SUB))) return true
  }
  return false
}

/** Tracks from `units`, reusing each track of `current` that comes out the same;
 *  null when the units do not make one consistent value (see Unknown state). */
function joinTracks(units: Units, currentUnits: Units, current: readonly Keyed[]): Keyed[] | null {
  const order = units.get(ORDER) as string[] | undefined
  if (!order) return null
  const byId = new Map(current.map((t) => [t.id as string, t]))
  const used = new Set<string>([ORDER])
  const out: Keyed[] = []
  for (const id of order) {
    const fields = units.get(trackKey(id)) as Keyed | undefined
    const ids = units.get(listKey(id)) as string[] | undefined
    if (!fields || !ids) return null
    used.add(trackKey(id))
    used.add(listKey(id))
    const items: unknown[] = []
    for (const itemId of ids) {
      const item = units.get(itemKey(itemId))
      if (item === undefined || used.has(itemKey(itemId))) return null
      used.add(itemKey(itemId))
      items.push(item)
    }
    const prev = byId.get(id)
    const prevItems = prev?.items as unknown[] | undefined
    const same = prev !== undefined && prevItems !== undefined && fields === currentUnits.get(trackKey(id))
      && items.length === prevItems.length && items.every((item, i) => item === prevItems[i])
    out.push(same ? prev : { ...fields, items })
  }
  // A clip or track nothing above named: dropping it would be a guess too.
  return used.size === units.size ? out : null
}

/** `state` with `units` taken from `source`; null when that cannot be built
 *  without guessing. */
function rebuild<P extends Project>(state: P, source: P, units: Set<string>, split: Splitter): P | null {
  const next: Keyed = { ...state }
  const trackUnits: string[] = []
  for (const unit of units) {
    if (unit.startsWith(SUB)) {
      trackUnits.push(unit)
      continue
    }
    const value = (source as Keyed)[unit]
    if (value === undefined) delete next[unit]
    else next[unit] = value
  }
  if (trackUnits.length > 0) {
    const currentTracks = (state as Keyed)[TRACKS]
    const current = split(currentTracks)
    const from = split((source as Keyed)[TRACKS])
    if (!current || !from) return null
    const merged: Units = new Map(current)
    for (const unit of trackUnits) {
      const value = from.get(unit)
      if (value === undefined) merged.delete(unit)
      else merged.set(unit, value)
    }
    const tracks = joinTracks(merged, current, currentTracks as Keyed[])
    if (!tracks) return null
    next[TRACKS] = tracks
  }
  return next as P
}

function walk<P extends Project>(
  stack: readonly HistoryEntry<P>[],
  pulled: Set<string>,
  reloaded: P,
  direction: 'undo' | 'redo',
  split: Splitter,
): { kept: HistoryEntry<P>[]; dropped: number } {
  const changed = new Set(pulled)
  const kept: HistoryEntry<P>[] = []
  let dropped = 0
  let state = reloaded
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i]
    const units = changedUnits(entry.before, entry.after, entry.keys, split)
    const source = direction === 'undo' ? entry.before : entry.after
    const rebuilt = overlaps(units, changed) ? null : rebuild(state, source, units, split)
    if (rebuilt === null) {
      dropped++
      for (const unit of units) changed.add(unit)
      continue
    }
    kept.push(direction === 'undo'
      ? { before: rebuilt, after: state, keys: entry.keys }
      : { before: state, after: rebuilt, keys: entry.keys })
    state = rebuilt
  }
  return { kept: kept.reverse(), dropped }
}

/**
 * Prune and rebase both stacks (bottom first, top last, as the hook holds them)
 * for a sync pull that turned `known` (the document the history knew) into
 * `reloaded`. Null when the pull changed nothing, so the history stays as it is.
 */
export function pruneHistory<P extends Project>(
  undo: readonly HistoryEntry<P>[],
  redo: readonly HistoryEntry<P>[],
  known: P,
  reloaded: P,
): { undo: HistoryEntry<P>[]; redo: HistoryEntry<P>[]; dropped: HistoryPruned } | null {
  const split = splitter()
  const keys = new Set([...Object.keys(known), ...Object.keys(reloaded)])
  const pulled = changedUnits(known, reloaded, keys, split)
  if (pulled.size === 0) return null
  const u = walk(undo, pulled, reloaded, 'undo', split)
  const r = walk(redo, pulled, reloaded, 'redo', split)
  return { undo: u.kept, redo: r.kept, dropped: { undo: u.dropped, redo: r.dropped } }
}
