import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, act, fireEvent } from '@testing-library/react'
import type { ImageElement, Slide } from '../../types'
import SlideCanvas from '../SlideCanvas'

// ── Reaching a lower layer (§586 M1) ─────────────────────────────────────────
//
// Cmd-press walks down the stack under the pointer; a press inside the
// selected element's box drags the selected element even with another on top.

const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

const img = (id: string, x: number, y: number, extra: Partial<ImageElement> = {}): ImageElement =>
  ({ id, type: 'image', src: `${id}.png`, x, y, w: 200, h: 200, rotation: 0, ...extra })

// el-1 at the back, el-3 on top. ALL is under all three; OUT only under el-3.
const stack = () => [img('el-1', 100, 100), img('el-2', 150, 150), img('el-3', 200, 200)]
const ALL = { clientX: 250, clientY: 250 }
const OUT = { clientX: 390, clientY: 390 }

const mac = (on: boolean) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(on ? 'MacIntel' : 'Win32')

function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}
const wrapperOf = (id: string) => document.querySelector(`[data-element-id="${id}"]`) as HTMLElement

function mount(selected: string[], elements: Slide['elements'] = stack(), extra: Partial<React.ComponentProps<typeof SlideCanvas>> = {}) {
  const fns = {
    moveElement: vi.fn(async (_s: string, _id: string, _x: number, _y: number) => {}),
    commit: vi.fn(async () => {}),
    onSelect: vi.fn(),
    onEnterCrop: vi.fn(),
    onExitCrop: vi.fn(),
    updateImageCrop: vi.fn(async () => {}),
  }
  // Selection follows onSelect, as the editor's does.
  function Harness() {
    const [sel, setSel] = useState(selected)
    return (
      <SlideCanvas
        slide={{ id: 's', base_color: '#ffffff', elements } as Slide}
        width={1080}
        height={1080}
        interactive
        scale={1}
        resolveImageSrc={(e) => e.src}
        selectedElementId={sel.length === 1 ? sel[0] : null}
        selectedElementIds={sel}
        {...fns}
        onSelect={(id) => { fns.onSelect(id); setSel(id ? [id] : []) }}
        {...extra}
      />
    )
  }
  render(<Harness />)
  return fns
}

/** A press let go where it began, with the click the browser sends. */
async function tap(id: string, init: MouseEventInit) {
  await act(async () => {
    pointer(wrapperOf(id), 'pointerdown', init)
    pointer(window, 'pointerup', init)
    fireEvent.click(wrapperOf(id), init)
  })
}
async function dragOn(id: string, from: { clientX: number; clientY: number }, dx = 40, dy = 30, init: MouseEventInit = {}) {
  await act(async () => {
    pointer(wrapperOf(id), 'pointerdown', { ...from, ...init })
    pointer(window, 'pointermove', { clientX: from.clientX + dx, clientY: from.clientY + dy })
    pointer(window, 'pointerup')
  })
}

describe('SlideCanvas: Cmd-press reaches a lower layer (§586 M1)', () => {
  it('cycles 3, 2, 1, then back to 3', async () => {
    mac(true)
    const fns = mount([])
    for (let i = 0; i < 4; i++) await tap('el-3', { ...ALL, metaKey: true })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-3', 'el-2', 'el-1', 'el-3'])
  })

  it('starts no drag and records nothing, and its click keeps the selection', async () => {
    mac(true)
    const fns = mount(['el-3'])
    await dragOn('el-3', ALL, 60, 40, { metaKey: true })
    expect(fns.moveElement).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-2'])
    await act(async () => { fireEvent.click(wrapperOf('el-3'), { ...ALL, metaKey: true }) })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-2'])
  })

  it('a selection not under the pointer starts at the topmost there', async () => {
    mac(true)
    const fns = mount(['el-1'])
    await tap('el-3', { ...OUT, metaKey: true })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-3'])
  })

  it('with several selected, starts below the frontmost one under the pointer and leaves one', async () => {
    mac(true)
    const fns = mount(['el-1', 'el-2'])
    await tap('el-3', { ...ALL, metaKey: true })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-1'])
  })

  it('skips hidden elements', async () => {
    mac(true)
    const fns = mount([], stack(), { hiddenElementIds: ['el-3'] })
    await tap('el-2', { ...ALL, metaKey: true })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-2'])
  })

  it('applies a pending crop first', async () => {
    mac(true)
    const fns = mount(['el-1'], stack(), { cropElementId: 'el-1' })
    await tap('el-3', { ...ALL, metaKey: true })
    expect(fns.onExitCrop).toHaveBeenCalledTimes(1)
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-3'])
  })

  it('on a Mac, Ctrl-click (a right-click) does not cycle', async () => {
    mac(true)
    const fns = mount(['el-1'])
    await tap('el-3', { ...ALL, ctrlKey: true })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).not.toContain('el-2')
    expect(fns.moveElement).not.toHaveBeenCalled()
  })

  it('off a Mac, Ctrl cycles and Meta does not', async () => {
    mac(false)
    const fns = mount([])
    await tap('el-3', { ...ALL, ctrlKey: true })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-3'])
    fns.onSelect.mockClear()
    await tap('el-3', { ...ALL, metaKey: true })
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-3'])
  })
})

