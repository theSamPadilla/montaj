import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, renderHook, act, waitFor } from '@testing-library/react'
import { useIsDark } from '../useIsDark'

// ── useIsDark ───────────────────────────────────────────────────────────
// App.tsx toggles the `dark` class on <html>; this hook mirrors that flag
// into React state via a MutationObserver so consumers (EditorPage's theme
// choice) re-render on toggle. MutationObserver callbacks fire as async
// microtasks, so post-mount assertions use waitFor rather than a sync read.

afterEach(() => {
  // Unmount (disconnecting each test's observer) before touching the class,
  // so a leftover mounted hook never sees a class mutation outside of act().
  cleanup()
  document.documentElement.classList.remove('dark')
})

describe('useIsDark', () => {
  it('reads false on mount when <html> has no dark class', () => {
    const { result } = renderHook(() => useIsDark())
    expect(result.current).toBe(false)
  })

  it('reads true on mount when <html> already has the dark class', () => {
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useIsDark())
    expect(result.current).toBe(true)
  })

  it('flips to true when the dark class is added after mount', async () => {
    const { result } = renderHook(() => useIsDark())
    expect(result.current).toBe(false)

    act(() => {
      document.documentElement.classList.add('dark')
    })

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('flips back to false when the dark class is removed after mount', async () => {
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useIsDark())
    expect(result.current).toBe(true)

    act(() => {
      document.documentElement.classList.remove('dark')
    })

    await waitFor(() => expect(result.current).toBe(false))
  })
})
