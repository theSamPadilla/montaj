import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectSync } from '../use-project-sync'
import type { UseProjectSync, UseProjectSyncOptions } from '../use-project-sync'
import type { EditorAdapter, FrameInfo, FrameWriter, Project, ImageElement, RenderEvent } from '../../types'
import { removeSlideNotes } from '../../carousel/notes'
import { removeNotes } from '../../video/timeline/notes'
import { rippleDelete } from '../../video/cuts'

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
  emit: (p: Project, stamp?: FrameWriter, info?: FrameInfo) => void
  saveCalls: Array<{ id: string; project: Project; before?: Project; argc: number }>
  unsub: ReturnType<typeof vi.fn>
}

function makeFakeAdapter(opts: {
  failSave?: boolean
  /** When set, saveProject blocks on this until `release` is called. */
  blockSave?: boolean
} = {}): FakeAdapter & { release: () => void } {
  let onFrame: ((p: Project, stamp?: FrameWriter, info?: FrameInfo) => void) | null = null
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
    subscribe: (_id: string, cb: (p: Project, stamp?: FrameWriter, info?: FrameInfo) => void) => {
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
    emit: (p: Project, stamp?: FrameWriter, info?: FrameInfo) => onFrame?.(p, stamp, info),
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

  it('§527: undo of a ripple delete brings back the audio, notes and markers it moved or deleted', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({
      slides: undefined,
      tracks: [{ id: 'trk-0', items: [
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 9 },
        { id: 'c', type: 'video', start: 9, end: 14 },
      ] }],
      audio: { tracks: [{ id: 'sfx', src: 'hit.wav', start: 10, end: 11 }] },
      notes: [{ id: 'gone', t: 7, text: '' }, { id: 'moved', t: 12, text: '' }],
      markers: [{ id: 'm', t: 11, label: '1' }],
    } as Partial<Project>)
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    await act(async () => { await result.current.mutate((p) => rippleDelete(p, 'b')) })
    expect(result.current.project.audio!.tracks[0].start).toBe(6)
    expect(result.current.project.notes).toEqual([{ id: 'moved', t: 8, text: '' }])
    await act(async () => { result.current.undo() })
    expect(result.current.project.audio).toEqual(initial.audio)
    expect(result.current.project.notes).toEqual(initial.notes)
    expect(result.current.project.markers).toEqual(initial.markers)
    expect(result.current.project.tracks).toEqual(initial.tracks)
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

// §482 U-1: an undo or redo step restores whole top-level fields from snapshots taken before
// a teammate's pull, so undoing it after the pull would put the pre-pull clips back. A frame
// stamped as a sync pull (writer `tool`, origin `sync`) prunes the history instead: a step that
// changed what the pull changed is dropped (per clip in `tracks`, whole for any other field),
// the drop cascades to steps that changed what a dropped step changed, and every other step is
// rebased onto the pulled values. Every other frame leaves the history as it was.
describe('useProjectSync: a sync pull prunes the undo and redo steps that would revert it (§482 U-1)', () => {
  type Clip = { id: string; type: 'video'; src: string; start: number; end: number; [k: string]: unknown }
  const SYNC: FrameWriter = { writer: 'tool', origin: 'sync' }
  const clip = (id: string, start: number, end: number): Clip =>
    ({ id, type: 'video', src: `/media/${id}.mp4`, start, end })
  const video = (): Project => makeProject({
    workflow: 'video',
    tracks: [{ id: 'trk-0', items: [clip('A', 0, 5), clip('B', 5, 10)] }],
    captions: { segments: [{ text: 'hi', start: 0, end: 1 }] },
  } as unknown as Partial<Project>)
  const tracksOf = (p: Project) => p.tracks as unknown as Array<{ id: string; items: Clip[] }>
  const clipOf = (p: Project, id: string): Clip | undefined =>
    tracksOf(p).flatMap((t) => t.items).find((c) => c.id === id)
  /** `p` with clip `id` changed by `patch`. */
  const setClip = (p: Project, id: string, patch: Partial<Clip>): Project => ({
    ...p,
    tracks: tracksOf(p).map((t) => ({ ...t, items: t.items.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  } as unknown as Project)
  const addClip = (p: Project, c: Clip): Project => ({
    ...p,
    tracks: tracksOf(p).map((t, i) => (i === 0 ? { ...t, items: [...t.items, c] } : t)),
  } as unknown as Project)
  const deepFreeze = <T,>(v: T): T => {
    if (v && typeof v === 'object') {
      Object.values(v).forEach(deepFreeze)
      Object.freeze(v)
    }
    return v
  }
  /** A frame as a host hands it over: a fresh parse of what was written, frozen so that a
   *  write into the reloaded document throws. */
  const frame = (p: Project): Project => deepFreeze(JSON.parse(JSON.stringify(p)) as Project)
  const caps = (text: string) => ({ segments: [{ text, start: 0, end: 1 }] }) as unknown as Project['captions']
  const setup = (opts: UseProjectSyncOptions<Project> = {}) => {
    const adapter = makeFakeAdapter()
    const initial = video()
    const hook = renderHook(() => useProjectSync(adapter, initial.id, initial, opts))
    return { adapter, result: hook.result, initial }
  }
  const now = (r: { current: UseProjectSync<Project> }) => r.current.projectRef.current!

  it('a kept step is rebased: undoing an edit of clip A after a pull changed clip B keeps the pulled B, in state and in the save', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
    const pulled = frame(setClip(now(result), 'B', { end: 12 }))
    act(() => { adapter.emit(pulled, SYNC) })
    // The reloaded document is applied as it came.
    expect(result.current.project).toBe(pulled)
    expect(result.current.canUndo).toBe(true)
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(clipOf(result.current.project, 'A')?.end).toBe(5)
    expect(clipOf(result.current.project, 'B')?.end).toBe(12)
    expect(clipOf(adapter.saveCalls[1].project, 'A')?.end).toBe(5)
    expect(clipOf(adapter.saveCalls[1].project, 'B')?.end).toBe(12)
  })

  it('a step that changed the pulled clip is dropped, so undo sends nothing that reverts the pull', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), SYNC) })
    expect(result.current.canUndo).toBe(false)
    act(() => { result.current.undo() })
    expect(clipOf(result.current.project, 'B')?.end).toBe(12)
    expect(adapter.saveCalls).toHaveLength(1)
  })

  it('a drop cascades: an older step that changed a clip the dropped step also changed is dropped, and an unrelated step still undoes', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
    await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
    // One edit that moved A's end and B's start together (a ripple).
    await act(async () => { await result.current.mutate((p) => setClip(setClip(p, 'A', { end: 3 }), 'B', { start: 3 })) })
    act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), SYNC) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(result.current.project.name).toBe('Test Project')
    expect(clipOf(result.current.project, 'A')?.end).toBe(3)
    expect(clipOf(result.current.project, 'B')).toMatchObject({ start: 3, end: 12 })
    expect(result.current.canUndo).toBe(false)
  })

  it('a pull that changes a field it cannot split (captions) drops every step that changed it and keeps the rest', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => ({ ...p, captions: caps('one') })) })
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
    await act(async () => { await result.current.mutate((p) => ({ ...p, captions: caps('two') })) })
    act(() => { adapter.emit(frame({ ...now(result), captions: caps('pulled') }), SYNC) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(result.current.project.name).toBe('Test Project')
    expect(result.current.project.captions).toEqual(caps('pulled'))
    expect(adapter.saveCalls[3].project.captions).toEqual(caps('pulled'))
    expect(result.current.canUndo).toBe(false)
  })

  it('redo is pruned the same way', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    act(() => { result.current.undo() })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), SYNC) })
    act(() => { result.current.redo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(5))
    expect(clipOf(result.current.project, 'A')?.end).toBe(4)
    expect(clipOf(result.current.project, 'B')?.end).toBe(12)
    expect(clipOf(adapter.saveCalls[4].project, 'B')?.end).toBe(12)
    expect(result.current.canRedo).toBe(false)
  })

  it('a pull that adds a clip keeps an edit of another clip and drops an edit that changed the same track clip list', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
    await act(async () => { await result.current.mutate((p) => addClip(p, clip('X', 10, 12))) })
    act(() => { adapter.emit(frame(addClip(now(result), clip('D', 12, 14))), SYNC) })
    // Adding X changed trk-0's clip list, which the pull changed too: that step is dropped.
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(tracksOf(result.current.project)[0].items.map((c) => c.id)).toEqual(['A', 'B', 'X', 'D'])
    expect(clipOf(result.current.project, 'A')?.end).toBe(5)
    expect(result.current.canUndo).toBe(false)
  })

  it.each([
    ['no stamp', undefined],
    ['a tool stamp with no origin', { writer: 'tool' }],
    ['a tool stamp with another origin', { writer: 'tool', origin: 'restore' }],
    ['an ai write', { writer: 'ai' }],
    ['an ai write that names origin sync', { writer: 'ai', origin: 'sync' }],
    ['the editor own save', { writer: 'editor' }],
  ] as Array<[string, FrameWriter | undefined]>)('%s never prunes: the history stays as it was', async (_name, stamp) => {
    const onHistoryPruned = vi.fn()
    const { adapter, result } = setup({ onHistoryPruned })
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), stamp) })
    expect(result.current.canUndo).toBe(true)
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(clipOf(result.current.project, 'B')?.end).toBe(10)
    expect(onHistoryPruned).not.toHaveBeenCalled()
  })

  it('serve maintenance writes (dims, a copied src, *Source markers) never prune, and undoing a clip add still works after the dims land', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => addClip(p, clip('X', 10, 12))) })
    act(() => { adapter.emit(frame(setClip(now(result), 'X', { sourceWidth: 3840, sourceHeight: 2160 }))) })
    act(() => {
      const patched = setClip(now(result), 'X', { src: '/proj/assets/X.mp4' })
      adapter.emit(frame({ ...patched, settings: { ...patched.settings, resolutionSource: 'footage' } } as Project))
    })
    expect(result.current.canUndo).toBe(true)
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(clipOf(result.current.project, 'X')).toBeUndefined()
  })

  it('a sync frame equal to what the editor holds (its own echo) prunes nothing', async () => {
    const onHistoryPruned = vi.fn()
    const { adapter, result } = setup({ onHistoryPruned })
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    act(() => { adapter.emit(frame(now(result)), SYNC) })
    expect(result.current.canUndo).toBe(true)
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(clipOf(result.current.project, 'B')?.end).toBe(10)
    expect(onHistoryPruned).not.toHaveBeenCalled()
  })

  it('a sync frame held during a save still prunes when an unstamped copy replaced it before the drain, and the mark never carries over', async () => {
    const adapter = makeFakeAdapter({ blockSave: true })
    const initial = video()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    let saving: Promise<void> = Promise.resolve()
    act(() => { saving = result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    const pulled = setClip(now(result), 'B', { end: 12 })
    act(() => { adapter.emit(frame(pulled), SYNC) })
    // The watcher's copy of the same write, unstamped, takes its place in the hold.
    act(() => { adapter.emit(frame(pulled)) })
    await act(async () => { adapter.release(); await saving })
    await waitFor(() => expect(clipOf(result.current.project, 'B')?.end).toBe(12))
    expect(result.current.canUndo).toBe(false)

    // A later hold of an unstamped frame does not prune.
    act(() => { saving = result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(2))
    act(() => { adapter.emit(frame(setClip(now(result), 'A', { end: 2 }))) })
    await act(async () => { adapter.release(); await saving })
    await waitFor(() => expect(clipOf(result.current.project, 'A')?.end).toBe(2))
    expect(result.current.canUndo).toBe(true)
  })

  it('onHistoryPruned fires once per pruning frame with the steps it dropped, and never when nothing was dropped', async () => {
    const onHistoryPruned = vi.fn()
    const { adapter, result } = setup({ onHistoryPruned })
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { start: 6 })) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    // A pull of a field no step changed drops nothing.
    act(() => { adapter.emit(frame({ ...now(result), editingPrompt: 'pulled' }), SYNC) })
    expect(onHistoryPruned).not.toHaveBeenCalled()
    act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), SYNC) })
    expect(onHistoryPruned).toHaveBeenCalledTimes(1)
    expect(onHistoryPruned).toHaveBeenCalledWith({ undo: 1, redo: 1 })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('the trigger is one predicate, so a host can choose which frames prune', async () => {
    const prunesHistory = vi.fn((stamp?: FrameWriter) => stamp?.origin === 'restore')
    const { adapter, result } = setup({ prunesHistory })
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), SYNC) })
    expect(result.current.canUndo).toBe(true)
    act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 13 })), { writer: 'tool', origin: 'restore' }) })
    expect(result.current.canUndo).toBe(false)
    expect(prunesHistory).toHaveBeenLastCalledWith({ writer: 'tool', origin: 'restore' })
  })

  it('with no frame from outside, undo and redo over clips behave exactly as before', async () => {
    const { adapter, result, initial } = setup()
    await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
    const afterA = now(result)
    await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
    const afterB = now(result)
    act(() => { result.current.undo() })
    expect(result.current.project).toEqual(afterA)
    act(() => { result.current.undo() })
    expect(result.current.project).toEqual(initial)
    act(() => { result.current.redo() })
    act(() => { result.current.redo() })
    expect(result.current.project).toEqual(afterB)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(6))
    expect(adapter.saveCalls.map((c) => [clipOf(c.before!, 'A')?.end, clipOf(c.project, 'B')?.end])).toEqual([
      [5, 10], [4, 9], [4, 10], [4, 10], [5, 10], [4, 9],
    ])
  })

  it('a kept clip add is rebased too: undoing it after a pull changed another clip removes only the added clip', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => addClip(p, clip('Y', 10, 12))) })
    act(() => { adapter.emit(frame(setClip(now(result), 'A', { end: 4 })), SYNC) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(tracksOf(result.current.project)[0].items.map((c) => c.id)).toEqual(['A', 'B'])
    expect(clipOf(result.current.project, 'A')?.end).toBe(4)
    expect(clipOf(adapter.saveCalls[1].project, 'A')?.end).toBe(4)
  })

  // The unknown-state rule. A kept step is rebuilt as the reloaded document with only the
  // step's own units (here trk-0's clip list and clip Y) taken from its snapshot. When a
  // frame OUTSIDE the history (unstamped, so it pruned nothing) removed a clip that restored
  // list names, or added one it lacks, the rebuilt snapshot would have to invent that clip
  // or silently delete it. The step refuses instead: it is dropped (and reported) like a
  // conflicting step, undo changes nothing and sends nothing, and the clip stays as it is.
  it.each([
    ['removed a clip the step\'s restored list names', (p: Project) => ({
      ...p,
      tracks: tracksOf(p).map((t) => ({ ...t, items: t.items.filter((c) => c.id !== 'B') })),
    } as unknown as Project), ['A', 'Y']],
    ['added a clip the step\'s restored list lacks', (p: Project) => addClip(p, clip('Z', 12, 14)), ['A', 'B', 'Y', 'Z']],
  ] as Array<[string, (p: Project) => Project, string[]]>)(
    'an undo pruned past an unknown state refuses: a frame outside the history %s, so the step is dropped and undo does nothing',
    async (_name, outside, ids) => {
      const onHistoryPruned = vi.fn()
      const { adapter, result } = setup({ onHistoryPruned })
      await act(async () => { await result.current.mutate((p) => addClip(p, clip('Y', 10, 12))) })
      act(() => { adapter.emit(frame(outside(now(result)))) })
      expect(result.current.canUndo).toBe(true)
      act(() => { adapter.emit(frame(setClip(now(result), 'A', { end: 4 })), SYNC) })
      expect(onHistoryPruned).toHaveBeenCalledTimes(1)
      expect(onHistoryPruned).toHaveBeenCalledWith({ undo: 1, redo: 0 })
      expect(result.current.canUndo).toBe(false)
      const held = now(result)
      act(() => { result.current.undo() })
      expect(now(result)).toBe(held)
      expect(adapter.saveCalls).toHaveLength(1)
      expect(tracksOf(result.current.project)[0].items.map((c) => c.id)).toEqual(ids)
      expect(clipOf(result.current.project, 'A')?.end).toBe(4)
    },
  )

  it('an open gesture is not taken for the pull\'s change: the pull is measured from the gesture\'s baseline', async () => {
    const { adapter, result } = setup()
    await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
    const saved = now(result)
    act(() => { result.current.mutateTransient((p) => setClip(p, 'A', { end: 3 })) })
    act(() => { adapter.emit(frame(setClip(saved, 'B', { end: 12 })), SYNC) })
    expect(result.current.canUndo).toBe(true)
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(clipOf(result.current.project, 'A')?.end).toBe(5)
    expect(clipOf(result.current.project, 'B')?.end).toBe(12)
  })

  it('tracks that do not split by id are one field: a pull that changes them drops every step that changed them', async () => {
    type Loose = { id: string; items: Array<{ type: 'video'; src: string; start: number; end: number }> }
    const adapter = makeFakeAdapter()
    const initial = makeProject({
      workflow: 'video',
      tracks: [{ id: 'trk-0', items: [
        { type: 'video', src: '/a.mp4', start: 0, end: 5 },
        { type: 'video', src: '/b.mp4', start: 5, end: 10 },
      ] }],
    } as unknown as Partial<Project>)
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial))
    const setEnd = (p: Project, i: number, end: number): Project => ({
      ...p,
      tracks: (p.tracks as unknown as Loose[]).map((t) => ({ ...t, items: t.items.map((c, j) => (j === i ? { ...c, end } : c)) })),
    } as unknown as Project)
    const ends = (p: Project) => (p.tracks as unknown as Loose[])[0].items.map((c) => c.end)
    await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
    await act(async () => { await result.current.mutate((p) => setEnd(p, 0, 4)) })
    act(() => { adapter.emit(frame(setEnd(now(result), 1, 12)), SYNC) })
    act(() => { result.current.undo() })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(result.current.project.name).toBe('Test Project')
    expect(ends(result.current.project)).toEqual([4, 12])
    expect(result.current.canUndo).toBe(false)
  })

  // FIX 1. A teammate's pull that lands while the stream is down is stamped to no
  // listener. The first frame on the reopened connection (serve's current state,
  // unstamped) may carry it, so the transport marks that frame `{ gap: true }` and,
  // for a project the host says is synced, the core prunes on it like a pull. Only
  // content that differs from what the editor holds prunes anything, so an
  // identical reconnect (or the editor's own save coming back) leaves the history
  // as it was.
  describe('in a synced project a frame after a gap may hold a pull, so it prunes like one (FIX 1)', () => {
    const GAP: FrameInfo = { gap: true }
    const SYNCED = { syncedProject: true }

    it('the stream drops, a teammate pull lands in the gap, the stream reopens: the next undo keeps the teammate change and no save reverts it', async () => {
      const onHistoryPruned = vi.fn()
      const { adapter, result } = setup({ ...SYNCED, onHistoryPruned })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      // The pull's stamped frame went to no listener. Serve's first frame on the new
      // connection is its current state, with no stamp.
      const reconnect = frame(setClip(now(result), 'B', { end: 12 }))
      act(() => { adapter.emit(reconnect, undefined, GAP) })
      expect(result.current.project).toBe(reconnect)
      expect(onHistoryPruned).toHaveBeenCalledTimes(1)
      expect(onHistoryPruned).toHaveBeenCalledWith({ undo: 1, redo: 0 })
      act(() => { result.current.undo() })
      await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
      expect(clipOf(result.current.project, 'A')?.end).toBe(5)
      expect(clipOf(result.current.project, 'B')?.end).toBe(12)
      expect(result.current.canUndo).toBe(false)
      act(() => { result.current.undo() })
      expect(adapter.saveCalls).toHaveLength(3)
      expect(clipOf(adapter.saveCalls[2].project, 'B')?.end).toBe(12)
    })

    it('an identical reconnect frame, or an edit saved while the stream was down coming back as the editor own echo, leaves the history untouched', async () => {
      const onHistoryPruned = vi.fn()
      const { adapter, result } = setup({ ...SYNCED, onHistoryPruned })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      act(() => { adapter.emit(frame(now(result)), undefined, GAP) })
      // Saved over HTTP while the stream was down; the reconnect frame holds it.
      await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
      act(() => { adapter.emit(frame(now(result)), undefined, GAP) })
      expect(onHistoryPruned).not.toHaveBeenCalled()
      act(() => { result.current.undo() })
      act(() => { result.current.undo() })
      await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
      expect(clipOf(result.current.project, 'A')?.end).toBe(5)
      expect(clipOf(result.current.project, 'B')?.end).toBe(10)
    })

    it('refetch reads across a possible gap: a changed document prunes, an unchanged one leaves the history alone', async () => {
      const onHistoryPruned = vi.fn()
      const { adapter, result } = setup({ ...SYNCED, onHistoryPruned })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      adapter.loadProject = vi.fn(async () => frame(now(result)))
      await act(async () => { await result.current.refetch() })
      expect(onHistoryPruned).not.toHaveBeenCalled()
      const fresh = frame(setClip(now(result), 'B', { end: 12 }))
      adapter.loadProject = vi.fn(async () => fresh)
      await act(async () => { await result.current.refetch() })
      expect(result.current.project).toBe(fresh)
      expect(onHistoryPruned).toHaveBeenCalledWith({ undo: 1, redo: 0 })
      act(() => { result.current.undo() })
      await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
      expect(clipOf(adapter.saveCalls[2].project, 'A')?.end).toBe(5)
      expect(clipOf(adapter.saveCalls[2].project, 'B')?.end).toBe(12)
      expect(result.current.canUndo).toBe(false)
    })

    it('a gap frame is never taken for a sync or AI write: the predicate sees the writer it came with, no local edit fires, and the gap prunes whatever the predicate says', async () => {
      const prunesHistory = vi.fn(() => false)
      const onLocalEdit = vi.fn()
      const { adapter, result } = setup({ ...SYNCED, prunesHistory, onLocalEdit })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      onLocalEdit.mockClear()
      const reconnect = frame(setClip(now(result), 'B', { end: 12 }))
      act(() => { adapter.emit(reconnect, undefined, GAP) })
      expect(prunesHistory).toHaveBeenLastCalledWith(undefined)
      expect(onLocalEdit).not.toHaveBeenCalled()
      expect(result.current.project).toBe(reconnect)
      act(() => { adapter.emit(frame(setClip(now(result), 'A', { end: 3 })), { writer: 'ai' }, GAP) })
      expect(prunesHistory).toHaveBeenLastCalledWith({ writer: 'ai' })
      expect(onLocalEdit).not.toHaveBeenCalled()
      expect(result.current.canUndo).toBe(false)
    })

    it('the gap binds to its one frame: a later unstamped frame with a change prunes nothing', async () => {
      const onHistoryPruned = vi.fn()
      const { adapter, result } = setup({ ...SYNCED, onHistoryPruned })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      act(() => { adapter.emit(frame(now(result)), undefined, GAP) })
      act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 }))) })
      expect(onHistoryPruned).not.toHaveBeenCalled()
      expect(result.current.canUndo).toBe(true)
      act(() => { result.current.undo() })
      await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
      expect(clipOf(result.current.project, 'B')?.end).toBe(10)
    })
  })

  // FIX 1 is dark: with `syncedProject` absent or false, a gap frame and a refetch
  // apply exactly as any unstamped frame did before U-1 (6243c387's parent), and
  // prune nothing. The stamped path is unchanged either way.
  describe('with syncedProject absent or false, a gap frame and a refetch prune nothing (FIX 1 is dark)', () => {
    const GAP: FrameInfo = { gap: true }
    type Deliver = (adapter: FakeAdapter, r: { current: UseProjectSync<Project> }, next: Project) => Promise<void>
    const plain: Deliver = async (adapter, _r, next) => { act(() => { adapter.emit(next) }) }
    const gap: Deliver = async (adapter, _r, next) => { act(() => { adapter.emit(next, undefined, GAP) }) }
    const refetch: Deliver = async (adapter, r, next) => {
      adapter.loadProject = vi.fn(async () => next)
      await act(async () => { await r.current.refetch() })
    }
    const ends = (p: unknown) => ['A', 'B'].map((id) => clipOf(p as Project, id)?.end)
    const doc = (p: Project) => JSON.parse(JSON.stringify(p)) as unknown

    /** Two edits, a frame that changes B delivered by `deliver`, then every undo and every redo. */
    async function trace(opts: UseProjectSyncOptions<Project>, deliver: Deliver) {
      const onHistoryPruned = vi.fn()
      const { adapter, result } = setup({ ...opts, onHistoryPruned })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      await deliver(adapter, result, frame(setClip(now(result), 'B', { end: 12 })))
      const states: unknown[] = [doc(now(result))]
      for (let i = 0; i < 10 && result.current.canUndo; i++) {
        act(() => { result.current.undo() })
        states.push(doc(now(result)))
      }
      states.push('redo')
      for (let i = 0; i < 10 && result.current.canRedo; i++) {
        act(() => { result.current.redo() })
        states.push(doc(now(result)))
      }
      // The two edits, then one save per undo and redo (`states` holds the frame, each step and the marker).
      await waitFor(() => expect(adapter.saveCalls).toHaveLength(states.length))
      return { states, saves: adapter.saveCalls.map((c) => doc(c.project)), pruned: onHistoryPruned.mock.calls.length }
    }

    it.each([
      ['a reconnect frame, syncedProject absent', {}, gap],
      ['a reconnect frame, syncedProject false', { syncedProject: false }, gap],
      ['a refetch, syncedProject absent', {}, refetch],
      ['a refetch, syncedProject false', { syncedProject: false }, refetch],
    ] as Array<[string, UseProjectSyncOptions<Project>, Deliver]>)('%s: applied as an unstamped frame was before U-1, every state and save the same', async (_name, opts, deliver) => {
      const want = await trace({}, plain)
      const got = await trace(opts, deliver)
      expect(got).toEqual(want)
      expect(got.pruned).toBe(0)
      // As before U-1: the undo of the B edit restores its whole snapshot, B 10.
      expect(got.states.map((s) => (s === 'redo' ? s : ends(s)))).toEqual([[4, 12], [4, 10], [5, 10], 'redo', [4, 10], [4, 9]])
    })

    it('a reconnect frame held during a save, syncedProject absent: applied on the drain with the history untouched', async () => {
      const onHistoryPruned = vi.fn()
      const adapter = makeFakeAdapter({ blockSave: true })
      const initial = video()
      const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial, { onHistoryPruned }))
      let saving: Promise<void> = Promise.resolve()
      act(() => { saving = result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
      const reconnect = frame(setClip(now(result), 'B', { end: 12 }))
      act(() => { adapter.emit(reconnect, undefined, GAP) })
      await act(async () => { adapter.release(); await saving })
      await waitFor(() => expect(now(result)).toBe(reconnect))
      expect(onHistoryPruned).not.toHaveBeenCalled()
      expect(result.current.canUndo).toBe(true)
    })

    it('the stamped path is unchanged with syncedProject absent: a sync pull still prunes', async () => {
      const onHistoryPruned = vi.fn()
      const { adapter, result } = setup({ onHistoryPruned })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), SYNC) })
      expect(onHistoryPruned).toHaveBeenCalledWith({ undo: 1, redo: 0 })
      expect(result.current.canUndo).toBe(false)
    })
  })

  // FIX 2. While a save is in flight every frame is held. Disk is written in
  // order, so a frame after a held pull already contains it. On the drain the held
  // frames are applied in order, each pull (or gap frame) pruning against its own
  // content, measured from the screen at that moment, and every other frame
  // without pruning. The history comes out as it would with the same frames and
  // no save in flight, and the drain reports once.
  describe('a held pull replaced by a later frame prunes for the pull only (FIX 2)', () => {
    const GAP: FrameInfo = { gap: true }
    type Emit = [Project, FrameWriter?, FrameInfo?]
    const ends = (p: unknown) => ['A', 'B'].map((id) => clipOf(p as Project, id)?.end)

    /**
     * Make `edits`, then hand the hook the frames `make` builds from the editor's
     * document: `held`, with the last edit's save still in flight, so the core holds
     * them until it finishes; `live`, after every save finished, so each applies as
     * it comes. Returns the document after the frames, then after each undo until
     * none is left, then after each redo, with what onHistoryPruned reported.
     */
    async function replay(mode: 'held' | 'live', edits: Array<(p: Project) => Project>, make: (doc: Project) => Emit[]) {
      const onHistoryPruned = vi.fn()
      const adapter = makeFakeAdapter()
      const save = adapter.saveProject
      let gate: Promise<void> | null = null
      let open = () => {}
      adapter.saveProject = vi.fn(async (...args: [string, Project, Project?]) => {
        await save(...args)
        if (gate) await gate
      })
      const initial = video()
      // Synced, so a gap frame in the hold prunes too.
      const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial, { onHistoryPruned, syncedProject: true }))
      for (const edit of edits.slice(0, -1)) await act(async () => { await result.current.mutate(edit) })
      const last = edits[edits.length - 1]
      let frames: Emit[] = []
      if (mode === 'live') {
        await act(async () => { await result.current.mutate(last) })
        frames = make(now(result))
        for (const f of frames) act(() => { adapter.emit(...f) })
      } else {
        gate = new Promise<void>((res) => { open = res })
        let saving: Promise<void> = Promise.resolve()
        act(() => { saving = result.current.mutate(last) })
        await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(edits.length))
        const screen = now(result)
        frames = make(screen)
        for (const f of frames) act(() => { adapter.emit(...f) })
        // Held: nothing applied, nothing pruned yet.
        expect(now(result)).toBe(screen)
        expect(onHistoryPruned).not.toHaveBeenCalled()
        gate = null
        await act(async () => { open(); await saving })
      }
      const latest = frames[frames.length - 1][0]
      await waitFor(() => expect(now(result)).toBe(latest))
      const doc = (p: Project) => JSON.parse(JSON.stringify(p)) as unknown
      const states: unknown[] = [doc(now(result))]
      for (let i = 0; i < 60 && result.current.canUndo; i++) {
        act(() => { result.current.undo() })
        states.push(doc(now(result)))
      }
      states.push('redo')
      for (let i = 0; i < 60 && result.current.canRedo; i++) {
        act(() => { result.current.redo() })
        states.push(doc(now(result)))
      }
      return { states, pruned: onHistoryPruned.mock.calls.map((c) => c[0]), adapter }
    }

    const both = async (edits: Array<(p: Project) => Project>, make: (doc: Project) => Emit[]) => {
      const held = await replay('held', edits, make)
      const live = await replay('live', edits, make)
      expect(held.states).toEqual(live.states)
      return held
    }

    // (a) and (b): the reviewer's case. The AI frame's own change prunes nothing, the pull still does.
    it('a held pull replaced by an AI frame that contains it: the step on the AI-changed clip is kept, the step on the pulled clip is dropped, as with no save in flight', async () => {
      const held = await both(
        [(p) => setClip(p, 'A', { end: 4 }), (p) => setClip(p, 'B', { end: 9 })],
        (doc) => {
          const pull = frame(setClip(doc, 'B', { end: 12 }))
          return [[pull, SYNC], [frame(setClip(pull, 'A', { end: 2 }))]]
        },
      )
      expect(held.pruned).toEqual([{ undo: 1, redo: 0 }])
      // After the drain; after undoing the kept A step; then the redo of it.
      expect(held.states.map((s) => (s === 'redo' ? s : ends(s)))).toEqual([[2, 12], [5, 12], 'redo', [4, 12]])
      expect(held.adapter.saveCalls.slice(2).map((c) => clipOf(c.project, 'B')?.end)).toEqual([12, 12])
    })

    // (c)
    it('a held pull replaced by the watcher identical copy prunes the same, as with no save in flight', async () => {
      const held = await both(
        [(p) => setClip(p, 'A', { end: 4 }), (p) => setClip(p, 'B', { end: 9 })],
        (doc) => {
          const pull = setClip(doc, 'B', { end: 12 })
          return [[frame(pull), SYNC], [frame(pull)]]
        },
      )
      expect(held.pruned).toEqual([{ undo: 1, redo: 0 }])
      expect(held.states.map((s) => (s === 'redo' ? s : ends(s)))).toEqual([[4, 12], [5, 12], 'redo', [4, 12]])
    })

    // (d)
    it('a held gap frame replaced by a later unstamped frame prunes for the gap frame content, as with no save in flight', async () => {
      const held = await both(
        [(p) => setClip(p, 'A', { end: 4 }), (p) => setClip(p, 'B', { end: 9 })],
        (doc) => {
          const reconnect = frame(setClip(doc, 'B', { end: 12 }))
          return [[reconnect, undefined, GAP], [frame(setClip(reconnect, 'A', { end: 2 }))]]
        },
      )
      expect(held.pruned).toEqual([{ undo: 1, redo: 0 }])
      expect(held.states.map((s) => (s === 'redo' ? s : ends(s)))).toEqual([[2, 12], [5, 12], 'redo', [4, 12]])
    })

    it('two held pulls then an unstamped frame: each pull prunes in order, then the frame, one report per drain, as with no save in flight', async () => {
      const held = await both(
        [
          (p) => ({ ...p, captions: caps('one') }),
          (p) => setClip(p, 'A', { end: 4 }),
          (p) => setClip(p, 'B', { end: 9 }),
        ],
        (doc) => {
          const first = frame(setClip(doc, 'B', { end: 12 }))
          const second = frame({ ...first, captions: caps('pulled') })
          return [[first, SYNC], [second, SYNC], [frame(setClip(second, 'A', { end: 2 }))]]
        },
      )
      // Once per drain: both pulls' changes in one report.
      expect(held.pruned).toEqual([{ undo: 2, redo: 0 }])
      expect(held.states.map((s) => (s === 'redo' ? s : ends(s)))).toEqual([[2, 12], [5, 12], 'redo', [4, 12]])
      expect((held.states[1] as Project).captions).toEqual(caps('pulled'))
    })

    it('an AI frame that reverts the clip the pull changed: the step on that clip stays dropped and nothing comes back', async () => {
      const held = await both(
        [(p) => ({ ...p, name: 'Renamed' }), (p) => setClip(p, 'B', { end: 9 })],
        (doc) => {
          const pull = frame(setClip(doc, 'B', { end: 12 }))
          // Back to the value the editor held before the pull.
          return [[pull, SYNC], [frame(setClip(pull, 'B', { end: 9 }))]]
        },
      )
      expect(held.pruned).toEqual([{ undo: 1, redo: 0 }])
      // Only the rename undoes; B is never 10 again, in state or in a save.
      expect(held.states.map((s) => (s === 'redo' ? s : [(s as Project).name, ends(s)[1]]))).toEqual([
        ['Renamed', 9], ['Test Project', 9], 'redo', ['Renamed', 9],
      ])
      // The saves after the pull: the rename's undo and redo, B as the AI left it.
      expect(held.adapter.saveCalls.slice(2).map((c) => clipOf(c.project, 'B')?.end)).toEqual([9, 9])
    })

    it('a gap frame held after a held pull prunes after it, in order, with one report per drain', async () => {
      const held = await both(
        [
          (p) => ({ ...p, captions: caps('one') }),
          (p) => ({ ...p, name: 'Renamed' }),
          (p) => setClip(p, 'B', { end: 9 }),
        ],
        (doc) => {
          const pull = frame(setClip(doc, 'B', { end: 12 }))
          // A second pull went to no listener while the stream was down.
          return [[pull, SYNC], [frame({ ...pull, captions: caps('pulled') }), undefined, GAP]]
        },
      )
      expect(held.pruned).toEqual([{ undo: 2, redo: 0 }])
      expect(held.states.map((s) => (s === 'redo' ? s : [(s as Project).name, ends(s)[1]]))).toEqual([
        ['Renamed', 12], ['Test Project', 12], 'redo', ['Renamed', 12],
      ])
    })

    it('the pull is measured from the screen when the save finishes, so an edit made while it was held is measured too', async () => {
      const onHistoryPruned = vi.fn()
      const adapter = makeFakeAdapter()
      const save = adapter.saveProject
      let gate: Promise<void> | null = null
      let open = () => {}
      adapter.saveProject = vi.fn(async (...args: [string, Project, Project?]) => {
        await save(...args)
        if (gate) await gate
      })
      const initial = video()
      const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial, { onHistoryPruned }))
      await act(async () => { await result.current.mutate((p) => ({ ...p, name: 'Renamed' })) })
      gate = new Promise<void>((res) => { open = res })
      let first: Promise<void> = Promise.resolve()
      act(() => { first = result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(2))
      const pull = frame(setClip(now(result), 'B', { end: 12 }))
      act(() => { adapter.emit(pull, SYNC) })
      // While the pull is held the user edits A. The pull frame predates that edit.
      let second: Promise<void> = Promise.resolve()
      act(() => { second = result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
      // The edit's echo replaces the pull in the hold.
      const echo = frame(setClip(pull, 'A', { end: 4 }))
      act(() => { adapter.emit(echo) })
      expect(onHistoryPruned).not.toHaveBeenCalled()
      gate = null
      await act(async () => { open(); await first; await second })
      await waitFor(() => expect(now(result)).toBe(echo))
      // Measured from the screen at the drain (A 4, B 9) to the pull (A 5, B 12): both
      // the B step and the A step made while the pull was held go. That is the
      // conservative side: from the screen when the pull was held (A 5) the A step
      // would have been rebuilt on the pull instead. The rename is kept.
      expect(onHistoryPruned).toHaveBeenCalledTimes(1)
      expect(onHistoryPruned).toHaveBeenCalledWith({ undo: 2, redo: 0 })
      act(() => { result.current.undo() })
      await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
      expect(result.current.project.name).toBe('Test Project')
      expect(ends(result.current.project)).toEqual([4, 12])
      expect(clipOf(adapter.saveCalls[3].project, 'B')?.end).toBe(12)
      expect(result.current.canUndo).toBe(false)
    })

    // Re-check finding 1: the frames held during a save are replayed in order, so a
    // later pull is measured from a screen that already holds the AI frame before it.
    it('a pull, an AI frame, then a pull, all held: replayed in order, so the AI change prunes nothing and the step on its clip is kept, as with no save in flight', async () => {
      const held = await both(
        [
          (p) => setClip(p, 'A', { end: 4 }),
          (p) => ({ ...p, captions: caps('one') }),
          (p) => setClip(p, 'B', { end: 9 }),
        ],
        (doc) => {
          const first = frame(setClip(doc, 'B', { end: 12 }))
          const ai = frame(setClip(first, 'A', { end: 2 }))
          return [[first, SYNC], [ai], [frame({ ...ai, captions: caps('pulled') }), SYNC]]
        },
      )
      // The B step and the captions step go, in one report; the A step stays.
      expect(held.pruned).toEqual([{ undo: 2, redo: 0 }])
      expect(ends(held.states[0])).toEqual([2, 12])
      expect(ends(held.states[1])).toEqual([5, 12])
      expect(held.states[2]).toBe('redo')
    })
  })

  // Re-check findings 4 and 5: what a resubscribe (a project switch, or a host that
  // re-creates its adapter) does to a held frame and to the first frame after it.
  describe('a resubscribe: held frames stay with their project, and its first frame is a gap', () => {
    const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const other = () => frame({ ...video(), id: 'proj-2', name: 'Other project' } as Project)

    it('a project switch while a pull is held: nothing from the old project applies or prunes on the new one', async () => {
      const onHistoryPruned = vi.fn()
      const adapter = makeFakeAdapter({ blockSave: true })
      const initial = video()
      const { result, rerender } = renderHook(
        ({ id }) => useProjectSync(adapter, id, initial, { onHistoryPruned, syncedProject: true }),
        { initialProps: { id: initial.id } },
      )
      let saving: Promise<void> = Promise.resolve()
      act(() => { saving = result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
      const screen = now(result)
      act(() => { adapter.emit(frame(setClip(screen, 'B', { end: 12 })), SYNC) })
      rerender({ id: 'proj-2' })
      await act(async () => { adapter.release(); await saving })
      await flush()
      expect(now(result)).toBe(screen)
      expect(onHistoryPruned).not.toHaveBeenCalled()
      expect(result.current.canUndo).toBe(true)
    })

    it('a project switch while a pull is held, then a frame of the new project held too: only the new frame applies, and the old pull prunes nothing', async () => {
      const onHistoryPruned = vi.fn()
      const adapter = makeFakeAdapter({ blockSave: true })
      const initial = video()
      const { result, rerender } = renderHook(
        ({ id }) => useProjectSync(adapter, id, initial, { onHistoryPruned }),
        { initialProps: { id: initial.id } },
      )
      let saving: Promise<void> = Promise.resolve()
      act(() => { saving = result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
      act(() => { adapter.emit(frame(setClip(now(result), 'B', { end: 12 })), SYNC) })
      rerender({ id: 'proj-2' })
      const next = other()
      act(() => { adapter.emit(next) })
      await act(async () => { adapter.release(); await saving })
      await waitFor(() => expect(now(result)).toBe(next))
      await flush()
      expect(now(result)).toBe(next)
      expect(onHistoryPruned).not.toHaveBeenCalled()
      expect(result.current.canUndo).toBe(true)
    })

    it('the same project resubscribed while a frame is held (the host re-created its adapter): the held frame still applies on the drain', async () => {
      const first = makeFakeAdapter({ blockSave: true })
      const second = makeFakeAdapter()
      const initial = video()
      const { result, rerender } = renderHook(
        ({ adapter }) => useProjectSync(adapter, initial.id, initial),
        { initialProps: { adapter: first as EditorAdapter } },
      )
      let saving: Promise<void> = Promise.resolve()
      act(() => { saving = result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      await waitFor(() => expect(first.saveProject).toHaveBeenCalledTimes(1))
      const ai = frame(setClip(now(result), 'A', { end: 2 }))
      act(() => { first.emit(ai) })
      rerender({ adapter: second })
      await act(async () => { first.release(); await saving })
      await waitFor(() => expect(now(result)).toBe(ai))
    })

    it.each([
      ['synced: the first frame on the new subscription prunes like a gap frame, and only that one', true, [{ undo: 1, redo: 0 }]],
      ['not synced: it prunes nothing, as before', false, []],
    ] as Array<[string, boolean, unknown[]]>)('a resubscribe of the same project, %s', async (_name, syncedProject, reports) => {
      const onHistoryPruned = vi.fn()
      const first = makeFakeAdapter()
      const second = makeFakeAdapter()
      const initial = video()
      const { result, rerender } = renderHook(
        ({ adapter }) => useProjectSync(adapter, initial.id, initial, { onHistoryPruned, syncedProject }),
        { initialProps: { adapter: first as EditorAdapter } },
      )
      await act(async () => { await result.current.mutate((p) => setClip(p, 'A', { end: 4 })) })
      await act(async () => { await result.current.mutate((p) => setClip(p, 'B', { end: 9 })) })
      // The first subscription's first frame is no gap.
      act(() => { first.emit(frame(setClip(now(result), 'B', { end: 11 }))) })
      expect(onHistoryPruned).not.toHaveBeenCalled()
      rerender({ adapter: second })
      act(() => { second.emit(frame(setClip(now(result), 'B', { end: 12 }))) })
      act(() => { second.emit(frame(setClip(now(result), 'A', { end: 2 }))) })
      expect(onHistoryPruned.mock.calls.map((c) => c[0])).toEqual(reports)
      expect(result.current.canUndo).toBe(true)
    })
  })
})

// §482 onBusyChange: busy is a save in flight OR a gesture open. It fires on
// transitions only, never on mount, and a host that passes nothing sees no change.
describe('useProjectSync onBusyChange', () => {
  function busySetup(opts: { blockSave?: boolean } = {}) {
    const adapter = makeFakeAdapter(opts)
    const initial = makeProject()
    const onBusyChange = vi.fn()
    const hook = renderHook(() => useProjectSync(adapter, initial.id, initial, { onBusyChange }))
    return { adapter, onBusyChange, ...hook }
  }

  it('a save in flight gives true, then false when it settles', async () => {
    const { adapter, onBusyChange, result } = busySetup({ blockSave: true })
    expect(onBusyChange).not.toHaveBeenCalled()
    let p: Promise<void> = Promise.resolve()
    act(() => { p = result.current.mutate((x) => ({ ...x, name: 'A' })) })
    expect(onBusyChange.mock.calls).toEqual([[true]])
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    await act(async () => { adapter.release(); await p })
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('a failed save also ends busy', async () => {
    const adapter = makeFakeAdapter({ failSave: true })
    const initial = makeProject()
    const onBusyChange = vi.fn()
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial, { onBusyChange }))
    await act(async () => { await result.current.mutate((x) => ({ ...x, name: 'A' })).catch(() => {}) })
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('a gesture open gives true, then false on commit', async () => {
    const { onBusyChange, result } = busySetup()
    act(() => { result.current.mutateTransient((x) => ({ ...x, name: 'D1' })) })
    act(() => { result.current.mutateTransient((x) => ({ ...x, name: 'D2' })) })
    expect(onBusyChange.mock.calls).toEqual([[true]])
    await act(async () => { await result.current.commit() })
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('a gesture open gives true, then false on cancel', () => {
    const { onBusyChange, result } = busySetup()
    act(() => { result.current.mutateTransient((x) => ({ ...x, name: 'D1' })) })
    act(() => { result.current.discardTransient() })
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('a gesture ended by an external frame ends busy', () => {
    const { adapter, onBusyChange, result } = busySetup()
    act(() => { result.current.mutateTransient((x) => ({ ...x, name: 'D1' })) })
    act(() => { adapter.emit(makeProject({ name: 'Ext' })) })
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('a save and a gesture that overlap give exactly one true and one false', async () => {
    const { adapter, onBusyChange, result } = busySetup({ blockSave: true })
    let p: Promise<void> = Promise.resolve()
    act(() => { p = result.current.mutate((x) => ({ ...x, name: 'A' })) })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    act(() => { result.current.mutateTransient((x) => ({ ...x, name: 'D1' })) })
    // The save settles while the gesture is still open: still busy.
    await act(async () => { adapter.release(); await p })
    expect(onBusyChange.mock.calls).toEqual([[true]])
    // Committing queues a second save; busy never dips between the two.
    let c: Promise<void> = Promise.resolve()
    act(() => { c = result.current.commit() })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(2))
    await act(async () => { adapter.release(); await c })
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('makes no calls when nothing changes', async () => {
    const { adapter, onBusyChange, result } = busySetup()
    act(() => { adapter.emit(makeProject({ name: 'Ext' })) })
    act(() => { result.current.discardTransient() })
    await act(async () => { await result.current.refetch() })
    expect(onBusyChange).not.toHaveBeenCalled()
  })

  it('with the prop absent nothing changes: no extra renders', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    let renders = 0
    const { result } = renderHook(() => { renders++; return useProjectSync(adapter, initial.id, initial) })
    const before = renders
    await act(async () => { await result.current.mutate((x) => ({ ...x, name: 'A' })) })
    const without = renders - before
    const adapter2 = makeFakeAdapter()
    let renders2 = 0
    const { result: r2 } = renderHook(() => { renders2++; return useProjectSync(adapter2, initial.id, initial, { onBusyChange: () => {} }) })
    const before2 = renders2
    await act(async () => { await r2.current.mutate((x) => ({ ...x, name: 'A' })) })
    expect(renders2 - before2).toBe(without)
  })

  it('a throwing onBusyChange neither wedges the queue nor stops saves, gestures or undo', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const onBusyChange = vi.fn(() => { throw new Error('host') })
    const { result } = renderHook(() => useProjectSync(adapter, initial.id, initial, { onBusyChange }))
    await act(async () => { await result.current.mutate((x) => ({ ...x, name: 'A' })) })
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
    expect(result.current.project.name).toBe('A')
    act(() => { result.current.mutateTransient((x) => ({ ...x, name: 'D1' })) })
    await act(async () => { await result.current.commit() })
    expect(adapter.saveProject).toHaveBeenCalledTimes(2)
    expect(result.current.project.name).toBe('D1')
    await act(async () => { result.current.undo() })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(3))
    expect(result.current.project.name).toBe('A')
    await act(async () => { await result.current.mutate((x) => ({ ...x, name: 'B' })) })
    expect(adapter.saveProject).toHaveBeenCalledTimes(4)
    expect(onBusyChange).toHaveBeenCalled()
  })

  it('unmount while busy calls nothing after it (no final false)', async () => {
    const { adapter, onBusyChange, result, unmount } = busySetup({ blockSave: true })
    let p: Promise<void> = Promise.resolve()
    act(() => { p = result.current.mutate((x) => ({ ...x, name: 'A' })) })
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    unmount()
    expect(onBusyChange.mock.calls).toEqual([[true]])
    await act(async () => { adapter.release(); await p.catch(() => {}) })
    expect(onBusyChange.mock.calls).toEqual([[true]])
  })
})
