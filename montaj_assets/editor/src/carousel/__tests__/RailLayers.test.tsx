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

  // The rows' places on screen: 40 px each, front first from y = 0. jsdom does no layout.
  const stubRows = () => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const i = rowIds().indexOf(this.dataset.layerId)
    const top = i * 40
    return { x: 0, y: top, left: 0, top, right: 200, bottom: top + 40, width: 200, height: 40, toJSON() {} } as DOMRect
  })
  // This jsdom has no PointerEvent, and fireEvent.pointer* drops clientX/Y: a
  // MouseEvent named for the pointer event carries them.
  const pointer = (target: EventTarget, type: string, clientY: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY, button: 0 }))
  /** A press on `id`'s name, a move to `toY` and a release there, then the click the browser sends when it ends on the same button. */
  async function dragRow(id: string, toY: number, { clickAfter = false } = {}) {
    const name = within(row(id)).getByRole('button', { name: /^Select/ })
    const y = rowIds().indexOf(id) * 40 + 20
    await act(async () => {
      pointer(name, 'pointerdown', y)
      pointer(window, 'pointermove', y + Math.sign(toY - y) * 6)
      pointer(window, 'pointermove', toY)
      pointer(window, 'pointerup', toY)
      if (clickAfter) fireEvent.click(name)
    })
  }

  it('a drag reorder is one save, through the stack, with a drop line while it moves', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Layers')
    stubRows()
    const before = adapter.saveCalls.length
    // Drag the front row (c) into the lower half of the back row (a): c becomes the back.
    const name = within(row('c')).getByRole('button', { name: /^Select/ })
    await act(async () => { pointer(name, 'pointerdown', 20); pointer(window, 'pointermove', 30); pointer(window, 'pointermove', 110) })
    expect(document.querySelector('[data-layer-drop-line]')?.closest('[data-layer-id]')?.getAttribute('data-layer-id')).toBe('a')
    expect(document.querySelector('[data-layer-drop-line]')?.getAttribute('data-layer-drop-line')).toBe('below')
    await act(async () => { pointer(window, 'pointerup', 110) })
    expect(document.querySelector('[data-layer-drop-line]')).toBeNull()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(elIds(lastSave(adapter))).toEqual(['c', 'a', 'b'])
  })

  it('rows are grab handles, not native drags', async () => {
    const { r } = await mount(base())
    await openRail(r, 'Layers')
    expect(row('c').style.cursor).toBe('grab')
    expect(row('c').getAttribute('draggable')).toBeNull()
  })

  it('a locked element reorders too', async () => {
    const { r, adapter } = await mount(makeProject([slide('s0', [img('a'), img('b', { locked: true }), img('c')])]))
    await openRail(r, 'Layers')
    stubRows()
    await dragRow('b', 2)
    await waitFor(() => expect(elIds(lastSave(adapter))).toEqual(['a', 'c', 'b']))
  })

  it('a drag of a selected row moves the whole selection', async () => {
    const { r, adapter } = await mount(makeProject([slide('s0', [img('a'), img('b'), img('c'), img('d')])]))
    await openRail(r, 'Layers')
    await act(async () => { fireEvent.click(within(row('d')).getByRole('button', { name: /^Select/ })) })
    await act(async () => { fireEvent.click(within(row('b')).getByRole('button', { name: /^Select/ }), { shiftKey: true }) })
    stubRows()
    // d, c, b, a on screen: d and b go below a, keeping their order.
    await dragRow('d', 150)
    await waitFor(() => expect(elIds(lastSave(adapter))).toEqual(['b', 'd', 'a', 'c']))
  })

  it('a press that does not move selects and saves nothing; a drag back to its own place saves and selects nothing', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Layers')
    stubRows()
    const before = adapter.saveCalls.length
    await dragRow('b', 32, { clickAfter: true })
    expect(within(row('b')).getByRole('button', { name: /^Select/ }).getAttribute('aria-pressed')).toBe('false')
    const name = within(row('b')).getByRole('button', { name: /^Select/ })
    await act(async () => { pointer(name, 'pointerdown', 60); pointer(window, 'pointermove', 61); pointer(window, 'pointerup', 61); fireEvent.click(name) })
    expect(name.getAttribute('aria-pressed')).toBe('true')
    expect(adapter.saveCalls.length).toBe(before)
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
  // In the rail the swatch opens the colour panel (§587 M5).
  const colourPanel = (r: Awaited<ReturnType<typeof mount>>['r']) => r.getByRole('region', { name: 'Colour panel' })
  it('a colour change writes once', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Background')
    const before = adapter.saveCalls.length
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Background color' })) })
    const hex = within(colourPanel(r)).getByRole('textbox', { name: 'Hex' }) as HTMLInputElement
    await act(async () => {
      fireEvent.change(hex, { target: { value: '#112233' } })
      fireEvent.keyDown(hex, { key: 'Enter' })
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(lastSave(adapter).slides![0].base_color).toBe('#112233')
  })

  it('a locked element selected: the slide colour still changes (the lock is the element\'s)', async () => {
    const { r, adapter } = await mount(makeProject([slide('s0', [img('a', { locked: true } as Partial<ImageElement>)])]))
    const w = document.querySelector<HTMLElement>('[data-element-id="a"]')!
    await act(async () => {
      w.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }))
      fireEvent.click(w)
    })
    expect(r.getByRole('toolbar', { name: 'Element' })).toBeTruthy()
    await openRail(r, 'Background')
    const before = adapter.saveCalls.length
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Background color' })) })
    const hex = within(colourPanel(r)).getByRole('textbox', { name: 'Hex' }) as HTMLInputElement
    expect(hex.disabled).toBe(false)
    await act(async () => {
      fireEvent.change(hex, { target: { value: '#112233' } })
      fireEvent.keyDown(hex, { key: 'Enter' })
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(lastSave(adapter).slides![0].base_color).toBe('#112233')
    expect(lastSave(adapter).slides![0].elements[0]).toMatchObject({ id: 'a', locked: true, x: 100 })
  })

  it('a panel closed with no pick writes nothing', async () => {
    const { r, adapter } = await mount(base())
    await openRail(r, 'Background')
    const before = adapter.saveCalls.length
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Background color' })) })
    await act(async () => { fireEvent.click(within(colourPanel(r)).getByRole('button', { name: 'Close' })) })
    expect(adapter.saveCalls.length).toBe(before)
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

  it('uses the real source size, in one save', async () => {
    const { loadImageNaturalSize } = await import('../imageGeometry')
    vi.mocked(loadImageNaturalSize).mockResolvedValueOnce({ width: 1000, height: 1000 })
    const p = makeProject([slide('s0', [img('a', { x: 50, y: 60, w: 400, h: 200 })])])
    const { r, adapter } = await mount(p)
    await openRail(r, 'Layers')
    await act(async () => { fireEvent.click(within(row('a')).getByRole('button', { name: /^Select/ })) })
    await openRail(r, 'Layers')
    await openRail(r, 'Background')
    const before = adapter.saveCalls.length
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Set image as background' })) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    // A 1:1 source on a 1080x1350 slide: all of the width, the middle 80% of the height... of a square: w 0.8 h 1.
    const el = lastSave(adapter).slides![0].elements[0] as ImageElement
    expect(el.crop!.h).toBeCloseTo(1)
    expect(el.crop!.w).toBeCloseTo(1080 / 1350)
  })

  it('setAsBackground is on the carousel api', async () => {
    let api: CarouselApi | null = null
    const { adapter } = await mount(makeProject([slide('s0', [txt('b', 'Hi'), img('a')])]), { onProvideCarouselApi: (a) => { api = a } })
    await act(async () => { api!.setAsBackground('a') })
    await waitFor(() => expect(lastSave(adapter).slides![0].elements[0]).toMatchObject({ id: 'a', locked: true, w: 1080 }))
  })
})

describe('setImageAsBackground', () => {
  const sq = { width: 1000, height: 1000 }
  it('an uncropped square source in a wide box becomes the whole square', () => {
    const out = setImageAsBackground([img('a', { w: 400, h: 200 })], 'a', 1000, 1000, sq)
    expect(out[0]).toMatchObject({ x: 0, y: 0, w: 1000, h: 1000, locked: true })
    const crop = (out[0] as ImageElement).crop
    expect(crop === undefined || (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1)).toBe(true)
  })
  it('a cropped image after a side resize centres on the part shown', () => {
    // 2000x1000 source, crop = its left half, box widened to 800x400: the picture
    // is drawn 1600x800 and the box shows the left half of its width, the middle
    // half of its height (shown crop {0, .25, .5, .5}).
    const el = img('a', { w: 800, h: 400, crop: { x: 0, y: 0, w: 0.5, h: 1 } })
    const out = setImageAsBackground([el], 'a', 1000, 1000, { width: 2000, height: 1000 })
    const crop = (out[0] as ImageElement).crop!
    expect(crop.w).toBeCloseTo(0.5)
    expect(crop.h).toBeCloseTo(1)
    // Centred on the shown part's x centre (0.25), clamped to the source.
    expect(crop.x).toBeCloseTo(0)
  })
  it('crops a wide image to the slide aspect around the visible part', () => {
    const out = setImageAsBackground([img('a', { w: 400, h: 200 })], 'a', 1000, 1000, { width: 2000, height: 1000 })
    const crop = (out[0] as ImageElement).crop!
    expect(crop.h).toBeCloseTo(1)
    expect(crop.w).toBeCloseTo(0.5)
    expect(crop.x).toBeCloseTo(0.25)
  })
  it('leaves a locked image alone', () => {
    const els = [img('a', { locked: true })]
    expect(setImageAsBackground(els, 'a', 1000, 1000, sq)).toBe(els)
  })
})
