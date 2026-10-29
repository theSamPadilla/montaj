import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, screen } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})
vi.mock('../photoColours', () => ({ photoColoursOf: vi.fn(async () => []) }))

// A toolbar change to a hugging pill and the box its pill then measures are one
// undo step; opening and selecting write nothing.

const TEMPLATE = '/rt/render/templates/overlays/static-text/static-text.jsx'

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [{
      id: 'slide-0', base_color: '#ffffff',
      elements: [{
        id: 'el-p', type: 'overlay', frame: 0, x: 100, y: 100, w: 600, h: 200, rotation: 0,
        overlay: { template: TEMPLATE, props: { text: 'Pill', fontSize: '48', color: '#111111', textAlign: 'left', hug: 'true', bgColor: '#ffee00' } },
      }],
    }],
  } as Project
}

function makeAdapter() {
  const saveCalls: Array<{ id: string; project: Project }> = []
  // The pill is 100 px plus twice its padX wide.
  const compile = vi.fn(async () => (_f: number, _fps: number, _d: number, props: Record<string, unknown>) => (
    <div data-montaj-pill="" data-w={String(100 + 2 * (parseFloat(String(props.padX ?? '0')) || 0))}>
      <p data-montaj-text="">{String(props.text)}</p>
    </div>
  ))
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: compile,
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
  } as unknown as EditorAdapter<Project> & { saveCalls: typeof saveCalls }
}

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.setPointerCapture = () => {}
  // The pill (flush left, centred) is data-w wide and 40 tall inside its layer.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const layer = this.closest('[data-overlay-layer]') as HTMLElement | null
    if (this.hasAttribute('data-overlay-layer')) return box(0, 0, parseFloat(this.style.width), parseFloat(this.style.height))
    if (this.hasAttribute('data-montaj-pill') && layer) return box(0, (parseFloat(layer.style.height) - 40) / 2, Number(this.getAttribute('data-w')), 40)
    return box(0, 0, 0, 0)
  })
})
afterEach(() => { vi.restoreAllMocks() })

const el = (a: { saveCalls: Array<{ project: Project }> }, i = -1) => {
  const call = a.saveCalls[a.saveCalls.length + i].project.slides![0].elements[0] as unknown as { x: number; y: number; w: number; h: number; overlay: { props: Record<string, string> } }
  return call
}
const wrapperOf = () => { const els = document.querySelectorAll('[data-element-id="el-p"]'); return els[els.length - 1] as HTMLElement }

async function mount() {
  const adapter = makeAdapter()
  render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} layout="rail" />)
  await waitFor(() => expect(wrapperOf()).toBeTruthy())
  // Shown fitted (100 wide: 50px at the 0.5 scale of a 1080 canvas is not assumed; the width just shrinks from 600).
  await waitFor(() => expect(parseFloat(wrapperOf().style.width)).toBeLessThan(600))
  return adapter
}

describe('a toolbar change to a hugging pill', () => {
  it('opening and selecting write nothing', async () => {
    const adapter = await mount()
    await act(async () => { fireEvent.click(wrapperOf()) })
    await new Promise((res) => setTimeout(res, 50))
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('stores the prop and the re-measured box together, and one undo restores both', async () => {
    const adapter = await mount()
    await act(async () => { fireEvent.click(wrapperOf()) })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Effects' })) })
    const input = await waitFor(() => screen.getByLabelText('Padding X'))
    await act(async () => {
      fireEvent.change(input, { target: { value: '30' } })
      fireEvent.blur(input)
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    await new Promise((res) => setTimeout(res, 50))
    // Both are stored: padX 30 and the pill's box (100 + 60 wide, 40 tall, centred where it was).
    const before = adapter.saveCalls.length
    const stored = el(adapter)
    expect(stored.overlay.props.padX).toBe('30')
    expect([stored.x, stored.w, stored.h]).toEqual([100, 160, 40])
    await act(async () => { fireEvent.keyDown(document, { key: 'z', ctrlKey: true }) })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(before))
    const undone = el(adapter)
    expect(undone.overlay.props.padX).toBeUndefined()
    expect([undone.x, undone.y, undone.w, undone.h]).toEqual([100, 100, 600, 200])
  })
})
