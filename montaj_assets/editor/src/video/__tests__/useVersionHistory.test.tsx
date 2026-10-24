import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useVersionHistory } from '../VideoEditor'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })

function setup() {
  let onFrame: () => void = () => {}
  const unsub = vi.fn()
  const adapter = {
    listVersionHistory: vi.fn(async () => [{ hash: 'a', message: 'version: before cut', timestamp: '2026-01-01T00:00:00Z' }]),
    subscribe: vi.fn((_id: string, cb: () => void) => { onFrame = cb; return unsub }),
  }
  const project = { id: 'p1', status: 'draft' }
  const hook = renderHook(() => useVersionHistory(adapter as never, project as never))
  return { adapter, hook, frame: () => onFrame(), unsub }
}

describe('useVersionHistory refetch', () => {
  it('fetches on mount, then once ~500 ms after the last of a burst of frames', async () => {
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

  it('stops on unmount', async () => {
    const { adapter, hook, frame, unsub } = setup()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    frame()
    hook.unmount()
    expect(unsub).toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1)
  })
})
