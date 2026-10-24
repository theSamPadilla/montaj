import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef } from 'react'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import type { ImageElement, OverlayElement, Slide } from '../../types'
import SlideCanvas, { type SlideCanvasCropControl } from '../SlideCanvas'

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => vi.restoreAllMocks())

function makeSlide(el: ImageElement): Slide {
  return { id: 'slide-0', base_color: '#ffffff', elements: [el] }
}

const pct = (v: string) => parseFloat(v) / 100

/**
 * The region of the source a cropped image's box shows, in fractions of the
 * source, laid out as CSS does: the image's width and height are percentages
 * of the box, a margin percentage is one of the box's WIDTH (either side), and
 * a translate percentage is one of the image's own size.
 */
function regionShown(img: HTMLImageElement, box: { w: number; h: number }) {
  const imgW = pct(img.style.width) * box.w
  const imgH = pct(img.style.height) * box.h
  let left = 0
  let top = 0
  if (img.style.marginLeft) left += pct(img.style.marginLeft) * box.w
  if (img.style.marginTop) top += pct(img.style.marginTop) * box.w
  const t = /translate\(([^,]+),\s*([^)]+)\)/.exec(img.style.transform)
  if (t) {
    left += pct(t[1]) * imgW
    top += pct(t[2]) * imgH
  }
  return { x: -left / imgW, y: -top / imgH, w: box.w / imgW, h: box.h / imgH }
}

async function croppedImg(el: ImageElement) {
  const { container } = render(
    <SlideCanvas
      slide={makeSlide(el)}
      width={1080}
      height={1080}
      interactive={false}
      scale={1}
      resolveImageSrc={(e) => e.src}
    />,
  )
  return waitFor(() => {
    const found = container.querySelector('[data-element-id="el-img"] img') as HTMLImageElement
    if (!found) throw new Error('img not rendered')
    return found
  })
}

describe('SlideCanvas crop display', () => {
  it('renders the oversized-cover crop variant when element.crop is present (non-interactive)', async () => {
    const img = await croppedImg({
      id: 'el-img',
      type: 'image',
      src: 'a.png',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      rotation: 0,
      crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 },
    })

    // Oversized cover: width = 100/cw = 200%, height = 100/ch = 200%.
    expect(img.style.width).toBe('200%')
    expect(img.style.height).toBe('200%')
    // Placed by a translate of its own size (§562): -cx*100%, -cy*100%. No margins.
    expect(img.style.transform).toBe('translate(-25%, -10%)')
    expect(img.style.marginLeft).toBe('')
    expect(img.style.marginTop).toBe('')
    expect(img.style.objectFit).toBe('cover')
    expect(img.style.display).toBe('block')
    // Tailwind-preflight defeat.
    expect(img.style.maxWidth).toBe('none')
    expect(img.style.maxHeight).toBe('none')

    // The crop wrapper clips overflow.
    const wrapper = img.parentElement as HTMLElement
    expect(wrapper.style.overflow).toBe('hidden')
  })

  // §562: a percentage margin-top is a share of the box's WIDTH, so on a box
  // that is not square a crop with a top offset showed another region.
  it('a crop with a top offset on a box that is not square shows the region picked', async () => {
    const crop = { x: 0, y: 0.25, w: 1, h: 0.5 }
    const img = await croppedImg({ id: 'el-img', type: 'image', src: 'a.png', x: 0, y: 0, w: 400, h: 200, rotation: 0, crop })
    expect(img.style.transform).toBe('translate(0%, -25%)')
    expect(img.style.marginTop).toBe('')
    const shown = regionShown(img, { w: 400, h: 200 })
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(shown[k]).toBeCloseTo(crop[k], 9)
  })

  it('renders plain contain (no crop wrapper) when element.crop is absent', async () => {
    const el: ImageElement = {
      id: 'el-img',
      type: 'image',
      src: 'a.png',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      rotation: 0,
    }
    const { container } = render(
      <SlideCanvas
        slide={makeSlide(el)}
        width={1080}
        height={1080}
        interactive={false}
        scale={1}
        resolveImageSrc={(e) => e.src}
      />,
    )

    const img = await waitFor(() => {
      const found = container.querySelector('[data-element-id="el-img"] img') as HTMLImageElement
      if (!found) throw new Error('img not rendered')
      return found
    })
    // Uncropped images use `contain` to mirror the renderer (no-crop branch in
    // render/templates/slide.jsx) so logos/escudos keep aspect in both paths.
    expect(img.style.objectFit).toBe('contain')
    expect(img.style.width).toBe('100%')
    expect(img.style.height).toBe('100%')
  })
})

