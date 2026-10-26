import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import type { ImageElement, Slide } from '../../types'
import SlideCanvas from '../SlideCanvas'
import { NotePinLayer } from '../NoteLayers'

// ── Handles past the slide edge (§586 M4) ────────────────────────────────────
//
// The selection outline, the handles, the snap guides and the crop window's
// handles are drawn in a chrome layer over the slide that the slide does not
// clip, so an element half off the slide keeps every handle. The elements
// still clip at the slide edge, as the export does. Thumbnails are unchanged.

function image(over: Partial<ImageElement> = {}): ImageElement {
  return { id: 'el', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 100, rotation: 0, ...over }
}

const SCALE = 0.5
const MARGIN = 40
// The 1080 x 1080 slide drawn at half scale.
const SLIDE_PX = 540

type Box = { x: number; y: number; w: number; h: number }
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

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

/** Every box above `el` that clips what it holds, nearest first. */
function clipsAbove(el: Element): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let p = el.parentElement; p; p = p.parentElement) if (p.style.overflow === 'hidden') out.push(p)
  return out
}

/** The box a clip draws to, in pixels of the slide's display box. */
function frameOf(el: HTMLElement) {
  return [el.style.left, el.style.top, el.style.width, el.style.height]
}

const SLIDE_FRAME = ['0px', '0px', `${SLIDE_PX}px`, `${SLIDE_PX}px`]
const MARGIN_FRAME = [`-${MARGIN}px`, `-${MARGIN}px`, `${SLIDE_PX + 2 * MARGIN}px`, `${SLIDE_PX + 2 * MARGIN}px`]

function setup(elements: ImageElement[], extra: Partial<React.ComponentProps<typeof SlideCanvas>> = {}) {
  const spies = {
    onSelect: vi.fn(),
    moveElement: vi.fn(async () => {}),
    resizeElement: vi.fn<(slideId: string, elementId: string, box: Box) => Promise<void>>(async () => {}),
    rotateElement: vi.fn(async () => {}),
    updateImageCrop: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    onExitCrop: vi.fn(),
  }
  const r = render(
    <SlideCanvas
      slide={{ id: 's', base_color: '#ffffff', elements }}
      width={1080}
      height={1080}
      interactive
      selectedElementId={elements[0].id}
      scale={SCALE}
      margin={MARGIN}
      resolveImageSrc={(e) => e.src}
      {...spies}
      {...extra}
    />,
  )
  const q = (sel: string) => r.container.querySelector(sel) as HTMLElement
  return {
    ...spies,
    r,
    root: q('[data-interactive]'),
    wrapper: (id = elements[0].id) => q(`[data-element-id="${id}"]`),
    chrome: (id = elements[0].id) => q(`[data-chrome-for="${id}"]`),
    chromeLayer: q('[data-slide-chrome]'),
    handle: (id: Handle) => q(`[data-testid="resize-handle-${id}"]`),
    rotateHandle: () => q('[data-testid="rotate-handle"]'),
  }
}

// Half off the slide's top-left corner.
const AT_EDGE = image({ x: -100, y: -50 })

describe('SlideCanvas thumbnails (§586 M4)', () => {
  it('a thumbnail draws exactly the markup it did', () => {
    const slide: Slide = {
      id: 's',
      base_color: '#123456',
      elements: [
        image({ id: 'plain', x: -40, y: 20 }),
        image({ id: 'cropped', x: 300, y: 500, rotation: 15, crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 } }),
        image({ id: 'hidden', x: 10, y: 10 }),
      ],
    }
    const { container } = render(
      <SlideCanvas
        slide={slide}
        width={1080}
        height={1350}
        interactive={false}
        scale={0.25}
        resolveImageSrc={(e) => e.src}
        hiddenElementIds={['hidden']}
      />,
    )
    expect(container.innerHTML).toMatchInlineSnapshot(`"<div role="presentation" style="width: 270px; height: 337.5px; overflow: hidden; position: relative; flex-shrink: 0;"><div style="width: 270px; height: 337.5px; position: absolute; top: 0px; left: 0px; background-color: rgb(18, 52, 86);"><div data-element-wrapper="true" data-element-id="plain" role="presentation" style="position: absolute; left: 0px; top: 0px; width: 50px; height: 25px; transform: translate(-10px, 5px); transform-origin: center center; pointer-events: none; user-select: none; outline: none; cursor: default;"><img draggable="false" style="width: 100%; height: 100%; object-fit: contain; display: block;" alt="" src="a.png"></div><div data-element-wrapper="true" data-element-id="cropped" role="presentation" style="position: absolute; left: 0px; top: 0px; width: 50px; height: 25px; transform: translate(75px, 125px) rotate(15deg); transform-origin: center center; pointer-events: none; user-select: none; outline: none; cursor: default;"><div style="width: 100%; height: 100%; overflow: hidden;"><img draggable="false" style="display: block; width: 200%; height: 200%; max-width: none; max-height: none; transform: translate(-25%, -10%); object-fit: cover;" alt="" src="a.png"></div></div></div></div>"`)
  })
})

