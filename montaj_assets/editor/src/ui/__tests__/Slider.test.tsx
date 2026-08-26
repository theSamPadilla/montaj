import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Slider } from '../Slider'

function setup(props: Partial<React.ComponentProps<typeof Slider>> = {}) {
  const onChange = vi.fn()
  const onCommit = vi.fn()
  const all = {
    'aria-label': 'Scale slider' as const,
    value: 1,
    min: 0,
    max: 4,
    step: 0.01,
    onChange,
    onCommit,
    ...props,
  }
  render(<Slider {...all} />)
  return {
    onChange,
    onCommit,
    slider: () => screen.getByRole('slider', { name: all['aria-label'] }) as HTMLInputElement,
  }
}

describe('Slider — value + semantics', () => {
  it('exposes the range natively, under its accessible name', () => {
    const { slider } = setup()

    expect(slider().value).toBe('1')
    expect(slider()).toHaveAttribute('type', 'range')
    expect(slider()).toHaveAttribute('min', '0')
    expect(slider()).toHaveAttribute('max', '4')
    expect(slider()).toHaveAttribute('step', '0.01')
  })

  it('previews the parsed number on every change', () => {
    const { slider, onChange } = setup()

    fireEvent.change(slider(), { target: { value: '1.5' } })
    fireEvent.change(slider(), { target: { value: '1.6' } })

    expect(onChange.mock.calls).toEqual([[1.5], [1.6]])
  })
})

describe('Slider — one commit per gesture', () => {
  it('commits ONCE on pointer up, not per change, and not again on the trailing blur', () => {
    const { slider, onCommit } = setup()

    fireEvent.change(slider(), { target: { value: '1.5' } })
    fireEvent.change(slider(), { target: { value: '1.6' } })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider())
    expect(onCommit).toHaveBeenCalledTimes(1)

    // A pointerup is normally followed by a blur — that must not stack a
    // second undo entry onto the same drag.
    fireEvent.blur(slider())
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('reports the last previewed value to the commit', () => {
    const { slider, onCommit } = setup()

    fireEvent.change(slider(), { target: { value: '1.5' } })
    fireEvent.change(slider(), { target: { value: '2.25' } })
    fireEvent.pointerUp(slider())

    expect(onCommit).toHaveBeenCalledWith(2.25)
  })

  it('commits a keyboard adjustment on key up', () => {
    const { slider, onCommit } = setup()

    fireEvent.change(slider(), { target: { value: '1.3' } })
    fireEvent.keyUp(slider(), { key: 'ArrowRight' })

    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commits NOTHING for a gesture that never changed anything', () => {
    // A click landing on the thumb's current position, or a focus/blur that
    // touched nothing, must not spend an undo entry on a no-op.
    const { slider, onCommit } = setup()

    fireEvent.pointerUp(slider())
    fireEvent.keyUp(slider(), { key: 'ArrowRight' })
    fireEvent.blur(slider())

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('re-arms for the NEXT gesture after committing', () => {
    const { slider, onCommit } = setup()

    fireEvent.change(slider(), { target: { value: '1.5' } })
    fireEvent.pointerUp(slider())

    fireEvent.change(slider(), { target: { value: '2' } })
    fireEvent.pointerUp(slider())

    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('is usable with no onCommit at all — a slider whose changes are already final', () => {
    const { slider, onChange } = setup({ onCommit: undefined })

    fireEvent.change(slider(), { target: { value: '2' } })
    expect(() => fireEvent.pointerUp(slider())).not.toThrow()
    expect(onChange).toHaveBeenCalledWith(2)
  })
})

describe('Slider — keyboard', () => {
  it('is focusable, so the native range keyboard bindings apply', () => {
    // The look is replaced, the control is not: it stays a native
    // `<input type="range">` precisely so arrows/Home/End keep working.
    const { slider } = setup()

    slider().focus()

    expect(document.activeElement).toBe(slider())
    expect(slider()).not.toHaveAttribute('tabindex', '-1')
  })

  it('honours `disabled`', () => {
    const { slider } = setup({ disabled: true })

    expect(slider()).toBeDisabled()
  })
})

describe('Slider — theming', () => {
  it('draws track and thumb from theme vars, never a literal color', () => {
    // The control has to read correctly on both the light and dark editor
    // grounds; a hardcoded fill would only work on one of them. This is
    // deliberately the ONLY assertion here — checking for the presence of
    // specific `bg-[var(--editor-*)]` classes would just be `SLIDER_CLASS`
    // copied into the test: it could only fail on a rename (which teaches
    // nothing about rendering) and would false-fail the first legitimate
    // token rename. The real rule this control must never break is "no
    // literal color", which is what stays under test.
    const { slider } = setup()
    const cls = slider().className

    expect(cls).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})
