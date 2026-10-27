import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { CarouselApi, CarouselEditorProps, EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import { FOOTAGE_DND_MIME, IMAGE_DND_MIME } from '../../types'
import CarouselEditor from '../CarouselEditor'
import SlideCanvas from '../SlideCanvas'
import { loadImageNaturalSize } from '../imageGeometry'

// ── Images onto the carousel canvas (§556 M7) ────────────────────────────────
//
// A drag from the host's Media panel (`IMAGE_DND_MIME`) or files from the OS,
// dropped on the canvas, and the host's `addImage`, each put an image on a
// slide shaped like the image (`placeImageBox`), in one undo step. "+ Upload
// Image" and AI images use the same shape. jsdom never loads an image, so the
// loader is mocked; the placement stays real, so the boxes asserted here are
// the ones the editor writes. jsdom has no `DragEvent` and lays nothing out:
// a MouseEvent named for the drag event carries the point, a stub carries the
// DataTransfer, and the canvas rect is pinned (as TimelineCanvas.drop.test does).

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn() }
})
const loadSize = vi.mocked(loadImageNaturalSize)

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: '1',
    id: 'proj-1',
    name: 'Test',
    workflow: 'carousel',
    status: 'draft',
    editingPrompt: '',
    projectType: 'carousel',
    settings: { resolution: [1080, 1350] },
    assets: [],
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [{ id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 }],
      },
      {
        id: 'slide-1',
        base_color: '#000000',
        elements: [{ id: 'el-s1', type: 'image', src: 'b.png', x: 50, y: 50, w: 100, h: 100, rotation: 0 }],
      },
    ],
    ...overrides,
  } as Project
}

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out.png' }
    },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async (file: File) => `/proj/assets/${file.name}`),
    fileUrl: (path: string) => path,
    saveCalls,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // A 2:1 image: on the 1080 x 1350 slide it is 864 x 432.
  loadSize.mockResolvedValue({ width: 2000, height: 1000 })
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  loadSize.mockReset()
})

// ── harness ──────────────────────────────────────────────────────────────────

function findInteractiveWrapper(elementId: string): HTMLElement {
  const els = document.querySelectorAll(`[data-element-id="${elementId}"]`)
  if (els.length === 0) throw new Error(`element wrapper ${elementId} not found`)
  return els[els.length - 1] as HTMLElement
}

/** The element's box in the canvas's chrome layer (§586 M4): its outline and handles; an empty box when it is not outlined. */
function chromeOf(elementId: string): HTMLElement {
  return (document.querySelector(`[data-chrome-for="${elementId}"]`) as HTMLElement | null) ?? document.createElement('div')
}

async function plainClick(id: string) {
  await act(async () => { fireEvent.click(findInteractiveWrapper(id)) })
}

async function key(k: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })
  await act(async () => { document.dispatchEvent(e) })
  return e
}

const undo = () => key('z', { metaKey: true })

function lastSave(adapter: FakeAdapter): Project {
  return adapter.saveCalls[adapter.saveCalls.length - 1].project
}

function elementsOf(p: Project, slide = 0) {
  return p.slides![slide].elements
}

function outlined(id: string): boolean {
  return chromeOf(id).style.outline.includes('solid')
}

function handlesOn(id: string): boolean {
  return chromeOf(id).querySelector('[data-testid="resize-handle-nw"]') !== null
}

// This jsdom has no PointerEvent: a MouseEvent named for the pointer event carries the point.
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

// jsdom never loads an image: give it a size and fire its load.
function loadImage(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(img)
}

function inCrop(id = 'el-img'): boolean {
  return chromeOf(id).querySelector('img[alt="Crop source"]') !== null
}

/** Crop mode on the selected el-img by its panel button, its source loaded as a
 *  400 x 200 image, and its window's right edge dragged in by 50 px of the slide
 *  (a quarter of the 200 wide box), so the window is {0, 0, 0.75, 1}. */
async function pickCrop(r: { getByTitle: (title: string) => HTMLElement }) {
  await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
  const source = chromeOf('el-img').querySelector<HTMLImageElement>('img[alt="Crop source"]')
  if (!source) throw new Error('el-img is not in crop mode')
  await act(async () => { loadImage(source, 400, 200) })
  const handle = chromeOf('el-img').querySelector('[data-testid="crop-handle-e"]') as HTMLElement
  const d = 50 * (parseFloat((document.querySelector('[data-interactive]') as HTMLElement).style.width) / 1080)
  await act(async () => {
    pointer(handle, 'pointerdown', { clientX: 0, clientY: 0 })
    pointer(handle, 'pointermove', { clientX: -d, clientY: 0 })
    pointer(handle, 'pointerup', { clientX: -d, clientY: 0 })
    // The click the browser sends after the release, to the handle that took the pointer.
    fireEvent.click(handle)
  })
}

async function selectSlide(id: string) {
  await act(async () => { fireEvent.click(document.querySelector(`[data-slide-thumb="${id}"]`) as HTMLElement) })
}

async function mount(adapter: FakeAdapter, project: Project = makeProject(), extra: Partial<CarouselEditorProps<Project>> = {}) {
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} {...extra} />)
  await waitFor(() => findInteractiveWrapper('el-img'))
  return r
}

/** The interactive canvas, with its rect pinned at (40, 20) and the scale the
 *  editor drew it at. `at(x, y)` is the client point over slide point (x, y). */
function pinCanvas() {
  const box = document.querySelector('[data-interactive]') as HTMLElement
  const boxW = parseFloat(box.style.width)
  const boxH = parseFloat(box.style.height)
  const left = 40
  const top = 20
  box.getBoundingClientRect = () =>
    ({ left, top, x: left, y: top, width: boxW, height: boxH, right: left + boxW, bottom: top + boxH, toJSON: () => ({}) }) as DOMRect
  const scale = boxW / 1080
  expect(scale).toBeGreaterThan(0)
  expect(scale).toBeLessThan(0.9)
  return { box, scale, at: (x: number, y: number) => ({ clientX: left + x * scale, clientY: top + y * scale }) }
}

interface FakeTransfer {
  types: string[]
  files: File[]
  dropEffect: string
  getData: (type: string) => string
  setData: () => void
}

/** A DataTransfer stub: `types` lists the entries and `Files` when there are
 *  files (override it to show a dragover, where the browser lists `Files` but
 *  has no files to hand over yet). */
