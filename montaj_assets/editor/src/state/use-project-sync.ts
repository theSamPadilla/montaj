/**
 * editor-core / state / use-project-sync — the shape-agnostic save/undo core.
 *
 * Extracted from `use-project-state.ts` so both editors (carousel + video) can
 * share one save model. This hook knows NOTHING about slides, elements, or the
 * typed action vocabulary — it operates over opaque project values `P` and
 * function-shaped mutations `(p: P) => P`. Everything shape-specific (the typed
 * `Action` union, `projectReducer`, edit-gating) stays in the layer above.
 *
 * Mechanics carried over verbatim from `use-project-state.ts`:
 *   - mutation-queue serialisation (`createMutationQueue`)
 *   - SSE subscribe + deferral: hold echoes while a save is in flight, then
 *     apply only the most recent one on drain (last-write-wins)
 *   - optimistic apply with rollback-on-save-failure
 *   - undo/redo snapshot stacks capped at MAX_HISTORY=50
 *   - `projectRef` same-tick mirror so a caller reading it immediately after a
 *     mutation sees post-mutation state without waiting for a re-render
 *
 * The only shape-aware seam is the optional `reconcile` option: how an external
 * frame (SSE / refetch / `applyExternal`) is folded into current state. It
 * defaults to a plain replace; the carousel layer passes its reference-
 * preserving structural merge so echoes don't churn the canvas. The core never
 * looks inside `P` to do this — it just calls the supplied function.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createMutationQueue } from './mutation-queue'
import { isSyncPull, pruneHistory, type HistoryEntry } from './history-prune'
import type { Project, EditorAdapter, FrameInfo, FrameWriter, HistoryPruned } from '../types'

// Connection lifecycle: 'connecting' from mount until the first frame arrives,
// then 'live'. The adapter's subscribe auto-reconnects on drop — the editor
// stays 'live' and simply receives the next frame when it comes.
export type Connection = 'connecting' | 'live'

export interface UseProjectSyncOptions<P extends Project> {
  /**
   * Fold an external (server-authored) frame into current state. Receives the
   * current project and the incoming frame; returns the state to apply. Used by
   * the SSE path, `refetch`, and `applyExternal`. Defaults to a plain replace
   * (`(_prev, next) => next`). Hosts that want reference-preserving merges pass
   * one here — it must be a pure function of its two arguments.
   */
  reconcile?: (prev: P, next: P) => P
  /**
   * Called on every local user edit: `mutate`, a `commit` that closes a
   * gesture which actually changed something, and an `undo`/`redo` that popped
   * a snapshot. Never for `mutateTransient`, `discardTransient`,
   * `applyExternal`, `refetch` or SSE frames, so a host can tell its own
   * user's edits from server-authored writes. Fired after the optimistic
   * apply, before the save resolves. Read through a ref: identity changes are
   * harmless and never re-create the returned callbacks.
   */
  onLocalEdit?: () => void
  /**
   * Whether a subscribed frame, by the writer the adapter reported with it,
   * prunes the undo and redo history (see `history-prune`). Called once per
   * frame, with `undefined` when the frame came with no writer. Defaults to a
   * Studio sync pull: writer `tool`, origin `sync`. `applyExternal` never
   * prunes. Read through a ref.
   */
  prunesHistory?: (writer?: FrameWriter) => boolean
  /**
   * The host says this project is synced (a Studio project another person can
   * pull into). Then a frame the adapter marks `info.gap` (the first after a
   * reconnect) and every `refetch` also prune, whatever `prunesHistory` says:
   * either may hold a pull whose stamp went to no listener. Only a change from
   * what the editor holds prunes anything, so an identical one leaves the
   * history as it was. Absent or false: both apply as any unstamped frame, with
   * no pruning. Read through a ref, so it may change while mounted.
   */
  syncedProject?: boolean
  /**
   * Called once per pruning frame that dropped at least one step, with how
   * many it dropped from each stack. No UI of its own: a host that wants a
   * notice draws it here. Read through a ref.
   */
  onHistoryPruned?: (info: HistoryPruned) => void
  /**
   * Called when the editor goes busy or idle: busy is a save in flight or a
   * gesture open (a preview not yet committed or cancelled). Fires on
   * transitions only, so never with a repeated value and never on mount with
   * false; a gesture that starts during a save keeps it busy until both end.
   * Not called after unmount (no final false). Read through a ref; absent, the
   * hook does nothing extra.
   */
  onBusyChange?: (busy: boolean) => void
}

