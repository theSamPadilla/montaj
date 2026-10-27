import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'
import { photoColoursOf } from '../photoColours'
import { DEFAULT_SOLIDS } from '../colours'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})
// The photo sampler at its boundary: jsdom has no canvas to read pixels from.
vi.mock('../photoColours', () => ({ photoColoursOf: vi.fn(async () => ['#123456', '#abcdef']) }))

// §587 round 2, R9: the element toolbar's colour swatch, the text colour's
// "A" with a live colour bar, and the colour panel's sections.

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function textEl(id: string, y: number, extra: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return {
    id, type: 'overlay', frame: 0, x: 300, y, w: 400, h: 100, rotation: 0,
    ...extra,
    overlay: {
      template: '/overlays/text.jsx',
      props: { text: 'Hello', fontFamily: '"Inter", system-ui, sans-serif', fontSize: '32px', color: '#111111', fontWeight: '400', fontStyle: 'normal', textAlign: 'left', effect: 'none', ...props },
    },
  }
}
const shape = (id: string, template: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, type: 'overlay', x: 600, y: 600, w: 200, h: 200, rotation: 0, ...extra,
  overlay: { template: `/rt/templates/overlays/${template}/${template}.jsx`, props },
})

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
          textEl('el-fx', 820, {}, { effect: 'outline', effectColor: '#445566' }),
          textEl('el-locked', 400, { locked: true }, { color: '#222222' }),
          shape('el-rect', 'shape-rect', { fill: '#bdbdbd', stroke: '#111111', strokeWidth: '0' }),
          shape('el-hollow', 'shape-ellipse', { fill: 'none', stroke: '#336699', strokeWidth: '6' }, { x: 800, y: 800 }),
          shape('el-line', 'line-arrow', { stroke: '#aa0000', strokeWidth: '8', arrowhead: 'end' }, { x: 20, y: 900, h: 40 }),
          shape('el-frame', 'frame-border', { stroke: '#00aa00' }, { x: 900, y: 20, w: 100, h: 100 }),
        ],
      },
      { id: 'slide-1', base_color: '#ff0000', elements: [textEl('el-u', 300)] },
    ],
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
    compileOverlay: vi.fn(async () => () => null),
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
  vi.mocked(photoColoursOf).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

async function mount(extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}) {
  const adapter = makeAdapter()
  const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} layout="rail" {...extra} />)
  await waitFor(() => expect(document.querySelector('[data-element-id="el-t"]')).not.toBeNull())
  return { adapter, r }
}

const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }
const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project
const propsOf = (p: Project, id: string, slide = 0) =>
  (p.slides![slide].elements.find((e) => e.id === id) as unknown as { overlay: { props: Record<string, unknown> } }).overlay.props

