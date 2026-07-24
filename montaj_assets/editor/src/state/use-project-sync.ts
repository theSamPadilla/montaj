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
import type { Project, EditorAdapter } from '../types'

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
  const queue = useRef(createMutationQueue())

  // Snapshot taken before the first transient mutation in the current gesture.
  // Reset to null after a successful commit or a non-transient mutation.
  const transientBaseline = useRef<P | null>(null)

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

  // Latest deferred external frame. Held while saves are in flight because an
  // echo for an earlier save can arrive while a later save is still mid-flight —
  // applying it would regress the optimistic state to the older value (visible
  // as jitter on the canvas while the operator is typing). Last-write-wins:
  // only the most recent frame is kept.
  const deferredSseRef = useRef<P | null>(null)

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
    transientBaseline.current = null
    setProject(next)
  }, [])

  // Undo/redo: snapshot-based stacks of full project state. Each committed local
  // mutation pushes the pre-mutation snapshot to undoStack and clears redoStack.
  // undo() pops undo→redo; redo() pops redo→undo. External frames do NOT touch
  // the stacks — server changes stay opaque to local history.
  const MAX_HISTORY = 50
  const undoStackRef = useRef<P[]>([])
  const redoStackRef = useRef<P[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), [])
  const pushUndo = useCallback((snapshot: P) => {
    undoStackRef.current.push(snapshot)
    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
    redoStackRef.current = []
    bumpHistory()
  }, [bumpHistory])

  // Subscription lifecycle. The adapter owns the transport (SSE, websocket,
  // poll); we just receive fresh frames and reconcile them. `applyExternal` is
  // stable so this only re-subscribes on adapter/projectId change.
  useEffect(() => {
    setConnection('connecting')
    let active = true
    const unsubscribe = adapter.subscribe(projectId, (next) => {
      if (!active) return
      setConnection('live')
      if (queue.current.isPending()) {
        // Hold the frame; apply it once the queue drains.
        deferredSseRef.current = next
        queue.current.onceDrained(() => {
          const held = deferredSseRef.current
          deferredSseRef.current = null
          if (held) applyExternal(held)
        })
        return
      }
      applyExternal(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [adapter, projectId, applyExternal])

  // Internal: persist the full project via the adapter; rollback on failure.
  const save = useCallback(
    async (next: P, snapshot: P) => {
      try {
        await adapter.saveProject(projectId, next)
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
      const base = projectRef.current
      const snapshot = base
      pushUndo(snapshot)
      const next = fn(base)
      projectRef.current = next
      setProject(next)
      // Non-transient mutations reset the baseline so any subsequent gesture
      // starts from the freshly committed state.
      transientBaseline.current = null
      return queue.current.enqueue(() =>
        save(next, snapshot).catch((err) => {
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
    }
    const next = fn(base)
    projectRef.current = next
    setProject(next)
  }, [])

  // commit() — enqueues ONE save with the current (post-gesture) state. On
  // failure, rolls back to the pre-gesture baseline. One undo step per gesture:
  // only push the baseline if the gesture actually produced transient changes.
  const commit = useCallback((): Promise<void> => {
    const current = projectRef.current
    const baseline = transientBaseline.current
    transientBaseline.current = null
    if (baseline !== null) pushUndo(baseline)
    const rollbackTo = baseline ?? current
    return queue.current.enqueue(() =>
      save(current, rollbackTo).catch((err) => {
        setLastError(err instanceof Error ? err.message : String(err))
        throw err
      }),
    )
  }, [save, pushUndo])

  // undo()/redo() — snapshot swap. Pops the target stack, pushes current state
  // to the opposite stack, replaces the entire state, and enqueues a save so the
  // host persists the swap. Also clears transientBaseline: it replaces state
  // wholesale, so any in-progress gesture's pre-gesture snapshot is stale after
  // this and must not be resurrected by a later commit()/undo() (see applyExternal).
  const undo = useCallback((): void => {
    const prev = undoStackRef.current.pop()
    if (!prev) return
    const current = projectRef.current
    redoStackRef.current.push(current)
    if (redoStackRef.current.length > MAX_HISTORY) redoStackRef.current.shift()
    bumpHistory()
    projectRef.current = prev
    transientBaseline.current = null
    setProject(prev)
    void queue.current.enqueue(() =>
      save(prev, current).catch((err) => {
        setLastError(err instanceof Error ? err.message : String(err))
        throw err
      }),
    )
  }, [save, bumpHistory])

  const redo = useCallback((): void => {
    const next = redoStackRef.current.pop()
    if (!next) return
    const current = projectRef.current
    undoStackRef.current.push(current)
    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
    bumpHistory()
    projectRef.current = next
    transientBaseline.current = null
    setProject(next)
    void queue.current.enqueue(() =>
      save(next, current).catch((err) => {
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
  const refetch = useCallback(async () => {
    try {
      const next = await adapter.loadProject(projectId)
      applyExternal(next)
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [adapter, projectId, applyExternal])

  return {
    project,
    connection,
    mutate,
    mutateTransient,
    commit,
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
