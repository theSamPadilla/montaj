import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { ImageElement } from '../../types'
import { CanvasCropOverlay } from '../CanvasCropOverlay'

// ── The crop window moves as a whole (§556 M4) ───────────────────────────────
//
// A press inside the window drags it: same size, kept inside the image. The
// eight handles still resize it, and sit above the move layer.

type Crop = { x: number; y: number; w: number; h: number }

// jsdom has no pointer capture.
const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn()
})
afterEach(() => {
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
  vi.restoreAllMocks()
})

// This jsdom has no PointerEvent: a MouseEvent named for the pointer event
// carries clientX/Y, and React handles it by its name.
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

// A 400 x 200 source in a 200 x 200 box at scale 1: drawn 200 x 100, 50 px down.
const element: ImageElement = { id: 'el', type: 'image', src: 'a.png', x: 0, y: 0, w: 200, h: 200, rotation: 0 }
const SRC = { width: 400, height: 200 }

function mount(localCrop: Crop, extra: Partial<React.ComponentProps<typeof CanvasCropOverlay>> = {}) {
  const onLocalCropChange = vi.fn()
  const r = render(
    <CanvasCropOverlay
      element={element}
      resolveImageSrc={(e) => e.src}
      scale={1}
      localCrop={localCrop}
      onLocalCropChange={onLocalCropChange}
      onSrcDimsLoaded={vi.fn()}
      srcDims={SRC}
      {...extra}
    />,
  )
  const move = r.getByTestId('crop-move')
  return { r, move, onLocalCropChange }
}

function lastCrop(spy: ReturnType<typeof vi.fn>): Crop {
  return spy.mock.calls[spy.mock.calls.length - 1][0] as Crop
}

function expectCrop(actual: Crop, expected: Crop) {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(actual[k]).toBeCloseTo(expected[k], 9)
}

describe('CanvasCropOverlay: the window moves as a whole (§556 M4)', () => {
  it('a move layer covers the window, with the move cursor, under the handles', () => {
    // The window {0.25, 0, 0.5, 1} is 100 x 100 at (50, 50).
    const { r, move } = mount({ x: 0.25, y: 0, w: 0.5, h: 1 })
    expect(move.style.left).toBe('50px')
    expect(move.style.top).toBe('50px')
    expect(move.style.width).toBe('100px')
    expect(move.style.height).toBe('100px')
    expect(move.style.cursor).toBe('move')
    expect(move.style.pointerEvents).toBe('auto')
    // Under the handles: a lower layer, and drawn before them.
    const handle = r.getByTestId('crop-handle-nw')
    expect(Number(move.style.zIndex)).toBeLessThan(Number(handle.style.zIndex))
    expect(move.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('dragging inside the window pans it by the pointer, keeping its size, and takes the pointer', () => {
    const { move, onLocalCropChange } = mount({ x: 0.25, y: 0, w: 0.5, h: 1 })
    act(() => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 70, clientY: 100 })
    })
    expect(Element.prototype.setPointerCapture).toHaveBeenCalled()
    // 30 px left in a source drawn 200 px wide: 0.15 of it.
    expectCrop(lastCrop(onLocalCropChange), { x: 0.1, y: 0, w: 0.5, h: 1 })
    act(() => { pointer(move, 'pointerup', { clientX: 70, clientY: 100 }) })
  })

  it('the window stays inside the image, at its size, however far it is dragged', () => {
    const { move, onLocalCropChange } = mount({ x: 0.25, y: 0, w: 0.5, h: 1 })
    act(() => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 900, clientY: 900 })
    })
    expectCrop(lastCrop(onLocalCropChange), { x: 0.5, y: 0, w: 0.5, h: 1 })
    act(() => { pointer(move, 'pointermove', { clientX: -900, clientY: -900 }) })
    expectCrop(lastCrop(onLocalCropChange), { x: 0, y: 0, w: 0.5, h: 1 })
    act(() => { pointer(move, 'pointerup') })
  })

  it('each move is measured from where the press began, and a move after the release does nothing', () => {
    const { move, onLocalCropChange } = mount({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    act(() => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointermove', { clientX: 110, clientY: 90 })
      pointer(move, 'pointermove', { clientX: 120, clientY: 80 })
    })
    // 20 px right (0.1), 20 px up in a source drawn 100 px tall (0.2).
    expectCrop(lastCrop(onLocalCropChange), { x: 0.35, y: 0.05, w: 0.5, h: 0.5 })
    act(() => { pointer(move, 'pointerup') })
    const calls = onLocalCropChange.mock.calls.length
    act(() => { pointer(move, 'pointermove', { clientX: 150, clientY: 150 }) })
    expect(onLocalCropChange.mock.calls.length).toBe(calls)
  })

  it('a handle still resizes the window', () => {
    const { r, onLocalCropChange } = mount({ x: 0.25, y: 0, w: 0.5, h: 1 })
    const e = r.getByTestId('crop-handle-e')
    act(() => {
      pointer(e, 'pointerdown', { clientX: 150, clientY: 100 })
      pointer(e, 'pointermove', { clientX: 170, clientY: 100 })
      pointer(e, 'pointerup', { clientX: 170, clientY: 100 })
    })
    expectCrop(lastCrop(onLocalCropChange), { x: 0.25, y: 0, w: 0.6, h: 1 })
  })

  it('tells when a press on the window or a handle is let go', () => {
    const onDragEnd = vi.fn()
    const { r, move } = mount({ x: 0.25, y: 0, w: 0.5, h: 1 }, { onDragEnd })
    act(() => {
      pointer(move, 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(move, 'pointerup', { clientX: 100, clientY: 100 })
    })
    expect(onDragEnd).toHaveBeenCalledTimes(1)
    const handle = r.getByTestId('crop-handle-se')
    act(() => {
      pointer(handle, 'pointerdown', { clientX: 150, clientY: 150 })
      pointer(handle, 'pointerup', { clientX: 150, clientY: 150 })
    })
    expect(onDragEnd).toHaveBeenCalledTimes(2)
  })
})
