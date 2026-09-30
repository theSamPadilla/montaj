import { describe, it, expect, vi } from 'vitest'
import type { Project } from '../../../types'
import type { CaptionSegment } from '../../../schema'
import { makeCaptionEdit, makeCaptionEditAll } from '../makeCaptionEdit'

function seg(overrides: Partial<CaptionSegment> = {}): CaptionSegment {
  return { id: 'cap-0', text: 'hello world', start: 0, end: 2, ...overrides }
}

function project(segments: CaptionSegment[]): Project {
  return { id: 'p1', captions: { style: 'word-by-word', segments } } as unknown as Project
}

describe('makeCaptionEdit', () => {
  it('is a no-op when project.captions is absent', () => {
    const onProjectChange = vi.fn()
    const onCaptionEdit = vi.fn()
    const p = { id: 'p1' } as unknown as Project
    makeCaptionEdit(0, p, onProjectChange, onCaptionEdit)('new text')
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onCaptionEdit).not.toHaveBeenCalled()
  })

  it('accepts a bare string, treated as { text }, and respreads words (index target)', () => {
    const onProjectChange = vi.fn()
    const p = project([seg()])
    makeCaptionEdit(0, p, onProjectChange)('foo bar baz')
    const updated = onProjectChange.mock.calls[0][0] as Project
    const out = updated.captions!.segments[0]
    expect(out.text).toBe('foo bar baz')
    expect(out.words).toHaveLength(3)
    expect(out.words![0]).toEqual({ word: 'foo', start: 0, end: 2 / 3 })
    expect(out.words![2].end).toBeCloseTo(2)
  })

  it('addresses a segment by string id', () => {
    const onProjectChange = vi.fn()
    const p = project([seg({ id: 'cap-0' }), seg({ id: 'cap-1', text: 'second', start: 2, end: 4 })])
    makeCaptionEdit('cap-1', p, onProjectChange)('renamed')
    const updated = onProjectChange.mock.calls[0][0] as Project
    expect(updated.captions!.segments[0].text).toBe('hello world') // untouched
    expect(updated.captions!.segments[1].text).toBe('renamed')
  })

  it('applies a position-only patch without touching words', () => {
    const onProjectChange = vi.fn()
    const original = seg({ words: [{ word: 'hello', start: 0, end: 1 }, { word: 'world', start: 1, end: 2 }] })
    const p = project([original])
    makeCaptionEdit(0, p, onProjectChange)({ offsetX: 10, offsetY: -5 })
    const out = onProjectChange.mock.calls[0][0].captions.segments[0] as CaptionSegment
    expect(out.offsetX).toBe(10)
    expect(out.offsetY).toBe(-5)
    expect(out.text).toBe('hello world')
    expect(out.words).toEqual(original.words)
  })

  it('applies a retime-only patch ({ start, end }) without touching words', () => {
    const onProjectChange = vi.fn()
    const original = seg({ words: [{ word: 'hello', start: 0, end: 1 }, { word: 'world', start: 1, end: 2 }] })
    const p = project([original])
    makeCaptionEdit(0, p, onProjectChange)({ start: 5, end: 9 })
    const out = onProjectChange.mock.calls[0][0].captions.segments[0] as CaptionSegment
    expect(out.start).toBe(5)
    expect(out.end).toBe(9)
    expect(out.words).toEqual(original.words)
  })

  it('respreads words against the NEW duration when text and start/end change together', () => {
    const onProjectChange = vi.fn()
    const p = project([seg({ start: 0, end: 2 })])
    makeCaptionEdit(0, p, onProjectChange)({ text: 'foo bar', start: 10, end: 14 })
    const out = onProjectChange.mock.calls[0][0].captions.segments[0] as CaptionSegment
    expect(out.words).toEqual([
      { word: 'foo', start: 10, end: 12 },
      { word: 'bar', start: 12, end: 14 },
    ])
  })

  it('does not let undefined keys in the patch clobber existing values', () => {
    const onProjectChange = vi.fn()
    const p = project([seg({ offsetX: 7 })])
    makeCaptionEdit(0, p, onProjectChange)({ offsetX: undefined, scale: 1.5 })
    const out = onProjectChange.mock.calls[0][0].captions.segments[0] as CaptionSegment
    expect(out.offsetX).toBe(7)
    expect(out.scale).toBe(1.5)
  })

  it('leaves other segments untouched', () => {
    const onProjectChange = vi.fn()
    const p = project([seg({ id: 'cap-0' }), seg({ id: 'cap-1', text: 'second' })])
    makeCaptionEdit(0, p, onProjectChange)({ scale: 2 })
    const segments = onProjectChange.mock.calls[0][0].captions.segments as CaptionSegment[]
    expect(segments[1]).toEqual(p.captions!.segments[1])
  })

  it('is a no-op (no callback) when the numeric index is out of range', () => {
    const onProjectChange = vi.fn()
    const onCaptionEdit = vi.fn()
    const p = project([seg()])
    makeCaptionEdit(5, p, onProjectChange, onCaptionEdit)('x')
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onCaptionEdit).not.toHaveBeenCalled()
  })

  it('is a no-op (no callback) when the string id matches no segment', () => {
    const onProjectChange = vi.fn()
    const onCaptionEdit = vi.fn()
    const p = project([seg({ id: 'cap-0' })])
    makeCaptionEdit('cap-nope', p, onProjectChange, onCaptionEdit)({ scale: 1.2 })
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onCaptionEdit).not.toHaveBeenCalled()
  })

  it('calls both onProjectChange and onCaptionEdit with the updated project', () => {
    const onProjectChange = vi.fn()
    const onCaptionEdit = vi.fn()
    const p = project([seg()])
    makeCaptionEdit(0, p, onProjectChange, onCaptionEdit)({ scale: 1.5 })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0]).toBe(onCaptionEdit.mock.calls[0][0])
  })
})

