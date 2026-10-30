/// <reference types="vitest/globals" />
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ConfirmDialog from '../ConfirmDialog'

afterEach(() => cleanup())

function setup(over: Record<string, unknown> = {}) {
  const fns = { onConfirm: vi.fn(), onCancel: vi.fn() }
  render(<ConfirmDialog open title="Remove track and 3 clips?" confirmLabel="Remove" tone="danger" {...fns} {...over} />)
  return fns
}

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    setup({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a modal dialog with the title and focuses Cancel', () => {
    setup()
    const d = screen.getByRole('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('Remove track and 3 clips?')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('Cancel, Escape and the scrim cancel', () => {
    const f = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('dialog').parentElement!)
    expect(f.onCancel).toHaveBeenCalledTimes(3)
    expect(f.onConfirm).not.toHaveBeenCalled()
  })

  it('clicking inside does not cancel; Remove confirms', () => {
    const f = setup()
    fireEvent.click(screen.getByRole('dialog'))
    expect(f.onCancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(f.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Enter on Remove confirms once; Enter on the focused Cancel does not confirm', () => {
    const f = setup()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(f.onConfirm).not.toHaveBeenCalled()
    screen.getByRole('button', { name: 'Remove' }).focus()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(f.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('honours custom cancel label', () => {
    setup({ cancelLabel: 'Keep' })
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy()
  })

  it('keeps every key except Tab away from listeners behind it', () => {
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    setup()
    fireEvent.keyDown(document.body, { key: 'Delete' })
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(seen).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(seen).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', seen)
  })

  it('a scrim click cancels without reaching the page behind', () => {
    const behind = vi.fn()
    const host = document.createElement('div')
    host.addEventListener('click', behind)
    document.body.appendChild(host)
    const f = setup()
    const scrim = screen.getByRole('dialog').parentElement!
    expect(scrim.parentElement).toBe(document.body)
    fireEvent.click(scrim)
    expect(f.onCancel).toHaveBeenCalledTimes(1)
    expect(behind).not.toHaveBeenCalled()
    host.remove()
  })
})
