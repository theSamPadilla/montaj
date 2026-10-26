import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { CarouselElement, EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent } from '../../types'
import SlideCanvas from '../SlideCanvas'
import CarouselEditor from '../CarouselEditor'
import { scaleFontSize } from '../textScale'

// Text scales with its box (§586 M8): a corner resize that keeps the ratio
// scales the font size by the box's height ratio, in the resize's undo step.

const SCALE = 0.5
type Box = { x: number; y: number; w: number; h: number }

function text(props: Record<string, unknown>, over: Partial<OverlayElement> = {}): OverlayElement {
  return {
    id: 'el',
    type: 'overlay',
    overlay: { template: '/overlays/static-text.jsx', props: { text: 'Hello', ...props } },
    frame: 0,
    x: 100, y: 100, w: 200, h: 100, rotation: 0,
    ...over,
  }
}

function setup(el: CarouselElement) {
  const spies = {
    resizeElement: vi.fn<(slideId: string, elementId: string, box: Box) => Promise<void>>(async () => {}),
    updateOverlayProp: vi.fn<(slideId: string, elementId: string, key: string, value: string) => Promise<void>>(async () => {}),
    commit: vi.fn(async () => {}),
  }
  const r = render(
    <SlideCanvas
      slide={{ id: 's', base_color: '#ffffff', elements: [el] }}
      width={1080}
      height={1080}
      interactive
      selectedElementId={el.id}
      scale={SCALE}
      resolveImageSrc={(e) => e.src}
      {...spies}
    />,
  )
  const q = (sel: string) => r.container.querySelector(sel) as HTMLElement
  const wrapper = q(`[data-element-id="${el.id}"]`)
  return {
    ...spies,
    handle: (id: string) => q(`[data-testid="resize-handle-${id}"]`),
    // The overlay's inner layer: drawn at native size and scaled to the canvas.
    inner: () => wrapper.firstElementChild as HTMLElement,
  }
}

// jsdom has no PointerEvent; a MouseEvent named for one carries clientX/Y and shiftKey.
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

async function dragFrom(target: HTMLElement, to: { x: number; y: number }, move: MouseEventInit = {}) {
  await act(async () => {
    pointer(target, 'pointerdown', { clientX: 0, clientY: 0 })
    pointer(window, 'pointermove', { clientX: to.x, clientY: to.y, ...move })
    pointer(window, 'pointerup', { clientX: to.x, clientY: to.y })
  })
}

// 100, 50 screen px at half scale: 200, 100 on the slide, twice the box.
const DOUBLE = { x: 100, y: 50 }

describe('SlideCanvas: a corner resize scales the text with the box (§586 M8)', () => {
  it('doubling the box doubles a unitless font size, written as px with the resize and no separate commit', async () => {
    const c = setup(text({ fontSize: '40' }))
    await dragFrom(c.handle('se'), DOUBLE)
    expect(c.resizeElement).toHaveBeenCalledWith('s', 'el', { x: 100, y: 100, w: 400, h: 200 })
    expect(c.updateOverlayProp).toHaveBeenCalledTimes(1)
    expect(c.updateOverlayProp).toHaveBeenCalledWith('s', 'el', 'fontSize', '80px')
    // The prop write is the edit: it folds the transient resize into its undo step and its save.
    expect(c.commit).not.toHaveBeenCalled()
  })

  it('doubles a number and a px font size', async () => {
    for (const fontSize of [24, '24px']) {
      const c = setup(text({ fontSize }))
      await dragFrom(c.handle('se'), DOUBLE)
      expect(c.updateOverlayProp).toHaveBeenCalledWith('s', 'el', 'fontSize', '48px')
    }
  })

  it('rounds the size to half a pixel, by the ratio of the committed height', async () => {
    // 46 screen px across: 92 on the slide, 1.368 times the box, which
    // commits at 274 x 137, 1.37 times the height.
    for (const [fontSize, out] of [['31', '42.5px'], ['30', '41px']]) {
      const c = setup(text({ fontSize }))
      await dragFrom(c.handle('se'), { x: 46, y: 0 })
      expect(c.resizeElement).toHaveBeenCalledWith('s', 'el', { x: 100, y: 100, w: 274, h: 137 })
      expect(c.updateOverlayProp).toHaveBeenCalledWith('s', 'el', 'fontSize', out)
    }
  })

  it('previews the scale on the inner layer during the drag, and takes it off on release', async () => {
    const c = setup(text({ fontSize: '40' }))
    expect(c.inner().style.transform).toBe('scale(0.5)')
    await act(async () => {
      pointer(c.handle('nw'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: -100, clientY: -50 })
    })
    expect(c.inner().style.transform).toBe('scale(1)')
    expect(c.inner().style.transformOrigin).toBe('top left')
    await act(async () => { pointer(window, 'pointerup') })
    expect(c.inner().style.transform).toBe('scale(0.5)')
    expect(c.updateOverlayProp).toHaveBeenCalledWith('s', 'el', 'fontSize', '80px')
  })

  it('a side handle, a Shift corner and Fit to box change the box only, and preview no scale', async () => {
    const cases: Array<{ el: OverlayElement; handle: string; move?: MouseEventInit }> = [
      { el: text({ fontSize: '40' }), handle: 'e' },
      { el: text({ fontSize: '40' }), handle: 's' },
      { el: text({ fontSize: '40' }), handle: 'se', move: { shiftKey: true } },
      { el: text({ fontSize: '40', fit: 'true' }), handle: 'se' },
    ]
    for (const { el, handle, move } of cases) {
      const c = setup(el)
      await act(async () => {
        pointer(c.handle(handle), 'pointerdown', { clientX: 0, clientY: 0 })
        pointer(window, 'pointermove', { clientX: DOUBLE.x, clientY: DOUBLE.y, ...move })
      })
      expect(c.inner().style.transform).toBe('scale(0.5)')
      await act(async () => { pointer(window, 'pointerup') })
      expect(c.resizeElement).toHaveBeenCalledTimes(1)
      expect(c.updateOverlayProp).not.toHaveBeenCalled()
      expect(c.commit).toHaveBeenCalledTimes(1)
    }
  })

  it('leaves a relative font size, an overlay with no font size and an image alone', async () => {
    const image: ImageElement = { id: 'el', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 100, rotation: 0 }
    for (const el of [text({ fontSize: '2em' }), text({}), image]) {
      const c = setup(el)
      await dragFrom(c.handle('se'), DOUBLE)
      expect(c.resizeElement).toHaveBeenCalledWith('s', 'el', { x: 100, y: 100, w: 400, h: 200 })
      expect(c.updateOverlayProp).not.toHaveBeenCalled()
      expect(c.commit).toHaveBeenCalledTimes(1)
    }
  })
})

