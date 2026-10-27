import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'

// §587 decision 4: the stacked slides render only what changed, and slides far
// from the view draw as a sized placeholder, not a canvas.

// jsdom never loads an image, so a real size read would wait out its timeout.
vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// Each SlideCanvas render, counted by its slide.
const renders = new Map<string, number>()
vi.mock('../SlideCanvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SlideCanvas')>()
  const Real = actual.default
  function Counted(props: ComponentProps<typeof Real>) {
    const id = props.slideId ?? props.slide.id
    renders.set(id, (renders.get(id) ?? 0) + 1)
    return createElement(Real, props)
  }
  return { ...actual, default: Counted }
})

function slide(i: number, elements: Slide['elements'] = []): Slide {
  return { id: `s${i}`, base_color: i === 4 ? '#ff0000' : '#ffffff', elements }
}
const img = (id: string, x = 100, y = 100): ImageElement => ({ id, type: 'image', src: `${id}.png`, x, y, w: 200, h: 200, rotation: 0 })

function makeProject(slides: Slide[]): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [], slides,
  } as Project
}
const many = (n: number) => makeProject(Array.from({ length: n }, (_, i) => slide(i, [img(`el-${i}`)])))

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

class MockIO {
  static instances: MockIO[] = []
  observed = new Set<Element>()
  constructor(public cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) { MockIO.instances.push(this) }
  observe(el: Element) { this.observed.add(el) }
  unobserve(el: Element) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  takeRecords() { return [] }
}
/** A user scroll: a scroll event on the stack, then each named slide's share in view. */
async function inView(ratios: Record<string, number>) {
  await act(async () => { document.querySelector('[data-slide-stack]')!.dispatchEvent(new Event('scroll')) })
  const io = [...MockIO.instances].reverse().find((o) => o.observed.size > 0)!
  const entries = [...io.observed]
    .filter((el) => (el as HTMLElement).dataset.slideSection! in ratios)
    .map((el) => {
      const r = ratios[(el as HTMLElement).dataset.slideSection!]
      return { target: el, intersectionRatio: r, isIntersecting: r > 0 } as unknown as IntersectionObserverEntry
    })
  await act(async () => { io.cb(entries, io as unknown as IntersectionObserver) })
}

const realIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
beforeEach(() => {
  renders.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  MockIO.instances = []
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  vi.restoreAllMocks()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIO
})

async function mount(project: Project) {
  const adapter = makeAdapter(project)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" />)
  await waitFor(() => expect(document.querySelectorAll('[data-slide-section]').length).toBe(project.slides!.length))
  return { adapter, r }
}
const section = (id: string) => document.querySelector<HTMLElement>(`[data-slide-section="${id}"]`)!
const wrapper = (id: string) => document.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!
const counter = (r: ReturnType<typeof render>) => within(r.getByRole('contentinfo', { name: 'Bottom bar' })).getByRole('button', { name: /^Slides / })
async function key(k: string) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true })) })
}
async function pressClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    fireEvent.click(el)
  })
}

describe('stacked slides: renders (§587)', () => {
  it('an edit on slide 1 does not render slide 3 again', async () => {
    const { adapter } = await mount(many(4))
    await inView({ s0: 1, s1: 0.4 })
    await pressClick(wrapper('el-0'))
    const s2 = renders.get('s2') ?? 0
    const s0 = renders.get('s0') ?? 0
    expect(s2).toBeGreaterThan(0)
    // A nudge (on screen), then a delete (saved): both edit slide 1 alone.
    await key('ArrowRight')
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    expect(adapter.saveCalls[adapter.saveCalls.length - 1].project.slides![0].elements).toEqual([])
    expect(renders.get('s0')!).toBeGreaterThan(s0)
    expect(renders.get('s2')).toBe(s2)
  })

  it('a slide far from the view draws a placeholder, not a canvas; its header stays and a click picks it', async () => {
    const { r } = await mount(many(6))
    await inView({ s0: 1, s1: 0.2 })
    // In view, one either side: live; two away: the thumbnail; further: the placeholder.
    expect(section('s3').querySelector('[data-element-id="el-3"]')).not.toBeNull()
    expect(section('s3').querySelector('[data-slide-placeholder]')).toBeNull()
    for (const id of ['s4', 's5']) {
      const ph = section(id).querySelector<HTMLElement>('[data-slide-placeholder]')
      expect(ph).not.toBeNull()
      expect(section(id).querySelector('[data-element-id]')).toBeNull()
      expect(renders.get(id) ?? 0).toBe(0)
      expect(section(id).querySelector('[data-slide-header]')).not.toBeNull()
      // Sized as the slide at the scale in effect: its aspect, the canvas's width.
      const w = parseFloat(ph!.style.width)
      expect(w).toBeGreaterThan(0)
      expect(parseFloat(ph!.style.height) / w).toBeCloseTo(1350 / 1080, 5)
      expect(w).toBeCloseTo(parseFloat(section('s0').querySelector<HTMLElement>('[data-interactive]')!.style.width), 5)
    }
    expect(section('s4').querySelector<HTMLElement>('[data-slide-placeholder]')!.style.backgroundColor).toBe('rgb(255, 0, 0)')
    await act(async () => { fireEvent.click(section('s5').querySelector<HTMLElement>('[data-slide-placeholder]')!) })
    expect(counter(r).textContent).toContain('6 / 6')
    // Scrolled there, it is drawn again.
    await inView({ s0: 0, s1: 0, s4: 0.3, s5: 1 })
    expect(section('s5').querySelector('[data-element-id="el-5"]')).not.toBeNull()
    expect(section('s1').querySelector('[data-slide-placeholder]')).not.toBeNull()
  })
})
