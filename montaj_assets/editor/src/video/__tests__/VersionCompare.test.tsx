import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within, act, cleanup } from '@testing-library/react'
import VersionCompare from '../VersionCompare'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const VERSIONS = [
  { hash: 'abc', message: 'v1', timestamp: '2026-01-01T00:00:00Z' },
  { hash: 'def', message: 'v2', timestamp: '2026-01-02T00:00:00Z' },
]

/** Distinctive, deterministic stand-in for the real frame-render URL builder —
 *  encodes exactly the two inputs under test (commit, t) into the string. */
function mockFrameUrl(_id: string, commit: string, t: number): string {
  return `mock:${commit}:${t}`
}

describe('VersionCompare', () => {
  it('renders two frame panes for two versions', () => {
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('sets both <img> srcs from frameUrl with the correct commit ids', () => {
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={vi.fn()}
      />,
    )

    // initialLeftHash="abc" seeds LEFT; RIGHT defaults to the "working"
    // sentinel since LEFT isn't already "working". Initial t = duration/2 = 5,
    // and sampleT starts equal to t (no debounce needed pre-interaction).
    const imgs = screen.getAllByRole('img')
    expect(imgs[0]).toHaveAttribute('src', 'mock:abc:5')
    expect(imgs[1]).toHaveAttribute('src', 'mock:working:5')
  })

  it('re-points both <img> srcs to the new time after the scrub debounce elapses', async () => {
    vi.useFakeTimers()
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={vi.fn()}
      />,
    )

    const slider = screen.getByLabelText('Scrub time')
    fireEvent.change(slider, { target: { value: '7' } })

    // Pre-debounce: the img srcs must not have moved yet.
    let imgs = screen.getAllByRole('img')
    expect(imgs[0]).toHaveAttribute('src', 'mock:abc:5')

    await act(async () => { await vi.advanceTimersByTimeAsync(200) })

    imgs = screen.getAllByRole('img')
    expect(imgs[0]).toHaveAttribute('src', 'mock:abc:7')
    expect(imgs[1]).toHaveAttribute('src', 'mock:working:7')
  })

  it("changing the LEFT picker updates only the left pane's src", () => {
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={vi.fn()}
      />,
    )

    const leftSelect = screen.getByLabelText('Left') as HTMLSelectElement
    fireEvent.change(leftSelect, { target: { value: 'def' } })

    const imgs = screen.getAllByRole('img')
    expect(imgs[0]).toHaveAttribute('src', 'mock:def:5')
    expect(imgs[1]).toHaveAttribute('src', 'mock:working:5')
  })

  it("changing the RIGHT picker updates only the right pane's src", () => {
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={vi.fn()}
      />,
    )

    const rightSelect = screen.getByLabelText('Right') as HTMLSelectElement
    fireEvent.change(rightSelect, { target: { value: 'def' } })

    const imgs = screen.getAllByRole('img')
    expect(imgs[0]).toHaveAttribute('src', 'mock:abc:5')
    expect(imgs[1]).toHaveAttribute('src', 'mock:def:5')
  })

  it('Escape key closes', () => {
    const onClose = vi.fn()
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={onClose}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the close button calls onClose', () => {
    const onClose = vi.fn()
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers the "working" option in both pickers and points a pane at commit "working" when chosen', () => {
    render(
      <VersionCompare
        projectId="proj-1"
        versions={VERSIONS}
        initialLeftHash="abc"
        frameUrl={mockFrameUrl}
        durationSeconds={10}
        onClose={vi.fn()}
      />,
    )

    const leftSelect = screen.getByLabelText('Left') as HTMLSelectElement
    const rightSelect = screen.getByLabelText('Right') as HTMLSelectElement
    expect(within(leftSelect).getByText('Current (working)')).toBeInTheDocument()
    expect(within(rightSelect).getByText('Current (working)')).toBeInTheDocument()

    // RIGHT already defaults to "working" (LEFT isn't "working" initially);
    // explicitly select it on LEFT too, proving the sentinel behaves
    // identically wired into either picker.
    fireEvent.change(leftSelect, { target: { value: 'working' } })
    const imgs = screen.getAllByRole('img')
    expect(imgs[0]).toHaveAttribute('src', 'mock:working:5')
  })
})
