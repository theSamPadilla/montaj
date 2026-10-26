import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import type { ImageElement } from '../../types'
import SlideCanvas from '../SlideCanvas'

// Smart guides (§586 M7): a drag snaps to the other visible elements as well
// as the slide, and to equal gaps between two neighbours; Cmd (or Ctrl) held
// during the drag snaps nothing for as long as it is held.

const SCALE = 0.5

function image(over: Partial<ImageElement> = {}): ImageElement {
  return { id: 'a', type: 'image', src: 'a.png', x: 100, y: 100, w: 160, h: 100, rotation: 0, ...over }
}

function setup(elements: ImageElement[], selected: string[], hiddenElementIds?: string[]) {
  const spies = {
    onSelect: vi.fn(),
    moveElement: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  }
  const r = render(
    <SlideCanvas
      slide={{ id: 's', base_color: '#ffffff', elements }}
      width={1080}
      height={1080}
      interactive
      selectedElementId={selected[selected.length - 1]}
      selectedElementIds={selected}
      onToggleSelect={vi.fn()}
      hiddenElementIds={hiddenElementIds}
      scale={SCALE}
      resolveImageSrc={(e) => e.src}
      {...spies}
    />,
  )
  return {
    ...spies,
    element: (id: string) => r.container.querySelector(`[data-element-id="${id}"]`) as HTMLElement,
    guides: () => Array.from(r.container.querySelectorAll<HTMLElement>('[data-testid^="snap-guide-"]')),
    gaps: () => Array.from(r.container.querySelectorAll<HTMLElement>('[data-testid="snap-gap"]')),
  }
}

// This jsdom has no PointerEvent: a MouseEvent named for the pointer event
// carries clientX/Y and the modifier keys.
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

const press = (target: HTMLElement) => act(async () => { pointer(target, 'pointerdown', { clientX: 0, clientY: 0 }) })
const move = (x: number, y: number, keys: MouseEventInit = {}) =>
  act(async () => { pointer(window, 'pointermove', { clientX: x, clientY: y, ...keys }) })
const release = () => act(async () => { pointer(window, 'pointerup') })

// 'a' is 160 x 100 at 100, 100; 'b' is a 100 square at 500, 400. Dragged 197
// screen px right (394 on the slide), a's left edge is at 494, 6 from b's.
const B = image({ id: 'b', x: 500, y: 400, w: 100, h: 100 })

describe('SlideCanvas smart guides (§586 M7)', () => {
  it("a drag near a neighbour's edge ends snapped to it, in one move and one commit, with a guide drawn", async () => {
    const c = setup([image(), B], ['a'])
    await press(c.element('a'))
    await move(197, 0)
    expect(c.element('a').style.transform).toBe('translate(250px, 50px)')
    expect(c.guides().map((g) => [g.dataset.testid, g.style.left])).toEqual([['snap-guide-x', '249px']])
    await release()
    expect(c.moveElement).toHaveBeenCalledTimes(1)
    expect(c.moveElement).toHaveBeenCalledWith('s', 'a', 500, 100)
    expect(c.commit).toHaveBeenCalledTimes(1)
    expect(c.guides()).toEqual([])
  })

  it('Cmd or Ctrl held during the drag snaps nothing for as long as it is held', async () => {
    for (const key of ['metaKey', 'ctrlKey'] as const) {
      const c = setup([image(), B], ['a'])
      await press(c.element('a'))
      await move(197, 0)
      expect(c.guides()).toHaveLength(1)
      await move(197, 0, { [key]: true })
      expect(c.guides()).toEqual([])
      expect(c.element('a').style.transform).toBe('translate(247px, 50px)')
      await move(197, 0)
      expect(c.guides()).toHaveLength(1)
      await move(197, 0, { [key]: true })
      await release()
      expect(c.moveElement).toHaveBeenCalledWith('s', 'a', 494, 100)
      expect(c.commit).toHaveBeenCalledTimes(1)
    }
  })

  it('a hidden element is not snapped to', async () => {
    const c = setup([image(), B], ['a'], ['b'])
    await press(c.element('a'))
    await move(197, 0)
    expect(c.guides()).toEqual([])
    await release()
    expect(c.moveElement).toHaveBeenCalledWith('s', 'a', 494, 100)
  })

  it('between two neighbours it snaps to equal gaps, each gap drawn as a short segment', async () => {
    // Two 100 squares at x 100 and 500, y 300. 'd', a 100 square at 270, 320,
    // dragged 27 right sits at 297: 3 from equal gaps of 100.
    const L = image({ id: 'l', x: 100, y: 300, w: 100, h: 100 })
    const R = image({ id: 'r', x: 500, y: 300, w: 100, h: 100 })
    const D = image({ id: 'd', x: 270, y: 320, w: 100, h: 100 })
    const c = setup([L, R, D], ['d'])
    await press(c.element('d'))
    await move(13.5, 0)
    expect(c.guides()).toEqual([])
    // Each gap halfway down the overlap (320..400): y 360, drawn 2 px thick.
    expect(c.gaps().map((g) => [g.style.left, g.style.width, g.style.top, g.style.height])).toEqual([
      ['100px', '50px', '179px', '2px'],
      ['200px', '50px', '179px', '2px'],
    ])
    await release()
    expect(c.moveElement).toHaveBeenCalledWith('s', 'd', 300, 320)
    expect(c.commit).toHaveBeenCalledTimes(1)
    expect(c.gaps()).toEqual([])
  })

  it('a group drag snaps the box the group covers to the elements not selected', async () => {
    // 'a' and 'c' cover 100..500 across. Dragged 197 right on the slide, the
    // group's right edge is at 697, 3 from 'o's left edge.
    const a = image({ w: 200 })
    const cc = image({ id: 'c', x: 400, y: 300, w: 100, h: 100 })
    const o = image({ id: 'o', x: 700, y: 600, w: 100, h: 100 })
    const c = setup([a, cc, o], ['a', 'c'])
    await press(c.element('a'))
    await move(98.5, 0)
    expect(c.guides().map((g) => g.style.left)).toEqual(['349px'])
    await release()
    expect(c.moveElement.mock.calls).toEqual([['s', 'a', 300, 100], ['s', 'c', 600, 300]])
    expect(c.commit).toHaveBeenCalledTimes(1)

    const free = setup([a, cc, o], ['a', 'c'])
    await press(free.element('a'))
    await move(98.5, 0, { metaKey: true })
    expect(free.guides()).toEqual([])
    await release()
    expect(free.moveElement.mock.calls).toEqual([['s', 'a', 297, 100], ['s', 'c', 597, 300]])
  })
})
