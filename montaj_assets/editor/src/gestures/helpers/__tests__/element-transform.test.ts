/// <reference types="vitest/globals" />
import { buildElementTransform } from '../element-transform'

describe('buildElementTransform', () => {
  it('returns only translate when rotation is zero', () => {
    expect(buildElementTransform(10, 20, 2, 0)).toBe('translate(20px, 40px)')
  })

  it('omits rotation when rotation is undefined', () => {
    expect(buildElementTransform(0, 0, 1, undefined)).toBe('translate(0px, 0px)')
  })

  it('omits rotation when rotation is null', () => {
    expect(buildElementTransform(0, 0, 1, null as unknown as undefined))
      .toBe('translate(0px, 0px)')
  })

  it('composes translate + rotate when rotation is non-zero', () => {
    expect(buildElementTransform(5, 5, 2, 45))
      .toBe('translate(10px, 10px) rotate(45deg)')
  })

  it('handles negative coordinates', () => {
    expect(buildElementTransform(-3, -4, 1, 0)).toBe('translate(-3px, -4px)')
  })

  it('handles fractional scale (passes through to sub-pixel CSS)', () => {
    expect(buildElementTransform(10, 10, 0.5, 0)).toBe('translate(5px, 5px)')
  })
})
