import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import CommandPalette from '../video/CommandPalette'
import { InlineTextEditor } from '../text/InlineTextEditor'
import { NoteArmLayer } from '../carousel/NoteLayers'
import ControlsInfoModal from '../ControlsInfoModal'

afterEach(() => cleanup())

// Components too heavy to mount here are covered by asserting the attribute in
// the source of the exact element (matched by a nearby anchor string).
const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const src = (p: string) => readFileSync(join(SRC, p), 'utf8')
describe('editor controls are named for the accessibility tree', () => {
  it('CommandPalette: dialog, and both inputs are named (goto and list)', () => {
    const { unmount } = render(<CommandPalette commands={[{ id: 'a', label: 'Alpha', run: vi.fn() }]} onGoToTime={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    expect(screen.getByLabelText('Search commands')).toBeTruthy()
    unmount()
    render(<CommandPalette commands={[]} initialMode="goto" onGoToTime={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Go to time')).toBeTruthy()
  })

  it('CommandPalette: the backdrop is presentation and still closes on click', () => {
    const onClose = vi.fn()
    render(<CommandPalette commands={[]} onGoToTime={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('presentation'))
    expect(onClose).toHaveBeenCalled()
  })

  it('InlineTextEditor: the textarea is named', () => {
    render(<InlineTextEditor initialValue="hi" rect={{ left: 0, top: 0, width: 10, height: 10 }} styleSnapshot={{}} onCommit={vi.fn()} onCancel={vi.fn()} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Edit text')).toBeTruthy()
  })

  it('NoteArmLayer: exposes a named button and still reports the click', () => {
    const onPlace = vi.fn()
    render(<NoteArmLayer onPlace={onPlace} />)
    fireEvent.click(screen.getByRole('button', { name: 'Place note' }))
    expect(onPlace).toHaveBeenCalled()
  })

  it('ControlsInfoModal: one dialog, inner stopper is presentation', () => {
    render(<ControlsInfoModal title="Editor controls" sections={[]} onClose={vi.fn()} />)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getAllByRole('presentation').length).toBeGreaterThan(0)
  })

  describe('source assertions (components too heavy to mount in this harness)', () => {
    it('OverlayPicker: backdrop presentation, panel is a named modal dialog', () => {
      const s = src('carousel/OverlayPicker.tsx')
      expect(s).toContain('role="presentation"')
      expect(s).toContain('role="dialog" aria-modal="true" aria-label="Add overlay"')
    })
    it('AddElementMenu / VersionPanel: placeholder-only fields have aria-label', () => {
      expect(src('carousel/AddElementMenu.tsx')).toContain('aria-label="Describe the image to generate"')
      expect(src('video/VersionPanel.tsx')).toContain('aria-label="Version name"')
    })
    it('CarouselEditor: slide thumbnail is a keyboard-operable button (Enter and Space select)', () => {
      const s = src('carousel/CarouselEditor.tsx')
      expect(s).toContain('role="button"')
      expect(s).toContain('tabIndex={0}')
      expect(s).toContain("aria-label={`Slide ${idx + 1}`}")
      expect(s).toContain("e.key === 'Enter' || e.key === ' '")
    })
    it('RenderModal: lightbox image is a button with Enter/Space paging, stoppers are presentation', () => {
      const s = src('video/RenderModal.tsx')
      expect(s).toContain("role={canNavCurves ? 'button' : 'img'}")
      expect(s).toContain("if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goCurve(1) }")
      expect(s.match(/role="presentation" className="(relative flex items-center|flex items-center gap-2 text-xs)/g)).toHaveLength(2)
    })
    it('PreviewPlayer: both play/pause click layers are named buttons', () => {
      const s = src('video/preview/PreviewPlayer.tsx')
      expect(s.match(/role="button"\s+aria-label="Play or pause"|role="button" aria-label="Play or pause"/g)).toHaveLength(2)
    })
    it('Timeline: root group is named; both menu backdrops are aria-hidden', () => {
      const s = src('video/timeline/Timeline.tsx')
      expect(s).toContain('role="group"\n      aria-label="Timeline"')
      for (const id of ['fade-curve-menu-backdrop', 'keyframe-menu-backdrop']) {
        expect(s).toContain(`data-testid="${id}"\n              aria-hidden="true"`)
      }
      expect(src('video/timeline/canvas/TimelineCanvas.tsx')).toContain('role="group"\n      aria-label="Timeline tracks"')
    })
    it('SlideCanvas / TextFormattingToolbar: stage and element wrappers carry a role', () => {
      const s = src('carousel/SlideCanvas.tsx')
      expect(s).toContain("aria-label={interactive ? 'Slide canvas' : undefined}")
      expect(s).toContain('aria-label={interactive ? `${element.type} element` : undefined}')
      expect(src('text/TextFormattingToolbar.tsx')).toContain('role="presentation"')
    })
  })
})
