/**
 * editor-core / state / use-project-state — optimistic, host-agnostic project
 * state with undo/redo and SSE reconciliation.
 *
 * Ported from mission-control's
 * `src/app/admin/projects/hooks/use-project-state.ts`. The MC version hardcoded
 * `/api/hub/projects/:id/montaj` fetch + EventSource. Here, ALL transport goes
 * through the injected `EditorAdapter`:
 *   - persistence → `adapter.saveProject(id, project)`
 *   - live frames → `adapter.subscribe(id, onFrame)`
 *   - refetch     → `adapter.loadProject(id)`
 *
 * Everything else is preserved: optimistic mutations, the transient-vs-committed
 * distinction, mutation-queue serialisation, SSE deferral while a save is in
 * flight, rollback on save failure, and the MAX_HISTORY=50 undo/redo stacks.
 */
import { useEffect, useReducer, useRef, useState, useCallback } from 'react'
import { projectReducer, type Action, type ProjectStatus } from './project-reducer'
import { createMutationQueue } from './mutation-queue'
import type { Project, Slide, CarouselElement, EditorAdapter } from '../types'

// Connection lifecycle: 'connecting' from mount until the first SSE frame
// arrives, then 'live'. The adapter's subscribe auto-reconnects on drop —
// the editor stays 'live' and simply receives the next frame when it comes.
export type Connection = 'connecting' | 'live'

function isEditable(status: ProjectStatus): boolean {
  return status === 'draft' || status === 'final'
}

function findElementType(
  state: Project,
  slideId: string,
  elementId: string,
): 'overlay' | 'image' | null {
  const slide: Slide | undefined = state.slides?.find((s) => s.id === slideId)
  const el = slide?.elements.find((e) => e.id === elementId)
  return el?.type ?? null
}