describe('scaleFontSize', () => {
  it('scales a number, a unitless string and a px length to px at half-pixel steps; other units are left', () => {
    expect(scaleFontSize(24, 2)).toBe('48px')
    expect(scaleFontSize('24px', 1.5)).toBe('36px')
    expect(scaleFontSize(' 31 ', 1.37)).toBe('42.5px')
    expect(scaleFontSize('10.25px', 1)).toBe('10.5px')
    for (const v of ['2em', '1.5rem', '50%', '4vw', 'large', '', undefined, null, NaN, -4, 0]) {
      expect(scaleFontSize(v, 2)).toBeNull()
    }
  })
})

// ── Through the real state layer: one undo step, one save ──

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function project(): Project {
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
    slides: [{ id: 'slide-0', base_color: '#ffffff', elements: [text({ fontSize: '24px' }, { w: 600, h: 150 })] }],
  } as Project
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => project()),
    saveProject: vi.fn(async (id: string, p: Project) => { saveCalls.push({ id, project: p }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out.png' }
    },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
  } as FakeAdapter
}

describe('CarouselEditor: a corner resize of a text box (§586 M8)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.setPointerCapture = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  const wrapperOf = () => {
    const els = document.querySelectorAll('[data-element-id="el"]')
    return els[els.length - 1] as HTMLElement
  }
  const placed = (p: Project) => p.slides![0].elements[0] as OverlayElement

  it('writes the box and the doubled font size in one save, and one Cmd+Z restores both', async () => {
    const adapter = makeFakeAdapter()
    render(<CarouselEditor project={project()} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => wrapperOf())
    await act(async () => { fireEvent.click(wrapperOf()) })
    // The canvas's scale, read off the box it draws.
    const scale = parseFloat(wrapperOf().style.width) / 600
    const handle = document.querySelector('[data-chrome-for="el"] [data-testid="resize-handle-se"]') as HTMLElement
    const before = adapter.saveCalls.length
    await dragFrom(handle, { x: 600 * scale, y: 150 * scale })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    const saved = placed(adapter.saveCalls[adapter.saveCalls.length - 1].project)
    expect({ w: saved.w, h: saved.h }).toEqual({ w: 1200, h: 300 })
    expect(saved.overlay.props.fontSize).toBe('48px')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true, bubbles: true }))
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 2))
    const undone = placed(adapter.saveCalls[adapter.saveCalls.length - 1].project)
    expect({ w: undone.w, h: undone.h }).toEqual({ w: 600, h: 150 })
    expect(undone.overlay.props.fontSize).toBe('24px')
  })
})