export interface UseProjectSync<P extends Project = Project> {
  project: P
  connection: Connection
  /** pushUndo + optimistic apply + queued save + rollback-on-failure. */
  mutate: (fn: (p: P) => P) => Promise<void>
  /** Local-only apply (gesture previews) — no save, no undo push. */
  mutateTransient: (fn: (p: P) => P) => void
  /** One queued save for the accumulated transient state; one undo step. */
  commit: () => Promise<void>
  /** Abandon an in-progress transient gesture — no save, no undo push. */
  discardTransient: () => void
  /** Apply server-authored state — no save, no undo push (e.g. caption regen). */
  applyExternal: (p: P) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  refetch: () => Promise<void>
  lastError: string | null
  clearError: () => void
  projectRef: RefObject<P>
}

// The host's save is a top-level shallow merge: a key the body omits is KEPT on
// disk, and only an explicit `null` deletes it. So a write that takes a key away
// has to say so, but ONLY for the keys the edit being written took away. A key
// is present when its value is not `undefined`; an explicit `null` (the note
// and marker models' "last one removed") is present and travels as itself.
//
// Never derive those keys by comparing the restored project with CURRENT
// state: current holds whatever the host pushed since (SSE, `applyExternal`),
// which the undo history never saw, and nulling a key the host added (the
// project's first `assets`, say) deletes it on disk.
type Keyed = Record<string, unknown>

/** Top-level keys present in `to` and absent in `from`. */
function keysAdded(from: Project, to: Project): string[] {
  return Object.keys(to).filter(
    (k) => (to as Keyed)[k] !== undefined && (from as Keyed)[k] === undefined,
  )
}

/** The save body: `project`, with each of `keys` it lacks sent as `null`. Any
 *  other key is untouched; with nothing to clear, `project` itself. */
function withKeysNulled<P extends Project>(project: P, keys: readonly string[]): P {
  let body: Keyed | null = null
  for (const key of keys) {
    if ((project as Keyed)[key] !== undefined) continue
    if (!body) body = { ...project }
    body[key] = null
  }
  return (body ?? project) as P
}

// One undo/redo step: `HistoryEntry` in `history-prune`, which also rebuilds
// the steps a sync pull leaves standing.

/** Top-level keys whose value differs between `a` and `b` (added, removed, or a
 *  different reference). An `undefined` value counts as absent. */
function changedKeys(a: Project, b: Project): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of [...Object.keys(a), ...Object.keys(b)]) {
    if (seen.has(k)) continue
    seen.add(k)
    if ((a as Keyed)[k] !== (b as Keyed)[k]) out.push(k)
  }
  return out
}

/** `current` with each of `keys` set to its value in `source`; a key `source`
 *  lacks is removed. Also returns the removed keys (to be sent as null). */
function restoreKeys<P extends Project>(
  current: P,
  source: P,
  keys: readonly string[],
): { next: P; cleared: string[] } {
  const next: Keyed = { ...current }
  const cleared: string[] = []
  for (const k of keys) {
    const v = (source as Keyed)[k]
    if (v === undefined) {
      delete next[k]
      cleared.push(k)
    } else {
      next[k] = v
    }
  }
  return { next: next as P, cleared }
}