describe('SlideCanvas: a press inside the selected box drags the selected (§586 M1)', () => {
  it('a moving press drags only the selected lower element, as one undo step', async () => {
    const fns = mount(['el-1'])
    await dragOn('el-3', ALL)
    expect(fns.moveElement).toHaveBeenCalledTimes(1)
    expect(fns.moveElement).toHaveBeenCalledWith('s', 'el-1', 140, 130)
    expect(fns.commit).toHaveBeenCalledTimes(1)
  })

  it('a press that does not move selects the topmost on release', async () => {
    const fns = mount(['el-1'])
    await tap('el-3', ALL)
    expect(fns.moveElement).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-3'])
  })

  it('a double-click on the overlap crops the selected lower image', async () => {
    const fns = mount(['el-1'])
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-3'), ALL) })
    expect(fns.onEnterCrop).toHaveBeenCalledTimes(1)
    expect(fns.onEnterCrop).toHaveBeenCalledWith('el-1')
  })

  it('the clicks of a double-click still end on the selected lower image', async () => {
    const fns = mount(['el-1'])
    await tap('el-3', ALL)
    await tap('el-3', { ...ALL, detail: 2 })
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-3'), ALL) })
    expect(fns.onEnterCrop).toHaveBeenCalledWith('el-1')
    expect(fns.onSelect.mock.calls[fns.onSelect.mock.calls.length - 1][0]).toBe('el-1')
  })

  it('a double-click on the top element right after a click moved the selection to it is for the top one', async () => {
    const fns = mount(['el-1'])
    await tap('el-3', ALL)
    await tap('el-3', { ...ALL, detail: 1 })
    await tap('el-3', { ...ALL, detail: 2 })
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-3'), ALL) })
    expect(fns.onEnterCrop).toHaveBeenCalledTimes(1)
    expect(fns.onEnterCrop).toHaveBeenCalledWith('el-3')
  })

  it('a press-and-move in the overlap does not drag the element being edited inline', async () => {
    const text = (id: string, x: number, y: number): Slide['elements'][number] => ({
      id, type: 'overlay', overlay: { template: '/o/text.jsx', props: { text: 'Hi' } }, frame: 0, x, y, w: 200, h: 200, rotation: 0,
    })
    const fns = mount(['el-1'], [text('el-1', 100, 100), img('el-2', 150, 150)])
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-2'), ALL) })
    await dragOn('el-2', ALL)
    expect(fns.moveElement.mock.calls.map((c) => c[1])).not.toContain('el-1')
  })

  it('a drag of the selected lower element snaps to a neighbour like any drag', async () => {
    const fns = mount(['el-1'], [img('el-1', 100, 100), img('el-2', 150, 150), img('el-3', 400, 500)])
    // el-1's left edge ends at 394, 6 from el-3's at 400.
    await dragOn('el-2', ALL, 294, 0)
    expect(fns.moveElement).toHaveBeenCalledWith('s', 'el-1', 400, 100)
  })

  it('a press outside the selected box hits the topmost', async () => {
    const fns = mount(['el-1'])
    await dragOn('el-3', OUT)
    expect(fns.moveElement).toHaveBeenCalledTimes(1)
    expect(fns.moveElement.mock.calls[0][1]).toBe('el-3')
    expect(fns.onSelect).toHaveBeenCalledWith('el-3')
  })

  it('a moving press inside any member of a multi-selection drags the group', async () => {
    const fns = mount(['el-1', 'el-2'])
    await dragOn('el-3', ALL)
    expect(fns.moveElement.mock.calls.map((c) => c[1]).sort()).toEqual(['el-1', 'el-2'])
    expect(fns.commit).toHaveBeenCalledTimes(1)
  })

  it('a selected locked element is not dragged', async () => {
    const fns = mount(['el-1'], [img('el-1', 100, 100, { locked: true }), img('el-2', 150, 150)])
    await dragOn('el-2', ALL)
    expect(fns.moveElement).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
  })
})
