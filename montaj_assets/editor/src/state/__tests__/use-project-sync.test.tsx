import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectSync } from '../use-project-sync'
import type { EditorAdapter, Project, ImageElement, RenderEvent } from '../../types'
import { removeSlideNotes } from '../../carousel/notes'
import { removeNotes } from '../../video/timeline/notes'

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
  saveCalls: Array<{ id: string; project: Project; before?: Project; argc: number }>
  unsub: ReturnType<typeof vi.fn>
}

function makeFakeAdapter(opts: {
  failSave?: boolean
  /** When set, saveProject blocks on this until `release` is called. */
  blockSave?: boolean
} = {}): FakeAdapter & { release: () => void } {
  let onFrame: ((p: Project) => void) | null = null
  const saveCalls: Array<{ id: string; project: Project; before?: Project; argc: number }> = []
  const unsub = vi.fn(() => { onFrame = null })
  let releaseSave: (() => void) | null = null
  const adapter: FakeAdapter & { release: () => void } = {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (...args: [string, Project, Project?]) => {
      const [id, project, before] = args
      saveCalls.push({ id, project, before, argc: args.length })
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

describe('useProjectSync — onLocalEdit', () => {
  it('fires on the four user paths only (mutate, a real commit, undo, redo)', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const onLocalEdit = vi.fn()
    const { result } = renderHook(() =>
      useProjectSync(adapter, initial.id, initial, { onLocalEdit }),
    )

    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'A' })) })
    expect(onLocalEdit).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.mutateTransient((p) => ({ ...p, name: 'B1' }))
      result.current.mutateTransient((p) => ({ ...p, name: 'B2' }))
      result.current.mutateTransient((p) => ({ ...p, name: 'B3' }))
    })
    expect(onLocalEdit).toHaveBeenCalledTimes(1)

    await act(async () => { await result.current.commit() })
    expect(onLocalEdit).toHaveBeenCalledTimes(2)

    // A commit with no transient gesture in flight changed nothing.
    await act(async () => { await result.current.commit() })
    expect(onLocalEdit).toHaveBeenCalledTimes(2)

    await act(async () => { result.current.undo() })
    expect(onLocalEdit).toHaveBeenCalledTimes(3)

    await act(async () => { result.current.redo() })
    expect(onLocalEdit).toHaveBeenCalledTimes(4)

    act(() => { result.current.applyExternal(makeProject({ name: 'Ext' })) })
    expect(onLocalEdit).toHaveBeenCalledTimes(4)

    act(() => { adapter.emit(makeProject({ name: 'SSE' })) })
    expect(result.current.project.name).toBe('SSE')
    expect(onLocalEdit).toHaveBeenCalledTimes(4)
  })

  it('does not fire for undo or redo on an empty stack, or for discardTransient', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const onLocalEdit = vi.fn()
    const { result } = renderHook(() =>
      useProjectSync(adapter, initial.id, initial, { onLocalEdit }),
    )

    act(() => { result.current.undo() })
    act(() => { result.current.redo() })
    act(() => {
      result.current.mutateTransient((p) => ({ ...p, name: 'X' }))
      result.current.discardTransient()
    })
    expect(onLocalEdit).not.toHaveBeenCalled()
  })

  it('calls the latest callback when the option identity changes', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const first = vi.fn()
    const second = vi.fn()
    const { result, rerender } = renderHook(
      ({ cb }) => useProjectSync(adapter, initial.id, initial, { onLocalEdit: cb }),
      { initialProps: { cb: first } },
    )
    const mutateBefore = result.current.mutate
    rerender({ cb: second })
    expect(result.current.mutate).toBe(mutateBefore)

    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'A' })) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('useProjectSync — optional top-level keys that go absent', () => {
  const note = (id: string) => ({ id, slideId: 'slide-0', text: id })

  it('undoing the first write of a key saves it as null so serve drops it', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, notes: [note('n1')] } as Project)) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))

    expect('notes' in result.current.project).toBe(false)
    expect((adapter.saveCalls[1].project as Record<string, unknown>).notes).toBeNull()
  })

  it('the same holds for markers', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, markers: [{ id: 'm1', t: 1, label: '' }] } as Project)) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect((adapter.saveCalls[1].project as Record<string, unknown>).markers).toBeNull()
  })

  it('undoing the second note saves the remaining note, not null', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, notes: [note('n1')] } as Project)) })
    await act(async () => { await result.current.mutate((p) => ({ ...p, notes: [note('n1'), note('n2')] } as Project)) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect((adapter.saveCalls[2].project as Record<string, unknown>).notes).toEqual([note('n1')])
  })

  it('a save where nothing went absent is the project itself', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'B' })) })
    expect(adapter.saveCalls[0].project).toEqual({ ...initial, name: 'B' })
    expect(Object.keys(adapter.saveCalls[0].project).sort()).toEqual(Object.keys({ ...initial, name: 'B' }).sort())
  })
})