describe('SlideCanvas: handles past the slide edge (§586 M4)', () => {
  it('an element half off the slide shows all eight handles, clipped only at the margin, not at the slide', () => {
    const c = setup([AT_EDGE])
    for (const id of HANDLES) {
      const h = c.handle(id)
      expect(h).not.toBeNull()
      expect(c.wrapper().contains(h)).toBe(false)
      const clips = clipsAbove(h)
      expect(clips).toEqual([c.chromeLayer])
      expect(frameOf(clips[0])).toEqual(MARGIN_FRAME)
    }
    // The outline is drawn there too, not on the element.
    expect(c.chrome().style.outline).toContain('solid')
    expect(c.wrapper().style.outline).toBe('none')
  })

  it('dragging the outside corner resizes it, and the handles follow the element on every preview', async () => {
    const c = setup([AT_EDGE])
    await act(async () => {
      // 10, 5 screen px out at half scale: 20, 10 on the slide, along the diagonal.
      pointer(c.handle('nw'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: -10, clientY: -5 })
    })
    // Mid-drag: the chrome box carries the preview the wrapper does.
    expect(c.chrome().style.transform).toBe(c.wrapper().style.transform)
    expect([c.chrome().style.width, c.chrome().style.height]).toEqual([c.wrapper().style.width, c.wrapper().style.height])
    expect(parseFloat(c.chrome().style.width)).toBeCloseTo(110, 6)
    expect(parseFloat(c.chrome().style.height)).toBeCloseTo(55, 6)
    await act(async () => { pointer(window, 'pointerup', { clientX: -10, clientY: -5 }) })
    expect(c.resizeElement).toHaveBeenCalledTimes(1)
    expect(c.resizeElement).toHaveBeenCalledWith('s', 'el', { x: -120, y: -60, w: 220, h: 110 })
    expect(c.commit).toHaveBeenCalledTimes(1)
  })

  it('a drag of the element moves its outline and handles with it', async () => {
    const c = setup([AT_EDGE])
    const start = c.chrome().style.transform
    await act(async () => {
      pointer(c.wrapper(), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: 40, clientY: 20 })
    })
    expect(c.wrapper().style.transform).not.toBe(start)
    expect(c.chrome().style.transform).toBe(c.wrapper().style.transform)
    await act(async () => { pointer(window, 'pointerup', { clientX: 40, clientY: 20 }) })
    expect(c.moveElement).toHaveBeenCalledTimes(1)
  })

  it('the rotate handle of an element at the edge turns it about the element\'s centre', async () => {
    const c = setup([AT_EDGE])
    // jsdom lays nothing out: the wrapper is put with its centre at 100, 100.
    c.wrapper().getBoundingClientRect = () =>
      ({ left: 50, top: 75, width: 100, height: 50, x: 50, y: 75, right: 150, bottom: 125, toJSON: () => ({}) }) as DOMRect
    const rotate = c.rotateHandle()
    expect(c.wrapper().contains(rotate)).toBe(false)
    expect(clipsAbove(rotate)).toEqual([c.chromeLayer])
    await act(async () => {
      // From straight above the centre to straight right of it: a quarter turn.
      pointer(rotate, 'pointerdown', { clientX: 100, clientY: 60 })
      pointer(window, 'pointermove', { clientX: 140, clientY: 100 })
    })
    expect(c.wrapper().style.transform).toBe('translate(-50px, -25px) rotate(90deg)')
    expect(c.chrome().style.transform).toBe(c.wrapper().style.transform)
    await act(async () => { pointer(window, 'pointerup', { clientX: 140, clientY: 100 }) })
    expect(c.rotateElement).toHaveBeenCalledWith('s', 'el', 90)
  })

  it('the element itself still clips at the slide edge, as the export does', () => {
    const c = setup([AT_EDGE])
    const clips = clipsAbove(c.wrapper())
    expect(clips).toHaveLength(1)
    expect(frameOf(clips[0])).toEqual(SLIDE_FRAME)
    expect(clips[0].parentElement).toBe(c.root)
  })

  it('a double-click on a handle is one on the element: an image crops', async () => {
    const onEnterCrop = vi.fn()
    const c = setup([AT_EDGE], { onEnterCrop })
    await act(async () => { fireEvent.doubleClick(c.handle('se')) })
    expect(onEnterCrop).toHaveBeenCalledWith('el')
    expect(c.onSelect).not.toHaveBeenCalled()
  })

  it('a multi-selection outlines every member in the chrome layer, handles on none', () => {
    const c = setup([AT_EDGE, image({ id: 'b', x: 900, y: 900 })], { selectedElementId: null, selectedElementIds: ['el', 'b'] })
    for (const id of ['el', 'b']) expect(c.chrome(id).style.outline).toContain('solid')
    expect(c.handle('nw')).toBeNull()
  })

  it('a hidden element has no chrome', () => {
    const c = setup([AT_EDGE], { hiddenElementIds: ['el'] })
    expect(c.chrome()).toBeNull()
    expect(c.handle('nw')).toBeNull()
  })
})

