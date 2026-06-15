import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectState } from '../use-project-state'
import type { EditorAdapter, Project, ImageElement, RenderEvent } from '../../types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: '1',
    id: 'proj-1',
    name: 'Test Project',
    workflow: 'carousel',
    status: 'draft', // editable so mutations are not gated out
    editingPrompt: '',
    settings: { resolution: [1080, 1080] },
    assets: [],
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [
          { id: 'el-0', type: 'image', src: 'a.png', x: 0, y: 0, w: 100, h: 100, rotation: 0 },
          {
            id: 'el-1',
            type: 'overlay',
            overlay: { template: 't', props: { text: 'hi' } },
            frame: 0,
            x: 0,
            y: 0,
            w: 50,
            h: 50,
            rotation: 0,
          },
        ],
      },
    ],
    ...overrides,
  }
}

interface FakeAdapter extends EditorAdapter {
  emit: (p: Project) => void
  saveCalls: Array<{ id: string; project: Project }>
}

function makeFakeAdapter(opts: { failSave?: boolean } = {}): FakeAdapter {
  let onFrame: ((p: Project) => void) | null = null
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => {
      saveCalls.push({ id, project })
      if (opts.failSave) throw new Error('save boom')
    }),
    subscribe: (_id: string, cb: (p: Project) => void) => {
      onFrame = cb
      return () => { onFrame = null }
    },
    render: async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out.png' }
    },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    emit: (p: Project) => onFrame?.(p),
    saveCalls,
  }
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useProjectState — adapter wiring', () => {
  it('optimistically applies a mutation and persists via adapter.saveProject', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.updateOverlayProp('slide-0', 'el-1', 'text', 'bye')
    })

    // Optimistic local state updated.
    const el = result.current.project.slides![0].elements[1]
    expect(el.type === 'overlay' && el.overlay.props.text).toBe('bye')
    // Persisted through the adapter, not a hardcoded fetch.
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
    expect(adapter.saveCalls[0].id).toBe('proj-1')
  })

  it('rolls back optimistic state and surfaces lastError when saveProject fails', async () => {
    const adapter = makeFakeAdapter({ failSave: true })
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.updateOverlayProp('slide-0', 'el-1', 'text', 'bye').catch(() => {})
    })

    const el = result.current.project.slides![0].elements[1]
    // Rolled back to original value.
    expect(el.type === 'overlay' && el.overlay.props.text).toBe('hi')
    expect(result.current.lastError).toMatch(/save boom/)
  })

  it('applies SSE frames pushed through adapter.subscribe', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    const frame = makeProject({ name: 'From Server', status: 'final' })
    act(() => { adapter.emit(frame) })

    await waitFor(() => {
      expect(result.current.project.name).toBe('From Server')
      expect(result.current.connection).toBe('live')
    })
  })

  it('undo/redo swap state and re-persist via adapter', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.setName('Renamed')
    })
    expect(result.current.project.name).toBe('Renamed')
    expect(result.current.canUndo).toBe(true)

    await act(async () => { result.current.undo() })
    expect(result.current.project.name).toBe('Test Project')
    expect(result.current.canRedo).toBe(true)

    await act(async () => { result.current.redo() })
    expect(result.current.project.name).toBe('Renamed')

    // mutate save + undo save + redo save
    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(3))
  })

  it('commit persists one save after transient gesture mutations', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.moveElement('slide-0', 'el-0', 10, 20)
      await result.current.moveElement('slide-0', 'el-0', 30, 40)
    })
    // Transient moves do not save.
    expect(adapter.saveProject).not.toHaveBeenCalled()
    const moved = result.current.project.slides![0].elements[0]
    expect(moved.x).toBe(30)
    expect(moved.y).toBe(40)

    await act(async () => { await result.current.commit() })
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
    expect(result.current.canUndo).toBe(true)
  })

  it('unsubscribes on unmount', () => {
    const adapter = makeFakeAdapter()
    const unsub = vi.fn()
    adapter.subscribe = (_id, _cb) => unsub
    const initial = makeProject()
    const { unmount } = renderHook(() => useProjectState(adapter, initial.id, initial))
    unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Status gating — slide-CRUD actions are no-ops when project is not editable
// ---------------------------------------------------------------------------

describe('useProjectState — addSlide is status-gated', () => {
  it('no-ops addSlide and does not save when project status is "pending"', async () => {
    const adapter = makeFakeAdapter()
    // Override loadProject to return a pending project, but we pass initial directly
    const initial = makeProject({ status: 'pending' })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.addSlide({
        id: 'slide-new',
        base_color: '#ff0000',
        elements: [],
      })
    })

    // State must not have gained a slide
    expect(result.current.project.slides).toHaveLength(initial.slides!.length)
    // Adapter must not have been asked to save
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('no-ops addSlide when project status is "storyboard_ready"', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ status: 'storyboard_ready' })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.addSlide({
        id: 'slide-new',
        base_color: '#0000ff',
        elements: [],
      })
    })

    expect(result.current.project.slides).toHaveLength(initial.slides!.length)
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('allows addSlide when project status is "draft"', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ status: 'draft' })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.addSlide({
        id: 'slide-new',
        base_color: '#00ff00',
        elements: [],
      })
    })

    expect(result.current.project.slides).toHaveLength(initial.slides!.length + 1)
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
  })

  it('allows addSlide when project status is "final"', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ status: 'final' })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.addSlide({
        id: 'slide-new',
        base_color: '#00ff00',
        elements: [],
      })
    })

    expect(result.current.project.slides).toHaveLength(initial.slides!.length + 1)
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
  })
})