// An undo/redo restores a snapshot of the whole project, but the history knows
// nothing of what the host pushed in between (SSE / applyExternal). So a
// restore may only clear the top-level keys that the undone (or redone) edit
// itself added (or removed): a key that arrived from elsewhere since is omitted
// from the body, and serve's shallow merge keeps it on disk.
describe('useProjectSync — undo/redo clear only the keys their own edit changed', () => {
  const note = (id: string) => ({ id, slideId: 'slide-0', text: id })
  const asset = { id: 'a1', src: 'a1.png', type: 'image' as const }
  const body = (adapter: FakeAdapter, i: number) => adapter.saveCalls[i].project as Record<string, unknown>
  // A project with no `assets` key, so the host can be the one to add it.
  const withoutAssets = (): Project => {
    const { assets: _a, ...rest } = makeProject()
    return rest as Project
  }

  it('undo of an edit after the host added a key never deletes that key', async () => {
    const adapter = makeFakeAdapter()
    const initial = withoutAssets()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
    // The host adds the project's first assets; the undo history never sees it.
    act(() => { adapter.emit({ ...result.current.projectRef.current!, assets: [asset] }) })
    expect(result.current.project.assets).toEqual([asset])

    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))

    expect(body(adapter, 1).name).toBe('Test Project')
    // The host's key rides along unchanged (equal to `before`), never null.
    expect(body(adapter, 1).assets).toEqual([asset])
    expect(adapter.saveCalls[1].before?.assets).toEqual([asset])
  })

  it('undo of the first note after the host added a key clears only notes', async () => {
    const adapter = makeFakeAdapter()
    const initial = withoutAssets()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, notes: [note('n1')] } as Project)) })
    act(() => { adapter.emit({ ...result.current.projectRef.current!, assets: [asset] }) })

    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))

    expect(body(adapter, 1).notes).toBeNull()
    expect(body(adapter, 1).assets).toEqual([asset])
  })

  it('a committed gesture records the keys it added, so its undo clears only those', async () => {
    const adapter = makeFakeAdapter()
    const initial = withoutAssets()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    act(() => {
      result.current.mutateTransient((p) => ({ ...p, notes: [note('n1')] } as Project))
      result.current.mutateTransient((p) => ({ ...p, notes: [note('n1'), note('n2')] } as Project))
    })
    await act(async () => { await result.current.commit() })
    act(() => { adapter.emit({ ...result.current.projectRef.current!, assets: [asset] }) })

    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))

    expect(body(adapter, 1).notes).toBeNull()
    expect(body(adapter, 1).assets).toEqual([asset])
  })

  it('redo after the host added a key never deletes that key', async () => {
    const adapter = makeFakeAdapter()
    const initial = withoutAssets()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    act(() => { adapter.emit({ ...result.current.projectRef.current!, assets: [asset] }) })

    act(() => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))

    expect(body(adapter, 2).name).toBe('Renamed')
    expect(body(adapter, 2).assets).toEqual([asset])
  })

  it('redo after undoing the first note restores it', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => ({ ...p, notes: [note('n1')] } as Project)) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(body(adapter, 1).notes).toBeNull()

    act(() => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))

    expect(body(adapter, 2).notes).toEqual([note('n1')])
    expect(result.current.project.notes).toEqual([note('n1')])
  })

  it('removing the last carousel note through the notes model saves notes: null', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ notes: [note('n1')] } as Partial<Project>)
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => {
      await result.current.mutate((p) => ({ ...p, notes: removeSlideNotes(p.notes, new Set(['n1'])) }))
    })
    expect(body(adapter, 0).notes).toBeNull()
  })

  it('removing the last video note through the notes model saves notes: null', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ notes: [{ id: 't1', t: 1, text: 'x' }] } as Partial<Project>)
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => { await result.current.mutate((p) => removeNotes(p, new Set(['t1'])) as Project) })
    expect(body(adapter, 0).notes).toBeNull()
  })

  it('an edit that drops a key deletes it, undo restores it, redo deletes it again', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ notes: [note('n1')] } as Partial<Project>)
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))

    await act(async () => {
      await result.current.mutate((p) => {
        const { notes: _n, ...rest } = p
        return rest as Project
      })
    })
    expect(body(adapter, 0).notes).toBeNull()

    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(body(adapter, 1).notes).toEqual([note('n1')])

    act(() => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(body(adapter, 2).notes).toBeNull()
  })
})


