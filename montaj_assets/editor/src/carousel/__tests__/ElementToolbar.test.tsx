import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, GlobalOverlay, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// The rail layout's element toolbar (§587 M3): what the selection can do, along
// the top of the canvas, and the Position popover with today's panel content.

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [{
      id: 'slide-0', base_color: '#ffffff',
      elements: [
        { id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 },
        { id: 'el-b', type: 'image', src: 'b.png', x: 500, y: 400, w: 100, h: 300, rotation: 0 },
        {
          id: 'el-t', type: 'overlay', frame: 0, x: 300, y: 700, w: 400, h: 100, rotation: 0,
          overlay: {
            template: '/overlays/text.jsx',
            props: { text: 'Hello', fontFamily: '"Inter", system-ui, sans-serif', fontSize: '32px', color: '#111111', fontWeight: '400', fontStyle: 'normal', textAlign: 'left', effect: 'none', tagline: 'Hi' },
          },
        },
      ],
    }],
  } as Project
}

/** Schemas for the overlay templates: a code element (badge) and the text template. */
const OVERLAYS: GlobalOverlay[] = [
  {
    name: 'Badge', description: '', jsxPath: '/overlays/badge.jsx',
    props: [{ name: 'accent', type: 'color' }, { name: 'show', type: 'bool' }, { name: 'label', type: 'string' }],
  },
  {
    name: 'Text', description: '', jsxPath: '/overlays/text.jsx',
    props: [{ name: 'text', type: 'string' }, { name: 'fontSize', type: 'string' }, { name: 'effect', type: 'string' }, { name: 'tagline', type: 'string' }],
  },
]

function makeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => OVERLAYS),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
  } as FakeAdapter
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

/** The base project plus a code element (el-ov, the badge template, frame 3). */
function withBadge(): Project {
  const p = makeProject()
  p.slides![0].elements.push({
    id: 'el-ov', type: 'overlay', frame: 3, x: 600, y: 100, w: 200, h: 100, rotation: 0,
    overlay: { template: '/overlays/badge.jsx', props: { accent: '#ff0000', show: true, label: 'Hi' } },
  } as never)
  return p
}

async function mount(layout: 'rail' | 'classic' = 'rail', extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}, project: Project = makeProject()) {
  const adapter = makeAdapter()
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout={layout} {...extra} />)
  await waitFor(() => expect(document.querySelector('[data-element-id="el-img"]')).not.toBeNull())
  return { adapter, r }
}

const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }
const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project
const elementsOf = (p: Project) => p.slides![0].elements
const byId = (p: Project, id: string) => elementsOf(p).find((e) => e.id === id)!
const propsOf = (p: Project, id: string) => (byId(p, id) as unknown as { overlay: { props: Record<string, unknown> } }).overlay.props
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })

async function click(id: string) {
  await act(async () => { fireEvent.click(wrapperOf(id)) })
}
function pointer(target: EventTarget, type: 'pointerdown' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}
async function shiftClick(id: string) {
  const w = wrapperOf(id)
  await act(async () => {
    pointer(w, 'pointerdown', { shiftKey: true, clientX: 10, clientY: 10 })
    pointer(window, 'pointerup')
    fireEvent.click(w, { shiftKey: true })
  })
}
async function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })) })
}
const undo = () => key('z', { metaKey: true })

const toolbar = (r: ReturnType<typeof render>) => r.getByRole('toolbar', { name: 'Element' })
const tb = (r: ReturnType<typeof render>, name: string | RegExp) => within(toolbar(r)).getByRole('button', { name }) as HTMLButtonElement
const tbNames = (r: ReturnType<typeof render>) =>
  within(toolbar(r)).queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
async function press(button: HTMLElement) {
  await act(async () => { fireEvent.click(button) })
}
const popover = (r: ReturnType<typeof render>, name: string) => r.getByRole('dialog', { name })
const field = (scope: HTMLElement, name: string) => within(scope).getByRole('spinbutton', { name }) as HTMLInputElement
async function type(input: HTMLInputElement, text: string) {
  input.focus()
  for (let i = 1; i <= text.length; i++) {
    await act(async () => { fireEvent.change(input, { target: { value: text.slice(0, i) } }) })
  }
}

