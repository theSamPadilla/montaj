import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import { Keyboard, MousePointer2 } from 'lucide-react'
import type { CarouselRenderModalContext, ControlsWindowContext, EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent, SlideNotesApi, SlidePin } from '../../types'
import type { SlideNote } from '../../schema'
import CarouselEditor from '../CarouselEditor'
import { CAROUSEL_CONTROLS } from '../../ControlsInfoModal'
import { stubPlatform } from '../../ui/__tests__/platform'

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
    // The assets slot lives in the below-canvas region, full-width at the very
    // bottom (no longer capped to a 320px sidebar) so the host panel spans the
    // editor width beneath the top canvas/editing region.
    const wrapper = getByTestId('assets').parentElement
    expect(wrapper?.className).toContain('w-full')
    expect(wrapper?.className).not.toContain('w-80')
  })

  // The root sets the editor text colour (as VideoEditor's root does), so chrome
  // that inherits colour reads --editor-text instead of the host page's colour.
  it('sets the editor text colour on its root', async () => {
    const adapter = makeFakeAdapter()
    const { container } = render(
      <CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('bg-[var(--editor-bg)]')
    expect(root.className).toContain('text-[var(--editor-text)]')
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

    // Undo via keyboard shortcut (Cmd/Ctrl+Z). The editor's keymap listens on
    // the document and skips text inputs, so fire on the document itself.
    await act(async () => {
      fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
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

  // Delete / Backspace removes the selected element and persists the removal.
  it('deletes the selected element on Delete keypress', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    render(<CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} />)

    const wrapper = await waitFor(() => findInteractiveWrapper('el-img'))
    await act(async () => { fireEvent.click(wrapper) })

    await act(async () => { fireEvent.keyDown(document, { key: 'Delete' }) })

    // The removal is persisted: the latest saved project has no elements.
    await waitFor(() => {
      expect(adapter.saveCalls.length).toBeGreaterThan(0)
      const saved = adapter.saveCalls[adapter.saveCalls.length - 1].project
      expect(saved.slides![0].elements.find(e => e.id === 'el-img')).toBeUndefined()
    })
  })

  // Guard: Delete/Backspace must not delete while typing (e.g. editing text or a
  // panel field), or Backspace in a field would wipe the element.
  it('does not delete the selected element while typing in an input', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    render(<CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} />)

    const wrapper = await waitFor(() => findInteractiveWrapper('el-img'))
    await act(async () => { fireEvent.click(wrapper) })

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const before = adapter.saveCalls.length
    await act(async () => { fireEvent.keyDown(input, { key: 'Backspace' }) })
    expect(adapter.saveCalls.length).toBe(before)
    document.body.removeChild(input)
  })

  // PL1: a host can own the carousel's render window too. The package hands
  // it everything CarouselRenderModal was given and never renders itself.
  it('renderModal replaces CarouselRenderModal and gets everything it was given', async () => {
    const adapter = makeFakeAdapter()
    adapter.render = vi.fn(async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out' }
    }) as unknown as typeof adapter.render
    const seen: CarouselRenderModalContext<Project>[] = []
    const { findByTitle, findByTestId, queryByTestId } = render(
      <CarouselEditor
        project={makeProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div data-testid="host-export-actions" /> }}
        renderModal={(ctx) => {
          seen.push(ctx)
          return ctx.open ? <div data-testid="host-render-window">{ctx.exportActions}</div> : null
        }}
      />,
    )

    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[seen.length - 1].open).toBe(false)

    const renderBtn = await findByTitle('Render all slides as PNGs')
    await act(async () => { fireEvent.click(renderBtn) })

    await findByTestId('host-render-window')
    expect(queryByTestId('host-export-actions')).not.toBeNull()
    expect(adapter.render).not.toHaveBeenCalled()
    const ctx = seen[seen.length - 1]
    expect(ctx.open).toBe(true)
    expect(ctx.projectId).toBe('proj-1')
    expect(ctx.adapter).toBe(adapter)
    expect(ctx.slidesCount).toBe(1)
    expect(ctx.resolution).toEqual([1080, 1080])
    expect(['light', 'dark']).toContain(ctx.mode)
    // The Render click still saved the project as final first.
    await waitFor(() => expect(adapter.saveCalls.some((c) => c.project.status === 'final')).toBe(true))

    await act(async () => { ctx.onClose() })
    await waitFor(() => expect(queryByTestId('host-render-window')).toBeNull())
  })

  // §448: a host that places Export in its own header (as the video editor's
  // host does) takes the trigger; the in-canvas toolbar button goes away.
  it('onProvideRenderTrigger hides the toolbar Render button and hands the host a working trigger', async () => {
    const adapter = makeFakeAdapter()
    const seen: CarouselRenderModalContext<Project>[] = []
    let trigger: (() => void) | undefined
    const { findByTestId, queryByTitle, queryByText } = render(
      <CarouselEditor
        project={makeProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        onProvideRenderTrigger={(fn) => { trigger = fn }}
        renderModal={(ctx) => {
          seen.push(ctx)
          return ctx.open ? <div data-testid="host-render-window" /> : null
        }}
      />,
    )
    await waitFor(() => expect(trigger).toBeDefined())
    expect(queryByTitle('Render all slides as PNGs')).toBeNull()
    expect(queryByText('Render')).toBeNull()
    await act(async () => { trigger!() })
    await findByTestId('host-render-window')
    await waitFor(() => expect(adapter.saveCalls.some((c) => c.project.status === 'final')).toBe(true))
  })

  // §337: Render never uses a system alert. A save that fails, or never
  // answers, goes to the host's onError and Render comes back.
  it('a failed save on Render calls onError, never alert, and re-enables Render', async () => {
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)
    const adapter = makeFakeAdapter()
    ;(adapter.saveProject as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('HTTP 500: disk full') })
    const onError = vi.fn()
    const seen: CarouselRenderModalContext<Project>[] = []
    const { findByTitle } = render(
      <CarouselEditor
        project={makeProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        onError={onError}
        renderModal={(ctx) => { seen.push(ctx); return null }}
      />,
    )
    const renderBtn = await findByTitle('Render all slides as PNGs')
    await act(async () => { fireEvent.click(renderBtn) })

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError).toHaveBeenCalledWith({ title: "Couldn't start the render", detail: 'HTTP 500: disk full' })
    expect(alertSpy).not.toHaveBeenCalled()
    expect(seen[seen.length - 1].open).toBe(false)
    await waitFor(() => expect((renderBtn as HTMLButtonElement).disabled).toBe(false))
    expect(renderBtn.textContent).toContain('Render')
    vi.unstubAllGlobals()
  })

  it('a save that never answers times out into onError and re-enables Render', async () => {
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)
    const adapter = makeFakeAdapter()
    ;(adapter.saveProject as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(() => {}))
    const onError = vi.fn()
    const seen: CarouselRenderModalContext<Project>[] = []
    const { findByTitle } = render(
      <CarouselEditor
        project={makeProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        onError={onError}
        renderSaveTimeoutMs={50}
        renderModal={(ctx) => { seen.push(ctx); return null }}
      />,
    )
    const renderBtn = await findByTitle('Render all slides as PNGs')
    await act(async () => { fireEvent.click(renderBtn) })
    expect(renderBtn.textContent).toContain('Starting…')

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError).toHaveBeenCalledWith({ title: "Couldn't start the render", detail: 'The project did not save in time.' })
    expect(alertSpy).not.toHaveBeenCalled()
    expect(seen[seen.length - 1].open).toBe(false)
    await waitFor(() => expect((renderBtn as HTMLButtonElement).disabled).toBe(false))
    expect(renderBtn.textContent).toContain('Render')
    vi.unstubAllGlobals()
  })

  // PL14: a host can draw the carousel's Controls window too, with the
  // modal's exact content already resolved for the platform.
  it('renderControls replaces ControlsInfoModal and gets the platform-resolved sections', async () => {
    const restore = stubPlatform('Win32')
    try {
      const seen: ControlsWindowContext[] = []
      const { findByRole, findByTestId, queryByTestId, queryByRole } = render(
        <CarouselEditor
          project={makeProject()}
          adapter={makeFakeAdapter()}
          onProjectChange={vi.fn()}
          renderControls={(ctx) => {
            seen.push(ctx)
            return ctx.open ? <div data-testid="host-controls" /> : null
          }}
        />,
      )

      const trigger = await findByRole('button', { name: 'Editor controls & shortcuts' })
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[seen.length - 1].open).toBe(false)
      expect(queryByTestId('host-controls')).toBeNull()

      await act(async () => { fireEvent.click(trigger) })

      await findByTestId('host-controls')
      expect(queryByRole('dialog', { name: 'Editor controls' })).toBeNull()

      const ctx = seen[seen.length - 1]
      expect(ctx.open).toBe(true)
      expect(ctx.kind).toBe('carousel')
      expect(ctx.title).toBe('Editor controls')
      expect(ctx.sections.map((s) => [s.heading, s.icon])).toEqual([
        ['Canvas', MousePointer2],
        ['Keyboard', Keyboard],
      ])
      expect(ctx.sections.map((s) => s.entries.map((e) => e.label))).toEqual(
        CAROUSEL_CONTROLS.map((s) => s.entries.map((e) => e.label)),
      )
      const keyboard = ctx.sections.find((s) => s.heading === 'Keyboard')!
      expect(keyboard.entries.map((e) => e.keys)).toEqual([
        ['Ctrl', 'Z'],
        ['Ctrl', 'Shift', 'Z'],
        ['Delete'],
        ['N'],
        ['Ctrl', 'C'],
        ['Ctrl', 'X'],
        ['Ctrl', 'V'],
        ['Ctrl', 'D'],
        ['Ctrl', 'A'],
        ['←', '↑', '↓', '→'],
        ['Shift', '←', '↑', '↓', '→'],
        ['Ctrl', ']'],
        ['Ctrl', '['],
        ['Ctrl', 'Alt', ']'],
        ['Ctrl', 'Alt', '['],
        ['Esc'],
      ])

      const calls = seen.length
      await act(async () => { ctx.onClose() })
      await waitFor(() => expect(queryByTestId('host-controls')).toBeNull())
      expect(seen.length).toBeGreaterThan(calls)
      expect(seen[calls].open).toBe(false)
    } finally {
      restore()
    }
  })

  it('without renderControls, the Controls trigger opens the package modal', async () => {
    const { findByRole } = render(
      <CarouselEditor project={makeProject()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} />,
    )
    const trigger = await findByRole('button', { name: 'Editor controls & shortcuts' })
    await act(async () => { fireEvent.click(trigger) })
    await findByRole('dialog', { name: 'Editor controls' })
  })
})

describe('CarouselEditor — platform shortcut labels', () => {
  async function renderEditor() {
    const r = render(
      <CarouselEditor project={makeProject()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} />,
    )
    await waitFor(() => r.getByLabelText('Undo'))
    return r
  }

  it('Windows: Undo and Redo titles and the help line say Ctrl', async () => {
    const restore = stubPlatform('Win32')
    try {
      const { getByLabelText, container } = await renderEditor()
      expect(getByLabelText('Undo').getAttribute('title')).toBe('Undo (Ctrl+Z)')
      expect(getByLabelText('Redo').getAttribute('title')).toBe('Redo (Ctrl+Shift+Z)')
      expect(container.textContent).toContain('Ctrl+Z to undo.')
    } finally {
      restore()
    }
  })

  it('Mac: titles and the help line use the glyphs', async () => {
    const restore = stubPlatform('MacIntel')
    try {
      const { getByLabelText, container } = await renderEditor()
      expect(getByLabelText('Undo').getAttribute('title')).toBe('Undo (⌘Z)')
      expect(getByLabelText('Redo').getAttribute('title')).toBe('Redo (⌘⇧Z)')
      expect(container.textContent).toContain('⌘Z to undo.')
    } finally {
      restore()
    }
  })
})

