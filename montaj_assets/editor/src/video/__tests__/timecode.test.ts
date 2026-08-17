import { describe, it, expect } from 'vitest'
import { parseTimecode } from '../timecode'

describe('parseTimecode', () => {
  it('parses bare seconds', () => {
    expect(parseTimecode('90')).toBe(90)
    expect(parseTimecode('12.5')).toBe(12.5)
    expect(parseTimecode('0')).toBe(0)
  })

  it('parses mm:ss', () => {
    expect(parseTimecode('1:30')).toBe(90)
    expect(parseTimecode('12:03.5')).toBe(12 * 60 + 3.5)
  })

  it('parses hh:mm:ss', () => {
    expect(parseTimecode('01:02:03')).toBe(1 * 3600 + 2 * 60 + 3)
    expect(parseTimecode('1:02:03.25')).toBe(3600 + 120 + 3.25)
  })

  it('trims surrounding whitespace', () => {
    expect(parseTimecode('  1:30  ')).toBe(90)
  })

  it('rejects out-of-range minutes/seconds', () => {
    expect(parseTimecode('1:60')).toBeNull()
    expect(parseTimecode('1:60:00')).toBeNull()
    expect(parseTimecode('60:00:00')).not.toBeNull() // hours component is unbounded
  })

  it('rejects garbage', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('   ')).toBeNull()
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('1:2:3:4')).toBeNull()
    expect(parseTimecode('1.5:30')).toBeNull()
    expect(parseTimecode('-5')).toBeNull()
    expect(parseTimecode('1:')).toBeNull()
  })
})
