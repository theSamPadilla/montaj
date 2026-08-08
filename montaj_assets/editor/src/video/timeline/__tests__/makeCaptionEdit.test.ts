import { describe, it, expect, vi } from 'vitest'
import type { Project } from '../../../types'
import type { CaptionSegment } from '../../../schema'
import { makeCaptionEdit } from '../makeCaptionEdit'

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