describe('Element toolbar (§587 M3, layout="rail")', () => {
  it('shows nothing with nothing selected, and is not in the classic layout', async () => {
    const { r } = await mount()
    expect(r.queryByRole('toolbar', { name: 'Element' })).toBeNull()
    r.unmount()
    const classic = await mount('classic')
    await click('el-t')
    expect(classic.r.queryByRole('toolbar', { name: 'Element' })).toBeNull()
    // The classic panel is still there.
    expect(classic.r.getByRole('spinbutton', { name: 'X' })).toBeTruthy()
  })

  it('a text overlay gets the text controls, then the common group', async () => {
    const { r } = await mount()
    await click('el-t')
    const names = tbNames(r)
    for (const n of ['Font family', 'Decrease font size', 'Increase font size', 'Bold', 'Italic', 'Effects', 'Position', 'Lock', 'Duplicate', 'Delete']) {
      expect(names).toContain(n)
    }
    // The colour control is today's (a native picker) until the colour panel lands.
    expect(within(toolbar(r)).getByLabelText('Text color')).toBeTruthy()
    expect(names.some((n) => /^Text alignment/.test(n ?? ''))).toBe(true)
    expect(within(toolbar(r)).getByRole('spinbutton', { name: 'Font size' })).toBeTruthy()
    expect(names).not.toContain('Crop')
    expect(names).not.toContain('Replace')
    // No right property panel in the rail layout.
    expect(r.queryByText('Background color')).toBeNull()
  })

  it('an image gets Crop and Replace, then the common group', async () => {
    const { r } = await mount()
    await click('el-img')
    const names = tbNames(r)
    expect(names).toEqual(expect.arrayContaining(['Crop', 'Replace', 'Position', 'Lock', 'Duplicate', 'Delete']))
    expect(names).not.toContain('Bold')
    expect(names).not.toContain('Effects')
  })

  it('a font size step writes once: one save and one undo step', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    await press(tb(r, 'Increase font size'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').fontSize).toBe('33px')
    await press(tb(r, 'Decrease font size'))
    await press(tb(r, 'Decrease font size'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(propsOf(last(adapter), 'el-t').fontSize).toBe('31px')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(propsOf(last(adapter), 'el-t').fontSize).toBe('32px')
  })

  it('Bold and the text alignment write through the same text handlers', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    await press(tb(r, 'Bold'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').fontWeight).toBe('700')
    expect(tb(r, 'Bold').getAttribute('aria-pressed')).toBe('true')
    await press(tb(r, /^Text alignment/))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-t').textAlign).toBe('center')
  })

  it('Effects opens today\'s effect controls in a popover', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    expect(r.queryByRole('dialog', { name: 'Effects' })).toBeNull()
    await press(tb(r, 'Effects'))
    const pop = popover(r, 'Effects')
    await press(within(pop).getByRole('radio', { name: 'Shadow' }))
    await waitFor(() => expect(propsOf(last(adapter), 'el-t').effect).toBe('shadow'))
  })

  it('Position holds align and layer order only, no number fields; Esc closes it', async () => {
    const { r } = await mount()
    await click('el-img')
    await press(tb(r, 'Position'))
    expect(tb(r, 'Position').getAttribute('aria-expanded')).toBe('true')
    const pop = popover(r, 'Position')
    for (const name of ['X', 'Y', 'W', 'H', 'Rotation']) expect(within(pop).queryByLabelText(name)).toBeNull()
    expect(within(pop).queryAllByRole('spinbutton')).toHaveLength(0)
    expect(within(pop).queryAllByRole('textbox')).toHaveLength(0)
    expect(within(pop).getAllByRole('button').length).toBeGreaterThan(0)
    await key('Escape')
    expect(r.queryByRole('dialog', { name: 'Position' })).toBeNull()
    expect(toolbar(r)).toBeTruthy()
  })

  it('align and layer order in the Position popover, each one undo step', async () => {
    const { adapter, r } = await mount()
    await click('el-img')
    await press(tb(r, 'Position'))
    await press(within(popover(r, 'Position')).getByRole('button', { name: 'Align left' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-img')).toMatchObject({ x: 0, y: 100 })

    await press(within(popover(r, 'Position')).getByRole('button', { name: 'Bring to front' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-b', 'el-t', 'el-img'])
    await press(within(popover(r, 'Position')).getByRole('button', { name: 'Send backward' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-b', 'el-img', 'el-t'])
    await press(within(popover(r, 'Position')).getByRole('button', { name: 'Send to back' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-img', 'el-b', 'el-t'])
    await press(within(popover(r, 'Position')).getByRole('button', { name: 'Bring forward' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(5))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-b', 'el-img', 'el-t'])

    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(6))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-img', 'el-b', 'el-t'])
  })

  it('a multi-selection gets the multi toolbar: Position aligns and distributes the selection, lock, duplicate, delete', async () => {
    const { adapter, r } = await mount()
    await click('el-img')
    await shiftClick('el-b')
    await shiftClick('el-t')
    const names = tbNames(r)
    expect(names).toEqual(['Position', 'Lock', 'Duplicate', 'Delete'])
    await press(tb(r, 'Position'))
    const pop = popover(r, 'Position')
    expect(within(pop).queryByRole('spinbutton', { name: 'X' })).toBeNull()
    await press(within(pop).getByRole('button', { name: 'Align left' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    // To the selection's box, not the page.
    expect(elementsOf(last(adapter)).map((e) => e.x)).toEqual([100, 100, 100])
    await press(within(popover(r, 'Position')).getByRole('button', { name: 'Distribute vertically' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))

    await press(tb(r, 'Duplicate'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(elementsOf(last(adapter))).toHaveLength(6)
    await press(tb(r, 'Delete'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-img', 'el-b', 'el-t'])
  })

  it('Lock locks in one step; then the text controls are off, layer order and duplicate still work, Unlock frees it', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    await press(tb(r, 'Lock'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-t')).toMatchObject({ locked: true })

    // Off as a disabled fieldset turns them off, as in the classic panel.
    for (const n of ['Font family', 'Increase font size', 'Bold', 'Italic', 'Effects', 'Delete']) {
      expect(tb(r, n)).toBeDisabled()
    }
    expect(tb(r, /^Text alignment/)).toBeDisabled()
    expect(within(toolbar(r)).getByRole('spinbutton', { name: 'Font size' })).toBeDisabled()
    expect(within(toolbar(r)).getByLabelText('Text color')).toBeDisabled()
    // A click on one writes nothing.
    await press(tb(r, 'Bold'))
    await settle()
    expect(adapter.saveCalls).toHaveLength(1)
    expect(tb(r, 'Unlock')).not.toBeDisabled()
    expect(tb(r, 'Duplicate')).not.toBeDisabled()
    expect(tb(r, 'Position')).not.toBeDisabled()

    await press(tb(r, 'Position'))
    const pop = popover(r, 'Position')
    expect(within(pop).queryAllByRole('spinbutton')).toHaveLength(0)
    expect(within(pop).getByRole('button', { name: 'Align left' })).toBeDisabled()
    await press(within(pop).getByRole('button', { name: 'Send to back' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-t', 'el-img', 'el-b'])

    // A copy of a locked element is free.
    await press(tb(r, 'Duplicate'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    const copy = elementsOf(last(adapter))[1]
    expect(copy.id).not.toBe('el-t')
    expect(copy.locked).toBeUndefined()
    // The copy is selected: back to the original and unlock it.
    await click('el-t')
    await press(tb(r, 'Unlock'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(byId(last(adapter), 'el-t').locked).toBeUndefined()
    expect(tb(r, 'Bold')).not.toBeDisabled()

    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(5))
    expect(byId(last(adapter), 'el-t')).toMatchObject({ locked: true })
  })

  it('Duplicate and Delete for one element', async () => {
    const { adapter, r } = await mount()
    await click('el-img')
    await press(tb(r, 'Duplicate'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const els = elementsOf(last(adapter))
    expect(els).toHaveLength(4)
    expect(els[1]).toMatchObject({ type: 'image', x: 120, y: 120 })
    await press(tb(r, 'Delete'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-img', 'el-b', 'el-t'])
    expect(r.queryByRole('toolbar', { name: 'Element' })).toBeNull()
  })

  it('a toolbar action applies a pending crop first', async () => {
    const { adapter, r } = await mount()
    await click('el-img')
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-img')) })
    expect(document.querySelector('img[alt="Crop source"]')).not.toBeNull()
    expect(tb(r, 'Crop').getAttribute('aria-pressed')).toBe('true')
    await press(tb(r, 'Lock'))
    await waitFor(() => expect(document.querySelector('img[alt="Crop source"]')).toBeNull())
    await waitFor(() => expect(byId(last(adapter), 'el-img')).toMatchObject({ locked: true }))
  })

  it('opening Position applies a pending crop first; Crop while cropping leaves crop mode', async () => {
    const { r } = await mount()
    await click('el-img')
    await press(tb(r, 'Crop'))
    expect(document.querySelector('img[alt="Crop source"]')).not.toBeNull()
    await press(tb(r, 'Position'))
    await waitFor(() => expect(document.querySelector('img[alt="Crop source"]')).toBeNull())
    expect(popover(r, 'Position')).toBeTruthy()

    await press(tb(r, 'Crop'))
    expect(document.querySelector('img[alt="Crop source"]')).not.toBeNull()
    expect(r.queryByRole('dialog', { name: 'Position' })).toBeNull()
    await press(tb(r, 'Crop'))
    await waitFor(() => expect(document.querySelector('img[alt="Crop source"]')).toBeNull())
  })
})

describe('Element toolbar: Edit, hide and popover closing (§587 M3)', () => {
  it('a code element gets Edit: its schema props and Frame; a prop change is one save and one undo step', async () => {
    const { adapter, r } = await mount('rail', {}, withBadge())
    await click('el-ov')
    expect(tbNames(r)).toEqual(['Edit', 'Position', 'Lock', 'Duplicate', 'Delete'])
    await press(tb(r, 'Edit'))
    const pop = popover(r, 'Edit')
    const show = await waitFor(() => within(pop).getByRole('checkbox', { name: 'show' }))
    expect(within(pop).getByLabelText('accent')).toBeTruthy()
    expect(within(pop).getByRole('textbox', { name: 'label' })).toBeTruthy()
    await press(show)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-ov').show).toBe('false')
    // A bool prop saved as the string 'false' reads as off.
    expect((within(popover(r, 'Edit')).getByRole('checkbox', { name: 'show' }) as HTMLInputElement).checked).toBe(false)
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-ov').show).toBe(true)
    await undo()
    await settle()
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('Frame in the Edit popover writes once on Enter', async () => {
    const { adapter, r } = await mount('rail', {}, withBadge())
    await click('el-ov')
    await press(tb(r, 'Edit'))
    const frame = field(popover(r, 'Edit'), 'Frame')
    expect(frame.value).toBe('3')
    await type(frame, '7')
    await act(async () => { fireEvent.keyDown(frame, { key: 'Enter' }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-ov')).toMatchObject({ frame: 7 })
  })

  it('for a text overlay, Edit holds Frame and only the props the text toolbar does not cover', async () => {
    const { r } = await mount()
    await click('el-t')
    await press(tb(r, 'Edit'))
    const pop = popover(r, 'Edit')
    await waitFor(() => expect(within(pop).getByRole('textbox', { name: 'tagline' })).toBeTruthy())
    expect(field(pop, 'Frame')).toBeTruthy()
    expect(within(pop).queryByRole('textbox', { name: 'fontSize' })).toBeNull()
    expect(within(pop).queryByRole('textbox', { name: 'text' })).toBeNull()
    expect(within(pop).queryByRole('textbox', { name: 'effect' })).toBeNull()
  })

  it('for a locked overlay the Edit popover opens with its controls off', async () => {
    const { adapter, r } = await mount('rail', {}, withBadge())
    await click('el-ov')
    await press(tb(r, 'Lock'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(tb(r, 'Edit')).not.toBeDisabled()
    await press(tb(r, 'Edit'))
    const pop = popover(r, 'Edit')
    const show = await waitFor(() => within(pop).getByRole('checkbox', { name: 'show' }))
    expect(show).toBeDisabled()
    expect(within(pop).getByRole('textbox', { name: 'label' })).toBeDisabled()
    expect(field(pop, 'Frame')).toBeDisabled()
    await press(show)
    await settle()
    expect(adapter.saveCalls).toHaveLength(1)
  })

  it('the eye hides and shows the element through the host, also when locked; no eye without the host callback', async () => {
    const onToggleElementVisibility = vi.fn()
    const { r } = await mount('rail', { onToggleElementVisibility, hiddenElementIds: [] }, withBadge())
    await click('el-ov')
    const eye = tb(r, 'Hide from editor')
    expect(eye.getAttribute('aria-pressed')).toBe('false')
    await press(eye)
    expect(onToggleElementVisibility).toHaveBeenCalledWith('el-ov')
    await press(tb(r, 'Lock'))
    expect(tb(r, 'Hide from editor')).not.toBeDisabled()
    r.rerender(<CarouselEditor project={withBadge()} adapter={makeAdapter()} onProjectChange={vi.fn()} layout="rail" onToggleElementVisibility={onToggleElementVisibility} hiddenElementIds={['el-ov']} />)
    expect(tb(r, 'Show in editor').getAttribute('aria-pressed')).toBe('true')
    r.unmount()

    const bare = await mount('rail', {}, withBadge())
    await click('el-ov')
    expect(tbNames(bare.r)).not.toContain('Hide from editor')
  })

  it('an open popover closes when the selected element changes', async () => {
    const { r } = await mount()
    await click('el-img')
    await press(tb(r, 'Position'))
    expect(popover(r, 'Position')).toBeTruthy()
    await click('el-b')
    expect(r.queryByRole('dialog', { name: 'Position' })).toBeNull()
    expect(toolbar(r)).toBeTruthy()
  })

  it('classic is unchanged: the panel still shows the props, Frame and the eye, and there is no toolbar', async () => {
    const onToggleElementVisibility = vi.fn()
    const { adapter, r } = await mount('classic', { onToggleElementVisibility, hiddenElementIds: [] }, withBadge())
    await click('el-ov')
    expect(r.queryByRole('toolbar', { name: 'Element' })).toBeNull()
    const show = await waitFor(() => r.getByRole('checkbox', { name: 'show' }))
    expect(r.getByRole('spinbutton', { name: 'Frame' })).toBeTruthy()
    await press(show)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await press(r.getByRole('button', { name: 'Hide from editor' }))
    expect(onToggleElementVisibility).toHaveBeenCalledWith('el-ov')
  })
})

describe('Element toolbar with stacked slides (§587 M2 + M3)', () => {
  function twoSlides(): Project {
    const p = makeProject()
    p.slides!.push({ id: 'slide-1', base_color: '#ffffff', elements: [{ id: 'el-z', type: 'image', src: 'z.png', x: 50, y: 50, w: 100, h: 100, rotation: 0 }] } as never)
    return p
  }
  async function pressClick(id: string) {
    const el = document.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!
    await act(async () => {
      pointer(el, 'pointerdown', { clientX: 10, clientY: 10 })
      pointer(window, 'pointerup', { clientX: 10, clientY: 10 })
      fireEvent.click(el)
    })
  }

  it('acts on the active slide selection, and sits outside the scrolling stack', async () => {
    const { adapter, r } = await mount('rail', {}, twoSlides())
    await pressClick('el-z')
    expect(within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: /^Slides / }).textContent).toContain('2 / 2')
    const stack = document.querySelector('[data-slide-stack]')!
    expect(stack.contains(toolbar(r))).toBe(false)
    await press(tb(r, 'Lock'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(last(adapter).slides![1].elements[0]).toMatchObject({ id: 'el-z', locked: true })
    expect(last(adapter).slides![0].elements.some((e) => e.locked)).toBe(false)
  })

  it('a Crop from the toolbar on another slide crops there, and a toolbar action applies it', async () => {
    const { adapter, r } = await mount('rail', {}, twoSlides())
    await pressClick('el-z')
    await press(tb(r, 'Crop'))
    expect(document.querySelector('img[alt="Crop source"]')).not.toBeNull()
    await press(tb(r, 'Duplicate'))
    await waitFor(() => expect(document.querySelector('img[alt="Crop source"]')).toBeNull())
    await waitFor(() => expect(last(adapter).slides![1].elements).toHaveLength(2))
  })

  it('the grid view hides the toolbar', async () => {
    const { r } = await mount()
    await click('el-img')
    expect(toolbar(r)).toBeTruthy()
    await press(within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: 'Grid view' }))
    expect(r.queryByRole('toolbar', { name: 'Element' })).toBeNull()
  })
})
