import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'

// §587 M6: the rail layout's zoom (slider, % menu, keys).

// jsdom never loads an image, so a real size read would wait out its timeout.
vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

function slide(i: number, elements: Slide['elements'] = []): Slide {
  return { id: `s${i}`, base_color: '#ffffff', elements }
}
const img = (id: string, x = 100, y = 100): ImageElement => ({ id, type: 'image', src: `${id}.png`, x, y, w: 200, h: 200, rotation: 0 })

function makeProject1(slides: Slide[]): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [], slides,
  } as Project
}

/** Three slides, each with one image: el-0, el-1, el-2. */
function makeProject(): Project { return makeProject1([slide(0, [img('el-0')])]) }

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

async function mount(project: Project, layout: 'rail' | 'classic' = 'rail') {
  const adapter = makeAdapter(project)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout={layout} />)
  await waitFor(() => expect(document.querySelectorAll('[data-element-id]').length).toBeGreaterThan(0))
  return { adapter, r }
}
const bar = (r: ReturnType<typeof render>) => within(r.getByRole('contentinfo', { name: 'Bottom bar' }))
const pct = (r: ReturnType<typeof render>) => bar(r).getByRole('button', { name: /^Zoom level/ })
const slider = (r: ReturnType<typeof render>) => bar(r).getByRole('slider', { name: 'Zoom' }) as HTMLInputElement
async function menu(r: ReturnType<typeof render>, item: string) {
  await act(async () => { fireEvent.click(pct(r)) })
  await act(async () => { fireEvent.click(r.getByRole('menuitem', { name: new RegExp(`^${item}`) })) })
}
async function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })) })
}
const canvasRoot = () => document.querySelector<HTMLElement>('[data-interactive]')!
const widthPx = () => parseFloat(canvasRoot().style.width)
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

