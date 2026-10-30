/// <reference types="vitest/globals" />
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import TrackContextMenu from '../TrackContextMenu'

afterEach(() => cleanup())

function setup(over: Record<string, unknown> = {}) {
  const fns = { onClose: vi.fn(), onHide: vi.fn(), onRemove: vi.fn() }
  render(<TrackContextMenu x={10} y={10} {...fns} {...over} />)
  return fns
}

describe('TrackContextMenu', () => {
  it('shows Hide track and Remove track with a separator', () => {
    setup()
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map(e => e.textContent)).toEqual(['Hide track', 'Remove track'])
    expect(screen.getByRole('separator')).toBeTruthy()
  })

  it('says Show track when hidden', () => {
    setup({ hidden: true })
    expect(screen.getByRole('menuitem', { name: 'Show track' })).toBeTruthy()
  })

  it('runs the action then closes', () => {
    const f = setup()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide track' }))
    expect(f.onHide).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    expect(f.onRemove).toHaveBeenCalledTimes(1)
    expect(f.onClose).toHaveBeenCalledTimes(2)
  })

  it('a disabled Remove does nothing', () => {
    const f = setup({ removeDisabled: true })
    const item = screen.getByRole('menuitem', { name: 'Remove track' })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(item)
    expect(f.onRemove).not.toHaveBeenCalled()
    expect(f.onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and outside click, not inside', () => {
    const f = setup()
    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(f.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(f.onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(document.body)
    expect(f.onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on scroll, wheel and resize, and removes the listeners after', () => {
    const f = setup()
    fireEvent.scroll(window)
    fireEvent.wheel(window)
    fireEvent(window, new Event('resize'))
    expect(f.onClose).toHaveBeenCalledTimes(3)
    cleanup()
    fireEvent.scroll(window)
    expect(f.onClose).toHaveBeenCalledTimes(3)
  })

  it('an element blur does not close it (a click moves focus)', () => {
    const f = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.blur()
    expect(f.onClose).not.toHaveBeenCalled()
    input.remove()
  })

  it('Escape does not reach other keydown listeners', () => {
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    setup()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    document.removeEventListener('keydown', seen)
    expect(seen).not.toHaveBeenCalled()
  })

  it('renders in document.body, and clicks inside do not bubble out', () => {
    const outer = vi.fn()
    const host = document.createElement('div')
    host.addEventListener('click', outer)
    document.body.appendChild(host)
    setup()
    expect(screen.getByRole('menu').parentElement).toBe(document.body)
    fireEvent.click(screen.getByRole('menu'))
    expect(outer).not.toHaveBeenCalled()
    host.remove()
  })

  it('omits Remove and the separator when canRemove is false', () => {
    setup({ canRemove: false })
    expect(screen.getAllByRole('menuitem').map(e => e.textContent)).toEqual(['Hide track'])
    expect(screen.queryByRole('separator')).toBeNull()
  })
})
