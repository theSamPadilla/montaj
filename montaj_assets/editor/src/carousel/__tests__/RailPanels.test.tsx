import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, screen } from '@testing-library/react'
import type { EditorAdapter, GlobalOverlay, ImageElement, OverlayElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'

// §587 M4b: the Text, Elements and AI image rail panels.

// jsdom never loads an image, so a real size read would wait out its timeout.
vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

function slide(i: number, elements: Slide['elements'] = []): Slide {
  return { id: `s${i}`, base_color: '#ffffff', elements }
}
const img = (id: string, x = 100, y = 100): ImageElement => ({ id, type: 'image', src: `${id}.png`, x, y, w: 200, h: 200, rotation: 0 })

function makeProject(slides: Slide[]): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [], slides,
  } as Project
}

/** Three slides, each with one image: el-0, el-1, el-2. */
const three = () => makeProject([slide(0, [img('el-0')]), slide(1, [img('el-1')]), slide(2, [img('el-2')])])

function makeAdapter(initial: Project) {
  const saveCalls: Array<{ id: string; project: Project }> = []
  const adapter: EditorAdapter<Project> & { saveCalls: typeof saveCalls } = {
    loadProject: vi.fn(async () => initial),
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


const TPL: GlobalOverlay = { name: 'static-text', description: '', jsxPath: 'static-text.jsx', props: [{ name: 'text', type: 'string', default: 'Hello' }, { name: 'color', type: 'color', default: '#000' }] }
const OVERLAYS: GlobalOverlay[] = [
  { name: 'Lower third', description: '', jsxPath: 'lower-third.jsx', props: [{ name: 'title', type: 'string', default: 'Name' }] },
  { name: 'Badge', description: '', jsxPath: 'badge.jsx', props: [] },
]

class MockIO {
  constructor(public cb: IntersectionObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
const realIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  vi.restoreAllMocks()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIO
})

function adapterWith(project: Project, extra: Partial<EditorAdapter<Project>> = {}) {
  const a = makeAdapter(project)
  a.getDefaultTextOverlay = vi.fn(async () => TPL)
  a.listGlobalOverlays = vi.fn(async () => OVERLAYS)
  return Object.assign(a, extra)
}
async function mount(project: Project, extra: Partial<EditorAdapter<Project>> = {}) {
  const adapter = adapterWith(project, extra)
  render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" />)
  await waitFor(() => expect(document.querySelectorAll('[data-slide-section]').length).toBe(project.slides!.length))
  await act(async () => {})
  return adapter
}
const lastSave = (a: ReturnType<typeof makeAdapter>) => a.saveCalls[a.saveCalls.length - 1].project
const wrapper = (id: string) => document.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!
async function pickSlideOf(elId: string) {
  await act(async () => {
    wrapper(elId).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }))
    fireEvent.click(wrapper(elId))
  })
}
const openRail = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`) })) }) }
const added = (p: Project, slide: number) => p.slides![slide].elements.filter((e) => e.type === 'overlay') as OverlayElement[]

describe('Text panel', () => {
  it('Add a text box adds one centred text box, one undo step, to the active slide', async () => {
    const adapter = await mount(three())
    await pickSlideOf('el-1')
    await openRail('Text')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Add a text box/ })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const p = lastSave(adapter)
    expect(added(p, 0)).toHaveLength(0)
    expect(added(p, 2)).toHaveLength(0)
    const [t] = added(p, 1)
    expect(t.overlay.template).toBe('static-text.jsx')
    expect(t.x + t.w / 2).toBe(540)
    expect(t.y + t.h / 2).toBe(540)
    expect(screen.getByText('T')).toBeTruthy()
  })

  it.each([
    ['Add a heading', '108', '700'],
    ['Add a subheading', '65', '600'],
    ['Add body text', '38', '400'],
  ])('%s adds a text box with its preset props', async (label, size, weight) => {
    const adapter = await mount(three())
    await openRail('Text')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [t] = added(lastSave(adapter), 0)
    expect(t.overlay.props.fontSize).toBe(size)
    expect(t.overlay.props.fontWeight).toBe(weight)
    expect(t.x + t.w / 2).toBe(540)
    expect(t.y + t.h / 2).toBe(540)
  })
})

describe('Elements panel', () => {
  it('lists the templates and a click adds one to the active slide', async () => {
    const adapter = await mount(three())
    await pickSlideOf('el-2')
    await openRail('Elements')
    const tile = await screen.findByRole('button', { name: /Lower third/ })
    expect(screen.getByRole('button', { name: /Badge/ })).toBeTruthy()
    await act(async () => { fireEvent.click(tile) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [o] = added(lastSave(adapter), 2)
    expect(o.overlay.template).toBe('lower-third.jsx')
    expect(o.overlay.props).toEqual({ title: 'Name' })
    expect(added(lastSave(adapter), 0)).toHaveLength(0)
  })
})

describe('AI image panel', () => {
  it('Generate calls the same adapter call as classic and adds the image to the active slide', async () => {
    const generateImage = vi.fn(async () => ({ path: '/gen.png' }))
    const adapter = await mount(three(), { generateImage })
    await pickSlideOf('el-1')
    await openRail('AI image')
    const field = screen.getByLabelText('Describe the image to generate')
    const go = screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    await act(async () => { fireEvent.change(field, { target: { value: 'a red fox' } }) })
    await act(async () => { fireEvent.click(go) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(generateImage).toHaveBeenCalledWith('a red fox', 'proj-1')
    const imgs = lastSave(adapter).slides![1].elements.filter((e) => e.type === 'image' && (e as ImageElement).src === '/gen.png')
    expect(imgs).toHaveLength(1)
  })
})
