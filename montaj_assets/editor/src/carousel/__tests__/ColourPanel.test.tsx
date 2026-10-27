import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, GlobalOverlay, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// The colour panel (§587 M5): every colour control in the rail layout opens it.

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function textEl(id: string, y: number, extra: Record<string, unknown> = {}) {
  return {
    id, type: 'overlay', frame: 0, x: 300, y, w: 400, h: 100, rotation: 0,
    ...extra,
    overlay: {
      template: '/overlays/text.jsx',
      props: { text: 'Hello', fontFamily: '"Inter", system-ui, sans-serif', fontSize: '32px', color: '#111111', bgColor: '#ffeeaa', fontWeight: '400', fontStyle: 'normal', textAlign: 'left', effect: 'none' },
    },
  }
}

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [
      {
        id: 'slide-0', base_color: '#ffffff',
        elements: [
          { id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 },
          textEl('el-t', 700),
          textEl('el-locked', 400, { locked: true }),
          { id: 'el-ov', type: 'overlay', frame: 3, x: 600, y: 100, w: 200, h: 100, rotation: 0, overlay: { template: '/overlays/badge.jsx', props: { accent: '#ff0000', show: true, label: 'Hi' } } },
        ],
      },
      { id: 'slide-1', base_color: '#ff0000', elements: [textEl('el-u', 300)] },
    ],
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
    props: [{ name: 'text', type: 'string' }, { name: 'fontSize', type: 'string' }, { name: 'effect', type: 'string' }],
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

async function mount(layout: 'rail' | 'classic' = 'rail', extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}, project: Project = makeProject()) {
  const adapter = makeAdapter()
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout={layout} {...extra} />)
  await waitFor(() => expect(document.querySelector('[data-element-id="el-t"]')).not.toBeNull())
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
async function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })) })
}
const undo = () => key('z', { metaKey: true })

const toolbar = (r: ReturnType<typeof render>) => r.getByRole('toolbar', { name: 'Element' })
const tb = (r: ReturnType<typeof render>, name: string | RegExp) => within(toolbar(r)).getByRole('button', { name }) as HTMLButtonElement
async function press(button: HTMLElement) {
  await act(async () => { fireEvent.click(button) })
}
const popover = (r: ReturnType<typeof render>, name: string) => r.getByRole('dialog', { name })
async function type(input: HTMLInputElement, text: string) {
  input.focus()
  for (let i = 1; i <= text.length; i++) {
    await act(async () => { fireEvent.change(input, { target: { value: text.slice(0, i) } }) })
  }
}


const panel = (r: ReturnType<typeof render>) => r.getByRole('region', { name: 'Colour panel' })
const hexField = (r: ReturnType<typeof render>) => within(panel(r)).getByRole('textbox', { name: 'Hex' }) as HTMLInputElement
const slider = (r: ReturnType<typeof render>) => within(panel(r)).getByRole('slider', { name: 'Transparency' }) as HTMLInputElement
const colourOf = (p: Project, id: string, slide = 0) => {
  const el = p.slides![slide].elements.find((e) => e.id === id) as unknown as { overlay: { props: Record<string, unknown> } }
  return el.overlay.props.color
}
const BRAND = { colors: ['#ff0000', '#00ff00'] }

async function openTextColour(r: ReturnType<typeof render>) {
  await click('el-t')
  await press(tb(r, 'Text color'))
}

