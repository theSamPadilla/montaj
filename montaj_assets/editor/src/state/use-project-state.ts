/**
 * editor-core / state / use-project-state — the carousel editor's typed,
 * slide/element-addressed project state.
 *
 * A thin typed layer over the shape-agnostic `useProjectSync` core. This module
 * owns everything carousel-specific: the typed `Action` vocabulary (via
 * `projectReducer`), edit-gating by project status, and the target-exists guards
 * on overlay/image prop edits. All save/undo/SSE machinery lives in
 * `useProjectSync`; each typed mutation is expressed as
 * `sync.mutate(p => projectReducer(p, action))` behind its existing gates.
 *
 * The public surface (the `UseProjectState` interface and behavior) is
 * unchanged from when the machinery lived here inline.
 */
import { useCallback } from 'react'
import { projectReducer, type Action, type ProjectStatus } from './project-reducer'
import { useProjectSync } from './use-project-sync'
import type { Project, Slide, CarouselElement, EditorAdapter } from '../types'

// Re-export so existing consumers (index.ts barrel) keep importing `Connection`
// from here; the type is now owned by the sync core.
export type { Connection } from './use-project-sync'

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
  connection: 'connecting' | 'live'
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
  // Reference-preserving structural merge for external frames (SSE / refetch),
  // expressed through the reducer's `sse` case so echoes don't churn the canvas.
  const reconcile = useCallback(
    (prev: P, next: P): P =>
      (projectReducer as (state: P, action: Action<P>) => P)(prev, { type: 'sse', project: next }),
    [],
  )

  const sync = useProjectSync<P>(adapter, projectId, initial, { reconcile })
  const { mutate: syncMutate, mutateTransient: syncMutateTransient, projectRef } = sync

  // Typed, gated mutation. Gates on edit-allowed status and target-exists; silent
  // no-ops surface via console.warn so the regen→slide-deleted race shows up in
  // the dev console. Non-gated actions flow straight to the core, which handles
  // the optimistic apply + queued save.
  const mutate = useCallback(
    (action: Action<P>): Promise<void> => {
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
      return syncMutate((p) => projectReducer(p, action))
    },
    [syncMutate, projectRef],
  )

  // Typed transient dispatch (gesture previews) — local only, gated to the
  // transform actions and edit-allowed status.
  const mutateTransient = useCallback(
    (action: Action<P>): void => {
      const base = projectRef.current
      const editGated = new Set(['moveElement', 'resizeElement', 'rotateElement'])
      if (!editGated.has(action.type) || !isEditable(base.status)) {
        console.warn(`[useProjectState] dropped transient ${action.type}: status="${base.status}" not editable`)
        return
      }
      syncMutateTransient((p) => projectReducer(p, action))
    },
    [syncMutateTransient, projectRef],
  )

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

  const isEditingAllowed = isEditable(sync.project.status)

  return {
    project: sync.project,
    connection: sync.connection,
    isEditingAllowed,
    lastError: sync.lastError,
    clearError: sync.clearError,
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
    commit: sync.commit,
    refetch: sync.refetch,
    undo: sync.undo,
    redo: sync.redo,
    canUndo: sync.canUndo,
    canRedo: sync.canRedo,
  }
}
