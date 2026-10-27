import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
    slides: [
      { id: 'slide-0', base_color: '#ffffff', elements: [{ id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 }] },
      { id: 'slide-1', base_color: '#ffffff', elements: [] },
    ],
  } as Project
}

function makeAdapter() {
  const saveCalls: Array<{ id: string; project: Project }> = []
  const adapter: EditorAdapter<Project> & { saveCalls: typeof saveCalls } = {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
  }
  return adapter
}

const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  vi.restoreAllMocks()
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

const ITEMS = ['Media', 'Elements', 'Text', 'AI image', 'Layers', 'Background', 'Notes']
const NOTES_SLOT = { carouselNotesPanel: <div data-testid="notes" /> }

function mount(extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}) {
  const adapter = makeAdapter()
  const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} layout="rail" {...extra} />)
  return { adapter, ...r }
}
const rail = (r: ReturnType<typeof mount>) => r.getByRole('navigation', { name: 'Editor rail' })
const item = (r: ReturnType<typeof mount>, name: string) => within(rail(r)).getByRole('button', { name })
const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }

describe('CarouselEditor layout="rail" shell', () => {
  it('classic layout has no rail', async () => {
    const adapter = makeAdapter()
    const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => wrapperOf('el-img'))
    expect(r.queryByRole('navigation', { name: 'Editor rail' })).toBeNull()
  })

  it('renders the top bar, a rail of 7 items and the bottom bar', async () => {
    const r = mount({ slots: NOTES_SLOT, notes: { enabled: true } })
    await waitFor(() => wrapperOf('el-img'))
    expect(r.getByRole('banner', { name: 'Top bar' })).toBeTruthy()
    const buttons = within(rail(r)).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(ITEMS)
    for (const b of buttons) expect(b.getAttribute('aria-pressed')).toBe('false')
    const bottom = r.getByRole('contentinfo', { name: 'Bottom bar' })
    expect(within(bottom).getByText('Fit')).toBeTruthy()
    expect(within(bottom).getByRole('button', { name: /Slides 1 \/ 2/ })).toBeTruthy()
    // The grid view is real since §587 M2 (RailStack.test.tsx).
    expect(within(bottom).getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed')).toBe('false')
    expect(r.getByText('1080 × 1350')).toBeTruthy()
    // The old left slide rail and the right property panel are not shown.
    expect(r.queryByText('Add element')).toBeNull()
  })

  it('clicking an item opens its panel, clicking again closes it, one at a time', async () => {
    const r = mount()
    await waitFor(() => wrapperOf('el-img'))
    expect(r.queryByRole('region', { name: 'Elements panel' })).toBeNull()
    await act(async () => { fireEvent.click(item(r, 'Elements')) })
    expect(r.getByRole('region', { name: 'Elements panel' })).toBeTruthy()
    expect(item(r, 'Elements').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { fireEvent.click(item(r, 'Layers')) })
    expect(r.queryByRole('region', { name: 'Elements panel' })).toBeNull()
    expect(r.getByRole('region', { name: 'Layers panel' })).toBeTruthy()
    expect(item(r, 'Elements').getAttribute('aria-pressed')).toBe('false')
    await act(async () => { fireEvent.click(item(r, 'Layers')) })
    expect(r.queryByRole('region', { name: 'Layers panel' })).toBeNull()
  })

  it('Esc in the panel closes it', async () => {
    const r = mount()
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(item(r, 'Text')) })
    const panel = r.getByRole('region', { name: 'Text panel' })
    await act(async () => { fireEvent.keyDown(panel, { key: 'Escape' }) })
    expect(r.queryByRole('region', { name: 'Text panel' })).toBeNull()
  })

  it('host slots fill Media and the top bar; an override prop wins', async () => {
    const r = mount({
      slots: {
        carouselTopLeft: <div data-testid="tl" />,
        carouselTopRight: <div data-testid="tr" />,
        carouselMediaPanel: <div data-testid="media" />,
      },
      railPanels: { layers: <div data-testid="layers-custom" /> },
    })
    await waitFor(() => wrapperOf('el-img'))
    const top = r.getByRole('banner', { name: 'Top bar' })
    expect(within(top).getByTestId('tl')).toBeTruthy()
    expect(within(top).getByTestId('tr')).toBeTruthy()
    await act(async () => { fireEvent.click(item(r, 'Media')) })
    expect(within(r.getByRole('region', { name: 'Media panel' })).getByTestId('media')).toBeTruthy()
    // There is no Brand item.
    expect(within(rail(r)).queryByRole('button', { name: 'Brand' })).toBeNull()
    await act(async () => { fireEvent.click(item(r, 'Layers')) })
    expect(r.queryByTestId('media')).toBeNull()
    expect(r.getByTestId('layers-custom')).toBeTruthy()
  })

  it('Notes opens the right panel with the host content, not the side panel', async () => {
    const r = mount({ notes: { enabled: true }, slots: { carouselNotesPanel: <div data-testid="notes" />, carouselMediaPanel: <div data-testid="media" /> } })
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(item(r, 'Media')) })
    await act(async () => { fireEvent.click(item(r, 'Notes')) })
    const right = r.getByRole('complementary', { name: 'Notes panel' })
    expect(within(right).getByTestId('notes')).toBeTruthy()
    expect(r.queryByRole('region', { name: 'Notes panel' })).toBeNull()
    expect(r.queryByTestId('media')).toBeNull()
    await act(async () => { fireEvent.click(within(right).getByRole('button', { name: 'Close' })) })
    expect(r.queryByRole('complementary', { name: 'Notes panel' })).toBeNull()
    expect(item(r, 'Notes').getAttribute('aria-pressed')).toBe('false')
  })

  it('Notes and a side panel are mutually exclusive', async () => {
    const r = mount({ slots: NOTES_SLOT, notes: { enabled: true } })
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(item(r, 'Elements')) })
    expect(r.getByRole('region', { name: 'Elements panel' })).toBeTruthy()
    await act(async () => { fireEvent.click(item(r, 'Notes')) })
    expect(r.queryByRole('region', { name: 'Elements panel' })).toBeNull()
    expect(r.getByRole('complementary', { name: 'Notes panel' })).toBeTruthy()
    expect(item(r, 'Elements').getAttribute('aria-pressed')).toBe('false')
    expect(item(r, 'Notes').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { fireEvent.click(item(r, 'Text')) })
    expect(r.queryByRole('complementary', { name: 'Notes panel' })).toBeNull()
    expect(r.getByRole('region', { name: 'Text panel' })).toBeTruthy()
    expect(item(r, 'Notes').getAttribute('aria-pressed')).toBe('false')
  })

  it('undo and redo in the top bar work', async () => {
    const r = mount()
    await waitFor(() => wrapperOf('el-img'))
    const top = r.getByRole('banner', { name: 'Top bar' })
    const undo = within(top).getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    const redo = within(top).getByRole('button', { name: 'Redo' }) as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    await act(async () => { fireEvent.click(wrapperOf('el-img')) })
    await act(async () => { fireEvent.keyDown(document, { key: 'Delete' }) })
    await waitFor(() => expect(wrapperOf('el-img')).toBeUndefined())
    expect(undo.disabled).toBe(false)
    await act(async () => { fireEvent.click(undo) })
    await waitFor(() => expect(wrapperOf('el-img')).toBeDefined())
    expect(redo.disabled).toBe(false)
    await act(async () => { fireEvent.click(redo) })
    await waitFor(() => expect(wrapperOf('el-img')).toBeUndefined())
  })

  it('Cmd+Z still undoes in the rail layout', async () => {
    const r = mount()
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(wrapperOf('el-img')) })
    await act(async () => { fireEvent.keyDown(document, { key: 'Delete' }) })
    await waitFor(() => expect(wrapperOf('el-img')).toBeUndefined())
    await act(async () => { fireEvent.keyDown(document, { key: 'z', metaKey: true, ctrlKey: true }) })
    await waitFor(() => expect(wrapperOf('el-img')).toBeDefined())
    r.unmount()
  })

  it('the help icon opens the Controls window', async () => {
    const r = mount()
    await waitFor(() => wrapperOf('el-img'))
    expect(r.queryByText('Editor controls')).toBeNull()
    const btn = within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: 'Controls' })
    // An icon, not a typed glyph.
    expect(btn.textContent).toBe('')
    expect(btn.querySelector('svg')).not.toBeNull()
    await act(async () => { fireEvent.click(btn) })
    expect(r.getByText('Editor controls')).toBeTruthy()
  })

  it('Slides N / M lists the slides and selects one', async () => {
    const onSelectedSlideChange = vi.fn()
    const r = mount({ onSelectedSlideChange })
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(r.getByRole('button', { name: /Slides 1 \/ 2/ })) })
    await act(async () => { fireEvent.click(r.getByRole('option', { name: 'Slide 2' })) })
    expect(r.getByRole('button', { name: /Slides 2 \/ 2/ })).toBeTruthy()
  })

  it('opening a panel applies a pending crop first', async () => {
    const r = mount({ slots: { carouselMediaPanel: <div data-testid="media" /> } })
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(wrapperOf('el-img')) })
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-img')) })
    expect(document.querySelector('img[alt="Crop source"]')).not.toBeNull()
    await act(async () => { fireEvent.click(item(r, 'Media')) })
    await waitFor(() => expect(document.querySelector('img[alt="Crop source"]')).toBeNull())
    expect(r.getByTestId('media')).toBeTruthy()
  })

  it('N opens the Notes panel (closing a side panel) so the new note is on screen', async () => {
    const onNoteAdded = vi.fn()
    const r = mount({ slots: { ...NOTES_SLOT, carouselMediaPanel: <div data-testid="media" /> }, notes: { enabled: true, onNoteAdded } })
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(item(r, 'Media')) })
    expect(r.getByTestId('media')).toBeTruthy()
    const press = async () => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })) }) }
    await press()
    await press()
    expect(onNoteAdded).toHaveBeenCalledTimes(1)
    expect(r.getByRole('complementary', { name: 'Notes panel' })).toBeTruthy()
    expect(r.queryByTestId('media')).toBeNull()
    expect(item(r, 'Notes').getAttribute('aria-pressed')).toBe('true')
  })

  it('N does not open Notes when the host has no notes panel', async () => {
    const r = mount({ notes: { enabled: true } })
    await waitFor(() => wrapperOf('el-img'))
    const press = async () => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })) }) }
    await press()
    await press()
    expect(r.queryByRole('complementary', { name: 'Notes panel' })).toBeNull()
  })

  it('locked notes: the Notes item calls onLocked and opens nothing', async () => {
    const onLocked = vi.fn()
    const r = mount({ notes: { enabled: false, onLocked } })
    await waitFor(() => wrapperOf('el-img'))
    await act(async () => { fireEvent.click(item(r, 'Notes')) })
    expect(onLocked).toHaveBeenCalledTimes(1)
    expect(r.queryByRole('complementary', { name: 'Notes panel' })).toBeNull()
    expect(item(r, 'Notes').getAttribute('aria-pressed')).toBe('false')
  })

  it('no notes option: the Notes item is hidden', async () => {
    const r = mount()
    await waitFor(() => wrapperOf('el-img'))
    expect(within(rail(r)).getAllByRole('button').map((b) => b.textContent)).toEqual(ITEMS.slice(0, 6))
  })
})
