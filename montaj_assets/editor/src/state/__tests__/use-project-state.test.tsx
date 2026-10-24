import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectState } from '../use-project-state'
import type { CarouselElement, EditorAdapter, Project, ImageElement, RenderEvent } from '../../types'

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
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
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

describe('useProjectState — editNotes (PL70)', () => {
  it('writes notes in a status that gates slide edits: one save, one undo step', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ status: 'storyboard_ready' })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.editNotes((n) => [...(n ?? []), { id: 'n1', slideId: 'slide-0', text: '' }])
    })
    expect(result.current.project.notes).toEqual([{ id: 'n1', slideId: 'slide-0', text: '' }])
    expect(adapter.saveCalls).toHaveLength(1)
    expect(adapter.saveCalls[0].project.notes).toEqual([{ id: 'n1', slideId: 'slide-0', text: '' }])
    expect(result.current.canUndo).toBe(true)

    act(() => { result.current.undo() })
    expect(result.current.project.notes).toBeUndefined()
    expect(result.current.canUndo).toBe(false)
  })

  it('an edit that returns the same notes writes nothing and pushes no undo step', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ notes: [{ id: 'n1', slideId: 'slide-0', text: 'x' }] })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => { await result.current.editNotes((n) => n) })
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('reads the live notes, so two edits in one tick chain', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      void result.current.editNotes((n) => [...(n ?? []), { id: 'a', slideId: 'slide-0', text: '' }])
      await result.current.editNotes((n) => [...(n ?? []), { id: 'b', slideId: 'slide-0', text: '' }])
    })
    expect(result.current.project.notes?.map((n) => n.id)).toEqual(['a', 'b'])
    expect(adapter.saveCalls[adapter.saveCalls.length - 1].project.notes?.map((n) => n.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// replaceImage (§556 M5): one save and one undo step, gated like every slide edit
// ---------------------------------------------------------------------------

describe('useProjectState: replaceImage', () => {
  const OLD_CROP = { x: 0, y: 0, w: 0.5, h: 0.5 }
  const NEW_CROP = { x: 0.25, y: 0, w: 0.5, h: 1 }

  function withImage(overrides: Partial<Project> = {}): Project {
    const base = makeProject(overrides)
    return {
      ...base,
      slides: base.slides!.map((s) => ({
        ...s,
        elements: s.elements.map((el) =>
          el.id === 'el-0'
            ? ({ ...el, x: 7, y: 8, w: 120, h: 90, rotation: 12, crop: OLD_CROP, mediaId: 'm-old' } as typeof el)
            : el,
        ),
      })),
    }
  }

  it('swaps the source in one save and one undo step, and the undo brings it all back', async () => {
    const adapter = makeFakeAdapter()
    const initial = withImage()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.replaceImage('slide-0', 'el-0', { src: '/proj/new.png', crop: NEW_CROP })
    })

    const el = result.current.project.slides![0].elements[0]
    expect(el).toEqual({
      id: 'el-0', type: 'image', src: '/proj/new.png', x: 7, y: 8, w: 120, h: 90, rotation: 12, crop: NEW_CROP,
    })
    expect(adapter.saveCalls).toHaveLength(1)
    expect(adapter.saveCalls[0].project.slides![0].elements[0]).toEqual(el)

    // One undo step: the old source, crop and media id are all back.
    await act(async () => { result.current.undo() })
    expect(result.current.project.slides![0].elements[0]).toEqual(initial.slides![0].elements[0])
    expect(result.current.canUndo).toBe(false)
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('clears the crop when given none', async () => {
    const adapter = makeFakeAdapter()
    const initial = withImage()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.replaceImage('slide-0', 'el-0', { src: '/proj/new.png', crop: undefined })
    })
    expect('crop' in result.current.project.slides![0].elements[0]).toBe(false)
    expect('crop' in adapter.saveCalls[0].project.slides![0].elements[0]).toBe(false)
  })

  it.each(['pending', 'storyboard_ready'] as const)('is dropped, saving nothing, while the status is "%s"', async (status) => {
    const adapter = makeFakeAdapter()
    const initial = withImage({ status })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.replaceImage('slide-0', 'el-0', { src: '/proj/new.png', crop: NEW_CROP })
    })
    expect(result.current.project.slides![0].elements[0]).toEqual(initial.slides![0].elements[0])
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('is allowed when the status is "final"', async () => {
    const adapter = makeFakeAdapter()
    const initial = withImage({ status: 'final' })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.replaceImage('slide-0', 'el-0', { src: '/proj/new.png', crop: NEW_CROP })
    })
    expect((result.current.project.slides![0].elements[0] as ImageElement).src).toBe('/proj/new.png')
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
  })

  it('is dropped, saving nothing and leaving no undo step, when the target is gone or is not an image', async () => {
    const adapter = makeFakeAdapter()
    const initial = withImage()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      // el-1 is an overlay; 'gone' does not exist; 'no-slide' is no slide.
      await result.current.replaceImage('slide-0', 'el-1', { src: '/proj/new.png', crop: NEW_CROP })
      await result.current.replaceImage('slide-0', 'gone', { src: '/proj/new.png', crop: NEW_CROP })
      await result.current.replaceImage('no-slide', 'el-0', { src: '/proj/new.png', crop: NEW_CROP })
    })
    expect(result.current.project).toBe(initial)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('rolls back and surfaces lastError when the save fails', async () => {
    const adapter = makeFakeAdapter({ failSave: true })
    const initial = withImage()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current
        .replaceImage('slide-0', 'el-0', { src: '/proj/new.png', crop: NEW_CROP })
        .catch(() => {})
    })
    expect(result.current.project.slides![0].elements[0]).toEqual(initial.slides![0].elements[0])
    expect(result.current.lastError).toMatch(/save boom/)
  })
})

