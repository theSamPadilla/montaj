import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import dashedSidecar from '../../../../render/templates/overlays/line-dashed/line-dashed.json'
import { render, act, waitFor, fireEvent, screen, within } from '@testing-library/react'
import type { AskAiRequest, EditorAdapter, GlobalOverlay, ImageElement, OverlayElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'
import { TEMPLATE_DND_MIME } from '../overlayElement'

// §587 R2: the shipped shapes, lines and frames in the Elements panel (click or
// drag onto a slide), their props in the Edit popover, and "Ask your AI".

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

function slide(i: number, elements: Slide['elements'] = []): Slide {
  return { id: `s${i}`, base_color: '#ffffff', elements }
}
const img = (id: string): ImageElement => ({ id, type: 'image', src: `${id}.png`, x: 100, y: 100, w: 200, h: 200, rotation: 0 })

function makeProject(slides: Slide[]): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [], slides,
  } as Project
}
const three = () => makeProject([slide(0, [img('el-0')]), slide(1, [img('el-1')]), slide(2, [img('el-2')])])

const sys = (name: string, description: string, category: string | undefined, props: GlobalOverlay['props']): GlobalOverlay =>
  ({ name, description, jsxPath: `/rt/render/templates/overlays/${name}/${name}.jsx`, props, ...(category ? { category } : {}) }) as GlobalOverlay
const FILL: GlobalOverlay['props'] = [
  { name: 'fill', type: 'string', default: '#bdbdbd', format: 'color' },
  { name: 'stroke', type: 'string', default: '#111111', format: 'color' },
  { name: 'strokeWidth', type: 'string', default: '0' },
]
const RECT = sys('shape-rect', 'Rectangle', 'shape', FILL)
const ELLIPSE = sys('shape-ellipse', 'Ellipse', 'shape', FILL)
const LINE = sys('line-arrow', 'Arrow line', 'line', [
  { name: 'stroke', type: 'string', default: '#111111', format: 'color' },
  { name: 'strokeWidth', type: 'string', default: '8' },
  { name: 'arrowhead', type: 'string', default: 'end', enum: ['none', 'end', 'start', 'both'] },
])
const FRAME = sys('frame-border', 'Border frame', 'frame', [{ name: 'stroke', type: 'string', default: '#111111', format: 'color' }])
const TEXT = sys('static-text', 'Static text overlay', undefined, [{ name: 'text', type: 'string', default: 'Hi' }])
const SYSTEM = [TEXT, RECT, ELLIPSE, LINE, FRAME]

function makeAdapter(initial: Project, extra: Partial<EditorAdapter<Project>> = {}) {
  const saveCalls: Array<{ id: string; project: Project }> = []
  const adapter: EditorAdapter<Project> & { saveCalls: typeof saveCalls } = {
    loadProject: vi.fn(async () => initial),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => SYSTEM),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
    ...extra,
  }
  return adapter
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => { vi.restoreAllMocks() })

