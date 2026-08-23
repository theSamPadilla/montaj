import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectSync } from '../use-project-sync'
import type { EditorAdapter, Project, ImageElement, RenderEvent } from '../../types'

// ---------------------------------------------------------------------------
// Fixtures — mirrors the use-project-state test's FakeAdapter, but drives the
// shape-agnostic core directly with `(p) => p` mutations instead of the typed
// action vocabulary.
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: '1',
    id: 'proj-1',
    name: 'Test Project',
    workflow: 'carousel',
    status: 'draft',
    editingPrompt: '',
    settings: { resolution: [1080, 1080] },
    assets: [],
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [
          { id: 'el-0', type: 'image', src: 'a.png', x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        ],
      },
    ],
    ...overrides,
  }
}

interface FakeAdapter extends EditorAdapter {
  emit: (p: Project) => void
  saveCalls: Array<{ id: string; project: Project }>
  unsub: ReturnType<typeof vi.fn>
}

function makeFakeAdapter(opts: {
  failSave?: boolean
  /** When set, saveProject blocks on this until `release` is called. */
  blockSave?: boolean
} = {}): FakeAdapter & { release: () => void } {
  let onFrame: ((p: Project) => void) | null = null
  const saveCalls: Array<{ id: string; project: Project }> = []
  const unsub = vi.fn(() => { onFrame = null })
  let releaseSave: (() => void) | null = null
  const adapter: FakeAdapter & { release: () => void } = {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => {
      saveCalls.push({ id, project })
      if (opts.blockSave) await new Promise<void>((res) => { releaseSave = res })
      if (opts.failSave) throw new Error('save boom')
    }),
    subscribe: (_id: string, cb: (p: Project) => void) => {
      onFrame = cb
      return unsub
    },
    render: async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out.png' }
    },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    emit: (p: Project) => onFrame?.(p),
    saveCalls,
    unsub,
    release: () => releaseSave?.(),
  }
  return adapter
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useProjectSync — optimistic save', () => {
  it('optimistically applies a mutation and persists via adapter.saveProject', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => {
      await result.current.mutate((p) => ({ ...p, name: 'Renamed' }))
    })

    expect(result.current.project.name).toBe('Renamed')
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
    expect(adapter.saveCalls[0].id).toBe('proj-1')
    expect(adapter.saveCalls[0].project.name).toBe('Renamed')
    expect(result.current.canUndo).toBe(true)
  })

  it('rolls back optimistic state and surfaces lastError when saveProject fails', async () => {
    const adapter = makeFakeAdapter({ failSave: true })
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => {
      await result.current.mutate((p) => ({ ...p, name: 'Renamed' })).catch(() => {})
    })

    // Rolled back to the pre-mutation snapshot.
    expect(result.current.project.name).toBe('Test Project')
    expect(result.current.lastError).toMatch(/save boom/)
  })

  it('clearError resets lastError', async () => {
    const adapter = makeFakeAdapter({ failSave: true })
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => {
      await result.current.mutate((p) => ({ ...p, name: 'X' })).catch(() => {})
    })
    expect(result.current.lastError).toMatch(/save boom/)

    act(() => { result.current.clearError() })
    expect(result.current.lastError).toBeNull()
  })
})

describe('useProjectSync — external frames', () => {
  it('applies SSE frames pushed through adapter.subscribe and goes live', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    expect(result.current.connection).toBe('connecting')

    act(() => { adapter.emit(makeProject({ name: 'From Server' })) })

    await waitFor(() => {
      expect(result.current.project.name).toBe('From Server')
      expect(result.current.connection).toBe('live')
    })
    // External frames do not save or push undo history.
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('applyExternal replaces state without saving or pushing undo', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    act(() => { result.current.applyExternal(makeProject({ name: 'Server Authored' })) })

    expect(result.current.project.name).toBe('Server Authored')
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('routes external frames through a supplied reconcile function', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ name: 'Local' })
    // reconcile that ignores the incoming frame (keeps prev).
    const reconcile = vi.fn((prev: Project, _next: Project) => prev)
    const { result } = renderHook(() =>
      useProjectSync(adapter, initial.id, initial, { reconcile }),
    )

    act(() => { result.current.applyExternal(makeProject({ name: 'Incoming' })) })

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(result.current.project.name).toBe('Local')
  })

  it('defers an SSE frame while a save is in flight, then applies it on drain', async () => {
    const adapter = makeFakeAdapter({ blockSave: true })
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    // Kick a mutation whose save blocks — the queue is now pending.
    let mutatePromise: Promise<void> = Promise.resolve()
    act(() => {
      mutatePromise = result.current.mutate((p) => ({ ...p, name: 'Optimistic' }))
    })
    expect(result.current.project.name).toBe('Optimistic')
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))

    // An echo arrives mid-save — it must be HELD, not applied (no clobber).
    act(() => { adapter.emit(makeProject({ name: 'Echo While Saving' })) })
    expect(result.current.project.name).toBe('Optimistic')

    // Release the save; the queue drains and the deferred frame is applied.
    await act(async () => {
      adapter.release()
      await mutatePromise
    })
    await waitFor(() => expect(result.current.project.name).toBe('Echo While Saving'))
  })
})

