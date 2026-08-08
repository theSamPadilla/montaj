import { describe, it, expect } from 'vitest'
import type { Project } from '../../types'
import type { CaptionSegment } from '../../schema'
import { backfillCaptionIds } from '../VideoEditor'

function project(segments: CaptionSegment[] | null): Project {
  return (segments
    ? { id: 'p1', captions: { style: 'word-by-word', segments } }
    : { id: 'p1' }) as unknown as Project
}

function seg(over: Partial<CaptionSegment> = {}): CaptionSegment {
  return { text: 'hello', start: 0, end: 1, ...over }
}

const ids = (p: Project) => p.captions!.segments.map((s) => s.id)

describe('backfillCaptionIds', () => {
  it('returns the SAME reference when there is nothing to do', () => {
    // This is the property the backfill effect's loop-safety rests on: after our
    // own applyExternal re-fires the effect, the second pass must be a no-op.
    const noCaptions = project(null)
    expect(backfillCaptionIds(noCaptions)).toBe(noCaptions)

    const empty = project([])
    expect(backfillCaptionIds(empty)).toBe(empty)

    const done = project([seg({ id: 'cap-0' }), seg({ id: 'cap-1' })])
    expect(backfillCaptionIds(done)).toBe(done)
  })

  it('is idempotent — backfilling the result changes nothing further', () => {
    const once = backfillCaptionIds(project([seg(), seg(), seg()]))
    expect(backfillCaptionIds(once)).toBe(once)
  })

  it('mints cap-<index> for an all-id-less track (regenerated captions)', () => {
    const out = backfillCaptionIds(project([seg(), seg(), seg()]))
    expect(ids(out)).toEqual(['cap-0', 'cap-1', 'cap-2'])
  })

  it('never overwrites an existing id', () => {
    const out = backfillCaptionIds(project([seg({ id: 'kept' }), seg()]))
    expect(ids(out)[0]).toBe('kept')
  })

  it('does not mint a duplicate of an id already in use', () => {
    // `cap-1` is already taken at index 2; index 1 must not be handed the same id.
    const out = backfillCaptionIds(project([seg({ id: 'cap-0' }), seg(), seg({ id: 'cap-1' })]))
    const got = ids(out)
    expect(got).toEqual(['cap-0', 'cap-2', 'cap-1'])
    expect(new Set(got).size).toBe(got.length)
  })

  it('stays collision-free across a mixed track (backfilled + freshly regenerated)', () => {
    const out = backfillCaptionIds(project([
      seg(), seg({ id: 'cap-0' }), seg(), seg({ id: 'cap-3' }), seg(), seg({ id: 'cap-1' }), seg(),
    ]))
    const got = ids(out)
    expect(new Set(got).size).toBe(got.length)
    expect(got.every((id) => !!id)).toBe(true)
    // Deterministic: the counter only moves forward, skipping ids already taken.
    expect(got).toEqual(['cap-2', 'cap-0', 'cap-4', 'cap-3', 'cap-5', 'cap-1', 'cap-6'])
  })

  it('preserves every other field on the segments it touches', () => {
    const out = backfillCaptionIds(project([seg({ text: 'x', start: 2, end: 4, offsetX: 10, scale: 1.5 })]))
    expect(out.captions!.segments[0]).toMatchObject({ text: 'x', start: 2, end: 4, offsetX: 10, scale: 1.5 })
  })
})
