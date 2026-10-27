import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { CarouselApi, EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'
import { setImageAsBackground } from '../background'

// §587 M4: the Layers and Background rail panels.

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

const img = (id: string, extra: Partial<ImageElement> = {}): ImageElement => ({ id, type: 'image', src: `/m/${id}.png`, x: 100, y: 100, w: 200, h: 200, rotation: 0, ...extra })
const txt = (id: string, text: string): OverlayElement => ({ id, type: 'overlay', overlay: { template: 'text', props: { text } }, frame: 0, x: 10, y: 10, w: 300, h: 80, rotation: 0 })
const badge = (id: string): OverlayElement => ({ id, type: 'overlay', overlay: { template: 'sticker', props: {} }, frame: 0, x: 10, y: 10, w: 50, h: 50, rotation: 0 })
const slide = (id: string, elements: Slide['elements']): Slide => ({ id, base_color: '#ffffff', elements })
function makeProject(slides: Slide[]): Project {
  return { version: '1', id: 'p', name: 'T', workflow: 'carousel', status: 'draft', editingPrompt: '', projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [], slides } as Project
}
function makeAdapter(initial: Project) {
  const saveCalls: Array<{ id: string; project: Project }> = []
  const adapter: EditorAdapter<Project> & { saveCalls: typeof saveCalls } = {
    loadProject: vi.fn(async () => initial),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/o.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (p: string) => p,
    saveCalls,
  }
  return adapter
}
class MockIO { constructor(public cb: IntersectionObserverCallback) {} observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }
const realIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
const pc = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  vi.restoreAllMocks()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIO
  if (pc) Object.defineProperty(Element.prototype, 'setPointerCapture', pc)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

async function mount(project: Project, extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}) {
  const adapter = makeAdapter(project)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" {...extra} />)
  await waitFor(() => expect(document.querySelectorAll('[data-slide-section]').length).toBe(project.slides!.length))
  return { adapter, r }
}
const openRail = async (r: ReturnType<typeof render>, name: string) => {
  await act(async () => { fireEvent.click(within(r.getByRole('navigation', { name: 'Editor rail' })).getByRole('button', { name })) })
}
const rowIds = () => Array.from(document.querySelectorAll<HTMLElement>('[data-layer-id]')).map((e) => e.dataset.layerId)
const row = (id: string) => document.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!
const lastSave = (a: ReturnType<typeof makeAdapter>) => a.saveCalls[a.saveCalls.length - 1].project
const elIds = (p: Project, i = 0) => p.slides![i].elements.map((e) => e.id)

const base = () => makeProject([slide('s0', [img('a'), txt('b', 'Hello world'), badge('c')]), slide('s1', [img('d')])])

