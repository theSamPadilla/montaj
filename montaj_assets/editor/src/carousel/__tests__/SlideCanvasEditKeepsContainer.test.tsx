import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, fireEvent, waitFor } from '@testing-library/react'
import type { OverlayElement } from '../../types'
import SlideCanvas from '../SlideCanvas'

// Editing a text in place hides only its text node: a pill's fill, border and
// radius stay drawn, and the editor keeps the text's own font.

const TEXT = 'Swipe for more'

function pillOverlay(over: Partial<OverlayElement> = {}): OverlayElement {
  return {
    id: 'pill', type: 'overlay', frame: 0, x: 100, y: 100, w: 400, h: 120, rotation: 0,
    overlay: { template: '/t/pill.jsx', props: { text: TEXT } },
    ...over,
  } as OverlayElement
}

// A custom JSX overlay: a hardcoded pill with nested spans, in a serif.
const compileOverlay = vi.fn(async () => () => (
  <div data-testid="pill" style={{ background: '#ff66aa', borderRadius: 40, padding: 20, border: '2px solid #000' }}>
    <div
      data-testid="label"
      style={{
        fontFamily: 'Georgia, serif', fontWeight: 300, fontSize: 40, letterSpacing: '4px',
        textTransform: 'uppercase', lineHeight: '48px', color: '#112233', textAlign: 'center',
      }}
    >
      <span>Swipe </span><span>for more</span>
    </div>
  </div>
))

async function mount(el: OverlayElement = pillOverlay(), compile: typeof compileOverlay = compileOverlay) {
  const updateOverlayProp = vi.fn(async () => {})
  const r = render(
    <SlideCanvas
      slide={{ id: 's', base_color: '#ffffff', elements: [el] }}
      width={1080}
      height={1080}
      interactive
      selectedElementId={el.id}
      scale={0.5}
      compileOverlay={compile as never}
      updateOverlayProp={updateOverlayProp}
      onSelect={vi.fn()}
    />,
  )
  await waitFor(() => expect(r.container.querySelector('[data-overlay-layer]')?.firstElementChild).not.toBeNull())
  const q = (sel: string) => r.container.querySelector(sel) as HTMLElement
  const edit = async () => {
    await act(async () => { fireEvent.doubleClick(q(`[data-element-id="${el.id}"]`)) })
  }
  return { r, q, edit, updateOverlayProp }
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
})

describe('editing a text keeps its container drawn', () => {
  it('hides only the text node while editing', async () => {
    const { q, edit } = await mount()
    await edit()
    expect(q('[role="textbox"]')).not.toBeNull()
    expect(q('[data-testid="label"]').style.visibility).toBe('hidden')
    expect(q('[data-testid="pill"]').style.visibility).toBe('')
  })

  it('restores the text node after Esc', async () => {
    const { q, edit } = await mount()
    await edit()
    await act(async () => { fireEvent.keyDown(q('[role="textbox"]'), { key: 'Escape' }) })
    expect(q('[role="textbox"]')).toBeNull()
    expect(q('[data-testid="label"]').style.visibility).toBe('')
  })

  it('restores the text node after a commit', async () => {
    const { q, edit, updateOverlayProp } = await mount()
    await edit()
    const box = q('[role="textbox"]')
    await act(async () => {
      box.textContent = 'Changed'
      fireEvent.input(box)
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    expect(updateOverlayProp).toHaveBeenCalled()
    expect(q('[role="textbox"]')).toBeNull()
    expect(q('[data-testid="label"]').style.visibility).toBe('')
  })

  it('keeps the whole text font in the editor', async () => {
    const { q, edit } = await mount()
    await edit()
    const s = q('[role="textbox"]').style
    expect(s.fontFamily).toContain('Georgia')
    expect(s.fontWeight).toBe('300')
    expect(s.textTransform).toBe('uppercase')
    expect(s.letterSpacing).toBe('2px')
    expect(s.textAlign).toBe('center')
    expect(s.fontSize).toBe('20px')
  })

  it('finds the text node case-insensitively when the text is transformed', async () => {
    const { q, edit } = await mount(pillOverlay({ overlay: { template: '/t/pill.jsx', props: { text: 'swipe  for MORE' } } } as Partial<OverlayElement>))
    await edit()
    expect(q('[data-testid="label"]').style.visibility).toBe('hidden')
    expect(q('[role="textbox"]').style.fontFamily).toContain('Georgia')
  })

  it('hides the marked <p> of a static-text pill and leaves the pill drawn', async () => {
    const compile = vi.fn(async () => () => (
      <div data-testid="pill" style={{ background: '#ffee00', borderRadius: 30, padding: 16 }}>
        <p data-montaj-text="" data-testid="label" style={{ margin: 0 }}>Custom words</p>
      </div>
    ))
    const { q, edit } = await mount(pillOverlay({ overlay: { template: '/t/s.jsx', props: { text: TEXT } } } as Partial<OverlayElement>), compile as never)
    await edit()
    expect(q('[data-testid="label"]').style.visibility).toBe('hidden')
    expect(q('[data-testid="pill"]').style.visibility).toBe('')
  })

  it('hides only the glyphs when the text sits directly in the styled box', async () => {
    const compile = vi.fn(async () => () => (
      <div data-testid="pill" style={{ background: '#ff66aa', borderRadius: 40, padding: 20, color: '#000', textShadow: '1px 1px red' }}>{TEXT}</div>
    ))
    const { q, edit } = await mount(pillOverlay(), compile as never)
    await edit()
    const pill = q('[data-testid="pill"]')
    expect(pill.style.visibility).toBe('')
    expect(pill.style.textShadow).toBe('none')
    await act(async () => { fireEvent.keyDown(q('[role="textbox"]'), { key: 'Escape' }) })
    expect(pill.style.textShadow).toContain('red')
  })

  it('hides every piece of a text split over sibling blocks', async () => {
    const compile = vi.fn(async () => () => (
      <div data-testid="pill" style={{ background: '#ff66aa' }}>
        <h1 data-testid="a">Big news</h1>
        <h2 data-testid="b">today</h2>
      </div>
    ))
    const { q, edit } = await mount(pillOverlay({ overlay: { template: '/t/s.jsx', props: { text: 'Big news today' } } } as Partial<OverlayElement>), compile as never)
    await edit()
    expect(q('[data-testid="a"]').style.visibility).toBe('hidden')
    expect(q('[data-testid="b"]').style.visibility).toBe('hidden')
    expect(q('[data-testid="pill"]').style.visibility).toBe('')
    await act(async () => { fireEvent.keyDown(q('[role="textbox"]'), { key: 'Escape' }) })
    expect(q('[data-testid="a"]').style.visibility).toBe('')
    expect(q('[data-testid="b"]').style.visibility).toBe('')
  })

  it('puts the editor over the text node, as wide as the box less its offset', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = (left: number, top: number, width: number, height: number) =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect
      if (this.hasAttribute('data-overlay-layer')) return box(0, 0, 200, 60)
      if (this.getAttribute('data-testid') === 'label') return box(40, 20, 100, 20)
      return box(0, 0, 0, 0)
    })
    const { q, edit } = await mount()
    await edit()
    const s = q('[role="textbox"]').style
    expect([s.left, s.top, s.width]).toEqual(['90px', '70px', '160px'])
    vi.restoreAllMocks()
  })

  it('keeps the element box for a turned element', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30, x: 10, y: 10, toJSON() {} } as DOMRect
    })
    const { q, edit } = await mount(pillOverlay({ rotation: 15 }))
    await edit()
    const s = q('[role="textbox"]').style
    expect([s.left, s.top, s.width]).toEqual(['50px', '50px', '200px'])
    vi.restoreAllMocks()
  })
})