// ---------------------------------------------------------------------------
// editElements (§556 review): an edit applied to the slide's elements as they
// are when it lands, not as the caller last saw them
// ---------------------------------------------------------------------------

describe('useProjectState: editElements', () => {
  const extra = { id: 'el-new', type: 'image', src: 'n.png', x: 1, y: 2, w: 30, h: 40, rotation: 0 } as const
  const ids = (p: Project) => p.slides![0].elements.map((e) => e.id)

  it('writes the edit in one save and one undo step, and undo brings the old elements back', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.editElements('slide-0', (els) => [...els, extra])
    })
    expect(ids(result.current.project)).toEqual(['el-0', 'el-1', 'el-new'])
    expect(adapter.saveCalls).toHaveLength(1)
    expect(ids(adapter.saveCalls[0].project)).toEqual(['el-0', 'el-1', 'el-new'])
    expect(result.current.canUndo).toBe(true)

    await act(async () => { result.current.undo() })
    expect(ids(result.current.project)).toEqual(['el-0', 'el-1'])
    expect(result.current.canUndo).toBe(false)
  })

  it('is applied to the elements the project holds now: an element an outside frame added is kept', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    // The caller's view is `initial`; the frame lands, and the edit follows in the same tick.
    await act(async () => {
      const base = makeProject()
      adapter.emit({ ...base, slides: [{ ...base.slides![0], elements: [...base.slides![0].elements, { ...extra, id: 'el-ai' }] }] })
      await result.current.editElements('slide-0', (els) => els.filter((e) => e.id !== 'el-0'))
    })
    expect(ids(result.current.project)).toEqual(['el-1', 'el-ai'])
    expect(ids(adapter.saveCalls[adapter.saveCalls.length - 1].project)).toEqual(['el-1', 'el-ai'])
  })

  it('two edits in one tick chain', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      void result.current.editElements('slide-0', (els) => [...els, { ...extra, id: 'a' }])
      await result.current.editElements('slide-0', (els) => [...els, { ...extra, id: 'b' }])
    })
    expect(ids(result.current.project)).toEqual(['el-0', 'el-1', 'a', 'b'])
    expect(ids(adapter.saveCalls[adapter.saveCalls.length - 1].project)).toEqual(['el-0', 'el-1', 'a', 'b'])
  })

  it('an edit that returns the same array writes nothing and pushes no undo step', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => { await result.current.editElements('slide-0', (els) => els) })
    expect(result.current.project).toBe(initial)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('calls the edit once, and not at all for a slide that is not there', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    const edit = vi.fn((els: CarouselElement[]) => [...els, extra])
    await act(async () => { await result.current.editElements('slide-0', edit) })
    expect(edit).toHaveBeenCalledTimes(1)

    const missing = vi.fn((els: CarouselElement[]) => [...els, extra])
    await act(async () => { await result.current.editElements('no-slide', missing) })
    expect(missing).not.toHaveBeenCalled()
    expect(adapter.saveCalls).toHaveLength(1)
  })

  it.each(['pending', 'storyboard_ready'] as const)('is dropped, saving nothing, while the status is "%s"', async (status) => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ status })
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => { await result.current.editElements('slide-0', (els) => [...els, extra]) })
    expect(result.current.project).toBe(initial)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('rolls back and surfaces lastError when the save fails', async () => {
    const adapter = makeFakeAdapter({ failSave: true })
    const initial = makeProject()
    const { result } = renderHook(() => useProjectState(adapter, initial.id, initial))

    await act(async () => {
      await result.current.editElements('slide-0', (els) => [...els, extra]).catch(() => {})
    })
    expect(ids(result.current.project)).toEqual(['el-0', 'el-1'])
    expect(result.current.lastError).toMatch(/save boom/)
  })
})
