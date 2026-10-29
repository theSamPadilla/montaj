import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})
vi.mock('../photoColours', () => ({ photoColoursOf: vi.fn(async () => []) }))

// A click on the grey around the slides lets the selection go, like a click on
// a slide's own empty area; toolbars and panels, and a drag-select let go off
// the slide, keep it.

const bg: ImageElement = { id: 'el-bg', type: 'image', src: 'bg.png', x: 0, y: 0, w: 1080, h: 1080, rotation: 0 }
const pic: ImageElement = { id: 'el-pic', type: 'image', src: 'pic.png', x: 300, y: 300, w: 200, h: 200, rotation: 0 }

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [{ id: 'slide-0', base_color: '#ffffff', elements: [bg, pic] }],
  } as Project
}

function makeAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async () => {}),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
  } as unknown as EditorAdapter<Project>
}

const pointer = (target: EventTarget, type: string, init: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }
const handles = () => document.querySelector('[data-testid="resize-handle-se"]')
/** A press and release in place, and the click after it. */
async function click(target: Element) {
  await act(async () => { pointer(target, 'pointerdown', { clientX: 5, clientY: 5 }); pointer(window, 'pointerup'); fireEvent.click(target) })
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => { vi.restoreAllMocks() })

for (const layout of ['rail', 'classic'] as const) {
  describe(`${layout} layout: clicking outside the slide`, () => {
    async function mount(select = 'el-bg') {
      const r = render(<CarouselEditor project={makeProject()} adapter={makeAdapter()} onProjectChange={vi.fn()} layout={layout === 'rail' ? 'rail' : undefined} />)
      await waitFor(() => expect(wrapperOf(select)).toBeTruthy())
      await click(wrapperOf(select))
      await waitFor(() => expect(handles()).not.toBeNull())
      return r
    }
    const backdrops = () => Array.from(document.querySelectorAll<HTMLElement>(layout === 'rail' ? '[data-stack-bg]' : '.relative.flex-1.flex-col.items-center.justify-center.overflow-y-auto'))

    it('clears a selected background image', async () => {
      await mount('el-bg')
      await click(backdrops()[0])
      expect(handles()).toBeNull()
    })

    it('clears a selected element', async () => {
      await mount('el-pic')
      await click(backdrops()[0])
      expect(handles()).toBeNull()
    })

    it('keeps the selection for a click on the toolbar or a panel', async () => {
      await mount('el-pic')
      const toolbar = (document.querySelector('[role="toolbar"]') ?? backdrops()[0].parentElement) as HTMLElement
      expect(toolbar).toBeTruthy()
      await click(toolbar)
      expect(handles()).not.toBeNull()
    })

    it('keeps the selection when a press on the slide is let go on the grey (a drag-select)', async () => {
      await mount('el-pic')
      const base = document.querySelector('[data-slide-base]') as HTMLElement
      await act(async () => {
        pointer(base, 'pointerdown', { clientX: 5, clientY: 5 })
        pointer(window, 'pointermove', { clientX: 60, clientY: 60 })
        pointer(window, 'pointerup', { clientX: 60, clientY: 60 })
        fireEvent.click(backdrops()[0])
      })
      // The band gesture owns that release; the grey did not start the press.
      expect(document.querySelector('[data-testid="resize-handle-se"]')).not.toBeNull()
    })

    it('Esc clears the selection', async () => {
      await mount('el-pic')
      await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
      expect(handles()).toBeNull()
    })
  })
}

describe('the slide itself', () => {
  it('a click on its own empty margin still clears', async () => {
    render(<CarouselEditor project={makeProject()} adapter={makeAdapter()} onProjectChange={vi.fn()} layout="rail" />)
    await waitFor(() => expect(wrapperOf('el-pic')).toBeTruthy())
    await click(wrapperOf('el-pic'))
    await waitFor(() => expect(handles()).not.toBeNull())
    await click(document.querySelector('[data-canvas-margin]') as HTMLElement)
    expect(handles()).toBeNull()
  })
})
