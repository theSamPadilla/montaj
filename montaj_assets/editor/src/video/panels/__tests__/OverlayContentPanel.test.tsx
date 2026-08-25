/// <reference types="vitest/globals" />
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { VisualItem } from '../../../schema'
import OverlayContentPanel from '../OverlayContentPanel'

afterEach(cleanup)

function overlayItem(props: Record<string, unknown>): VisualItem {
  return { id: 'overlay-1', type: 'overlay', src: 'scoreboard.jsx', start: 0, end: 4, props }
}

function renderPanel(
  props: Record<string, unknown>,
  extra: { fileUrl?: (p: string) => string; uploadFile?: (f: File) => Promise<string> } = {},
) {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const utils = render(
    <OverlayContentPanel
      item={overlayItem(props)}
      onPreview={onPreview}
      onCommit={onCommit}
      {...extra}
    />,
  )
  return { ...utils, onPreview, onCommit }
}

describe('OverlayContentPanel — fields inferred from item.props', () => {
  it('renders one control per primitive prop, in the kind its value implies', () => {
    renderPanel({
      homeName: 'Colombia',        // text
      homeScore: 2,                // number
      accent: '#FCD116',           // color (hex)
      badge: 'assets/crest.png',   // image (path)
      showClock: true,             // boolean
    })

    expect((screen.getByLabelText('homeName') as HTMLTextAreaElement).tagName).toBe('TEXTAREA')
    expect((screen.getByLabelText('homeScore') as HTMLInputElement).type).toBe('number')
    expect((screen.getByLabelText('accent') as HTMLInputElement).type).toBe('color')
    expect((screen.getByLabelText('showClock') as HTMLInputElement).type).toBe('checkbox')
    // The image field with no `uploadFile` degrades to an editable path box.
    expect((screen.getByLabelText('badge') as HTMLInputElement).type).toBe('text')
  })

  it('skips non-primitive props but carries them through every write untouched', () => {
    const { onPreview } = renderPanel({
      homeName: 'Colombia',
      players: [{ n: 1 }],
      meta: { round: 'final' },
    })

    // Not shown: `inferOverlayPropFields` only surfaces primitives.
    expect(screen.queryByLabelText('players')).toBeNull()
    expect(screen.queryByLabelText('meta')).toBeNull()

    fireEvent.change(screen.getByLabelText('homeName'), { target: { value: 'Argentina' } })
    // The whole props record is spread on the way out, so the skipped values
    // ride through rather than being dropped by the edit.
    expect(onPreview).toHaveBeenLastCalledWith({
      homeName: 'Argentina',
      players: [{ n: 1 }],
      meta: { round: 'final' },
    })
  })

  it('shows the empty state for an overlay whose props yield no editable fields', () => {
    renderPanel({ players: [{ n: 1 }], meta: null })
    expect(screen.getByText('This overlay has no editable content.')).toBeTruthy()
  })

  it('shows the empty state for no selection at all', () => {
    render(<OverlayContentPanel item={null} onPreview={vi.fn()} onCommit={vi.fn()} />)
    expect(screen.getByText('Select an overlay to edit its content.')).toBeTruthy()
  })
})