export interface UseProjectState<P extends Project = Project> {
  project: P
  connection: Connection
  isEditingAllowed: boolean
  lastError: string | null
  clearError: () => void
  updateOverlayProp: (slideId: string, elementId: string, key: string, value: string) => Promise<void>
  updateImageCrop: (slideId: string, elementId: string, crop: { x: number; y: number; w: number; h: number } | undefined) => Promise<void>
  setStatus: (status: ProjectStatus) => Promise<void>
  setName: (name: string) => Promise<void>
  moveElement: (slideId: string, elementId: string, x: number, y: number) => Promise<void>
  resizeElement: (slideId: string, elementId: string, box: { x: number; y: number; w: number; h: number }) => Promise<void>
  rotateElement: (slideId: string, elementId: string, rotation: number) => Promise<void>
  addElement: (slideId: string, element: CarouselElement) => Promise<void>
  removeElement: (slideId: string, elementId: string) => Promise<void>
  duplicateElement: (slideId: string, elementId: string, newElement: CarouselElement) => Promise<void>
  reorderElement: (slideId: string, elementId: string, direction: 'forward' | 'backward') => Promise<void>
  addSlide: (slide: Slide, afterSlideId?: string) => Promise<void>
  removeSlide: (slideId: string) => Promise<void>
  duplicateSlide: (slideId: string, newSlide: Slide) => Promise<void>
  reorderSlides: (fromIndex: number, toIndex: number) => Promise<void>
  updateSlide: (slideId: string, patch: Partial<Slide>) => Promise<void>
  setOverlayFrame: (slideId: string, elementId: string, frame: number) => Promise<void>
  commit: () => Promise<void>
  refetch: () => Promise<void>
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function useProjectState<P extends Project = Project>(
  adapter: EditorAdapter<P>,
  projectId: string,
  initial: P,
): UseProjectState<P> {
  const [project, dispatch] = useReducer(
    projectReducer as (state: P, action: Action<P>) => P,
    initial,
  )
  const [connection, setConnection] = useState<Connection>('connecting')
  const [lastError, setLastError] = useState<string | null>(null)
  const queue = useRef(createMutationQueue())
  // Snapshot taken before the first transient mutation in the current gesture.
  // Reset to null after a successful commit or rollback.
  const transientBaseline = useRef<P | null>(null)
  // Synchronously-updated mirror of the reducer state. Written in three places:
  //   1. Render phase, from `project` (covers SSE, rollback, refetch — paths
  //      that go through dispatch directly without computing `next` here).
  //   2. Inside `mutate`, after computing `next` synchronously from the reducer.
  //   3. Inside `mutateTransient`, after computing `next` synchronously.
  // (2) and (3) are critical: a same-tick caller (e.g. `commit()` invoked
  // immediately after `moveElement` from the gesture's onCommit handler) reads
  // this ref to get the post-dispatch state without waiting for a re-render.
  // Without (2)/(3), the ref lags by one render and save bodies are stale.
  const projectRef = useRef<P>(project)
  projectRef.current = project

  // Latest deferred SSE payload. Held while there are in-flight saves because
  // SSE echoes for an earlier save can arrive while a later save is still
  // mid-flight — applying them would regress the optimistic state to the older
  // value (visible as jitter on the canvas while the operator is typing).
  // Last-write-wins: only the most recent SSE is kept.
  const deferredSseRef = useRef<P | null>(null)

  // Undo/redo: snapshot-based stacks of full project state. Each committed
  // local action pushes the pre-action snapshot to undoStack and clears the
  // redoStack. undo() pops undo→redo; redo() pops redo→undo. SSE updates do
  // NOT touch the stacks — external changes stay opaque to local history.
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
  // poll); we just receive fresh frames and reconcile them.
  useEffect(() => {
    setConnection('connecting')
    let active = true
    const unsubscribe = adapter.subscribe(projectId, (next) => {
      if (!active) return
      setConnection('live')
      if (queue.current.isPending()) {
        // Hold the frame; dispatch it once the queue drains.
        deferredSseRef.current = next
        queue.current.onceDrained(() => {
          const held = deferredSseRef.current
          deferredSseRef.current = null
          if (held) dispatch({ type: 'sse', project: held })
        })
        return
      }
      dispatch({ type: 'sse', project: next })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [adapter, projectId])

  // Internal: persist the full project via the adapter; rollback on failure.
  const save = useCallback(
    async (next: P, snapshot: P) => {
      try {
        await adapter.saveProject(projectId, next)
      } catch (err) {
        dispatch({ type: 'rollback', snapshot })
        throw err instanceof Error ? err : new Error(String(err))
      }
    },
    [adapter, projectId],
  )

  // Internal: snapshot, optimistically reduce, dispatch, and enqueue the save.
  // Gates on edit-allowed status and target-exists; silent no-ops are visible
  // via console.warn so the regen→slide-deleted race surfaces in the dev
  // console. `next` is computed synchronously via the same reducer so the save
  // gets the correct shape without waiting for a re-render.
  const mutate = useCallback(
    (action: Action<P>) => {
      // Read base state from the live ref, not the `project` closure, so a
      // sequence of mutate calls in the same event tick chain correctly
      // (call N's `next` becomes call N+1's base).
      const base = projectRef.current
      const editGated = new Set(['updateOverlayProp', 'updateImageCrop', 'setStatus', 'setName', 'moveElement', 'resizeElement', 'rotateElement', 'addElement', 'removeElement', 'addSlide', 'removeSlide', 'duplicateSlide', 'reorderSlides', 'updateSlide', 'duplicateElement', 'reorderElement', 'setOverlayFrame'])
      if (editGated.has(action.type) && !isEditable(base.status)) {
        console.warn(`[useProjectState] dropped ${action.type}: status="${base.status}" not editable`)
        return Promise.resolve()
      }
      if (action.type === 'updateOverlayProp' || action.type === 'updateImageCrop') {
        const found = findElementType(base, action.slideId, action.elementId)
        const expected = action.type === 'updateOverlayProp' ? 'overlay' : 'image'
        if (found !== expected) {
          console.warn(
            `[useProjectState] dropped ${action.type}: target ${action.slideId}/${action.elementId} ${found ? `is ${found}, expected ${expected}` : 'no longer exists'}`,
          )
          return Promise.resolve()
        }
      }
      const snapshot = base
      pushUndo(snapshot)
      const next = projectReducer(base, action)
      projectRef.current = next
      dispatch(action)
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

  // Internal: dispatch a transient (local-only) action — no save, no queue.
  // Records the pre-gesture baseline on the first call so commit() can roll
  // back to it on failure.
  const mutateTransient = useCallback(
    (action: Action<P>) => {
      const base = projectRef.current
      const editGated = new Set(['moveElement', 'resizeElement', 'rotateElement'])
      if (!editGated.has(action.type) || !isEditable(base.status)) {
        console.warn(`[useProjectState] dropped transient ${action.type}: status="${base.status}" not editable`)
        return
      }
      // Capture baseline before the first transient change in this gesture.
      if (transientBaseline.current === null) {
        transientBaseline.current = base
      }
      const next = projectReducer(base, action)
      projectRef.current = next
      dispatch(action)
    },
    [],
  )

  // commit() — enqueues ONE save with the current (post-drag) state.
  // On failure, rolls back to the pre-gesture baseline.
  const commit = useCallback((): Promise<void> => {
    const current = projectRef.current
    const baseline = transientBaseline.current
    transientBaseline.current = null
    // One undo step per gesture: only push the baseline if the gesture
    // actually produced transient changes (baseline was captured).
    if (baseline !== null) pushUndo(baseline)
    const rollbackTo = baseline ?? current
    return queue.current.enqueue(() =>
      save(current, rollbackTo).catch((err) => {
        setLastError(err instanceof Error ? err.message : String(err))
        throw err
      }),
    )
  }, [save, pushUndo])

  // undo()/redo() — snapshot swap. Pops the target stack, pushes current
  // state to the opposite stack, dispatches `rollback` (which replaces the
  // entire state), and enqueues a save so the host persists the swap.
  const undo = useCallback((): void => {
    const prev = undoStackRef.current.pop()
    if (!prev) return
    const current = projectRef.current
    redoStackRef.current.push(current)
    if (redoStackRef.current.length > MAX_HISTORY) redoStackRef.current.shift()
    bumpHistory()
    projectRef.current = prev
    dispatch({ type: 'rollback', snapshot: prev })
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
    dispatch({ type: 'rollback', snapshot: next })
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

  const updateOverlayProp = useCallback(
    (slideId: string, elementId: string, key: string, value: string) =>
      mutate({ type: 'updateOverlayProp', slideId, elementId, key, value }),
    [mutate],
  )

  const updateImageCrop = useCallback(
    (slideId: string, elementId: string, crop: { x: number; y: number; w: number; h: number } | undefined) =>
      mutate({ type: 'updateImageCrop', slideId, elementId, crop }),
    [mutate],
  )

  const setStatus = useCallback(
    (status: ProjectStatus) =>
      mutate({ type: 'setStatus', status }),
    [mutate],
  )

  const setName = useCallback(
    (name: string) =>
      mutate({ type: 'setName', name }),
    [mutate],
  )

  const moveElement = useCallback(
    (slideId: string, elementId: string, x: number, y: number): Promise<void> => {
      mutateTransient({ type: 'moveElement', slideId, elementId, x, y })
      return Promise.resolve()
    },
    [mutateTransient],
  )

  const resizeElement = useCallback(
    (slideId: string, elementId: string, box: { x: number; y: number; w: number; h: number }): Promise<void> => {
      mutateTransient({ type: 'resizeElement', slideId, elementId, ...box })
      return Promise.resolve()
    },
    [mutateTransient],
  )

  const rotateElement = useCallback(
    (slideId: string, elementId: string, rotation: number): Promise<void> => {
      mutateTransient({ type: 'rotateElement', slideId, elementId, rotation })
      return Promise.resolve()
    },
    [mutateTransient],
  )

  const addElement = useCallback(
    (slideId: string, element: CarouselElement) =>
      mutate({ type: 'addElement', slideId, element }),
    [mutate],
  )

  const removeElement = useCallback(
    (slideId: string, elementId: string) =>
      mutate({ type: 'removeElement', slideId, elementId }),
    [mutate],
  )

  const duplicateElement = useCallback(
    (slideId: string, elementId: string, newElement: CarouselElement) =>
      mutate({ type: 'duplicateElement', slideId, elementId, newElement }),
    [mutate],
  )

  const reorderElement = useCallback(
    (slideId: string, elementId: string, direction: 'forward' | 'backward') =>
      mutate({ type: 'reorderElement', slideId, elementId, direction }),
    [mutate],
  )

  const addSlide = useCallback(
    (slide: Slide, afterSlideId?: string) =>
      mutate({ type: 'addSlide', slide, afterSlideId }),
    [mutate],
  )

  const removeSlide = useCallback(
    (slideId: string) =>
      mutate({ type: 'removeSlide', slideId }),
    [mutate],
  )

  const duplicateSlide = useCallback(
    (slideId: string, newSlide: Slide) =>
      mutate({ type: 'duplicateSlide', slideId, newSlide }),
    [mutate],
  )

  const reorderSlides = useCallback(
    (fromIndex: number, toIndex: number) =>
      mutate({ type: 'reorderSlides', fromIndex, toIndex }),
    [mutate],
  )

  const updateSlide = useCallback(
    (slideId: string, patch: Partial<Slide>) =>
      mutate({ type: 'updateSlide', slideId, patch }),
    [mutate],
  )

  const setOverlayFrame = useCallback(
    (slideId: string, elementId: string, frame: number) =>
      mutate({ type: 'setOverlayFrame', slideId, elementId, frame }),
    [mutate],
  )

  // Force a fresh load of the project via the adapter and replace local state.
  // Useful when local state has drifted from the server (e.g. after a network gap).
  const refetch = useCallback(async () => {
    try {
      const next = await adapter.loadProject(projectId)
      dispatch({ type: 'sse', project: next })
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [adapter, projectId])

  const isEditingAllowed = isEditable(project.status)

  return {
    project,
    connection,
    isEditingAllowed,
    lastError,
    clearError,
    updateOverlayProp,
    updateImageCrop,
    setStatus,
    setName,
    moveElement,
    resizeElement,
    rotateElement,
    addElement,
    removeElement,
    duplicateElement,
    reorderElement,
    addSlide,
    removeSlide,
    duplicateSlide,
    reorderSlides,
    updateSlide,
    setOverlayFrame,
    commit,
    refetch,
    undo,
    redo,
    canUndo,
    canRedo,
  }
}
