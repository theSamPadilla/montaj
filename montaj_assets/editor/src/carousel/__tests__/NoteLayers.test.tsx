import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { SlidePin } from '../../types'
import { NoteArmLayer, NotePinLayer } from '../NoteLayers'

type PointPin = SlidePin & { x: number; y: number }

const pin = (over: Partial<PointPin> & { id: string }): PointPin => ({ slideId: 's', x: 0.3, y: 0.3, ...over })

function pinEl(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-pin-id="${id}"]`)!
}
const badgeOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-pin-badge]')!
const textOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-pin-text]')

const LONG = 'The logo in the corner reads too small next to the headline so make it bigger and move it up a little, then match the blue of the button below it and check the spacing again before export'

describe('NotePinLayer (§143)', () => {
  it('a badge carries the label, coloured by tone: self accent, review amber, anything else accent; dark text on each', () => {
    const { container } = render(
      <NotePinLayer
        pins={[
          pin({ id: 'a', label: '1', tone: 'self', x: 0.1, y: 0.1 }),
          pin({ id: 'b', label: 'J', tone: 'review', x: 0.5, y: 0.5 }),
          pin({ id: 'c', label: '2', tone: 'other', x: 0.1, y: 0.9 }),
          pin({ id: 'd', label: '3', x: 0.9, y: 0.1 }),
        ]}
      />,
    )
    const a = badgeOf(pinEl(container, 'a'))
    expect(a.textContent).toBe('1')
    expect(a.style.width).toBe('18px')
    expect(a.style.height).toBe('18px')
    expect(a.style.borderRadius).toBe('50%')
    expect(a.style.backgroundColor).toBe('var(--editor-accent)')
    expect(a.style.boxShadow).toContain('1.5px')
    expect(badgeOf(pinEl(container, 'b')).style.backgroundColor).toBe('rgb(245, 181, 68)')
    expect(badgeOf(pinEl(container, 'c')).style.backgroundColor).toBe('var(--editor-accent)')
    expect(badgeOf(pinEl(container, 'd')).style.backgroundColor).toBe('var(--editor-accent)')
    for (const id of ['a', 'b', 'c', 'd']) expect(badgeOf(pinEl(container, id)).style.color).toBe('rgb(3, 7, 18)')
    expect(pinEl(container, 'b').dataset.tone).toBe('review')
  })

  it('defaults to badges: a pin with text shows only its badge', () => {
    const { container } = render(<NotePinLayer pins={[pin({ id: 'a', label: '1', text: 'Bigger logo' })]} />)
    const a = pinEl(container, 'a')
    expect(a.dataset.pinForm).toBe('badge')
    expect(textOf(a)).toBeNull()
  })

  it('chip: the badge plus the first words of the note, on one line with an ellipsis', () => {
    const { container } = render(<NotePinLayer pinDisplay="chip" pins={[pin({ id: 'a', label: '1', text: LONG })]} />)
    const a = pinEl(container, 'a')
    expect(a.dataset.pinForm).toBe('chip')
    expect(badgeOf(a).textContent).toBe('1')
    const t = textOf(a)!
    expect(t.textContent!.startsWith('The logo in the corner')).toBe(true)
    expect(t.textContent).not.toContain('before export')
    expect(t.style.whiteSpace).toBe('nowrap')
    expect(t.style.textOverflow).toBe('ellipsis')
    expect(t.style.overflow).toBe('hidden')
    expect(a.style.maxWidth).toBe('150px')
    expect(a.style.backgroundColor).toBe('rgba(3, 7, 18, 0.82)')
  })

  it('chip without text shows the badge only', () => {
    const { container } = render(<NotePinLayer pinDisplay="chip" pins={[pin({ id: 'a', label: '1' }), pin({ id: 'b', label: '2', text: '   ', x: 0.8, y: 0.8 })]} />)
    expect(textOf(pinEl(container, 'a'))).toBeNull()
    expect(pinEl(container, 'a').dataset.pinForm).toBe('badge')
    expect(textOf(pinEl(container, 'b'))).toBeNull()
  })

  it('the active pin shows its whole text, wrapping, with an accent border, in either display', () => {
    for (const pinDisplay of ['badge', 'chip'] as const) {
      const { container, unmount } = render(<NotePinLayer pinDisplay={pinDisplay} pins={[pin({ id: 'a', label: '1', text: LONG, active: true })]} />)
      const a = pinEl(container, 'a')
      expect(a.dataset.pinForm).toBe('full')
      const t = textOf(a)!
      expect(t.textContent).toBe(LONG)
      expect(t.style.whiteSpace).toBe('pre-wrap')
      expect(a.style.maxWidth).toBe('220px')
      expect(a.style.borderRadius).toBe('12px')
      expect(a.style.border).toContain('var(--editor-accent)')
      expect(a.querySelector('[data-pin-caret]')).toBeNull()
      unmount()
    }
  })

  it('an active pin with no text shows a blinking caret that stops under reduced motion', () => {
    const { container } = render(<NotePinLayer pins={[pin({ id: 'a', label: '1', text: '', active: true })]} />)
    const a = pinEl(container, 'a')
    expect(a.dataset.pinForm).toBe('full')
    const caret = a.querySelector<HTMLElement>('[data-pin-caret]')!
    expect(caret).not.toBeNull()
    const css = Array.from(container.querySelectorAll('style')).map((s) => s.textContent).join('')
    expect(css).toContain('@keyframes')
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(css).toContain(caret.className)
  })

  it('past x 0.6 the pin opens to the left, its badge still on the point', () => {
    const { container } = render(
      <NotePinLayer pinDisplay="chip" pins={[pin({ id: 'r', label: '1', text: 'Too close to the edge', x: 0.7, y: 0.4 }), pin({ id: 'l', label: '2', text: 'Fine here', x: 0.2, y: 0.8 })]} />,
    )
    const r = pinEl(container, 'r')
    expect(r.dataset.pinOpens).toBe('left')
    expect(r.style.right).toBe('30%')
    expect(r.style.left).toBe('')
    expect(r.style.flexDirection).toBe('row-reverse')
    expect(r.style.top).toBe('40%')
    const l = pinEl(container, 'l')
    expect(l.dataset.pinOpens).toBe('right')
    expect(l.style.left).toBe('20%')
    expect(l.style.flexDirection).toBe('row')
  })

  it('a chip crowded by another pin shows its badge until hovered; the active pin always shows in full', () => {
    const { container } = render(
      <NotePinLayer
        pinDisplay="chip"
        pins={[
          pin({ id: 'a', label: '1', text: 'First', x: 0.3, y: 0.3 }),
          pin({ id: 'b', label: '2', text: 'Second', x: 0.35, y: 0.32 }),
          pin({ id: 'c', label: '3', text: 'Alone', x: 0.3, y: 0.8 }),
          pin({ id: 'd', label: '4', text: 'Chosen', x: 0.75, y: 0.5, active: true }),
          pin({ id: 'e', label: '5', text: 'Beside the chosen one', x: 0.7, y: 0.52 }),
        ]}
      />,
    )
    expect(pinEl(container, 'a').dataset.pinForm).toBe('badge')
    expect(pinEl(container, 'b').dataset.pinForm).toBe('badge')
    expect(textOf(pinEl(container, 'b'))).toBeNull()
    expect(pinEl(container, 'c').dataset.pinForm).toBe('chip')
    expect(pinEl(container, 'd').dataset.pinForm).toBe('full')
    expect(pinEl(container, 'e').dataset.pinForm).toBe('badge')

    const b = pinEl(container, 'b')
    fireEvent.pointerEnter(b)
    expect(b.dataset.pinForm).toBe('chip')
    expect(textOf(b)!.textContent).toBe('Second')
    expect(pinEl(container, 'a').dataset.pinForm).toBe('badge')
    fireEvent.pointerLeave(b)
    expect(b.dataset.pinForm).toBe('badge')
  })

  it('names each pin from its label and text', () => {
    const { getByRole } = render(
      <NotePinLayer pins={[pin({ id: 'a', label: '1', text: 'Bigger logo' }), pin({ id: 'b', x: 0.8, y: 0.8 }), pin({ id: 'c', label: 'J', x: 0.1, y: 0.9 })]} />,
    )
    const a = getByRole('button', { name: '1: Bigger logo' })
    expect(a.title).toBe('1: Bigger logo')
    expect(getByRole('button', { name: 'Note' })).toBeTruthy()
    expect(getByRole('button', { name: 'J' })).toBeTruthy()
  })

  it('only the pins take the pointer, and a click reports the pin without reaching the canvas', () => {
    const onPinClick = vi.fn()
    const onCanvasClick = vi.fn()
    const { container } = render(
      <div onClick={onCanvasClick}>
        <NotePinLayer pinDisplay="chip" onPinClick={onPinClick} pins={[pin({ id: 'a', label: '1', text: 'Bigger logo' })]} />
      </div>,
    )
    const a = pinEl(container, 'a')
    expect(a.style.pointerEvents).toBe('auto')
    expect((a.parentElement as HTMLElement).style.pointerEvents).toBe('none')
    fireEvent.click(a)
    expect(onPinClick).toHaveBeenCalledWith('a')
    expect(onCanvasClick).not.toHaveBeenCalled()
  })
})

describe('NoteArmLayer (§143)', () => {
  it('the cursor is an arrow with a chip, falling back to a crosshair', () => {
    const { getByTestId } = render(<NoteArmLayer onPlace={vi.fn()} />)
    const cursor = getByTestId('note-arm-layer').style.cursor
    expect(cursor).toContain('data:image/svg+xml')
    expect(cursor).toMatch(/,\s*crosshair$/)
  })
})
