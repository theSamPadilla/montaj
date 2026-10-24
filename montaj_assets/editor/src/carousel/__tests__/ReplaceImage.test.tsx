import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { CarouselEditorProps, EditorAdapter, ImageElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'
import SlidePropertyPanel from '../SlidePropertyPanel'
import { loadImageNaturalSize } from '../imageGeometry'

// ── Replace image (§556 M5) ──────────────────────────────────────────────────
//
// Replace swaps a selected image's file and keeps its box: x, y, w, h and
// rotation stay, the crop becomes the centred region of the new image with the
// box's aspect (no letterbox bands), and `mediaId` goes. One undo step, one
// save. jsdom never loads an image, so the loader is mocked; `coverCrop` stays
// real, so the crops asserted here are the ones the editor writes.

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn() }
})
const loadSize = vi.mocked(loadImageNaturalSize)

const OLD_CROP = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
const NEW_SRC = '/proj/assets/new.png'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: '1',
    id: 'proj-1',
    name: 'Test',
    workflow: 'carousel',
    status: 'draft',
    editingPrompt: '',
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    assets: [],
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [
          // A rotated image with a crop and a media id: everything Replace touches or keeps.
          { id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 10, crop: OLD_CROP, mediaId: 'm-old' },
          { id: 'el-other', type: 'image', src: 'b.png', x: 500, y: 500, w: 100, h: 100, rotation: 0 },
        ],
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
    uploadFile: vi.fn(async () => NEW_SRC),
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
  // A 2:1 image: wider than the 200 x 200 box.
  loadSize.mockResolvedValue({ width: 400, height: 200 })
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

function findInteractiveWrapper(elementId: string): HTMLElement {
  const els = document.querySelectorAll(`[data-element-id="${elementId}"]`)
  if (els.length === 0) throw new Error(`element wrapper ${elementId} not found`)
  return els[els.length - 1] as HTMLElement
}

async function plainClick(id: string) {
  await act(async () => { fireEvent.click(findInteractiveWrapper(id)) })
}

async function key(k: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })
  await act(async () => { document.dispatchEvent(e) })
  return e
}

function lastSave(adapter: FakeAdapter): Project {
  return adapter.saveCalls[adapter.saveCalls.length - 1].project
}

function imageIn(p: Project, id = 'el-img'): ImageElement {
  return p.slides![0].elements.find((e) => e.id === id) as ImageElement
}

function replaceInput(): HTMLInputElement {
  return document.querySelector('[data-testid="replace-image-input"]') as HTMLInputElement
}

function newFile(name = 'new.png') {
  return new File(['x'], name, { type: 'image/png' })
}

async function pickFile(file: File) {
  await act(async () => { fireEvent.change(replaceInput(), { target: { files: [file] } }) })
}

async function mountSelected(adapter: FakeAdapter, project: Project = makeProject(), extra: Partial<CarouselEditorProps<Project>> = {}) {
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} {...extra} />)
  await waitFor(() => findInteractiveWrapper('el-img'))
  await plainClick('el-img')
  return r
}

