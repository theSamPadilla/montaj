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
