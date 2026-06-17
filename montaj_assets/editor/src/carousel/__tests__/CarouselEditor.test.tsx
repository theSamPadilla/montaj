import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

// ── Fake adapter (mirrors editor-core's use-project-state test pattern) ───────
// The package owns the assembled editor now: no host (`@/`) modules are mocked.
// A full fake `EditorAdapter` drives load/save/render and the overlay-list /
// upload / fileUrl primitives the assembled editor consumes.

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
  } as Project
}

interface FakeAdapter extends EditorAdapter<Project> {
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
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
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
  it('renders the host-supplied assetsPanel slot', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const { getByTestId } = render(
      <CarouselEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ assetsPanel: <div data-testid="assets" /> }}
      />,
    )
    await waitFor(() => getByTestId('assets'))
  })

  // Regression: SlideGrid thumbnails must receive `compileOverlay` so overlay
  // elements render in the left rail. Before the fix the thumbnail used a
  // noopCompiler that always rejected → a red "overlay error" badge on every
  // overlay; adapter.compileOverlay was called ONCE (main canvas only). With the
  // fix the thumbnail (non-interactive SlideCanvas) routes through
  // adapter.compileOverlay too, so the SAME overlay is compiled twice
  // (thumbnail + main). We assert the compiler is threaded to the thumbnail
  // (call count ≥ 2) — the precise fix. (We don't assert the rendered overlay
  // output: the fake factory can't render in jsdom, which is orthogonal to this
  // bug; the real render is verified in the browser.)
  it('threads compileOverlay into slide thumbnails (compiles overlay for thumbnail + main)', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({
      slides: [
        {
          id: 'slide-ov',
          base_color: '#ffffff',
          elements: [
            {
              id: 'el-ov',
              type: 'overlay',
              overlay: { template: '/overlays/lp-text.jsx', props: { text: 'Puerta' } },
              frame: 0,
              x: 100, y: 800, w: 880, h: 160, rotation: 0,
            },
          ],
        },
      ],
    })
    render(<CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} />)
    // ≥2 calls proves the thumbnail uses adapter.compileOverlay (not noopCompiler).
    // Under the bug this is exactly 1 (main canvas only) and this times out.
    await waitFor(() =>
      expect((adapter.compileOverlay as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2),
    )
  })

  it('renders the host-supplied pendingStatus slot in the pending view', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ status: 'pending', slides: [] })
    const { getByTestId, queryByText } = render(
      <CarouselEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending-status">Agent is working: → step 2</div> }}
      />,
    )
    await waitFor(() => getByTestId('pending-status'))
    // The slot replaces the default empty-state copy.
    expect(queryByText('Message your agent to start')).toBeNull()
  })

  it('shows the default empty-state copy when pendingStatus slot is absent', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({ status: 'pending', slides: [] })
    const { getByText } = render(
      <CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} />,
    )
    await waitFor(() => getByText('Message your agent to start'))
  })

  it('selecting an element, moving it, then undo reverts the position', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()

    render(
      <CarouselEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ assetsPanel: <div data-testid="assets" /> }}
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
    render(<CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} />)

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

  // Visibility toggle: ids in `hiddenElementIds` are omitted from the interactive
  // canvas (editor-only; the thumbnail and `saveProject` are untouched).
  it('omits hidden elements from the interactive canvas', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject({
      slides: [
        {
          id: 'slide-0',
          base_color: '#ffffff',
          elements: [
            { id: 'el-a', type: 'image', src: 'a.png', x: 0, y: 0, w: 100, h: 100, rotation: 0 },
            { id: 'el-b', type: 'image', src: 'b.png', x: 10, y: 10, w: 100, h: 100, rotation: 0 },
          ],
        },
      ],
    })
    const { container } = render(
      <CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} hiddenElementIds={['el-b']} />,
    )
    // Visible element renders in the interactive canvas; hidden one does not.
    await waitFor(() => expect(container.querySelector('[data-interactive] [data-element-id="el-a"]')).not.toBeNull())
    expect(container.querySelector('[data-interactive] [data-element-id="el-b"]')).toBeNull()
  })

  // onSelectionChange fires with the selected element, and with null on deselect.
  it('fires onSelectionChange on select and deselect', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    const onSelectionChange = vi.fn()
    const { container } = render(
      <CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} onSelectionChange={onSelectionChange} />,
    )

    const lastSelection = () => {
      const calls = onSelectionChange.mock.calls
      return calls[calls.length - 1]?.[0]
    }

    const wrapper = await waitFor(() => findInteractiveWrapper('el-img'))
    await act(async () => { fireEvent.click(wrapper) })
    await waitFor(() => {
      expect(lastSelection()?.id).toBe('el-img')
    })

    // Click the interactive canvas background to clear selection.
    const root = container.querySelector('[data-interactive]') as HTMLElement
    await act(async () => { fireEvent.click(root) })
    await waitFor(() => {
      expect(lastSelection()).toBeNull()
    })
  })
})
