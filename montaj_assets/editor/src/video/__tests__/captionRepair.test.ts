import { describe, it, expect } from 'vitest'
import { repairCaptionWords } from '../captionRepair'
import type { Captions, CaptionSegment } from '../../schema'

function makeCaptions(segments: CaptionSegment[]): Captions {
  return { style: 'word-by-word', segments }
}

describe('repairCaptionWords', () => {
  it('returns null when all segments are already consistent', () => {
    const captions = makeCaptions([
      {
        id: 's1',
        text: 'hello world',
        start: 0,
        end: 2,
        words: [
          { word: 'hello', start: 0, end: 1 },
          { word: 'world', start: 1, end: 2 },
        ],
      },
    ])
    expect(repairCaptionWords(captions)).toBeNull()
  })

  it('returns null on case-insensitive match', () => {
    const captions = makeCaptions([
      {
        id: 's1',
        text: 'Hello World',
        start: 0,
        end: 2,
        words: [
          { word: 'hello', start: 0, end: 1 },
          { word: 'world', start: 1, end: 2 },
        ],
      },
    ])
    // words text "hello world" vs seg.text "Hello World" — case-insensitive match → no repair
    expect(repairCaptionWords(captions)).toBeNull()
  })

  it('repairs a segment whose words text diverged from edited text', () => {
    const captions = makeCaptions([
      {
        id: 's1',
        text: 'new edited text',   // edited inline
        start: 0,
        end: 3,
        words: [
          { word: 'old', start: 0, end: 1 },
          { word: 'stale', start: 1, end: 2 },
          { word: 'words', start: 2, end: 3 },
        ],
      },
    ])
    const result = repairCaptionWords(captions)
    expect(result).not.toBeNull()
    const seg = result!.segments[0]
    expect(seg.words).toHaveLength(3)
    expect(seg.words![0].word).toBe('new')
    expect(seg.words![1].word).toBe('edited')
    expect(seg.words![2].word).toBe('text')
    // Uniform timing across [0, 3] — each word gets 1s
    expect(seg.words![0].start).toBeCloseTo(0)
    expect(seg.words![0].end).toBeCloseTo(1)
    expect(seg.words![1].start).toBeCloseTo(1)
    expect(seg.words![2].end).toBeCloseTo(3)
  })

  it('handles a segment with no words array (missing)', () => {
    const captions = makeCaptions([
      {
        id: 's2',
        text: 'only text',
        start: 1,
        end: 3,
        // words absent
      },
    ])
    const result = repairCaptionWords(captions)
    expect(result).not.toBeNull()
    const seg = result!.segments[0]
    expect(seg.words).toHaveLength(2)
    expect(seg.words![0].word).toBe('only')
    expect(seg.words![1].word).toBe('text')
  })

  it('only repairs diverged segments, preserving consistent ones', () => {
    const captions = makeCaptions([
      {
        id: 's1',
        text: 'unchanged',
        start: 0,
        end: 1,
        words: [{ word: 'unchanged', start: 0, end: 1 }],
      },
      {
        id: 's2',
        text: 'new words here',
        start: 1,
        end: 4,
        words: [{ word: 'old', start: 1, end: 2 }],
      },
    ])
    const result = repairCaptionWords(captions)
    expect(result).not.toBeNull()
    // s1 preserved by reference
    expect(result!.segments[0]).toBe(captions.segments[0])
    // s2 repaired
    expect(result!.segments[1].words).toHaveLength(3)
  })

  it('returns null for empty segments array', () => {
    const captions = makeCaptions([])
    // no segments → nothing changed
    expect(repairCaptionWords(captions)).toBeNull()
  })

  it('handles a single-word segment with correct timing', () => {
    const captions = makeCaptions([
      {
        id: 's3',
        text: 'hello',
        start: 5,
        end: 7,
        words: [{ word: 'goodbye', start: 5, end: 7 }],
      },
    ])
    const result = repairCaptionWords(captions)
    expect(result).not.toBeNull()
    expect(result!.segments[0].words![0]).toEqual({ word: 'hello', start: 5, end: 7 })
  })
})
