import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// Remove background (§587 R3): the photo toolbar's one button. The host makes
// the cutout; the editor swaps it in for the photo in one undo step, keeps the
// box and crop, adds the cutout to project.assets and leaves the original.

const CROP = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }
const CUTOUT = '/proj/assets/a-cutout.png'

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function makeProject(locked = false): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] },
    assets: [{ id: 'as-a', src: '/proj/assets/a.jpg', type: 'image', name: 'a.jpg' }],
    slides: [{
      id: 'slide-0', base_color: '#ffffff',
      elements: [
        { id: 'el-img', type: 'image', src: '/proj/assets/a.jpg', x: 100, y: 100, w: 200, h: 300, rotation: 5, crop: CROP, mediaId: 'm-a', ...(locked ? { locked: true } : {}) },
        {
          id: 'el-t', type: 'overlay', frame: 0, x: 300, y: 700, w: 400, h: 100, rotation: 0,
          overlay: { template: '/overlays/text.jsx', props: { text: 'Hello' } },
        },
      ],
    }],
  } as Project
}

function makeAdapter(removeBackground?: EditorAdapter<Project>['removeBackground']): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  const adapter = {
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
  if (removeBackground) adapter.removeBackground = removeBackground
  return adapter
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { vi.restoreAllMocks() })

const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }
const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project
const image = (p: Project) => p.slides![0].elements.find((e) => e.id === 'el-img') as ImageElement
const toolbar = (r: ReturnType<typeof render>) => r.getByRole('toolbar', { name: 'Element' })
const removeBg = (r: ReturnType<typeof render>) => within(toolbar(r)).queryByRole('button', { name: 'Remove background' }) as HTMLButtonElement | null

async function mount(adapter: FakeAdapter, select = 'el-img', project = makeProject(), onError = vi.fn()) {
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" onError={onError} />)
  await waitFor(() => expect(document.querySelector(`[data-element-id="${select}"]`)).not.toBeNull())
  await act(async () => { fireEvent.click(wrapperOf(select)) })
  return { r, onError }
}
async function press(b: HTMLElement) { await act(async () => { fireEvent.click(b) }) }
async function undo() {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true, bubbles: true })) })
}

describe('Remove background (§587 R3)', () => {
  it('shows on an image only when the host can remove backgrounds', async () => {
    const none = await mount(makeAdapter())
    expect(removeBg(none.r)).toBeNull()
    none.r.unmount()

    const withIt = await mount(makeAdapter(vi.fn(async () => ({ path: CUTOUT }))))
    expect(removeBg(withIt.r)).not.toBeNull()
    withIt.r.unmount()

    const text = await mount(makeAdapter(vi.fn(async () => ({ path: CUTOUT }))), 'el-t')
    expect(removeBg(text.r)).toBeNull()
  })

  it('runs with a spinner, swaps in the cutout in one save, adds it to the assets, and one undo restores the photo', async () => {
    const run = deferred<{ path: string }>()
    const adapter = makeAdapter(vi.fn(() => run.promise))
    const { r } = await mount(adapter)

    await press(removeBg(r)!)
    expect(adapter.removeBackground).toHaveBeenCalledTimes(1)
    expect(adapter.removeBackground).toHaveBeenCalledWith('/proj/assets/a.jpg', 'proj-1')
    // Running: busy and disabled, with a spinner; a second click starts nothing.
    const busy = removeBg(r)!
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.disabled).toBe(true)
    expect(busy.querySelector('.animate-spin')).not.toBeNull()
    await press(busy)
    expect(adapter.removeBackground).toHaveBeenCalledTimes(1)
    expect(adapter.saveCalls).toHaveLength(0)

    await act(async () => { run.resolve({ path: CUTOUT }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const saved = last(adapter)
    // The box, rotation and crop stay (the cutout has the photo's pixel size); mediaId named the old file.
    expect(image(saved)).toEqual({ id: 'el-img', type: 'image', src: CUTOUT, x: 100, y: 100, w: 200, h: 300, rotation: 5, crop: CROP })
    // The cutout joins the assets; the original stays listed.
    expect(saved.assets!.map((a) => a.src)).toEqual(['/proj/assets/a.jpg', CUTOUT])
    expect(saved.assets![1]).toMatchObject({ type: 'image', name: 'a-cutout.png' })
    expect(removeBg(r)!.disabled).toBe(false)
    expect(removeBg(r)!.getAttribute('aria-busy')).toBe('false')

    await undo()
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(image(last(adapter))).toEqual(image(makeProject()))
  })

  it('a failure goes to onError and changes nothing', async () => {
    const adapter = makeAdapter(vi.fn(async () => { throw new Error('The background removal model is missing.') }))
    const { r, onError } = await mount(adapter)
    await press(removeBg(r)!)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError).toHaveBeenCalledWith({ title: "Couldn't remove the background", detail: 'The background removal model is missing.' })
    expect(adapter.saveCalls).toHaveLength(0)
    expect(removeBg(r)!.disabled).toBe(false)
  })

  it('a cutout save that fails goes to onError', async () => {
    const adapter = makeAdapter(vi.fn(async () => ({ path: CUTOUT })))
    adapter.saveProject = vi.fn(async () => { throw new Error('disk full') })
    const { r, onError } = await mount(adapter)
    await press(removeBg(r)!)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError.mock.calls[0][0]).toMatchObject({ title: "Couldn't remove the background" })
  })

  it('an answer without a path goes to onError and writes nothing', async () => {
    const adapter = makeAdapter(vi.fn(async () => ({}) as { path: string }))
    const { r, onError } = await mount(adapter)
    await press(removeBg(r)!)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError.mock.calls[0][0]).toMatchObject({ title: "Couldn't remove the background" })
    await act(async () => { await new Promise((res) => setTimeout(res, 30)) })
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('a write the project drops (it stopped being editable) goes to onError', async () => {
    const run = deferred<{ path: string }>()
    const adapter = makeAdapter(vi.fn(() => run.promise))
    let push!: (p: Project) => void
    adapter.subscribe = (_id, onFrame) => { push = (p) => onFrame(p); return () => {} }
    const { r, onError } = await mount(adapter)
    await press(removeBg(r)!)
    await act(async () => { push({ ...makeProject(), status: 'rendering' } as unknown as Project) })
    await act(async () => { run.resolve({ path: CUTOUT }) })
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('is disabled on a locked image', async () => {
    const adapter = makeAdapter(vi.fn(async () => ({ path: CUTOUT })))
    const { r } = await mount(adapter, 'el-img', makeProject(true))
    expect(removeBg(r)!.disabled).toBe(true)
  })

  it('writes nothing when the photo was replaced while it ran', async () => {
    const run = deferred<{ path: string }>()
    const adapter = makeAdapter(vi.fn(() => run.promise))
    const { r } = await mount(adapter)
    await press(removeBg(r)!)
    // Another file arrives for the image meanwhile (Replace).
    const input = document.querySelector('[data-testid="replace-image-input"]') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'b.png', { type: 'image/png' })] } }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await act(async () => { run.resolve({ path: CUTOUT }) })
    await act(async () => { await new Promise((res) => setTimeout(res, 30)) })
    expect(adapter.saveCalls).toHaveLength(1)
    expect(image(last(adapter)).src).toBe('/path')
  })
})
