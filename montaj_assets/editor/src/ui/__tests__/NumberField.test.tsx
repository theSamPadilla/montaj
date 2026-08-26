import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NumberField, stepValue } from '../NumberField'

/** Renders with sensible defaults, returning the spies and `rerender` so a
 *  test can simulate the host re-rendering with a CHANGED value — the playback
 *  tick this component's `draft` exists to survive. */
function setup(props: Partial<React.ComponentProps<typeof NumberField>> = {}) {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onStep = vi.fn()
  const all = { name: 'Offset X', value: 10, onPreview, onCommit, onStep, step: 1, ...props }
  const { rerender } = render(<NumberField {...all} />)
  return {
    onPreview,
    onCommit,
    onStep,
    input: () => screen.getByLabelText(all.name) as HTMLInputElement,
    rerender: (next: Partial<React.ComponentProps<typeof NumberField>>) =>
      rerender(<NumberField {...all} {...next} />),
  }
}

describe('NumberField — typing gesture', () => {
  it('shows the controlled value under its accessible name', () => {
    const { input } = setup()
    expect(input()).toHaveValue(10)
  })

  it('previews the parsed number on every keystroke, without committing', () => {
    const { input, onPreview, onCommit } = setup()

    fireEvent.change(input(), { target: { value: '4' } })
    fireEvent.change(input(), { target: { value: '42' } })

    expect(onPreview.mock.calls).toEqual([[4], [42]])
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits ONCE on blur, carrying the last previewed value', () => {
    const { input, onCommit } = setup()

    fireEvent.change(input(), { target: { value: '4' } })
    fireEvent.change(input(), { target: { value: '42' } })
    fireEvent.blur(input())

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(42)
  })

  it('commits on Enter, through that same blur path', () => {
    const { input, onCommit } = setup()

    input().focus()
    fireEvent.change(input(), { target: { value: '42' } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(input())
  })

  it('does not double-fire when Enter is followed by a blur', () => {
    const { input, onCommit } = setup()

    input().focus()
    fireEvent.change(input(), { target: { value: '42' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.blur(input())

    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commits NOTHING when the field was focused but never edited', () => {
    // A pointless save and an undo entry for a no-op.
    const { input, onPreview, onCommit } = setup()

    fireEvent.focus(input())
    fireEvent.blur(input())

    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits NOTHING when the only keystrokes were unparseable', () => {
    const { input, onCommit } = setup()

    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.blur(input())

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('re-arms for the NEXT gesture after committing', () => {
    const { input, onCommit } = setup()

    fireEvent.change(input(), { target: { value: '42' } })
    fireEvent.blur(input())

    fireEvent.change(input(), { target: { value: '43' } })
    fireEvent.blur(input())

    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenLastCalledWith(43)
  })

  it('emits nothing for the mid-typing states an operator passes through', () => {
    const { input, onPreview } = setup()

    fireEvent.change(input(), { target: { value: '' } }) // cleared the box
    fireEvent.change(input(), { target: { value: '-' } }) // typing "-5"

    expect(onPreview).not.toHaveBeenCalled()
  })

  it('holds the emptied box open rather than snapping back to the live value', () => {
    // Nothing reaches the caller (previous test), but a box that refilled
    // itself the instant it was cleared would be unusable — the draft has to
    // stay authoritative through an unparseable state too, not just a valid
    // one, and through a value change arriving during it.
    const { input, rerender } = setup()

    fireEvent.change(input(), { target: { value: '' } })
    expect(input().value).toBe('')

    rerender({ value: 77 })
    expect(input().value).toBe('')
  })
})

describe('NumberField — a mid-typed value survives a value change (the reason `draft` exists)', () => {
  it('does not clobber the typed text when the host re-renders with a new value', () => {
    const { input, rerender } = setup()

    fireEvent.change(input(), { target: { value: '4' } }) // mid-typing "4" of "42"
    expect(input()).toHaveValue(4)

    // A playback tick arrives while the field is still mid-edit. Before
    // `draft`, this forced the controlled input back to the incoming prop and
    // ate the keystroke.
    rerender({ value: 77 })
    expect(input()).toHaveValue(4)

    fireEvent.change(input(), { target: { value: '42' } })
    expect(input()).toHaveValue(42)
  })

  it('goes back to tracking the live value once the gesture commits', () => {
    const { input, rerender } = setup()

    fireEvent.change(input(), { target: { value: '4' } })
    rerender({ value: 77 })
    fireEvent.blur(input())

    // Proves blur RELEASED the draft rather than freezing the typed text.
    expect(input()).toHaveValue(77)
  })

  it('tracks the live value while untouched — an animating prop still animates', () => {
    const { input, rerender } = setup()

    rerender({ value: 55 })

    expect(input()).toHaveValue(55)
  })
})

describe('NumberField — steppers', () => {
  it('nudges in each direction as a discrete edit, never a preview/commit pair', () => {
    const { onStep, onPreview, onCommit } = setup({ name: 'Opacity' })

    fireEvent.click(screen.getByRole('button', { name: 'Increase Opacity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Opacity' }))

    expect(onStep.mock.calls).toEqual([[1], [-1]])
    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('renders no steppers at all when the caller has no discrete nudge for them', () => {
    setup({ onStep: undefined })

    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('NumberField — decoration', () => {
  it('renders the prefix and unit, hidden from assistive tech', () => {
    setup({ prefix: 'X', unit: '%' })

    // The accessible name still reads once, from the box's own aria-label.
    expect(screen.getByLabelText('Offset X')).toBeInTheDocument()
    expect(screen.getByText('X')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('%')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows an empty box for a value the caller has no explicit setting for', () => {
    // `''` is not zero — it means "nothing stored", and the placeholder is
    // what makes the field honest about what is actually in force.
    const { input } = setup({ value: '', placeholder: '1.3' })

    expect(input().value).toBe('')
    expect(input()).toHaveAttribute('placeholder', '1.3')
  })

  it('renders an EMPTY placeholder as a real attribute, not an absent one', () => {
    // A caller whose active default has no value to report still needs the
    // attribute there — dropping it would fall back to some other placeholder.
    const { input } = setup({ value: '', placeholder: '' })

    expect(input()).toHaveAttribute('placeholder', '')
  })

  it('shows a stored value rather than the placeholder when it has one', () => {
    const { input } = setup({ value: '0.08', placeholder: '-0.02' })

    expect(input().value).toBe('0.08')
    expect(input()).toHaveAttribute('placeholder', '-0.02')
  })

  it('snaps an emptied box back to the live value on blur', () => {
    const { input } = setup({ value: 10 })

    fireEvent.change(input(), { target: { value: '' } })
    expect(input().value).toBe('')

    fireEvent.blur(input())

    expect(input()).toHaveValue(10)
  })

  it('passes step/min/max to the box for native validation', () => {
    const { input } = setup({ step: 0.01, min: 0, max: 1, value: 0.5 })

    expect(input()).toHaveAttribute('step', '0.01')
    expect(input()).toHaveAttribute('min', '0')
    expect(input()).toHaveAttribute('max', '1')
  })

  it('does NOT clamp a typed value — a bound only limits the stepper', () => {
    // Both assertions deliberately use values OUTSIDE the bounds. A value on
    // the boundary would prove nothing: `Math.max(min, 5)` is also 5, so a
    // clamping implementation would pass such a test unchanged.
    const { input, onPreview } = setup({ min: 5, max: 400, value: 100 })

    // Past the ceiling: `500` typed on the way to a bigger number must arrive
    // whole, not rewritten to 400 between keystrokes.
    fireEvent.change(input(), { target: { value: '500' } })
    expect(onPreview).toHaveBeenLastCalledWith(500)

    // And under the floor: `1` typed on the way to `12` must not become 5.
    fireEvent.change(input(), { target: { value: '1' } })
    expect(onPreview).toHaveBeenLastCalledWith(1)
  })
})

describe('NumberField — disabled', () => {
  it('disables the box itself', () => {
    const { input } = setup({ disabled: true })
    expect(input()).toBeDisabled()
  })

  it('disables the steppers too — a live arrow beside a dead box would be a bug', () => {
    setup({ name: 'Opacity', disabled: true })

    expect(screen.getByRole('button', { name: 'Increase Opacity' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decrease Opacity' })).toBeDisabled()
  })

  it('a disabled stepper click does not fire onStep', () => {
    const { onStep } = setup({ name: 'Opacity', disabled: true })

    fireEvent.click(screen.getByRole('button', { name: 'Increase Opacity' }))

    expect(onStep).not.toHaveBeenCalled()
  })
})

describe('stepValue', () => {
  it('increments and decrements by one step', () => {
    expect(stepValue(10, 1, { step: 1 })).toBe(11)
    expect(stepValue(10, -1, { step: 1 })).toBe(9)
  })

  it('rounds away the float noise the nudge itself introduces', () => {
    // 1.2 + 0.01 is 1.2100000000000002 in IEEE 754.
    expect(stepValue(1.2, 1, { step: 0.01 })).toBe(1.21)
  })

  it('clamps at min and max', () => {
    expect(stepValue(0.01, -1, { step: 0.01, min: 0.01 })).toBe(0.01)
    expect(stepValue(1, 1, { step: 0.01, min: 0, max: 1 })).toBe(1)
  })

  it('leaves an unbounded value unbounded', () => {
    expect(stepValue(-5, -1, { step: 1 })).toBe(-6)
    expect(stepValue(999, 1, { step: 1 })).toBe(1000)
  })
})