describe('useProjectSync — saveProject receives the document before the edit', () => {
  const named = (name: string) => makeProject({ name })

  it('mutate passes the document before the edit; the first save of a session passes the seeded initial', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'A' })) })
    expect(adapter.saveCalls[0].argc).toBe(3)
    expect(adapter.saveCalls[0].before).toBe(initial)
    expect(adapter.saveCalls[0].project.name).toBe('A')
  })

  it('two edits, undo, redo: before is the state just before each step', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'A' })) })
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'B' })) })
    await act(async () => { result.current.undo() })
    await act(async () => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    const seen = adapter.saveCalls.map((c) => [c.before?.name, c.project.name])
    expect(seen).toEqual([['Test Project', 'A'], ['A', 'B'], ['B', 'A'], ['A', 'B']])
  })

  it('a setting toggled on, off, on: each before is the previous state', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ settings: { resolution: [1080, 1080] } })
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    const toggle = (on: boolean) => (p: Project) =>
      ({ ...p, settings: { ...p.settings, flag: on } }) as Project
    await act(async () => { await result.current.mutate(toggle(true)) })
    await act(async () => { await result.current.mutate(toggle(false)) })
    await act(async () => { await result.current.mutate(toggle(true)) })
    const flags = adapter.saveCalls.map((c) => [
      (c.before?.settings as { flag?: boolean }).flag,
      (c.project.settings as { flag?: boolean }).flag,
    ])
    expect(flags).toEqual([[undefined, true], [true, false], [false, true]])
  })

  it('an edit while an external frame is held passes the editor own state, and the held frame lands after the drain', async () => {
    const adapter = makeFakeAdapter({ blockSave: true })
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    let p1: Promise<void> = Promise.resolve()
    let p2: Promise<void> = Promise.resolve()
    act(() => { p1 = result.current.mutate((p) => ({ ...p, name: 'Own 1' })) })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    act(() => { adapter.emit(named('Held frame')) })
    expect(result.current.project.name).toBe('Own 1')
    act(() => { p2 = result.current.mutate((p) => ({ ...p, name: 'Own 2' })) })
    await act(async () => { adapter.release(); await p1 })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(2))
    expect(adapter.saveCalls[1].before?.name).toBe('Own 1')
    expect(result.current.project.name).toBe('Own 2')
    await act(async () => { adapter.release(); await p2 })
    await waitFor(() => expect(result.current.project.name).toBe('Held frame'))
  })

  it('a committed gesture passes the pre-gesture document', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    await act(async () => {
      result.current.mutateTransient((p) => ({ ...p, name: 'Drag 1' }))
      result.current.mutateTransient((p) => ({ ...p, name: 'Drag 2' }))
    })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[0].argc).toBe(3)
    expect(adapter.saveCalls[0].before).toBe(initial)
    expect(adapter.saveCalls[0].project.name).toBe('Drag 2')
  })

  it('a gesture whose baseline an external frame cleared passes before: undefined, explicitly', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'Drag' })) })
    act(() => { result.current.applyExternal(named('External')) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls).toHaveLength(1)
    expect(adapter.saveCalls[0].argc).toBe(3)
    expect(adapter.saveCalls[0].before).toBeUndefined()
  })

  it('a commit with no transient changes still saves, and passes the current project as before (not undefined)', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls).toHaveLength(1)
    expect(adapter.saveCalls[0].argc).toBe(3)
    expect(adapter.saveCalls[0].before).toBe(initial)
    expect(adapter.saveCalls[0].project).toEqual(initial)
  })

  it('an external frame with no gesture in progress does not make the next empty commit undefined', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    act(() => { result.current.applyExternal(named('External')) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[0].before?.name).toBe('External')
  })

  it('a gesture started after an external frame has a baseline again', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'Drag' })) })
    act(() => { result.current.applyExternal(named('External')) })
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'Drag 2' })) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[0].argc).toBe(3)
    expect(adapter.saveCalls[0].before?.name).toBe('External')
    expect(adapter.saveCalls[0].project.name).toBe('Drag 2')
  })

  it('after a refused gesture, the next gesture and the next empty commit are normal', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'Drag' })) })
    act(() => { result.current.applyExternal(named('External')) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[0].before).toBeUndefined()
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[1].before?.name).toBe('External')
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'Next' })) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[2].before?.name).toBe('External')
  })

  it('two gestures in a row: each passes its own pre-gesture document', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'G1' })) })
    await act(async () => { await result.current.commit() })
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'G2' })) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls.map((c) => [c.before?.name, c.project.name])).toEqual([
      ['Test Project', 'G1'],
      ['G1', 'G2'],
    ])
  })

  it('a failed save still rolls back, and before was passed', async () => {
    const adapter = makeFakeAdapter({ failSave: true })
    const initial = makeProject()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    await act(async () => {
      await result.current.mutate((p) => ({ ...p, name: 'Doomed' })).catch(() => {})
    })
    expect(adapter.saveCalls[0].before).toBe(initial)
    expect(result.current.project.name).toBe('Test Project')
    expect(result.current.lastError).toBe('save boom')
  })
})