function transfer(init: { entries?: Record<string, string>; files?: File[]; types?: string[] } = {}): FakeTransfer {
  const entries = init.entries ?? {}
  const files = init.files ?? []
  return {
    types: init.types ?? [...Object.keys(entries), ...(files.length > 0 ? ['Files'] : [])],
    files,
    dropEffect: 'none',
    getData: (type) => entries[type] ?? '',
    setData: () => {},
  }
}

const payload = (src: string, name?: string) => transfer({ entries: { [IMAGE_DND_MIME]: JSON.stringify({ src, name }) } })
const rawPayload = (raw: string) => transfer({ entries: { [IMAGE_DND_MIME]: raw } })
const png = (name: string) => new File(['x'], name, { type: 'image/png' })

function dragEvent(type: 'dragenter' | 'dragover' | 'drop', point: { clientX: number; clientY: number }, dataTransfer: unknown) {
  const e = new MouseEvent(type, { ...point, bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer })
  return e
}

async function fire(target: Element, e: Event) {
  await act(async () => { target.dispatchEvent(e) })
  return e
}

async function endHostDrag() {
  await act(async () => { document.body.dispatchEvent(new Event('dragend', { bubbles: true })) })
}

/** A drag begins in the page itself, as one from the host's Media panel does:
 *  only then is a host image (`IMAGE_DND_MIME`) believed. Any other page or app
 *  can put the same type on a drag. */
async function startHostDrag() {
  await act(async () => { document.body.dispatchEvent(new Event('dragstart', { bubbles: true })) })
}

// ── what the canvas takes ────────────────────────────────────────────────────

describe('Images on the canvas: which drags it claims', () => {
  it.each(['dragenter', 'dragover'] as const)('%s with a host image or with files is claimed, with a copy cursor', async (type) => {
    await mount(makeFakeAdapter())
    const { box, at } = pinCanvas()
    await startHostDrag()
    // On dragover the browser lists `Files` but has no files to read yet, and `getData` is empty.
    for (const dt of [rawPayload('{}'), transfer({ types: ['Files'] })]) {
      const e = await fire(box, dragEvent(type, at(540, 675), dt))
      expect(e.defaultPrevented).toBe(true)
      expect(dt.dropEffect).toBe('copy')
    }
  })

  it.each([
    ['a footage drag', { types: [FOOTAGE_DND_MIME] }],
    ['plain text', { types: ['text/plain'] }],
    ['a link', { types: ['text/uri-list', 'text/html'] }],
    ['a drag with nothing in it', { types: [] }],
  ])('%s is left alone', async (_name, init) => {
    await mount(makeFakeAdapter())
    const { box, at } = pinCanvas()
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      const dt = transfer(init)
      const e = await fire(box, dragEvent(type, at(540, 675), dt))
      expect(e.defaultPrevented).toBe(false)
      expect(dt.dropEffect).toBe('none')
    }
  })

  it('a footage drop adds nothing and uploads nothing', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ entries: { [FOOTAGE_DND_MIME]: JSON.stringify({ src: 'v.mp4', sourceDuration: 3 }) } })))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(loadSize).not.toHaveBeenCalled()
  })

  it('files are not claimed when the adapter cannot upload; a host image still is', async () => {
    const adapter = makeFakeAdapter()
    delete (adapter as { uploadFile?: unknown }).uploadFile
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()

    const files = transfer({ types: ['Files'] })
    const noFiles = await fire(box, dragEvent('dragover', at(540, 675), files))
    expect(noFiles.defaultPrevented).toBe(false)
    expect(files.dropEffect).toBe('none')

    const host = rawPayload('{}')
    const yesHost = await fire(box, dragEvent('dragover', at(540, 675), host))
    expect(yesHost.defaultPrevented).toBe(true)
    expect(host.dropEffect).toBe('copy')
  })

  it('nothing is claimed while the project cannot be edited, and a drop that arrives anyway changes nothing', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter, makeProject({ status: 'storyboard_ready' }))
    const { box, at } = pinCanvas()
    await startHostDrag()
    for (const mk of [() => payload('/media/pic.png'), () => transfer({ files: [png('a.png')] })]) {
      for (const type of ['dragenter', 'dragover'] as const) {
        const dt = mk()
        const e = await fire(box, dragEvent(type, at(540, 675), dt))
        expect(e.defaultPrevented).toBe(false)
        expect(dt.dropEffect).toBe('none')
      }
      // Kept from the browser, which would open a dropped file, but not taken.
      const drop = await fire(box, dragEvent('drop', at(540, 675), mk()))
      expect(drop.defaultPrevented).toBe(true)
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(loadSize).not.toHaveBeenCalled()
  })

  it('nothing is claimed in crop mode, and a drop that arrives anyway changes nothing', async () => {
    const adapter = makeFakeAdapter()
    const r = await mount(adapter)
    await plainClick('el-img')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    expect(chromeOf('el-img').querySelector('img[alt="Crop source"]')).not.toBeNull()
    const { box, at } = pinCanvas()
    await startHostDrag()

    for (const mk of [() => payload('/media/pic.png'), () => transfer({ files: [png('a.png')] })]) {
      for (const type of ['dragenter', 'dragover'] as const) {
        const dt = mk()
        const e = await fire(box, dragEvent(type, at(540, 675), dt))
        expect(e.defaultPrevented).toBe(false)
        expect(dt.dropEffect).toBe('none')
      }
      const drop = await fire(box, dragEvent('drop', at(540, 675), mk()))
      expect(drop.defaultPrevented).toBe(true)
    }
    await act(async () => { await new Promise((res) => setTimeout(res, 0)) })
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
    // The crop is still open.
    expect(chromeOf('el-img').querySelector('img[alt="Crop source"]')).not.toBeNull()
  })

  it('a slide thumbnail takes no drops', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const thumb = document.querySelector('[data-slide-thumb="slide-1"] [data-element-id="el-s1"]') as HTMLElement
    expect(thumb).not.toBeNull()
    await startHostDrag()
    await fire(thumb, dragEvent('drop', { clientX: 10, clientY: 10 }, payload('/media/pic.png')))
    await fire(thumb, dragEvent('drop', { clientX: 10, clientY: 10 }, transfer({ files: [png('a.png')] })))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })
})

