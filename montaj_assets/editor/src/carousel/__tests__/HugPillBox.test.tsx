import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import type { OverlayElement } from '../../types'
import SlideCanvas from '../SlideCanvas'
import { requestFit } from '../fitRequests'

// A hugging pill's element box IS the pill: outline, handles and knob wrap it,
// a saved wide box shows fitted without being written, and a gesture writes
// the box it shows.

const compile = vi.fn(async () => (_f: number, _fps: number, _d: number, props: Record<string, unknown>) => (
  <div data-testid="pill" data-montaj-pill="" data-align={String(props.textAlign)}>
    <p data-montaj-text="">{String(props.text)}</p>
  </div>
))

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect

// The pill is `pillW` x 40, flush left in its layer and centred vertically.
let pillW = 120
function mockRects() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const layer = this.closest('[data-overlay-layer]') as HTMLElement | null
    if (this.hasAttribute('data-overlay-layer')) return box(0, 0, parseFloat(this.style.width), parseFloat(this.style.height))
    if (this.hasAttribute('data-montaj-pill') && layer) return box(0, (parseFloat(layer.style.height) - 40) / 2, pillW, 40)
    return box(0, 0, 0, 0)
  })
}

function pillEl(over: Partial<OverlayElement> = {}): OverlayElement {
  return {
    id: 'pill', type: 'overlay', frame: 0, x: 100, y: 100, w: 400, h: 120, rotation: 0,
    overlay: { template: '/t/h.jsx', props: { text: 'Pill', textAlign: 'left', hug: 'true' } },
    ...over,
  } as OverlayElement
}

async function mount(el: OverlayElement, opts: { interactive?: boolean } = {}) {
  const spies = {
    editElements: vi.fn(async () => {}),
    moveElement: vi.fn(async () => {}),
    resizeElement: vi.fn(async () => {}),
    rotateElement: vi.fn(async () => {}),
    updateOverlayProp: vi.fn(async () => {}),
    updateOverlayProps: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  }
  const canvas = (e: OverlayElement) => (
    <SlideCanvas
      slide={{ id: 's', base_color: '#ffffff', elements: [e] }}
      width={1080} height={1080} interactive={opts.interactive ?? true} selectedElementId={e.id} scale={0.5}
      compileOverlay={compile as never} onSelect={vi.fn()} {...spies}
    />
  )
  const r = render(canvas(el))
  const again = async (e: OverlayElement) => { await act(async () => { r.rerender(canvas(e)); await new Promise((res) => setTimeout(res, 20)) }) }
  await waitFor(() => expect(r.container.querySelector('[data-montaj-pill]')).not.toBeNull())
  const q = (sel: string) => r.container.querySelector(sel) as HTMLElement
  // A box as drawn, in slide px.
  const at = (e: HTMLElement) => {
    const [tx, ty] = (/translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(e.style.transform) ?? ['', '0', '0']).slice(1).map(Number)
    return [tx * 2, ty * 2, parseFloat(e.style.width) * 2, parseFloat(e.style.height) * 2]
  }
  return { r, q, at, again, ...spies, wrapper: () => q('[data-element-id="pill"]'), chrome: () => q('[data-chrome-for="pill"]') }
}

type PointerInit = MouseEventInit
const pointer = (target: EventTarget, type: string, init: PointerInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))

