import { describe, it, expect } from 'vitest'
import {
  applyCutToTracks,
  applyCutToItem,
  collapseGaps,
  splitAtTime,
} from '../cuts'
import type { EditorProject as Project } from '../../schema'

// Minimal project factory — only the fields the cut engine touches.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [[]],
    ...over,
  }
}

describe('applyCutToTracks (lift)', () => {
  it('returns the project unchanged for a zero/negative-length cut', () => {
    const p = makeProject({ tracks: [[{ id: 'a', type: 'video', start: 0, end: 10 }]] })
    expect(applyCutToTracks(p, { start: 5, end: 5 })).toBe(p)
    expect(applyCutToTracks(p, { start: 6, end: 3 })).toBe(p)
  })

  it('deletes a clip fully inside the cut and leaves later clips in place (no shift)', () => {
    const p = makeProject({
      tracks: [[
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 10 },
      ]],
    })
    const out = applyCutToTracks(p, { start: 5, end: 10 })
    const primary = out.tracks![0]
    expect(primary.map(c => c.id)).toEqual(['a'])
    expect(primary[0]).toMatchObject({ start: 0, end: 5 })
  })

  it('trims a clip overlapping the left edge of the cut', () => {
    const p = makeProject({
      tracks: [[{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
    })
    const out = applyCutToTracks(p, { start: 6, end: 12 })
    expect(out.tracks![0][0]).toMatchObject({ id: 'a', end: 6, outPoint: 6 })
  })

  it('splits a clip the cut spans into two fragments (lift positions)', () => {
    const p = makeProject({
      tracks: [[{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
    })
    const out = applyCutToTracks(p, { start: 3, end: 7 })
    const primary = out.tracks![0]
    expect(primary).toHaveLength(2)
    expect(primary[0]).toMatchObject({ id: 'a', start: 0, end: 3 })
    expect(primary[1].start).toBe(7) // right fragment stays at original timeline pos
    expect(primary[1].inPoint).toBe(7)
  })

  it('shifts captions after the cut by the cut duration', () => {
    const p = makeProject({
      tracks: [[{ id: 'a', type: 'video', start: 0, end: 10 }]],
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'before', start: 0, end: 2 },
          { text: 'after', start: 8, end: 10 },
        ],
      },
    })
    const out = applyCutToTracks(p, { start: 3, end: 5 })
    const segs = out.captions!.segments
    expect(segs.find(s => s.text === 'before')).toMatchObject({ start: 0, end: 2 })
    expect(segs.find(s => s.text === 'after')).toMatchObject({ start: 6, end: 8 })
  })

  it('leaves overlay tracks (tracks[1+]) untouched', () => {
    const overlay = { id: 'o', type: 'overlay' as const, start: 4, end: 6 }
    const p = makeProject({
      tracks: [
        [{ id: 'a', type: 'video', start: 0, end: 10 }],
        [overlay],
      ],
    })
    const out = applyCutToTracks(p, { start: 3, end: 7 })
    expect(out.tracks![1][0]).toEqual(overlay)
  })
})

describe('collapseGaps', () => {
  it('returns the same reference when there are fewer than 2 clips', () => {
    const p = makeProject({ tracks: [[{ id: 'a', type: 'video', start: 5, end: 10 }]] })
    expect(collapseGaps(p)).toBe(p)
  })

  it('returns the same reference when there are no gaps', () => {
    const p = makeProject({
      tracks: [[
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 10 },
      ]],
    })
    expect(collapseGaps(p)).toBe(p)
  })

  it('shifts clips left to close gaps and remaps captions', () => {
    const p = makeProject({
      tracks: [[
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 8, end: 12 },
      ]],
      captions: {
        style: 'subtitle',
        segments: [{ text: 'b-cap', start: 9, end: 11, words: [{ word: 'x', start: 9, end: 11 }] }],
      },
    })
    const out = collapseGaps(p)
    const primary = out.tracks![0]
    expect(primary[0]).toMatchObject({ id: 'a', start: 0, end: 5 })
    expect(primary[1]).toMatchObject({ id: 'b', start: 5, end: 9 }) // shifted left by 3
    const cap = out.captions!.segments[0]
    expect(cap).toMatchObject({ start: 6, end: 8 })
    expect(cap.words![0]).toMatchObject({ start: 6, end: 8 })
  })
})

describe('applyCutToItem (collapse, single item)', () => {
  it('returns the project unchanged when itemId is not found', () => {
    const p = makeProject({ tracks: [[{ id: 'a', type: 'video', start: 0, end: 10 }]] })
    expect(applyCutToItem(p, 'nope', { start: 2, end: 4 })).toBe(p)
  })

  it('collapses a middle cut within a single primary clip (right fragment butts left)', () => {
    const p = makeProject({
      tracks: [[{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
    })
    const out = applyCutToItem(p, 'a', { start: 3, end: 7 })
    const primary = out.tracks![0]
    expect(primary).toHaveLength(2)
    expect(primary[0]).toMatchObject({ start: 0, end: 3, outPoint: 3 })
    // right fragment collapses: starts at cut.start (3), duration = remaining 3s
    expect(primary[1]).toMatchObject({ start: 3, end: 6, inPoint: 7 })
  })

  it('clamps the cut to the item bounds', () => {
    const p = makeProject({
      tracks: [[{ id: 'a', type: 'video', start: 2, end: 8, inPoint: 0, outPoint: 6 }]],
    })
    const out = applyCutToItem(p, 'a', { start: 0, end: 4 })
    const primary = out.tracks![0]
    // cut clamped to [2,4]; left fragment removed (nothing before 2), right collapses to start 2
    expect(primary[0]).toMatchObject({ start: 2 })
  })
})

describe('splitAtTime', () => {
  it('returns the same reference when nothing contains the playhead', () => {
    const p = makeProject({ tracks: [[{ id: 'a', type: 'video', start: 0, end: 5 }]] })
    expect(splitAtTime(p, 8, null)).toBe(p)
  })

  it('splits every clip containing `at` when itemId is null', () => {
    const p = makeProject({
      tracks: [[{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
    })
    const out = splitAtTime(p, 4, null)
    const primary = out.tracks![0]
    expect(primary).toHaveLength(2)
    expect(primary[0]).toMatchObject({ start: 0, end: 4 })
    expect(primary[1]).toMatchObject({ start: 4 })
  })

  it('splits only the named item when itemId is given', () => {
    const p = makeProject({
      tracks: [[
        { id: 'a', type: 'video', start: 0, end: 10 },
        { id: 'b', type: 'video', start: 0, end: 10 },
      ]],
    })
    const out = splitAtTime(p, 5, 'a')
    // 'a' split into 2 fragments (original id + split id); 'b' untouched.
    expect(out.tracks![0].filter(c => c.id.startsWith('a'))).toHaveLength(2)
    expect(out.tracks![0].filter(c => c.id === 'b')).toHaveLength(1)
    expect(out.tracks![0]).toHaveLength(3)
  })

  it('splits audio tracks containing `at`', () => {
    const p = makeProject({
      tracks: [[]],
      audio: { tracks: [{ id: 'au', src: 'a.mp3', start: 0, end: 10, inPoint: 0 }] },
    })
    const out = splitAtTime(p, 4, null)
    expect(out.audio!.tracks).toHaveLength(2)
    expect(out.audio!.tracks[0]).toMatchObject({ end: 4, outPoint: 4 })
    expect(out.audio!.tracks[1]).toMatchObject({ start: 4, inPoint: 4 })
  })
})