describe('Images on the canvas: the slide rail', () => {
  const thumbOf = (id: string) => document.querySelector(`[data-slide-thumb="${id}"]`) as HTMLElement
  const lit = (el: HTMLElement) => el.className.includes('opacity-70')

  it('a host image or files crossing the rail are left alone: not claimed, and no thumbnail lights up (§556 review)', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    await startHostDrag()
    const thumb = thumbOf('slide-1')
    for (const dt of [payload('/media/pic.png'), transfer({ types: ['Files'] })]) {
      const e = await fire(thumb, dragEvent('dragover', { clientX: 10, clientY: 10 }, dt))
      expect(e.defaultPrevented).toBe(false)
    }
    expect(lit(thumb)).toBe(false)
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('a slide being dragged still lights up the thumbnail it is over, and the drop reorders and is kept from the browser', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const from = thumbOf('slide-0')
    const to = thumbOf('slide-1')

    await act(async () => { fireEvent.dragStart(from) })
    const over = await fire(to, new Event('dragover', { bubbles: true, cancelable: true }))
    expect(over.defaultPrevented).toBe(true)
    expect(lit(to)).toBe(true)

    const drop = await fire(to, new Event('drop', { bubbles: true, cancelable: true }))
    expect(drop.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).slides!.map((s) => s.id)).toEqual(['slide-1', 'slide-0'])
    expect(lit(thumbOf('slide-1'))).toBe(false)
  })
})

describe('Images on the canvas: SlideCanvas', () => {
  const slide = { id: 's', base_color: '#ffffff', elements: [] }

  it.each([
    [true, 1],
    [false, 0],
  ])('with interactive=%s the drag handlers are called %s time each', (interactive, calls) => {
    const handlers = { onDragEnter: vi.fn(), onDragOver: vi.fn(), onDrop: vi.fn() }
    const { container } = render(<SlideCanvas slide={slide} width={1080} height={1350} interactive={interactive} scale={0.5} {...handlers} />)
    const root = container.firstElementChild as HTMLElement
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      act(() => { root.dispatchEvent(dragEvent(type, { clientX: 1, clientY: 1 }, transfer())) })
    }
    expect(handlers.onDragEnter).toHaveBeenCalledTimes(calls)
    expect(handlers.onDragOver).toHaveBeenCalledTimes(calls)
    expect(handlers.onDrop).toHaveBeenCalledTimes(calls)
  })
})

// ── a host image dropped on the canvas ───────────────────────────────────────

describe('Images on the canvas: a drag from the host', () => {
  it('lands shaped like the image, centred on the drop, selected, and one undo takes it away', async () => {
    const adapter = makeFakeAdapter()
    const r = await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()

    const drop = await fire(box, dragEvent('drop', at(600, 700), payload('/media/pic.png', 'pic')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    // The desktop shell would otherwise open the dropped file.
    expect(drop.defaultPrevented).toBe(true)

    // The size was read through the adapter's URL for the new source.
    expect(loadSize).toHaveBeenCalledWith('/media/pic.png')
    // A 2000 x 1000 image on the 1080 x 1350 slide: 864 x 432, centred on (600, 700).
    const els = elementsOf(lastSave(adapter))
    expect(els).toHaveLength(2)
    expect(els[0].id).toBe('el-img')
    expect(els[1]).toEqual({ id: expect.any(String), type: 'image', src: '/media/pic.png', x: 168, y: 484, w: 864, h: 432, rotation: 0 })
    // Nothing was uploaded: the host's image is already on the host.
    expect(adapter.uploadFile).not.toHaveBeenCalled()

    // It is the selection: outlined, with handles and its panel; the old one is not.
    const id = els[1].id
    expect(outlined(id)).toBe(true)
    expect(handlesOn(id)).toBe(true)
    expect(outlined('el-img')).toBe(false)
    expect(r.getByTitle('/media/pic.png')).toBeTruthy()

    // One Cmd+Z takes it away, and there is no second step.
    const z = await undo()
    expect(z.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter)).map((e) => e.id)).toEqual(['el-img'])
    await undo()
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('a drop on top of an element still lands at the drop point', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { at } = pinCanvas()
    await startHostDrag()
    // (150, 150) is over el-img; the rect is read from the canvas, not the target.
    await fire(findInteractiveWrapper('el-img'), dragEvent('drop', at(600, 700), payload('/media/pic.png')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const els = elementsOf(lastSave(adapter))
    expect(els).toHaveLength(2)
    expect(els[0]).toMatchObject({ id: 'el-img', x: 100, y: 100, w: 200, h: 200 })
    expect(els[1]).toMatchObject({ src: '/media/pic.png', x: 168, y: 484, w: 864, h: 432 })
  })

  it('reads the size through resolveImageSrc, with the new source and no media id', async () => {
    const adapter = makeFakeAdapter()
    adapter.resolveImageSrc = (el) => (el.mediaId ? `media:${el.mediaId}` : `file:${el.src}`)
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    await fire(box, dragEvent('drop', at(540, 675), payload('/media/pic.png')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(loadSize).toHaveBeenCalledTimes(1)
    expect(loadSize).toHaveBeenCalledWith('file:/media/pic.png')
  })

  it('an image whose size cannot be read is the old centred square, on the drop point', async () => {
    loadSize.mockResolvedValue(null)
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    await fire(box, dragEvent('drop', at(600, 700), payload('/media/pic.png')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ x: 168, y: 268, w: 864, h: 864 })
  })

  it('a tall image is as tall as 80% of the slide, centred on the slide centre', async () => {
    loadSize.mockResolvedValue({ width: 1000, height: 2000 })
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    await fire(box, dragEvent('drop', at(540, 675), payload('/media/tall.png')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ x: 270, y: 135, w: 540, h: 1080 })
  })

  it('takes the point from the canvas rect and scale, wherever the canvas is on the page', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, scale } = pinCanvas()
    await startHostDrag()
    const rect = box.getBoundingClientRect()
    // Slide point (270, 1012.5), reached by client coordinates from the rect's corner.
    await fire(box, dragEvent('drop', { clientX: rect.left + 270 * scale, clientY: rect.top + 1012.5 * scale }, payload('/media/pic.png')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    // 864 x 432 centred on (270, 1012.5): x = -162, y = 796.5 rounds to 797 (or 796).
    const el = elementsOf(lastSave(adapter))[1]
    expect(el.x).toBe(-162)
    expect(Math.abs(el.y - 796.5)).toBeLessThanOrEqual(0.5)
    expect([el.w, el.h]).toEqual([864, 432])
  })

  it.each([
    ['not JSON', '{ not json'],
    ['no src', JSON.stringify({ name: 'pic' })],
    ['an empty src', JSON.stringify({ src: '' })],
    ['a src that is not text', JSON.stringify({ src: 5 })],
    ['null', 'null'],
    ['a bare string', '"/media/pic.png"'],
  ])('a payload that is %s adds nothing, and the drop is still kept from the browser', async (_name, raw) => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    const drop = await fire(box, dragEvent('drop', at(540, 675), rawPayload(raw)))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(drop.defaultPrevented).toBe(true)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(loadSize).not.toHaveBeenCalled()
  })

  it('the host image wins over files in the same drop, which are not uploaded', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    const dt = transfer({ entries: { [IMAGE_DND_MIME]: JSON.stringify({ src: '/media/pic.png' }) }, files: [png('other.png')] })
    await fire(box, dragEvent('drop', at(540, 675), dt))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(elementsOf(lastSave(adapter)).map((e) => (e as ImageElement).src)).toEqual(['a.png', '/media/pic.png'])
  })

  it('a malformed host payload falls back to the image files that came with it', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    const dt = transfer({ entries: { [IMAGE_DND_MIME]: '{ nope' }, files: [png('other.png')] })
    await fire(box, dragEvent('drop', at(540, 675), dt))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ src: '/proj/assets/other.png' })
  })
})

