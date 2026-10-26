import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import type { ImageElement } from '../../types'
import SlideCanvas from '../SlideCanvas'

// ── Drag-select (§586 M6) ────────────────────────────────────────────────────
//
// A press and move from the empty canvas, the margin or a locked element draws
// a band; on release every shown element it touches is selected.

const SCALE = 0.5
const MARGIN = 40

const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn()
})
afterEach(() => {
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

function image(id: string, over: Partial<ImageElement> = {}): ImageElement {
  return { id, type: 'image', src: `${id}.png`, x: 0, y: 0, w: 200, h: 200, rotation: 0, ...over }
}

// Display pixels are half the slide's; the jsdom canvas sits at the origin.
const A = image('a', { x: 100, y: 100 })
const B = image('b', { x: 500, y: 100 })
const C = image('c', { x: 100, y: 600 })

function setup(elements: ImageElement[] = [A, B, C], extra: Partial<React.ComponentProps<typeof SlideCanvas>> = {}) {
  const spies = {
    onSelect: vi.fn(),
    onSelectMany: vi.fn(),
    moveElement: vi.fn(async () => {}),
    resizeElement: vi.fn(async () => {}),
    rotateElement: vi.fn(async () => {}),
    updateImageCrop: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  }
  const r = render(
    <SlideCanvas
      slide={{ id: 's', base_color: '#ffffff', elements }}
      width={1080}
      height={1080}
      interactive
      selectedElementId={null}
      selectedElementIds={[]}
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
    margin: q('[data-canvas-margin]'),
    wrapper: (id: string) => q(`[data-element-id="${id}"]`),
    band: () => r.container.querySelector('[data-testid="selection-band"]') as HTMLElement | null,
    noWrites: () => {
      expect(spies.moveElement).not.toHaveBeenCalled()
      expect(spies.resizeElement).not.toHaveBeenCalled()
      expect(spies.rotateElement).not.toHaveBeenCalled()
      expect(spies.updateImageCrop).not.toHaveBeenCalled()
      expect(spies.commit).not.toHaveBeenCalled()
    },
  }
}

function drag(from: EventTarget, a: [number, number], b: [number, number], init: MouseEventInit = {}) {
  act(() => {
    pointer(from, 'pointerdown', { clientX: a[0], clientY: a[1], ...init })
    pointer(window, 'pointermove', { clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2, ...init })
    pointer(window, 'pointermove', { clientX: b[0], clientY: b[1], ...init })
  })
}
const release = (at: [number, number]) => act(() => { pointer(window, 'pointerup', { clientX: at[0], clientY: at[1] }) })

describe('drag-select', () => {
  it('a band over two of three elements selects exactly those two', () => {
    const t = setup()
    drag(t.root, [20, 20], [400, 200])
    expect(t.band()).not.toBeNull()
    release([400, 200])
    expect(t.onSelectMany).toHaveBeenCalledTimes(1)
    expect([...t.onSelectMany.mock.calls[0][0]].sort()).toEqual(['a', 'b'])
    expect(t.band()).toBeNull()
    t.noWrites()
  })

  it('the band is drawn in the chrome layer and takes no pointer', () => {
    const t = setup()
    drag(t.root, [20, 20], [400, 200])
    const band = t.band()!
    expect(band.closest('[data-slide-chrome]')).not.toBeNull()
    expect(band.style.pointerEvents).toBe('none')
    expect(band.style.border).toContain('var(--editor-selection)')
    release([400, 200])
  })

  it('shift at the press adds to the selection', () => {
    const t = setup([A, B, C], { selectedElementIds: ['c'], selectedElementId: 'c' })
    drag(t.root, [20, 20], [200, 200], { shiftKey: true })
    release([200, 200])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual(['c', 'a'])
  })

  it('without shift the band replaces the selection', () => {
    const t = setup([A, B, C], { selectedElementIds: ['c'], selectedElementId: 'c' })
    drag(t.root, [20, 20], [200, 200])
    release([200, 200])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual(['a'])
  })

  it('the frontmost element touched is last, the primary', () => {
    const t = setup()
    drag(t.root, [20, 20], [400, 200])
    release([400, 200])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual(['a', 'b'])
  })

  it('a turned element counts by its turned outline', () => {
    // Centre (200, 200) in slide units, a 200 x 200 box turned 45 degrees: its
    // bounding box reaches (59, 59) but the diamond does not.
    const turned = image('t', { x: 100, y: 100, rotation: 45 })
    const t = setup([turned])
    // Slide (60..80, 60..80): inside the bounding box corner, outside the diamond.
    drag(t.root, [30, 30], [40, 40])
    release([40, 40])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual([])
    // Over the diamond's edge it is touched.
    const u = setup([turned])
    drag(u.root, [60, 60], [80, 80])
    release([80, 80])
    expect(u.onSelectMany.mock.calls[0][0]).toEqual(['t'])
  })

  it('hidden elements are skipped', () => {
    const t = setup([A, B, C], { hiddenElementIds: ['b'] })
    drag(t.root, [20, 20], [400, 200])
    release([400, 200])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual(['a'])
  })

  it('a band started on a locked full-bleed background selects what it touches, the background too', () => {
    const bg = image('bg', { x: 0, y: 0, w: 1080, h: 1080, locked: true })
    const t = setup([bg, A, C])
    drag(t.wrapper('bg'), [10, 10], [200, 200])
    release([200, 200])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual(['bg', 'a'])
    t.noWrites()
  })

  it('a press on a locked element without movement only selects it', () => {
    const bg = image('bg', { x: 0, y: 0, w: 1080, h: 1080, locked: true })
    const t = setup([bg, A])
    act(() => { pointer(t.wrapper('bg'), 'pointerdown', { clientX: 10, clientY: 10 }) })
    release([10, 10])
    expect(t.onSelect).toHaveBeenCalledWith('bg')
    expect(t.onSelectMany).not.toHaveBeenCalled()
    t.noWrites()
  })

  it('the click after the release does not deselect', () => {
    const t = setup()
    drag(t.root, [20, 20], [400, 200])
    release([400, 200])
    fireEvent.click(t.root)
    expect(t.onSelect).not.toHaveBeenCalled()
    // The next plain click still deselects.
    fireEvent.click(t.root)
    expect(t.onSelect).toHaveBeenCalledWith(null)
  })

  it('a press without movement deselects and records nothing', () => {
    const t = setup()
    act(() => { pointer(t.root, 'pointerdown', { clientX: 20, clientY: 20 }) })
    release([20, 20])
    fireEvent.click(t.root)
    expect(t.onSelect).toHaveBeenCalledWith(null)
    expect(t.onSelectMany).not.toHaveBeenCalled()
    expect(t.band()).toBeNull()
    t.noWrites()
  })

  it('a band started in the margin works', () => {
    const t = setup()
    drag(t.margin, [-30, -30], [200, 200])
    release([200, 200])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual(['a'])
  })

  it('a band that touches nothing clears the selection', () => {
    const t = setup([A, B, C], { selectedElementIds: ['c'], selectedElementId: 'c' })
    drag(t.root, [500, 500], [520, 520])
    release([520, 520])
    expect(t.onSelectMany.mock.calls[0][0]).toEqual([])
  })

  it('a press on an unlocked element starts no band', () => {
    const t = setup()
    act(() => {
      pointer(t.wrapper('a'), 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(window, 'pointermove', { clientX: 140, clientY: 140 })
    })
    expect(t.band()).toBeNull()
    release([140, 140])
    expect(t.onSelectMany).not.toHaveBeenCalled()
  })
})
