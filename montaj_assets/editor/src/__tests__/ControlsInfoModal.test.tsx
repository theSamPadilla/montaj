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
    expect(carouselLabels).toEqual(expect.arrayContaining(['Double-click text to edit it', 'Shift-click to select several']))
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

  it('lists the carousel clipboard, nudge, layer and deselect keys under Keyboard (§556)', () => {
    const keyboard = CAROUSEL_CONTROLS.find((s) => s.heading === 'Keyboard')!
    // What was there stays, in its place.
    expect(keyboard.entries.slice(0, 4).map((e) => e.label)).toEqual(['Undo', 'Redo', 'Remove the selected element', 'Add a note'])
    expect(keyboard.entries.slice(4)).toEqual([
      { keys: ['⌘', 'C'], label: 'Copy' },
      { keys: ['⌘', 'X'], label: 'Cut' },
      { keys: ['⌘', 'V'], label: 'Paste' },
      { keys: ['⌘', 'D'], label: 'Duplicate' },
      { keys: ['⌘', 'A'], label: 'Select all' },
      { keys: ['←', '↑', '↓', '→'], label: 'Nudge' },
      { keys: ['⇧', '←', '↑', '↓', '→'], label: 'Nudge further' },
      { keys: ['⌘', ']'], label: 'Bring forward' },
      { keys: ['⌘', '['], label: 'Send backward' },
      { keys: ['⌘', '⌥', ']'], label: 'Bring to front' },
      { keys: ['⌘', '⌥', '['], label: 'Send to back' },
      { keys: ['⌥', '⇧', 'L'], label: 'Lock or unlock' },
      { keys: ['Esc'], label: 'Deselect' },
    ])
  })

  it('shows the carousel keys in the window: a row each, the modifiers as chips', () => {
    const restore = stubPlatform('MacIntel')
    try {
      render(<ControlsInfoModal title="Editor controls" sections={CAROUSEL_CONTROLS} onClose={vi.fn()} />)
      for (const label of ['Copy', 'Cut', 'Paste', 'Duplicate', 'Select all', 'Nudge', 'Nudge further', 'Bring forward', 'Send backward', 'Bring to front', 'Send to back', 'Deselect']) {
        expect(screen.getByText(label)).toBeTruthy()
      }
      const row = screen.getByText('Bring to front').closest('li')!
      expect([...row.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘', '⌥', ']'])
      const nudge = screen.getByText('Nudge further').closest('li')!
      expect([...nudge.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⇧', '←', '↑', '↓', '→'])
    } finally {
      restore()
    }
  })

  it('lists the carousel crop and ratio gestures under Canvas (§556)', () => {
    const canvas = CAROUSEL_CONTROLS.find((s) => s.heading === 'Canvas')!
    // Every row is a mouse gesture: a glyph, no key chips.
    expect(canvas.entries.every((e) => e.icon && !e.keys)).toBe(true)
    expect(canvas.entries.map((e) => e.label)).toEqual([
      'Drag an element to reposition it',
      'Resize or rotate it via the handles',
      'Shift-drag a corner to free the ratio',
      'Double-click text to edit it',
      'Double-click an image to crop it',
      'Shift-click to select several',
    ])
  })

  it('shows the carousel crop and ratio gestures in the window', () => {
    render(<ControlsInfoModal title="Editor controls" sections={CAROUSEL_CONTROLS} onClose={vi.fn()} />)
    for (const label of ['Double-click an image to crop it', 'Shift-drag a corner to free the ratio']) {
      // "Shift" in the label is a word, so it reads the same off Apple and has no chip of its own.
      expect(screen.getByText(label).closest('li')!.querySelectorAll('kbd')).toHaveLength(0)
    }
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