// ── Crop mode (§556 M4) ──────────────────────────────────────────────────────
//
// The crop being picked lives here until crop mode ends. Every way out applies
// it as one write, or writes nothing when it is the crop the image already has.
// A change to the slide meanwhile keeps the window; a new file starts it again
// from the new file's crop; the image going away ends crop mode, writing nothing.

type Crop = { x: number; y: number; w: number; h: number }

const IMG: ImageElement = { id: 'el-img', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 200, rotation: 0 }
const OTHER: ImageElement = { id: 'el-b', type: 'image', src: 'b.png', x: 500, y: 500, w: 100, h: 100, rotation: 0 }
const TEXT: OverlayElement = {
  id: 'el-text',
  type: 'overlay',
  overlay: { template: '/overlays/text.jsx', props: { text: 'Hello' } },
  frame: 0,
  x: 600, y: 100, w: 300, h: 100, rotation: 0,
}

function slideWith(...elements: Slide['elements']): Slide {
  return { id: 'slide-0', base_color: '#ffffff', elements }
}

// jsdom has no pointer capture.
const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn()
})
afterEach(() => {
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

// This jsdom has no PointerEvent: a MouseEvent named for the pointer event
// carries clientX/Y, and React handles it by its name.
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

// jsdom never loads an image: give it a size and fire its load.
function loadImage(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(img)
}

function mountCanvas(slide: Slide, extra: Partial<React.ComponentProps<typeof SlideCanvas>> = {}) {
  const fns = {
    resizeElement: vi.fn(async (_slideId: string, _elementId: string, _box: Crop) => {}),
    updateImageCrop: vi.fn(async (_slideId: string, _elementId: string, _crop: Crop | undefined) => {}),
    commit: vi.fn(async () => {}),
    onExitCrop: vi.fn(),
    onSelect: vi.fn(),
    onEnterCrop: vi.fn(),
  }
  const props = (s: Slide, more: Partial<React.ComponentProps<typeof SlideCanvas>> = {}) => (
    <SlideCanvas
      slide={s}
      width={1080}
      height={1080}
      interactive
      scale={1}
      resolveImageSrc={(e) => e.src}
      selectedElementId="el-img"
      cropElementId="el-img"
      {...fns}
      {...extra}
      {...more}
    />
  )
  const r = render(props(slide))
  return { r, fns, rerender: (s: Slide, more: Partial<React.ComponentProps<typeof SlideCanvas>> = {}) => r.rerender(props(s, more)) }
}

function wrapperOf(id: string): HTMLElement {
  return document.querySelector(`[data-element-id="${id}"]`) as HTMLElement
}
function cropSource(id = 'el-img'): HTMLImageElement | null {
  return wrapperOf(id).querySelector('img[alt="Crop source"]')
}
function cropWindow(id = 'el-img'): HTMLElement | null {
  return wrapperOf(id).querySelector('[data-testid="crop-window"]')
}
function boxOf(el: HTMLElement | null) {
  if (!el) throw new Error('no crop window')
  return [el.style.left, el.style.top, el.style.width, el.style.height]
}

// The 400 x 200 source in the 200 x 200 box is drawn 200 x 100, 50 px down.
async function loadSource(w = 400, h = 200) {
  await act(async () => { loadImage(cropSource()!, w, h) })
}

/** Drags the window's right edge 50 px in: the window becomes {0, 0, 0.75, 1}. */
async function dragRightEdgeIn() {
  const handle = wrapperOf('el-img').querySelector('[data-testid="crop-handle-e"]') as HTMLElement
  await act(async () => {
    pointer(handle, 'pointerdown', { clientX: 200, clientY: 100 })
    pointer(handle, 'pointermove', { clientX: 150, clientY: 100 })
    pointer(handle, 'pointerup', { clientX: 150, clientY: 100 })
  })
}

async function esc() {
  const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
  await act(async () => { window.dispatchEvent(e) })
  return e
}

function expectCrop(actual: unknown, expected: Crop) {
  const c = actual as Crop
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(c[k]).toBeCloseTo(expected[k], 9)
}

describe('SlideCanvas: crop mode (§556 M4)', () => {
  it('Esc applies the picked window: the box takes its shape, then the crop, then a commit, then crop mode ends', async () => {
    const { fns } = mountCanvas(slideWith(IMG))
    await loadSource()
    await dragRightEdgeIn()

    const e = await esc()
    expect(e.defaultPrevented).toBe(true)
    // 0.75 of 400 by 200 is 3:2, so the 200 wide box is 133 tall.
    expect(fns.resizeElement).toHaveBeenCalledTimes(1)
    expect(fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', { x: 100, y: 100, w: 200, h: 133 })
    expect(fns.updateImageCrop).toHaveBeenCalledTimes(1)
    expect(fns.updateImageCrop.mock.calls[0].slice(0, 2)).toEqual(['slide-0', 'el-img'])
    expectCrop(fns.updateImageCrop.mock.calls[0][2], { x: 0, y: 0, w: 0.75, h: 1 })
    expect(fns.commit).toHaveBeenCalledTimes(1)
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
    expect(cropSource()).toBeNull()
  })

  it('a crop that changes nothing writes nothing: no crop, no new box, no commit', async () => {
    const { fns } = mountCanvas(slideWith(IMG))
    await loadSource()
    await esc()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
    expect(cropSource()).toBeNull()
  })

  it('the crop the image already has, or a window dragged back to it, writes nothing', async () => {
    const stored = { x: 0.25, y: 0, w: 0.5, h: 1 }
    const { fns } = mountCanvas(slideWith({ ...IMG, crop: stored }))
    await loadSource()
    const move = wrapperOf('el-img').querySelector('[data-testid="crop-move"]') as HTMLElement
    await act(async () => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 133, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 100, clientY: 100 })
      pointer(move, 'pointerup', { clientX: 100, clientY: 100 })
    })
    await esc()
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
  })

  it('moving the window keeps its size, so the box keeps its shape: only the crop is written', async () => {
    const { fns } = mountCanvas(slideWith({ ...IMG, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }))
    await loadSource()
    const move = wrapperOf('el-img').querySelector('[data-testid="crop-move"]') as HTMLElement
    await act(async () => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 60, clientY: 100 })
      pointer(move, 'pointerup', { clientX: 60, clientY: 100 })
    })
    await esc()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expectCrop(fns.updateImageCrop.mock.calls[0][2], { x: 0.05, y: 0, w: 0.5, h: 1 })
    expect(fns.commit).toHaveBeenCalledTimes(1)
  })

  it('a change to the slide during crop keeps the overlay and the window picked so far', async () => {
    const { fns, rerender } = mountCanvas(slideWith(IMG, OTHER))
    await loadSource()
    await dragRightEdgeIn()
    const source = cropSource()
    const before = boxOf(cropWindow())

    // Another element moves (an edit from the panel, or another writer).
    await act(async () => { rerender(slideWith(IMG, { ...OTHER, x: 600 })) })
    expect(cropSource()).toBe(source)
    expect(boxOf(cropWindow())).toEqual(before)
    // The image itself moves: the window stays the same part of it.
    await act(async () => { rerender(slideWith({ ...IMG, x: 300 }, { ...OTHER, x: 600 })) })
    expect(cropSource()).toBe(source)
    expect(boxOf(cropWindow())).toEqual(before)

    await esc()
    expect(fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', { x: 300, y: 100, w: 200, h: 133 })
    expectCrop(fns.updateImageCrop.mock.calls[0][2], { x: 0, y: 0, w: 0.75, h: 1 })
  })

  it('a new file for the image (a Replace landing) starts the window again from its own crop', async () => {
    const { fns, rerender } = mountCanvas(slideWith(IMG))
    await loadSource()
    await dragRightEdgeIn()

    const replaced = { ...IMG, src: 'new.png', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }
    await act(async () => { rerender(slideWith(replaced)) })
    expect(cropSource()!.getAttribute('src')).toBe('new.png')
    // Its size is not known until it loads.
    expect(cropWindow()).toBeNull()
    await loadSource()
    expect(boxOf(cropWindow())).toEqual(['50px', '50px', '100px', '100px'])

    // The window is the new file's own crop: nothing to write.
    await esc()
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
  })

  it('the image going away ends crop mode and writes nothing', async () => {
    const { fns, rerender } = mountCanvas(slideWith(IMG, OTHER))
    await loadSource()
    await dragRightEdgeIn()

    await act(async () => { rerender(slideWith(OTHER)) })
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
    await esc()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
  })

  it('the host leaves through the handle: apply writes the window and resolves after it; discard writes nothing', async () => {
    const control = createRef<SlideCanvasCropControl>()
    const { fns } = mountCanvas(slideWith(IMG), { cropControlRef: control })
    await loadSource()
    await dragRightEdgeIn()

    await act(async () => { await control.current!.leave('discard') })
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
    expect(cropSource()).toBeNull()
  })

  it('apply through the handle waits for the writes, and a second leave does nothing', async () => {
    const control = createRef<SlideCanvasCropControl>()
    let landed!: () => void
    const save = new Promise<void>((res) => { landed = res })
    const { fns } = mountCanvas(slideWith(IMG), { cropControlRef: control, updateImageCrop: vi.fn(() => save) })
    await loadSource()
    await dragRightEdgeIn()

    let done = false
    await act(async () => { void control.current!.leave('apply').then(() => { done = true }) })
    expect(fns.resizeElement).toHaveBeenCalledTimes(1)
    expect(fns.commit).toHaveBeenCalledTimes(1)
    expect(done).toBe(false)
    await act(async () => { landed(); await save })
    expect(done).toBe(true)

    await act(async () => { await control.current!.leave('apply') })
    expect(fns.resizeElement).toHaveBeenCalledTimes(1)
    expect(fns.commit).toHaveBeenCalledTimes(1)
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
  })

  it('a click after a window drag let go off the image changes nothing; a later click on the canvas still selects nothing', async () => {
    const { fns } = mountCanvas(slideWith({ ...IMG, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }))
    await loadSource()
    const move = wrapperOf('el-img').querySelector('[data-testid="crop-move"]') as HTMLElement
    const canvas = document.querySelector('[data-interactive]') as HTMLElement
    await act(async () => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 400, clientY: 100 })
      pointer(move, 'pointerup', { clientX: 400, clientY: 100 })
      // The browser may send the click to the canvas, holding both press and release.
      fireEvent.click(canvas)
    })
    expect(fns.onSelect).not.toHaveBeenCalled()
    expect(cropSource()).not.toBeNull()

    await act(async () => {
      pointer(canvas, 'pointerdown', { clientX: 900, clientY: 900 })
      pointer(canvas, 'pointerup', { clientX: 900, clientY: 900 })
      fireEvent.click(canvas)
    })
    expect(fns.onSelect).toHaveBeenCalledWith(null)
  })
})