describe('SlideCanvas: crop handles at the image edge are whole (§586 M4)', () => {
  it('the window\'s handles and border sit in the chrome layer; only the image area clips', async () => {
    const c = setup([AT_EDGE], { cropElementId: 'el' })
    const source = c.chrome().querySelector('img[alt="Crop source"]') as HTMLImageElement
    // 400 x 200 in the 200 x 100 box: the window is the whole box.
    await act(async () => { loadImage(source, 400, 200) })
    // M3b: the crop picture is drawn in the chrome layer too, so the image
    // area clips it, then the margin edge, never the slide.
    const area = c.chrome().querySelector('[data-testid="crop-image-area"]') as HTMLElement
    expect(clipsAbove(source)).toEqual([area, c.chromeLayer])
    for (const id of HANDLES) {
      const h = c.chrome().querySelector(`[data-testid="crop-handle-${id}"]`) as HTMLElement
      expect(h).not.toBeNull()
      expect(clipsAbove(h)).toEqual([c.chromeLayer])
    }
    expect(c.wrapper().querySelector('[data-testid="crop-handle-nw"]')).toBeNull()
    expect(clipsAbove(c.chrome().querySelector('[data-testid="crop-window"]')!)).toEqual([c.chromeLayer])
  })

  it('a cropped image at the slide edge draws its whole picture past the slide, into the margin, its handles whole (M3b)', async () => {
    // The middle half of a 400 x 100 source in the 200 x 100 box half off the
    // corner: the picture is drawn 400 x 100 from x -200, the box 100 into it.
    const c = setup([image({ x: -100, y: -50, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } })], { cropElementId: 'el' })
    const source = c.chrome().querySelector('img[alt="Crop source"]') as HTMLImageElement
    await act(async () => { loadImage(source, 400, 100) })
    const area = c.chrome().querySelector('[data-testid="crop-image-area"]') as HTMLElement
    // In display pixels of the box at half scale.
    expect(frameOf(area)).toEqual(['-50px', '0px', '200px', '50px'])
    expect(clipsAbove(source)).toEqual([area, c.chromeLayer])
    expect(frameOf(c.chrome().querySelector('[data-testid="crop-window"]') as HTMLElement)).toEqual(['0px', '0px', '100px', '50px'])
    for (const id of HANDLES) {
      const h = c.chrome().querySelector(`[data-testid="crop-handle-${id}"]`) as HTMLElement
      expect(clipsAbove(h)).toEqual([c.chromeLayer])
    }
  })

  it('a crop handle in the chrome layer still moves the window, and Esc applies it', async () => {
    const c = setup([image({ x: 0, y: 0, w: 200, h: 200 })], { cropElementId: 'el' })
    const source = c.chrome().querySelector('img[alt="Crop source"]') as HTMLImageElement
    // 400 x 200 in the 200 x 200 box at half scale: drawn 100 x 50.
    await act(async () => { loadImage(source, 400, 200) })
    const e = c.chrome().querySelector('[data-testid="crop-handle-e"]') as HTMLElement
    await act(async () => {
      pointer(e, 'pointerdown', { clientX: 100, clientY: 50 })
      pointer(e, 'pointermove', { clientX: 75, clientY: 50 })
      pointer(e, 'pointerup', { clientX: 75, clientY: 50 })
    })
    const win = c.chrome().querySelector('[data-testid="crop-window"]') as HTMLElement
    expect(win.style.width).toBe('75px')
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(c.updateImageCrop).toHaveBeenCalledTimes(1)
    const crop = (c.updateImageCrop.mock.calls[0] as unknown[])[2] as Box
    expect(crop.w).toBeCloseTo(0.75, 9)
  })
})