// ── a file dropped from Finder also joins the project's media (§587) ─────────

describe('Images on the canvas: files from Finder join project.assets', () => {
  it('two files: one save adds both assets and both elements, and one undo removes both', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a1.png'), png('b1.png')] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const saved = lastSave(adapter)
    expect(saved.assets).toEqual([
      { id: expect.any(String), src: '/proj/assets/a1.png', type: 'image', name: 'a1.png' },
      { id: expect.any(String), src: '/proj/assets/b1.png', type: 'image', name: 'b1.png' },
    ])
    expect(elementsOf(saved).map((e) => (e as ImageElement).src)).toEqual(['a.png', '/proj/assets/a1.png', '/proj/assets/b1.png'])
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(lastSave(adapter).assets).toEqual([])
    expect(elementsOf(lastSave(adapter)).map((e) => e.id)).toEqual(['el-img'])
    await undo()
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('the asset is named after the file it landed as (a de-dup suffix, a converted type), not the dropped file', async () => {
    const adapter = makeFakeAdapter()
    adapter.uploadFile = vi.fn(async (file: File) => (file.name === 'a1.png' ? '/proj/assets/a1-2.png' : 'C:\\proj\\assets\\b1.jpg'))
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a1.png'), png('b1.heic')] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).assets?.map((a) => a.name)).toEqual(['a1-2.png', 'b1.jpg'])
  })

  it('a file whose path already is an asset adds no duplicate', async () => {
    const adapter = makeFakeAdapter()
    const existing = { id: 'asset-1', src: '/proj/assets/a1.png', type: 'image' as const, name: 'a1.png' }
    await mount(adapter, makeProject({ assets: [existing] }))
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a1.png')] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).assets).toEqual([existing])
    expect(elementsOf(lastSave(adapter))).toHaveLength(2)
  })

  it('a Media-card drag adds no asset', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    await fire(box, dragEvent('drop', at(540, 675), payload('/media/pic.png', 'pic')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).assets).toEqual([])
  })
})

// ── only a drag that started in this page is a host image (§556 review) ─────
//
// Any page or app can put `IMAGE_DND_MIME` on a drag, and its `src` (a remote
// address, or any local path) would be stored in the project and fetched. So
// the payload is believed only while a drag that began in this document is
// under way: a dragstart sets it, a dragend or a drop clears it. Files from the
// OS are unaffected.

describe('Images on the canvas: only a drag that started in this page is a host image', () => {
  const foreign = () => payload('https://example.com/pic.png')

  it('the payload with no drag started in the page is not claimed on enter, over or drop, and adds, uploads and reads nothing', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()

    for (const type of ['dragenter', 'dragover'] as const) {
      const dt = foreign()
      const e = await fire(box, dragEvent(type, at(540, 675), dt))
      expect(e.defaultPrevented).toBe(false)
      expect(dt.dropEffect).toBe('none')
    }
    const drop = await fire(box, dragEvent('drop', at(540, 675), foreign()))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(drop.defaultPrevented).toBe(false)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(loadSize).not.toHaveBeenCalled()
  })

  it('after a dragstart in the page the same payload is claimed and added', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()

    const over = foreign()
    const e = await fire(box, dragEvent('dragover', at(540, 675), over))
    expect(e.defaultPrevented).toBe(true)
    expect(over.dropEffect).toBe('copy')
    const drop = await fire(box, dragEvent('drop', at(540, 675), foreign()))
    expect(drop.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(loadSize).toHaveBeenCalledWith('https://example.com/pic.png')
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ src: 'https://example.com/pic.png' })
  })

  it('the drag ending ends it: a payload dropped after the dragend is not claimed', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    await endHostDrag()

    const over = foreign()
    expect((await fire(box, dragEvent('dragover', at(540, 675), over))).defaultPrevented).toBe(false)
    const drop = await fire(box, dragEvent('drop', at(540, 675), foreign()))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(drop.defaultPrevented).toBe(false)
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('a dragstart that was cancelled starts no drag: the payload is not believed', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    // A draggable that cancels its own drag, as the note bubbles on the thumbnails do.
    const cancel = (e: Event) => e.preventDefault()
    document.body.addEventListener('dragstart', cancel)
    try {
      await act(async () => { document.body.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true })) })
    } finally {
      document.body.removeEventListener('dragstart', cancel)
    }

    const over = await fire(box, dragEvent('dragover', at(540, 675), foreign()))
    expect(over.defaultPrevented).toBe(false)
    const drop = await fire(box, dragEvent('drop', at(540, 675), foreign()))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(drop.defaultPrevented).toBe(false)
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(loadSize).not.toHaveBeenCalled()
  })

  it('a drop ends it too: the next payload needs a drag of its own', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await startHostDrag()
    await fire(box, dragEvent('drop', at(540, 675), payload('/media/one.png')))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))

    const second = await fire(box, dragEvent('drop', at(540, 675), payload('/media/two.png')))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(second.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(1)
    expect(loadSize).toHaveBeenCalledTimes(1)
  })

  it('files are taken with no drag in the page, and a host payload that came with them is ignored', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()

    const dt = transfer({ entries: { [IMAGE_DND_MIME]: JSON.stringify({ src: 'https://example.com/pic.png' }) }, files: [png('other.png')] })
    const over = await fire(box, dragEvent('dragover', at(540, 675), transfer({ types: [IMAGE_DND_MIME, 'Files'] })))
    expect(over.defaultPrevented).toBe(true)
    const drop = await fire(box, dragEvent('drop', at(540, 675), dt))
    expect(drop.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(adapter.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'other.png' }), 'proj-1', 'drop')
    expect(elementsOf(lastSave(adapter)).map((e) => (e as ImageElement).src)).toEqual(['a.png', '/proj/assets/other.png'])
    expect(loadSize).not.toHaveBeenCalledWith('https://example.com/pic.png')
  })
})

