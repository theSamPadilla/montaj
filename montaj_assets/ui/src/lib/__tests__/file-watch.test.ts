import { describe, it, expect, beforeEach, vi } from 'vitest'
import { watchWorkspaceFile, _resetFileWatchForTests } from '../file-watch'

// Minimal EventSource fake: records instances, lets tests fire messages.
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close() { this.closed = true }
  emit(path: string) { this.onmessage?.({ data: JSON.stringify({ path }) }) }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  _resetFileWatchForTests()
})

describe('watchWorkspaceFile', () => {
  it('opens ONE EventSource to the global stream for many watchers', () => {
    watchWorkspaceFile('/ws/a.jsx', () => {})
    watchWorkspaceFile('/ws/a.jsx', () => {})
    watchWorkspaceFile('/ws/b.jsx', () => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/files/stream')
  })

  it('dispatches only to callbacks registered for the changed path', () => {
    const a = vi.fn(); const a2 = vi.fn(); const b = vi.fn()
    watchWorkspaceFile('/ws/a.jsx', a)
    watchWorkspaceFile('/ws/a.jsx', a2)
    watchWorkspaceFile('/ws/b.jsx', b)
    FakeEventSource.instances[0].emit('/ws/a.jsx')
    expect(a).toHaveBeenCalledTimes(1)
    expect(a2).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('unsubscribe removes only that callback; last unsubscribe closes the ES', () => {
    const a = vi.fn(); const b = vi.fn()
    const offA = watchWorkspaceFile('/ws/a.jsx', a)
    const offB = watchWorkspaceFile('/ws/b.jsx', b)
    offA()
    FakeEventSource.instances[0].emit('/ws/a.jsx')
    FakeEventSource.instances[0].emit('/ws/b.jsx')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances[0].closed).toBe(false)
    offB()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('double-calling the same unsubscribe is a no-op', () => {
    const off = watchWorkspaceFile('/ws/a.jsx', () => {})
    const off2 = watchWorkspaceFile('/ws/a.jsx', () => {})
    off()
    off()  // must not decrement someone else's registration
    expect(FakeEventSource.instances[0].closed).toBe(false)
    off2()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('watching again after full teardown opens a fresh EventSource', () => {
    const off = watchWorkspaceFile('/ws/a.jsx', () => {})
    off()
    expect(FakeEventSource.instances[0].closed).toBe(true)
    const cb = vi.fn()
    watchWorkspaceFile('/ws/a.jsx', cb)
    expect(FakeEventSource.instances).toHaveLength(2)
    FakeEventSource.instances[1].emit('/ws/a.jsx')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed frames without throwing', () => {
    const cb = vi.fn()
    watchWorkspaceFile('/ws/a.jsx', cb)
    const es = FakeEventSource.instances[0]
    expect(() => es.onmessage?.({ data: 'not json' })).not.toThrow()
    expect(cb).not.toHaveBeenCalled()
  })
})
