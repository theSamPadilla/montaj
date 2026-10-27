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
const fontsOf = (p: Project, id: string) => (byId(p, id) as unknown as { googleFonts?: string[] }).googleFonts
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



const BRAND = { colors: ['#ff0000', '#00ff00'], fonts: { heading: '"Poppins", system-ui, sans-serif', googleFonts: ['Poppins:wght@400;700'] } }
const panel = (r: ReturnType<typeof render>) => r.getByRole('region', { name: 'Colour panel' })
const openRail = async (r: ReturnType<typeof render>, name: string) => {
  await act(async () => { fireEvent.click(within(r.getByRole('navigation', { name: 'Editor rail' })).getByRole('button', { name })) })
}
const colourOf = (p: Project, id: string) => propsOf(p, id).color
const BRAND_LABEL = 'Use brand default'

describe('Use brand default (§587 r2 note 8)', () => {
  it('font picker: with a brand the first row is Use brand default and one click applies the profile font', async () => {
    const { adapter, r } = await mount('rail', { brand: BRAND })
    await click('el-t')
    await press(tb(r, 'Font family'))
    const options = within(r.getByRole('listbox')).getAllByRole('option')
    expect(options[0].textContent).toBe(BRAND_LABEL)
    await press(options[0])
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').fontFamily).toBe('"Poppins", system-ui, sans-serif')
    expect(fontsOf(last(adapter), 'el-t')).toEqual(['Poppins:wght@400;700'])
  })

  it('font picker: the family and its googleFonts are one write and one undo step', async () => {
    const { adapter, r } = await mount('rail', { brand: BRAND })
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(r.getByRole('listbox')).getAllByRole('option')[0])
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-t').fontFamily).toBe('"Inter", system-ui, sans-serif')
    expect(fontsOf(last(adapter), 'el-t')).toBeUndefined()
  })

  it('font picker: a list pick writes its spec, and System clears it', async () => {
    const { adapter, r } = await mount('rail')
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(r.getByRole('listbox')).getByRole('option', { name: 'Bebas Neue' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(fontsOf(last(adapter), 'el-t')).toEqual(['Bebas+Neue:wght@400;700'])
    await press(tb(r, 'Font family'))
    await press(within(r.getByRole('listbox')).getByRole('option', { name: 'System' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(fontsOf(last(adapter), 'el-t')).toBeUndefined()
    expect(propsOf(last(adapter), 'el-t').fontFamily).toContain('system-ui')
  })

  it('font picker: a locked element is not changed', async () => {
    const { adapter, r } = await mount('rail', { brand: BRAND })
    await click('el-locked')
    expect(tb(r, 'Font family').disabled).toBe(true)
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('font picker: no brand font, no row', async () => {
    const { r } = await mount('rail', { brand: { colors: ['#ff0000'] } })
    await click('el-t')
    await press(tb(r, 'Font family'))
    expect(within(r.getByRole('listbox')).queryByText(BRAND_LABEL)).toBeNull()
  })

  it('colour panel: with brand colours the brand section leads with Use brand default and one click applies the brand colour', async () => {
    const { adapter, r } = await mount('rail', { brand: BRAND })
    await click('el-t')
    await press(tb(r, 'Text color'))
    // §587 R9: the brand palette is its own section, "Use brand default" its first row.
    const brand = within(panel(r)).getByRole('region', { name: 'Brand' })
    const row = within(brand).getAllByRole('button')[0]
    expect(within(brand).getByRole('button', { name: BRAND_LABEL })).toBe(row)
    await press(row)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(colourOf(last(adapter), 'el-t')).toBe('#ff0000')
  })

  it('colour panel: no brand colours, no row', async () => {
    const { r } = await mount()
    await click('el-t')
    await press(tb(r, 'Text color'))
    expect(within(panel(r)).queryByRole('button', { name: BRAND_LABEL })).toBeNull()
  })
})

describe('Background panel (§587 r2 note 9)', () => {
  it('brand colours lead, then the custom picker; a brand swatch writes the slide colour once', async () => {
    const { adapter, r } = await mount('rail', { brand: BRAND })
    await openRail(r, 'Background')
    const swatch = r.getByRole('button', { name: 'Brand color #00ff00' })
    const custom = r.getByRole('button', { name: 'Background color' })
    expect(swatch.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await press(swatch)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(last(adapter).slides![0].base_color).toBe('#00ff00')
  })

  it('without a brand there are no brand swatches', async () => {
    const { r } = await mount()
    await openRail(r, 'Background')
    expect(r.queryByRole('button', { name: /^Brand color/ })).toBeNull()
    expect(r.getByRole('button', { name: 'Background color' })).toBeTruthy()
  })

  it('the carouselBackgroundImages slot renders under the colours, and nothing without it', async () => {
    const { r } = await mount('rail', { brand: BRAND, slots: { carouselBackgroundImages: <div data-testid="bg-images">row</div> } })
    await openRail(r, 'Background')
    const slot = r.getByTestId('bg-images')
    const custom = r.getByRole('button', { name: 'Background color' })
    expect(custom.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    r.unmount()
    const m = await mount('rail', { brand: BRAND })
    await openRail(m.r, 'Background')
    expect(m.r.queryByTestId('bg-images')).toBeNull()
  })
})

describe('CarouselApi.setBackgroundImage (§587 r2 note 9)', () => {
  it('adds the image at src as a locked cover at the back, in one save and one undo step', async () => {
    let api: import('../../types').CarouselApi | null = null
    const { adapter } = await mount('rail', { onProvideCarouselApi: (a) => { api = a } })
    expect(api).not.toBeNull()
    const before = adapter.saveCalls.length
    await act(async () => { await api!.setBackgroundImage('/lib/bg.png') })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    const els = elementsOf(last(adapter))
    expect(els[0]).toMatchObject({ type: 'image', src: '/lib/bg.png', x: 0, y: 0, w: 1080, h: 1080, locked: true })
    expect(els).toHaveLength(5)
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 2))
    expect(elementsOf(last(adapter))).toHaveLength(4)
  })
})
