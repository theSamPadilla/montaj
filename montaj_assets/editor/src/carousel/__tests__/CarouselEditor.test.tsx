import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import { Keyboard, MousePointer2 } from 'lucide-react'
import type { CarouselRenderModalContext, ControlsWindowContext, EditorAdapter, ImageElement, Project, RenderEvent, SlideNotesApi, SlidePin } from '../../types'
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

  // Delete / Backspace removes the selected element and persists the removal.
  it('deletes the selected element on Delete keypress', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeProject()
    render(<CarouselEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} />)

    const wrapper = await waitFor(() => findInteractiveWrapper('el-img'))
    await act(async () => { fireEvent.click(wrapper) })

    await act(async () => { fireEvent.keyDown(window, { key: 'Delete' }) })

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
      expect(keyboard.entries.map((e) => e.keys)).toEqual([['Ctrl', 'Z'], ['Ctrl', 'Shift', 'Z'], ['Delete'], ['N']])

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

async function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = window): Promise<KeyboardEvent> {
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
