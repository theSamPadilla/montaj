/// <reference types="vitest/globals" />
/**
 * SocialPreviewMenu — the "Preview for social media" platform picker. These
 * tests cover the picker's own contract: it lists all four entries (TikTok /
 * YouTube Shorts / Instagram Reels / None), calls `onChange` with the right
 * platform (or `null` for None) and closes itself, and marks the active
 * entry with a checkmark via `aria-checked` — the same `role="menuitemradio"`
 * shape `ImageToneMenu.tsx` uses for its own list of exclusive options.
 *
 * The popover portals to `document.body` (see the component's doc comment),
 * so these tests query `document.body` directly rather than a render
 * container. jsdom does no layout, so `getBoundingClientRect()` on the
 * anchor/popover both resolve to all-zero rects — the component still
 * measures and sets a position from those, it's just not a meaningful one;
 * none of these tests assert on the numeric position.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { createRef } from 'react'
import SocialPreviewMenu from '../SocialPreviewMenu'

afterEach(() => {
  cleanup()
})

function Harness({ value, onChange, onClose }: {
  value: 'tiktok' | 'youtube' | 'instagram' | null
  onChange: (p: 'tiktok' | 'youtube' | 'instagram' | null) => void
  onClose: () => void
}) {
  const anchorRef = createRef<HTMLButtonElement>()
  return (
    <>
      <button ref={anchorRef}>trigger</button>
      <SocialPreviewMenu anchorRef={anchorRef} value={value} onChange={onChange} onClose={onClose} />
    </>
  )
}

describe('SocialPreviewMenu — lists every entry', () => {
  it('shows TikTok, YouTube Shorts, Instagram Reels and None', () => {
    render(<Harness value={null} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByLabelText('TikTok')).toBeTruthy()
    expect(screen.getByLabelText('YouTube Shorts')).toBeTruthy()
    expect(screen.getByLabelText('Instagram Reels')).toBeTruthy()
    expect(screen.getByLabelText('None')).toBeTruthy()
  })

  it('shows the "Preview for social media" title and its caption', () => {
    render(<Harness value={null} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Preview for social media')).toBeTruthy()
    expect(screen.getByText('What you see may vary depending on your device.')).toBeTruthy()
  })

  it('gives every row (including None) a decorative, aria-hidden platform glyph', () => {
    render(<Harness value={null} onChange={vi.fn()} onClose={vi.fn()} />)
    for (const label of ['TikTok', 'YouTube Shorts', 'Instagram Reels', 'None']) {
      const row = screen.getByLabelText(label)
      // The glyph is decorative — the row's accessible name stays the plain
      // platform label (asserted above), never the icon.
      expect(row.querySelector('[aria-hidden="true"]')).toBeTruthy()
    }
  })
})

describe('SocialPreviewMenu — selection', () => {
  it('clicking a platform calls onChange with that platform and closes the menu', () => {
    const onChange = vi.fn()
    const onClose = vi.fn()
    render(<Harness value={null} onChange={onChange} onClose={onClose} />)

    fireEvent.click(screen.getByLabelText('YouTube Shorts'))
    expect(onChange).toHaveBeenCalledWith('youtube')
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking None calls onChange with null', () => {
    const onChange = vi.fn()
    render(<Harness value="tiktok" onChange={onChange} onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('None'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('marks the active entry aria-checked, and only that one', () => {
    render(<Harness value="instagram" onChange={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByLabelText('Instagram Reels').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('TikTok').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText('YouTube Shorts').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText('None').getAttribute('aria-checked')).toBe('false')
  })

  it('marks None active when value is null', () => {
    render(<Harness value={null} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByLabelText('None').getAttribute('aria-checked')).toBe('true')
  })
})

describe('SocialPreviewMenu — dismissal', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<Harness value={null} onChange={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on an outside click', () => {
    const onClose = vi.fn()
    render(<Harness value={null} onChange={vi.fn()} onClose={onClose} />)
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close on a click on the trigger itself (the trigger owns its own toggle)', () => {
    const onClose = vi.fn()
    render(<Harness value={null} onChange={vi.fn()} onClose={onClose} />)
    fireEvent.mouseDown(screen.getByText('trigger'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