describe('SlideCanvas: double-click (§556 M4)', () => {
  function mountIdle(slide: Slide) {
    return mountCanvas(slide, { cropElementId: null, selectedElementId: null })
  }

  it('double-click on an image enters crop', async () => {
    const { fns } = mountIdle(slideWith(IMG))
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-img')) })
    expect(fns.onEnterCrop).toHaveBeenCalledWith('el-img')
  })

  it('a rotated image does nothing on double-click', async () => {
    const { fns } = mountIdle(slideWith({ ...IMG, rotation: 10 }))
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-img')) })
    expect(fns.onEnterCrop).not.toHaveBeenCalled()
  })

  it('double-click on the image already in crop does not enter it again', async () => {
    const { fns } = mountCanvas(slideWith(IMG))
    await loadSource()
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-img').querySelector('[data-testid="crop-move"]') ?? wrapperOf('el-img')) })
    expect(fns.onEnterCrop).not.toHaveBeenCalled()
  })

  it('double-click on text still opens the text editor, and never enters crop', async () => {
    const { fns, r } = mountIdle(slideWith(IMG, TEXT))
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-text')) })
    expect(r.getByRole('textbox', { name: 'Edit text' })).toBeTruthy()
    expect(fns.onEnterCrop).not.toHaveBeenCalled()
  })

  it('without onEnterCrop, double-click on an image does nothing', async () => {
    const { fns } = mountCanvas(slideWith(IMG), { cropElementId: null, selectedElementId: null, onEnterCrop: undefined })
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-img')) })
    expect(fns.onEnterCrop).not.toHaveBeenCalled()
    expect(cropSource()).toBeNull()
  })
})