// "Apply to all" (the captions panel's checkbox): the edit made on one segment
// lands on every segment as the SAME ABSOLUTE value, not as a delta.
describe('makeCaptionEditAll', () => {
  const three = () => project([
    seg({ id: 'cap-0', text: 'zero', start: 0, end: 1, offsetX: 5, offsetY: -2, scale: 1.2, color: '#111111' }),
    seg({ id: 'cap-1', text: 'one', start: 1, end: 2, words: [{ word: 'one', start: 1, end: 2 }] }),
    seg({ id: 'cap-2', text: 'two', start: 2, end: 3, offsetX: -30, scale: 0.5 }),
  ])

  it('gives every segment the same absolute position, leaving each one\'s own size alone', () => {
    const onProjectChange = vi.fn()
    makeCaptionEditAll(three(), onProjectChange)({ offsetX: 12, offsetY: 34 })
    const segments = onProjectChange.mock.calls[0][0].captions.segments as CaptionSegment[]
    expect(segments.map(s => [s.offsetX, s.offsetY])).toEqual([[12, 34], [12, 34], [12, 34]])
    expect(segments.map(s => s.scale)).toEqual([1.2, undefined, 0.5])
  })

  it('gives every segment the same absolute size, leaving each one\'s own position alone', () => {
    const onProjectChange = vi.fn()
    makeCaptionEditAll(three(), onProjectChange)({ scale: 1.75 })
    const segments = onProjectChange.mock.calls[0][0].captions.segments as CaptionSegment[]
    expect(segments.map(s => s.scale)).toEqual([1.75, 1.75, 1.75])
    expect(segments.map(s => [s.offsetX, s.offsetY])).toEqual([[5, -2], [undefined, undefined], [-30, undefined]])
  })

  it('gives every segment the same text color', () => {
    const onProjectChange = vi.fn()
    makeCaptionEditAll(three(), onProjectChange)({ color: '#ff0000' })
    const segments = onProjectChange.mock.calls[0][0].captions.segments as CaptionSegment[]
    expect(segments.map(s => s.color)).toEqual(['#ff0000', '#ff0000', '#ff0000'])
  })

  it('leaves text, timing, words and ids alone', () => {
    const onProjectChange = vi.fn()
    const p = three()
    makeCaptionEditAll(p, onProjectChange)({ offsetX: 1, offsetY: 1 })
    const segments = onProjectChange.mock.calls[0][0].captions.segments as CaptionSegment[]
    segments.forEach((s, i) => {
      const before = p.captions!.segments[i]
      expect([s.id, s.text, s.start, s.end, s.words]).toEqual([before.id, before.text, before.start, before.end, before.words])
    })
  })

  it('writes only position, size and color: text or timing in the patch never reaches every segment', () => {
    const onProjectChange = vi.fn()
    const p = three()
    makeCaptionEditAll(p, onProjectChange)({ scale: 2, text: 'same everywhere', start: 9, end: 10 } as never)
    const segments = onProjectChange.mock.calls[0][0].captions.segments as CaptionSegment[]
    expect(segments.map(s => s.text)).toEqual(['zero', 'one', 'two'])
    expect(segments.map(s => [s.start, s.end])).toEqual([[0, 1], [1, 2], [2, 3]])
    expect(segments.map(s => s.scale)).toEqual([2, 2, 2])
  })

  it('does not let undefined keys in the patch clobber existing values', () => {
    const onProjectChange = vi.fn()
    makeCaptionEditAll(three(), onProjectChange)({ offsetX: undefined, scale: 3 })
    const segments = onProjectChange.mock.calls[0][0].captions.segments as CaptionSegment[]
    expect(segments.map(s => s.offsetX)).toEqual([5, undefined, -30])
  })

  it('is one project change: each callback fires once, with the same updated project', () => {
    const onProjectChange = vi.fn()
    const onCaptionEdit = vi.fn()
    makeCaptionEditAll(three(), onProjectChange, onCaptionEdit)({ offsetX: 1 })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0]).toBe(onCaptionEdit.mock.calls[0][0])
  })

  it('is a no-op with no captions, no segments, or nothing to write', () => {
    const onProjectChange = vi.fn()
    makeCaptionEditAll({ id: 'p1' } as unknown as Project, onProjectChange)({ scale: 2 })
    makeCaptionEditAll(project([]), onProjectChange)({ scale: 2 })
    makeCaptionEditAll(three(), onProjectChange)({})
    makeCaptionEditAll(three(), onProjectChange)({ scale: undefined })
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('is a no-op when every segment already holds exactly these values: no empty undo step', () => {
    const onProjectChange = vi.fn()
    const same = project([
      seg({ id: 'cap-0', offsetX: 3, offsetY: 4, color: '#abcdef' }),
      seg({ id: 'cap-1', offsetX: 3, offsetY: 4, color: '#abcdef' }),
    ])
    makeCaptionEditAll(same, onProjectChange)({ offsetX: 3, offsetY: 4 })
    makeCaptionEditAll(same, onProjectChange)({ color: '#abcdef' })
    expect(onProjectChange).not.toHaveBeenCalled()
    // One segment differing is enough to write.
    makeCaptionEditAll(same, onProjectChange)({ offsetX: 3, offsetY: 5 })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })
})