describe('Colour panel (§587 M5, layout="rail")', () => {
  it('the toolbar text colour opens the panel, not the OS picker', async () => {
    const { r } = await mount()
    await click('el-t')
    expect(toolbar(r).querySelector('input[type="color"]')).toBeNull()
    expect(r.queryByRole('region', { name: 'Colour panel' })).toBeNull()
    await press(tb(r, 'Text color'))
    expect(within(panel(r)).getByText('Text color')).toBeTruthy()
    expect(hexField(r).value).toBe('#111111')
    await press(within(panel(r)).getByRole('button', { name: 'Close' }))
    expect(r.queryByRole('region', { name: 'Colour panel' })).toBeNull()
  })

  it('a brand swatch click writes once: one save, one undo step', async () => {
    const { adapter, r } = await mount('rail', { brand: BRAND })
    await openTextColour(r)
    await press(within(panel(r)).getByRole('button', { name: 'Brand color #00ff00' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(colourOf(last(adapter), 'el-t')).toBe('#00ff00')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(colourOf(last(adapter), 'el-t')).toBe('#111111')
  })

  it('hides Brand with no brand colours', async () => {
    const { r } = await mount()
    await openTextColour(r)
    expect(within(panel(r)).queryByText('Brand')).toBeNull()
  })

  it('a typed hex writes once, on Enter', async () => {
    const { adapter, r } = await mount()
    await openTextColour(r)
    await type(hexField(r), '#abcdef')
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { fireEvent.keyDown(hexField(r), { key: 'Enter' }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(colourOf(last(adapter), 'el-t')).toBe('#abcdef')
    await settle()
    expect(adapter.saveCalls).toHaveLength(1)
  })

  it('transparency writes 8-digit hex once, on release, for a text colour', async () => {
    const { adapter, r } = await mount()
    await openTextColour(r)
    await act(async () => { fireEvent.change(slider(r), { target: { value: '50' } }) })
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { fireEvent.pointerUp(slider(r)) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(colourOf(last(adapter), 'el-t')).toBe('#11111180')
  })

  it('the text background takes transparency too', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    await press(tb(r, 'Effects'))
    await press(within(popover(r, 'Effects')).getByRole('button', { name: 'Text background' }))
    expect(within(panel(r)).getByText('Text background')).toBeTruthy()
    await act(async () => { fireEvent.change(slider(r), { target: { value: '25' } }) })
    await act(async () => { fireEvent.pointerUp(slider(r)) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').bgColor).toBe('#ffeeaabf')
  })

  it('hides transparency where the target takes no alpha (an overlay prop)', async () => {
    const { adapter, r } = await mount()
    await click('el-ov')
    await press(tb(r, 'Edit'))
    await press(within(popover(r, 'Edit')).getByRole('button', { name: 'accent' }))
    expect(within(panel(r)).getByText('accent')).toBeTruthy()
    expect(within(panel(r)).queryByRole('slider', { name: 'Transparency' })).toBeNull()
    await press(within(panel(r)).getByRole('button', { name: 'In this carousel color #ffffff' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-ov').accent).toBe('#ffffff')
  })

  it('"In this carousel" lists the colours used on every slide, most used first', async () => {
    const { r } = await mount()
    await openTextColour(r)
    const used = within(panel(r)).getAllByRole('button', { name: /^In this carousel color / }).map((b) => b.getAttribute('aria-label')!.split(' ').pop())
    expect(used).toEqual(['#111111', '#ffeeaa', '#ff0000', '#ffffff'])
  })

  it('"Change on every slide" replaces the colour everywhere in one undo step and skips locked elements', async () => {
    const { adapter, r } = await mount('rail', { brand: BRAND })
    await openTextColour(r)
    await press(within(panel(r)).getByRole('button', { name: 'Change on every slide' }))
    await press(within(panel(r)).getByRole('button', { name: 'Brand color #00ff00' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const saved = last(adapter)
    expect(colourOf(saved, 'el-t')).toBe('#00ff00')
    expect(colourOf(saved, 'el-u', 1)).toBe('#00ff00')
    expect(colourOf(saved, 'el-locked')).toBe('#111111')
    expect(saved.slides![1].base_color).toBe('#ff0000')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(colourOf(last(adapter), 'el-t')).toBe('#111111')
    expect(colourOf(last(adapter), 'el-u', 1)).toBe('#111111')
  })

  it('"Change on every slide": two slider changes then release save the LAST value on every slide, one undo step', async () => {
    const { adapter, r } = await mount()
    await openTextColour(r)
    await press(within(panel(r)).getByRole('button', { name: 'Change on every slide' }))
    await act(async () => { fireEvent.change(slider(r), { target: { value: '50' } }) })
    await act(async () => { fireEvent.change(slider(r), { target: { value: '25' } }) })
    await act(async () => { fireEvent.pointerUp(slider(r)) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(colourOf(last(adapter), 'el-t')).toBe('#111111bf')
    expect(colourOf(last(adapter), 'el-u', 1)).toBe('#111111bf')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(colourOf(last(adapter), 'el-t')).toBe('#111111')
    expect(colourOf(last(adapter), 'el-u', 1)).toBe('#111111')
  })

  it('"Change on every slide" with transparency keeps non-text props opaque', async () => {
    const project = makeProject()
    ;(byId(project, 'el-ov') as unknown as { overlay: { props: Record<string, unknown> } }).overlay.props.accent = '#111111'
    const { adapter, r } = await mount('rail', {}, project)
    await openTextColour(r)
    await press(within(panel(r)).getByRole('button', { name: 'Change on every slide' }))
    await act(async () => { fireEvent.change(slider(r), { target: { value: '50' } }) })
    await act(async () => { fireEvent.pointerUp(slider(r)) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(colourOf(last(adapter), 'el-t')).toBe('#11111180')
    expect(propsOf(last(adapter), 'el-ov').accent).toBe('#111111')
  })

  it('a colour picked from Edit does not overwrite a prop changed since the panel opened', async () => {
    const { adapter, r } = await mount()
    await click('el-ov')
    await press(tb(r, 'Edit'))
    await press(within(popover(r, 'Edit')).getByRole('button', { name: 'accent' }))
    if (!r.queryByRole('dialog', { name: 'Edit' })) await press(tb(r, 'Edit'))
    const label = within(popover(r, 'Edit')).getByDisplayValue('Hi') as HTMLInputElement
    await act(async () => { fireEvent.change(label, { target: { value: 'Yo' } }) })
    await act(async () => { fireEvent.blur(label) })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    await press(within(panel(r)).getByRole('button', { name: 'In this carousel color #ffffff' }))
    await waitFor(() => expect(propsOf(last(adapter), 'el-ov').accent).toBe('#ffffff'))
    expect(propsOf(last(adapter), 'el-ov').label).toBe('Yo')
  })

  it('Esc typed in a field outside the colour panel reaches that field', async () => {
    const { r } = await mount()
    await openTextColour(r)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const seen = vi.fn()
    outside.addEventListener('keydown', seen)
    await key('Escape', {}, outside)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(r.queryByRole('region', { name: 'Colour panel' })).not.toBeNull()
    outside.remove()
  })

  it('Esc reverts an uncommitted preview and closes the panel', async () => {
    const { adapter, r } = await mount()
    await openTextColour(r)
    await act(async () => { fireEvent.change(slider(r), { target: { value: '40' } }) })
    await key('Escape')
    expect(r.queryByRole('region', { name: 'Colour panel' })).toBeNull()
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
    await press(tb(r, 'Text color'))
    expect(hexField(r).value).toBe('#111111')
  })

  it('shows the colour of a locked target but disables changes', async () => {
    const { r } = await mount()
    await openTextColour(r)
    await press(tb(r, 'Lock'))
    expect(hexField(r).disabled).toBe(true)
    expect(hexField(r).value).toBe('#111111')
    expect(slider(r).disabled).toBe(true)
  })

  it('the classic layout keeps the OS picker and has no colour panel', async () => {
    const { r } = await mount('classic', { brand: BRAND })
    await click('el-t')
    expect(document.querySelector('input[type="color"][aria-label="Text color"]')).not.toBeNull()
    expect(r.queryByRole('region', { name: 'Colour panel' })).toBeNull()
  })
})
