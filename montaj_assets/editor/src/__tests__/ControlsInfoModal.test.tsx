import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ControlsInfoModal, {
  VIDEO_CONTROLS,
  CAROUSEL_CONTROLS,
  type ControlSection,
} from '../ControlsInfoModal'

afterEach(() => cleanup())

const SECTIONS: ControlSection[] = [
  {
    heading: 'Canvas',
    entries: [
      { label: 'Drag an element to reposition it' },
      { keys: ['⌘/Ctrl', 'Z'], label: 'Undo' },
    ],
  },
]

describe('ControlsInfoModal', () => {
  it('renders the title, section headings, entry labels, and kbd chips', () => {
    render(<ControlsInfoModal title="Editor controls" sections={SECTIONS} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Editor controls' })).toBeTruthy()
    expect(screen.getByText('Canvas')).toBeTruthy()
    expect(screen.getByText('Drag an element to reposition it')).toBeTruthy()
    // Keys render as individual <kbd> chips.
    expect(screen.getByText('⌘/Ctrl').tagName).toBe('KBD')
    expect(screen.getByText('Z').tagName).toBe('KBD')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<ControlsInfoModal title="Editor controls" sections={SECTIONS} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop click but not on panel click', () => {
    const onClose = vi.fn()
    render(<ControlsInfoModal title="Editor controls" sections={SECTIONS} onClose={onClose} />)

    // Click inside the panel — should NOT close.
    fireEvent.click(screen.getByText('Canvas'))
    expect(onClose).not.toHaveBeenCalled()

    // Click the backdrop (the dialog root) — should close.
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ships real control content for both editors', () => {
    // Guards against an empty/placeholder content regression.
    const videoLabels = VIDEO_CONTROLS.flatMap((s) => s.entries.map((e) => e.label))
    const carouselLabels = CAROUSEL_CONTROLS.flatMap((s) => s.entries.map((e) => e.label))
    expect(videoLabels).toEqual(expect.arrayContaining(['Split at the playhead']))
    expect(carouselLabels).toEqual(expect.arrayContaining(['Double-click text to edit it']))
    expect(VIDEO_CONTROLS.length).toBeGreaterThan(0)
    expect(CAROUSEL_CONTROLS.length).toBeGreaterThan(0)
  })
})
