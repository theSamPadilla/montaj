import { describe, it, expect } from 'vitest'
import { Keyboard, MousePointer2, Move, SlidersHorizontal } from 'lucide-react'
import {
  CAROUSEL_CONTROLS,
  VIDEO_CONTROLS,
  platformSections,
  type ControlSection,
} from '../ControlsInfoModal'
import { stubPlatform } from '../ui/__tests__/platform'

// `platformSections` is what a host's `renderControls` is handed: the modal's
// content with the platform's keys already in place and each card's icon
// attached, so a host draws it as given and can never show ⌘ on Windows.

const SECTIONS: ControlSection[] = [
  {
    heading: 'Canvas',
    entries: [
      { icon: Move, label: 'Drag an element to reposition it' },
      { keys: ['⌘', '⇧', 'Z'], label: 'Redo' },
    ],
  },
  {
    heading: 'Keyboard',
    entries: [
      { keys: ['⌘', '⌥', 'V'], label: 'Paste attributes' },
      { keys: ['←', '→'], where: 'Timeline', label: 'Step one frame (⇧ for ten frames)' },
    ],
  },
  { heading: 'Something new', entries: [{ label: 'A host heading' }] },
]

describe('platformSections', () => {
  it('spells the modifiers out off Apple, in keys and in labels', () => {
    const out = platformSections(SECTIONS, false)
    expect(out[0].entries[1].keys).toEqual(['Ctrl', 'Shift', 'Z'])
    expect(out[1].entries[0].keys).toEqual(['Ctrl', 'Alt', 'V'])
    expect(out[1].entries[1].keys).toEqual(['←', '→'])
    expect(out[1].entries[1].label).toBe('Step one frame (Shift for ten frames)')
  })

  it('keeps the glyphs on Apple', () => {
    const out = platformSections(SECTIONS, true)
    expect(out[0].entries[1].keys).toEqual(['⌘', '⇧', 'Z'])
    expect(out[1].entries[0].keys).toEqual(['⌘', '⌥', 'V'])
    expect(out[1].entries[1].label).toBe('Step one frame (⇧ for ten frames)')
  })

  it("gives each section the modal's icon for its heading, the slider glyph when unknown", () => {
    for (const apple of [true, false]) {
      const out = platformSections(SECTIONS, apple)
      expect(out.map((s) => s.icon)).toEqual([MousePointer2, Keyboard, SlidersHorizontal])
    }
    expect(platformSections(VIDEO_CONTROLS, false).map((s) => [s.heading, s.icon])).toEqual([
      ['Mouse', MousePointer2],
      ['Toolbar', SlidersHorizontal],
      ['Keyboard', Keyboard],
    ])
    expect(platformSections(CAROUSEL_CONTROLS, false).map((s) => [s.heading, s.icon])).toEqual([
      ['Canvas', MousePointer2],
      ['Keyboard', Keyboard],
    ])
  })

  it('keeps every other field and leaves its input alone', () => {
    const before = JSON.stringify(SECTIONS)
    const out = platformSections(SECTIONS, false)
    expect(JSON.stringify(SECTIONS)).toBe(before)
    expect(out.map((s) => s.heading)).toEqual(['Canvas', 'Keyboard', 'Something new'])
    expect(out[0].entries[0]).toEqual({ icon: Move, label: 'Drag an element to reposition it' })
    expect(out[1].entries[1].where).toBe('Timeline')
    expect(out[2].entries[0]).toEqual({ label: 'A host heading' })
  })

  it('reads the platform from the navigator by default', () => {
    const restoreWin = stubPlatform('Win32')
    try {
      expect(platformSections(SECTIONS)[0].entries[1].keys).toEqual(['Ctrl', 'Shift', 'Z'])
    } finally {
      restoreWin()
    }
    const restoreMac = stubPlatform('MacIntel')
    try {
      expect(platformSections(SECTIONS)[0].entries[1].keys).toEqual(['⌘', '⇧', 'Z'])
    } finally {
      restoreMac()
    }
  })
})