export function useProjectSync<P extends Project = Project>(
  adapter: EditorAdapter<P>,
  projectId: string,
  initial: P,
  options?: UseProjectSyncOptions<P>,
): UseProjectSync<P> {
  // Replace-only reducer: every transition computes the next project value
  // externally and dispatches it. Keeps the core shape-agnostic (no typed
  // action vocabulary) while dodging useState's function-arg ambiguity.
  const [project, setProject] = useReducer((_prev: P, next: P) => next, initial)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [lastError, setLastError] = useState<string | null>(null)
  // Busy (a save in flight or a gesture open) is recomputed at every point
  // either can change, and reported only when it differs from the last report.
  const onBusyChangeRef = useRef(options?.onBusyChange)
  onBusyChangeRef.current = options?.onBusyChange
  const reportedBusy = useRef(false)
  const mounted = useRef(true)
  const checkBusyRef = useRef<() => void>(() => {})
  const queue = useRef(createMutationQueue(() => checkBusyRef.current()))

  // Snapshot taken before the first transient mutation in the current gesture.
  // Reset to null after a successful commit or a non-transient mutation.
  const transientBaseline = useRef<P | null>(null)

  const checkBusy = useCallback(() => {
    const cb = onBusyChangeRef.current
    if (!cb || !mounted.current) return
    const busy = queue.current.isPending() || transientBaseline.current !== null
    if (busy === reportedBusy.current) return
    reportedBusy.current = busy
    // A host's throw must never break the save, gesture or undo that called
    // this: log it and carry on.
    try {
      cb(busy)
    } catch (err) {
      console.warn('[useProjectSync] onBusyChange threw', err)
    }
  }, [])
  checkBusyRef.current = checkBusy
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // True when an external frame cleared the baseline of a gesture in progress:
  // the pre-gesture document is gone, so the next commit() cannot say what the
  // gesture changed and passes `before: undefined`. Reset when a new gesture
  // starts and after every commit. A commit with no transient changes at all is
  // different: nothing changed, so it passes the current project as `before`.
  const baselineLost = useRef(false)

  // Synchronously-updated mirror of reducer state. Written in the render phase
  // (below) AND inside every mutation path after computing `next`. The same-tick
  // writes are critical: a caller (e.g. `commit()` invoked immediately after a
  // transient move from a gesture's onCommit handler) reads this ref to get
  // post-dispatch state without waiting for a re-render.
  const projectRef = useRef<P>(project)
  projectRef.current = project

  // `reconcile` stashed in a ref so the subscribe effect and apply path stay
  // referentially stable regardless of whether the host memoises the option.
  const reconcileRef = useRef(options?.reconcile)
  reconcileRef.current = options?.reconcile

  // `onLocalEdit` likewise, so the user-edit paths stay referentially stable.
  const onLocalEditRef = useRef(options?.onLocalEdit)
  onLocalEditRef.current = options?.onLocalEdit

  // The pruning trigger and report, likewise.
  const prunesHistoryRef = useRef(options?.prunesHistory ?? isSyncPull)
  prunesHistoryRef.current = options?.prunesHistory ?? isSyncPull
  const onHistoryPrunedRef = useRef(options?.onHistoryPruned)
  onHistoryPrunedRef.current = options?.onHistoryPruned
  const syncedProjectRef = useRef(options?.syncedProject === true)
  syncedProjectRef.current = options?.syncedProject === true

  // Subscribed frames held while saves are in flight, oldest first, each with
  // whether it prunes (a sync pull, or a gap frame in a synced project) and the
  // project it came for. Held because an echo for an earlier save can arrive
  // while a later save is still mid-flight: applying it would regress the
  // optimistic state to the older value (visible as jitter on the canvas while
  // the operator is typing). On the drain they are applied in order, each
  // pruning frame pruning as it would have live, so the history is the one the
  // same frames give with no save in flight: a frame on top of a pull (an AI
  // write, the watcher's copy, an adapter's refetch) prunes nothing of its own,
  // and a later pull is measured from a screen that holds the frames before it.
  // A run of frames that do not prune keeps only its last, since applied one
  // after another they touch no history and leave the last one's content. A
  // drain reports what it dropped once.
  const heldRef = useRef<Array<{ frame: P; prunes: boolean; projectId: string }>>([])
  // Whether the subscribe effect has subscribed before: every later
  // subscription's first frame is treated as a gap frame.
  const subscribedRef = useRef(false)

  // Fold an external frame into current state (reconcile, or plain replace) and
  // apply it. No save, no undo push. Stable — reads reconcile via ref.
  //
  // Clears transientBaseline: an external frame invalidates any in-progress
  // gesture's pre-gesture snapshot (it predates this frame), so a subsequent
  // commit() must not roll back to it and undo() must not resurrect it. Without
  // this, a stale baseline can silently swallow an external change on undo —
  // see the regression test for the full sequence.
  const applyExternal = useCallback((incoming: P) => {
    const base = projectRef.current
    const reconcile = reconcileRef.current
    const next = reconcile ? reconcile(base, incoming) : incoming
    projectRef.current = next
    if (transientBaseline.current !== null) baselineLost.current = true
    transientBaseline.current = null
    setProject(next)
    checkBusy()
  }, [checkBusy])

  // Undo/redo: snapshot-based stacks of full project state. Each committed local
  // mutation pushes the pre-mutation snapshot (with the keys that mutation added
  // and removed) to undoStack and clears redoStack. undo() pops undo→redo;
  // redo() pops redo→undo. External frames do NOT touch the stacks, except a
  // subscribed frame `prunesHistory` marks (a sync pull): see `applyFrame`.
  const MAX_HISTORY = 50
  const undoStackRef = useRef<HistoryEntry<P>[]>([])
  const redoStackRef = useRef<HistoryEntry<P>[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), [])
  // Record an edit from `before` to `after`: one undo step restoring `before`.
  const pushUndo = useCallback((before: P, after: P) => {
    undoStackRef.current.push({ before, after, keys: changedKeys(before, after) })
    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
    redoStackRef.current = []
    bumpHistory()
  }, [bumpHistory])

  // Apply subscribed frames in order. A pruning frame (a sync pull) also drops
  // the undo and redo steps that changed what it changed and rebases the rest
  // onto it (`history-prune`). Each pull's change is measured from the document
  // the history knows when it applies: an open gesture's baseline, not its
  // unsaved preview. What the frames dropped is reported once.
  //
  // Known cost, not fixed (finding 7): a frame is serve's JSON as written, the
  // screen may be a normalised form of it (a host `reconcile`, fields the
  // editor fills in on load). A difference that is only normalisation counts as
  // a change, so steps on that unit are dropped. Undo steps, never content.
  const applyFrames = useCallback((frames: ReadonlyArray<{ frame: P; prunes: boolean }>) => {
    let undo = 0
    let redo = 0
    for (const { frame, prunes } of frames) {
      const known = transientBaseline.current ?? projectRef.current
      applyExternal(frame)
      if (!prunes) continue
      const pruned = pruneHistory(undoStackRef.current, redoStackRef.current, known, projectRef.current)
      if (!pruned) continue
      undoStackRef.current = pruned.undo
      redoStackRef.current = pruned.redo
      undo += pruned.dropped.undo
      redo += pruned.dropped.redo
    }
    if (undo + redo === 0) return
    bumpHistory()
    onHistoryPrunedRef.current?.({ undo, redo })
  }, [applyExternal, bumpHistory])
  const applyFrame = useCallback(
    (frame: P, prunes: boolean) => applyFrames([{ frame, prunes }]),
    [applyFrames],
  )

  // Subscription lifecycle. The adapter owns the transport (SSE, websocket,
  // poll); we just receive fresh frames and reconcile them. `applyFrame` is
  // stable so this only re-subscribes on adapter/projectId change.
  useEffect(() => {
    setConnection('connecting')
    let active = true
    // Apply what was held, once the queue drains. A replaced subscription's
    // drain does nothing; this one takes its place below.
    //
    // Known costs, not fixed (§482 review item 3, re-check finding 2): a held
    // pull can predate a save of the editor's own, in flight when it was held
    // or made while it was, whose echo comes later; and a reconnect while a
    // save is in flight gives a gap frame read before that save landed. Either
    // frame is measured from the screen when it applies, so it seems to have
    // changed what that save changed, and the save's undo step is dropped too.
    // One undo step lost, never content.
    const drain = () => {
      if (!active) return
      const frames = heldRef.current
      heldRef.current = []
      applyFrames(frames)
    }
    // Frames held for another project never apply here. Ones held for this
    // project by the subscription this one replaced (a host that re-created its
    // adapter) still apply, on this subscription's drain: dropping them would
    // leave the screen without a write until the next frame.
    heldRef.current = heldRef.current.filter((h) => h.projectId === projectId)
    if (heldRef.current.length > 0) queue.current.onceDrained(drain)
    // Every subscription after the first may have missed frames while it was
    // replaced, and a pooled transport sends no fresh state to a new listener:
    // its first frame is a gap frame.
    let firstIsGap = subscribedRef.current
    subscribedRef.current = true
    const unsubscribe = adapter.subscribe(projectId, (next, writer, info?: FrameInfo) => {
      if (!active) return
      setConnection('live')
      const gap = info?.gap === true || firstIsGap
      firstIsGap = false
      // In a synced project a gap frame prunes like a pull. Its writer is still
      // the one it came with (usually none): the predicate and everything else
      // see that.
      const prunes = prunesHistoryRef.current(writer) || (gap && syncedProjectRef.current)
      if (queue.current.isPending()) {
        // Hold the frame; apply it once the queue drains.
        const held = heldRef.current
        const last = held[held.length - 1]
        if (last && !last.prunes && !prunes) held.pop()
        held.push({ frame: next, prunes, projectId })
        queue.current.onceDrained(drain)
        return
      }
      applyFrame(next, prunes)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [adapter, projectId, applyFrame, applyFrames])

  // Internal: persist the full project via the adapter; rollback on failure.
  // `before` is the document as it was before the edit being written (undefined
  // when unknown, e.g. a gesture whose baseline an external frame cleared).
  // `clear` names the top-level keys this write took away (see withKeysNulled):
  // the ones a plain edit removed, or the ones an undo/redo step's own edit
  // added/removed. Nothing else is ever sent as null.
  const save = useCallback(
    async (next: P, snapshot: P, clear: readonly string[], before: P | undefined) => {
      try {
        // `before` is always passed (explicitly undefined when the core cannot
        // say), so a host can tell "no baseline" from an older core.
        await adapter.saveProject(projectId, withKeysNulled(next, clear), before)
      } catch (err) {
        projectRef.current = snapshot
        setProject(snapshot)
        throw err instanceof Error ? err : new Error(String(err))
      }
    },
    [adapter, projectId],
  )

  // Snapshot, optimistically apply, and enqueue the save. `next` is computed
  // synchronously from the live ref (not the `project` closure) so a sequence of
  // mutate calls in the same tick chains correctly (call N's next becomes call
  // N+1's base) and the save body carries the correct shape without a re-render.
  const mutate = useCallback(
    (fn: (p: P) => P): Promise<void> => {
      // An open gesture is part of this edit: its pre-gesture document is the
      // baseline, so the preview is saved and undone with it, not discarded.
      const base = transientBaseline.current ?? projectRef.current
      const next = fn(projectRef.current)
      pushUndo(base, next)
      projectRef.current = next
      setProject(next)
      // Non-transient mutations reset the baseline so any subsequent gesture
      // starts from the freshly committed state.
      transientBaseline.current = null
      baselineLost.current = false
      onLocalEditRef.current?.()
      const removed = keysAdded(next, base)
      return queue.current.enqueue(() =>
        save(next, base, removed, base).catch((err) => {
          setLastError(err instanceof Error ? err.message : String(err))
          throw err
        }),
      )
    },
    [save, pushUndo],
  )

  // Local-only apply — no save, no queue. Records the pre-gesture baseline on the
  // first call so commit() can roll back to it on failure.
  const mutateTransient = useCallback((fn: (p: P) => P): void => {
    const base = projectRef.current
    if (transientBaseline.current === null) {
      transientBaseline.current = base
      baselineLost.current = false
    }
    const next = fn(base)
    projectRef.current = next
    setProject(next)
    checkBusy()
  }, [checkBusy])

  // commit() — enqueues ONE save with the current (post-gesture) state. On
  // failure, rolls back to the pre-gesture baseline. One undo step per gesture:
  // only push the baseline if the gesture actually produced transient changes.
  const commit = useCallback((): Promise<void> => {
    const current = projectRef.current
    const baseline = transientBaseline.current
    transientBaseline.current = null
    const lost = baselineLost.current
    baselineLost.current = false
    if (baseline !== null) {
      pushUndo(baseline, current)
      onLocalEditRef.current?.()
    }
    const rollbackTo = baseline ?? current
    const removed = baseline !== null ? keysAdded(current, baseline) : []
    return queue.current.enqueue(() =>
      save(current, rollbackTo, removed, baseline ?? (lost ? undefined : current)).catch((err) => {
        setLastError(err instanceof Error ? err.message : String(err))
        throw err
      }),
    )
  }, [save, pushUndo])

  // Abandon an in-progress transient gesture: restore projectRef/state to the
  // pre-gesture baseline and clear it. No save, no undo push. A no-op when no
  // transient baseline is set. Exists so callers don't have to reproduce this
  // themselves via `mutateTransient(() => baseline)`, which would restore the
  // state but leave `transientBaseline` set — corrupting the NEXT unrelated
  // commit() into pushing a stale baseline for a gesture that never happened.
  const discardTransient = useCallback((): void => {
    const baseline = transientBaseline.current
    if (baseline === null) {
      baselineLost.current = false
      return
    }
    transientBaseline.current = null
    baselineLost.current = false
    projectRef.current = baseline
    setProject(baseline)
    checkBusy()
  }, [checkBusy])

  // undo()/redo(): restore the keys the step's edit changed, on top of the
  // current project (see HistoryEntry), and enqueue a save so the host persists
  // it. The entry moves between the stacks. Also clears transientBaseline and
  // baselineLost: the state changes under any in-progress gesture, so its
  // pre-gesture snapshot is stale and must not be resurrected by a later
  // commit()/undo() (see applyExternal).
  const undo = useCallback((): void => {
    const entry = undoStackRef.current.pop()
    if (!entry) return
    const current = projectRef.current
    const { next, cleared } = restoreKeys(current, entry.before, entry.keys)
    redoStackRef.current.push(entry)
    if (redoStackRef.current.length > MAX_HISTORY) redoStackRef.current.shift()
    bumpHistory()
    projectRef.current = next
    transientBaseline.current = null
    baselineLost.current = false
    setProject(next)
    onLocalEditRef.current?.()
    void queue.current.enqueue(() =>
      save(next, current, cleared, current).catch((err) => {
        setLastError(err instanceof Error ? err.message : String(err))
        throw err
      }),
    )
  }, [save, bumpHistory])

  const redo = useCallback((): void => {
    const entry = redoStackRef.current.pop()
    if (!entry) return
    const current = projectRef.current
    const { next, cleared } = restoreKeys(current, entry.after, entry.keys)
    undoStackRef.current.push(entry)
    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
    bumpHistory()
    projectRef.current = next
    transientBaseline.current = null
    baselineLost.current = false
    setProject(next)
    onLocalEditRef.current?.()
    void queue.current.enqueue(() =>
      save(next, current, cleared, current).catch((err) => {
        setLastError(err instanceof Error ? err.message : String(err))
        throw err
      }),
    )
  }, [save, bumpHistory])

  const canUndo = undoStackRef.current.length > 0
  const canRedo = redoStackRef.current.length > 0
  // Touch historyVersion so dependent components re-render when the stacks
  // change. Without this, canUndo/canRedo would be evaluated on stale renders.
  void historyVersion

  const clearError = useCallback(() => setLastError(null), [])

  // Force a fresh load of the project via the adapter and reconcile it in.
  // Useful when local state has drifted from the server (e.g. after a gap).
  // That is the only reason to refetch, so in a synced project the read prunes
  // like a gap frame: a pull may be among what was missed. Identical content
  // prunes nothing. Not synced: applied with no pruning, as before.
  const refetch = useCallback(async () => {
    try {
      const next = await adapter.loadProject(projectId)
      applyFrame(next, syncedProjectRef.current)
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [adapter, projectId, applyFrame])

  return {
    project,
    connection,
    mutate,
    mutateTransient,
    commit,
    discardTransient,
    applyExternal,
    undo,
    redo,
    canUndo,
    canRedo,
    refetch,
    lastError,
    clearError,
    projectRef,
  }
}