// ── PL70 — the user's own notes on a carousel ─────────────────────────────────
//
// Notes are a host opt-in, as in the video editor: with `notes` passed, N on
// the selected slide arms a pin, and the next click on the slide adds a note at
// that point (Esc or a second N adds one about the whole slide). Every note
// write is one save and one undo step, observed here as one `saveProject`.

function twoSlides(overrides: Partial<Project> = {}): Project {
  return makeProject({
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [{ id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 }],
      },
      {
        id: 'slide-1',
        base_color: '#000000',
        elements: [{ id: 'el-b', type: 'image', src: 'b.png', x: 0, y: 0, w: 100, h: 100, rotation: 0 }],
      },
    ],
    ...overrides,
  })
}

function lastSave(adapter: FakeAdapter): Project {
  return adapter.saveCalls[adapter.saveCalls.length - 1].project
}

// On the document by default, where the editor's keymap listens; it bubbles on
// to the window, where SlideCanvas's crop Esc and the Controls window listen.
async function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })
  await act(async () => { target.dispatchEvent(e) })
  return e
}

function armLayer(): HTMLElement | null {
  return document.querySelector('[data-testid="note-arm-layer"]')
}

// jsdom lays nothing out, so the layer's box is stubbed: 200 x 400 at (100, 50).
function stubRect(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: 200, height: 400, x: 100, y: 50, right: 300, bottom: 450, toJSON: () => ({}) }) as DOMRect
}

function interactiveHas(elementId: string): boolean {
  return document.querySelector(`[data-interactive] [data-element-id="${elementId}"]`) !== null
}

describe('CarouselEditor — N adds a note (PL70)', () => {
  it('N arms a pin on the selected slide, and the next click on the slide adds a note at that point', async () => {
    const adapter = makeFakeAdapter()
    const onNoteAdded = vi.fn()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true, onNoteAdded }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))

    const e = await key('n')
    expect(e.defaultPrevented).toBe(true)
    // Arming alone writes nothing.
    expect(adapter.saveCalls).toHaveLength(0)
    const layer = armLayer()!
    expect(layer).not.toBeNull()
    expect(layer.closest('[data-interactive]')).not.toBeNull()
    // An arrow with a chip, falling back to a crosshair (§143).
    expect(layer.style.cursor).toContain('data:image/svg+xml')
    expect(layer.style.cursor).toMatch(/,\s*crosshair$/)

    stubRect(layer)
    await act(async () => { fireEvent.click(layer, { clientX: 150, clientY: 150 }) })

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const notes = lastSave(adapter).notes as SlideNote[]
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ slideId: 'slide-0', x: 0.25, y: 0.25, text: '' })
    expect(notes[0].id).toBeTruthy()
    expect(onNoteAdded).toHaveBeenCalledTimes(1)
    expect(onNoteAdded).toHaveBeenCalledWith(notes[0])
    // One click, one note: the pin is disarmed.
    expect(armLayer()).toBeNull()
  })

  it('a click outside the slide box still lands on the slide, clamped into 0..1', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await key('n')
    const layer = armLayer()!
    stubRect(layer)
    await act(async () => { fireEvent.click(layer, { clientX: 400, clientY: 0 }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect((lastSave(adapter).notes as SlideNote[])[0]).toMatchObject({ x: 1, y: 0 })
  })

  // The canvas draws the slide at one uniform scale, so a click's fraction of
  // the drawn box is its fraction of the slide's design size: the scale
  // cancels. Pinned at a non-square size and a scale well below 1.
  it('stores the click as fractions of the design size at any canvas scale', async () => {
    const adapter = makeFakeAdapter()
    const project = makeProject({ settings: { resolution: [1080, 1350] } })
    const { container } = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))

    // The interactive SlideCanvas box is the design size times the canvas scale.
    const box = container.querySelector('[data-interactive]') as HTMLElement
    const boxW = parseFloat(box.style.width)
    const boxH = parseFloat(box.style.height)
    const scale = boxW / 1080
    expect(scale).toBeGreaterThan(0)
    expect(scale).toBeLessThan(0.9)
    expect(boxH / 1350).toBeCloseTo(scale, 9)

    await key('n')
    const layer = armLayer()!
    // The layer fills the box, so its rect is the box's rect.
    expect(layer.parentElement).toBe(box)
    expect([layer.style.width, layer.style.height]).toEqual(['100%', '100%'])
    const rect = { left: 40, top: 20, width: boxW, height: boxH }
    for (const el of [box, layer]) {
      el.getBoundingClientRect = () =>
        ({ ...rect, x: rect.left, y: rect.top, right: rect.left + boxW, bottom: rect.top + boxH, toJSON: () => ({}) }) as DOMRect
    }

    // Design point (270, 1012.5) of the 1080 x 1350 slide, in screen pixels.
    await act(async () => {
      fireEvent.click(layer, { clientX: rect.left + 270 * scale, clientY: rect.top + 1012.5 * scale })
    })

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const note = (lastSave(adapter).notes as SlideNote[])[0]
    expect(note.x).toBeCloseTo(270 / 1080, 9)
    expect(note.y).toBeCloseTo(1012.5 / 1350, 9)
  })

  it.each([['Escape'], ['n']])('N then %s adds a note about the whole slide (no point)', async (second) => {
    const adapter = makeFakeAdapter()
    const onNoteAdded = vi.fn()
    render(<CarouselEditor project={twoSlides()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true, onNoteAdded }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))

    await key('n')
    const e = await key(second)
    expect(e.defaultPrevented).toBe(true)

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const notes = lastSave(adapter).notes as SlideNote[]
    expect(notes).toHaveLength(1)
    expect(notes[0]).toEqual({ id: notes[0].id, slideId: 'slide-0', text: '' })
    expect(onNoteAdded).toHaveBeenCalledWith(notes[0])
    expect(armLayer()).toBeNull()
  })

  it('a press anywhere else disarms without adding, and so does selecting another slide', async () => {
    const adapter = makeFakeAdapter()
    const provided: Array<SlideNotesApi | null> = []
    render(
      <CarouselEditor
        project={twoSlides()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        notes={{ enabled: true }}
        onProvideNotesApi={(api) => { provided.push(api) }}
      />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))

    await key('n')
    expect(armLayer()).not.toBeNull()
    await act(async () => { fireEvent.pointerDown(document.body) })
    expect(armLayer()).toBeNull()
    // Esc with nothing armed is not a note.
    const esc = await key('Escape')
    expect(esc.defaultPrevented).toBe(false)

    await key('n')
    expect(armLayer()).not.toBeNull()
    await act(async () => { provided[provided.length - 1]!.selectSlide('slide-1') })
    await waitFor(() => expect(interactiveHas('el-b')).toBe(true))
    expect(armLayer()).toBeNull()
    await key('Escape')

    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('N in a text input, with Cmd, Ctrl or Alt, as a key repeat, or in crop mode writes nothing', async () => {
    const adapter = makeFakeAdapter()
    const onNoteAdded = vi.fn()
    const onLocked = vi.fn()
    const { findByTitle } = render(
      <CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true, onNoteAdded, onLocked }} />,
    )
    const wrapper = await waitFor(() => findInteractiveWrapper('el-img'))

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      const typed = await key('n', {}, input)
      expect(typed.defaultPrevented).toBe(false)
      for (const mod of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        const e = await key('n', mod)
        expect(e.defaultPrevented).toBe(false)
      }
      await key('n', { repeat: true })
      expect(armLayer()).toBeNull()

      // Crop mode: select the image, press its Crop button, then N twice (a
      // second N would add a note if the first had armed).
      await act(async () => { fireEvent.click(wrapper) })
      const crop = await findByTitle('Crop image')
      await act(async () => { fireEvent.click(crop) })
      await key('n')
      expect(armLayer()).toBeNull()
      await key('n')

      expect(adapter.saveCalls).toHaveLength(0)
      expect(onNoteAdded).not.toHaveBeenCalled()
      expect(onLocked).not.toHaveBeenCalled()
    } finally {
      input.remove()
    }
  })

  it('Shift+N arms like N, as on video', async () => {
    const adapter = makeFakeAdapter()
    const onNoteAdded = vi.fn()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true, onNoteAdded }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))

    const e = await key('N', { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(armLayer()).not.toBeNull()
    await key('N', { shiftKey: true })

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const notes = lastSave(adapter).notes as SlideNote[]
    expect(notes).toEqual([{ id: notes[0].id, slideId: 'slide-0', text: '' }])
    expect(onNoteAdded).toHaveBeenCalledTimes(1)
  })

  it('with notes locked, N calls onLocked once, even when held, and writes nothing', async () => {
    const adapter = makeFakeAdapter()
    const onLocked = vi.fn()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: false, onLocked }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))

    await key('n')
    await key('n', { repeat: true })
    await key('n', { repeat: true })
    expect(armLayer()).toBeNull()
    await key('Escape')

    expect(onLocked).toHaveBeenCalledTimes(1)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('one undo removes the note just added', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))

    await key('n')
    await key('Escape')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).notes).toHaveLength(1)

    await key('z', { ctrlKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(lastSave(adapter).notes ?? []).toEqual([])
  })

  it('writes a note even while the project status gates slide edits', async () => {
    const adapter = makeFakeAdapter()
    render(
      <CarouselEditor project={makeProject({ status: 'storyboard_ready' })} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true }} />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))

    await key('n')
    await key('Escape')

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).notes).toHaveLength(1)
    expect(lastSave(adapter).status).toBe('storyboard_ready')
  })

  it('without notes props, N is not claimed, nothing arms, and there is no pin layer', async () => {
    const adapter = makeFakeAdapter()
    const { container } = render(<CarouselEditor project={twoSlides()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-img'))

    const e = await key('n')
    expect(e.defaultPrevented).toBe(false)
    expect(armLayer()).toBeNull()
    await key('n')
    await key('Escape')

    expect(adapter.saveCalls).toHaveLength(0)
    expect(container.querySelector('[data-note-pins]')).toBeNull()
    expect(container.querySelector('[data-slide-note-bubble]')).toBeNull()
  })
})

