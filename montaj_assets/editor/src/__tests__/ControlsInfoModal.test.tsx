import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import pkg from '../../package.json'
import ControlsInfoModal, {
  VIDEO_CONTROLS,
  CAROUSEL_CONTROLS,
  type ControlSection,
} from '../ControlsInfoModal'
import { stubPlatform } from '../ui/__tests__/platform'

afterEach(() => cleanup())

const SECTIONS: ControlSection[] = [
  {
    heading: 'Canvas',
    entries: [
      { label: 'Drag an element to reposition it' },
      { keys: ['⌘', 'Z'], label: 'Undo' },
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
    // jsdom's navigator.platform is '' (not Apple), so ⌘ renders as Ctrl.
    expect(screen.getByText('Ctrl').tagName).toBe('KBD')
    expect(screen.getByText('Z').tagName).toBe('KBD')
  })

  it('shows the editor version in the footer, and never vundefined', () => {
    render(<ControlsInfoModal title="Editor controls" sections={SECTIONS} onClose={vi.fn()} />)
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(screen.getByText(`v${pkg.version}`)).toBeTruthy()
    expect(screen.queryByText(/vundefined/)).toBeNull()
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

  it('renders an entry\'s `where` as a pill, not as a key chip', () => {
    render(
      <ControlsInfoModal
        title="Editor controls"
        sections={[{ heading: 'Mouse', entries: [{ where: 'Timeline', label: 'Drag a clip' }] }]}
        onClose={vi.fn()}
      />,
    )
    // A surface name is not something you press, so it must not be a <kbd> —
    // that element is the modal's promise that a row names a keystroke.
    expect(screen.getByText('Timeline').tagName).not.toBe('KBD')
  })

  it('keeps every mouse gesture in ONE section, tagged by surface', () => {
    // Preview and Timeline were two cards; merging them into "Mouse" moved the
    // surface onto each row. Re-splitting is fine, but silently dropping the
    // `where` tags would lose which surface a gesture applies to entirely.
    const mouse = VIDEO_CONTROLS.filter((s) => s.entries.some((e) => e.where))
    expect(mouse).toHaveLength(1)
    expect(mouse[0].heading).toBe('Mouse')
    expect(mouse[0].entries.every((e) => e.where && e.icon)).toBe(true)
    expect(new Set(mouse[0].entries.map((e) => e.where))).toEqual(new Set(['Preview', 'Timeline']))
  })

  it('gives every toolbar row the glyph of its button', () => {
    const toolbar = VIDEO_CONTROLS.find((s) => s.heading === 'Toolbar')!
    expect(toolbar.entries.every((e) => e.icon)).toBe(true)
  })

  it('lists the clipboard and fullscreen shortcuts under Keyboard', () => {
    const keyboard = VIDEO_CONTROLS.find((s) => s.heading === 'Keyboard')!
    const labels = keyboard.entries.map((e) => e.label)
    expect(labels).toEqual(
      expect.arrayContaining([
        'Copy the selection',
        'Paste at the playhead',
        'Duplicate the selection in place',
        'Paste attributes onto the selection',
        'Toggle fullscreen preview',
      ]),
    )
  })

  it('lists N as "Add a note" under Keyboard (PL39)', () => {
    // Static like M: the row is always listed, the binding is the host's opt-in.
    const keyboard = VIDEO_CONTROLS.find((s) => s.heading === 'Keyboard')!
    expect(keyboard.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ keys: ['N'], label: 'Add a note' })]),
    )
  })
})

describe('ControlsInfoModal platform keys', () => {
  const textOf = () => document.body.textContent ?? ''

  it('shows Ctrl, Alt and Shift on Windows, never the glyphs or the combined forms', () => {
    const restore = stubPlatform('Win32')
    try {
      render(<ControlsInfoModal title="Controls" sections={VIDEO_CONTROLS} onClose={vi.fn()} />)
      const kbds = [...document.querySelectorAll('kbd')].map((k) => k.textContent)
      expect(kbds).toEqual(expect.arrayContaining(['Ctrl', 'Alt', 'Shift']))
      for (const bad of ['⌘', '⌥', '⇧', '⌘/Ctrl', '⌥/Alt']) expect(textOf()).not.toContain(bad)
      expect(screen.getByText('Step one frame (Shift for ten frames)')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('shows the glyphs on a Mac, never the combined forms', () => {
    const restore = stubPlatform('MacIntel')
    try {
      render(<ControlsInfoModal title="Controls" sections={VIDEO_CONTROLS} onClose={vi.fn()} />)
      const kbds = [...document.querySelectorAll('kbd')].map((k) => k.textContent)
      expect(kbds).toEqual(expect.arrayContaining(['⌘', '⌥', '⇧']))
      expect(textOf()).not.toContain('⌘/Ctrl')
      expect(textOf()).not.toContain('⌥/Alt')
      expect(screen.getByText('Step one frame (⇧ for ten frames)')).toBeTruthy()
    } finally {
      restore()
    }
  })
})
