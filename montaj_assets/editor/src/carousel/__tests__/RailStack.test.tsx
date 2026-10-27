import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'
import { SELECTION_AWAY_PX } from '../StackedSlides'

// §587 M2: the rail layout's stacked slides, their headers and the grid view.

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

// ── A mocked IntersectionObserver: the test says which slides are in view ──
class MockIO {
  static instances: MockIO[] = []
  observed = new Set<Element>()
  constructor(public cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) { MockIO.instances.push(this) }
  observe(el: Element) { this.observed.add(el) }
  unobserve(el: Element) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  takeRecords() { return [] }
}
/** A user scroll of the stack: a scroll event, then the observer reports each named slide's share in view (0..1). */
async function inView(ratios: Record<string, number>) {
  await act(async () => { document.querySelector('[data-slide-stack]')!.dispatchEvent(new Event('scroll')) })
  await layoutInView(ratios)
}
/** The observer reports the shares with no scroll before it: the layout changed (a zoom, a panel opened). */
async function layoutInView(ratios: Record<string, number>) {
  const io = [...MockIO.instances].reverse().find((o) => o.observed.size > 0)
  if (!io) throw new Error('no IntersectionObserver is observing')
  const entries = [...io.observed]
    .filter((el) => (el as HTMLElement).dataset.slideSection! in ratios)
    .map((el) => {
      const r = ratios[(el as HTMLElement).dataset.slideSection!]
      return { target: el, intersectionRatio: r, isIntersecting: r > 0 } as unknown as IntersectionObserverEntry
    })
  await act(async () => { io.cb(entries, io as unknown as IntersectionObserver) })
}

/** Lays the stack out 800 x 600 at the origin and `id`'s element at `top` (100 px tall): jsdom has no layout. */
function placeElement(id: string, top: number) {
  const rect = (t: number, h: number, w: number) => () => ({ left: 0, top: t, right: w, bottom: t + h, width: w, height: h, x: 0, y: t, toJSON: () => ({}) }) as DOMRect
  document.querySelector<HTMLElement>('[data-slide-stack]')!.getBoundingClientRect = rect(0, 600, 800)
  wrapper(id).getBoundingClientRect = rect(top, 100, 200)
}

const realIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  MockIO.instances = []
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  vi.restoreAllMocks()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIO
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

async function mount(project: Project, extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}) {
  const adapter = makeAdapter(project)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" {...extra} />)
  await waitFor(() => expect(sections().length).toBe(project.slides!.length))
  return { adapter, r }
}

const sections = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slide-section]'))
const section = (id: string) => document.querySelector<HTMLElement>(`[data-slide-section="${id}"]`)!
/** Whether the slide is drawn by a live, interactive canvas (else its static thumbnail). */
const live = (id: string) => section(id).querySelector('[data-interactive]') !== null
const wrapper = (id: string) => document.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!
const chromeOf = (id: string) => document.querySelector<HTMLElement>(`[data-chrome-for="${id}"]`) ?? document.createElement('div')
const header = (id: string) => within(section(id).querySelector<HTMLElement>('[data-slide-header]')!)
const lastSave = (a: ReturnType<typeof makeAdapter>) => a.saveCalls[a.saveCalls.length - 1].project
const slideIds = (p: Project) => p.slides!.map((s) => s.id)
const counter = (r: ReturnType<typeof render>) => within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: /^Slides / })