describe('Replace image: the editor', () => {
  it('the Replace button opens the file picker for an image', async () => {
    const r = await mountSelected(makeFakeAdapter())
    const input = replaceInput()
    expect(input.type).toBe('file')
    expect(input.accept).toBe('image/*')
    const open = vi.spyOn(input, 'click')

    fireEvent.click(r.getByTitle('Replace image'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('uploads into the project, swaps the src, keeps the box and rotation, and sets the centred cover crop', async () => {
    const adapter = makeFakeAdapter()
    const r = await mountSelected(adapter)
    const file = newFile()

    await pickFile(file)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))

    // The file goes into the project folder.
    expect(adapter.uploadFile).toHaveBeenCalledTimes(1)
    expect(adapter.uploadFile).toHaveBeenCalledWith(file, 'proj-1')
    // Its size was read from the URL the adapter resolves for the new source.
    expect(loadSize).toHaveBeenCalledWith(NEW_SRC)

    // The 2:1 image fills the 200 x 200 box: the middle half of its width.
    const saved = imageIn(lastSave(adapter))
    expect(saved).toEqual({
      id: 'el-img', type: 'image', src: NEW_SRC, x: 100, y: 100, w: 200, h: 200, rotation: 10,
      crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
    })
    expect('mediaId' in saved).toBe(false)
    // Nothing else moved.
    expect(imageIn(lastSave(adapter), 'el-other')).toEqual(imageIn(makeProject(), 'el-other'))

    // The canvas and the panel show the new file, the image still selected.
    expect(findInteractiveWrapper('el-img').querySelector('img')!.getAttribute('src')).toBe(NEW_SRC)
    expect(r.getByTitle(NEW_SRC).textContent).toBe('new.png')
    expect(findInteractiveWrapper('el-img').querySelector('[data-testid="resize-handle-nw"]')).not.toBeNull()
  })

  it('reads the new size through resolveImageSrc, never through the old media id', async () => {
    const adapter = makeFakeAdapter()
    adapter.resolveImageSrc = (el) => (el.mediaId ? `media:${el.mediaId}` : `file:${el.src}`)
    await mountSelected(adapter)

    await pickFile(newFile())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(loadSize).toHaveBeenCalledTimes(1)
    expect(loadSize).toHaveBeenCalledWith(`file:${NEW_SRC}`)
    expect(findInteractiveWrapper('el-img').querySelector('img')!.getAttribute('src')).toBe(`file:${NEW_SRC}`)
  })

  it('a taller image gets a vertically centred crop', async () => {
    loadSize.mockResolvedValue({ width: 200, height: 800 })
    const adapter = makeFakeAdapter()
    await mountSelected(adapter)

    await pickFile(newFile())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(imageIn(lastSave(adapter)).crop).toEqual({ x: 0, y: 0.375, w: 1, h: 0.25 })
  })

  it('one undo puts back the old src, crop and media id, and there is no second step', async () => {
    const adapter = makeFakeAdapter()
    await mountSelected(adapter)

    await pickFile(newFile())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const original = makeProject().slides![0].elements[0]

    const undo = await key('z', { metaKey: true })
    expect(undo.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(imageIn(lastSave(adapter))).toEqual(original)

    // A second Cmd+Z has nothing left to undo: the replace was one step.
    await key('z', { metaKey: true })
    expect(adapter.saveCalls).toHaveLength(2)
  })

  it('clears the crop when the new size cannot be read', async () => {
    loadSize.mockResolvedValue(null)
    const adapter = makeFakeAdapter()
    await mountSelected(adapter)

    await pickFile(newFile())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const saved = imageIn(lastSave(adapter))
    expect(saved.src).toBe(NEW_SRC)
    expect('crop' in saved).toBe(false)
    expect([saved.x, saved.y, saved.w, saved.h, saved.rotation]).toEqual([100, 100, 200, 200, 10])
  })

  it('clears the crop when the new image already has the box shape', async () => {
    loadSize.mockResolvedValue({ width: 800, height: 800 })
    const adapter = makeFakeAdapter()
    await mountSelected(adapter)

    await pickFile(newFile())
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect('crop' in imageIn(lastSave(adapter))).toBe(false)
  })

  it('an upload failure goes to onError, never alert, and changes nothing', async () => {
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    const onError = vi.fn()
    const r = await mountSelected(adapter, makeProject(), { onError })

    await pickFile(newFile())
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError).toHaveBeenCalledWith({ title: "Couldn't replace the image", detail: 'disk full' })
    expect(alertSpy).not.toHaveBeenCalled()

    // Nothing was written, measured or left in the undo history.
    expect(adapter.saveProject).not.toHaveBeenCalled()
    expect(loadSize).not.toHaveBeenCalled()
    expect(r.getByTitle('a.png')).toBeTruthy()
    await key('z', { metaKey: true })
    expect(adapter.saveProject).not.toHaveBeenCalled()
    // The button is back for another try.
    await waitFor(() => expect((r.getByTitle('Replace image') as HTMLButtonElement).disabled).toBe(false))
  })

  it('without onError an upload failure is logged to the console', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValue('quota')
    await mountSelected(adapter)

    await pickFile(newFile())
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))
    expect(errorSpy.mock.calls[0][0]).toContain("Couldn't replace the image: quota")
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('a failed save rolls back and shows the save error once, not through onError', async () => {
    const adapter = makeFakeAdapter()
    ;(adapter.saveProject as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('HTTP 500: disk full') })
    const onError = vi.fn()
    const r = await mountSelected(adapter, makeProject(), { onError })

    await pickFile(newFile())
    await waitFor(() => expect(r.getByText('HTTP 500: disk full')).toBeTruthy())
    // Back to the old file, and no second report.
    expect(r.getByTitle('a.png')).toBeTruthy()
    // The save that failed carried the new source.
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)
    expect(imageIn((adapter.saveProject as ReturnType<typeof vi.fn>).mock.calls[0][1] as Project).src).toBe(NEW_SRC)
    expect(onError).not.toHaveBeenCalled()
  })

  it('the button is off while the replace is in flight, and back after', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    const r = await mountSelected(adapter)
    const button = () => r.getByTitle('Replace image') as HTMLButtonElement
    expect(button().disabled).toBe(false)

    await pickFile(newFile())
    expect(button().disabled).toBe(true)

    await act(async () => { gate.resolve(NEW_SRC) })
    await waitFor(() => expect(button().disabled).toBe(false))
    expect(adapter.saveCalls).toHaveLength(1)
  })

  it('crops for the box the element has when the replace lands, not the one it had when it started', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    loadSize.mockResolvedValue({ width: 300, height: 300 })
    const r = await mountSelected(adapter)

    await pickFile(newFile())
    // While the upload runs the box becomes 400 x 200.
    await act(async () => { fireEvent.change(r.getByRole('spinbutton', { name: 'W' }), { target: { value: '400' } }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(imageIn(lastSave(adapter)).w).toBe(400)

    await act(async () => { gate.resolve(NEW_SRC) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    // A square image in a 2:1 box: the middle half of its height. (Against the
    // 200 x 200 box the replace started with there would be no crop at all.)
    expect(imageIn(lastSave(adapter))).toMatchObject({
      src: NEW_SRC, x: 100, y: 100, w: 400, h: 200, rotation: 10, crop: { x: 0, y: 0.25, w: 1, h: 0.5 },
    })
  })

  it('drops the replace when the element is deleted meanwhile, with no save and no undo step', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    const onError = vi.fn()
    await mountSelected(adapter, makeProject(), { onError })

    await pickFile(newFile())
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(lastSave(adapter).slides![0].elements.map((e) => e.id)).toEqual(['el-other'])

    await act(async () => { gate.resolve(NEW_SRC); await new Promise((r) => setTimeout(r, 0)) })
    expect(adapter.saveCalls).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    // The one undo step is the delete.
    await key('z', { metaKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(imageIn(lastSave(adapter)).src).toBe('a.png')
  })

  it('writes nothing once the editor is gone', async () => {
    const gate = deferred<string>()
    const adapter = makeFakeAdapter()
    ;(adapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(() => gate.promise)
    const r = await mountSelected(adapter)

    await pickFile(newFile())
    r.unmount()
    await act(async () => { gate.resolve(NEW_SRC); await new Promise((res) => setTimeout(res, 0)) })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('is off while the project is not editable', async () => {
    const adapter = makeFakeAdapter()
    const r = await mountSelected(adapter, makeProject({ status: 'storyboard_ready' }))
    expect((r.getByTitle('Replace image') as HTMLButtonElement).disabled).toBe(true)
  })

  it('has no Replace for an overlay', async () => {
    const adapter = makeFakeAdapter()
    const overlay = makeProject({
      slides: [
        {
          id: 'slide-0',
          base_color: '#ffffff',
          elements: [
            { id: 'el-img', type: 'overlay', overlay: { template: '/overlays/t.jsx', props: { text: 'Hi' } }, frame: 0, x: 0, y: 0, w: 200, h: 100, rotation: 0 },
          ],
        },
      ],
    })
    const r = await mountSelected(adapter, overlay)
    expect(r.queryByTitle('Replace image')).toBeNull()
    expect(replaceInput()).toBeNull()
  })
})

describe('Replace image: the panel buttons', () => {
  it('Crop and Replace are a pair in one row, one size and variant, Crop keeping its titles', async () => {
    const adapter = makeFakeAdapter()
    const r = await mountSelected(adapter, makeProject({
      slides: [
        {
          id: 'slide-0',
          base_color: '#ffffff',
          elements: [{ id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 }],
        },
      ],
    }))
    const crop = r.getByTitle('Crop image')
    const replace = r.getByTitle('Replace image')

    expect(crop.parentElement).toBe(replace.parentElement)
    expect(crop.parentElement!.className).toContain('flex gap-2')
    for (const b of [crop, replace]) {
      expect(b.className).toContain('flex-1')
      expect(b.className).toContain('h-7')
      expect(b.className).toContain('bg-[var(--editor-surface)]')
      expect(b.querySelector('svg')).not.toBeNull()
    }
    expect(crop.textContent).toBe('Crop')
    expect(replace.textContent).toBe('Replace')
    expect((crop as HTMLButtonElement).disabled).toBe(false)
    expect((replace as HTMLButtonElement).disabled).toBe(false)
  })

  it('Crop still opens the crop overlay', async () => {
    const adapter = makeFakeAdapter()
    const r = await mountSelected(adapter, makeProject({
      slides: [
        {
          id: 'slide-0',
          base_color: '#ffffff',
          elements: [{ id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 }],
        },
      ],
    }))
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    expect(findInteractiveWrapper('el-img').querySelector('img[alt="Crop source"]')).not.toBeNull()
  })

  it('a rotated image keeps Crop off with its own title, and Replace on', async () => {
    const r = await mountSelected(makeFakeAdapter())
    const crop = r.getByTitle('Reset rotation to 0 before cropping') as HTMLButtonElement
    expect(crop.disabled).toBe(true)
    expect((r.getByTitle('Replace image') as HTMLButtonElement).disabled).toBe(false)
  })
})

// ── The panel on its own ─────────────────────────────────────────────────────

describe('Replace image: SlidePropertyPanel', () => {
  const slide: Slide = {
    id: 'slide-0',
    base_color: '#ffffff',
    elements: [{ id: 'el-img', type: 'image', src: 'dir/a.png', x: 0, y: 0, w: 100, h: 100, rotation: 0 }],
  }

  function renderPanel(onReplaceImage?: (slideId: string, elementId: string, file: File) => void | Promise<void>) {
    const adapter = makeFakeAdapter()
    return render(
      <SlidePropertyPanel
        project={makeProject()}
        slide={slide}
        element={slide.elements[0]}
        adapter={adapter}
        onSlideChange={vi.fn()}
        onElementChange={vi.fn()}
        onDeleteSlide={vi.fn()}
        onDuplicateSlide={vi.fn()}
        onDeleteElement={vi.fn()}
        onDuplicateElement={vi.fn()}
        onReorderElement={vi.fn()}
        onEnterCrop={vi.fn()}
        onReplaceImage={onReplaceImage}
      />,
    )
  }

  it('is off without onReplaceImage', async () => {
    const r = renderPanel(undefined)
    await act(async () => {})
    expect((r.getByTitle('Replace image') as HTMLButtonElement).disabled).toBe(true)
  })

  it('hands the picked file, with the slide and element ids, to onReplaceImage', async () => {
    const onReplace = vi.fn(async () => {})
    const r = renderPanel(onReplace)
    await act(async () => {})
    const file = newFile('pick.png')

    await pickFile(file)
    expect(onReplace).toHaveBeenCalledTimes(1)
    expect(onReplace).toHaveBeenCalledWith('slide-0', 'el-img', file)
    expect((r.getByTitle('Replace image') as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears the input after a pick, so the same file can be picked again', async () => {
    const onReplace = vi.fn(async () => {})
    renderPanel(onReplace)
    await act(async () => {})
    const input = replaceInput()
    const set = vi.fn()
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set })

    await pickFile(newFile())
    expect(set).toHaveBeenCalledWith('')
  })

  it('does nothing when the picker is dismissed with no file', async () => {
    const onReplace = vi.fn(async () => {})
    renderPanel(onReplace)
    await act(async () => {})

    await act(async () => { fireEvent.change(replaceInput(), { target: { files: [] } }) })
    expect(onReplace).not.toHaveBeenCalled()
  })

  it('stays off until onReplaceImage resolves', async () => {
    const gate = deferred<void>()
    const r = renderPanel(vi.fn(() => gate.promise))
    await act(async () => {})
    const button = () => r.getByTitle('Replace image') as HTMLButtonElement

    await pickFile(newFile())
    expect(button().disabled).toBe(true)
    await act(async () => { gate.resolve() })
    expect(button().disabled).toBe(false)
  })

  it('a handler that returns nothing never leaves the button off', async () => {
    const onReplace = vi.fn()
    const r = renderPanel(onReplace)
    await act(async () => {})

    await pickFile(newFile())
    expect(onReplace).toHaveBeenCalledTimes(1)
    expect((r.getByTitle('Replace image') as HTMLButtonElement).disabled).toBe(false)
  })
})