// ── files from the OS ────────────────────────────────────────────────────────

describe('Images on the canvas: files from the OS', () => {
  it('uploads each image into the project, adds them in ONE write, the next 20 px further down and right, and selects them', async () => {
    loadSize.mockResolvedValue({ width: 1000, height: 1000 })
    const adapter = makeFakeAdapter()
    const r = await mount(adapter)
    const { box, at } = pinCanvas()
    const a = png('a.png')
    const b = new File(['x'], 'b.jpg', { type: 'image/jpeg' })
    const notes = new File(['x'], 'notes.txt', { type: 'text/plain' })

    const drop = await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [a, notes, b] })))
    expect(drop.defaultPrevented).toBe(true)
    // Only the images, in order, with the project and where they came from.
    expect(adapter.uploadFile).toHaveBeenCalledTimes(2)
    expect(adapter.uploadFile).toHaveBeenNthCalledWith(1, a, 'proj-1', 'drop')
    expect(adapter.uploadFile).toHaveBeenNthCalledWith(2, b, 'proj-1', 'drop')

    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const els = elementsOf(lastSave(adapter))
    expect(els.map((e) => e.id)).toEqual(['el-img', els[1].id, els[2].id])
    expect(els[1]).toMatchObject({ type: 'image', src: '/proj/assets/a.png', x: 108, y: 243, w: 864, h: 864, rotation: 0 })
    expect(els[2]).toMatchObject({ type: 'image', src: '/proj/assets/b.jpg', x: 128, y: 263, w: 864, h: 864, rotation: 0 })
    expect(els[1].id).not.toBe(els[2].id)

    // Both are the selection, and nothing else is: the multi-selection panel, no handles.
    expect(outlined(els[1].id)).toBe(true)
    expect(outlined(els[2].id)).toBe(true)
    expect(outlined('el-img')).toBe(false)
    expect(handlesOn(els[1].id)).toBe(false)
    expect(r.queryByRole('group', { name: 'Align' })).not.toBeNull()

    // One Cmd+Z takes both away.
    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter)).map((e) => e.id)).toEqual(['el-img'])
    await undo()
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('one image file is placed on the drop point like a host image, shaped like it', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    const a = png('a.png')
    await fire(box, dragEvent('drop', at(600, 700), transfer({ files: [a] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(loadSize).toHaveBeenCalledWith('/proj/assets/a.png')
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ src: '/proj/assets/a.png', x: 168, y: 484, w: 864, h: 432 })
    expect(adapter.uploadFile).toHaveBeenCalledWith(a, 'proj-1', 'drop')
  })

  it('each image is shaped like itself', async () => {
    loadSize.mockImplementation(async (url) => (url.endsWith('wide.png') ? { width: 2000, height: 1000 } : { width: 1000, height: 2000 }))
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('wide.png'), png('tall.png')] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const els = elementsOf(lastSave(adapter))
    expect(els[1]).toMatchObject({ x: 108, y: 459, w: 864, h: 432 })
    expect(els[2]).toMatchObject({ x: 290, y: 155, w: 540, h: 1080 })
  })

  it('files that are not images upload nothing and add nothing, but are still kept from the browser', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    const files = [new File(['x'], 'notes.txt', { type: 'text/plain' }), new File(['x'], 'clip.mp4', { type: 'video/mp4' }), new File(['x'], 'mystery', { type: '' })]
    const drop = await fire(box, dragEvent('drop', at(540, 675), transfer({ files })))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(drop.defaultPrevented).toBe(true)
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('a PSD file is ignored: the canvas cannot draw it, and it would land as an empty square (§556 review)', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    const drop = await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [new File(['x'], 'photo.psd', { type: 'image/vnd.adobe.photoshop' })] })))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // Still kept from the browser, which would open it.
    expect(drop.defaultPrevented).toBe(true)
    expect(adapter.uploadFile).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/bmp'])('a %s file is taken', async (type) => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    const file = new File(['x'], 'pic.bin', { type })
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [file] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(adapter.uploadFile).toHaveBeenCalledWith(file, 'proj-1', 'drop')
  })

  // §568: the upload stores these as a JPEG with their colour profile and answers that, so they are taken like the rest.
  it.each([
    ['HEIC', 'photo.heic', 'image/heic'],
    ['HEIF', 'photo.heif', 'image/heif'],
    ['TIFF', 'scan.tiff', 'image/tiff'],
    ['HEIC with no type (a browser that does not know it)', 'IMG_0001.HEIC', ''],
    ['TIF with no type', 'scan.tif', ''],
  ])('a %s file is uploaded, and what the upload answers is placed', async (_name, name, type) => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    const file = new File(['x'], name, { type })
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [file] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(adapter.uploadFile).toHaveBeenCalledWith(file, 'proj-1', 'drop')
  })

  it('a file with no type and no image name is still ignored', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [new File(['x'], 'photo.heic.txt', { type: '' })] })))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(adapter.uploadFile).not.toHaveBeenCalled()
  })

  it('among several files only the ones it can draw or convert are uploaded', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    const { box, at } = pinCanvas()
    const psd = new File(['x'], 'a.psd', { type: 'image/vnd.adobe.photoshop' })
    const jpg = new File(['x'], 'b.jpg', { type: 'image/jpeg' })
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [psd, jpg] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(adapter.uploadFile).toHaveBeenCalledTimes(1)
    expect(adapter.uploadFile).toHaveBeenCalledWith(jpg, 'proj-1', 'drop')
    expect(elementsOf(lastSave(adapter)).map((e) => (e as ImageElement).src)).toEqual(['a.png', '/proj/assets/b.jpg'])
  })

  it('an upload that fails goes to onError, never alert, and adds nothing', async () => {
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    const onError = vi.fn()
    await mount(adapter, makeProject(), { onError })
    const { box, at } = pinCanvas()

    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a.png')] })))
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError).toHaveBeenCalledWith({ title: "Couldn't add the image", detail: 'disk full' })
    expect(alertSpy).not.toHaveBeenCalled()

    // Nothing measured, written or left to undo.
    expect(loadSize).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
    await undo()
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('without onError a failed upload is logged to the console', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValue('quota')
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a.png')] })))
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))
    expect(errorSpy.mock.calls[0][0]).toContain("Couldn't add the image: quota")
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('one failed upload among several is reported once and the others are still added, in one write', async () => {
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(async (file: File) => {
      if (file.name === 'bad.png') throw new Error('too big')
      return `/proj/assets/${file.name}`
    })
    loadSize.mockResolvedValue({ width: 1000, height: 1000 })
    const onError = vi.fn()
    await mount(adapter, makeProject(), { onError })
    const { box, at } = pinCanvas()

    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('good.png'), png('bad.png'), png('ok.png')] })))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith({ title: "Couldn't add the image", detail: 'too big' })
    // The two that went up, the second 20 px past the first (not 40).
    const els = elementsOf(lastSave(adapter))
    expect(els.map((e) => (e as ImageElement).src)).toEqual(['a.png', '/proj/assets/good.png', '/proj/assets/ok.png'])
    expect([els[1].x, els[1].y, els[2].x, els[2].y]).toEqual([108, 243, 128, 263])
  })

  it('lands on the slide it was dropped on, and leaves the selection on the slide the user went to', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a.png')] })))

    // While it uploads, the user goes to the second slide and selects its image.
    await selectSlide('slide-1')
    await plainClick('el-s1')
    expect(outlined('el-s1')).toBe(true)

    await act(async () => { gate.resolve('/proj/assets/a.png') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const saved = lastSave(adapter)
    expect(elementsOf(saved, 0).map((e) => (e as ImageElement).src)).toEqual(['a.png', '/proj/assets/a.png'])
    expect(elementsOf(saved, 1).map((e) => e.id)).toEqual(['el-s1'])
    // The user's selection stays.
    expect(outlined('el-s1')).toBe(true)
    expect(handlesOn('el-s1')).toBe(true)
  })

  it('adds onto the elements the slide has when the uploads land: one an outside writer added meanwhile is kept (§556 review)', async () => {
    const gates = [deferred<string>(), deferred<string>()]
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation((file: File) => gates[file.name === 'a.png' ? 0 : 1].promise)
    let push: ((p: Project) => void) | undefined
    adapter.subscribe = (_id, onFrame) => {
      push = onFrame
      return () => {}
    }
    await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a.png'), png('b.png')] })))

    // The uploads land and an outside writer's element arrives in the same tick,
    // before the editor has drawn it.
    const base = makeProject()
    const ai = { id: 'el-ai', type: 'image', src: 'ai.png', x: 40, y: 40, w: 100, h: 100, rotation: 0 } as const
    await act(async () => {
      push!({ ...base, slides: [{ ...base.slides![0], elements: [...base.slides![0].elements, ai] }, base.slides![1]] })
      gates[0].resolve('/proj/assets/a.png')
      gates[1].resolve('/proj/assets/b.png')
      // The whole add is microtasks; the editor draws again when this scope ends.
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter)).map((e) => (e as ImageElement).src)).toEqual(['a.png', 'ai.png', '/proj/assets/a.png', '/proj/assets/b.png'])
  })

  describe('while the person crops', () => {
    // jsdom has no pointer capture; the crop window and its handles take the pointer.
    const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
    beforeEach(() => {
      Element.prototype.setPointerCapture = vi.fn()
    })
    afterEach(() => {
      if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
      else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
    })

    it('an add that lands in crop mode is written but does not take the selection: Esc then writes the crop, as one undo step (§556 review)', async () => {
      const gate = deferred<string>()
      const adapter = makeFakeAdapter()
      ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
      const r = await mount(adapter)
      const { box, at } = pinCanvas()
      await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a.png')] })))

      // While it uploads, the person crops el-img.
      await plainClick('el-img')
      await pickCrop(r)
      expect(inCrop()).toBe(true)

      await act(async () => { gate.resolve('/proj/assets/a.png') })
      await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
      const els = elementsOf(lastSave(adapter))
      expect(els.map((e) => (e as ImageElement).src)).toEqual(['a.png', '/proj/assets/a.png'])

      // The selection and crop mode stayed with el-img.
      expect(inCrop()).toBe(true)
      expect(outlined('el-img')).toBe(true)
      expect(outlined(els[1].id)).toBe(false)
      expect(handlesOn(els[1].id)).toBe(false)

      // Esc applies the window picked; the box shrinks to the kept part at the picture's scale (§586 M3a).
      await key('Escape')
      await waitFor(() => expect((elementsOf(lastSave(adapter))[0] as ImageElement).crop).toBeDefined())
      const cropped = elementsOf(lastSave(adapter))[0] as ImageElement
      expect([cropped.x, cropped.y, cropped.w, cropped.h]).toEqual([100, 150, 150, 100])
      expect(cropped.crop!.w).toBeCloseTo(0.75, 9)
      expect(inCrop()).toBe(false)
      expect(outlined('el-img')).toBe(true)
      expect(handlesOn('el-img')).toBe(true)
      expect(outlined(els[1].id)).toBe(false)

      // The crop is one undo step, then the image added is the next, then nothing.
      await undo()
      await waitFor(() => expect((elementsOf(lastSave(adapter))[0] as ImageElement).crop).toBeUndefined())
      expect(elementsOf(lastSave(adapter)).map((e) => e.id)).toEqual(['el-img', els[1].id])
      expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ w: 200, h: 200 })
      await undo()
      await waitFor(() => expect(elementsOf(lastSave(adapter)).map((e) => e.id)).toEqual(['el-img']))
      const saves = adapter.saveCalls.length
      await undo()
      expect(adapter.saveCalls).toHaveLength(saves)
    })
  })

  it('writes nothing when the slide is deleted meanwhile', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    const onError = vi.fn()
    await mount(adapter, makeProject(), { onError })
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a.png')] })))

    const del = document.querySelector('[data-slide-thumb="slide-0"] button[title="Delete slide"]') as HTMLElement
    await act(async () => { fireEvent.click(del) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))

    await act(async () => { gate.resolve('/proj/assets/a.png'); await new Promise((r) => setTimeout(r, 0)) })
    expect(adapter.saveCalls).toHaveLength(1)
    expect(lastSave(adapter).slides!.map((s) => s.id)).toEqual(['slide-1'])
    expect(onError).not.toHaveBeenCalled()
  })

  it('writes nothing once the editor is gone', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    const r = await mount(adapter)
    const { box, at } = pinCanvas()
    await fire(box, dragEvent('drop', at(540, 675), transfer({ files: [png('a.png')] })))

    r.unmount()
    await act(async () => { gate.resolve('/proj/assets/a.png'); await new Promise((res) => setTimeout(res, 0)) })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('the drop is its own undo step, apart from a nudge still open when it lands', async () => {
    const adapter = makeFakeAdapter()
    await mount(adapter)
    await plainClick('el-img')
    // An arrow press opens a nudge burst: on screen, not yet saved.
    await key('ArrowRight')
    expect(adapter.saveCalls).toHaveLength(0)

    const { box, at } = pinCanvas()
    await startHostDrag()
    await fire(box, dragEvent('drop', at(540, 675), payload('/media/pic.png')))
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThanOrEqual(2))
    // The nudge was saved as its own step, then the drop.
    expect(elementsOf(adapter.saveCalls[0].project)[0]).toMatchObject({ id: 'el-img', x: 101 })
    expect(elementsOf(lastSave(adapter))).toHaveLength(2)

    // The first Cmd+Z takes back the drop only: the nudge stays.
    await undo()
    await waitFor(() => expect(elementsOf(lastSave(adapter))).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[0]).toMatchObject({ id: 'el-img', x: 101 })
  })
})

