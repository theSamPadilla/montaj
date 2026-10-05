import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, cleanup } from '@testing-library/react'
import VersionCompare from '../VersionCompare'

type FetchCall = { url: string; signal: AbortSignal; resolve: (r: unknown) => void; reject: (e: unknown) => void }
let calls: FetchCall[] = []
let blobN = 0
const created: string[] = []
const revoked: string[] = []

/** A fetch that stays pending until the test settles it, so loading and
 *  abort states are observable. */
function installFetch() {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const signal = init!.signal!
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      calls.push({ url, signal, resolve, reject })
    })))
}

function okFrame(end?: number) {
  return {
    ok: true,
    headers: { get: (k: string) => (k === 'X-Montaj-Frame-End' && end != null ? String(end) : null) },
    blob: async () => new Blob(['png']),
  }
}

function failFrame(body: unknown) {
  return {
    ok: false,
    headers: { get: () => null },
    json: async () => { if (body === undefined) throw new Error('not json'); return body },
  }
}

/** Settle call `i` and let React flush the result. */
async function settle(i: number, res: unknown) {
  await act(async () => { calls[i].resolve(res) })
}

beforeEach(() => {
  installFetch()
  created.length = 0
  revoked.length = 0
  URL.createObjectURL = vi.fn(() => { const u = `blob:frame-${++blobN}`; created.push(u); return u })
  URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u) })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
  it('renders two frame panes for two versions', async () => {
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

    await settle(0, okFrame())
    await settle(1, okFrame())
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('shows the loader while a frame renders, then the frame', async () => {
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
    expect(screen.getAllByRole('status', { name: 'Rendering frame' })).toHaveLength(2)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()

    await settle(0, okFrame())
    expect(screen.getAllByRole('status', { name: 'Rendering frame' })).toHaveLength(1)
    expect(screen.getByRole('img')).toHaveAttribute('src', created[0])
  })

  it('sets both frame requests from frameUrl with the correct commit ids', async () => {
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
    expect(calls.map(c => c.url)).toEqual(['mock:abc:5', 'mock:working:5'])
    await settle(0, okFrame())
    await settle(1, okFrame())
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('re-points both frame requests to the new time after the scrub debounce elapses', async () => {
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

    // Pre-debounce: no new request yet.
    expect(calls).toHaveLength(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(200) })

    expect(calls.slice(2).map(c => c.url)).toEqual(['mock:abc:7', 'mock:working:7'])
  })

  it("changing the LEFT picker updates only the left pane's request", () => {
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

    expect(calls.map(c => c.url)).toEqual(['mock:abc:5', 'mock:working:5', 'mock:def:5'])
  })

  it("changing the RIGHT picker updates only the right pane's request", () => {
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

    expect(calls.map(c => c.url)).toEqual(['mock:abc:5', 'mock:working:5', 'mock:def:5'])
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
    expect(calls[calls.length - 1].url).toBe('mock:working:5')
  })

  describe('frame pane', () => {
    function mount(mode?: 'light' | 'dark') {
      return render(
        <VersionCompare
          projectId="proj-1"
          versions={VERSIONS}
          initialLeftHash="abc"
          frameUrl={mockFrameUrl}
          durationSeconds={10}
          onClose={vi.fn()}
          mode={mode}
        />,
      )
    }

    it('captions "Ends at" when the server sends the end header', async () => {
      mount()
      await settle(0, okFrame(52.2798))
      await settle(1, okFrame())
      expect(screen.getByText('Ends at 52.3s')).toBeInTheDocument()
      expect(screen.getAllByText(/Ends at/)).toHaveLength(1)
    })

    it("shows the server's message on a 500", async () => {
      mount()
      await settle(0, failFrame({ detail: { error: 'render_failed', message: 'Clip source missing' } }))
      expect(screen.getByText('Clip source missing')).toBeInTheDocument()
    })

    it('falls back to a fixed message when the body is not JSON', async () => {
      mount()
      await settle(0, failFrame(undefined))
      expect(screen.getByText("Couldn't render this frame")).toBeInTheDocument()
    })

    it('keeps the light/dark error colour', async () => {
      mount('light')
      await settle(0, failFrame(undefined))
      expect(screen.getByText("Couldn't render this frame")).toHaveClass('text-red-600')
    })

    it('aborts the in-flight request when the src changes', async () => {
      mount()
      expect(calls[0].signal.aborted).toBe(false)
      fireEvent.change(screen.getByLabelText('Left') as HTMLSelectElement, { target: { value: 'def' } })
      expect(calls[0].signal.aborted).toBe(true)
      expect(calls[1].signal.aborted).toBe(false)
      // A late answer for the aborted request never shows.
      await act(async () => { calls[0].resolve(okFrame()) })
      expect(created).toHaveLength(0)
    })

    it('keeps the previous frame, dimmed, while the next one loads', async () => {
      mount()
      await settle(0, okFrame())
      fireEvent.change(screen.getByLabelText('Left') as HTMLSelectElement, { target: { value: 'def' } })
      const img = screen.getByRole('img')
      expect(img).toHaveAttribute('src', created[0])
      expect(img).toHaveClass('opacity-40')
      expect(screen.getAllByRole('status', { name: 'Rendering frame' })).toHaveLength(2)
    })

    it('revokes the previous object URL on change and the last on unmount', async () => {
      const { unmount } = mount()
      await settle(0, okFrame())
      fireEvent.change(screen.getByLabelText('Left') as HTMLSelectElement, { target: { value: 'def' } })
      await settle(2, okFrame())
      expect(revoked).toEqual([created[0]])
      unmount()
      expect(revoked).toEqual([created[0], created[1]])
    })
  })
})
