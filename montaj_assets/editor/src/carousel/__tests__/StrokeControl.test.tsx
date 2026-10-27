import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// §587 round 2, F-F: the element toolbar's stroke control for lines and
// stroked shapes (style, rounded ends or corners, weight) and a line's
// start and end arrow toggles.

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

const shape = (id: string, template: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, type: 'overlay', x: 600, y: 600, w: 200, h: 200, rotation: 0, ...extra,
  overlay: { template: `/rt/templates/overlays/${template}/${template}.jsx`, props },
})

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [{
      id: 'slide-0', base_color: '#ffffff',
      elements: [
        { id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 },
        {
          id: 'el-t', type: 'overlay', frame: 0, x: 300, y: 700, w: 400, h: 100, rotation: 0,
          overlay: { template: '/overlays/text.jsx', props: { text: 'Hello', fontSize: '32px', color: '#111111' } },
        },
        shape('el-line', 'line-straight', { stroke: '#111111', strokeWidth: 8, arrowhead: 'none' }, { x: 20, y: 900, w: 400, h: 40 }),
        shape('el-dashed', 'line-dashed', { stroke: '#111111', strokeWidth: 8, dash: 24, gap: 16, arrowhead: 'none' }, { x: 20, y: 960, w: 400, h: 40 }),
        shape('el-rect', 'shape-rect', { fill: '#bdbdbd', stroke: '#111111', strokeWidth: 4 }),
        shape('el-ellipse', 'shape-ellipse', { fill: '#bdbdbd', stroke: '#111111', strokeWidth: 4 }, { x: 800, y: 800 }),
        shape('el-frame', 'frame-border', { stroke: '#00aa00', strokeWidth: 12 }, { x: 900, y: 20, w: 100, h: 100 }),
        shape('el-locked', 'line-arrow', { stroke: '#111111', strokeWidth: 8, arrowhead: 'end' }, { x: 20, y: 400, w: 400, h: 40, locked: true }),
      ],
    }],
  } as Project
}

function makeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    // The canvas draws each overlay's stroke width, so a preview can be read.
    compileOverlay: vi.fn(async () => (_f: number, _fps: number, _d: number, props: Record<string, unknown>) =>
      createElement('div', { 'data-stroke-width': String(props.strokeWidth) })),
    listGlobalOverlays: vi.fn(async () => []),
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

async function mount() {
  const adapter = makeAdapter()
  const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} layout="rail" />)
  await waitFor(() => expect(document.querySelector('[data-element-id="el-line"]')).not.toBeNull())
  return { adapter, r }
}

const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }
const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project
const propsOf = (p: Project, id: string) =>
  (p.slides![0].elements.find((e) => e.id === id) as unknown as { overlay: { props: Record<string, unknown> } }).overlay.props
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })

async function click(id: string) { await act(async () => { fireEvent.click(wrapperOf(id)) }) }
async function press(button: HTMLElement) { await act(async () => { fireEvent.click(button) }) }
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })) })
}
const undo = () => key('z', { metaKey: true })
const toolbar = (r: ReturnType<typeof render>) => r.getByRole('toolbar', { name: 'Element' })
const tb = (r: ReturnType<typeof render>, name: string | RegExp) => within(toolbar(r)).getByRole('button', { name }) as HTMLButtonElement
const tbQuery = (r: ReturnType<typeof render>, name: string | RegExp) => within(toolbar(r)).queryByRole('button', { name })
const strokePop = (r: ReturnType<typeof render>) => r.getByRole('dialog', { name: 'Stroke' })
const tile = (r: ReturnType<typeof render>, name: string) => within(strokePop(r)).getByRole('button', { name }) as HTMLButtonElement
const weightField = (r: ReturnType<typeof render>) => within(strokePop(r)).getByRole('spinbutton', { name: 'Stroke weight' }) as HTMLInputElement
const weightSlider = (r: ReturnType<typeof render>) => within(strokePop(r)).getByRole('slider', { name: 'Stroke weight' }) as HTMLInputElement
const drawnWidth = (id: string) => wrapperOf(id).querySelector('[data-stroke-width]')?.getAttribute('data-stroke-width')

