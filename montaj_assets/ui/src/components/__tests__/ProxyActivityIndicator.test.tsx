import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'

const { proxyStatus } = vi.hoisted(() => ({
  proxyStatus: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { proxyStatus },
}))

import ProxyActivityIndicator from '../ProxyActivityIndicator'

// Flushes the microtask the mocked `api.proxyStatus()` promise resolves on,
// without advancing the virtual clock.
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  proxyStatus.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ProxyActivityIndicator', () => {
  it('renders nothing when running and queued are both zero', async () => {
    proxyStatus.mockResolvedValue({ running: 0, queued: 0 })
    const { container } = render(<ProxyActivityIndicator />)
    await flush()
    expect(container).toBeEmptyDOMElement()
  })

  it('counts the running clip too, since it is not ready either', async () => {
    // 1 encoding + 3 waiting = 4 clips you cannot scrub yet. Counting only the
    // queue would say "3 left" while four are unready.
    proxyStatus.mockResolvedValue({ running: 1, queued: 3 })
    render(<ProxyActivityIndicator />)
    await flush()
    expect(screen.getByText('Getting your footage ready to edit')).toBeInTheDocument()
    expect(screen.getByText('4 clips left')).toBeInTheDocument()
  })

  it('singularizes the count for exactly one clip queued', async () => {
    proxyStatus.mockResolvedValue({ running: 0, queued: 1 })
    render(<ProxyActivityIndicator />)
    await flush()
    expect(screen.getByText('1 clip left')).toBeInTheDocument()
  })

  it('still shows a count for the last clip, rather than dropping it', async () => {
    // The count keys on the same quantity the indicator's visibility does, so
    // it cannot disappear while the final clip is still encoding.
    proxyStatus.mockResolvedValue({ running: 1, queued: 0 })
    render(<ProxyActivityIndicator />)
    await flush()
    expect(screen.getByText('Getting your footage ready to edit')).toBeInTheDocument()
    expect(screen.getByText('1 clip left')).toBeInTheDocument()
  })

  it('carries the one-line explanation as a title attribute', async () => {
    proxyStatus.mockResolvedValue({ running: 1, queued: 0 })
    render(<ProxyActivityIndicator />)
    await flush()
    expect(
      screen.getByTitle(
        'Montaj is making smooth-scrubbing copies of your footage. You can keep editing while this finishes.',
      ),
    ).toBeInTheDocument()
  })

  it('polls every 3s while active, then drops to every 10s once idle', async () => {
    proxyStatus.mockResolvedValueOnce({ running: 1, queued: 1 })
    render(<ProxyActivityIndicator />)
    await flush()
    expect(proxyStatus).toHaveBeenCalledTimes(1)

    proxyStatus.mockResolvedValueOnce({ running: 0, queued: 0 })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(proxyStatus).toHaveBeenCalledTimes(2) // fired at the active 3s cadence

    proxyStatus.mockResolvedValue({ running: 0, queued: 0 })
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
    expect(proxyStatus).toHaveBeenCalledTimes(2) // now idle: no poll before 10s

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(proxyStatus).toHaveBeenCalledTimes(3) // idle cadence: fires at 10s
  })

  it('pauses polling while the tab is hidden and resumes immediately on focus', async () => {
    proxyStatus.mockResolvedValue({ running: 1, queued: 0 })
    render(<ProxyActivityIndicator />)
    await flush()
    expect(proxyStatus).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(proxyStatus).toHaveBeenCalledTimes(1) // no polling while hidden

    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(proxyStatus).toHaveBeenCalledTimes(2) // resumes on visibility change
  })

  it('degrades to hidden on a failed poll instead of throwing, and keeps polling', async () => {
    proxyStatus.mockRejectedValueOnce(new Error('Not Found'))
    const { container } = render(<ProxyActivityIndicator />)
    await flush()
    expect(container).toBeEmptyDOMElement()

    proxyStatus.mockResolvedValueOnce({ running: 1, queued: 0 })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.getByText('Getting your footage ready to edit')).toBeInTheDocument()
  })

  it('does not fork a second poll chain when visibility toggles while a poll is in flight', async () => {
    // Deliberately unresolved: simulates the mount poll still awaiting
    // api.proxyStatus() when the visibilitychange handler fires.
    let resolveMountPoll: (value: { running: number; queued: number }) => void
    const mountPoll = new Promise<{ running: number; queued: number }>((resolve) => {
      resolveMountPoll = resolve
    })
    proxyStatus.mockReturnValueOnce(mountPoll)
    proxyStatus.mockResolvedValue({ running: 1, queued: 0 })

    render(<ProxyActivityIndicator />)
    expect(proxyStatus).toHaveBeenCalledTimes(1) // mount poll started, still in flight

    // Visible while already visible (e.g. a duplicate/rapid event) — this is
    // exactly the case that must not start an uncancellable second chain,
    // since clearTimer() cannot cancel a poll that hasn't scheduled a timer yet.
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(proxyStatus).toHaveBeenCalledTimes(2) // the visibility handler's own poll

    resolveMountPoll!({ running: 1, queued: 0 })
    await flush()

    // One active-cadence tick (3s). A correctly-cancelled mount chain ticks
    // once here (from the surviving chain); a forked, orphaned mount chain
    // ticks too, doubling the count.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(proxyStatus).toHaveBeenCalledTimes(3) // not 4 — only one chain survives
  })
})