// A hugging pill that is 10 px wide per character, 40 px tall.
describe('the container follows the typed text', () => {
  const CHAR = 10
  const hugCompile = vi.fn(async () => (_f: number, _fps: number, _d: number, props: Record<string, unknown>) => (
    <div data-testid="pill" data-montaj-pill="" data-align={String(props.textAlign)} style={{ background: '#ff66aa' }}>
      <p data-montaj-text="" data-testid="label">{String(props.text)}</p>
    </div>
  ))

  function rects() {
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-overlay-layer')) return box(0, 0, parseFloat(this.style.width), parseFloat(this.style.height))
      const w = CHAR * (this.textContent ?? '').length
      if (this.hasAttribute('data-montaj-pill')) {
        // The flex wrapper sits the pill by textAlign in the layer, past either end when wider.
        const layerW = parseFloat((this.closest('[data-overlay-layer]') as HTMLElement).style.width)
        const align = this.getAttribute('data-align')
        const left = align === 'left' ? 0 : align === 'right' ? layerW - w : (layerW - w) / 2
        const layerH = parseFloat((this.closest('[data-overlay-layer]') as HTMLElement).style.height)
        return box(left, (layerH - 40) / 2, w, 40)
      }
      if (this.getAttribute('data-testid') === 'label') return box(8, 6, w, 28)
      return box(0, 0, 0, 0)
    })
  }

  const el = (align: string) => pillOverlay({ x: 100, y: 100, w: 400, h: 120, overlay: { template: '/t/h.jsx', props: { text: 'Hi', textAlign: align, hug: 'true' } } } as Partial<OverlayElement>)

  async function mountHug(align: string) {
    rects()
    const editElements = vi.fn(async () => {})
    const updateOverlayProp = vi.fn(async () => {})
    const updateOverlayProps = vi.fn(async () => {})
    const element = el(align)
    const r = render(
      <SlideCanvas
        slide={{ id: 's', base_color: '#ffffff', elements: [element] }}
        width={1080} height={1080} interactive selectedElementId={element.id} scale={0.5}
        compileOverlay={hugCompile as never} editElements={editElements} updateOverlayProp={updateOverlayProp}
        updateOverlayProps={updateOverlayProps} onSelect={vi.fn()}
      />,
    )
    await waitFor(() => expect(r.container.querySelector('[data-montaj-pill]')).not.toBeNull())
    const q = (sel: string) => r.container.querySelector(sel) as HTMLElement
    await act(async () => { fireEvent.doubleClick(q(`[data-element-id="${element.id}"]`)) })
    const type = async (text: string) => {
      const box = q('[role="textbox"]')
      await act(async () => { box.textContent = text; fireEvent.input(box) })
    }
    // The box as drawn: x, y, w, h in slide px.
    const drawn = () => {
      const s = q(`[data-element-id="${element.id}"]`).style
      const [tx, ty] = (/translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(s.transform) ?? ['', '0', '0']).slice(1).map(Number)
      return [tx * 2, ty * 2, parseFloat(s.width) * 2, parseFloat(s.height) * 2]
    }
    return { q, type, drawn, editElements, updateOverlayProp, updateOverlayProps }
  }

  it('left anchored: grows then shrinks with the text, x fixed', async () => {
    const { type, drawn } = await mountHug('left')
    expect(drawn()).toEqual([100, 140, 20, 40])  // the pill's own box before any typing
    await type('Hi there')           // 8 chars -> 80 wide
    expect(drawn()).toEqual([100, 140, 80, 40])
    await type('Hi there and more')  // 17 -> 170
    expect(drawn().slice(0, 3)).toEqual([100, 140, 170])
    await type('Hi')
    expect(drawn().slice(0, 3)).toEqual([100, 140, 20])
  })

  it('centered keeps the centre, right keeps the right edge', async () => {
    const c = await mountHug('center')
    await c.type('Hi there')
    expect(c.drawn().slice(0, 3)).toEqual([100 + (400 - 80) / 2, 140, 80])
    const r = await mountHug('right')
    await r.type('Hi there')
    const [x, , w] = r.drawn()
    expect(x + w).toBe(500)
  })

  it('draws the draft text in the overlay and writes nothing per keystroke', async () => {
    const t = await mountHug('left')
    await t.type('Hi there')
    await t.type('Hi there!')
    expect(t.q('[data-testid="label"]').textContent).toBe('Hi there!')
    expect(t.editElements).not.toHaveBeenCalled()
    expect(t.updateOverlayProp).not.toHaveBeenCalled()
    expect(t.updateOverlayProps).not.toHaveBeenCalled()
  })

  it('an edit back to the original text closes without a write and restores the box', async () => {
    const t = await mountHug('left')
    await t.type('Hi there and more')
    await t.type('Hi')
    await act(async () => { fireEvent.keyDown(t.q('[role="textbox"]'), { key: 'Escape' }) })
    expect(t.q('[data-testid="label"]').textContent).toBe('Hi')
    expect(t.drawn()).toEqual([100, 140, 20, 40])
    expect(t.editElements).not.toHaveBeenCalled()
  })

  it('commit writes text and the fitted box in one step', async () => {
    const t = await mountHug('left')
    await t.type('Hi there')
    await act(async () => { fireEvent.keyDown(t.q('[role="textbox"]'), { key: 'Enter' }) })
    expect(t.editElements).toHaveBeenCalledTimes(1)
    const [, edit] = t.editElements.mock.calls[0] as unknown as [string, (e: unknown[]) => Array<Record<string, unknown>>]
    const out = edit([el('left')])[0] as { x: number; y: number; w: number; h: number; overlay: { props: Record<string, unknown> } }
    expect([out.x, out.y, out.w, out.h]).toEqual([100, 140, 80, 40])
    expect(out.overlay.props.text).toBe('Hi there')
    expect(t.updateOverlayProp).not.toHaveBeenCalled()
  })

  it('a custom overlay wider than its box grows the box, never shrinks it', async () => {
    rects()
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.getAttribute('data-testid') === 'label' ? 10 * (this.textContent ?? '').length + 400 : 0 } })
    try {
      const editElements = vi.fn(async () => {})
      const compile = vi.fn(async () => (_f: number, _fps: number, _d: number, props: Record<string, unknown>) => <div><div data-testid="label">{String(props.text)}</div></div>)
      const element = pillOverlay({ x: 100, y: 100, w: 400, h: 120, overlay: { template: '/t/c.jsx', props: { text: 'Hi' } } } as Partial<OverlayElement>)
      const r = render(<SlideCanvas slide={{ id: 's', base_color: '#fff', elements: [element] }} width={1080} height={1080} interactive selectedElementId="pill" scale={0.5} compileOverlay={compile as never} editElements={editElements} onSelect={vi.fn()} />)
      await waitFor(() => expect(r.container.querySelector('[data-testid="label"]')).not.toBeNull())
      await act(async () => { fireEvent.doubleClick(r.container.querySelector('[data-element-id="pill"]') as HTMLElement) })
      const box = r.container.querySelector('[role="textbox"]') as HTMLElement
      await act(async () => { box.textContent = 'Hi there'; fireEvent.input(box) })
      const s = (r.container.querySelector('[data-element-id="pill"]') as HTMLElement).style
      expect(parseFloat(s.width) * 2).toBe(480)
    } finally {
      delete (HTMLElement.prototype as { scrollWidth?: unknown }).scrollWidth
    }
  })
})