async function click(id: string) { await act(async () => { fireEvent.click(wrapperOf(id)) }) }
async function press(button: HTMLElement) { await act(async () => { fireEvent.click(button) }) }
const toolbar = (r: ReturnType<typeof render>) => r.getByRole('toolbar', { name: 'Element' })
const tb = (r: ReturnType<typeof render>, name: string | RegExp) => within(toolbar(r)).getByRole('button', { name }) as HTMLButtonElement
const swatch = (r: ReturnType<typeof render>) => tb(r, 'Color')
/** The swatch's ball, which carries the colour. */
const ball = (r: ReturnType<typeof render>) => swatch(r).querySelector<HTMLElement>('[data-colour-swatch]')!
const panel = (r: ReturnType<typeof render>) => r.getByRole('region', { name: 'Colour panel' })
const panelTitle = (r: ReturnType<typeof render>) => within(panel(r)).getByRole('heading').textContent
const hexField = (r: ReturnType<typeof render>) => within(panel(r)).getByRole('textbox', { name: 'Hex' }) as HTMLInputElement
const search = (r: ReturnType<typeof render>) => within(panel(r)).getByRole('searchbox', { name: 'Search colors' }) as HTMLInputElement
/** jsdom reports a style colour as rgb(); compare in hex. */
const hexOf = (el: HTMLElement) => {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(el.style.backgroundColor)
  return m ? `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : el.style.backgroundColor
}

describe('Element toolbar colour swatch (§587 R9)', () => {
  it('a text element: the swatch is the text colour and opens the panel on it', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    expect(hexOf(ball(r))).toBe('#111111')
    await press(swatch(r))
    expect(panelTitle(r)).toBe('Text color')
    expect(hexField(r).value).toBe('#111111')
    await press(within(panel(r)).getByRole('button', { name: 'Default color #ef4444' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').color).toBe('#ef4444')
    expect(hexOf(ball(r))).toBe('#ef4444')
  })

  it('a shape: the fill', async () => {
    const { adapter, r } = await mount()
    await click('el-rect')
    expect(hexOf(ball(r))).toBe('#bdbdbd')
    await press(swatch(r))
    expect(panelTitle(r)).toBe('Fill color')
    await press(within(panel(r)).getByRole('button', { name: 'Default color #ef4444' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-rect')).toMatchObject({ fill: '#ef4444', stroke: '#111111' })
  })

  it('a shape with no fill: the stroke', async () => {
    const { adapter, r } = await mount()
    await click('el-hollow')
    expect(hexOf(ball(r))).toBe('#336699')
    await press(swatch(r))
    expect(panelTitle(r)).toBe('Stroke color')
    await press(within(panel(r)).getByRole('button', { name: 'Default color #ef4444' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-hollow')).toMatchObject({ fill: 'none', stroke: '#ef4444' })
  })

  it('a line and a frame: the stroke', async () => {
    const { r } = await mount()
    await click('el-line')
    expect(hexOf(ball(r))).toBe('#aa0000')
    await press(swatch(r))
    expect(panelTitle(r)).toBe('Stroke color')
    await click('el-frame')
    expect(hexOf(ball(r))).toBe('#00aa00')
  })

  it('an image has no swatch', async () => {
    const { r } = await mount()
    await click('el-img')
    expect(within(toolbar(r)).queryByRole('button', { name: 'Color' })).toBeNull()
  })

  it('with the panel open on another colour of the element, the swatch shows and edits that one', async () => {
    const { adapter, r } = await mount()
    await click('el-fx')
    expect(hexOf(ball(r))).toBe('#111111')
    await press(tb(r, 'Effects'))
    await press(within(r.getByRole('dialog', { name: 'Effects' })).getByRole('button', { name: 'Effect color' }))
    expect(panelTitle(r)).toBe('Effect color')
    expect(hexOf(ball(r))).toBe('#445566')
    await press(within(panel(r)).getByRole('button', { name: 'Default color #ef4444' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-fx')).toMatchObject({ effectColor: '#ef4444', color: '#111111' })
    expect(hexOf(ball(r))).toBe('#ef4444')
    // The swatch is that colour's: a click on it does not switch the panel to the text colour.
    expect(swatch(r).getAttribute('aria-expanded')).toBe('true')
  })

  it('locked: the swatch shows the colour, the panel opens disabled', async () => {
    const { r } = await mount()
    await click('el-locked')
    expect(hexOf(ball(r))).toBe('#222222')
    await press(swatch(r))
    expect(hexField(r).value).toBe('#222222')
    expect(hexField(r).disabled).toBe(true)
    expect(search(r).disabled).toBe(true)
    expect((within(panel(r)).getByRole('button', { name: 'Default color #ef4444' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Text colour "A" with a live colour bar (§587 R9)', () => {
  it('the bar is filled with the text colour and follows a pick', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    const bar = () => tb(r, 'Text color').querySelector<HTMLElement>('[data-colour-bar]')!
    expect(bar()).not.toBeNull()
    expect(hexOf(bar())).toBe('#111111')
    await press(tb(r, 'Text color'))
    expect(panelTitle(r)).toBe('Text color')
    await press(within(panel(r)).getByRole('button', { name: 'Default color #3b82f6' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(hexOf(bar())).toBe('#3b82f6')
  })
})

describe('Text colour "A" toggles the panel like the swatch', () => {
  it('a second press closes the panel; a third opens it again', async () => {
    const { r } = await mount()
    await click('el-t')
    await press(tb(r, 'Text color'))
    expect(panelTitle(r)).toBe('Text color')
    await press(tb(r, 'Text color'))
    expect(r.queryByRole('region', { name: 'Colour panel' })).toBeNull()
    await press(tb(r, 'Text color'))
    expect(panelTitle(r)).toBe('Text color')
  })
})

describe('Colour panel sections (§587 R9)', () => {
  it('the search field takes a colour name and a hex, each written once on Enter', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    await press(swatch(r))
    expect(search(r).placeholder).toMatch(/blue/)
    await act(async () => { fireEvent.change(search(r), { target: { value: 'Blue' } }) })
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { fireEvent.keyDown(search(r), { key: 'Enter' }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').color).toBe('#0000ff')
    await act(async () => { fireEvent.change(search(r), { target: { value: '#00b4d8' } }) })
    await act(async () => { fireEvent.keyDown(search(r), { key: 'Enter' }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-t').color).toBe('#00b4d8')
    // Not a colour: nothing is written.
    await act(async () => { fireEvent.change(search(r), { target: { value: 'nope' } }) })
    await act(async () => { fireEvent.keyDown(search(r), { key: 'Enter' }) })
    await act(async () => { await new Promise((res) => setTimeout(res, 30)) })
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('the sections come in order: search, this element, in this carousel, brand (default first), photos, default colours', async () => {
    const { r } = await mount({ brand: { colors: ['#ff0000', '#00ff00'] } })
    await click('el-t')
    await press(swatch(r))
    await waitFor(() => expect(within(panel(r)).getAllByRole('button', { name: /^Photo color / }).length).toBeGreaterThan(0))
    const order = [
      search(r),
      within(panel(r)).getByRole('region', { name: 'This element' }),
      within(panel(r)).getByRole('region', { name: 'In this carousel' }),
      within(panel(r)).getByRole('button', { name: 'Use brand default' }),
      within(panel(r)).getByRole('button', { name: 'Brand color #00ff00' }),
      within(panel(r)).getByRole('region', { name: 'Photo colors' }),
      within(panel(r)).getByRole('region', { name: 'Default colors' }),
    ]
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `section ${i}`).toBeTruthy()
    }
  })

  it('photo colours come from the slide\'s images', async () => {
    const { adapter, r } = await mount()
    await click('el-t')
    await press(swatch(r))
    const photos = await within(panel(r)).findByRole('region', { name: 'Photo colors' })
    expect(within(photos).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Photo color #123456', 'Photo color #abcdef'])
    expect(photoColoursOf).toHaveBeenCalledWith('a.png')
    await press(within(photos).getByRole('button', { name: 'Photo color #abcdef' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').color).toBe('#abcdef')
  })

  it('no photo colours on a slide without images', async () => {
    const { r } = await mount()
    await click('el-u')
    await press(swatch(r))
    await act(async () => { await new Promise((res) => setTimeout(res, 30)) })
    expect(within(panel(r)).queryByRole('region', { name: 'Photo colors' })).toBeNull()
    expect(photoColoursOf).not.toHaveBeenCalled()
  })

  it('a photo that cannot be read is skipped silently', async () => {
    vi.mocked(photoColoursOf).mockRejectedValueOnce(new Error('tainted'))
    const { r } = await mount()
    await click('el-t')
    await press(swatch(r))
    await act(async () => { await new Promise((res) => setTimeout(res, 30)) })
    expect(within(panel(r)).queryByRole('region', { name: 'Photo colors' })).toBeNull()
  })

  it('the default solid colours are a fixed grid', async () => {
    const { r } = await mount()
    await click('el-t')
    await press(swatch(r))
    const grid = within(panel(r)).getByRole('region', { name: 'Default colors' })
    const labels = within(grid).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(DEFAULT_SOLIDS.map((c) => `Default color ${c}`))
    expect(DEFAULT_SOLIDS.length).toBeGreaterThanOrEqual(21)
    expect(DEFAULT_SOLIDS).toContain('#000000')
    expect(DEFAULT_SOLIDS).toContain('#ffffff')
  })

  it('"This element" lists the element\'s colours, the current one pressed', async () => {
    const { r } = await mount()
    await click('el-fx')
    await press(swatch(r))
    const row = within(panel(r)).getByRole('region', { name: 'This element' })
    const buttons = within(row).getAllByRole('button', { name: /^This element color / })
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['This element color #111111', 'This element color #445566'])
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false')
  })
})