describe('Layers panel', () => {
  it('lists the active slide front to back with names and a Background row', async () => {
    const { r } = await mount(base())
    await openRail(r, 'Layers')
    expect(rowIds()).toEqual(['c', 'b', 'a'])
    expect(row('b').textContent).toContain('Hello world')
    expect(row('a').textContent).toContain('a.png')
    expect(row('c').textContent).toContain('sticker')
    expect(document.querySelector('[data-layer-background]')?.textContent).toBe('Background')
  })

  it('selects on click and toggles on shift-click', async () => {
    const { r } = await mount(base())
    await openRail(r, 'Layers')
    await act(async () => { fireEvent.click(within(row('a')).getByRole('button', { name: /^Select/ })) })
    expect(within(row('a')).getByRole('button', { name: /^Select/ }).getAttribute('aria-pressed')).toBe('true')
    await act(async () => { fireEvent.click(within(row('b')).getByRole('button', { name: /^Select/ }), { shiftKey: true }) })
    expect(within(row('a')).getByRole('button', { name: /^Select/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(row('b')).getByRole('button', { name: /^Select/ }).getAttribute('aria-pressed')).toBe('true')
    await act(async () => { fireEvent.click(within(row('b')).getByRole('button', { name: /^Select/ }), { shiftKey: true }) })
    expect(within(row('b')).getByRole('button', { name: /^Select/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('a drag reorder is one save', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Layers')
    const before = adapter.saveCalls.length
    // Drag the front row (c) below the back row (a): c becomes the back.
    await act(async () => {
      fireEvent.dragStart(row('c'))
      fireEvent.dragOver(row('a'), { clientY: 5 })
      fireEvent.drop(row('a'), { clientY: 5 })
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(elIds(lastSave(adapter))).toEqual(['c', 'a', 'b'])
  })

  it('lock toggle locks and unlocks one element', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Layers')
    await act(async () => { fireEvent.click(within(row('b')).getByRole('button', { name: /^Lock/ })) })
    await waitFor(() => expect(lastSave(adapter).slides![0].elements.find((e) => e.id === 'b')).toMatchObject({ locked: true }))
    expect(lastSave(adapter).slides![0].elements.find((e) => e.id === 'a')).not.toHaveProperty('locked')
    await act(async () => { fireEvent.click(within(row('b')).getByRole('button', { name: /^Unlock/ })) })
    await waitFor(() => expect(lastSave(adapter).slides![0].elements.find((e) => e.id === 'b')).not.toHaveProperty('locked'))
  })

  it('the eye calls the host and is absent without it', async () => {
    const onToggle = vi.fn()
    const { r } = await mount(base(), { hiddenElementIds: ['a'], onToggleElementVisibility: onToggle })
    await openRail(r, 'Layers')
    await act(async () => { fireEvent.click(within(row('b')).getByRole('button', { name: /^Hide/ })) })
    expect(onToggle).toHaveBeenCalledWith('b')
    expect(within(row('a')).getByRole('button', { name: /^Show/ })).toBeTruthy()
  })
  it('has no eye without the host callback', async () => {
    const { r } = await mount(base())
    await openRail(r, 'Layers')
    expect(within(row('b')).queryByRole('button', { name: /^(Hide|Show)/ })).toBeNull()
  })

  it('header buttons reorder the selection', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Layers')
    const send = r.getByRole('button', { name: 'Send to back' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(within(row('c')).getByRole('button', { name: /^Select/ })) })
    await act(async () => { fireEvent.click(send) })
    await waitFor(() => expect(elIds(lastSave(adapter))).toEqual(['c', 'a', 'b']))
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Bring to front' })) })
    await waitFor(() => expect(elIds(lastSave(adapter))).toEqual(['a', 'b', 'c']))
  })

  it('follows the active slide', async () => {
    const { r } = await mount(base())
    await openRail(r, 'Layers')
    await act(async () => { fireEvent.click(r.getByRole('button', { name: /^Slides / })) })
    await act(async () => { fireEvent.click(r.getByRole('option', { name: 'Slide 2' })) })
    expect(rowIds()).toEqual(['d'])
  })
})

describe('Background panel', () => {
  it('a colour change writes once', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Background')
    const before = adapter.saveCalls.length
    const input = r.container.ownerDocument.querySelector<HTMLInputElement>('input[type="color"][aria-label="Background color"]')!
    await act(async () => { fireEvent.change(input, { target: { value: '#112233' } }) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(lastSave(adapter).slides![0].base_color).toBe('#112233')
  })

  it('Set image as background is disabled without a selected image', async () => {
    const { r } = await mount(base())
    await openRail(r, 'Background')
    expect((r.getByRole('button', { name: 'Set image as background' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Set image as background covers, sends to back and locks in one save', async () => {
    const p = makeProject([slide('s0', [img('a', { x: 50, y: 60, w: 400, h: 200 }), txt('b', 'Hi')])])
    const { r, adapter } = await mount(p)
    await openRail(r, 'Layers')
    await act(async () => { fireEvent.click(within(row('a')).getByRole('button', { name: /^Select/ })) })
    await openRail(r, 'Layers')
    await openRail(r, 'Background')
    const before = adapter.saveCalls.length
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Set image as background' })) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    const els = lastSave(adapter).slides![0].elements
    expect(els.map((e) => e.id)).toEqual(['a', 'b'])
    expect(els[0]).toMatchObject({ x: 0, y: 0, w: 1080, h: 1350, locked: true })
  })

  it('setAsBackground is on the carousel api', async () => {
    let api: CarouselApi | null = null
    const { adapter } = await mount(makeProject([slide('s0', [txt('b', 'Hi'), img('a')])]), { onProvideCarouselApi: (a) => { api = a } })
    await act(async () => { api!.setAsBackground('a') })
    await waitFor(() => expect(lastSave(adapter).slides![0].elements[0]).toMatchObject({ id: 'a', locked: true, w: 1080 }))
  })
})

describe('setImageAsBackground', () => {
  it('crops a wide image to the slide aspect around the visible part', () => {
    // A 2:1 source shown whole in a 2:1 box.
    const out = setImageAsBackground([img('a', { w: 400, h: 200 })], 'a', 1000, 1000)
    const crop = (out[0] as ImageElement).crop!
    expect(crop.h).toBeCloseTo(1)
    expect(crop.w).toBeCloseTo(0.5)
    expect(crop.x).toBeCloseTo(0.25)
  })
  it('leaves a locked image alone', () => {
    const els = [img('a', { locked: true })]
    expect(setImageAsBackground(els, 'a', 1000, 1000)).toBe(els)
  })
})
