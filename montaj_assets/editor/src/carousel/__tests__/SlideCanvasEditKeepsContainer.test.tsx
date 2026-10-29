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

async function mount(el: OverlayElement = pillOverlay()) {
  const updateOverlayProp = vi.fn(async () => {})
  const r = render(
    <SlideCanvas
      slide={{ id: 's', base_color: '#ffffff', elements: [el] }}
      width={1080}
      height={1080}
      interactive
      selectedElementId={el.id}
      scale={0.5}
      compileOverlay={compileOverlay}
      updateOverlayProp={updateOverlayProp}
      onSelect={vi.fn()}
    />,
  )
  await waitFor(() => expect(r.container.querySelector('[data-testid="pill"]')).not.toBeNull())
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
})