// ── The commit model: preview per change, commit on blur ────────────────────
// The dialog this panel replaces had a Save button; a panel has no such moment,
// so a typing gesture is closed by the field's blur and that is what becomes
// one undo step. These pin BOTH halves: that an in-progress edit previews
// without committing, and that the blur commits exactly once.
describe('OverlayContentPanel — preview then commit on blur', () => {
  it('a text edit previews per keystroke and commits once on blur', () => {
    const { onPreview, onCommit } = renderPanel({ homeName: 'Colombia' })
    const field = screen.getByLabelText('homeName')

    fireEvent.change(field, { target: { value: 'Arg' } })
    fireEvent.change(field, { target: { value: 'Argentina' } })
    expect(onPreview).toHaveBeenCalledTimes(2)
    expect(onPreview).toHaveBeenLastCalledWith({ homeName: 'Argentina' })
    // Still uncommitted — this is the whole point of the transient path.
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(field)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a number edit previews as a NUMBER and commits on blur', () => {
    const { onPreview, onCommit } = renderPanel({ homeScore: 2 })
    const field = screen.getByLabelText('homeScore')

    fireEvent.change(field, { target: { value: '3' } })
    expect(onPreview).toHaveBeenLastCalledWith({ homeScore: 3 })
    fireEvent.blur(field)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a half-typed number is not previewed over the value being replaced', () => {
    const { onPreview } = renderPanel({ homeScore: 2 })
    const field = screen.getByLabelText('homeScore')

    // Clearing the box is mid-typing, not "set it to zero" — the dialog this
    // replaces coerced '' to 0 and snapped the field back.
    fireEvent.change(field, { target: { value: '' } })
    expect(onPreview).not.toHaveBeenCalled()
    expect((field as HTMLInputElement).value).toBe('')

    fireEvent.change(field, { target: { value: '12' } })
    expect(onPreview).toHaveBeenLastCalledWith({ homeScore: 12 })
  })

  it('a blur on an untouched field does not spend a commit', () => {
    const { onPreview, onCommit } = renderPanel({ homeName: 'Colombia' })
    fireEvent.blur(screen.getByLabelText('homeName'))
    expect(onPreview).not.toHaveBeenCalled()
    // `onCommit` reaches sync.commit(), which enqueues a save whether or not a
    // gesture happened — so an untouched blur has to be filtered out here.
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a color pick previews live and commits when the picker closes', () => {
    const { onPreview, onCommit } = renderPanel({ accent: '#FCD116' })
    const swatch = screen.getByLabelText('accent')

    fireEvent.change(swatch, { target: { value: '#003893' } })
    expect(onPreview).toHaveBeenLastCalledWith({ accent: '#003893' })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(swatch)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a boolean toggle previews and commits back to back — there is no blur to wait for', () => {
    const { onPreview, onCommit } = renderPanel({ showClock: false })
    fireEvent.click(screen.getByLabelText('showClock'))
    expect(onPreview).toHaveBeenLastCalledWith({ showClock: true })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('OverlayContentPanel — image fields', () => {
  it('resolves the thumbnail through fileUrl and swaps the prop to the uploaded path', async () => {
    const uploadFile = vi.fn(async () => 'assets/uploaded.png')
    const { onPreview, onCommit, container } = renderPanel(
      { badge: 'assets/crest.png' },
      { fileUrl: (p: string) => `/served/${p}`, uploadFile },
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/served/assets/crest.png')

    const picker = screen.getByLabelText('badge') as HTMLInputElement
    expect(picker.type).toBe('file')
    fireEvent.change(picker, { target: { files: [new File(['x'], 'crest2.png', { type: 'image/png' })] } })

    // A finished upload is discrete: preview + commit, no blur in between.
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith({ badge: 'assets/uploaded.png' }))
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('accepts a data: URL as an image prop', () => {
    const tiny = 'data:image/png;base64,iVBORw0KGgo='
    const { container } = renderPanel({ badge: tiny })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(tiny)
  })

  it('degrades to an editable path field when the host cannot upload', () => {
    const { onPreview, onCommit } = renderPanel({ badge: 'assets/crest.png' })
    const field = screen.getByLabelText('badge')

    fireEvent.change(field, { target: { value: 'assets/other.png' } })
    expect(onPreview).toHaveBeenLastCalledWith({ badge: 'assets/other.png' })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(field)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('OverlayContentPanel — derived from the item, not stored', () => {
  it('re-derives its fields when the selection changes to a different overlay', () => {
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const { rerender } = render(
      <OverlayContentPanel item={overlayItem({ homeName: 'Colombia' })} onPreview={onPreview} onCommit={onCommit} />,
    )
    expect(screen.getByLabelText('homeName')).toBeTruthy()

    // A panel stays mounted while the operator clicks from overlay to overlay,
    // so fields seeded once in a useState initializer (as the retired dialog
    // did) would keep showing the PREVIOUS overlay's props.
    rerender(
      <OverlayContentPanel
        item={{ ...overlayItem({ caption: 'Full time' }), id: 'overlay-2' }}
        onPreview={onPreview}
        onCommit={onCommit}
      />,
    )
    expect(screen.queryByLabelText('homeName')).toBeNull()
    expect(screen.getByLabelText('caption')).toBeTruthy()
  })

  it('draws no section header of its own — the tab strip above it already says "Content"', () => {
    renderPanel({ homeName: 'Colombia' })
    // A "CONTENT" header under a "Content" tab is the same word twice, and it
    // made `getByText('Content')` ambiguous at the VideoEditor seam.
    expect(screen.queryByText('Content')).toBeNull()
    expect(screen.queryByRole('button', { expanded: true })).toBeNull()
  })
})
