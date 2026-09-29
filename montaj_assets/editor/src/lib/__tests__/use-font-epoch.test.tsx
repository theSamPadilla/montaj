import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { useFontEpoch } from '../use-font-epoch'

const orig = Object.getOwnPropertyDescriptor(document, 'fonts')
function setFonts(v: unknown) {
  Object.defineProperty(document, 'fonts', { value: v, configurable: true })
}
afterEach(() => {
  if (orig) Object.defineProperty(document, 'fonts', orig)
  else delete (document as unknown as Record<string, unknown>).fonts
})

describe('useFontEpoch', () => {
  it('increments on each loadingdone and stops after unmount', () => {
    const fonts = new EventTarget()
    setFonts(fonts)
    const { result, unmount } = renderHook(() => useFontEpoch())
    expect(result.current).toBe(0)
    act(() => { fonts.dispatchEvent(new Event('loadingdone')) })
    expect(result.current).toBe(1)
    act(() => { fonts.dispatchEvent(new Event('loadingdone')) })
    expect(result.current).toBe(2)
    unmount()
    act(() => { fonts.dispatchEvent(new Event('loadingdone')) })
    expect(result.current).toBe(2)
  })

  it('returns 0 without document.fonts', () => {
    setFonts(undefined)
    const { result } = renderHook(() => useFontEpoch())
    expect(result.current).toBe(0)
  })
})