describe('CarouselEditor layout="rail": zoom (§587 M6)', () => {
  it('starts at Fit, which is today\'s fit-to-width scale', async () => {
    const { r } = await mount(makeProject())
    expect(pct(r).textContent).toBe('Fit')
    // The default 600 px view leaves 520 px for a 1080 px slide.
    expect(widthPx()).toBeCloseTo(520, 0)
    expect(Number(slider(r).value)).toBe(Math.round((520 / 1080) * 100))
  })

  it('the menu sets 100%, 200%, Fill and Fit, and the label follows', async () => {
    const { r } = await mount(makeProject())
    await menu(r, '100%')
    expect(pct(r).textContent).toBe('100%')
    expect(widthPx()).toBeCloseTo(1080, 0)
    await menu(r, '200%')
    expect(pct(r).textContent).toBe('200%')
    expect(widthPx()).toBeCloseTo(2160, 0)
    expect(slider(r).value).toBe('200')
    await menu(r, 'Fill')
    expect(pct(r).textContent).toBe('Fill')
    // Fill is fit-to-height: 700 - 80 = 620 px tall slide, at least the fit width.
    expect(widthPx()).toBeCloseTo(620, 0)
    await menu(r, 'Fit')
    expect(pct(r).textContent).toBe('Fit')
    expect(widthPx()).toBeCloseTo(520, 0)
  })

  it('the menu lists its keys and Esc closes it', async () => {
    const { r } = await mount(makeProject())
    await act(async () => { fireEvent.click(pct(r)) })
    const items = within(r.getByRole('menu', { name: 'Zoom' })).getAllByRole('menuitem').map((b) => b.textContent)
    expect(items).toHaveLength(6)
    expect(items[0]).toMatch(/^Zoom in/)
    expect(items.join('|')).toMatch(/Fit.*0/)
    await key('Escape')
    expect(r.queryByRole('menu', { name: 'Zoom' })).toBeNull()
  })

  it('the slider sets a percentage', async () => {
    const { r } = await mount(makeProject())
    await act(async () => { fireEvent.change(slider(r), { target: { value: '150' } }) })
    expect(pct(r).textContent).toBe('150%')
    expect(widthPx()).toBeCloseTo(1620, 0)
  })

  it('zoom in and zoom out step through the levels', async () => {
    const { r } = await mount(makeProject())
    // Fit is 48%: in goes to 50, 75, 100, 150; out comes back down.
    await menu(r, 'Zoom in')
    expect(pct(r).textContent).toBe('50%')
    await menu(r, 'Zoom in')
    expect(pct(r).textContent).toBe('75%')
    await menu(r, 'Zoom in')
    expect(pct(r).textContent).toBe('100%')
    await menu(r, 'Zoom in')
    expect(pct(r).textContent).toBe('150%')
    await menu(r, 'Zoom out')
    expect(pct(r).textContent).toBe('100%')
    await menu(r, 'Zoom out')
    expect(pct(r).textContent).toBe('75%')
  })

  it('stops at the ends', async () => {
    const { r } = await mount(makeProject())
    for (let i = 0; i < 10; i++) await key('=', { metaKey: true })
    expect(pct(r).textContent).toBe('300%')
    for (let i = 0; i < 12; i++) await key('-', { metaKey: true })
    expect(pct(r).textContent).toBe('10%')
  })

  it('Cmd+0, Cmd+1, Cmd+= , Cmd++ and Cmd+- work (Ctrl too)', async () => {
    const { r } = await mount(makeProject())
    await key('1', { metaKey: true })
    expect(pct(r).textContent).toBe('100%')
    await key('=', { metaKey: true })
    expect(pct(r).textContent).toBe('150%')
    await key('+', { metaKey: true, shiftKey: true })
    expect(pct(r).textContent).toBe('200%')
    await key('-', { ctrlKey: true })
    expect(pct(r).textContent).toBe('150%')
    await key('0', { metaKey: true })
    expect(pct(r).textContent).toBe('Fit')
    // No modifier: nothing.
    await key('1')
    expect(pct(r).textContent).toBe('Fit')
  })

  it('the keys do not fire while typing', async () => {
    const { r } = await mount(makeProject())
    const input = document.createElement('input')
    document.body.appendChild(input)
    await key('1', { metaKey: true }, input)
    await key('=', { metaKey: true }, input)
    expect(pct(r).textContent).toBe('Fit')
    input.remove()
  })

  it('the canvas area scrolls both ways when zoomed past fit', async () => {
    const { r } = await mount(makeProject())
    await menu(r, '200%')
    const stack = r.container.querySelector<HTMLElement>('[data-slide-stack]')!
    expect(stack.className).toMatch(/overflow-auto/)
  })

  it('at 200% a drag moves the element by the cursor delta over the new scale, as one undo step', async () => {
    const { adapter } = await mount(makeProject())
    await key('1', { metaKey: true })
    await key('=', { metaKey: true }) // 150
    await key('=', { metaKey: true }) // 200
    const el = document.querySelector<HTMLElement>('[data-element-id="el-0"]')!
    const w = widthPx()
    expect(w).toBeCloseTo(2160, 0)
    const before = adapter.saveCalls.length
    await act(async () => {
      pointer(el, 'pointerdown', { clientX: 10, clientY: 10 })
      pointer(window, 'pointermove', { clientX: 110, clientY: 10 })
      pointer(window, 'pointerup', { clientX: 110, clientY: 10 })
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    const moved = adapter.saveCalls[adapter.saveCalls.length - 1].project.slides![0].elements[0] as ImageElement
    expect(moved.x).toBeCloseTo(150, 0)
    await key('z', { metaKey: true })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 2))
    expect((adapter.saveCalls[adapter.saveCalls.length - 1].project.slides![0].elements[0] as ImageElement).x).toBe(100)
  })

  it('classic layout has no zoom: no slider, and the keys do nothing', async () => {
    const { r } = await mount(makeProject(), 'classic')
    expect(r.queryByRole('slider', { name: 'Zoom' })).toBeNull()
    const w = document.querySelector<HTMLElement>('[data-interactive]')!.style.width
    await key('1', { metaKey: true })
    await key('=', { metaKey: true })
    expect(document.querySelector<HTMLElement>('[data-interactive]')!.style.width).toBe(w)
  })
})