describe('SlideCanvas: notes and pins draw where they did (§586 M4)', () => {
  it('the host\'s layers sit in the slide box, over the elements and clipped with them', () => {
    const c = setup([AT_EDGE], {
      children: <NotePinLayer pins={[{ id: 'p1', slideId: 's', label: '1', x: 0.25, y: 0.5 }]} />,
    })
    const layer = c.r.container.querySelector('[data-note-pins]') as HTMLElement
    const slideBox = layer.parentElement as HTMLElement
    expect(frameOf(slideBox)).toEqual(SLIDE_FRAME)
    expect(slideBox.parentElement).toBe(c.root)
    expect([layer.style.width, layer.style.height]).toEqual(['100%', '100%'])
    // After the elements, so drawn over them.
    expect(c.wrapper().compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const pin = c.r.container.querySelector('[data-pin-id="p1"]') as HTMLElement
    expect([pin.style.left, pin.style.top]).toEqual(['25%', '50%'])
  })
})

describe('SlideCanvas: the margin around the page (§586 M4)', () => {
  it('spans the slide and the margin, under the slide', () => {
    const c = setup([AT_EDGE])
    const m = c.r.container.querySelector('[data-canvas-margin]') as HTMLElement
    expect(frameOf(m)).toEqual(MARGIN_FRAME)
    expect(m.parentElement).toBe(c.root)
    expect(c.root.firstElementChild).toBe(m)
  })

  it('a press and click in it is a press on the empty canvas: it deselects', async () => {
    const c = setup([AT_EDGE])
    const m = c.r.container.querySelector('[data-canvas-margin]') as HTMLElement
    await act(async () => {
      pointer(m, 'pointerdown', { clientX: 5, clientY: 5 })
      pointer(window, 'pointerup', { clientX: 5, clientY: 5 })
      fireEvent.click(m)
    })
    expect(c.onSelect).toHaveBeenCalledWith(null)
    expect(c.moveElement).not.toHaveBeenCalled()
  })

  it('a drag let go over the margin keeps the selection', async () => {
    const c = setup([AT_EDGE])
    await act(async () => {
      pointer(c.wrapper(), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: -30, clientY: 0 })
      pointer(window, 'pointerup', { clientX: -30, clientY: 0 })
      // The click goes to the nearest box holding the press and the release: the root.
      fireEvent.click(c.root)
    })
    expect(c.onSelect).not.toHaveBeenCalledWith(null)
    expect(c.moveElement).toHaveBeenCalledTimes(1)
  })

  it('a click on a handle keeps the selection', async () => {
    const c = setup([AT_EDGE])
    await act(async () => { fireEvent.click(c.handle('se')) })
    expect(c.onSelect).not.toHaveBeenCalled()
  })

  it('without a margin there is none, and the chrome clips at the slide edge', () => {
    const c = setup([AT_EDGE], { margin: undefined })
    expect(c.r.container.querySelector('[data-canvas-margin]')).toBeNull()
    expect(frameOf(c.chromeLayer)).toEqual(SLIDE_FRAME)
  })
})

describe('SlideCanvas lock badge (§586 M5b)', () => {
  it('is drawn in the chrome layer, whole for an element at the slide top-right edge', () => {
    const onUnlock = vi.fn()
    const el = image({ x: 1080 - 200, y: 0, locked: true })
    const c = setup([el], { onUnlock })
    const badge = c.chrome().querySelector<HTMLElement>('[data-testid="lock-badge"]')!
    expect(badge).not.toBeNull()
    expect(clipsAbove(badge)).toEqual([c.chromeLayer])
    expect(badge.style.pointerEvents).toBe('auto')
    // Centred on the box's top-right corner, so half of it is past the slide edge.
    expect(badge.style.right).toBeTruthy()
    fireEvent.click(badge)
    expect(onUnlock).toHaveBeenCalledWith('el')
  })

  it('is absent for an unlocked element and a press on it starts no drag', () => {
    const c = setup([image()], { onUnlock: vi.fn() })
    expect(c.chrome().querySelector('[data-testid="lock-badge"]')).toBeNull()
  })
})
