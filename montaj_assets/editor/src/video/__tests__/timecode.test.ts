import { describe, it, expect } from 'vitest'
import { formatTimecode, parseTimecode } from '../timecode'

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

describe('formatTimecode', () => {
  it('formats zero', () => {
    expect(formatTimecode(0)).toBe('0:00.0')
  })

  it('formats sub-minute values with one decimal', () => {
    expect(formatTimecode(5.34)).toBe('0:05.3')
    expect(formatTimecode(59.96)).toBe('1:00.0') // rounds up and carries into minutes
  })

  it('formats minute-plus values without an hours component', () => {
    expect(formatTimecode(65)).toBe('1:05.0')
    expect(formatTimecode(599.9)).toBe('9:59.9')
  })

  it('formats hour-plus values with an hh:mm:ss.f shape', () => {
    expect(formatTimecode(3600)).toBe('1:00:00.0')
    expect(formatTimecode(3725.6)).toBe('1:02:05.6')
  })

  it('never emits a frames-style trailing group (parseTimecode has no concept of frames)', () => {
    expect(formatTimecode(3725.6).split(':')).toHaveLength(3) // h:mm:ss.f, not h:mm:ss:ff
  })

  it('clamps negatives and non-finite input to 0', () => {
    expect(formatTimecode(-5)).toBe('0:00.0')
    expect(formatTimecode(NaN)).toBe('0:00.0')
  })

  it('round-trips through parseTimecode', () => {
    const values = [0, 0.1, 5.3, 42.7, 65.0, 599.9, 3600, 3661.2, 7325.8]
    for (const t of values) {
      expect(parseTimecode(formatTimecode(t))).toBeCloseTo(t, 1)
    }
  })
})
