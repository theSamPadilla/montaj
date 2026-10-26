import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef } from 'react'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import type { ImageElement, OverlayElement, Slide } from '../../types'
import SlideCanvas, { type SlideCanvasCropControl } from '../SlideCanvas'
import { croppedBox, drawnSourceRect } from '../../crop/crop-math'

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

/** The element's box in the canvas's chrome layer (§586 M4): its outline and handles; an empty box when it is not outlined. */
function chromeOf(elementId: string): HTMLElement {
  return (document.querySelector(`[data-chrome-for="${elementId}"]`) as HTMLElement | null) ?? document.createElement('div')
}
/** The crop overlay draws in the chrome layer, so the picture can reach past the slide (M3b). */
function cropSource(id = 'el-img'): HTMLImageElement | null {
  return chromeOf(id).querySelector('img[alt="Crop source"]')
}
function cropMove(id = 'el-img'): HTMLElement {
  return chromeOf(id).querySelector('[data-testid="crop-move"]') as HTMLElement
}
function cropWindow(id = 'el-img'): HTMLElement | null {
  return chromeOf(id).querySelector('[data-testid="crop-window"]')
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
  const handle = chromeOf('el-img').querySelector('[data-testid="crop-handle-e"]') as HTMLElement
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
    // M3a: the box takes the kept region's place on the slide. The 400 x 200
    // source is drawn 200 x 100, 50 down; its left three quarters are 150 x 100.
    expect(fns.resizeElement).toHaveBeenCalledTimes(1)
    expect(fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', { x: 100, y: 150, w: 150, h: 100 })
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
    const move = cropMove()
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

  it('moving the window keeps its size, so the box keeps its shape: the box moves to where the kept part was drawn', async () => {
    const { fns } = mountCanvas(slideWith({ ...IMG, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }))
    await loadSource()
    const move = cropMove()
    await act(async () => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 60, clientY: 100 })
      pointer(move, 'pointerup', { clientX: 60, clientY: 100 })
    })
    await esc()
    // M3b: the picture is drawn 400 wide from x 0, so 40 px is a tenth of it
    // and the box moves 40 left.
    expect(fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', { x: 60, y: 100, w: 200, h: 200 })
    expectCrop(fns.updateImageCrop.mock.calls[0][2], { x: 0.15, y: 0, w: 0.5, h: 1 })
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
    expect(fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', { x: 300, y: 150, w: 150, h: 100 })
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
    // M3b: the window on the new file's crop is the box.
    expect(boxOf(cropWindow())).toEqual(['0px', '0px', '200px', '200px'])

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
    const move = cropMove()
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

// ── Re-crop at the current scale (M3b) ───────────────────────────────────────
//
// Crop mode draws the whole picture where it is drawn on the slide now, at its
// scale, past the box. The window starts on the box, so the kept part lands on
// the slide exactly where the window was drawn.

describe('SlideCanvas: re-crop at the current scale (M3b)', () => {
  // The middle half of the 400 x 200 source in the 200 x 200 box at (100, 100):
  // the picture is drawn 400 x 200 from (0, 100).
  const CROP = { x: 0.25, y: 0, w: 0.5, h: 1 }
  const CROPPED: ImageElement = { ...IMG, crop: CROP }
  const SRC = { width: 400, height: 200 }

  function imageArea(): HTMLElement {
    return chromeOf('el-img').querySelector('[data-testid="crop-image-area"]') as HTMLElement
  }
  /** A box drawn in pixels of the element's box, in slide units. */
  function inSlide(el: HTMLElement, box: { x: number; y: number }, scale: number) {
    const px = (v: string) => parseFloat(v) / scale
    return { x: box.x + px(el.style.left), y: box.y + px(el.style.top), w: px(el.style.width), h: px(el.style.height) }
  }
  async function drag(target: HTMLElement, dx: number, dy: number) {
    await act(async () => {
      pointer(target, 'pointerdown', { clientX: 500, clientY: 500 })
      pointer(target, 'pointermove', { clientX: 500 + dx, clientY: 500 + dy })
      pointer(target, 'pointerup', { clientX: 500 + dx, clientY: 500 + dy })
    })
  }
  const handle = (id: string) => chromeOf('el-img').querySelector(`[data-testid="crop-handle-${id}"]`) as HTMLElement

  it('the whole picture is drawn at its scale on the slide: its kept region is the box, and the window starts on it', async () => {
    mountCanvas(slideWith(CROPPED), { scale: 0.5 })
    await loadSource()
    const picture = inSlide(imageArea(), CROPPED, 0.5)
    expectCrop(picture, { x: 0, y: 100, w: 400, h: 200 })
    // The crop's region of it is the box.
    expectCrop(
      { x: picture.x + CROP.x * picture.w, y: picture.y + CROP.y * picture.h, w: CROP.w * picture.w, h: CROP.h * picture.h },
      { x: 100, y: 100, w: 200, h: 200 },
    )
    expectCrop(inSlide(cropWindow()!, CROPPED, 0.5), { x: 100, y: 100, w: 200, h: 200 })
    expect(cropSource()!.style.visibility).toBe('')
  })

  it('the element\'s own picture is hidden under the crop picture, and shows again after', async () => {
    mountCanvas(slideWith(CROPPED))
    const own = () => wrapperOf('el-img').firstElementChild as HTMLElement
    // Until the size is known the crop picture is not drawn, so the image shows.
    expect(own().style.visibility).toBe('')
    await loadSource()
    expect(own().style.visibility).toBe('hidden')
    await esc()
    expect(own().style.visibility).toBe('')
  })

  it('moving the window right by N moves the box right by N at its size and the picture\'s scale', async () => {
    const { fns } = mountCanvas(slideWith(CROPPED))
    await loadSource()
    await drag(cropMove(), 40, 0)
    expectCrop(inSlide(cropWindow()!, CROPPED, 1), { x: 140, y: 100, w: 200, h: 200 })
    await esc()
    const box = fns.resizeElement.mock.calls[0][2]
    expect(box).toEqual({ x: 140, y: 100, w: 200, h: 200 })
    const crop = fns.updateImageCrop.mock.calls[0][2] as Crop
    expectCrop(crop, { x: 0.35, y: 0, w: 0.5, h: 1 })
    // The picture is drawn where it was, at the size it was.
    const after = drawnSourceRect(box, crop, SRC)
    expectCrop({ x: box.x + after.offsetX, y: box.y + after.offsetY, w: after.width, h: after.height }, { x: 0, y: 100, w: 400, h: 200 })
  })

  it('re-cropping back to the full frame gives the box the whole picture takes at that scale', async () => {
    const { fns } = mountCanvas(slideWith(CROPPED))
    await loadSource()
    await drag(handle('nw'), -1000, -1000)
    await drag(handle('se'), 1000, 1000)
    expectCrop(inSlide(cropWindow()!, CROPPED, 1), { x: 0, y: 100, w: 400, h: 200 })
    await esc()
    expect(fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', { x: 0, y: 100, w: 400, h: 200 })
    expectCrop(fns.updateImageCrop.mock.calls[0][2], { x: 0, y: 0, w: 1, h: 1 })
  })

  it('on a box a side resize changed, the window starts on the box and applying it writes nothing', async () => {
    // 300 x 200 on the same crop: the picture is drawn 600 x 300 from (-50, 50).
    const stretched = { ...CROPPED, w: 300 }
    const { fns } = mountCanvas(slideWith(stretched))
    await loadSource()
    expectCrop(inSlide(imageArea(), stretched, 1), { x: -50, y: 50, w: 600, h: 300 })
    expectCrop(inSlide(cropWindow()!, stretched, 1), { x: 100, y: 100, w: 300, h: 200 })
    await esc()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
  })

  it('a letterboxed uncropped image: the window starts on the picture\'s contain rect, unmoved writes nothing, moved gives croppedBox\'s box', async () => {
    // A 16:9 source in the 200 x 200 box is drawn 200 x 112.5, 43.75 down.
    const src = { width: 1600, height: 900 }
    const { fns } = mountCanvas(slideWith(IMG))
    await loadSource(src.width, src.height)
    expectCrop(inSlide(cropWindow()!, IMG, 1), { x: 100, y: 143.75, w: 200, h: 112.5 })
    expectCrop(inSlide(imageArea(), IMG, 1), { x: 100, y: 143.75, w: 200, h: 112.5 })
    await esc()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()

    // Again: the right edge 50 in, then the window 20 right.
    const again = mountCanvas(slideWith(IMG))
    await act(async () => { loadImage(again.r.container.querySelector('img[alt="Crop source"]') as HTMLImageElement, src.width, src.height) })
    const inThis = (sel: string) => again.r.container.querySelector(sel) as HTMLElement
    await drag(inThis('[data-testid="crop-handle-e"]'), -50, 0)
    await drag(inThis('[data-testid="crop-move"]'), 20, 0)
    await esc()
    const crop = again.fns.updateImageCrop.mock.calls[0][2] as Crop
    expectCrop(crop, { x: 0.1, y: 0, w: 0.75, h: 1 })
    const want = croppedBox(IMG, undefined, crop, src)
    expect(want.x).toBeCloseTo(120, 9)
    expect(want.y).toBeCloseTo(143.75, 9)
    expect(again.fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', {
      x: Math.round(want.x), y: Math.round(want.y), w: Math.round(want.w), h: Math.round(want.h),
    })
  })

  it('a source that fails to load leaves the element\'s own picture showing in crop mode, and writes nothing', async () => {
    const { fns } = mountCanvas(slideWith(CROPPED))
    await act(async () => { fireEvent.error(cropSource()!) })
    expect((wrapperOf('el-img').firstElementChild as HTMLElement).style.visibility).toBe('')
    expect(cropSource()!.style.visibility).toBe('hidden')
    expect(cropWindow()).toBeNull()
    await esc()
    expect(fns.resizeElement).not.toHaveBeenCalled()
    expect(fns.updateImageCrop).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
  })

  it('on that box, a window moved right by N moves the box right by N at its size', async () => {
    const stretched = { ...CROPPED, w: 300 }
    const { fns } = mountCanvas(slideWith(stretched))
    await loadSource()
    await drag(cropMove(), 30, 0)
    await esc()
    expect(fns.resizeElement).toHaveBeenCalledWith('slide-0', 'el-img', { x: 130, y: 100, w: 300, h: 200 })
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
    await act(async () => { fireEvent.doubleClick(cropMove() ?? wrapperOf('el-img')) })
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
