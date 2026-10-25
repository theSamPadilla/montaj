import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useVersionHistory } from '../VideoEditor'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })

function setup() {
  const adapter = {
    listVersionHistory: vi.fn(async () => [{ hash: 'a', message: 'version: before cut', timestamp: '2026-01-01T00:00:00Z' }]),
    subscribe: vi.fn(() => vi.fn()),
  }
  const project = { id: 'p1', status: 'draft' }
  const hook = renderHook(() => useVersionHistory(adapter as never, project as never))
  return { adapter, hook, frame: () => hook.result.current.noteFrame() }
}

describe('useVersionHistory refetch', () => {
  it('never subscribes to the adapter itself', async () => {
    const { adapter } = setup()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(adapter.subscribe).not.toHaveBeenCalled()
  })

  it('fetches on mount, then once ~500 ms after the last of a burst of noteFrame calls', async () => {
    const { adapter, frame } = setup()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1)

    frame(); await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    frame(); await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    frame(); await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2) })
    expect(adapter.listVersionHistory).toHaveBeenCalledTimes(2)
  })

  it('does not fetch after unmount', async () => {
    const { adapter, hook, frame } = setup()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    frame()
    hook.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1)
  })

  it('refreshOnOpen skips right after the mount fetch, but refetches once that is stale', async () => {
    const { adapter, hook } = setup()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await hook.result.current.refreshOnOpen() })
    expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    await act(async () => { await hook.result.current.refreshOnOpen() })
    expect(adapter.listVersionHistory).toHaveBeenCalledTimes(2)
  })
})
