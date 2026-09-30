import { describe, it, expect } from 'vitest'
import { isApplePlatform, modifierKey, modifierKeys, shortcutText } from '../modifierKeys'

describe('isApplePlatform', () => {
  it('is true for a Mac platform', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true)
  })
  it('is false for Windows and Linux', () => {
    expect(isApplePlatform({ platform: 'Win32' })).toBe(false)
    expect(isApplePlatform({ platform: 'Linux x86_64' })).toBe(false)
  })
  it('prefers userAgentData.platform over platform', () => {
    expect(isApplePlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false)
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' }, platform: '' })).toBe(true)
  })
  it('uses userAgentData.platform when platform is missing', () => {
    expect(isApplePlatform({ userAgentData: { platform: 'Windows' } })).toBe(false)
  })
  it('falls back to the user agent', () => {
    expect(isApplePlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true)
    expect(isApplePlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false)
  })
  it('treats an empty or absent navigator as not Apple', () => {
    expect(isApplePlatform({})).toBe(false)
    expect(isApplePlatform(undefined as never)).toBe(false)
  })
})

describe('modifierKeys', () => {
  it('keeps the glyphs on Apple', () => {
    expect(modifierKeys(['⌘', '⇧', '⌥', 'Z'], true)).toEqual(['⌘', '⇧', '⌥', 'Z'])
  })
  it('spells them out elsewhere', () => {
    expect(modifierKeys(['⌘', '⇧', '⌥', 'Z'], false)).toEqual(['Ctrl', 'Shift', 'Alt', 'Z'])
  })
  it('leaves other keys alone', () => {
    for (const k of ['Z', 'Delete', '←']) {
      expect(modifierKey(k, false)).toBe(k)
      expect(modifierKey(k, true)).toBe(k)
    }
  })
})

describe('shortcutText', () => {
  it('joins with nothing on Apple', () => {
    expect(shortcutText(['⌘', '⇧', 'Z'], true)).toBe('⌘⇧Z')
  })
  it('joins with + elsewhere', () => {
    expect(shortcutText(['⌘', '⇧', 'Z'], false)).toBe('Ctrl+Shift+Z')
  })
})