async function mount(project: Project = three(), extra: Partial<EditorAdapter<Project>> = {}, props: Partial<React.ComponentProps<typeof CarouselEditor>> = {}) {
  const adapter = makeAdapter(project, extra)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" {...props} />)
  await waitFor(() => expect(document.querySelectorAll('[data-slide-section]').length).toBe(project.slides!.length))
  await act(async () => {})
  return { adapter, r }
}
const lastSave = (a: ReturnType<typeof makeAdapter>) => a.saveCalls[a.saveCalls.length - 1].project
const overlaysOn = (p: Project, i: number) => p.slides![i].elements.filter((e) => e.type === 'overlay') as OverlayElement[]
const openRail = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`) })) }) }
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
const undo = () => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })) })
async function pickSlideOf(elId: string) {
  const w = document.querySelector<HTMLElement>(`[data-element-id="${elId}"]`)!
  await act(async () => {
    w.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }))
    fireEvent.click(w)
  })
}
const panel = () => screen.getByRole('region', { name: 'Elements panel' })
const tile = (name: string) => within(panel()).findByRole('button', { name })

// ── drag helpers ──────────────────────────────────────────────────────────────

interface FakeTransfer { types: string[]; files: File[]; dropEffect: string; effectAllowed: string; data: Record<string, string>; getData: (t: string) => string; setData: (t: string, v: string) => void }
function transfer(types?: string[]): FakeTransfer {
  const t: FakeTransfer = {
    types: types ?? [], files: [], dropEffect: 'none', effectAllowed: 'all', data: {},
    getData: (k) => t.data[k] ?? '',
    setData: (k, v) => { t.data[k] = v; if (!t.types.includes(k)) t.types.push(k) },
  }
  return t
}
function dragEvent(type: string, point: { clientX: number; clientY: number }, dataTransfer: unknown) {
  const e = new MouseEvent(type, { ...point, bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer })
  return e
}
async function fire(target: Element, e: Event) {
  await act(async () => { target.dispatchEvent(e) })
  return e
}
/** Slide `i`'s live canvas, its rect pinned at (40, 20); `at(x, y)` is the client point over slide point (x, y). */
function pinSlide(i: number) {
  const box = document.querySelector(`[data-slide-section="s${i}"] [data-interactive]`) as HTMLElement
  expect(box).toBeTruthy()
  const w = parseFloat(box.style.width)
  const h = parseFloat(box.style.height)
  box.getBoundingClientRect = () => ({ left: 40, top: 20, x: 40, y: 20, width: w, height: h, right: 40 + w, bottom: 20 + h, toJSON: () => ({}) }) as DOMRect
  const scale = w / 1080
  expect(scale).toBeGreaterThan(0)
  return { box, at: (x: number, y: number) => ({ clientX: 40 + x * scale, clientY: 20 + y * scale }) }
}

describe('Elements panel: shapes, lines and frames', () => {
  it('lists the shipped templates by category, for every user, above no "No graphics" note', async () => {
    const { adapter } = await mount()
    await openRail('Elements')
    await tile('Rectangle')
    const p = panel()
    for (const h of ['Shapes', 'Lines', 'Frames']) expect(within(p).getByRole('heading', { name: h })).toBeTruthy()
    expect(within(p).getByRole('button', { name: 'Ellipse' })).toBeTruthy()
    expect(within(p).getByRole('button', { name: 'Arrow line' })).toBeTruthy()
    expect(within(p).getByRole('button', { name: 'Border frame' })).toBeTruthy()
    // a shipped template with no category is not a tile
    expect(within(p).queryByRole('button', { name: /static text/i })).toBeNull()
    // no graphics of the person's own: no empty note under the shapes
    expect(within(p).queryByText('No graphics available')).toBeNull()
    expect(adapter.listSystemOverlays).toHaveBeenCalled()
  })

  it('a shape tile previews at the box the element is added in, so px props are in scale (a rounded rectangle is not a circle)', async () => {
    const ROUNDED = sys('shape-rounded-rect', 'Rounded rectangle', 'shape', [...FILL, { name: 'cornerRadius', type: 'int', default: 48 }])
    const Fake = (_f: number, _fps: number, _d: number, p: Record<string, unknown>) => <svg width={p.boxWidth as number}><rect data-testid="thumb-rect" rx={p.cornerRadius as number} width={p.boxWidth as number} /></svg>
    await mount(three(), { listSystemOverlays: vi.fn(async () => [ROUNDED]), compileOverlay: vi.fn(async () => Fake as never) })
    await openRail('Elements')
    await tile('Rounded rectangle')
    await settle()
    const rect = within(panel()).getAllByTestId('thumb-rect')[0]
    expect(Number(rect.getAttribute('rx')) / Number(rect.getAttribute('width'))).toBeLessThan(0.2)
  })

  it('the Shapes tiles sit in order: a section with no template is not shown', async () => {
    await mount(three(), { listSystemOverlays: vi.fn(async () => [RECT]) })
    await openRail('Elements')
    await tile('Rectangle')
    expect(within(panel()).queryByRole('heading', { name: 'Lines' })).toBeNull()
    expect(within(panel()).queryByRole('heading', { name: 'Frames' })).toBeNull()
  })

  it('a click adds the shape to the active slide: a centred square, its defaults, one undo step', async () => {
    const { adapter } = await mount()
    await openRail('Elements')
    await pickSlideOf('el-1')
    await act(async () => { fireEvent.click(await tile('Rectangle')) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [o] = overlaysOn(lastSave(adapter), 1)
    expect(o.overlay.template).toBe(RECT.jsxPath)
    expect(o.overlay.props).toEqual({ fill: '#bdbdbd', stroke: '#111111', strokeWidth: '0' })
    expect([o.w, o.h]).toEqual([432, 432])
    expect([o.x + o.w / 2, o.y + o.h / 2]).toEqual([540, 540])
    expect(overlaysOn(lastSave(adapter), 0)).toHaveLength(0)
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(overlaysOn(lastSave(adapter), 1)).toHaveLength(0)
  })

  it('a line is added in a wide, thin box', async () => {
    const { adapter } = await mount()
    await openRail('Elements')
    await act(async () => { fireEvent.click(await tile('Arrow line')) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [o] = overlaysOn(lastSave(adapter), 0)
    expect([o.w, o.h]).toEqual([648, 54])
    expect([o.x + o.w / 2, o.y + o.h / 2]).toEqual([540, 540])
    expect(o.overlay.props.arrowhead).toBe('end')
  })

  it('a tile dragged onto a slide adds the shape centred on the drop point, one save', async () => {
    const { adapter } = await mount()
    await openRail('Elements')
    const t = await tile('Ellipse')
    const dt = transfer()
    await act(async () => { fireEvent.dragStart(t, { dataTransfer: dt }) })
    expect(dt.types).toContain(TEMPLATE_DND_MIME)
    const { box, at } = pinSlide(0)
    const over = await fire(box, dragEvent('dragover', at(300, 800), dt))
    expect(over.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('copy')
    const drop = await fire(box, dragEvent('drop', at(300, 800), dt))
    expect(drop.defaultPrevented).toBe(true)
    await act(async () => { fireEvent.dragEnd(t, { dataTransfer: dt }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [o] = overlaysOn(lastSave(adapter), 0)
    expect(o.overlay.template).toBe(ELLIPSE.jsxPath)
    expect([o.x + o.w / 2, o.y + o.h / 2]).toEqual([300, 800])
    expect(adapter.uploadFile).not.toHaveBeenCalled()
  })

  it('a drag with the template type that did not start on a tile is ignored; so is one after the tile drag ended', async () => {
    const { adapter } = await mount()
    await openRail('Elements')
    const t = await tile('Ellipse')
    const { box, at } = pinSlide(0)
    // from another page or app: the type alone
    const foreign = transfer([TEMPLATE_DND_MIME])
    foreign.data[TEMPLATE_DND_MIME] = ELLIPSE.jsxPath
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const e = await fire(box, dragEvent(type, at(300, 300), foreign))
      expect(e.defaultPrevented).toBe(false)
    }
    // a tile drag that ended (dropped elsewhere) is not believed afterwards
    const dt = transfer()
    await act(async () => { fireEvent.dragStart(t, { dataTransfer: dt }) })
    await act(async () => { fireEvent.dragEnd(t, { dataTransfer: dt }) })
    const late = await fire(box, dragEvent('drop', at(300, 300), dt))
    expect(late.defaultPrevented).toBe(false)
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
  })
})

describe('Edit popover for a shape: colour and option props', () => {
  it('a colour prop gets a swatch and an option prop a select, which writes one undo step', async () => {
    const line: OverlayElement = {
      id: 'el-line', type: 'overlay', frame: 59, x: 100, y: 500, w: 648, h: 54, rotation: 0,
      overlay: { template: LINE.jsxPath, props: { stroke: '#111111', strokeWidth: '8', arrowhead: 'end' } },
    }
    const { adapter, r } = await mount(makeProject([slide(0, [img('el-0'), line])]))
    await pickSlideOf('el-line')
    await act(async () => { fireEvent.click(within(r.getByRole('toolbar', { name: 'Element' })).getByRole('button', { name: 'Edit' })) })
    const pop = r.getByRole('dialog', { name: 'Edit' })
    const select = await waitFor(() => within(pop).getByRole('combobox', { name: 'arrowhead' }) as HTMLSelectElement)
    expect(within(pop).getByRole('button', { name: 'stroke' })).toBeTruthy()
    expect(within(pop).queryByRole('textbox', { name: 'stroke' })).toBeNull()
    expect(select.value).toBe('end')
    await act(async () => { fireEvent.change(select, { target: { value: 'both' } }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(overlaysOn(lastSave(adapter), 0)[0].overlay.props.arrowhead).toBe('both')
  })
})

describe('Edit popover for a shape: numeric props step', () => {
  it("the shipped dashed line's strokeWidth has a stepper (int in the sidecar)", async () => {
    const dashed = { ...dashedSidecar, name: 'line-dashed', jsxPath: '/rt/render/templates/overlays/line-dashed/line-dashed.jsx' } as GlobalOverlay
    const el: OverlayElement = {
      id: 'el-dash', type: 'overlay', frame: 59, x: 100, y: 500, w: 648, h: 54, rotation: 0,
      overlay: { template: dashed.jsxPath, props: { stroke: '#111111', strokeWidth: 8, dash: 24, gap: 16, arrowhead: 'none' } },
    }
    const { adapter, r } = await mount(makeProject([slide(0, [img('el-0'), el])]), { listSystemOverlays: vi.fn(async () => [dashed]) })
    await pickSlideOf('el-dash')
    await act(async () => { fireEvent.click(within(r.getByRole('toolbar', { name: 'Element' })).getByRole('button', { name: 'Edit' })) })
    const pop = r.getByRole('dialog', { name: 'Edit' })
    const inc = await waitFor(() => within(pop).getByRole('button', { name: 'Increase strokeWidth' }))
    await act(async () => { fireEvent.click(inc) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    // The editor writes every prop edit as a string; the templates read either.
    expect(overlaysOn(lastSave(adapter), 0)[0].overlay.props.strokeWidth).toBe('9')
  })
})

describe('Edit popover for a shape: no Frame field', () => {
  it('a shape has no Frame (it does not animate), once its props are shown', async () => {
    const line: OverlayElement = {
      id: 'el-line', type: 'overlay', frame: 59, x: 100, y: 500, w: 648, h: 54, rotation: 0,
      overlay: { template: LINE.jsxPath, props: { stroke: '#111111', strokeWidth: '8', arrowhead: 'end' } },
    }
    const { r } = await mount(makeProject([slide(0, [img('el-0'), line])]))
    await pickSlideOf('el-line')
    await act(async () => { fireEvent.click(within(r.getByRole('toolbar', { name: 'Element' })).getByRole('button', { name: 'Edit' })) })
    const pop = r.getByRole('dialog', { name: 'Edit' })
    await waitFor(() => within(pop).getByRole('combobox', { name: 'arrowhead' }))
    expect(within(pop).queryByText('Frame')).toBeNull()
    expect(within(pop).queryByRole('spinbutton', { name: 'Frame' })).toBeNull()
  })
})

describe('Ask your AI for a custom shape', () => {
  it('is not shown without onAskAi', async () => {
    await mount()
    await openRail('Elements')
    await tile('Rectangle')
    expect(screen.queryByRole('button', { name: 'Ask your AI for a shape' })).toBeNull()
  })

  it('is a pill at the top of Elements; a click hands the host the slide with empty text (the host opens its own modal)', async () => {
    const onAskAi = vi.fn<(req: AskAiRequest) => void>()
    await mount(three(), {}, { onAskAi })
    await pickSlideOf('el-2')
    await openRail('Elements')
    const pill = await screen.findByRole('button', { name: 'Ask your AI for a shape' })
    // At the top: before the first shape tile in the panel.
    const first = await tile('Rectangle')
    expect(pill.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Ask your AI for a custom shape' })).toBeNull()
    await act(async () => { fireEvent.click(pill) })
    expect(onAskAi).toHaveBeenCalledTimes(1)
    expect(onAskAi).toHaveBeenCalledWith({ kind: 'shape', slideId: 's2', text: '' })
  })
})
