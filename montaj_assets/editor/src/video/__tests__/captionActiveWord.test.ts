import { describe, it, expect } from 'vitest'
import { activeCaptionWord } from '../captionActiveWord'
import type { CaptionSegment, Captions, Word } from '../../schema'

function w(word: string, start: number, end: number): Word {
  return { word, start, end }
}

function seg(over: Partial<CaptionSegment> = {}): CaptionSegment {
  return { text: 'x', start: 0, end: 1, ...over }
}

function captions(segments: CaptionSegment[]): Captions {
  return { style: 'word-by-word', segments }
}

describe('activeCaptionWord', () => {
  it('returns the word the playhead is inside', () => {
    const track = captions([
      seg({ id: 'a', start: 0, end: 2, text: 'hello world', words: [w('hello', 0, 1), w('world', 1, 2)] }),
    ])
    expect(activeCaptionWord(track, 0.5)).toEqual({ word: 'hello', segmentId: 'a' })
    expect(activeCaptionWord(track, 1.5)).toEqual({ word: 'world', segmentId: 'a' })
  })

  it('falls back to the segment\'s first word when the playhead is in a gap between words', () => {
    const track = captions([
      seg({ id: 'a', start: 0, end: 2, text: 'hello world', words: [w('hello', 0, 0.4), w('world', 0.6, 1)] }),
    ])
    // 0.5 is between the two words' spans (0.4-0.6 gap), but still inside the segment.
    expect(activeCaptionWord(track, 0.5)).toEqual({ word: 'hello', segmentId: 'a' })
  })

  it('is inclusive at a word\'s start (half-open interval)', () => {
    const track = captions([
      seg({ id: 'a', start: 0, end: 2, text: 'hello world', words: [w('hello', 0, 1), w('world', 1, 2)] }),
    ])
    expect(activeCaptionWord(track, 1)).toEqual({ word: 'world', segmentId: 'a' })
  })

  it('is exclusive at a word\'s end: falls to the next word if one starts there, else the gap fallback', () => {
    const track = captions([
      seg({ id: 'a', start: 0, end: 2, text: 'hello world', words: [w('hello', 0, 1), w('world', 1, 2)] }),
    ])
    // t=1 lands on "hello".end / "world".start: "hello" is excluded, "world" matches.
    expect(activeCaptionWord(track, 1)).toEqual({ word: 'world', segmentId: 'a' })

    const trackWithGap = captions([
      seg({ id: 'a', start: 0, end: 2, text: 'hello world', words: [w('hello', 0, 0.5), w('world', 0.6, 2)] }),
    ])
    // t=0.5 lands on "hello".end but "world" doesn't start until 0.6: gap fallback.
    expect(activeCaptionWord(trackWithGap, 0.5)).toEqual({ word: 'hello', segmentId: 'a' })
  })

  it('is exclusive at seg.end: the next segment is active there instead', () => {
    const track = captions([
      seg({ id: 'a', start: 0, end: 1, text: 'hello', words: [w('hello', 0, 1)] }),
      seg({ id: 'b', start: 1, end: 2, text: 'world', words: [w('world', 1, 2)] }),
    ])
    expect(activeCaptionWord(track, 1)).toEqual({ word: 'world', segmentId: 'b' })
  })

  it('uses the first whitespace-separated token of seg.text when there is no words array', () => {
    const track = captions([seg({ id: 'a', start: 0, end: 1, text: 'hello world' })])
    expect(activeCaptionWord(track, 0.5)).toEqual({ word: 'hello', segmentId: 'a' })
  })

  it('falls through without an empty word when text is empty/whitespace and there are no words', () => {
    expect(activeCaptionWord(captions([seg({ id: 'a', start: 0, end: 1, text: '' })]), 0.5)).toBeNull()
    expect(activeCaptionWord(captions([seg({ id: 'a', start: 0, end: 1, text: '   ' })]), 0.5)).toBeNull()
  })

  it('falls back to the selected segment\'s first word when the playhead is between segments', () => {
    const track = captions([
      seg({ id: 'a', start: 0, end: 1, text: 'hello world' }),
      seg({ id: 'b', start: 2, end: 3, text: 'goodbye moon' }),
    ])
    expect(activeCaptionWord(track, 1.5, 'b')).toEqual({ word: 'goodbye', segmentId: 'b' })
  })

  it('returns null when the playhead is between segments with no selection', () => {
    const track = captions([
      seg({ id: 'a', start: 0, end: 1, text: 'hello world' }),
      seg({ id: 'b', start: 2, end: 3, text: 'goodbye moon' }),
    ])
    expect(activeCaptionWord(track, 1.5)).toBeNull()
  })

  it('returns null for an empty caption track and for undefined captions, without throwing', () => {
    expect(activeCaptionWord(captions([]), 0.5)).toBeNull()
    expect(activeCaptionWord(undefined, 0.5)).toBeNull()
  })

  it('prefers the highest lane when two segments are active at once, unless selection names the lower lane', () => {
    const track = captions([
      seg({ id: 'lo', start: 0, end: 2, text: 'bottom row', lane: 0 }),
      seg({ id: 'hi', start: 0, end: 2, text: 'top row', lane: 1 }),
    ])
    expect(activeCaptionWord(track, 1)).toEqual({ word: 'top', segmentId: 'hi' })
    expect(activeCaptionWord(track, 1, 'lo')).toEqual({ word: 'bottom', segmentId: 'lo' })
  })

  it('splits on irregular internal whitespace when falling back to seg.text', () => {
    const track = captions([seg({ id: 'a', start: 0, end: 1, text: '  hello   world ' })])
    expect(activeCaptionWord(track, 0.5)).toEqual({ word: 'hello', segmentId: 'a' })
  })
})
