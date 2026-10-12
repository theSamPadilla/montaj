import { describe, it, expect } from 'vitest'
import type { Captions } from '../../schema'
import {
  applyCaptionStyle,
  captionGoogleFonts,
  captionStyleScope,
  captionStyleValue,
  type CaptionStylePatch,
} from '../captionSegmentStyle'

const captions = (): Captions => ({
  style: 'karaoke',
  fontsize: 50,
  color: '#ffffff',
  segments: [
    { id: 'a', text: 'zero', start: 0, end: 1, fontSize: 30, color: '#00ff00' },
    { id: 'b', text: 'one', start: 1, end: 2 },
    { id: 'c', text: 'two', start: 2, end: 3, fontFamily: 'Serif', googleFonts: ['Serif:wght@400'] },
  ],
})

describe('captionStyleScope', () => {
  it('on: every caption, whatever is selected', () => {
    expect(captionStyleScope(true, ['a'])).toEqual({ kind: 'all' })
    expect(captionStyleScope(true, [])).toEqual({ kind: 'all' })
  })
  it('off: the selected captions, or the track when none are', () => {
    expect(captionStyleScope(false, ['a', 'c'])).toEqual({ kind: 'segments', ids: ['a', 'c'] })
    expect(captionStyleScope(false, [])).toEqual({ kind: 'track' })
  })
})

describe('applyCaptionStyle', () => {
  it('segments: writes each selected caption its own value, under the segment key, and leaves the rest as they were', () => {
    const before = captions()
    const after = applyCaptionStyle(before, { fontsize: 72 }, { kind: 'segments', ids: ['b', 'c'] })
    expect(after.segments.map(s => s.fontSize)).toEqual([30, 72, 72])
    expect(after.fontsize).toBe(50)
    expect(after.segments[0]).toBe(before.segments[0])
    expect(after.segments[1]).not.toHaveProperty('fontsize')
  })

  it('all: writes the track and removes that field\'s override from every caption, and only that field', () => {
    const after = applyCaptionStyle(captions(), { fontsize: 72 }, { kind: 'all' })
    expect(after.fontsize).toBe(72)
    expect(after.segments.map(s => s.fontSize)).toEqual([undefined, undefined, undefined])
    expect(after.segments[0]).not.toHaveProperty('fontSize')
    // Another field's override stays.
    expect(after.segments[0].color).toBe('#00ff00')
  })

  it('all: a font goes on the track with its Google Fonts, and every caption\'s own font and fonts go', () => {
    const after = applyCaptionStyle(captions(), { fontFamily: 'Mono', googleFonts: ['Mono:wght@700'] }, { kind: 'all' })
    expect(after).toMatchObject({ fontFamily: 'Mono', googleFonts: ['Mono:wght@700'] })
    expect(after.segments[2]).not.toHaveProperty('fontFamily')
    expect(after.segments[2]).not.toHaveProperty('googleFonts')
  })

  it('track: writes the track only; captions with their own value keep it', () => {
    const before = captions()
    const after = applyCaptionStyle(before, { fontsize: 72 }, { kind: 'track' })
    expect(after.fontsize).toBe(72)
    expect(after.segments).toBe(before.segments)
  })

  it('an undefined value removes the key at that scope', () => {
    const seg = applyCaptionStyle(captions(), { color: undefined }, { kind: 'segments', ids: ['a'] })
    expect(seg.segments[0]).not.toHaveProperty('color')
    expect(seg.color).toBe('#ffffff')
    const all = applyCaptionStyle(captions(), { color: undefined }, { kind: 'all' })
    expect(all).not.toHaveProperty('color')
    expect(all.segments[0]).not.toHaveProperty('color')
  })

  it('never writes text, timing, words, lane or position, at any scope', () => {
    const patch = { fontsize: 72, text: 'x', start: 9, end: 10, words: [], lane: 3, offsetX: 50, style: 'pop' } as unknown as CaptionStylePatch
    for (const scope of [{ kind: 'all' }, { kind: 'track' }, { kind: 'segments', ids: ['a', 'b', 'c'] }] as const) {
      const after = applyCaptionStyle(captions(), patch, scope)
      expect(after.style).toBe('karaoke')
      expect(after.segments.map(s => [s.text, s.start, s.end, s.words, s.lane, s.offsetX]))
        .toEqual(captions().segments.map(s => [s.text, s.start, s.end, s.words, s.lane, s.offsetX]))
    }
  })

  it('a patch with no styling field returns the captions unchanged', () => {
    const before = captions()
    expect(applyCaptionStyle(before, {}, { kind: 'all' })).toBe(before)
  })
})

describe('captionStyleValue: the caption\'s own value, else the track\'s', () => {
  it('reads through the font size key difference', () => {
    const c = captions()
    expect(captionStyleValue(c, c.segments[0], 'fontsize')).toBe(30)
    expect(captionStyleValue(c, c.segments[1], 'fontsize')).toBe(50)
    expect(captionStyleValue(c, undefined, 'fontsize')).toBe(50)
    expect(captionStyleValue(c, c.segments[1], 'fontFamily')).toBeUndefined()
  })
})

describe('captionGoogleFonts: the track\'s, then each caption\'s, once each', () => {
  it('unions and deduplicates, accepting a bare string', () => {
    expect(captionGoogleFonts({ googleFonts: ['A'], segments: [{ text: '', start: 0, end: 1, googleFonts: ['B', 'A'] }] })).toEqual(['A', 'B'])
    expect(captionGoogleFonts({ googleFonts: 'A, C' as unknown as string[], segments: [] })).toEqual(['A', 'C'])
    expect(captionGoogleFonts({ segments: [] })).toEqual([])
  })

  it('keeps the commas inside a spec\'s axis list when a bare string is split', () => {
    const spec = 'Playfair+Display:ital,wght@1,700'
    expect(captionGoogleFonts({ googleFonts: spec as unknown as string[], segments: [{ text: '', start: 0, end: 1, googleFonts: ['B'] }] }))
      .toEqual([spec, 'B'])
    expect(captionGoogleFonts({ googleFonts: `A:wght@700, ${spec}` as unknown as string[], segments: [] }))
      .toEqual(['A:wght@700', spec])
    expect(captionGoogleFonts({ segments: [{ text: '', start: 0, end: 1, googleFonts: [spec] }] })).toEqual([spec])
  })
})
