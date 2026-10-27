import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, act, fireEvent } from '@testing-library/react'
import type { ImageElement, Slide } from '../../types'
import SlideCanvas from '../SlideCanvas'

// ── The Cmd-click pick list (§587 M8, rail layout) ───────────────────────────

beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})
afterEach(() => vi.restoreAllMocks())

const img = (id: string, x: number, y: number, extra: Partial<ImageElement> = {}): ImageElement =>
  ({ id, type: 'image', src: `dir/${id}.png`, x, y, w: 200, h: 200, rotation: 0, ...extra })
const text = (id: string, x: number, y: number) => ({
  id, type: 'overlay' as const, overlay: { template: 'a/headline.jsx', props: { text: 'Hello world' } },
  frame: 0, x, y, w: 200, h: 200, rotation: 0,
})
// el-1 at the back, el-3 on top. All three are under (250, 250).
const stack = (): Slide['elements'] => [img('el-1', 100, 100, { locked: true } as Partial<ImageElement>), text('el-2', 150, 150), img('el-3', 200, 200)]
const ALL = { clientX: 250, clientY: 250, metaKey: true }

function mount(selected: string[], pickList = true, elements: Slide['elements'] = stack()) {
  const fns = {
    moveElement: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    onSelect: vi.fn(),
    onExitCrop: vi.fn(),
  }
  function Harness() {
    const [sel, setSel] = useState(selected)
    return (
      <SlideCanvas
        slide={{ id: 's', base_color: '#ffffff', elements } as Slide}
        width={1080}
        height={1080}
        interactive
        scale={1}
        pickList={pickList}
        resolveImageSrc={(e) => e.src}
        selectedElementId={sel.length === 1 ? sel[0] : null}
        selectedElementIds={sel}
        {...fns}
        onSelect={(id) => { fns.onSelect(id); setSel(id ? [id] : []) }}
      />
    )
  }
  render(<Harness />)
  return fns
}
const wrapperOf = (id: string) => document.querySelector(`[data-element-id="${id}"]`) as HTMLElement
const list = () => document.querySelector('[data-pick-list]') as HTMLElement | null
const rows = () => Array.from(document.querySelectorAll('[data-pick-row]')) as HTMLElement[]
async function cmdPress(init: MouseEventInit = ALL) {
  await act(async () => {
    wrapperOf('el-3').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...init }))
    window.dispatchEvent(new MouseEvent('pointerup', { ...init }))
    fireEvent.click(wrapperOf('el-3'), init)
  })
}
const key = (k: string) => act(async () => { fireEvent.keyDown(window, { key: k }) })

describe('Cmd-click pick list (§587 M8)', () => {
  it('shows every element under the pointer, front to back, the selected one ticked', async () => {
    mount([])
    await cmdPress()
    expect(rows().map((r) => r.getAttribute('data-pick-row'))).toEqual(['el-3', 'el-2', 'el-1'])
    expect(rows()[0].textContent).toContain('el-3.png')
    expect(rows()[1].textContent).toContain('Hello world')
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
  })

  it('still cycles, and the list follows a second press at the same spot', async () => {
    const fns = mount([])
    await cmdPress()
    await cmdPress()
    expect(fns.onSelect.mock.calls.map((c) => c[0])).toEqual(['el-3', 'el-2'])
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  })

  it('outlines the others dashed and the selected one solid while open', async () => {
    mount([])
    await cmdPress()
    const out = (id: string) => (document.querySelector(`[data-chrome-for="${id}"]`) as HTMLElement).style.outline
    expect(out('el-3')).toContain('solid')
    expect(out('el-2')).toContain('dashed')
    expect(out('el-1')).toContain('dashed')
    await key('Escape')
    expect(document.querySelector('[data-chrome-for="el-2"]')).toBeNull()
  })

  it('a row click selects that element (a locked one too) and closes', async () => {
    const fns = mount([])
    await cmdPress()
    await act(async () => { fireEvent.click(rows()[2]) })
    expect(fns.onSelect).toHaveBeenLastCalledWith('el-1')
    expect(list()).toBeNull()
  })

  it('Esc closes; a press elsewhere closes', async () => {
    mount([])
    await cmdPress()
    await key('Escape')
    expect(list()).toBeNull()
    await cmdPress()
    expect(list()).not.toBeNull()
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(list()).toBeNull()
  })

  it('Up and Down move the tick and the selection; Enter closes', async () => {
    const fns = mount([])
    await cmdPress()
    await key('ArrowDown')
    expect(fns.onSelect).toHaveBeenLastCalledWith('el-2')
    await key('ArrowDown')
    expect(fns.onSelect).toHaveBeenLastCalledWith('el-1')
    await key('ArrowUp')
    expect(fns.onSelect).toHaveBeenLastCalledWith('el-2')
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    await key('Enter')
    expect(list()).toBeNull()
  })

  it('records nothing', async () => {
    const fns = mount([])
    await cmdPress()
    await key('ArrowDown')
    await act(async () => { fireEvent.click(rows()[0]) })
    expect(fns.moveElement).not.toHaveBeenCalled()
    expect(fns.commit).not.toHaveBeenCalled()
  })

  it('classic layout shows no list', async () => {
    mount([], false)
    await cmdPress()
    expect(list()).toBeNull()
  })

  it('leaves keys typed into a field alone', async () => {
    mount([])
    await cmdPress()
    const field = document.createElement('input')
    document.body.appendChild(field)
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    await act(async () => { field.dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(false)
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(list()).not.toBeNull()
    field.remove()
  })

  it('flips to the other side of the press near the right and bottom edges', async () => {
    mount([], true, [img('el-1', 880, 880), img('el-3', 900, 900)])
    await cmdPress({ clientX: 1000, clientY: 1050, metaKey: true })
    expect(list()!.style.transform).toBe('translate(-100%, -100%)')
    expect(list()!.style.left).toBe('992px')
  })

  it('opens down and right with room', async () => {
    mount([])
    await cmdPress()
    expect(list()!.style.transform).toBe('translate(0, 0)')
    expect(list()!.style.left).toBe('258px')
  })
})