// ── the host's addImage ──────────────────────────────────────────────────────

describe('Images on the canvas: the host API', () => {
  async function mountWithApi(adapter: FakeAdapter, project: Project = makeProject()) {
    const provide = vi.fn()
    const r = await mount(adapter, project, { onProvideCarouselApi: provide })
    const api = () => provide.mock.calls[0][0] as CarouselApi
    return { r, provide, api }
  }

  it('is handed up once, stays the same through edits, and is withdrawn with null on unmount', async () => {
    const adapter = makeFakeAdapter()
    const { r, provide, api } = await mountWithApi(adapter)
    expect(provide).toHaveBeenCalledTimes(1)
    expect(typeof api().addImage).toBe('function')

    await act(async () => { await api().addImage('/media/pic.png') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await key('ArrowRight')
    await undo()
    expect(provide).toHaveBeenCalledTimes(1)

    r.unmount()
    expect(provide).toHaveBeenCalledTimes(2)
    expect(provide.mock.calls[1][0]).toBeNull()
  })

  it('addImage puts the image on the selected slide, centred, shaped like it, selected, in one undo step', async () => {
    const adapter = makeFakeAdapter()
    const { api } = await mountWithApi(adapter)
    await selectSlide('slide-1')

    await act(async () => { await api().addImage('/media/pic.png') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(loadSize).toHaveBeenCalledWith('/media/pic.png')
    const saved = lastSave(adapter)
    // The other slide is untouched.
    expect(elementsOf(saved, 0).map((e) => e.id)).toEqual(['el-img'])
    const els = elementsOf(saved, 1)
    expect(els).toHaveLength(2)
    expect(els[0].id).toBe('el-s1')
    expect(els[1]).toEqual({ id: expect.any(String), type: 'image', src: '/media/pic.png', x: 108, y: 459, w: 864, h: 432, rotation: 0 })
    expect(adapter.uploadFile).not.toHaveBeenCalled()

    expect(outlined(els[1].id)).toBe(true)
    expect(handlesOn(els[1].id)).toBe(true)
    expect(outlined('el-s1')).toBe(false)

    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter), 1).map((e) => e.id)).toEqual(['el-s1'])
    await undo()
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('addImage uses the slide selected when it is called, with the current state', async () => {
    const adapter = makeFakeAdapter()
    const { api } = await mountWithApi(adapter)
    // The api object came up at mount, with slide 1 selected; call it after the user moved on.
    await selectSlide('slide-1')
    await selectSlide('slide-0')
    await act(async () => { await api().addImage('/media/pic.png') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter), 0)).toHaveLength(2)
    expect(elementsOf(lastSave(adapter), 1)).toHaveLength(1)
  })

  it('an image whose size cannot be read is the old centred square', async () => {
    loadSize.mockResolvedValue(null)
    const adapter = makeFakeAdapter()
    const { api } = await mountWithApi(adapter)
    await act(async () => { await api().addImage('/media/pic.png') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ x: 108, y: 243, w: 864, h: 864 })
  })

  it('does nothing with no selected slide', async () => {
    const adapter = makeFakeAdapter()
    const provide = vi.fn()
    render(<CarouselEditor project={makeProject({ status: 'pending', slides: [] })} adapter={adapter} onProjectChange={vi.fn()} onProvideCarouselApi={provide} />)
    expect(document.querySelector('[data-interactive]')).toBeNull()
    expect(provide).toHaveBeenCalledTimes(1)

    await act(async () => { await (provide.mock.calls[0][0] as CarouselApi).addImage('/media/pic.png') })
    expect(loadSize).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('does nothing while the project cannot be edited', async () => {
    const adapter = makeFakeAdapter()
    const { api } = await mountWithApi(adapter, makeProject({ status: 'storyboard_ready' }))
    await act(async () => { await api().addImage('/media/pic.png') })
    expect(loadSize).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('does nothing in crop mode, where the image being cropped keeps the selection', async () => {
    const adapter = makeFakeAdapter()
    const { r, api } = await mountWithApi(adapter)
    await plainClick('el-img')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    await act(async () => { await api().addImage('/media/pic.png') })
    expect(loadSize).not.toHaveBeenCalled()
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('addImage resolves true when it added and false when it did nothing', async () => {
    const adapter = makeFakeAdapter()
    const { api } = await mountWithApi(adapter)
    await selectSlide('slide-1')
    await act(async () => { expect(await api().addImage('/media/pic.png')).toBe(true) })
    const ro = await mountWithApi(makeFakeAdapter(), makeProject({ status: 'storyboard_ready' }))
    await act(async () => { expect(await ro.api().addImage('/media/pic.png')).toBe(false) })
  })

  it('canAddImage is ok on a selected slide and names the reason otherwise, agreeing with addImage', async () => {
    const adapter = makeFakeAdapter()
    const { r, api } = await mountWithApi(adapter)
    await selectSlide('slide-1')
    expect(api().canAddImage()).toEqual({ ok: true })
    await selectSlide('slide-0')
    await plainClick('el-img')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    expect(api().canAddImage()).toEqual({ ok: false, reason: 'crop' })
    await act(async () => { expect(await api().addImage('/media/pic.png')).toBe(false) })
  })

  it('canAddImage says read-only for a project that cannot be edited or is pending', async () => {
    const ro = await mountWithApi(makeFakeAdapter(), makeProject({ status: 'storyboard_ready' }))
    expect(ro.api().canAddImage()).toEqual({ ok: false, reason: 'read-only' })
    const provide = vi.fn()
    render(<CarouselEditor project={makeProject({ status: 'pending', slides: [] })} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} onProvideCarouselApi={provide} />)
    const pending = provide.mock.calls[0][0] as CarouselApi
    expect(pending.canAddImage()).toEqual({ ok: false, reason: 'read-only' })
    expect(await pending.addImage('/media/pic.png')).toBe(false)
  })

  it('writes nothing once the editor is gone', async () => {
    const gate = deferred<{ width: number; height: number } | null>()
    loadSize.mockImplementation(() => gate.promise)
    const adapter = makeFakeAdapter()
    const { r, api } = await mountWithApi(adapter)
    const added = api().addImage('/media/pic.png')
    r.unmount()
    await act(async () => { gate.resolve({ width: 100, height: 100 }); await added })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('a save that fails does not leave addImage rejecting', async () => {
    const adapter = makeFakeAdapter()
    ;(adapter.saveProject as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('HTTP 500') })
    const { r, api } = await mountWithApi(adapter)
    await act(async () => { await expect(api().addImage('/media/pic.png')).resolves.toBe(true) })
    // The save error is the editor's own, shown once.
    await waitFor(() => expect(r.getByText('HTTP 500')).toBeTruthy())
  })
})

// ── "+ Upload Image" and AI images ───────────────────────────────────────────

describe('Images on the canvas: the Add menu', () => {
  function uploadInput(r: ReturnType<typeof render>): HTMLInputElement {
    return r.getByText('+ Upload Image').nextElementSibling as HTMLInputElement
  }

  async function pick(r: ReturnType<typeof render>, file: File) {
    await act(async () => { fireEvent.change(uploadInput(r), { target: { files: [file] } }) })
  }

  it('+ Upload Image adds an image shaped like the file, centred, and selected', async () => {
    const adapter = makeFakeAdapter()
    const r = await mount(adapter)
    const file = png('up.png')

    await pick(r, file)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    // No project (a shared upload, as it was), and the host is told it came from a file picker.
    expect(adapter.uploadFile).toHaveBeenCalledTimes(1)
    expect(adapter.uploadFile).toHaveBeenCalledWith(file, undefined, 'picker')
    expect(loadSize).toHaveBeenCalledWith('/proj/assets/up.png')
    const els = elementsOf(lastSave(adapter))
    expect(els[1]).toEqual({ id: expect.any(String), type: 'image', src: '/proj/assets/up.png', x: 108, y: 459, w: 864, h: 432, rotation: 0 })
    expect(outlined(els[1].id)).toBe(true)

    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(lastSave(adapter)).map((e) => e.id)).toEqual(['el-img'])
  })

  it('+ Upload Image that lands after the person went to another slide is added to its own slide and leaves their selection alone (§556 review)', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    const r = await mount(adapter)
    await pick(r, png('up.png'))

    // While it uploads, the person goes to the second slide and selects its image.
    await selectSlide('slide-1')
    await plainClick('el-s1')
    expect(outlined('el-s1')).toBe(true)

    await act(async () => { gate.resolve('/proj/assets/up.png') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const saved = lastSave(adapter)
    expect(elementsOf(saved, 0).map((e) => (e as ImageElement).src)).toEqual(['a.png', '/proj/assets/up.png'])
    expect(elementsOf(saved, 1).map((e) => e.id)).toEqual(['el-s1'])
    // Their selection stays.
    expect(outlined('el-s1')).toBe(true)
    expect(handlesOn('el-s1')).toBe(true)
  })

  it('and a crop the person has open on that other slide is left open', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    const r = await mount(adapter)
    await pick(r, png('up.png'))
    await selectSlide('slide-1')
    await plainClick('el-s1')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    expect(inCrop('el-s1')).toBe(true)

    await act(async () => { gate.resolve('/proj/assets/up.png') })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter), 0)).toHaveLength(2)
    expect(inCrop('el-s1')).toBe(true)
    expect(outlined('el-s1')).toBe(true)
  })

  it('+ Upload Image with an unreadable size keeps the old square', async () => {
    loadSize.mockResolvedValue(null)
    const adapter = makeFakeAdapter()
    const r = await mount(adapter)
    await pick(r, png('up.png'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ x: 108, y: 243, w: 864, h: 864 })
  })

  it('+ Upload Image fitting a tall image', async () => {
    loadSize.mockResolvedValue({ width: 1000, height: 2000 })
    const adapter = makeFakeAdapter()
    const r = await mount(adapter)
    await pick(r, png('up.png'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ x: 270, y: 135, w: 540, h: 1080 })
  })

  it('a failed upload is still shown under the button, and adds nothing', async () => {
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'))
    const r = await mount(adapter)
    await pick(r, png('up.png'))
    await waitFor(() => expect(r.getByText('nope')).toBeTruthy())
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('an AI image is shaped like the generated file, centred, and selected', async () => {
    loadSize.mockResolvedValue({ width: 1000, height: 2000 })
    const adapter = makeFakeAdapter()
    adapter.generateImage = vi.fn(async () => ({ path: '/gen/cat.png' }))
    const r = await mount(adapter)

    await act(async () => { fireEvent.click(r.getByText('+ AI Image')) })
    await act(async () => { fireEvent.change(r.getByLabelText('Describe the image to generate'), { target: { value: 'a cat' } }) })
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Generate' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))

    expect(adapter.generateImage).toHaveBeenCalledWith('a cat', 'proj-1')
    expect(loadSize).toHaveBeenCalledWith('/gen/cat.png')
    const els = elementsOf(lastSave(adapter))
    expect(els[1]).toEqual({ id: expect.any(String), type: 'image', src: '/gen/cat.png', x: 270, y: 135, w: 540, h: 1080, rotation: 0 })
    expect(outlined(els[1].id)).toBe(true)
    // The prompt box closes.
    expect(r.queryByLabelText('Describe the image to generate')).toBeNull()
  })

  it('an AI image with an unreadable size keeps the old square', async () => {
    loadSize.mockResolvedValue(null)
    const adapter = makeFakeAdapter()
    adapter.generateImage = vi.fn(async () => ({ path: '/gen/cat.png' }))
    const r = await mount(adapter)

    await act(async () => { fireEvent.click(r.getByText('+ AI Image')) })
    await act(async () => { fireEvent.change(r.getByLabelText('Describe the image to generate'), { target: { value: 'a cat' } }) })
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Generate' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(lastSave(adapter))[1]).toMatchObject({ x: 108, y: 243, w: 864, h: 864 })
  })
})
