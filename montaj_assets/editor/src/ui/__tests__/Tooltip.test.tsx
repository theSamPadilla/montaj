/// <reference types="vitest/globals" />
/**
 * The styled hover pill that replaced native `title=` on the editor's tool
 * buttons. What matters is that it appears on hover with no delay, leaves on
 * every exit path, and renders outside the trigger's clipping ancestors.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Tooltip } from '../Tooltip'

afterEach(() => cleanup())

function renderTooltip(props: Partial<React.ComponentProps<typeof Tooltip>> = {}) {
  return render(
    <Tooltip label="Undo" {...props}>
      <button aria-label="Undo">u</button>
    </Tooltip>,
  )
}

describe('Tooltip', () => {
  it('is absent until hover, then shows the label immediately', () => {
    renderTooltip()
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.mouseEnter(screen.getByLabelText('Undo').parentElement!)
    // No timers advanced: the pill is up on the first event, unlike `title=`.
    expect(screen.getByRole('tooltip').textContent).toContain('Undo')
  })

  it('renders shortcut chips as <kbd> after the label', () => {
    renderTooltip({ keys: ['⌘', 'Z'] })
    fireEvent.mouseEnter(screen.getByLabelText('Undo').parentElement!)

    const chips = screen.getAllByText(/^[⌘Z]$/)
    expect(chips.map((c) => c.tagName)).toEqual(['KBD', 'KBD'])
  })

  it('hides on mouse leave', () => {
    renderTooltip()
    const wrapper = screen.getByLabelText('Undo').parentElement!
    fireEvent.mouseEnter(wrapper)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('hides on press, so a button that opens a modal leaves no orphan pill', () => {
    renderTooltip()
    const wrapper = screen.getByLabelText('Undo').parentElement!
    fireEvent.mouseEnter(wrapper)
    fireEvent.mouseDown(wrapper)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows on keyboard focus and hides on blur', () => {
    renderTooltip()
    const button = screen.getByLabelText('Undo')
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    fireEvent.blur(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('portals the pill to document.body, escaping the trigger\'s overflow ancestors', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <Tooltip label="Fit to view">
          <button aria-label="Fit to view">fit</button>
        </Tooltip>
      </div>,
    )
    fireEvent.mouseEnter(screen.getByLabelText('Fit to view').parentElement!)

    const pill = screen.getByRole('tooltip')
    expect(container.contains(pill)).toBe(false)
    expect(document.body.contains(pill)).toBe(true)
    // Fixed positioning is what makes the escape work — an absolute pill would
    // still resolve against a positioned ancestor.
    expect(pill.className).toContain('fixed')
  })

  it('is inert to the pointer, so it can never eat the click it describes', () => {
    const onClick = vi.fn()
    render(
      <Tooltip label="Split at playhead">
        <button aria-label="Split" onClick={onClick}>s</button>
      </Tooltip>,
    )
    const button = screen.getByLabelText('Split')
    fireEvent.mouseEnter(button.parentElement!)
    expect(screen.getByRole('tooltip').className).toContain('pointer-events-none')

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('puts layout classes on the wrapper, which is the flex item', () => {
    renderTooltip({ className: 'mr-auto' })
    const wrapper = screen.getByLabelText('Undo').parentElement!
    expect(wrapper.className).toBe('inline-flex mr-auto')
  })
})
