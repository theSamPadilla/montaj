import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import CommandPalette, { type PaletteCommand } from '../CommandPalette'

afterEach(() => cleanup())

function makeCommands(): PaletteCommand[] {
  return [
    { id: 'split', label: 'Split at playhead', run: vi.fn() },
    { id: 'undo', label: 'Undo', run: vi.fn() },
    { id: 'zoom-fit', label: 'Zoom to fit', run: vi.fn() },
  ]
}

describe('CommandPalette', () => {
  it('filters the list as the query changes', () => {
    const commands = makeCommands()
    render(<CommandPalette commands={commands} onGoToTime={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Split at playhead')).toBeTruthy()
    expect(screen.getByText('Undo')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Type a command…'), { target: { value: 'zoom' } })
    expect(screen.queryByText('Split at playhead')).toBeNull()
    expect(screen.getByText('Zoom to fit')).toBeTruthy()
  })

  it('Enter runs the highlighted command and closes', () => {
    const commands = makeCommands()
    const onClose = vi.fn()
    render(<CommandPalette commands={commands} onGoToTime={vi.fn()} onClose={onClose} />)
    const input = screen.getByPlaceholderText('Type a command…')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(commands[0].run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ArrowDown moves the highlight before Enter runs it', () => {
    const commands = makeCommands()
    render(<CommandPalette commands={commands} onGoToTime={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command…')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(commands[1].run).toHaveBeenCalledTimes(1)
    expect(commands[0].run).not.toHaveBeenCalled()
  })

  it('Escape closes without running anything', () => {
    const commands = makeCommands()
    const onClose = vi.fn()
    render(<CommandPalette commands={commands} onGoToTime={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(screen.getByPlaceholderText('Type a command…'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(commands.every((c) => (c.run as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true)
  })

  it('clicking a command runs it and closes', () => {
    const commands = makeCommands()
    const onClose = vi.fn()
    render(<CommandPalette commands={commands} onGoToTime={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByText('Undo'))
    expect(commands[1].run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('typing letters filters instead of triggering any single-key binding', () => {
    // The palette owns its own onKeyDown on the input — arbitrary letters
    // (that would be single-key shortcuts elsewhere, e.g. 's') must only
    // ever filter the list here, never run a command as a side effect of
    // being typed.
    const commands = makeCommands()
    render(<CommandPalette commands={commands} onGoToTime={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command…')
    fireEvent.keyDown(input, { key: 's' })
    fireEvent.change(input, { target: { value: 's' } })
    expect(commands.every((c) => (c.run as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true)
    expect(screen.getByText('Split at playhead')).toBeTruthy()
  })

  describe('goto mode', () => {
    it('parses a valid timecode on Enter and closes', () => {
      const onGoToTime = vi.fn()
      const onClose = vi.fn()
      render(<CommandPalette commands={makeCommands()} initialMode="goto" onGoToTime={onGoToTime} onClose={onClose} />)
      const input = screen.getByPlaceholderText(/mm:ss/)
      fireEvent.change(input, { target: { value: '1:30' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onGoToTime).toHaveBeenCalledWith(90)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('shows an error and does not close on an unparseable timecode', () => {
      const onGoToTime = vi.fn()
      const onClose = vi.fn()
      render(<CommandPalette commands={makeCommands()} initialMode="goto" onGoToTime={onGoToTime} onClose={onClose} />)
      const input = screen.getByPlaceholderText(/mm:ss/)
      fireEvent.change(input, { target: { value: 'garbage' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onGoToTime).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByText(/couldn.t parse/i)).toBeTruthy()
    })

    it('Escape closes outright when opened directly into goto mode', () => {
      const onClose = vi.fn()
      render(<CommandPalette commands={makeCommands()} initialMode="goto" onGoToTime={vi.fn()} onClose={onClose} />)
      fireEvent.keyDown(screen.getByPlaceholderText(/mm:ss/), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('clicking the backdrop closes the palette', () => {
    const onClose = vi.fn()
    render(<CommandPalette commands={makeCommands()} onGoToTime={vi.fn()} onClose={onClose} />)
    // Portal-rendered to document.body — not inside `render`'s own container.
    const backdrop = document.body.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