beforeEach(() => {
  pillW = 120
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => { vi.restoreAllMocks() })

describe('a hugging pill is its own element box', () => {
  it('a saved wide box shows fitted to the pill, outline and handles included', async () => {
    mockRects()
    const t = await mount(pillEl())
    // Flush left, centred vertically: x stays, y moves down by (120 - 40) / 2.
    await waitFor(() => expect(t.at(t.wrapper())).toEqual([100, 140, 120, 40]))
    expect(t.at(t.chrome())).toEqual([100, 140, 120, 40])
    expect(t.q('[data-testid="resize-handle-se"]')).not.toBeNull()
  })

  async function shown(t: Awaited<ReturnType<typeof mount>>) {
    await waitFor(() => expect(t.at(t.wrapper())[2]).toBe(pillW))
  }
  const boxOf = (call: unknown[], from: OverlayElement) => {
    const out = (call[1] as (e: unknown[]) => Array<Record<string, number>>)([from])[0]
    return [out.x, out.y, out.w, out.h]
  }
  const nothingWritten = (t: Awaited<ReturnType<typeof mount>>) => {
    for (const spy of [t.editElements, t.moveElement, t.resizeElement, t.rotateElement, t.updateOverlayProp, t.updateOverlayProps, t.commit]) {
      expect(spy).not.toHaveBeenCalled()
    }
  }

  it('opening, selecting and re-rendering an old wide box write nothing', async () => {
    mockRects()
    const t = await mount(pillEl())
    await shown(t)
    await t.again(pillEl())
    await t.again(pillEl({ x: 100, y: 100, w: 400, h: 121 }))
    nothingWritten(t)
  })

  it('a box that is already the pill is not written either', async () => {
    mockRects()
    const t = await mount(pillEl({ x: 100, y: 140, w: 120, h: 40 }))
    await t.again(pillEl({ x: 100, y: 140, w: 120, h: 40 }))
    nothingWritten(t)
  })

  it('a fit request stores the re-measured box once, and only when asked', async () => {
    mockRects()
    const t = await mount(pillEl({ x: 100, y: 140, w: 120, h: 40 }))
    pillW = 200
    const bigger = pillEl({ x: 100, y: 140, w: 120, h: 40, overlay: { template: '/t/h.jsx', props: { text: 'Pill', textAlign: 'left', hug: 'true', fontSize: '60' } } } as Partial<OverlayElement>)
    await t.again(bigger)
    expect(t.editElements).not.toHaveBeenCalled()  // shown fitted, not written
    await act(async () => { await requestFit('s', 'pill') })
    expect(t.editElements).toHaveBeenCalledTimes(1)
    expect(boxOf(t.editElements.mock.calls[0], bigger)).toEqual([100, 140, 200, 40])
  })

  it('a fit request for a canvas that is not editing-ready, locked or read-only writes nothing and still resolves', async () => {
    mockRects()
    const ro = await mount(pillEl(), { interactive: false })
    await act(async () => { await requestFit('s', 'pill') })
    expect(ro.editElements).not.toHaveBeenCalled()
    ro.r.unmount()
    const locked = await mount(pillEl({ locked: true } as Partial<OverlayElement>))
    await shown(locked)
    await act(async () => { await requestFit('s', 'pill') })
    expect(locked.editElements).not.toHaveBeenCalled()
  })

  it('a resize stores the pill-fitted box after the dragged one', async () => {
    mockRects()
    const t = await mount(pillEl())
    await shown(t)
    await act(async () => {
      pointer(t.q('[data-testid="resize-handle-e"]'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: 20, clientY: 0 })
      pointer(window, 'pointerup', { clientX: 20, clientY: 0 })
    })
    expect(t.resizeElement).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(t.editElements).toHaveBeenCalledTimes(1))
    expect(boxOf(t.editElements.mock.calls[0], pillEl())[2]).toBe(120)
  })

  it('a drag writes the shown box with the move, in one step', async () => {
    mockRects()
    const t = await mount(pillEl())
    await shown(t)
    await act(async () => {
      pointer(t.wrapper(), 'pointerdown', { clientX: 10, clientY: 10 })
      pointer(window, 'pointermove', { clientX: 30, clientY: 20 })
      pointer(window, 'pointerup', { clientX: 30, clientY: 20 })
    })
    expect(t.moveElement).not.toHaveBeenCalled()
    expect(t.editElements).toHaveBeenCalledTimes(1)
    const [, edit] = t.editElements.mock.calls[0] as unknown as [string, (e: unknown[]) => Array<Record<string, number>>]
    const out = edit([pillEl()])[0]
    // 20 / 0.5 = 40 and 10 / 0.5 = 20 slide px from the shown (fitted) start.
    expect([out.x, out.y, out.w, out.h]).toEqual([140, 160, 120, 40])
  })

  it('a turn writes the shown box with the rotation, in one step', async () => {
    mockRects()
    const t = await mount(pillEl())
    await shown(t)
    const knob = t.q('[data-testid="rotate-handle"]')
    await act(async () => {
      pointer(knob, 'pointerdown', { clientX: 0, clientY: -10 })
      pointer(window, 'pointermove', { clientX: 10, clientY: 0 })
      pointer(window, 'pointerup', { clientX: 10, clientY: 0 })
    })
    expect(t.rotateElement).not.toHaveBeenCalled()
    expect(t.editElements).toHaveBeenCalledTimes(1)
    const [, edit] = t.editElements.mock.calls[0] as unknown as [string, (e: unknown[]) => Array<Record<string, number>>]
    const out = edit([pillEl()])[0]
    expect([out.x, out.y, out.w, out.h]).toEqual([100, 140, 120, 40])
    expect(out.rotation).toBe(90)
  })

  it('a turned pill is read from its layout box and keeps its place on the slide', async () => {
    // 80 x 40, flush left and centred vertically in whatever box the layer is drawn at.
    const dims: Record<string, (layerH: number) => number> = { offsetWidth: () => 80, offsetHeight: () => 40, offsetLeft: () => 0, offsetTop: (h) => (h - 40) / 2 }
    for (const [k, v] of Object.entries(dims)) {
      Object.defineProperty(HTMLElement.prototype, k, {
        configurable: true,
        get() {
          if (!this.hasAttribute('data-montaj-pill')) return 0
          return v(parseFloat((this.closest('[data-overlay-layer]') as HTMLElement).style.height))
        },
      })
    }
    try {
      const t = await mount(pillEl({ rotation: 90 }))
      // Centre (300, 160) + the pill's offset (-160, 0) turned 90 degrees = (300, 0): a 80 x 40 box at (260, -20).
      await waitFor(() => expect(t.at(t.wrapper()).slice(0, 4)).toEqual([260, -20, 80, 40]))
    } finally {
      for (const k of Object.keys(dims)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
    }
  })
})
