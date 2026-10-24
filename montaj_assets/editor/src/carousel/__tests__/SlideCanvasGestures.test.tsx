import { describe, it, expect, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import type { ImageElement } from '../../types'
import SlideCanvas from '../SlideCanvas'

// The canvas's resize, rotate and drag gestures (§556 M3), driven through the
// real pointer wiring with spy mutators.

const SCALE = 0.5

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
type Box = { x: number; y: number; w: number; h: number }

function image(over: Partial<ImageElement> = {}): ImageElement {
  return { id: 'el', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 100, rotation: 0, ...over }
}

function setup(el: ImageElement) {
  const spies = {
    onSelect: vi.fn(),
    moveElement: vi.fn(async () => {}),
    resizeElement: vi.fn<(slideId: string, elementId: string, box: Box) => Promise<void>>(async () => {}),
    rotateElement: vi.fn(async () => {}),
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
  return {
    ...spies,
    r,
    root: q('[data-interactive]'),
    wrapper: q(`[data-element-id="${el.id}"]`),
    handle: (id: Handle) => q(`[data-testid="resize-handle-${id}"]`),
    rotateHandle: q('[data-testid="rotate-handle"]'),
  }
}

// This jsdom has no PointerEvent, and fireEvent.pointer* drops clientX/Y and
// shiftKey. A MouseEvent named for the pointer event carries them.
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

async function dragFrom(target: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, move: MouseEventInit = {}) {
  await act(async () => {
    pointer(target, 'pointerdown', { clientX: from.x, clientY: from.y })
    pointer(window, 'pointermove', { clientX: to.x, clientY: to.y, ...move })
    pointer(window, 'pointerup', { clientX: to.x, clientY: to.y })
  })
}

// A press and release in place, and the click the browser sends after it.
async function clickInPlace(target: HTMLElement) {
  await act(async () => {
    pointer(target, 'pointerdown', { clientX: 40, clientY: 40 })
    pointer(window, 'pointerup', { clientX: 40, clientY: 40 })
    fireEvent.click(target)
  })
}

// Where the point (sx * w/2, sy * h/2) from a box's centre lands on the slide,
// the box turned `rotation` degrees clockwise about its centre.
function at(b: Box, rotation: number, sx: number, sy: number) {
  const t = (rotation * Math.PI) / 180
  const u = (sx * b.w) / 2
  const v = (sy * b.h) / 2
  return { x: b.x + b.w / 2 + Math.cos(t) * u - Math.sin(t) * v, y: b.y + b.h / 2 + Math.sin(t) * u + Math.cos(t) * v }
}

function signs(h: Handle) {
  return { sx: h.includes('w') ? -1 : h.includes('e') ? 1 : 0, sy: h.includes('n') ? -1 : h.includes('s') ? 1 : 0 }
}

describe('SlideCanvas resize handles (§556 M3)', () => {
  it('a corner drag keeps the box ratio, in one resize and one commit', async () => {
    const c = setup(image())
    // 60, 5 screen px at half scale: 120, 10 on the slide. The corner goes to
    // the cursor's projection onto the diagonal, 1.5 times the box.
    await dragFrom(c.handle('se'), { x: 0, y: 0 }, { x: 60, y: 5 })
    expect(c.resizeElement).toHaveBeenCalledTimes(1)
    expect(c.resizeElement).toHaveBeenCalledWith('s', 'el', { x: 100, y: 100, w: 300, h: 150 })
    expect(c.commit).toHaveBeenCalledTimes(1)
  })

  it('with Shift held during the move, the corner is free', async () => {
    const c = setup(image())
    await dragFrom(c.handle('se'), { x: 0, y: 0 }, { x: 60, y: 5 }, { shiftKey: true })
    expect(c.resizeElement).toHaveBeenCalledWith('s', 'el', { x: 100, y: 100, w: 320, h: 110 })
  })

  it('a side handle moves one side, Shift or not', async () => {
    const c = setup(image())
    await dragFrom(c.handle('e'), { x: 0, y: 0 }, { x: 60, y: 5 })
    expect(c.resizeElement).toHaveBeenCalledWith('s', 'el', { x: 100, y: 100, w: 320, h: 100 })
  })

  it('a turned element resizes along its own axes: the opposite corner or side stays put on the slide', async () => {
    for (const rotation of [30, -135]) {
      for (const handle of HANDLES) {
        for (const shiftKey of [false, true]) {
          const el = image({ x: 300, y: 300, rotation })
          const c = setup(el)
          await dragFrom(c.handle(handle), { x: 0, y: 0 }, { x: 30, y: -25 }, { shiftKey })
          expect(c.resizeElement).toHaveBeenCalledTimes(1)
          const box = c.resizeElement.mock.calls[0][2]
          for (const v of Object.values(box)) expect(Number.isInteger(v)).toBe(true)
          const { sx, sy } = signs(handle)
          const before = at(el, rotation, -sx, -sy)
          const after = at(box, rotation, -sx, -sy)
          expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThanOrEqual(1)
          if (sx !== 0 && sy !== 0 && !shiftKey) expect(box.w / box.h).toBeCloseTo(2, 1)
          c.r.unmount()
        }
      }
    }
  })

  it('a move that rounds back to the start records nothing and shows the element where it is', async () => {
    const c = setup(image())
    // 0.2 screen px is 0.4 on the slide: w 200.4 rounds back to 200.
    await dragFrom(c.handle('e'), { x: 0, y: 0 }, { x: 0.2, y: 0 })
    expect(c.resizeElement).not.toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
    expect(c.wrapper.style.width).toBe('100px')

    await dragFrom(c.wrapper, { x: 0, y: 0 }, { x: 0.2, y: 0 })
    expect(c.moveElement).not.toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
    expect(c.wrapper.style.transform).toBe('translate(50px, 50px)')
  })

  it('the eight handles sit in percentages of the box, so all of them follow it during a drag', async () => {
    const c = setup(image())
    const where: Record<Handle, [string, string]> = {
      nw: ['0%', '0%'], n: ['50%', '0%'], ne: ['100%', '0%'], e: ['100%', '50%'],
      se: ['100%', '100%'], s: ['50%', '100%'], sw: ['0%', '100%'], w: ['0%', '50%'],
    }
    const check = () => {
      for (const id of HANDLES) {
        const h = c.handle(id)
        expect([h.style.left, h.style.top]).toEqual(where[id])
        expect([h.style.marginLeft, h.style.marginTop]).toEqual(['-4px', '-4px'])
      }
    }
    check()
    await act(async () => {
      pointer(c.handle('nw'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: -20, clientY: -10, shiftKey: true })
    })
    // Mid-drag: the box is bigger, the handles are where they were in it.
    expect(c.wrapper.style.width).toBe('120px')
    expect(c.wrapper.style.height).toBe('60px')
    check()
    await act(async () => { pointer(window, 'pointerup') })
  })
})

describe('SlideCanvas: a release never changes the selection (§556 M3)', () => {
  it('letting go of a resize handle off the element keeps it selected', async () => {
    const c = setup(image())
    await dragFrom(c.handle('se'), { x: 0, y: 0 }, { x: 300, y: 200 })
    // The browser sends the click to the nearest box holding both the press and
    // the release: here, the canvas.
    await act(async () => { fireEvent.click(c.root) })
    expect(c.onSelect).not.toHaveBeenCalledWith(null)
    expect(c.resizeElement).toHaveBeenCalledTimes(1)
  })

  it('letting go of the rotate handle off the element keeps it selected', async () => {
    const c = setup(image())
    // jsdom lays nothing out, so the element's centre is at 0, 0: from straight
    // up to the right is a quarter turn.
    await dragFrom(c.rotateHandle, { x: 0, y: -20 }, { x: 20, y: 0 })
    await act(async () => { fireEvent.click(c.root) })
    expect(c.onSelect).not.toHaveBeenCalledWith(null)
    expect(c.rotateElement).toHaveBeenCalledWith('s', 'el', 90)
  })

  it('a later press and click on the empty canvas still deselects', async () => {
    const c = setup(image())
    // Let go off the canvas: the click goes elsewhere and never reaches it.
    await dragFrom(c.handle('se'), { x: 0, y: 0 }, { x: 900, y: 900 })
    await act(async () => {
      pointer(c.root, 'pointerdown', { clientX: 5, clientY: 5 })
      pointer(window, 'pointerup', { clientX: 5, clientY: 5 })
      fireEvent.click(c.root)
    })
    expect(c.onSelect).toHaveBeenLastCalledWith(null)
  })
})

describe('SlideCanvas: a press and release in place records nothing (§556 M3)', () => {
  it('on the element, a resize handle or the rotate handle, also twice in a row', async () => {
    const c = setup(image())
    await clickInPlace(c.wrapper)
    await clickInPlace(c.wrapper)
    await clickInPlace(c.handle('se'))
    await clickInPlace(c.handle('n'))
    await clickInPlace(c.rotateHandle)
    expect(c.moveElement).not.toHaveBeenCalled()
    expect(c.resizeElement).not.toHaveBeenCalled()
    expect(c.rotateElement).not.toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
    expect(c.onSelect).not.toHaveBeenCalledWith(null)
  })

  it('on a member of a multi-selection: nothing moves, and the click selects just that member; a move that rounds back records nothing either', async () => {
    const onSelect = vi.fn()
    const moveElement = vi.fn(async () => {})
    const commit = vi.fn(async () => {})
    const r = render(
      <SlideCanvas
        slide={{ id: 's', base_color: '#ffffff', elements: [image({ id: 'a' }), image({ id: 'b', x: 500 })] }}
        width={1080}
        height={1080}
        interactive
        selectedElementId="b"
        selectedElementIds={['a', 'b']}
        onSelect={onSelect}
        onToggleSelect={vi.fn()}
        scale={SCALE}
        resolveImageSrc={(e) => e.src}
        moveElement={moveElement}
        commit={commit}
      />,
    )
    const a = r.container.querySelector('[data-element-id="a"]') as HTMLElement
    await clickInPlace(a)
    expect(onSelect).toHaveBeenLastCalledWith('a')

    // 0.2 screen px is 0.4 on the slide: both members round back.
    await dragFrom(a, { x: 0, y: 0 }, { x: 0.2, y: 0 })
    expect(moveElement).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(a.style.transform).toBe('translate(50px, 50px)')
  })
})
