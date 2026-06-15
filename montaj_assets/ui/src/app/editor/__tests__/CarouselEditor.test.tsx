import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { EditorAdapter, Project, ImageElement, RenderEvent } from '@/editor-core/types'

// ── Module mocks ────────────────────────────────────────────────────────────
// CarouselEditor mounts a few child panels that hit Montaj's HTTP API and the
// overlay compiler. Stub them so the component renders headless.
vi.mock('@/lib/api', () => ({
  api: {
    getInfo: vi.fn(async () => ({ root_skill_path: 'skill', skill_path: '', style_profile_skill_path: '' })),
    listGlobalOverlays: vi.fn(async () => []),
    listProfileOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    saveProject: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => 'x.png'),
    pickFiles: vi.fn(async () => ({ paths: [] })),
  },
}))

vi.mock('@/lib/overlay-eval', () => ({
  compileOverlay: vi.fn(async () => () => null),
}))

import CarouselEditor from '../CarouselEditor'

// ── Fake adapter (mirrors editor-core's use-project-state test pattern) ───────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: '1',
    id: 'proj-1',
    name: 'Test',
    workflow: 'carousel',
    status: 'draft',
    editingPrompt: '',
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    assets: [],
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [
          {
            id: 'el-img',
            type: 'image',
            src: 'a.png',
            x: 100,
            y: 100,
            w: 200,
            h: 200,
            rotation: 0,
          },
        ],
      },
    ],
    ...overrides,
  }
}

interface FakeAdapter extends EditorAdapter {
  saveCalls: Array<{ id: string; project: Project }>
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out.png' }
    },
    resolveImageSrc: (el: ImageElement) => el.src,
    saveCalls,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // ResizeObserver isn't in jsdom.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => vi.restoreAllMocks())

// The element id appears twice in the DOM: once in the left-rail thumbnail
// (non-interactive SlideCanvas) and once in the main interactive canvas. The
// interactive canvas renders last, so take the final match.
function findInteractiveWrapper(elementId: string): HTMLElement {
  const els = document.querySelectorAll(`[data-element-id="${elementId}"]`)
  if (els.length === 0) throw new Error(`element wrapper ${elementId} not found`)
  return els[els.length - 1] as HTMLElement
}

describe('CarouselEditor — editor-core integration', () => {
  it('selecting an element, moving it, then undo reverts the position', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()

    render(
      <CarouselEditor
        project={initial}
        adapter={adapter}
        onProjectChange={() => {}}
      />,
    )

    // The interactive slide canvas renders the image element wrapper.
    const wrapper = await waitFor(() => findInteractiveWrapper('el-img'))

    // Select the element (click).
    await act(async () => { fireEvent.click(wrapper) })

    // Perform a drag: pointer-down on the wrapper, move on window, up on window.
    await act(async () => {
      fireEvent.pointerDown(wrapper, { clientX: 150, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 250, clientY: 250 })
      fireEvent.pointerUp(window)
    })

    // The move + commit persisted a new position via the adapter.
    await waitFor(() => {
      expect(adapter.saveCalls.length).toBeGreaterThan(0)
    })
    const movedSave = adapter.saveCalls[adapter.saveCalls.length - 1].project
    const movedEl = movedSave.slides![0].elements[0]
    expect(movedEl.x).not.toBe(100)

    const savesBeforeUndo = adapter.saveCalls.length

    // Undo via keyboard shortcut (Cmd/Ctrl+Z). Guarded paths require the target
    // not be a text input — fire on document.body.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    })

    // Undo enqueues a save that restores the original position.
    await waitFor(() => {
      expect(adapter.saveCalls.length).toBeGreaterThan(savesBeforeUndo)
    })
    const undoneSave = adapter.saveCalls[adapter.saveCalls.length - 1].project
    const undoneEl = undoneSave.slides![0].elements[0]
    expect(undoneEl.x).toBe(100)
    expect(undoneEl.y).toBe(100)
  })

  it('does not fire undo while typing in an input', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    render(<CarouselEditor project={initial} adapter={adapter} onProjectChange={() => {}} />)

    await waitFor(() => findInteractiveWrapper('el-img'))

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const before = adapter.saveCalls.length
    await act(async () => {
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true })
    })
    // No undo save should have been enqueued.
    expect(adapter.saveCalls.length).toBe(before)
    document.body.removeChild(input)
  })
})
