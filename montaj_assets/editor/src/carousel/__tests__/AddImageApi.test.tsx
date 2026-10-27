import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import type { CarouselApi, EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// CarouselApi.addImage: the optional asset, and what it resolves.

interface FakeAdapter extends EditorAdapter<Project> { saveCalls: Array<{ id: string; project: Project }> }

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [{ id: 'slide-0', base_color: '#ffffff', elements: [{ id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 }] }],
  } as Project
}

function makeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeProject()),
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

async function mount(adapter = makeAdapter()) {
  let api: CarouselApi | null = null
  const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} layout="rail" onProvideCarouselApi={(a) => { api = a }} />)
  await waitFor(() => expect(document.querySelector('[data-element-id="el-img"]')).not.toBeNull())
  await waitFor(() => expect(api).not.toBeNull())
  return { adapter, r, api: () => api! }
}

const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project
const undo = () => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true, bubbles: true })) })

describe('CarouselApi.addImage', () => {
  it('with { asset }: one save adds the element and the asset, one undo removes both', async () => {
    const { adapter, api } = await mount()
    const before = adapter.saveCalls.length
    let ok: boolean | undefined
    await act(async () => { ok = await api().addImage('/kit/logo.png', { asset: { name: 'logo.png' } }) })
    expect(ok).toBe(true)
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    let p = last(adapter)
    expect(p.slides![0].elements.map((e) => (e as ImageElement).src)).toContain('/kit/logo.png')
    expect(p.assets).toEqual([expect.objectContaining({ src: '/kit/logo.png', type: 'image', name: 'logo.png' })])
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 2))
    p = last(adapter)
    expect(p.slides![0].elements).toHaveLength(1)
    expect(p.assets ?? []).toHaveLength(0)
  })

  it('without options it adds no asset', async () => {
    const { adapter, api } = await mount()
    await act(async () => { await api().addImage('/kit/logo.png') })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    expect(last(adapter).assets ?? []).toHaveLength(0)
  })

  it('resolves false when the editor went away before it could write', async () => {
    const geometry = await import('../imageGeometry')
    let release: (v: null) => void = () => {}
    vi.mocked(geometry.loadImageNaturalSize).mockImplementationOnce(() => new Promise((res) => { release = res }))
    const { adapter, api, r } = await mount()
    const call = api().addImage('/kit/slow.png')
    await act(async () => { await new Promise((res) => setTimeout(res, 10)) })
    r.unmount()
    release(null)
    expect(await call).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })
})
