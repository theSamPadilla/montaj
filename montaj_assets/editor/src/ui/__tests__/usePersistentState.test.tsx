/// <reference types="vitest/globals" />
/**
 * The layout preferences that survive a reload (timeline pane height, caption
 * row visibility). What matters is that a bad or hostile stored value can never
 * take the editor down — a preference is not worth a crash the user can only
 * escape by clearing site data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { reviveBoolean, reviveNumberInRange, usePersistentState } from '../usePersistentState'

const KEY = 'test.pref'

function Probe({ revive = reviveNumberInRange(10, 100), initial = 50 } = {}) {
  const [value, set] = usePersistentState(KEY, initial, revive)
  return (
    <div>
      <span data-testid="value">{String(value)}</span>
      <button onClick={() => set(77 as never)}>persist</button>
      <button onClick={() => set(88 as never, { persist: false })}>transient</button>
    </div>
  )
}

beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

describe('usePersistentState', () => {
  it('starts at the initial value when nothing is stored', () => {
    render(<Probe />)
    expect(screen.getByTestId('value').textContent).toBe('50')
  })

  it('restores a previously stored value', () => {
    window.localStorage.setItem(KEY, '42')
    render(<Probe />)
    expect(screen.getByTestId('value').textContent).toBe('42')
  })

  it('writes through on a normal set', () => {
    render(<Probe />)
    fireEvent.click(screen.getByText('persist'))
    expect(screen.getByTestId('value').textContent).toBe('77')
    expect(window.localStorage.getItem(KEY)).toBe('77')
  })

  it('applies a transient set without writing it — the drag-frame case', () => {
    // Every mousemove of a divider drag calls this; persisting each one would
    // mean ~60 localStorage writes a second for a value only the last of which
    // matters.
    render(<Probe />)
    fireEvent.click(screen.getByText('transient'))
    expect(screen.getByTestId('value').textContent).toBe('88')
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('rejects a stored value outside the allowed range', () => {
    // A height saved on a much taller window must not open the editor with the
    // preview pushed off-screen.
    window.localStorage.setItem(KEY, '99999')
    render(<Probe />)
    expect(screen.getByTestId('value').textContent).toBe('50')
  })

  it('falls back to the initial value on unparseable JSON', () => {
    window.localStorage.setItem(KEY, 'not json{')
    render(<Probe />)
    expect(screen.getByTestId('value').textContent).toBe('50')
  })

  it('falls back on a value of the wrong type', () => {
    window.localStorage.setItem(KEY, '"tall"')
    render(<Probe />)
    expect(screen.getByTestId('value').textContent).toBe('50')
  })

  it('survives localStorage throwing on read — Safari private mode', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    render(<Probe />)
    expect(screen.getByTestId('value').textContent).toBe('50')
    spy.mockRestore()
  })

  it('survives localStorage throwing on write, keeping the value in memory', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    render(<Probe />)
    act(() => { fireEvent.click(screen.getByText('persist')) })
    expect(screen.getByTestId('value').textContent).toBe('77')
    spy.mockRestore()
  })
})

describe('revivers', () => {
  it('reviveNumberInRange accepts the bounds and rejects everything unusable', () => {
    const revive = reviveNumberInRange(10, 100)
    expect(revive(10)).toBe(10)
    expect(revive(100)).toBe(100)
    expect(revive(9)).toBeNull()
    expect(revive(101)).toBeNull()
    expect(revive(Number.NaN)).toBeNull()
    expect(revive(Number.POSITIVE_INFINITY)).toBeNull()
    expect(revive('50')).toBeNull()
    expect(revive(null)).toBeNull()
  })

  it('reviveBoolean takes only real booleans', () => {
    expect(reviveBoolean(true)).toBe(true)
    expect(reviveBoolean(false)).toBe(false)
    expect(reviveBoolean('true')).toBeNull()
    expect(reviveBoolean(1)).toBeNull()
  })
})