describe('CarouselEditor — onProvideNotesApi (PL70)', () => {
  async function mountWithApi(project: Project = twoSlides()) {
    const adapter = makeFakeAdapter()
    const onNoteAdded = vi.fn()
    const provided: Array<SlideNotesApi | null> = []
    const utils = render(
      <CarouselEditor
        project={project}
        adapter={adapter}
        onProjectChange={vi.fn()}
        notes={{ enabled: true, onNoteAdded }}
        onProvideNotesApi={(api) => { provided.push(api) }}
      />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))
    const api = provided[provided.length - 1]
    if (!api) throw new Error('no notes api was provided')
    return { adapter, api, provided, onNoteAdded, utils }
  }

  it('add saves one note per call and returns its id, with or without a point', async () => {
    const { adapter, api, onNoteAdded } = await mountWithApi()
    let a = ''
    let b = ''
    // Two adds in one tick chain: the second save carries both.
    await act(async () => {
      a = api.add('slide-1')
      b = api.add('slide-0', { x: 0.5, y: 2 })
    })

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(lastSave(adapter).notes).toEqual([
      { id: a, slideId: 'slide-1', text: '' },
      { id: b, slideId: 'slide-0', x: 0.5, y: 1, text: '' },
    ])
    // The caller already has the id; onNoteAdded is the N key's report.
    expect(onNoteAdded).not.toHaveBeenCalled()
  })

  it('setText, setDone, setPoint and remove each write once, through the slide note model', async () => {
    const { adapter, api } = await mountWithApi(twoSlides({ notes: [{ id: 'n1', slideId: 'slide-0', text: '' }] }))

    await act(async () => { api.setText('n1', 'logo too small') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).notes).toEqual([{ id: 'n1', slideId: 'slide-0', text: 'logo too small' }])

    await act(async () => { api.setDone('n1', true) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(lastSave(adapter).notes).toEqual([{ id: 'n1', slideId: 'slide-0', text: 'logo too small', done: true }])

    await act(async () => { api.setPoint('n1', { x: 0.1, y: 0.9 }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(lastSave(adapter).notes).toEqual([{ id: 'n1', slideId: 'slide-0', text: 'logo too small', done: true, x: 0.1, y: 0.9 }])

    await act(async () => { api.setPoint('n1', null) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(lastSave(adapter).notes).toEqual([{ id: 'n1', slideId: 'slide-0', text: 'logo too small', done: true }])

    await act(async () => { api.remove('n1') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(5))
    // The last note gone is an explicit `notes: null` (serve's merge keeps an omitted key).
    expect(lastSave(adapter).notes).toBeNull()
  })

  it('a write that changes nothing makes no save and no undo step', async () => {
    const { adapter, api, utils } = await mountWithApi(twoSlides({ notes: [{ id: 'n1', slideId: 'slide-0', text: 'same' }] }))

    await act(async () => {
      api.setText('n1', 'same')
      api.setDone('n1', false)
      api.setPoint('n1', null)
      api.remove('nope')
      api.setText('nope', 'x')
    })

    expect(adapter.saveCalls).toHaveLength(0)
    expect((utils.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('selectSlide selects that slide; an unknown id changes nothing', async () => {
    const { api } = await mountWithApi()
    expect(interactiveHas('el-b')).toBe(false)

    await act(async () => { api.selectSlide('slide-1') })
    await waitFor(() => expect(interactiveHas('el-b')).toBe(true))

    await act(async () => { api.selectSlide('nope') })
    expect(interactiveHas('el-b')).toBe(true)
  })

  it('is one stable api across re-renders, withdrawn with null on unmount', async () => {
    const { api, provided, utils } = await mountWithApi()
    await act(async () => { api.add('slide-0') })
    await act(async () => { api.selectSlide('slide-1') })
    await act(async () => { api.add('slide-1') })

    expect(new Set(provided.filter(Boolean))).toEqual(new Set([api]))
    utils.unmount()
    expect(provided[provided.length - 1]).toBeNull()
  })
})

describe('CarouselEditor — note pins (PL70)', () => {
  const pins: SlidePin[] = [
    { id: 'p1', slideId: 'slide-0', x: 0.25, y: 0.75, label: 'Logo too small' },
    { id: 'p2', slideId: 'slide-0', x: 0.5, y: 0.5 },
    { id: 'p3', slideId: 'slide-0' },
    { id: 'p4', slideId: 'slide-1', x: 0.1, y: 0.1 },
    { id: 'p5', slideId: 'slide-1' },
    { id: 'p6', slideId: 'slide-1' },
  ]

  it('draws the selected slide pins that have a point as buttons at that point', async () => {
    const { getByRole, container } = render(
      <CarouselEditor project={twoSlides()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} pins={pins} onPinClick={vi.fn()} />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))

    const p1 = getByRole('button', { name: 'Logo too small' })
    expect(p1.closest('[data-interactive]')).not.toBeNull()
    expect(p1.style.left).toBe('25%')
    expect(p1.style.top).toBe('75%')
    const p2 = getByRole('button', { name: 'Note' })
    expect(p2.style.left).toBe('50%')
    expect(p2.style.top).toBe('50%')
    // Only the pins take the pointer; the layer over the slide lets it through.
    expect(p1.style.pointerEvents).toBe('auto')
    expect((p1.parentElement as HTMLElement).style.pointerEvents).toBe('none')
    // A whole-slide pin and another slide's pin are not on this canvas.
    expect(container.querySelectorAll('[data-interactive] [data-pin-id]')).toHaveLength(2)
    expect(container.querySelector('[data-pin-id="p3"]')).toBeNull()
    expect(container.querySelector('[data-pin-id="p4"]')).toBeNull()
  })

  it('a click on a pin reports its id and keeps the selection', async () => {
    const adapter = makeFakeAdapter()
    const onPinClick = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByRole } = render(
      <CarouselEditor
        project={twoSlides()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        pins={pins}
        onPinClick={onPinClick}
        onSelectionChange={onSelectionChange}
      />,
    )
    const wrapper = await waitFor(() => findInteractiveWrapper('el-img'))
    const lastSelection = () => {
      const calls = onSelectionChange.mock.calls
      return calls[calls.length - 1]?.[0]
    }
    await act(async () => { fireEvent.click(wrapper) })
    await waitFor(() => expect(lastSelection()?.id).toBe('el-img'))

    const p1 = getByRole('button', { name: 'Logo too small' })
    await act(async () => {
      fireEvent.pointerDown(p1, { clientX: 10, clientY: 10 })
      fireEvent.pointerMove(window, { clientX: 90, clientY: 90 })
      fireEvent.pointerUp(window)
      fireEvent.click(p1)
    })

    expect(onPinClick).toHaveBeenCalledTimes(1)
    expect(onPinClick).toHaveBeenCalledWith('p1')
    expect(lastSelection()?.id).toBe('el-img')
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('draws badges by default and chips with pinDisplay="chip" (§143)', async () => {
    const withText: SlidePin[] = [{ id: 'p1', slideId: 'slide-0', x: 0.25, y: 0.75, label: '1', text: 'Logo too small' }]
    const { container, rerender } = render(
      <CarouselEditor project={twoSlides()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} pins={withText} />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))
    const p1 = () => container.querySelector<HTMLElement>('[data-interactive] [data-pin-id="p1"]')!
    expect(p1().dataset.pinForm).toBe('badge')
    expect(p1().querySelector('[data-pin-text]')).toBeNull()

    rerender(<CarouselEditor project={twoSlides()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} pins={withText} pinDisplay="chip" />)
    expect(p1().dataset.pinForm).toBe('chip')
    expect(p1().querySelector('[data-pin-text]')!.textContent).toBe('Logo too small')
  })

  it('reports a change of selected slide by id, not on mount and not when the same slide is picked again (§143)', async () => {
    const onSelectedSlideChange = vi.fn()
    const provided: Array<SlideNotesApi | null> = []
    render(
      <CarouselEditor
        project={twoSlides()}
        adapter={makeFakeAdapter()}
        onProjectChange={vi.fn()}
        notes={{ enabled: true }}
        onProvideNotesApi={(api) => { provided.push(api) }}
        onSelectedSlideChange={onSelectedSlideChange}
      />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))
    expect(onSelectedSlideChange).not.toHaveBeenCalled()

    // The slide list thumbnail: the element drawn outside the interactive canvas.
    const thumb = (elementId: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-element-id="${elementId}"]`)).find((el) => !el.closest('[data-interactive]'))!

    await act(async () => { fireEvent.click(thumb('el-b')) })
    await waitFor(() => expect(interactiveHas('el-b')).toBe(true))
    expect(onSelectedSlideChange).toHaveBeenCalledTimes(1)
    expect(onSelectedSlideChange).toHaveBeenLastCalledWith('slide-1')

    await act(async () => { fireEvent.click(thumb('el-b')) })
    await act(async () => { provided[provided.length - 1]!.selectSlide('slide-1') })
    expect(onSelectedSlideChange).toHaveBeenCalledTimes(1)

    await act(async () => { provided[provided.length - 1]!.selectSlide('slide-0') })
    await waitFor(() => expect(interactiveHas('el-img')).toBe(true))
    expect(onSelectedSlideChange).toHaveBeenCalledTimes(2)
    expect(onSelectedSlideChange).toHaveBeenLastCalledWith('slide-0')
  })

  // §149: a thumbnail shows where notes live, a bubble per tone.
  function threeSlides(): Project {
    const p = twoSlides()
    return { ...p, slides: [...p.slides!, { id: 'slide-2', base_color: '#888888', elements: [] }] }
  }
  const bubbles = (container: HTMLElement, slideId: string) =>
    Array.from(container.querySelectorAll<HTMLElement>(`[data-slide-note-bubble="${slideId}"]`))
  const thumbOf = (container: HTMLElement, slideId: string) =>
    container.querySelector<HTMLElement>(`[data-slide-thumb="${slideId}"]`)!

  it('each thumbnail shows a bubble per tone, yours first, counting pins with or without a point, a number only past one (§149)', async () => {
    const toned: SlidePin[] = [
      { id: 'a1', slideId: 'slide-0', x: 0.2, y: 0.2, tone: 'self' },
      { id: 'a2', slideId: 'slide-0', tone: 'review' },
      { id: 'a3', slideId: 'slide-0', tone: 'self' },
      // Reviews first from the host; an unknown tone and no tone count as yours.
      { id: 'b1', slideId: 'slide-1', x: 0.5, y: 0.5, tone: 'review' },
      { id: 'b2', slideId: 'slide-1', tone: 'review' },
      { id: 'b3', slideId: 'slide-1', tone: 'note' },
    ]
    const { container } = render(
      <CarouselEditor project={threeSlides()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} pins={toned} />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))

    const shape = (slideId: string) =>
      bubbles(container, slideId).map((b) => [b.tagName, b.dataset.tone, b.getAttribute('aria-label'), b.textContent])
    expect(shape('slide-0')).toEqual([
      ['BUTTON', 'self', '2 notes', '2'],
      ['BUTTON', 'review', '1 review', ''],
    ])
    expect(shape('slide-1')).toEqual([
      ['BUTTON', 'self', '1 note', ''],
      ['BUTTON', 'review', '2 reviews', '2'],
    ])
    expect(bubbles(container, 'slide-2')).toEqual([])
    // Each bubble sits in its own thumbnail, which still shows its number.
    for (const [i, id] of ['slide-0', 'slide-1', 'slide-2'].entries()) {
      const thumb = thumbOf(container, id)
      for (const b of bubbles(container, id)) expect(b.closest('[data-slide-thumb]')).toBe(thumb)
      expect(Array.from(thumb.querySelectorAll('div')).some((d) => d.textContent === String(i + 1))).toBe(true)
    }
    expect(container.querySelector('[data-slide-pin-count]')).toBeNull()
  })

  it('a click on a bubble selects its slide and opens that tone first note, and nothing else takes the press (§149)', async () => {
    const toned: SlidePin[] = [
      { id: 'r1', slideId: 'slide-1', x: 0.5, y: 0.5, tone: 'review' },
      { id: 's1', slideId: 'slide-1', tone: 'self' },
      { id: 'r2', slideId: 'slide-1', tone: 'review' },
      { id: 's2', slideId: 'slide-1', x: 0.1, y: 0.9, tone: 'self' },
    ]
    const onPinClick = vi.fn()
    const onSelectedSlideChange = vi.fn()
    const { container } = render(
      <CarouselEditor
        project={twoSlides()}
        adapter={makeFakeAdapter()}
        onProjectChange={vi.fn()}
        pins={toned}
        onPinClick={onPinClick}
        onSelectedSlideChange={onSelectedSlideChange}
      />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))

    // What reaches the document past the bubble: the thumbnail's own click
    // handler would see anything that does.
    const leaked: string[] = []
    const types = ['click', 'pointerdown', 'mousedown']
    const spy = (e: Event) => { if ((e.target as HTMLElement).closest?.('[data-slide-note-bubble]')) leaked.push(e.type) }
    for (const t of types) document.addEventListener(t, spy)
    try {
      const [, review] = bubbles(container, 'slide-1')
      await act(async () => {
        fireEvent.pointerDown(review)
        fireEvent.mouseDown(review)
        fireEvent.click(review)
      })
      await waitFor(() => expect(interactiveHas('el-b')).toBe(true))
      expect(onSelectedSlideChange).toHaveBeenCalledTimes(1)
      expect(onSelectedSlideChange).toHaveBeenLastCalledWith('slide-1')
      expect(onPinClick).toHaveBeenCalledTimes(1)
      expect(onPinClick).toHaveBeenLastCalledWith('r1')

      const [self] = bubbles(container, 'slide-1')
      await act(async () => { fireEvent.click(self) })
      expect(onPinClick).toHaveBeenCalledTimes(2)
      expect(onPinClick).toHaveBeenLastCalledWith('s1')
      expect(onSelectedSlideChange).toHaveBeenCalledTimes(1)
      expect(leaked).toEqual([])
    } finally {
      for (const t of types) document.removeEventListener(t, spy)
    }
  })

  it('a drag from a bubble moves nothing; a drag from the thumbnail still reorders (§149)', async () => {
    const adapter = makeFakeAdapter()
    const { container } = render(
      <CarouselEditor project={twoSlides()} adapter={adapter} onProjectChange={vi.fn()} pins={[{ id: 'r1', slideId: 'slide-1', tone: 'review' }]} />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))
    const [bubble] = bubbles(container, 'slide-1')
    const target = thumbOf(container, 'slide-0')

    let started = true
    await act(async () => {
      started = fireEvent.dragStart(bubble)
      fireEvent.dragOver(target)
      fireEvent.drop(target)
      fireEvent.dragEnd(bubble)
    })
    expect(started).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)

    // The control: the same drag from the thumbnail moves the slide.
    await act(async () => {
      fireEvent.dragStart(thumbOf(container, 'slide-1'))
      fireEvent.dragOver(target)
      fireEvent.drop(target)
    })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).slides!.map((s) => s.id)).toEqual(['slide-1', 'slide-0'])
  })

  it('renders the notesPanel slot in the right rail', async () => {
    const { findByTestId } = render(
      <CarouselEditor
        project={makeProject()}
        adapter={makeFakeAdapter()}
        onProjectChange={vi.fn()}
        slots={{ notesPanel: <div data-testid="notes-panel" /> }}
      />,
    )
    const panel = await findByTestId('notes-panel')
    expect(panel.closest('[data-interactive]')).toBeNull()
  })
})

describe('CarouselEditor — pendingSurface', () => {
  const pending = () => makeProject({ status: 'pending' })

  it("default: a pending project shows the pending block, not the slide", async () => {
    const adapter = makeFakeAdapter()
    const { findByText, container } = render(
      <CarouselEditor project={pending()} adapter={adapter} onProjectChange={vi.fn()} />,
    )
    await findByText('Message your agent to start')
    expect(container.textContent).toContain('project id:')
    // Only the slide list thumbnail; no canvas for the selected slide.
    expect(document.querySelectorAll('[data-element-id="el-img"]')).toHaveLength(1)
  })

  it("'host': a pending project shows the slides, not the pending block", async () => {
    const adapter = makeFakeAdapter()
    const { queryByText, container } = render(
      <CarouselEditor
        project={pending()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        pendingSurface="host"
        slots={{ pendingStatus: <div data-testid="pending-status" /> }}
      />,
    )
    // Slide list thumbnail plus the selected slide's canvas.
    await waitFor(() => expect(document.querySelectorAll('[data-element-id="el-img"]').length).toBe(2))
    expect(container.querySelector('[data-testid="pending-status"]')).toBeNull()
    expect(queryByText('Message your agent to start')).toBeNull()
    expect(container.textContent).not.toContain('project id:')
  })

  it("'host': Render is disabled while pending", async () => {
    const adapter = makeFakeAdapter()
    const { findByTitle } = render(
      <CarouselEditor project={pending()} adapter={adapter} onProjectChange={vi.fn()} pendingSurface="host" />,
    )
    const btn = await findByTitle('Wait for the agent to finish before rendering')
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it("'host': no starter slide is auto-created while pending", async () => {
    const adapter = makeFakeAdapter()
    const { findByTitle } = render(
      <CarouselEditor
        project={makeProject({ status: 'pending', slides: [] })}
        adapter={adapter}
        onProjectChange={vi.fn()}
        pendingSurface="host"
      />,
    )
    await findByTitle('Wait for the agent to finish before rendering')
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(adapter.saveCalls).toHaveLength(0)
  })
})

// ── Multi-select (§156) ──────────────────────────────────────────────────────
//
// Shift-click adds an element to the selection or takes it out. Every selected
// element draws the selection outline; the handles and the element panel are
// for exactly one. Dragging a member of a multi-selection moves all of them,
// Delete removes all of them, and the align buttons align them to the box the
// selection covers: each in one save and one undo step.

function threeElements(): Project {
  return makeProject({
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [
          { id: 'el-a', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 100, rotation: 0 },
          { id: 'el-b', type: 'image', src: 'b.png', x: 500, y: 400, w: 100, h: 300, rotation: 0 },
          { id: 'el-c', type: 'image', src: 'c.png', x: 700, y: 700, w: 100, h: 100, rotation: 0 },
        ],
      },
      { id: 'slide-1', base_color: '#000000', elements: [] },
    ],
  })
}

// A click alone, as the tests above select: a press would also start (and
// commit) a single-element drag.
async function plainClick(id: string) {
  await act(async () => { fireEvent.click(findInteractiveWrapper(id)) })
}

// This jsdom has no PointerEvent, so fireEvent.pointer* falls back to a plain
// Event and drops shiftKey and clientX/Y. A MouseEvent named for the pointer
// event carries them, and React handles it by its name.
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

async function shiftClick(id: string) {
  const w = findInteractiveWrapper(id)
  await act(async () => {
    pointer(w, 'pointerdown', { shiftKey: true, clientX: 10, clientY: 10 })
    pointer(window, 'pointerup')
    fireEvent.click(w, { shiftKey: true })
  })
}

async function dragFrom(id: string, to: { clientX: number; clientY: number }) {
  await act(async () => {
    pointer(findInteractiveWrapper(id), 'pointerdown', { clientX: 100, clientY: 100 })
    pointer(window, 'pointermove', to)
    pointer(window, 'pointerup')
  })
}

function outlined(id: string): boolean {
  return findInteractiveWrapper(id).style.outline.includes('solid')
}

function handlesOn(id: string): boolean {
  return findInteractiveWrapper(id).querySelector('[data-testid="resize-handle-nw"]') !== null
}

function elementsOf(p: Project) {
  return p.slides![0].elements
}

describe('CarouselEditor: multi-select (§156)', () => {
  it('shift-click toggles; each selected element is outlined; handles and the element panel only for one', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))

    await plainClick('el-a')
    expect(outlined('el-a')).toBe(true)
    expect(handlesOn('el-a')).toBe(true)
    expect(r.queryByRole('group', { name: 'Align to slide' })).not.toBeNull()
    expect(r.queryByTitle('Crop image')).not.toBeNull()

    await shiftClick('el-b')
    expect(outlined('el-a')).toBe(true)
    expect(outlined('el-b')).toBe(true)
    expect(outlined('el-c')).toBe(false)
    expect(handlesOn('el-a')).toBe(false)
    expect(handlesOn('el-b')).toBe(false)
    // The element panel is gone; only the align buttons, aligning to the selection.
    expect(r.queryByTitle('Crop image')).toBeNull()
    expect(r.queryByRole('group', { name: 'Align to slide' })).toBeNull()
    expect(r.queryByRole('group', { name: 'Align' })).not.toBeNull()

    // Shift-click again takes it out: back to one, handles back.
    await shiftClick('el-b')
    expect(outlined('el-b')).toBe(false)
    expect(handlesOn('el-a')).toBe(true)

    // A plain click resets to just that one.
    await shiftClick('el-b')
    await plainClick('el-c')
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-b')).toBe(false)
    expect(outlined('el-c')).toBe(true)
    expect(handlesOn('el-c')).toBe(true)

    // A click on the empty canvas clears.
    await shiftClick('el-a')
    await act(async () => { fireEvent.click(document.querySelector('[data-interactive]') as HTMLElement) })
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-c')).toBe(false)

    // Selecting another slide clears too.
    await plainClick('el-a')
    await shiftClick('el-b')
    await act(async () => { fireEvent.click(document.querySelector('[data-slide-thumb="slide-1"]') as HTMLElement) })
    await act(async () => { fireEvent.click(document.querySelector('[data-slide-thumb="slide-0"]') as HTMLElement) })
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-b')).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('onSelectionChange reports the one element, the last clicked of several, and null', async () => {
    const onSelectionChange = vi.fn()
    render(<CarouselEditor project={threeElements()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} onSelectionChange={onSelectionChange} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    const last = () => onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1]?.[0]

    await plainClick('el-a')
    expect(last()?.id).toBe('el-a')
    await shiftClick('el-c')
    expect(last()?.id).toBe('el-c')
    await shiftClick('el-b')
    expect(last()?.id).toBe('el-b')
    await act(async () => { fireEvent.click(document.querySelector('[data-interactive]') as HTMLElement) })
    expect(last()).toBeNull()
  })

  it('Delete removes every selected element in one save, and one undo brings them all back', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await shiftClick('el-c')

    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter)).map(e => e.id)).toEqual(['el-b'])

    await key('z', { ctrlKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter)).map(e => e.id)).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('dragging a member moves the whole selection by one delta, in one save and one undo step', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await shiftClick('el-b')

    await dragFrom('el-b', { clientX: 140, clientY: 160 })
    await act(async () => { fireEvent.click(findInteractiveWrapper('el-b')) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [a, b, c] = elementsOf(lastSave(adapter))
    const dx = a.x - 100
    const dy = a.y - 100
    expect(dx).toBeGreaterThan(0)
    expect(dy).toBeGreaterThan(0)
    expect([b.x - 500, b.y - 400]).toEqual([dx, dy])
    expect([c.x, c.y]).toEqual([700, 700])
    // The click that ends the drag keeps the selection.
    expect(outlined('el-a')).toBe(true)
    expect(outlined('el-b')).toBe(true)

    await key('z', { ctrlKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    const undone = elementsOf(lastSave(adapter))
    expect(undone.map(e => [e.x, e.y])).toEqual([[100, 100], [500, 400], [700, 700]])
  })

  it('dragging an unselected element selects only it and moves only it', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await shiftClick('el-b')
    const saves = adapter.saveCalls.length

    await dragFrom('el-c', { clientX: 140, clientY: 160 })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(saves))
    const [a, b, c] = elementsOf(lastSave(adapter))
    expect([a.x, a.y, b.x, b.y]).toEqual([100, 100, 500, 400])
    expect(c.x).not.toBe(700)
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-c')).toBe(true)
  })

  it('the align buttons align the selection to the box it covers, in one undo step', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await shiftClick('el-b')

    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align bottom' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    // Union bottom is B's (700): A's bottom moves there, B stays.
    expect(elementsOf(lastSave(adapter)).map(e => [e.x, e.y])).toEqual([[100, 600], [500, 400], [700, 700]])

    await key('z', { ctrlKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter)).map(e => [e.x, e.y])).toEqual([[100, 100], [500, 400], [700, 700]])
  })

  it('Distribute spreads three selected elements evenly, or by an exact gap keeping the first, each in one undo step', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await shiftClick('el-b')
    // Two selected: Distribute is there but off.
    expect(r.getByRole('button', { name: 'Distribute horizontally' })).toBeDisabled()
    await shiftClick('el-c')
    expect(r.getByRole('button', { name: 'Distribute horizontally' })).not.toBeDisabled()

    // Blank gap: A 100..300, B 500..600, C 700..800 are 200 + 100 + 100 wide inside 100..800, so two gaps of 150.
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Distribute horizontally' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter)).map(e => [e.x, e.y])).toEqual([[100, 100], [450, 400], [700, 700]])
    await key('z', { ctrlKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter)).map(e => [e.x, e.y])).toEqual([[100, 100], [500, 400], [700, 700]])

    // A gap of 50 from the first, which stays.
    await act(async () => { fireEvent.change(r.getByRole('spinbutton', { name: 'Gap' }), { target: { value: '50' } }) })
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Distribute horizontally' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(elementsOf(lastSave(adapter)).map(e => [e.x, e.y])).toEqual([[100, 100], [350, 400], [500, 700]])
  })

  it('in crop mode shift-click acts as a plain click', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await act(async () => { fireEvent.click(await r.findByTitle('Crop image')) })

    await shiftClick('el-b')
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-b')).toBe(true)
    expect(handlesOn('el-b')).toBe(true)
  })
})

// ── One keymap (§556) ────────────────────────────────────────────────────────
//
// Every carousel shortcut is one registry (the video editor's `useKeymap`): one
// `document` listener, first match wins. It skips typing surfaces, holds every
// key while a dialog is up, and leaves Esc in crop mode to SlideCanvas.

function textOverlaySlide(): Project {
  return makeProject({
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [
          {
            id: 'el-ov',
            type: 'overlay',
            overlay: { template: '/overlays/text.jsx', props: { text: 'Hello' } },
            frame: 0,
            x: 100, y: 100, w: 600, h: 200, rotation: 0,
          },
        ],
      },
    ],
  })
}

// jsdom never loads an image: give it a size and fire its load.
function loadImage(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(img)
}

describe('CarouselEditor: one keymap (§556)', () => {
  it('one Cmd+Z is one undo and one Cmd+Shift+Z is one redo', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    const at = () => ['X', 'Y'].map((name) => (r.getByRole('spinbutton', { name }) as HTMLInputElement).value)

    // Two edits, two undo steps.
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align left' })) })
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align top' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(at()).toEqual(['0', '0'])

    const undo = await key('z', { metaKey: true })
    expect(undo.defaultPrevented).toBe(true)
    expect(at()).toEqual(['0', '100'])
    await key('z', { metaKey: true })
    expect(at()).toEqual(['100', '100'])
    const redo = await key('z', { metaKey: true, shiftKey: true })
    expect(redo.defaultPrevented).toBe(true)
    expect(at()).toEqual(['0', '100'])

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(5))
    expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ x: 0, y: 100 })
  })

  it('Delete in the inline text editor stays in the text', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={textOverlaySlide()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-ov'))
    await plainClick('el-ov')
    await act(async () => { fireEvent.doubleClick(findInteractiveWrapper('el-ov')) })
    const editor = r.getByRole('textbox', { name: 'Edit text' })
    expect(document.activeElement).toBe(editor)

    for (const k of ['Delete', 'Backspace']) {
      const e = await key(k, {}, editor)
      expect(e.defaultPrevented).toBe(false)
    }
    expect(interactiveHas('el-ov')).toBe(true)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('keys typed in a panel field stay in the field', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    // An edit, so an undo would have something to take back.
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align left' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))

    const x = r.getByRole('spinbutton', { name: 'X' }) as HTMLInputElement
    x.focus()
    const typed = [
      await key('Delete', {}, x),
      await key('Backspace', {}, x),
      await key('z', { metaKey: true }, x),
      await key('n', {}, x),
    ]
    expect(typed.map((e) => e.defaultPrevented)).toEqual([false, false, false, false])
    expect(interactiveHas('el-img')).toBe(true)
    expect(x.value).toBe('0')
    expect(armLayer()).toBeNull()
    expect(adapter.saveCalls).toHaveLength(1)
  })

  it('while the overlay picker is open, Delete leaves the selection alone', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')

    await act(async () => { fireEvent.click(r.getByRole('button', { name: '+ Overlay' })) })
    await r.findByRole('dialog', { name: 'Add overlay' })
    const held = await key('Delete')
    expect(held.defaultPrevented).toBe(false)
    expect(interactiveHas('el-img')).toBe(true)
    expect(adapter.saveCalls).toHaveLength(0)

    // Esc closes the picker (its own key), and Delete is back.
    await key('Escape')
    expect(r.queryByRole('dialog', { name: 'Add overlay' })).toBeNull()
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))).toEqual([])
  })

  it.each([['Controls'], ['Render']])('while the %s window is open, Delete leaves the selection alone', async (which) => {
    const adapter = makeFakeAdapter()
    const r = render(
      <CarouselEditor
        project={makeProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        renderModal={(ctx) => (ctx.open ? <button type="button" onClick={ctx.onClose}>Close render</button> : null)}
      />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    if (which === 'Controls') {
      await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Editor controls & shortcuts' })) })
      await r.findByRole('dialog', { name: 'Editor controls' })
    } else {
      await act(async () => { fireEvent.click(r.getByTitle('Render all slides as PNGs')) })
      await r.findByRole('button', { name: 'Close render' })
    }
    const saves = adapter.saveCalls.length

    const held = await key('Delete')
    expect(held.defaultPrevented).toBe(false)
    expect(interactiveHas('el-img')).toBe(true)
    expect(adapter.saveCalls).toHaveLength(saves)

    // Closed, Delete is back.
    if (which === 'Controls') await key('Escape')
    else await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Close render' })) })
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(saves + 1))
    expect(elementsOf(lastSave(adapter))).toEqual([])
  })

  it('in crop mode Esc applies the crop and keeps the image selected', async () => {
    const adapter = makeFakeAdapter()
    const onSelectionChange = vi.fn()
    const r = render(
      <CarouselEditor
        project={makeProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        notes={{ enabled: true }}
        onSelectionChange={onSelectionChange}
      />,
    )
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    const source = findInteractiveWrapper('el-img').querySelector<HTMLImageElement>('img[alt="Crop source"]')
    expect(source).not.toBeNull()
    // A 2:1 source in the 200 x 200 box.
    await act(async () => { loadImage(source!, 400, 200) })

    await key('Escape')
    // The crop applied: the whole source, and the box takes its 2:1 shape.
    await waitFor(() =>
      expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ crop: { x: 0, y: 0, w: 1, h: 1 }, w: 200, h: 100 }),
    )
    // Crop mode is over, and the image is still the one selected.
    expect(findInteractiveWrapper('el-img').querySelector('img[alt="Crop source"]')).toBeNull()
    expect(handlesOn('el-img')).toBe(true)
    const calls = onSelectionChange.mock.calls
    expect(calls[calls.length - 1][0]?.id).toBe('el-img')
    expect(armLayer()).toBeNull()
  })
})

// ── Clipboard and element keys (§556 M2) ─────────────────────────────────────
//
// Cmd+C, Cmd+X, Cmd+V, Cmd+D, Cmd+A, the arrows, Cmd+[ and Cmd+] (with Option
// for the ends) and Esc are bindings in the same registry. None acts in crop
// mode, without a selected slide, or while typing.

const CMD = { metaKey: true }
// Option changes `key` on a Mac (Opt+] types U+2018), so these match on `code`.
const RIGHT_BRACKET = { code: 'BracketRight' }
const LEFT_BRACKET = { code: 'BracketLeft' }

async function keyUp(k: string, init: KeyboardEventInit = {}, target: EventTarget = document): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keyup', { key: k, cancelable: true, bubbles: true, ...init })
  await act(async () => { target.dispatchEvent(e) })
  return e
}

async function pickSlide(id: string) {
  await act(async () => { fireEvent.click(document.querySelector(`[data-slide-thumb="${id}"]`) as HTMLElement) })
}

const idsOf = (p: Project, slide = 0) => p.slides![slide].elements.map((e) => e.id)
const posOf = (p: Project, slide = 0) => p.slides![slide].elements.map((e) => [e.x, e.y])

// What the editor holds right now, saved or not: the last project it reported.
function liveProject(onProjectChange: ReturnType<typeof vi.fn>): Project {
  const calls = onProjectChange.mock.calls
  return calls[calls.length - 1][0] as Project
}

async function mountThree(extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}) {
  const adapter = makeFakeAdapter()
  const onProjectChange = vi.fn()
  const r = render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={onProjectChange} {...extra} />)
  await waitFor(() => findInteractiveWrapper('el-a'))
  return { adapter, onProjectChange, r }
}

describe('CarouselEditor: copy, cut and paste (§556 M2)', () => {
  it('Cmd+C then Cmd+V pastes copies 20 px down and right, on top, as new elements, and selects them', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-c')

    const copy = await key('c', CMD)
    // Copy leaves the browser's own text copy alone, and writes nothing.
    expect(copy.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)

    const paste = await key('v', CMD)
    expect(paste.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const saved = lastSave(adapter)
    expect(idsOf(saved).slice(0, 3)).toEqual(['el-a', 'el-b', 'el-c'])
    expect(posOf(saved).slice(0, 3)).toEqual([[100, 100], [500, 400], [700, 700]])
    const [pa, pc] = elementsOf(saved).slice(3)
    expect(elementsOf(saved)).toHaveLength(5)
    expect(pa).toMatchObject({ type: 'image', src: 'a.png', x: 120, y: 120, w: 200, h: 100 })
    expect(pc).toMatchObject({ type: 'image', src: 'c.png', x: 720, y: 720, w: 100, h: 100 })
    expect(new Set(['el-a', 'el-b', 'el-c', pa.id, pc.id]).size).toBe(5)

    // The pasted ones are the selection now.
    expect(outlined(pa.id)).toBe(true)
    expect(outlined(pc.id)).toBe(true)
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-c')).toBe(false)
  })

  it('pasting twice on the slide they came from moves each paste 20 px further: +20, then +40', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-b')
    await key('c', CMD)
    await key('v', CMD)
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    const saved = lastSave(adapter)
    expect(posOf(saved)).toEqual([[100, 100], [500, 400], [700, 700], [520, 420], [540, 440]])
    expect(new Set(idsOf(saved)).size).toBe(5)
  })

  it('on another slide the first paste keeps the copied position, and each further one moves 20 px', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-b')
    await key('c', CMD)
    await pickSlide('slide-1')
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(posOf(lastSave(adapter), 1)).toEqual([[500, 400]])
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(posOf(lastSave(adapter), 1)).toEqual([[500, 400], [520, 420]])
    // The slide they came from is untouched.
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('the clipboard survives switching slides, and a new copy starts the counts again', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await key('c', CMD)
    await key('v', CMD)
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(posOf(lastSave(adapter)).slice(3)).toEqual([[120, 120], [140, 140]])

    // Another slide and back; then copy something else: its first paste is +20 again.
    await pickSlide('slide-1')
    await pickSlide('slide-0')
    await plainClick('el-c')
    await key('c', CMD)
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(posOf(lastSave(adapter)).slice(5)).toEqual([[720, 720]])
  })

  it('the clipboard does not follow the editor onto another project', async () => {
    const adapter = makeFakeAdapter()
    let push: ((p: Project) => void) | undefined
    adapter.subscribe = (_id, onFrame) => {
      push = onFrame
      return () => {}
    }
    const onProjectChange = vi.fn()
    render(<CarouselEditor project={threeElements()} adapter={adapter} onProjectChange={onProjectChange} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await key('c', CMD)

    // The host puts another project in the editor.
    await act(async () => { push!({ ...threeElements(), id: 'proj-2' }) })
    expect(liveProject(onProjectChange).id).toBe('proj-2')

    await plainClick('el-a')
    const paste = await key('v', CMD)
    expect(paste.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('each paste is one undo step', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-b')
    await key('c', CMD)
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))).toHaveLength(5)
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('Cmd+X removes the selection in one undo step, and Cmd+V brings it back', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-c')

    const cut = await key('x', CMD)
    expect(cut.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b'])
    expect(outlined('el-b')).toBe(false)

    // One undo puts both back where they were.
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
    await key('z', { ...CMD, shiftKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b'])

    // The cut elements paste back, as new elements, on top.
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    const saved = lastSave(adapter)
    expect(elementsOf(saved).map((e) => (e as ImageElement).src)).toEqual(['b.png', 'a.png', 'c.png'])
    expect(idsOf(saved)).not.toContain('el-a')
    expect(idsOf(saved)).not.toContain('el-c')
  })

  it('a cut pasted onto another slide lands where it was', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-c')
    await key('x', CMD)
    await pickSlide('slide-1')
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b'])
    expect(elementsOf({ ...lastSave(adapter), slides: [lastSave(adapter).slides![1]] }).map((e) => (e as ImageElement).src)).toEqual(['a.png', 'c.png'])
    expect(posOf(lastSave(adapter), 1)).toEqual([[100, 100], [700, 700]])
  })

  it('Cmd+X then Cmd+V on the same slide puts the element back where it was cut, not 20 px on', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-b')
    await key('x', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    const pasted = elementsOf(lastSave(adapter)).find((e) => (e as ImageElement).src === 'b.png')!
    expect(pasted).toMatchObject({ type: 'image', x: 500, y: 400 })
    expect(pasted.id).not.toBe('el-b')
  })

  it('Cmd+X, Cmd+Z, then Cmd+V on the same slide: the originals are back, so the paste steps 20 px', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-b')
    await key('x', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(posOf(lastSave(adapter))).toEqual([[100, 100], [500, 400], [700, 700]])
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    // The restored el-b is still there, in place; the paste is the fourth element.
    const elements = elementsOf(lastSave(adapter))
    expect(elements).toHaveLength(4)
    const [pasted] = elements.slice(3)
    expect(pasted).toMatchObject({ type: 'image', src: 'b.png', x: 520, y: 420 })
    expect(pasted.id).not.toBe('el-b')
  })

  it('Cmd+V with an empty clipboard does nothing, and leaves the browser\'s paste alone', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    const paste = await key('v', CMD)
    expect(paste.defaultPrevented).toBe(false)
    // Nothing selected: Cut is not claimed either, and Copy never blocks the browser's.
    await key('Escape')
    const cut = await key('x', CMD)
    expect(cut.defaultPrevented).toBe(false)
    const copy = await key('c', CMD)
    expect(copy.defaultPrevented).toBe(false)
    const pasteAfter = await key('v', CMD)
    expect(pasteAfter.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('Ctrl does what Cmd does', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await key('c', { ctrlKey: true })
    const paste = await key('v', { ctrlKey: true })
    expect(paste.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))).toHaveLength(4)
  })

  it('Shift or Option with the letter is not claimed', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    for (const init of [{ ...CMD, shiftKey: true }, { ...CMD, altKey: true }]) {
      for (const k of ['c', 'x', 'd']) {
        const e = await key(k, init)
        expect(e.defaultPrevented).toBe(false)
      }
    }
    // Nothing was copied, so a plain Cmd+V finds an empty clipboard.
    const paste = await key('v', CMD)
    expect(paste.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('pasted clones share nothing with the source or with each other', async () => {
    const project = makeProject({
      slides: [
        {
          id: 'slide-0',
          base_color: '#ffffff',
          elements: [
            { id: 'el-crop', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } },
            {
              id: 'el-ov',
              type: 'overlay',
              overlay: { template: '/overlays/text.jsx', props: { text: 'Hi', style: { color: 'red' } } },
              frame: 0,
              x: 300, y: 300, w: 300, h: 100, rotation: 0,
              googleFonts: ['Syne:wght@800'],
            },
          ],
        },
      ],
    })
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-crop'))
    await plainClick('el-crop')
    await shiftClick('el-ov')
    await key('c', CMD)
    await key('v', CMD)
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))

    const [src, srcOv, p1, p1Ov, p2, p2Ov] = elementsOf(lastSave(adapter)) as [ImageElement, OverlayElement, ImageElement, OverlayElement, ImageElement, OverlayElement]
    expect(p1.crop).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
    expect(p1.crop).not.toBe(src.crop)
    expect(p2.crop).not.toBe(p1.crop)
    p1.crop!.x = 0.9
    expect(src.crop!.x).toBe(0)
    expect(p2.crop!.x).toBe(0)

    expect(p1Ov.overlay.props).not.toBe(srcOv.overlay.props)
    expect(p1Ov.overlay.props.style).not.toBe(srcOv.overlay.props.style)
    expect(p1Ov.googleFonts).not.toBe(srcOv.googleFonts)
    ;(p1Ov.overlay.props.style as { color: string }).color = 'blue'
    p1Ov.googleFonts!.push('Inter')
    expect((srcOv.overlay.props.style as { color: string }).color).toBe('red')
    expect((p2Ov.overlay.props.style as { color: string }).color).toBe('red')
    expect(srcOv.googleFonts).toEqual(['Syne:wght@800'])
    expect(p2Ov.googleFonts).toEqual(['Syne:wght@800'])
  })
})

describe('CarouselEditor: duplicate (§556 M2)', () => {
  it('Cmd+D copies every selected element 20 px down and right, each directly above its source, in one undo step', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-b')

    const e = await key('d', CMD)
    expect(e.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const els = elementsOf(lastSave(adapter))
    expect(els).toHaveLength(5)
    expect([els[0].id, els[2].id, els[4].id]).toEqual(['el-a', 'el-b', 'el-c'])
    expect(els[1]).toMatchObject({ src: 'a.png', x: 120, y: 120, w: 200, h: 100 })
    expect(els[3]).toMatchObject({ src: 'b.png', x: 520, y: 420, w: 100, h: 300 })
    expect(new Set(els.map((x) => x.id)).size).toBe(5)
    // The sources stay where they were.
    expect([els[0], els[2], els[4]].map((x) => [x.x, x.y])).toEqual([[100, 100], [500, 400], [700, 700]])

    // The copies are the selection.
    expect(outlined(els[1].id)).toBe(true)
    expect(outlined(els[3].id)).toBe(true)
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-b')).toBe(false)

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('Cmd+D on one element does what the panel Duplicate button does', async () => {
    const { adapter, r } = await mountThree()
    await plainClick('el-b')
    // The panel: the slide has a Duplicate button too; the element\'s is the last.
    const buttons = r.getAllByRole('button', { name: 'Duplicate' })
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const viaButton = elementsOf(lastSave(adapter))
    expect(viaButton.map((e) => e.id).filter((id) => id.startsWith('el-'))).toEqual(['el-a', 'el-b', 'el-c'])
    // a, b, the copy of b, c
    expect(viaButton).toHaveLength(4)
    expect(viaButton[2]).toMatchObject({ src: 'b.png', x: 520, y: 420, w: 100, h: 300 })
    expect(outlined(viaButton[2].id)).toBe(true)

    // Undo it, then the key: the same result.
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    await plainClick('el-b')
    await key('d', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    const viaKey = elementsOf(lastSave(adapter))
    expect(viaKey.map((e) => e.id).filter((id) => id.startsWith('el-'))).toEqual(['el-a', 'el-b', 'el-c'])
    expect(viaKey).toHaveLength(4)
    expect(viaKey[2]).toMatchObject({ src: 'b.png', x: 520, y: 420, w: 100, h: 300 })
    expect(outlined(viaKey[2].id)).toBe(true)
  })

  it('the panel Duplicate button copies share nothing with the source', async () => {
    const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    const project = makeProject({
      slides: [
        {
          id: 'slide-0',
          base_color: '#ffffff',
          elements: [{ id: 'el-crop', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0, crop }],
        },
      ],
    })
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-crop'))
    await plainClick('el-crop')
    const buttons = r.getAllByRole('button', { name: 'Duplicate' })
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [src, copy] = elementsOf(lastSave(adapter)) as [ImageElement, ImageElement]
    expect(copy).toMatchObject({ x: 120, y: 120, crop })
    expect(copy.crop).not.toBe(src.crop)
  })

  it('a duplicated slide holds clones that share nothing with the original', async () => {
    const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    const project = makeProject({
      slides: [
        {
          id: 'slide-0',
          base_color: '#ffffff',
          elements: [
            { id: 'el-crop', type: 'image', src: 'a.png', x: 0, y: 0, w: 100, h: 100, rotation: 0, crop },
            {
              id: 'el-ov',
              type: 'overlay',
              overlay: { template: '/overlays/text.jsx', props: { text: 'Hi', style: { color: 'red' } } },
              frame: 0,
              x: 0, y: 0, w: 100, h: 100, rotation: 0,
              googleFonts: ['Syne:wght@800'],
            },
          ],
        },
      ],
    })
    const adapter = makeFakeAdapter()
    const { getByTitle } = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-crop'))
    await act(async () => { fireEvent.click(getByTitle('Duplicate slide')) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [orig, clone] = lastSave(adapter).slides!
    const [oImg, oOv] = orig.elements as [ImageElement, OverlayElement]
    const [cImg, cOv] = clone.elements as [ImageElement, OverlayElement]
    expect(cImg.crop).toEqual(oImg.crop)
    expect(cImg.crop).not.toBe(oImg.crop)
    expect(cOv.overlay.props.style).toEqual(oOv.overlay.props.style)
    expect(cOv.overlay.props.style).not.toBe(oOv.overlay.props.style)
    expect(cOv.googleFonts).not.toBe(oOv.googleFonts)
    expect(cImg.id).not.toBe(oImg.id)
  })
})

describe('CarouselEditor: select all (§556 M2)', () => {
  it('Cmd+A selects every element on the slide, and Delete then empties it in one undo step', async () => {
    const { adapter } = await mountThree()
    const e = await key('a', CMD)
    expect(e.defaultPrevented).toBe(true)
    for (const id of ['el-a', 'el-b', 'el-c']) expect(outlined(id)).toBe(true)

    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))).toEqual([])

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('on an empty slide it still takes the key, so the page does not select its text', async () => {
    const { adapter } = await mountThree()
    await pickSlide('slide-1')
    const e = await key('a', CMD)
    expect(e.defaultPrevented).toBe(true)
    // Nothing to select, nothing to delete: the first slide\'s elements are not in the selection.
    await key('Delete')
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('leaves out the elements the host hides', async () => {
    const { adapter } = await mountThree({ hiddenElementIds: ['el-b'] })
    await key('a', CMD)
    expect(outlined('el-a')).toBe(true)
    expect(outlined('el-c')).toBe(true)
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b'])
  })

  it('Cmd+Shift+A is not Select all', async () => {
    await mountThree()
    const e = await key('a', { ...CMD, shiftKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(outlined('el-a')).toBe(false)
  })
})

describe('CarouselEditor: nudge (§556 M2)', () => {
  afterEach(() => { vi.useRealTimers() })

  // The element at (100, 100), selected.
  async function mountOne() {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={onProjectChange} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    return { adapter, onProjectChange, r }
  }
  const xyOf = (p: Project) => [elementsOf(p)[0].x, elementsOf(p)[0].y]

  it('three presses of ArrowRight move 3 px at once, and 500 ms after the last one it is one save and one undo step', async () => {
    const { adapter, onProjectChange, r } = await mountOne()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    for (let i = 0; i < 3; i++) {
      const e = await key('ArrowRight', { repeat: i > 0 })
      // No scrolling.
      expect(e.defaultPrevented).toBe(true)
    }
    // On screen already; nothing saved yet.
    expect(xyOf(liveProject(onProjectChange))).toEqual([103, 100])
    expect(adapter.saveCalls).toHaveLength(0)

    await act(async () => { vi.advanceTimersByTime(499) })
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(1) })
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(xyOf(lastSave(adapter))).toEqual([103, 100])

    // One undo brings back the start, and there is nothing left to undo.
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(xyOf(lastSave(adapter))).toEqual([100, 100])
    expect((r.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the 500 ms are counted from the last press', async () => {
    const { adapter, onProjectChange } = await mountOne()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowDown')
    await act(async () => { vi.advanceTimersByTime(400) })
    await key('ArrowDown', { repeat: true })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(100) })
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(xyOf(lastSave(adapter))).toEqual([100, 102])
    expect(xyOf(liveProject(onProjectChange))).toEqual([100, 102])
  })

  it.each([
    ['ArrowLeft', {}, [99, 100]],
    ['ArrowRight', {}, [101, 100]],
    ['ArrowUp', {}, [100, 99]],
    ['ArrowDown', {}, [100, 101]],
    ['ArrowLeft', { shiftKey: true }, [90, 100]],
    ['ArrowRight', { shiftKey: true }, [110, 100]],
    ['ArrowUp', { shiftKey: true }, [100, 90]],
    ['ArrowDown', { shiftKey: true }, [100, 110]],
  ] as const)('%s %j moves the element to %j', async (k, init, to) => {
    const { adapter } = await mountOne()
    await key(k, init)
    // Releasing the key ends the burst.
    await keyUp(k, init)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(xyOf(lastSave(adapter))).toEqual(to)
  })

  it('every selected element moves, in the same one undo step', async () => {
    const { adapter, onProjectChange } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-b')
    await key('ArrowLeft', { shiftKey: true })
    expect(posOf(liveProject(onProjectChange))).toEqual([[90, 100], [490, 400], [700, 700]])
    await keyUp('ArrowLeft', { shiftKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(posOf(lastSave(adapter))).toEqual([[90, 100], [490, 400], [700, 700]])

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(posOf(lastSave(adapter))).toEqual([[100, 100], [500, 400], [700, 700]])
  })

  it('Cmd+Z right after a nudge undoes the nudge', async () => {
    const { adapter } = await mountOne()
    await key('ArrowRight')
    await key('z', CMD)
    // The nudge was saved first, then taken back.
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(xyOf(adapter.saveCalls[0].project)).toEqual([101, 100])
    expect(xyOf(lastSave(adapter))).toEqual([100, 100])
  })

  it('Cmd+Z right after a burst undoes the burst, not an earlier edit', async () => {
    const { adapter, onProjectChange, r } = await mountOne()
    // An earlier edit, so there is something else to undo.
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align left' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(xyOf(lastSave(adapter))).toEqual([0, 100])

    await key('ArrowDown')
    await key('ArrowDown', { repeat: true })
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(xyOf(liveProject(onProjectChange))).toEqual([0, 100])
  })

  it('releasing the arrow commits the burst at once, not 500 ms later', async () => {
    const { adapter } = await mountOne()
    // The 500 ms timer is frozen, then dropped: only the release can save.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowRight')
    await key('ArrowRight', { repeat: true })
    expect(adapter.saveCalls).toHaveLength(0)
    await keyUp('ArrowRight')
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(xyOf(lastSave(adapter))).toEqual([102, 100])
  })

  it('after a release the timer has nothing left to save', async () => {
    const { adapter } = await mountOne()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowRight')
    await keyUp('ArrowRight')
    // Past the 500 ms: a second commit would save a second time.
    await act(async () => { vi.advanceTimersByTime(1000) })
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(adapter.saveCalls).toHaveLength(1)
  })

  it('a key release of a key that is not an arrow commits nothing', async () => {
    const { adapter } = await mountOne()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowRight')
    await keyUp('Shift')
    await keyUp('a')
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(500) })
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
  })

  it('the window losing focus commits the burst', async () => {
    const { adapter } = await mountOne()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowDown')
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('blur')) })
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(xyOf(lastSave(adapter))).toEqual([100, 101])
  })

  it('selecting another element commits the burst first, as its own undo step', async () => {
    const { adapter, onProjectChange } = await mountThree()
    await plainClick('el-a')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowRight', { shiftKey: true })
    expect(adapter.saveCalls).toHaveLength(0)

    await plainClick('el-b')
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(posOf(lastSave(adapter))).toEqual([[110, 100], [500, 400], [700, 700]])

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(posOf(lastSave(adapter))).toEqual([[100, 100], [500, 400], [700, 700]])
    expect(posOf(liveProject(onProjectChange))).toEqual([[100, 100], [500, 400], [700, 700]])
  })

  it('switching slide commits the burst', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-c')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowUp')
    await pickSlide('slide-1')
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(posOf(lastSave(adapter))).toEqual([[100, 100], [500, 400], [700, 699]])
  })

  it('any other shortcut commits the burst before it acts, so the burst is its own undo step', async () => {
    const { adapter } = await mountOne()
    await key('ArrowRight')
    await key('d', CMD)
    // The nudge saved, then the duplicate.
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(xyOf(adapter.saveCalls[0].project)).toEqual([101, 100])
    expect(elementsOf(lastSave(adapter)).map((e) => [e.x, e.y])).toEqual([[101, 100], [121, 120]])

    // The first undo takes the duplicate away and keeps the nudge.
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(elementsOf(lastSave(adapter)).map((e) => [e.x, e.y])).toEqual([[101, 100]])
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(elementsOf(lastSave(adapter)).map((e) => [e.x, e.y])).toEqual([[100, 100]])
  })

  it('unmounting commits a burst that is still open', async () => {
    const { adapter, r } = await mountOne()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await key('ArrowLeft')
    expect(adapter.saveCalls).toHaveLength(0)
    r.unmount()
    vi.useRealTimers()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(xyOf(lastSave(adapter))).toEqual([99, 100])
  })

  it('Cmd, Ctrl or Alt with an arrow is not a nudge', async () => {
    const { adapter, onProjectChange } = await mountOne()
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const e = await key('ArrowRight', init)
      expect(e.defaultPrevented).toBe(false)
    }
    await keyUp('ArrowRight')
    expect(xyOf(liveProject(onProjectChange))).toEqual([100, 100])
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('with nothing selected, the arrows are left alone', async () => {
    const { adapter } = await mountThree()
    const e = await key('ArrowDown')
    expect(e.defaultPrevented).toBe(false)
    await keyUp('ArrowDown')
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('a project that cannot be edited does not move, and saves nothing', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<CarouselEditor project={makeProject({ status: 'storyboard_ready' })} adapter={adapter} onProjectChange={onProjectChange} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    await key('ArrowRight')
    await keyUp('ArrowRight')
    expect(xyOf(liveProject(onProjectChange))).toEqual([100, 100])
    expect(adapter.saveCalls).toHaveLength(0)
  })
})

describe('CarouselEditor: layer order (§556 M2)', () => {
  const FRONT = { ...CMD, altKey: true }

  it('Opt+Cmd+] puts the selected element in front of all the others, in one undo step', async () => {
    const { adapter, r } = await mountThree()
    await plainClick('el-a')
    const e = await key(']', { ...FRONT, ...RIGHT_BRACKET })
    expect(e.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b', 'el-c', 'el-a'])

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
    expect((r.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Opt+Cmd+[ puts it behind all the others', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-c')
    await key('[', { ...FRONT, ...LEFT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-c', 'el-a', 'el-b'])
  })

  it('goes by the physical key: Option changes what a Mac types for ] and [', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    // Opt+] types U+2018 on a Mac; Opt+[ types U+201C.
    await key('‘', { ...FRONT, ...RIGHT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b', 'el-c', 'el-a'])
    await key('“', { ...FRONT, ...LEFT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('Cmd+] brings it forward one step and Cmd+[ sends it backward one step', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-b')
    await key(']', { ...CMD, ...RIGHT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-c', 'el-b'])
    await key('[', { ...CMD, ...LEFT_BRACKET })
    await key('[', { ...CMD, ...LEFT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b', 'el-a', 'el-c'])
  })

  it('the Option shortcut is the end, not one step: it comes before the plain one', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await key(']', { ...FRONT, ...RIGHT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    // One step forward would have given b, a, c.
    expect(idsOf(lastSave(adapter))).toEqual(['el-b', 'el-c', 'el-a'])
  })

  it('Ctrl works as Cmd does', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await key(']', { ctrlKey: true, ...RIGHT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b', 'el-a', 'el-c'])
    await key('[', { ctrlKey: true, altKey: true, ...LEFT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('several selected keep their own relative order, in one undo step', async () => {
    const { adapter } = await mountThree()
    // Picked in the opposite order to the slide.
    await plainClick('el-c')
    await shiftClick('el-b')
    await key('[', { ...CMD, ...LEFT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b', 'el-c', 'el-a'])

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-b', 'el-c'])
  })

  it('a selection apart: each passes its own neighbour, and Opt+Cmd+] sends them to the front in their order', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-c')
    await key(']', { ...CMD, ...RIGHT_BRACKET })
    // c is in front already; a passes b.
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(idsOf(lastSave(adapter))).toEqual(['el-b', 'el-a', 'el-c'])
    await key('[', { ...FRONT, ...LEFT_BRACKET })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(idsOf(lastSave(adapter))).toEqual(['el-a', 'el-c', 'el-b'])
  })

  it('an order that would not change makes no undo step and no save, but still keeps the browser from going back', async () => {
    const { adapter, r } = await mountThree()
    await plainClick('el-c')
    for (const [k, init] of [
      [']', { ...CMD, ...RIGHT_BRACKET }],
      [']', { ...FRONT, ...RIGHT_BRACKET }],
    ] as const) {
      const e = await key(k, init)
      // Cmd+[ and Cmd+] are history navigation in a browser.
      expect(e.defaultPrevented).toBe(true)
    }
    await plainClick('el-a')
    await key('[', { ...CMD, ...LEFT_BRACKET })
    await key('[', { ...FRONT, ...LEFT_BRACKET })
    expect(adapter.saveCalls).toHaveLength(0)
    expect((r.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('nothing happens with nothing selected', async () => {
    const { adapter } = await mountThree()
    const e = await key(']', { ...CMD, ...RIGHT_BRACKET })
    expect(e.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('Shift with the bracket is not claimed', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    const e = await key('}', { ...CMD, shiftKey: true, ...RIGHT_BRACKET })
    expect(e.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })
})

describe('CarouselEditor: Esc deselects (§556 M2)', () => {
  it('Esc clears the selection', async () => {
    const { adapter } = await mountThree()
    await plainClick('el-a')
    await shiftClick('el-b')
    const e = await key('Escape')
    expect(e.defaultPrevented).toBe(true)
    expect(outlined('el-a')).toBe(false)
    expect(outlined('el-b')).toBe(false)
    expect(handlesOn('el-a')).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('Esc with nothing selected is not claimed, so a host\'s own Esc still works', async () => {
    await mountThree()
    const e = await key('Escape')
    expect(e.defaultPrevented).toBe(false)
    await plainClick('el-a')
    await key('Escape')
    const again = await key('Escape')
    expect(again.defaultPrevented).toBe(false)
  })

  it('an armed note takes the first Esc, and the next one deselects', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} notes={{ enabled: true }} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    await key('n')
    expect(armLayer()).not.toBeNull()

    await key('Escape')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect((lastSave(adapter).notes as SlideNote[])).toHaveLength(1)
    expect(armLayer()).toBeNull()
    expect(outlined('el-img')).toBe(true)

    await key('Escape')
    expect(outlined('el-img')).toBe(false)
  })

  it('in crop mode Esc is the crop\'s: it applies the crop and the image stays selected', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    const source = findInteractiveWrapper('el-img').querySelector<HTMLImageElement>('img[alt="Crop source"]')
    await act(async () => { loadImage(source!, 400, 200) })

    await key('Escape')
    await waitFor(() => expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ crop: { x: 0, y: 0, w: 1, h: 1 } }))
    expect(handlesOn('el-img')).toBe(true)
    expect(outlined('el-img')).toBe(true)
  })
})

describe('CarouselEditor: where the element keys do not act (§556 M2)', () => {
  // Every key of this batch, as a user would press it.
  const KEYS: Array<[string, KeyboardEventInit]> = [
    ['c', CMD],
    ['x', CMD],
    ['v', CMD],
    ['d', CMD],
    ['a', CMD],
    ['ArrowRight', {}],
    ['ArrowDown', { shiftKey: true }],
    [']', { ...CMD, ...RIGHT_BRACKET }],
    ['[', { ...CMD, altKey: true, ...LEFT_BRACKET }],
    ['Escape', {}],
  ]

  it('while typing in an input, nothing happens: no default prevented, no save, selection kept', async () => {
    const { adapter, onProjectChange } = await mountThree()
    await plainClick('el-a')
    // A copy first, so Cmd+V has something to paste if it were let through.
    await key('c', CMD)

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      input.focus()
      for (const [k, init] of KEYS) {
        const e = await key(k, init, input)
        expect([k, e.defaultPrevented]).toEqual([k, false])
      }
      await keyUp('ArrowRight', {}, input)
      expect(adapter.saveCalls).toHaveLength(0)
      expect(posOf(liveProject(onProjectChange))).toEqual([[100, 100], [500, 400], [700, 700]])
      expect(outlined('el-a')).toBe(true)
    } finally {
      input.remove()
    }
  })

  it('in the inline text editor, nothing happens either', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    const r = render(<CarouselEditor project={textOverlaySlide()} adapter={adapter} onProjectChange={onProjectChange} />)
    await waitFor(() => findInteractiveWrapper('el-ov'))
    await plainClick('el-ov')
    await key('c', CMD)
    await act(async () => { fireEvent.doubleClick(findInteractiveWrapper('el-ov')) })
    const editor = r.getByRole('textbox', { name: 'Edit text' })
    expect(document.activeElement).toBe(editor)

    // Not Esc: the editor takes that one itself, and cancels.
    for (const [k, init] of KEYS.filter(([k]) => k !== 'Escape')) {
      const e = await key(k, init, editor)
      expect([k, e.defaultPrevented]).toEqual([k, false])
    }
    expect(adapter.saveCalls).toHaveLength(0)
    expect(interactiveHas('el-ov')).toBe(true)
    expect(elementsOf(liveProject(onProjectChange))).toHaveLength(1)
    expect(outlined('el-ov')).toBe(true)
  })

  it('in crop mode, none of them acts', async () => {
    const { adapter, onProjectChange, r } = await mountThree()
    await plainClick('el-a')
    await key('c', CMD)
    await act(async () => { fireEvent.click(await r.findByTitle('Crop image')) })
    expect(findInteractiveWrapper('el-a').querySelector('img[alt="Crop source"]')).not.toBeNull()

    for (const [k, init] of KEYS.filter(([k]) => k !== 'Escape')) {
      const e = await key(k, init)
      expect([k, e.defaultPrevented]).toEqual([k, false])
    }
    await keyUp('ArrowRight')
    expect(adapter.saveCalls).toHaveLength(0)
    expect(posOf(liveProject(onProjectChange))).toEqual([[100, 100], [500, 400], [700, 700]])
    // Still in crop mode, and still the one image selected.
    expect(findInteractiveWrapper('el-a').querySelector('img[alt="Crop source"]')).not.toBeNull()
    expect(outlined('el-a')).toBe(true)
  })

  it('with no slide selected, none of them acts', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={makeProject({ status: 'pending', slides: [] })} adapter={adapter} onProjectChange={vi.fn()} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    for (const [k, init] of KEYS) {
      const e = await key(k, init)
      expect([k, e.defaultPrevented]).toEqual([k, false])
    }
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('in a project that cannot be edited, only the keys that leave it alone act', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<CarouselEditor project={{ ...threeElements(), status: 'storyboard_ready' }} adapter={adapter} onProjectChange={onProjectChange} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')

    // Copying changes nothing, so it still works: Paste then has something, and still does not act.
    await key('c', CMD)
    for (const [k, init] of KEYS.filter(([k]) => ['x', 'v', 'd', 'ArrowRight', ']', '['].includes(k))) {
      const e = await key(k, init)
      expect([k, e.defaultPrevented]).toEqual([k, false])
    }
    const front = await key(']', { ...CMD, altKey: true, ...RIGHT_BRACKET })
    expect(front.defaultPrevented).toBe(false)
    await keyUp('ArrowRight')
    expect(adapter.saveCalls).toHaveLength(0)
    expect(idsOf(liveProject(onProjectChange))).toEqual(['el-a', 'el-b', 'el-c'])
    expect(posOf(liveProject(onProjectChange))).toEqual([[100, 100], [500, 400], [700, 700]])

    // Selecting is not editing.
    const all = await key('a', CMD)
    expect(all.defaultPrevented).toBe(true)
    for (const id of ['el-a', 'el-b', 'el-c']) expect(outlined(id)).toBe(true)
    const esc = await key('Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(outlined('el-a')).toBe(false)
  })

  it('Copy still works in a project that cannot be edited yet: what was copied is there once it can', async () => {
    const adapter = makeFakeAdapter()
    let push: ((p: Project) => void) | undefined
    adapter.subscribe = (_id, onFrame) => {
      push = onFrame
      return () => {}
    }
    render(<CarouselEditor project={{ ...threeElements(), status: 'storyboard_ready' }} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-a'))
    await plainClick('el-a')
    await key('c', CMD)
    const early = await key('v', CMD)
    expect(early.defaultPrevented).toBe(false)

    await act(async () => { push!({ ...threeElements(), status: 'draft' }) })
    const paste = await key('v', CMD)
    expect(paste.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter)).map((e) => (e as ImageElement).src)).toEqual(['a.png', 'b.png', 'c.png', 'a.png'])
  })

  it('while the Controls window is open, they are held', async () => {
    const { adapter, r } = await mountThree()
    await plainClick('el-a')
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Editor controls & shortcuts' })) })
    await r.findByRole('dialog', { name: 'Editor controls' })

    for (const [k, init] of KEYS.filter(([k]) => k !== 'Escape')) {
      const e = await key(k, init)
      expect([k, e.defaultPrevented]).toEqual([k, false])
    }
    expect(adapter.saveCalls).toHaveLength(0)
    expect(outlined('el-a')).toBe(true)
  })

  it('the pending view keeps Cmd+A for the page', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={makeProject({ status: 'pending' })} adapter={adapter} onProjectChange={vi.fn()} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    const e = await key('a', CMD)
    expect(e.defaultPrevented).toBe(false)
  })
})

// ── Resize handles and clicks (§556 M3) ─────────────────────────────────────
//
// Corner handles keep the box ratio unless Shift is held, a release never
// changes the selection, and a press and release in place records nothing.

describe('CarouselEditor: resize handles and clicks (§556 M3)', () => {
  function handleOf(id: string, testId: string): HTMLElement {
    return findInteractiveWrapper(id).querySelector(`[data-testid="${testId}"]`) as HTMLElement
  }

  it('a press and release in place, on the element, a handle or the rotate handle, records nothing: undo then takes back the edit before', async () => {
    const adapter = makeFakeAdapter()
    const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align left' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))

    // Twice on the element, as a double-click does.
    const targets = [
      () => findInteractiveWrapper('el-img'),
      () => findInteractiveWrapper('el-img'),
      () => handleOf('el-img', 'resize-handle-se'),
      () => handleOf('el-img', 'rotate-handle'),
    ]
    for (const target of targets) {
      const el = target()
      await act(async () => {
        pointer(el, 'pointerdown', { clientX: 200, clientY: 200 })
        pointer(window, 'pointerup', { clientX: 200, clientY: 200 })
        fireEvent.click(el)
      })
    }
    await act(async () => { await new Promise((res) => setTimeout(res, 20)) })
    expect(adapter.saveCalls).toHaveLength(1)
    expect(handlesOn('el-img')).toBe(true)

    await key('z', { metaKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ x: 100, y: 100 })
    expect((r.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('letting go of a resize or rotate handle off the element keeps it selected', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    const canvas = document.querySelector('[data-interactive]') as HTMLElement

    for (const testId of ['resize-handle-se', 'rotate-handle']) {
      await act(async () => {
        pointer(handleOf('el-img', testId), 'pointerdown', { clientX: 0, clientY: -20 })
        pointer(window, 'pointermove', { clientX: 60, clientY: 40 })
        pointer(window, 'pointerup', { clientX: 60, clientY: 40 })
        // The browser sends the click to the nearest box holding both the
        // press and the release: here, the canvas.
        fireEvent.click(canvas)
      })
      expect(handlesOn('el-img')).toBe(true)
    }
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
  })

  it('a corner drag keeps the ratio; Shift held during the move frees it', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => findInteractiveWrapper('el-img'))
    await plainClick('el-img')
    const scale = parseFloat((document.querySelector('[data-interactive]') as HTMLElement).style.width) / 1080

    // 60, 10 on the slide. The 200 x 200 square grows by its diagonal's share:
    // 1 + (200 * 60 + 200 * 10) / (2 * 200²) = 1.175, so 235 x 235.
    await act(async () => {
      pointer(handleOf('el-img', 'resize-handle-se'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: 60 * scale, clientY: 10 * scale })
      pointer(window, 'pointerup')
    })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ x: 100, y: 100, w: 235, h: 235 })

    await act(async () => {
      pointer(handleOf('el-img', 'resize-handle-se'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: 60 * scale, clientY: 10 * scale, shiftKey: true })
      pointer(window, 'pointerup')
    })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ x: 100, y: 100, w: 295, h: 245 })
  })
})