function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })) })
}
/** A press and release without moving, then the click: a click on the element. */
async function pressClick(el: HTMLElement) {
  await act(async () => {
    pointer(el, 'pointerdown', { clientX: 10, clientY: 10 })
    pointer(window, 'pointerup', { clientX: 10, clientY: 10 })
    fireEvent.click(el)
  })
}
function loadImage(el: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(el, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(el, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(el)
}
/** Crop mode on el-0 (slide 1) by a double-click, its 400 x 200 source loaded, its right edge dragged in a quarter. */
async function pickCrop() {
  await pressClick(wrapper('el-0'))
  await act(async () => { fireEvent.doubleClick(wrapper('el-0')) })
  const source = chromeOf('el-0').querySelector<HTMLImageElement>('img[alt="Crop source"]')!
  expect(source).not.toBeNull()
  await act(async () => { loadImage(source, 400, 200) })
  const handle = chromeOf('el-0').querySelector('[data-testid="crop-handle-e"]') as HTMLElement
  const root = section('s0').querySelector<HTMLElement>('[data-interactive]')!
  const d = 50 * (parseFloat(root.style.width) / 1080)
  await act(async () => {
    pointer(handle, 'pointerdown', { clientX: 0, clientY: 0 })
    pointer(handle, 'pointermove', { clientX: -d, clientY: 0 })
    pointer(handle, 'pointerup', { clientX: -d, clientY: 0 })
    fireEvent.click(handle)
  })
}
function expectCropApplied(el: unknown) {
  expect(el).toMatchObject({ x: 100, y: 150, w: 150, h: 100 })
  expect((el as ImageElement).crop!.w).toBeCloseTo(0.75, 9)
}
const inCrop = () => chromeOf('el-0').querySelector('img[alt="Crop source"]') !== null

describe('CarouselEditor layout="rail": stacked slides (§587 M2)', () => {
  it('renders every slide stacked in one scroll, in order, each with a header', async () => {
    const { r } = await mount(makeProject([slide(0), slide(1), slide(2), slide(3)]))
    expect(sections().map((s) => s.dataset.slideSection)).toEqual(['s0', 's1', 's2', 's3'])
    sections().forEach((s, i) => {
      const h = within(s.querySelector<HTMLElement>('[data-slide-header]')!)
      expect(h.getByText(`Slide ${i + 1}`)).toBeTruthy()
      expect((h.getByRole('textbox', { name: `Slide ${i + 1} title` }) as HTMLInputElement).placeholder).toBe('Add a title')
      for (const name of ['Move slide up', 'Move slide down', 'Duplicate slide', 'Delete slide', 'Add slide after']) {
        expect(h.getByRole('button', { name })).toBeTruthy()
      }
    })
    // One scrolling column holds them all.
    const stack = r.container.querySelector('[data-slide-stack]')!
    expect(sections().every((s) => stack.contains(s))).toBe(true)
    // There is no hide: slides have no visibility of their own.
    expect(r.queryByRole('button', { name: /Hide slide/ })).toBeNull()
  })

  it('only the slides in view, one either side and the active one are live canvases; two away are thumbnails, the rest placeholders', async () => {
    const { r } = await mount(makeProject([0, 1, 2, 3, 4, 5].map((i) => slide(i, [img(`el-${i}`)]))))
    await inView({ s0: 1, s1: 0.2 })
    expect(['s0', 's1', 's2', 's3', 's4', 's5'].map(live)).toEqual([true, true, true, false, false, false])
    // A thumbnail still draws the slide; further away a placeholder stands in.
    expect(section('s3').querySelector('[data-element-id="el-3"]')).not.toBeNull()
    expect(section('s4').querySelector('[data-element-id="el-4"]')).toBeNull()
    expect(section('s4').querySelector('[data-slide-placeholder]')).not.toBeNull()

    // Scrolled down: slide 5 is the one most in view and becomes active.
    await inView({ s0: 0, s1: 0, s3: 0.3, s4: 1 })
    expect(counter(r).textContent).toContain('5 / 6')
    expect(['s0', 's1', 's2', 's3', 's4', 's5'].map(live)).toEqual([false, false, true, true, true, true])
  })

  it('a scale change with two slides in view does not change the active slide; a user scroll does', async () => {
    const { r } = await mount(three())
    await inView({ s0: 1, s1: 0.4 })
    await pressClick(wrapper('el-0'))
    const slider = within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('slider', { name: 'Zoom' })
    await act(async () => { fireEvent.change(slider, { target: { value: '30' } }) })
    // Smaller slides: slide 2 is now the one most in view, by layout alone.
    await layoutInView({ s0: 0.8, s1: 1 })
    expect(counter(r).textContent).toContain('1 / 3')
    expect(chromeOf('el-0').style.outline).toContain('solid')
    // A scroll just before a zoom is not a scroll to another slide either.
    await act(async () => { document.querySelector('[data-slide-stack]')!.dispatchEvent(new Event('scroll')) })
    await act(async () => { fireEvent.change(slider, { target: { value: '40' } }) })
    await layoutInView({ s0: 0.7, s1: 1 })
    expect(counter(r).textContent).toContain('1 / 3')
    // The person scrolls slide 2 more into view, the selected element still
    // in view: the selection holds its slide (§587 R8).
    placeElement('el-0', 10)
    await inView({ s0: 0.5, s1: 1 })
    expect(counter(r).textContent).toContain('1 / 3')
    expect(chromeOf('el-0').style.outline).toContain('solid')
    // Just out of view, within a slide header's height: still held.
    placeElement('el-0', -100 - SELECTION_AWAY_PX + 2)
    await inView({ s0: 0.4, s1: 1 })
    expect(counter(r).textContent).toContain('1 / 3')
    expect(chromeOf('el-0').style.outline).toContain('solid')
    // Scrolled far out of view: the selection goes and the slide most in view takes over.
    placeElement('el-0', -100 - SELECTION_AWAY_PX - 2)
    await inView({ s0: 0.3, s1: 1 })
    expect(counter(r).textContent).toContain('2 / 3')
    expect(document.querySelector('[data-chrome-for="el-0"]')).toBeNull()
  })

  it('with nothing selected, a scroll to another slide makes it active', async () => {
    const { r } = await mount(three())
    await inView({ s0: 1, s1: 0.4 })
    await inView({ s0: 0.5, s1: 1 })
    expect(counter(r).textContent).toContain('2 / 3')
  })

  it('a wheel on the stack counts as a scroll; a slide scrolled to from the slide list stays active', async () => {
    const scrollTo = vi.fn()
    HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
    const { r } = await mount(three())
    await layoutInView({ s0: 1, s1: 0.4 })
    await act(async () => { document.querySelector('[data-slide-stack]')!.dispatchEvent(new Event('wheel')) })
    await layoutInView({ s0: 0.4, s1: 1 })
    expect(counter(r).textContent).toContain('2 / 3')
    // A scroll, then a pick from the list: the stack's own scroll to slide 3 activates nothing else.
    await act(async () => { document.querySelector('[data-slide-stack]')!.dispatchEvent(new Event('scroll')) })
    await act(async () => { fireEvent.click(counter(r)) })
    await act(async () => { fireEvent.click(r.getByRole('option', { name: 'Slide 3' })) })
    expect(scrollTo).toHaveBeenCalled()
    await layoutInView({ s0: 0, s1: 1, s2: 0.6 })
    expect(counter(r).textContent).toContain('3 / 3')
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it('a click on an element on slide 3 makes slide 3 active, and Delete acts there', async () => {
    const { adapter, r } = await mount(three())
    await inView({ s0: 1, s1: 0.4 })
    await pressClick(wrapper('el-0'))
    expect(chromeOf('el-0').style.outline).toContain('solid')

    await pressClick(wrapper('el-2'))
    expect(counter(r).textContent).toContain('3 / 3')
    // Selection is per slide: slide 1's is gone.
    expect(document.querySelector('[data-chrome-for="el-0"]')).toBeNull()
    expect(chromeOf('el-2').style.outline).toContain('solid')

    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    expect(lastSave(adapter).slides![2].elements).toEqual([])
    expect(lastSave(adapter).slides![0].elements.map((e) => e.id)).toEqual(['el-0'])
  })

  it('a click on the empty canvas of another slide applies a pending crop and makes that slide active', async () => {
    const { adapter, r } = await mount(three())
    await inView({ s0: 1, s1: 0.4 })
    await pickCrop()
    expect(adapter.saveCalls).toHaveLength(0)
    const root = section('s1').querySelector<HTMLElement>('[data-interactive]')!
    await act(async () => { fireEvent.click(root) })
    await waitFor(() => expectCropApplied(lastSave(adapter).slides![0].elements[0]))
    expect(inCrop()).toBe(false)
    expect(counter(r).textContent).toContain('2 / 3')
  })

  it('scrolling the cropping slide away applies its crop', async () => {
    const { adapter, r } = await mount(three())
    await inView({ s0: 1, s1: 0.4 })
    await pickCrop()
    // Slide 2 most in view alone keeps the crop; the image far out of view applies it.
    await inView({ s0: 0.4, s1: 1 })
    expect(inCrop()).toBe(true)
    expect(adapter.saveCalls).toHaveLength(0)
    placeElement('el-0', -400)
    await inView({ s0: 0.1, s1: 1 })
    await waitFor(() => expectCropApplied(lastSave(adapter).slides![0].elements[0]))
    expect(inCrop()).toBe(false)
    expect(counter(r).textContent).toContain('2 / 3')
  })

  it.each([
    ['a zoom key', async () => { await key('1', { metaKey: true }) }],
    ['the zoom slider', async (r: ReturnType<typeof render>) => {
      const sl = within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('slider', { name: 'Zoom' })
      await act(async () => { fireEvent.change(sl, { target: { value: '150' } }) })
    }],
    ['the zoom % button', async (r: ReturnType<typeof render>) => {
      await act(async () => { fireEvent.click(within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: /^Zoom level/ })) })
    }],
  ])('%s applies a pending crop first', async (_name, zoom) => {
    const { adapter, r } = await mount(three())
    await inView({ s0: 1, s1: 0.4 })
    await pickCrop()
    expect(adapter.saveCalls).toHaveLength(0)
    await zoom(r)
    await waitFor(() => expectCropApplied(lastSave(adapter).slides![0].elements[0]))
    expect(inCrop()).toBe(false)
  })

  it('move down and move up each reorder in one undo step', async () => {
    const { adapter } = await mount(three())
    await act(async () => { fireEvent.click(header('s0').getByRole('button', { name: 'Move slide down' })) })
    await waitFor(() => expect(slideIds(lastSave(adapter))).toEqual(['s1', 's0', 's2']))
    expect(sections().map((s) => s.dataset.slideSection)).toEqual(['s1', 's0', 's2'])
    expect((header('s0').getByRole('button', { name: 'Move slide down' }) as HTMLButtonElement).disabled).toBe(false)
    const saves = adapter.saveCalls.length
    await key('z', { metaKey: true })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(saves))
    expect(slideIds(lastSave(adapter))).toEqual(['s0', 's1', 's2'])

    await act(async () => { fireEvent.click(header('s2').getByRole('button', { name: 'Move slide up' })) })
    await waitFor(() => expect(slideIds(lastSave(adapter))).toEqual(['s0', 's2', 's1']))
    await key('z', { metaKey: true })
    await waitFor(() => expect(slideIds(lastSave(adapter))).toEqual(['s0', 's1', 's2']))
    // The first can't go up and the last can't go down.
    expect((header('s0').getByRole('button', { name: 'Move slide up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((header('s2').getByRole('button', { name: 'Move slide down' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('duplicate, delete and add after use the slide handlers, and the new slide is active', async () => {
    const { adapter, r } = await mount(three())
    await act(async () => { fireEvent.click(header('s1').getByRole('button', { name: 'Duplicate slide' })) })
    await waitFor(() => expect(lastSave(adapter).slides).toHaveLength(4))
    const copy = lastSave(adapter).slides![2]
    expect(copy.id).not.toBe('s1')
    expect(copy.elements[0]).toMatchObject({ src: 'el-1.png', x: 100, y: 100 })
    expect(copy.elements[0].id).not.toBe('el-1')
    expect(counter(r).textContent).toContain('3 / 4')

    await act(async () => { fireEvent.click(header('s0').getByRole('button', { name: 'Delete slide' })) })
    await waitFor(() => expect(lastSave(adapter).slides).toHaveLength(3))
    expect(slideIds(lastSave(adapter))[0]).toBe('s1')

    await act(async () => { fireEvent.click(header('s1').getByRole('button', { name: 'Add slide after' })) })
    await waitFor(() => expect(lastSave(adapter).slides).toHaveLength(4))
    const added = lastSave(adapter).slides![1]
    expect(added.elements).toEqual([])
    expect(slideIds(lastSave(adapter))[0]).toBe('s1')
    expect(counter(r).textContent).toContain('2 / 4')
  })

  it('deleting another slide from its header keeps the active slide and its selection', async () => {
    const { adapter, r } = await mount(three())
    await inView({ s0: 0.5, s1: 1, s2: 0.5 })
    await pressClick(wrapper('el-1'))
    expect(counter(r).textContent).toContain('2 / 3')
    expect(chromeOf('el-1').style.outline).toContain('solid')
    const del = header('s2').getByRole('button', { name: 'Delete slide' })
    await act(async () => {
      pointer(del, 'pointerdown', { clientX: 5, clientY: 5 })
      pointer(window, 'pointerup', { clientX: 5, clientY: 5 })
      fireEvent.click(del)
    })
    await waitFor(() => expect(slideIds(lastSave(adapter))).toEqual(['s0', 's1']))
    expect(counter(r).textContent).toContain('2 / 2')
    expect(chromeOf('el-1').style.outline).toContain('solid')
  })

  it('the title field writes `title` once, on Enter, as one undo step', async () => {
    const { adapter } = await mount(three())
    const field = header('s1').getByRole('textbox', { name: 'Slide 2 title' }) as HTMLInputElement
    await act(async () => { field.focus(); fireEvent.change(field, { target: { value: 'Intro' } }) })
    expect(adapter.saveCalls).toHaveLength(0)
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }) })
    await act(async () => { fireEvent.blur(field) })
    await waitFor(() => expect(lastSave(adapter).slides![1].title).toBe('Intro'))
    expect(adapter.saveCalls).toHaveLength(1)
    // Typing Delete in it removes no element.
    await act(async () => { field.focus(); fireEvent.keyDown(field, { key: 'Delete' }) })
    expect(adapter.saveCalls).toHaveLength(1)
    await act(async () => { field.blur() })
    await key('z', { metaKey: true })
    await waitFor(() => expect(lastSave(adapter).slides![1].title).toBeUndefined())
    expect((header('s1').getByRole('textbox', { name: 'Slide 2 title' }) as HTMLInputElement).value).toBe('')
  })

  it('Esc in the title field puts it back and writes nothing', async () => {
    const { adapter } = await mount(three())
    const field = header('s0').getByRole('textbox', { name: 'Slide 1 title' }) as HTMLInputElement
    await act(async () => { field.focus(); fireEvent.change(field, { target: { value: 'Nope' } }) })
    await act(async () => { fireEvent.keyDown(field, { key: 'Escape' }) })
    await act(async () => { fireEvent.blur(field) })
    expect(field.value).toBe('')
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('with no slides the canvas shows Add slide', async () => {
    const { adapter, r } = await mount(makeProject([slide(0)]))
    await act(async () => { fireEvent.click(header('s0').getByRole('button', { name: 'Delete slide' })) })
    // The editor puts a starter slide back the first time a project ends up empty (as before).
    await waitFor(() => expect(sections().map((s) => s.dataset.slideSection)).not.toContain('s0'))
    expect(sections()).toHaveLength(1)
    const starter = sections()[0].dataset.slideSection!
    await act(async () => { fireEvent.click(header(starter).getByRole('button', { name: 'Delete slide' })) })
    await waitFor(() => expect(lastSave(adapter).slides).toHaveLength(0))
    expect(sections()).toHaveLength(0)
    expect(r.queryByText(/Add one in the left panel/)).toBeNull()
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Add slide' })) })
    await waitFor(() => expect(lastSave(adapter).slides).toHaveLength(1))
    expect(sections()).toHaveLength(1)
  })

  it('Slides N / M scrolls to the slide picked; its list closes on Esc and on a press outside', async () => {
    const scrollTo = vi.fn()
    HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
    const { r } = await mount(three())
    section('s2').getBoundingClientRect = () => ({ top: 900, height: 0, left: 0, width: 0, bottom: 900, right: 0, x: 0, y: 900, toJSON: () => ({}) }) as DOMRect
    await act(async () => { fireEvent.click(counter(r)) })
    await act(async () => { fireEvent.click(r.getByRole('option', { name: 'Slide 3' })) })
    expect(counter(r).textContent).toContain('3 / 3')
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 900 }))

    await act(async () => { fireEvent.click(counter(r)) })
    expect(r.getByRole('listbox', { name: 'Slides' })).toBeTruthy()
    await key('Escape')
    expect(r.queryByRole('listbox', { name: 'Slides' })).toBeNull()

    await act(async () => { fireEvent.click(counter(r)) })
    await act(async () => { fireEvent.pointerDown(r.getByRole('banner', { name: 'Top bar' })) })
    expect(r.queryByRole('listbox', { name: 'Slides' })).toBeNull()
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it('the grid view shows every slide; drag reorders in one undo step; a click returns to the stack on that slide', async () => {
    const scrollTo = vi.fn()
    HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
    const { adapter, r } = await mount(three())
    const gridBtn = within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: 'Grid view' }) as HTMLButtonElement
    expect(gridBtn.disabled).toBe(false)
    await act(async () => { fireEvent.click(gridBtn) })
    expect(gridBtn.getAttribute('aria-pressed')).toBe('true')
    expect(sections()).toHaveLength(0)
    const grid = within(r.getByRole('region', { name: 'All slides' }))
    const tiles = () => grid.getAllByRole('button', { name: /^Slide \d$/ })
    expect(tiles()).toHaveLength(3)
    expect(Array.from(document.querySelectorAll('[data-grid-number]'), (n) => n.textContent)).toEqual(['1', '2', '3'])
    expect(grid.getByRole('button', { name: 'Add slide' })).toBeTruthy()

    await act(async () => {
      fireEvent.dragStart(tiles()[0])
      fireEvent.dragOver(tiles()[2])
      fireEvent.drop(tiles()[2])
      fireEvent.dragEnd(tiles()[0])
    })
    await waitFor(() => expect(slideIds(lastSave(adapter))).toEqual(['s1', 's2', 's0']))
    await key('z', { metaKey: true })
    await waitFor(() => expect(slideIds(lastSave(adapter))).toEqual(['s0', 's1', 's2']))

    await act(async () => { fireEvent.click(tiles()[2]) })
    expect(r.queryByRole('region', { name: 'All slides' })).toBeNull()
    expect(sections()).toHaveLength(3)
    expect(counter(r).textContent).toContain('3 / 3')
    expect(gridBtn.getAttribute('aria-pressed')).toBe('false')
    expect(scrollTo).toHaveBeenCalled()
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it('the grid add tile adds a slide at the end', async () => {
    const { adapter, r } = await mount(three())
    await act(async () => { fireEvent.click(within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: 'Grid view' })) })
    await act(async () => { fireEvent.click(within(r.getByRole('region', { name: 'All slides' })).getByRole('button', { name: 'Add slide' })) })
    await waitFor(() => expect(lastSave(adapter).slides).toHaveLength(4))
    expect(slideIds(lastSave(adapter)).slice(0, 3)).toEqual(['s0', 's1', 's2'])
  })

  it('classic layout has no stacked slides or slide headers', async () => {
    const adapter = makeAdapter(three())
    render(<CarouselEditor project={three()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('[data-slide-thumb="s0"]')).not.toBeNull())
    expect(sections()).toHaveLength(0)
    expect(document.querySelector('[data-slide-header]')).toBeNull()
  })
})