async function openStroke(r: ReturnType<typeof render>, id: string) {
  await click(id)
  await press(tb(r, 'Stroke'))
  return strokePop(r)
}

describe('Stroke control (§587 round 2, F-F)', () => {
  it('shows for lines, shapes and frames; not for an image or text', async () => {
    const { r } = await mount()
    for (const id of ['el-line', 'el-dashed', 'el-rect', 'el-ellipse', 'el-frame']) {
      await click(id)
      expect(tbQuery(r, 'Stroke'), id).not.toBeNull()
    }
    for (const id of ['el-img', 'el-t']) {
      await click(id)
      expect(tbQuery(r, 'Stroke'), id).toBeNull()
    }
  })

  it('the arrow toggles show for a line only', async () => {
    const { r } = await mount()
    await click('el-line')
    expect(tbQuery(r, 'Start arrow')).not.toBeNull()
    expect(tbQuery(r, 'End arrow')).not.toBeNull()
    await click('el-rect')
    expect(tbQuery(r, 'Start arrow')).toBeNull()
    expect(tbQuery(r, 'End arrow')).toBeNull()
  })

  it('a style tile sets strokeStyle in one save and one undo step; the active tile is pressed', async () => {
    const { adapter, r } = await mount()
    await openStroke(r, 'el-line')
    expect(tile(r, 'Solid').getAttribute('aria-pressed')).toBe('true')
    expect(tile(r, 'Dotted').getAttribute('aria-pressed')).toBe('false')
    await press(tile(r, 'Dotted'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-line').strokeStyle).toBe('dotted')
    expect(tile(r, 'Dotted').getAttribute('aria-pressed')).toBe('true')
    await press(tile(r, 'Long dash'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-line').strokeStyle).toBe('long-dash')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(propsOf(last(adapter), 'el-line').strokeStyle).toBe('dotted')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(propsOf(last(adapter), 'el-line').strokeStyle).toBeUndefined()
  })

  it('the dashed line reads as long dash before any pick', async () => {
    const { r } = await mount()
    await openStroke(r, 'el-dashed')
    expect(tile(r, 'Long dash').getAttribute('aria-pressed')).toBe('true')
  })

  it('a line gets "Rounded end points" (roundCaps); a rectangle gets "Rounded corners" (roundJoins); an ellipse neither', async () => {
    const { adapter, r } = await mount()
    const pop = await openStroke(r, 'el-line')
    expect(within(pop).queryByRole('switch', { name: 'Rounded corners' })).toBeNull()
    await press(within(pop).getByRole('switch', { name: 'Rounded end points' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-line').roundCaps).toBe('true')
    expect(within(strokePop(r)).getByRole('switch', { name: 'Rounded end points' }).getAttribute('aria-checked')).toBe('true')

    const rect = await openStroke(r, 'el-rect')
    expect(within(rect).queryByRole('switch', { name: 'Rounded end points' })).toBeNull()
    await press(within(rect).getByRole('switch', { name: 'Rounded corners' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-rect').roundJoins).toBe('true')

    const ellipse = await openStroke(r, 'el-ellipse')
    expect(within(ellipse).queryByRole('switch')).toBeNull()
    expect(within(ellipse).getByRole('button', { name: 'Dotted' })).toBeTruthy()
  })

  it('the weight field writes strokeWidth once on Enter', async () => {
    const { adapter, r } = await mount()
    await openStroke(r, 'el-rect')
    const input = weightField(r)
    expect(input.value).toBe('4')
    input.focus()
    await act(async () => { fireEvent.change(input, { target: { value: '1' } }) })
    await act(async () => { fireEvent.change(input, { target: { value: '12' } }) })
    // Live while typing, no save yet.
    expect(drawnWidth('el-rect')).toBe('12')
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-rect').strokeWidth).toBe('12')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-rect').strokeWidth).toBe(4)
  })

  it('Escape in the weight field reverts the typed weight, keeps the selection and saves nothing', async () => {
    const { adapter, r } = await mount()
    await openStroke(r, 'el-rect')
    const input = weightField(r)
    input.focus()
    await act(async () => { fireEvent.change(input, { target: { value: '1' } }) })
    await act(async () => { fireEvent.change(input, { target: { value: '12' } }) })
    expect(drawnWidth('el-rect')).toBe('12')
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }) })
    await settle()
    expect(drawnWidth('el-rect')).toBe('4')
    expect(weightField(r).value).toBe('4')
    expect(adapter.saveCalls).toHaveLength(0)
    // Still selected: the toolbar and the popover stay.
    expect(toolbar(r)).toBeTruthy()
    expect(strokePop(r)).toBeTruthy()
  })

  it('the weight slider previews live and saves once on release', async () => {
    const { adapter, r } = await mount()
    await openStroke(r, 'el-line')
    const slider = weightSlider(r)
    expect(slider.value).toBe('8')
    await act(async () => { fireEvent.change(slider, { target: { value: '10' } }) })
    await act(async () => { fireEvent.change(slider, { target: { value: '14' } }) })
    expect(drawnWidth('el-line')).toBe('14')
    expect(weightField(r).value).toBe('14')
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { fireEvent.pointerUp(slider) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-line').strokeWidth).toBe('14')
    // The blur after the release does not save again.
    await act(async () => { fireEvent.blur(slider) })
    await settle()
    expect(adapter.saveCalls).toHaveLength(1)
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-line').strokeWidth).toBe(8)
  })

  it('the arrow toggles step arrowhead through none, end, both, start and back, one save each', async () => {
    const { adapter, r } = await mount()
    await click('el-line')
    const start = () => tb(r, 'Start arrow')
    const end = () => tb(r, 'End arrow')
    expect(start().getAttribute('aria-pressed')).toBe('false')
    expect(end().getAttribute('aria-pressed')).toBe('false')
    await press(end())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-line').arrowhead).toBe('end')
    expect(end().getAttribute('aria-pressed')).toBe('true')
    await press(start())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-line').arrowhead).toBe('both')
    await press(end())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(propsOf(last(adapter), 'el-line').arrowhead).toBe('start')
    await press(start())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(4))
    expect(propsOf(last(adapter), 'el-line').arrowhead).toBe('none')
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(5))
    expect(propsOf(last(adapter), 'el-line').arrowhead).toBe('start')
  })

  it('a locked line: the arrows are disabled and the popover opens with every control disabled', async () => {
    const { adapter, r } = await mount()
    await click('el-locked')
    expect(tb(r, 'Start arrow').disabled).toBe(true)
    expect(tb(r, 'End arrow').disabled).toBe(true)
    expect(tb(r, 'End arrow').getAttribute('aria-pressed')).toBe('true')
    await press(tb(r, 'Stroke'))
    const pop = strokePop(r)
    for (const name of ['Solid', 'Long dash', 'Short dash', 'Dotted']) expect(tile(r, name).disabled).toBe(true)
    expect((within(pop).getByRole('switch', { name: 'Rounded end points' }) as HTMLButtonElement).disabled).toBe(true)
    expect(weightField(r).disabled).toBe(true)
    expect(weightSlider(r).disabled).toBe(true)
    await press(tile(r, 'Dotted'))
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('the Stroke button toggles its popover', async () => {
    const { r } = await mount()
    await openStroke(r, 'el-frame')
    expect(tb(r, 'Stroke').getAttribute('aria-expanded')).toBe('true')
    await press(tb(r, 'Stroke'))
    expect(r.queryByRole('dialog', { name: 'Stroke' })).toBeNull()
  })
})