describe('useProjectSync — undo/redo', () => {
  it('undo/redo swap state and re-persist via adapter', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => {
      await result.current.mutate((p) => ({ ...p, name: 'Renamed' }))
    })
    expect(result.current.project.name).toBe('Renamed')
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)

    await act(async () => { result.current.undo() })
    expect(result.current.project.name).toBe('Test Project')
    expect(result.current.canRedo).toBe(true)

    await act(async () => { result.current.redo() })
    expect(result.current.project.name).toBe('Renamed')

    // mutate save + undo save + redo save
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(3))
  })

  it('undo is a no-op with an empty history', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    act(() => { result.current.undo() })
    expect(result.current.project.name).toBe('Test Project')
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })
})

describe('useProjectSync — transient gestures', () => {
  it('commit persists one save after transient mutations, with one undo step', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => {
      result.current.mutateTransient((p) => ({ ...p, name: 'Drag 1' }))
      result.current.mutateTransient((p) => ({ ...p, name: 'Drag 2' }))
    })
    // Transient mutations do not save.
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.project.name).toBe('Drag 2')

    await act(async () => { await result.current.commit() })
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
    expect(adapter.saveCalls[0].project.name).toBe('Drag 2')
    // One undo step for the whole gesture.
    expect(result.current.canUndo).toBe(true)

    await act(async () => { result.current.undo() })
    expect(result.current.project.name).toBe('Test Project')
  })

  it('discardTransient restores the pre-gesture state without saving or touching undo', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    const canUndoBefore = result.current.canUndo

    act(() => {
      result.current.mutateTransient((p) => ({ ...p, name: 'Drag 1' }))
      result.current.mutateTransient((p) => ({ ...p, name: 'Drag 2' }))
    })
    expect(result.current.project.name).toBe('Drag 2')

    act(() => { result.current.discardTransient() })

    expect(result.current.project).toEqual(initial)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(canUndoBefore)
  })

  it('discardTransient clears the baseline so a later unrelated commit does not push a stale undo step', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    // Gesture that gets abandoned.
    act(() => {
      result.current.mutateTransient((p) => ({ ...p, name: 'Abandoned Drag' }))
    })
    act(() => { result.current.discardTransient() })
    expect(result.current.project.name).toBe('Test Project')
    expect(result.current.canUndo).toBe(false)

    // A later, unrelated commit() — NOT preceded by any new mutateTransient —
    // must not resurrect the discarded gesture's baseline as a phantom undo
    // step. If discardTransient had merely restored state (the naive
    // `mutateTransient(() => baseline)` a caller would otherwise have to do)
    // without clearing `transientBaseline`, this commit() would call
    // pushUndo(baseline) here and canUndo would flip to true despite no new
    // gesture ever having happened.
    await act(async () => { await result.current.commit() })

    expect(result.current.canUndo).toBe(false)
  })

  it('discardTransient with no transient in flight is a safe no-op', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    act(() => { result.current.discardTransient() })

    expect(result.current.project).toEqual(initial)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })
})

describe('useProjectSync — stale baseline regression', () => {
  // Regression for a data-loss bug: applyExternal (and undo/redo) replaced
  // state but left `transientBaseline` pointing at a now-stale pre-gesture
  // snapshot. A second gesture would then see a non-null baseline and skip
  // re-baselining, so commit() pushed the STALE snapshot as the undo/rollback
  // target — a later undo silently discarded the external change in between.
  // Sequence: gesture 1 (baseline = initial) → external frame arrives →
  // gesture 2 (must re-baseline to the external frame, not reuse the stale
  // one) → commit → undo. Asserts undo lands on the EXTERNAL state, not the
  // pre-gesture-1 state.
  it('undo after a gesture that follows an external frame restores the external state, not the stale pre-gesture baseline', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ name: 'Test Project' })
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    // Gesture 1 — baselines against the initial state.
    act(() => {
      result.current.mutateTransient((p) => ({ ...p, name: 'Gesture 1' }))
    })

    // External frame arrives mid-gesture (e.g. cancelOverlayEdit routing through
    // applyExternal, or an SSE echo / caption regen / restoreVersion).
    act(() => {
      result.current.applyExternal(makeProject({ name: 'External' }))
    })
    expect(result.current.project.name).toBe('External')

    // Gesture 2 — must baseline against 'External' (the current state), not the
    // stale 'Test Project' baseline from gesture 1.
    act(() => {
      result.current.mutateTransient((p) => ({ ...p, name: 'Gesture 2' }))
    })

    await act(async () => { await result.current.commit() })

    await act(async () => { result.current.undo() })

    // Undo should remove only gesture 2, landing back on the external state —
    // NOT the stale pre-gesture-1 snapshot ('Test Project'), which would
    // silently discard the external change.
    expect(result.current.project.name).toBe('External')
  })
})

describe('useProjectSync — subscription lifecycle', () => {
  it('unsubscribes on unmount', () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { unmount } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    unmount()
    expect(adapter.unsub).toHaveBeenCalledTimes(1)
  })
})