// Undo and redo restore ONLY the keys their edit changed, on top of the current
// project; a field another writer changed since is never reverted. A gesture
// left open when a mutate happens is saved as part of that edit. A lost
// baseline never outlives the gesture it belonged to.
describe('useProjectSync: keyed undo/redo, open gestures, stale baselineLost', () => {
  const note = (id: string) => ({ id, slideId: 'slide-0', text: id })
  const body = (adapter: FakeAdapter, i: number) => adapter.saveCalls[i].project as Record<string, unknown>
  const before = (adapter: FakeAdapter, i: number) => adapter.saveCalls[i].before as Record<string, unknown> | undefined
  const named = (name: string) => makeProject({ name })
  const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }))
  const setup = (initial: Project = makeProject()) => {
    const adapter = makeFakeAdapter()
    const hook = renderHook(() => useProjectSync(adapter, initial.id, initial))
    return { adapter, result: hook.result, initial }
  }

  it('A1: undo after an external frame brought notes keeps those notes and the host sees them unchanged', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
    act(() => { adapter.emit({ ...result.current.projectRef.current!, notes: [note('ai')] } as Project) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(body(adapter, 1).name).toBe('Test Project')
    expect(body(adapter, 1).notes).toEqual([note('ai')])
    expect(body(adapter, 1).notes).toBe(before(adapter, 1)!.notes)
  })

  it('A2: redo after an external frame brought notes keeps those notes', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    act(() => { adapter.emit({ ...result.current.projectRef.current!, notes: [note('ai')] } as Project) })
    act(() => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(body(adapter, 2).name).toBe('Renamed')
    expect(body(adapter, 2).notes).toBe(before(adapter, 2)!.notes)
    expect(result.current.project.notes).toEqual([note('ai')])
  })

  it('D1: a failed edit rolled back is not written back by the undo of a later edit', async () => {
    const { adapter, result } = setup()
    ;(adapter.saveProject as ReturnType<typeof vi.fn>).mockImplementationOnce(async (...a: unknown[]) => {
      adapter.saveCalls.push({ id: a[0] as string, project: a[1] as Project, before: a[2] as Project, argc: a.length })
      throw new Error('boom')
    })
    // Both edits in one tick: edit 2 starts from a state that holds edit 1.
    await act(async () => {
      const p1 = result.current.mutate((p) => ({ ...p, name: 'Failed' })).catch(() => {})
      const p2 = result.current.mutate((p) => ({ ...p, tracks: tracks(2) } as Project))
      await Promise.all([p1, p2])
    })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(body(adapter, 2).name).toBe('Test Project')
    expect(body(adapter, 2).tracks).toBeNull()
  })

  it('undo restores only the edit keys when other keys changed externally', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'N', status: 'final' })) })
    act(() => { adapter.emit({ ...result.current.projectRef.current!, status: 'pending', editingPrompt: 'ext' }) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(result.current.project.name).toBe('Test Project')
    expect(result.current.project.status).toBe('draft')
    expect(result.current.project.editingPrompt).toBe('ext')
  })

  it('redo restores only the edit keys when other keys changed externally', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'N' })) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    act(() => { adapter.emit({ ...result.current.projectRef.current!, editingPrompt: 'ext' }) })
    act(() => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(result.current.project.name).toBe('N')
    expect(result.current.project.editingPrompt).toBe('ext')
  })

  it('undo of an edit that added a key removes only that key', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, markers: [{ id: 'm', t: 1, label: '' }] } as Project)) })
    act(() => { adapter.emit({ ...result.current.projectRef.current!, notes: [note('ai')] } as Project) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(body(adapter, 1).markers).toBeNull()
    expect(body(adapter, 1).notes).toEqual([note('ai')])
    expect('markers' in result.current.project).toBe(false)
  })

  it('undo of an edit that removed a key restores only that key', async () => {
    const { adapter, result } = setup(makeProject({ notes: [note('n1')] } as Partial<Project>))
    await act(async () => {
      await result.current.mutate((p) => { const { notes: _n, ...rest } = p; return rest as Project })
    })
    act(() => { adapter.emit({ ...result.current.projectRef.current!, markers: [{ id: 'm', t: 1, label: '' }] } as Project) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(body(adapter, 1).notes).toEqual([note('n1')])
    expect(result.current.project.markers).toEqual([{ id: 'm', t: 1, label: '' }])
  })

  it('undo still swaps the whole edit when nothing else changed', async () => {
    const { adapter, result, initial } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'N', status: 'final' })) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(result.current.project).toEqual(initial)
    act(() => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(result.current.project).toEqual({ ...initial, name: 'N', status: 'final' })
  })

  it('H1: a mutate during an uncommitted gesture saves the gesture too', async () => {
    const { adapter, result, initial } = setup()
    act(() => { result.current.mutateTransient((p) => ({ ...p, tracks: tracks(3) } as Project)) })
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'M' })) })
    expect(adapter.saveCalls[0].before).toBe(initial)
    expect(body(adapter, 0).name).toBe('M')
    expect(body(adapter, 0).tracks).toEqual(tracks(3))
    await act(async () => { await result.current.commit() })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(result.current.project).toEqual(initial)
  })

  it('B1: a discarded gesture whose baseline was lost does not make the next empty commit undefined', async () => {
    const { adapter, result } = setup()
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'Drag' })) })
    act(() => { result.current.applyExternal(named('External')) })
    act(() => { result.current.discardTransient() })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[0].before?.name).toBe('External')
  })

  it('B2: a mutate after a lost baseline does not leave the next empty commit undefined', async () => {
    const { adapter, result } = setup()
    act(() => { result.current.mutateTransient((p) => ({ ...p, name: 'Drag' })) })
    act(() => { result.current.applyExternal(named('External')) })
    await act(async () => { await result.current.mutate((p) => ({ ...p, status: 'final' })) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[1].before).toBeDefined()
    expect(adapter.saveCalls[1].before?.status).toBe('final')
  })

  it('undo and redo also reset a lost baseline', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'A' })) })
    act(() => { result.current.mutateTransient((p) => ({ ...p, status: 'pending' })) })
    act(() => { result.current.applyExternal({ ...result.current.projectRef.current!, status: 'pending' }) })
    act(() => { result.current.undo() })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[adapter.saveCalls.length - 1].before).toBeDefined()
    act(() => { result.current.mutateTransient((p) => ({ ...p, status: 'storyboard_ready' })) })
    act(() => { result.current.applyExternal({ ...result.current.projectRef.current!, status: 'storyboard_ready' }) })
    act(() => { result.current.redo() })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveCalls[adapter.saveCalls.length - 1].before).toBeDefined()
  })
})
