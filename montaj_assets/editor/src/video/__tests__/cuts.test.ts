import { describe, it, expect } from 'vitest'
import {
  applyCutToTracks,
  applyCutToItem,
  collapseGaps,
  splitAtTime,
  rippleDelete,
  rollEdit,
  slipItem,
  slideItem,
  setClipSpeed,
} from '../cuts'
import type { EditorProject as Project, VisualItem, VisualTrack } from '../../schema'

/** Object-shape visual tracks, carrying the ids `normalizeTracks` would hand
 *  out — so a fixture reads `vtracks([clipA, clipB], [overlay])`. The cut ops
 *  address tracks by INDEX, which the object shape leaves untouched, so every
 *  expectation below is the one the legacy `[[...]]` fixture asserted. */
function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

// Minimal project factory — only the fields the cut engine touches.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([]),
    ...over,
  }
}

describe('applyCutToTracks (lift)', () => {
  it('returns the project unchanged for a zero/negative-length cut', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10 }]) })
    expect(applyCutToTracks(p, { start: 5, end: 5 })).toBe(p)
    expect(applyCutToTracks(p, { start: 6, end: 3 })).toBe(p)
  })

  it('deletes a clip fully inside the cut and leaves later clips in place (no shift)', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 10 },
      ]),
    })
    const out = applyCutToTracks(p, { start: 5, end: 10 })
    const primary = out.tracks![0].items
    expect(primary.map(c => c.id)).toEqual(['a'])
    expect(primary[0]).toMatchObject({ start: 0, end: 5 })
  })

  it('trims a clip overlapping the left edge of the cut', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]),
    })
    const out = applyCutToTracks(p, { start: 6, end: 12 })
    expect(out.tracks![0].items[0]).toMatchObject({ id: 'a', end: 6, outPoint: 6 })
  })

  it('splits a clip the cut spans into two fragments (lift positions)', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]),
    })
    const out = applyCutToTracks(p, { start: 3, end: 7 })
    const primary = out.tracks![0].items
    expect(primary).toHaveLength(2)
    expect(primary[0]).toMatchObject({ id: 'a', start: 0, end: 3 })
    expect(primary[1].start).toBe(7) // right fragment stays at original timeline pos
    expect(primary[1].inPoint).toBe(7)
  })

  it('shifts captions after the cut by the cut duration', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10 }]),
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
      tracks: vtracks(
        [{ id: 'a', type: 'video', start: 0, end: 10 }],
        [overlay],
      ),
    })
    const out = applyCutToTracks(p, { start: 3, end: 7 })
    expect(out.tracks![1].items[0]).toEqual(overlay)
  })
})

describe('collapseGaps', () => {
  it('returns the same reference when there are fewer than 2 clips', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 5, end: 10 }]) })
    expect(collapseGaps(p)).toBe(p)
  })

  it('returns the same reference when there are no gaps', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 10 },
      ]),
    })
    expect(collapseGaps(p)).toBe(p)
  })

  it('shifts clips left to close gaps and remaps captions', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 8, end: 12 },
      ]),
      captions: {
        style: 'subtitle',
        segments: [{ text: 'b-cap', start: 9, end: 11, words: [{ word: 'x', start: 9, end: 11 }] }],
      },
    })
    const out = collapseGaps(p)
    const primary = out.tracks![0].items
    expect(primary[0]).toMatchObject({ id: 'a', start: 0, end: 5 })
    expect(primary[1]).toMatchObject({ id: 'b', start: 5, end: 9 }) // shifted left by 3
    const cap = out.captions!.segments[0]
    expect(cap).toMatchObject({ start: 6, end: 8 })
    expect(cap.words![0]).toMatchObject({ start: 6, end: 8 })
  })
})

describe('applyCutToItem (collapse, single item)', () => {
  it('returns the project unchanged when itemId is not found', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10 }]) })
    expect(applyCutToItem(p, 'nope', { start: 2, end: 4 })).toBe(p)
  })

  it('collapses a middle cut within a single primary clip (right fragment butts left)', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]),
    })
    const out = applyCutToItem(p, 'a', { start: 3, end: 7 })
    const primary = out.tracks![0].items
    expect(primary).toHaveLength(2)
    expect(primary[0]).toMatchObject({ start: 0, end: 3, outPoint: 3 })
    // right fragment collapses: starts at cut.start (3), duration = remaining 3s
    expect(primary[1]).toMatchObject({ start: 3, end: 6, inPoint: 7 })
  })

  it('clamps the cut to the item bounds', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 2, end: 8, inPoint: 0, outPoint: 6 }]),
    })
    const out = applyCutToItem(p, 'a', { start: 0, end: 4 })
    const primary = out.tracks![0].items
    // cut clamped to [2,4]; left fragment removed (nothing before 2), right collapses to start 2
    expect(primary[0]).toMatchObject({ start: 2 })
  })
})

describe('splitAtTime', () => {
  it('returns the same reference when nothing contains the playhead', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]) })
    expect(splitAtTime(p, 8, null)).toBe(p)
  })

  it('splits every clip containing `at` when itemId is null', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 0, outPoint: 10 }]),
    })
    const out = splitAtTime(p, 4, null)
    const primary = out.tracks![0].items
    expect(primary).toHaveLength(2)
    expect(primary[0]).toMatchObject({ start: 0, end: 4 })
    expect(primary[1]).toMatchObject({ start: 4 })
  })

  it('splits only the named item when itemId is given', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 10 },
        { id: 'b', type: 'video', start: 0, end: 10 },
      ]),
    })
    const out = splitAtTime(p, 5, 'a')
    // 'a' split into 2 fragments (original id + split id); 'b' untouched.
    expect(out.tracks![0].items.filter(c => c.id.startsWith('a'))).toHaveLength(2)
    expect(out.tracks![0].items.filter(c => c.id === 'b')).toHaveLength(1)
    expect(out.tracks![0].items).toHaveLength(3)
  })

  it('splits audio tracks containing `at`', () => {
    const p = makeProject({
      tracks: vtracks([]),
      audio: { tracks: [{ id: 'au', src: 'a.mp3', start: 0, end: 10, inPoint: 0 }] },
    })
    const out = splitAtTime(p, 4, null)
    expect(out.audio!.tracks).toHaveLength(2)
    expect(out.audio!.tracks[0]).toMatchObject({ end: 4, outPoint: 4 })
    expect(out.audio!.tracks[1]).toMatchObject({ start: 4, inPoint: 4 })
  })
})

describe('rippleDelete', () => {
  it('returns the same reference when the item is not found', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]) })
    expect(rippleDelete(p, 'nope')).toBe(p)
  })

  it('returns the same reference for an audio-track id (audio lanes are not ripple targets)', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]),
      audio: { tracks: [{ id: 'au', src: 'm.mp3', start: 0, end: 20 }] },
    })
    expect(rippleDelete(p, 'au')).toBe(p)
  })

  it('deletes the item and pulls later clips earlier by its duration', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 9 },
        { id: 'c', type: 'video', start: 9, end: 14 },
      ]),
    })
    const out = rippleDelete(p, 'b')
    expect(out.tracks![0].items.map(c => c.id)).toEqual(['a', 'c'])
    expect(out.tracks![0].items[0]).toMatchObject({ start: 0, end: 5 })
    expect(out.tracks![0].items[1]).toMatchObject({ start: 5, end: 10 })
  })

  it('shifts only content after the deletion point — earlier gaps survive (unlike collapseGaps)', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 3 },
        { id: 'b', type: 'video', start: 6, end: 10 },   // 3s gap before b
        { id: 'c', type: 'video', start: 10, end: 15 },
      ]),
    })
    const out = rippleDelete(p, 'b')
    expect(out.tracks![0].items[0]).toMatchObject({ id: 'a', start: 0, end: 3 })
    expect(out.tracks![0].items[1]).toMatchObject({ id: 'c', start: 6, end: 11 })
    // collapseGaps would additionally have normalized the 3–6 gap away
    expect(collapseGaps(out).tracks![0].items[1]).toMatchObject({ id: 'c', start: 3 })
  })

  it('deletes captions inside the removed window and shifts later ones', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 9 },
        { id: 'c', type: 'video', start: 9, end: 14 },
      ]),
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'a-cap', start: 1, end: 3 },
          { text: 'b-cap', start: 6, end: 8 },
          { text: 'c-cap', start: 10, end: 12, words: [{ word: 'x', start: 10, end: 12 }] },
        ],
      },
    })
    const segs = rippleDelete(p, 'b').captions!.segments
    expect(segs.map(s => s.text)).toEqual(['a-cap', 'c-cap'])
    expect(segs[0]).toMatchObject({ start: 1, end: 3 })
    expect(segs[1]).toMatchObject({ start: 6, end: 8 })
    expect(segs[1].words![0]).toMatchObject({ start: 6, end: 8 })
  })

  it('shifts overlay-track items after the deletion point and leaves earlier ones put', () => {
    const p = makeProject({
      tracks: vtracks(
        [
          { id: 'a', type: 'video', start: 0, end: 5 },
          { id: 'b', type: 'video', start: 5, end: 9 },
          { id: 'c', type: 'video', start: 9, end: 14 },
        ],
        [
          { id: 'o1', type: 'overlay', start: 1, end: 3 },
          { id: 'o2', type: 'overlay', start: 10, end: 12 },
        ],
      ),
    })
    const out = rippleDelete(p, 'b')
    expect(out.tracks![1].items[0]).toMatchObject({ id: 'o1', start: 1, end: 3 })
    expect(out.tracks![1].items[1]).toMatchObject({ id: 'o2', start: 6, end: 8 })
  })

  it('leaves items that begin inside the deleted window put — only later ones are subsequent', () => {
    const p = makeProject({
      tracks: vtracks(
        [
          { id: 'a', type: 'video', start: 0, end: 5 },
          { id: 'b', type: 'video', start: 5, end: 9 },
          { id: 'c', type: 'video', start: 9, end: 14 },
        ],
        [
          { id: 'inside',  type: 'overlay', start: 6, end: 8 },   // starts within [5,9)
          { id: 'atStart', type: 'overlay', start: 5, end: 11 },  // starts on the deletion point
          { id: 'atEnd',   type: 'overlay', start: 9, end: 11 },  // starts on the deletion end
        ],
      ),
    })
    const overlays = rippleDelete(p, 'b').tracks![1].items
    expect(overlays[0]).toMatchObject({ id: 'inside',  start: 6, end: 8 })
    expect(overlays[1]).toMatchObject({ id: 'atStart', start: 5, end: 11 })
    expect(overlays[2]).toMatchObject({ id: 'atEnd',   start: 5, end: 7 })
  })

  it('leaves audio tracks untouched (matching collapseGaps)', () => {
    const audio = { tracks: [{ id: 'au', src: 'm.mp3', start: 0, end: 20, inPoint: 0 }] }
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 9 },
      ]),
      audio,
    })
    expect(rippleDelete(p, 'b').audio).toBe(audio)
  })

  it('pulls the remaining clips to the front when the first item is deleted', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 9 },
      ]),
    })
    const out = rippleDelete(p, 'a')
    expect(out.tracks![0].items).toHaveLength(1)
    expect(out.tracks![0].items[0]).toMatchObject({ id: 'b', start: 0, end: 4 })
  })

  it('only removes the item when it is last — there is nothing to shift', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 9 },
      ]),
    })
    const out = rippleDelete(p, 'b')
    expect(out.tracks![0].items).toHaveLength(1)
    expect(out.tracks![0].items[0]).toMatchObject({ id: 'a', start: 0, end: 5 })
  })

  it('moves shifted clips on the timeline only — source points are preserved', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5, inPoint: 0, outPoint: 5 },
        { id: 'b', type: 'video', start: 5, end: 9, inPoint: 2, outPoint: 6, normalizedInPoint: 2 },
      ]),
    })
    expect(rippleDelete(p, 'a').tracks![0].items[0]).toMatchObject({
      start: 0, end: 4, inPoint: 2, outPoint: 6, normalizedInPoint: 2,
    })
  })
})

describe('rollEdit', () => {
  // left source window 10–15 of a 30s source; right window 20–25 of a 30s source.
  // Both MIN_DURATION clamps bind before either source bound does.
  const base = () => makeProject({
    tracks: vtracks([
      { id: 'l', type: 'video', start: 0, end: 5,  inPoint: 10, outPoint: 15, sourceDuration: 30 },
      { id: 'r', type: 'video', start: 5, end: 10, inPoint: 20, outPoint: 25, sourceDuration: 30 },
    ]),
  })

  it('returns the same reference when either id is missing', () => {
    const p = base()
    expect(rollEdit(p, 'l', 'nope', 1)).toBe(p)
    expect(rollEdit(p, 'nope', 'r', 1)).toBe(p)
  })

  it('returns the same reference when the clips are on different tracks', () => {
    const p = makeProject({
      tracks: vtracks(
        [{ id: 'l', type: 'video', start: 0, end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 }],
        [{ id: 'r', type: 'video', start: 5, end: 10, inPoint: 0, outPoint: 5, sourceDuration: 30 }],
      ),
    })
    expect(rollEdit(p, 'l', 'r', 1)).toBe(p)
  })

  it('returns the same reference when the clips are not adjacent', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'l', type: 'video', start: 0, end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
        { id: 'r', type: 'video', start: 6, end: 10, inPoint: 0, outPoint: 4, sourceDuration: 30 },
      ]),
    })
    expect(rollEdit(p, 'l', 'r', 1)).toBe(p)
  })

  it('returns the same reference when the ids are passed in the wrong order', () => {
    const p = base()
    expect(rollEdit(p, 'r', 'l', 1)).toBe(p)
  })

  it('returns the same reference for a zero delta', () => {
    const p = base()
    expect(rollEdit(p, 'l', 'r', 0)).toBe(p)
  })

  it('moves the shared boundary later without changing total duration', () => {
    const [l, r] = rollEdit(base(), 'l', 'r', 2).tracks![0].items
    expect(l).toMatchObject({ start: 0, end: 7, inPoint: 10, outPoint: 17 })
    expect(r).toMatchObject({ start: 7, end: 10, inPoint: 22, outPoint: 25 })
    expect(r.end - l.start).toBe(10)
  })

  it('moves the shared boundary earlier without changing total duration', () => {
    const [l, r] = rollEdit(base(), 'l', 'r', -2).tracks![0].items
    expect(l).toMatchObject({ start: 0, end: 3, inPoint: 10, outPoint: 13 })
    expect(r).toMatchObject({ start: 3, end: 10, inPoint: 18, outPoint: 25 })
    expect(r.end - l.start).toBe(10)
  })

  it("clamps at the left clip's MIN_DURATION", () => {
    const [l, r] = rollEdit(base(), 'l', 'r', -20).tracks![0].items
    expect(l.end - l.start).toBeCloseTo(0.1)
    expect(l.outPoint).toBeCloseTo(10.1)
    expect(r.start).toBeCloseTo(0.1)
    expect(r.inPoint).toBeCloseTo(15.1)
  })

  it("clamps at the right clip's MIN_DURATION", () => {
    const [l, r] = rollEdit(base(), 'l', 'r', 20).tracks![0].items
    expect(r.end - r.start).toBeCloseTo(0.1)
    expect(l.end).toBeCloseTo(9.9)
    expect(l.outPoint).toBeCloseTo(19.9)
    expect(r.inPoint).toBeCloseTo(24.9)
  })

  it("clamps at the end of the left clip's source media", () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'l', type: 'video', start: 0, end: 5,  inPoint: 10, outPoint: 15, sourceDuration: 16 },
        { id: 'r', type: 'video', start: 5, end: 10, inPoint: 20, outPoint: 25, sourceDuration: 30 },
      ]),
    })
    const [l, r] = rollEdit(p, 'l', 'r', 5).tracks![0].items
    expect(l).toMatchObject({ end: 6, outPoint: 16 })   // outPoint stops at sourceDuration
    expect(r).toMatchObject({ start: 6, inPoint: 21 })
  })

  it("clamps at the start of the right clip's source media", () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'l', type: 'video', start: 0, end: 5,  inPoint: 10, outPoint: 15, sourceDuration: 30 },
        { id: 'r', type: 'video', start: 5, end: 10, inPoint: 1,  outPoint: 6,  sourceDuration: 30 },
      ]),
    })
    const [l, r] = rollEdit(p, 'l', 'r', -5).tracks![0].items
    expect(r).toMatchObject({ start: 4, inPoint: 0 })   // inPoint stops at 0
    expect(l).toMatchObject({ end: 4, outPoint: 14 })
  })

  it('returns the same reference when the roll clamps to zero', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'l', type: 'video', start: 0, end: 5,  inPoint: 10, outPoint: 15, sourceDuration: 30 },
        { id: 'r', type: 'video', start: 5, end: 10, inPoint: 0,  outPoint: 5,  sourceDuration: 30 },
      ]),
    })
    expect(rollEdit(p, 'l', 'r', -3)).toBe(p)   // right clip is already at its source start
  })

  it('leaves captions and audio untouched', () => {
    const captions = { style: 'subtitle' as const, segments: [{ text: 'x', start: 4, end: 6 }] }
    const audio = { tracks: [{ id: 'au', src: 'm.mp3', start: 0, end: 20 }] }
    const p = makeProject({ ...base(), captions, audio })
    const out = rollEdit(p, 'l', 'r', 2)
    expect(out.captions).toBe(captions)
    expect(out.audio).toBe(audio)
  })

  it('rolls non-video items geometrically without inventing source points', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'l', type: 'image', start: 0, end: 5 },
        { id: 'r', type: 'image', start: 5, end: 10 },
      ]),
    })
    const [l, r] = rollEdit(p, 'l', 'r', 2).tracks![0].items
    expect(l).toMatchObject({ end: 7 })
    expect(r).toMatchObject({ start: 7 })
    expect('outPoint' in l).toBe(false)
    expect('inPoint' in r).toBe(false)
  })
})

describe('slipItem', () => {
  const base = () => makeProject({
    tracks: vtracks([
      { id: 'a', type: 'video', start: 2, end: 8, inPoint: 5, outPoint: 11, sourceDuration: 30, normalizedInPoint: 5 },
    ]),
  })

  it('returns the same reference when the item is not found', () => {
    const p = base()
    expect(slipItem(p, 'nope', 1)).toBe(p)
  })

  it('returns the same reference for a zero delta', () => {
    const p = base()
    expect(slipItem(p, 'a', 0)).toBe(p)
  })

  it('returns the same reference for a non-video item (no source media to slip)', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'o', type: 'overlay', start: 0, end: 5 }]) })
    expect(slipItem(p, 'o', 1)).toBe(p)
  })

  it('returns the same reference for a video item carrying no in/outPoint', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]) })
    expect(slipItem(p, 'a', 1)).toBe(p)
  })

  it('shifts the source window while the timeline position stays fixed', () => {
    expect(slipItem(base(), 'a', 3).tracks![0].items[0]).toMatchObject({
      start: 2, end: 8, inPoint: 8, outPoint: 14,
    })
  })

  it('never touches normalizedInPoint', () => {
    expect(slipItem(base(), 'a', 3).tracks![0].items[0].normalizedInPoint).toBe(5)
  })

  it('clamps at the start of the source media', () => {
    expect(slipItem(base(), 'a', -20).tracks![0].items[0]).toMatchObject({
      start: 2, end: 8, inPoint: 0, outPoint: 6,
    })
  })

  it('clamps at the end of the source media', () => {
    expect(slipItem(base(), 'a', 40).tracks![0].items[0]).toMatchObject({
      start: 2, end: 8, inPoint: 24, outPoint: 30,
    })
  })

  it('returns the same reference when already at the source start and slipped earlier', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 30 }]),
    })
    expect(slipItem(p, 'a', -2)).toBe(p)
  })

  it('leaves the upper clamp open when sourceDuration is unknown', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5, inPoint: 1, outPoint: 6 }]),
    })
    expect(slipItem(p, 'a', 100).tracks![0].items[0]).toMatchObject({ inPoint: 101, outPoint: 106 })
  })

  it('slips items on overlay tracks too, leaving captions and audio untouched', () => {
    const captions = { style: 'subtitle' as const, segments: [{ text: 'x', start: 1, end: 3 }] }
    const audio = { tracks: [{ id: 'au', src: 'm.mp3', start: 0, end: 20 }] }
    const p = makeProject({
      tracks: vtracks(
        [{ id: 'a', type: 'video', start: 0, end: 5 }],
        [{ id: 'b', type: 'video', start: 1, end: 4, inPoint: 2, outPoint: 5, sourceDuration: 20 }],
      ),
      captions,
      audio,
    })
    const out = slipItem(p, 'b', 1)
    expect(out.tracks![1].items[0]).toMatchObject({ start: 1, end: 4, inPoint: 3, outPoint: 6 })
    expect(out.tracks![0].items[0]).toBe(p.tracks![0].items[0])
    expect(out.captions).toBe(captions)
    expect(out.audio).toBe(audio)
  })
})

describe('slideItem', () => {
  const base = () => makeProject({
    tracks: vtracks([
      { id: 'p', type: 'video', start: 0,  end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
      { id: 'm', type: 'video', start: 5,  end: 10, inPoint: 2, outPoint: 7, sourceDuration: 30 },
      { id: 'n', type: 'video', start: 10, end: 15, inPoint: 3, outPoint: 8, sourceDuration: 30 },
    ]),
  })

  it('returns the same reference when the item is not found', () => {
    const p = base()
    expect(slideItem(p, 'nope', 1)).toBe(p)
  })

  it('returns the same reference for a zero delta', () => {
    const p = base()
    expect(slideItem(p, 'm', 0)).toBe(p)
  })

  it('moves the item later and lets the neighbors absorb it', () => {
    const [prev, item, next] = slideItem(base(), 'm', 2).tracks![0].items
    expect(prev).toMatchObject({ id: 'p', start: 0, end: 7, inPoint: 0, outPoint: 7 })
    expect(item).toMatchObject({ id: 'm', start: 7, end: 12, inPoint: 2, outPoint: 7 })
    expect(next).toMatchObject({ id: 'n', start: 12, end: 15, inPoint: 5, outPoint: 8 })
  })

  it('moves the item earlier and lets the neighbors absorb it', () => {
    const [prev, item, next] = slideItem(base(), 'm', -2).tracks![0].items
    expect(prev).toMatchObject({ id: 'p', start: 0, end: 3, outPoint: 3 })
    expect(item).toMatchObject({ id: 'm', start: 3, end: 8, inPoint: 2, outPoint: 7 })
    expect(next).toMatchObject({ id: 'n', start: 8, end: 15, inPoint: 1 })
  })

  it("clamps at the next neighbor's MIN_DURATION", () => {
    const [prev, item, next] = slideItem(base(), 'm', 20).tracks![0].items
    expect(next.end - next.start).toBeCloseTo(0.1)
    expect(prev.end).toBeCloseTo(9.9)
    expect(item.start).toBeCloseTo(9.9)
    expect(item.end).toBeCloseTo(14.9)
  })

  it("clamps at the next neighbor's source start", () => {
    const [prev, item, next] = slideItem(base(), 'm', -20).tracks![0].items
    expect(next).toMatchObject({ start: 7, inPoint: 0 })   // nextIn 3 → can only give back 3s
    expect(prev).toMatchObject({ end: 2, outPoint: 2 })
    expect(item).toMatchObject({ start: 2, end: 7 })
  })

  it("clamps at the previous neighbor's MIN_DURATION", () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'p', type: 'video', start: 0, end: 2,  inPoint: 0,  outPoint: 2,  sourceDuration: 30 },
        { id: 'm', type: 'video', start: 2, end: 7,  inPoint: 2,  outPoint: 7,  sourceDuration: 30 },
        { id: 'n', type: 'video', start: 7, end: 12, inPoint: 10, outPoint: 15, sourceDuration: 30 },
      ]),
    })
    const [prev, item] = slideItem(p, 'm', -20).tracks![0].items
    expect(prev.end - prev.start).toBeCloseTo(0.1)
    expect(prev.outPoint).toBeCloseTo(0.1)
    expect(item.start).toBeCloseTo(0.1)
  })

  it("clamps at the previous neighbor's source end", () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'p', type: 'video', start: 0,  end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 6 },
        { id: 'm', type: 'video', start: 5,  end: 10, inPoint: 2, outPoint: 7, sourceDuration: 30 },
        { id: 'n', type: 'video', start: 10, end: 15, inPoint: 3, outPoint: 8, sourceDuration: 30 },
      ]),
    })
    const [prev, item, next] = slideItem(p, 'm', 10).tracks![0].items
    expect(prev).toMatchObject({ end: 6, outPoint: 6 })   // outPoint stops at sourceDuration
    expect(item).toMatchObject({ start: 6, end: 11 })
    expect(next).toMatchObject({ start: 11, inPoint: 4 })
  })

  it('slides a first item with no previous neighbor, clamped at the timeline origin', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'm', type: 'video', start: 2, end: 7,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
        { id: 'n', type: 'video', start: 7, end: 12, inPoint: 3, outPoint: 8, sourceDuration: 30 },
      ]),
    })
    expect(slideItem(p, 'm', 2).tracks![0].items[0]).toMatchObject({ start: 4, end: 9 })
    // with no previous neighbor to shrink, the origin is what stops the slide
    expect(slideItem(p, 'm', -20).tracks![0].items[0]).toMatchObject({ start: 0, end: 5 })
  })

  it('slides a last item with no next neighbor', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'p', type: 'video', start: 0, end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
        { id: 'm', type: 'video', start: 5, end: 10, inPoint: 2, outPoint: 7, sourceDuration: 30 },
      ]),
    })
    const [prev, item] = slideItem(p, 'm', 2).tracks![0].items
    expect(prev).toMatchObject({ end: 7, outPoint: 7 })
    expect(item).toMatchObject({ start: 7, end: 12, inPoint: 2, outPoint: 7 })
  })

  it('picks neighbors by timeline order, not array order', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'n', type: 'video', start: 10, end: 15, inPoint: 3, outPoint: 8, sourceDuration: 30 },
        { id: 'p', type: 'video', start: 0,  end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
        { id: 'm', type: 'video', start: 5,  end: 10, inPoint: 2, outPoint: 7, sourceDuration: 30 },
      ]),
    })
    const [next, prev, item] = slideItem(p, 'm', 2).tracks![0].items
    expect(prev).toMatchObject({ id: 'p', end: 7, outPoint: 7 })
    expect(item).toMatchObject({ id: 'm', start: 7, end: 12 })
    expect(next).toMatchObject({ id: 'n', start: 12, inPoint: 5 })
  })

  it('does not absorb into non-adjacent neighbors', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'p', type: 'video', start: 0,  end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
        { id: 'm', type: 'video', start: 8,  end: 12, inPoint: 0, outPoint: 4, sourceDuration: 30 },
        { id: 'n', type: 'video', start: 15, end: 20, inPoint: 3, outPoint: 8, sourceDuration: 30 },
      ]),
    })
    const out = slideItem(p, 'm', 2)
    expect(out.tracks![0].items[0]).toBe(p.tracks![0].items[0])
    expect(out.tracks![0].items[2]).toBe(p.tracks![0].items[2])
    expect(out.tracks![0].items[1]).toMatchObject({ start: 10, end: 14, inPoint: 0, outPoint: 4 })
  })

  it("shifts only the captions sitting over the item's old window", () => {
    const p = makeProject({
      ...base(),
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'p-cap', start: 1,  end: 3 },
          { text: 'm-cap', start: 6,  end: 9, words: [{ word: 'w', start: 6, end: 9 }] },
          { text: 'n-cap', start: 11, end: 13 },
        ],
      },
    })
    const segs = slideItem(p, 'm', 2).captions!.segments
    expect(segs[0]).toBe(p.captions!.segments[0])
    expect(segs[1]).toMatchObject({ start: 8, end: 11 })
    expect(segs[1].words![0]).toMatchObject({ start: 8, end: 11 })
    expect(segs[2]).toBe(p.captions!.segments[2])
  })

  it('returns the same reference when the slide clamps to zero', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'p', type: 'video', start: 0,  end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
        { id: 'm', type: 'video', start: 5,  end: 10, inPoint: 2, outPoint: 7, sourceDuration: 30 },
        { id: 'n', type: 'video', start: 10, end: 15, inPoint: 0, outPoint: 5, sourceDuration: 30 },
      ]),
    })
    expect(slideItem(p, 'm', -5)).toBe(p)   // n is already at its source start
  })

  it('leaves audio tracks untouched', () => {
    const audio = { tracks: [{ id: 'au', src: 'm.mp3', start: 0, end: 20 }] }
    const p = makeProject({ ...base(), audio })
    expect(slideItem(p, 'm', 2).audio).toBe(audio)
  })
})

// ── Track-level invariants ──────────────────────────────────────────────────
//
// Two properties every op in this file shares, both of which are easy to break
// by rebuilding `tracks` as bare `{ id, items }` objects or by filtering out
// the empties on the way past:
//
//   • a track's id and its volume/muted/enabled survive the op;
//   • an emptied track STAYS, unlike `moveItemAcrossTracks`, which prunes.

describe('every op preserves track identity and settings', () => {
  /** Two tracks with settings only they should ever carry, plus a third that is
   *  already empty and must still be there afterwards. */
  function settledProject(): Project {
    return makeProject({
      tracks: [
        {
          id: 'base', volume: 0.4, muted: false,
          items: [
            // a|b share a boundary (so `rollEdit` has one to move); the gap
            // before c is what gives `collapseGaps` something to close.
            { id: 'a', type: 'video', start: 0,  end: 5,  inPoint: 0, outPoint: 5, sourceDuration: 30 },
            { id: 'b', type: 'video', start: 5,  end: 10, inPoint: 0, outPoint: 5, sourceDuration: 30 },
            { id: 'c', type: 'video', start: 11, end: 16, inPoint: 0, outPoint: 5, sourceDuration: 30 },
          ],
        },
        { id: 'ovl', enabled: false, items: [{ id: 'o', type: 'overlay', start: 1, end: 3 }] },
        { id: 'spare', volume: 0.9, items: [] },
      ],
    })
  }

  const settingsOf = (p: Project) =>
    p.tracks!.map(t => ({ id: t.id, volume: t.volume, muted: t.muted, enabled: t.enabled }))
  const expected = settingsOf(settledProject())

  const ops: Array<[string, (p: Project) => Project]> = [
    ['applyCutToTracks', p => applyCutToTracks(p, { start: 1, end: 2 })],
    ['collapseGaps',     p => collapseGaps(p)],
    ['applyCutToItem (primary)', p => applyCutToItem(p, 'a', { start: 1, end: 2 })],
    ['applyCutToItem (overlay)', p => applyCutToItem(p, 'o', { start: 1.5, end: 2 })],
    ['splitAtTime',      p => splitAtTime(p, 2, null)],
    ['rippleDelete',     p => rippleDelete(p, 'b')],
    ['rollEdit',         p => rollEdit(p, 'a', 'b', 0.5)],
    ['slipItem',         p => slipItem(p, 'a', 1)],
    ['slideItem',        p => slideItem(p, 'b', 1)],
  ]

  for (const [name, op] of ops) {
    it(`${name} keeps every track's id and settings, and keeps the empty track`, () => {
      const input = settledProject()
      const out = op(input)
      expect(out).not.toBe(input)                   // the op actually did something
      expect(settingsOf(out)).toEqual(expected)
      expect(out.tracks!.map(t => t.id)).toEqual(['base', 'ovl', 'spare'])
      expect(out.tracks![2].items).toEqual([])      // empty tracks are kept
    })
  }
})

// ── Per-clip speed (montaj/speed) ─────────────────────────────────────────────
//
// The invariant every op must preserve for a clip at speed S: the source-window
// length is the timeline span times speed —
//
//     outPoint − inPoint === S · (end − start)
//
// A clip at S=1/absent is byte-identical to the pre-speed op (every test above
// exercises that path). These tests exercise S=2 (a 10s source window plays in
// 5 timeline seconds) and S=0.5 (a 10s window is stretched over 20 seconds).

describe('per-clip speed', () => {
  /** outPoint − inPoint − S·(end − start); 0 when the invariant holds. */
  const invariantErr = (i: VisualItem) =>
    (i.outPoint! - i.inPoint!) - (i.speed ?? 1) * (i.end - i.start)
  const holdsFor = (i: VisualItem) => expect(invariantErr(i)).toBeCloseTo(0, 9)

  describe('trim / cut ops keep outPoint − inPoint === S·(end − start)', () => {
    it('applyCutToTracks trims a sped clip end (overlaps-left) coherently', () => {
      const p = makeProject({
        tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5, inPoint: 100, outPoint: 110, speed: 2 }]),
      })
      const a = applyCutToTracks(p, { start: 3, end: 99 }).tracks![0].items[0]
      expect(a).toMatchObject({ end: 3, outPoint: 106 })   // 100 + (3−0)·2
      holdsFor(a)
    })

    it('applyCutToTracks trims a sped clip start (overlaps-right) coherently', () => {
      const p = makeProject({
        tracks: vtracks([{ id: 'a', type: 'video', start: 2, end: 7, inPoint: 100, outPoint: 110, speed: 2 }]),
      })
      const a = applyCutToTracks(p, { start: 0, end: 4 }).tracks![0].items[0]
      expect(a).toMatchObject({ start: 4, inPoint: 104 })  // 100 + (4−2)·2
      holdsFor(a)
    })

    it('splitAtTime splits a sped clip into two coherent fragments', () => {
      const p = makeProject({
        tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5, inPoint: 100, outPoint: 110, speed: 2 }]),
      })
      const [left, right] = splitAtTime(p, 3, 'a').tracks![0].items
      expect(left).toMatchObject({ end: 3, outPoint: 106 })            // 100 + 3·2
      expect(right).toMatchObject({ start: 3, inPoint: 106, end: 5, outPoint: 110 })
      holdsFor(left)
      holdsFor(right)
    })

    it('applyCutToItem (collapse) cuts a sped clip coherently, re-timing the right fragment by /S', () => {
      const p = makeProject({
        tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5, inPoint: 100, outPoint: 110, speed: 2 }]),
      })
      const [left, right] = applyCutToItem(p, 'a', { start: 1, end: 3 }).tracks![0].items
      expect(left).toMatchObject({ end: 1, outPoint: 102 })            // physStart 100 + 1·2
      // right: source [106, 110] is 4 src-seconds → 4/2 = 2 timeline seconds from cut.start 1.
      expect(right).toMatchObject({ start: 1, end: 3, inPoint: 106, outPoint: 110 })
      holdsFor(left)
      holdsFor(right)
    })

    it('rollEdit moves the shared boundary by d·S in each clip’s own source', () => {
      const p = makeProject({
        tracks: vtracks([
          { id: 'a', type: 'video', start: 0, end: 5, inPoint: 100, outPoint: 110, sourceDuration: 200, speed: 2 },
          { id: 'b', type: 'video', start: 5, end: 9, inPoint: 20,  outPoint: 22,  sourceDuration: 200, speed: 0.5 },
        ]),
      })
      const [a, b] = rollEdit(p, 'a', 'b', 1).tracks![0].items
      expect(a).toMatchObject({ end: 6, outPoint: 112 })   // 110 + 1·2
      expect(b).toMatchObject({ start: 6, inPoint: 20.5 })  // 20 + 1·0.5
      holdsFor(a)
      holdsFor(b)
    })

    it('rollEdit clamps a sped left clip at its source end by /S', () => {
      const p = makeProject({
        tracks: vtracks([
          { id: 'a', type: 'video', start: 0, end: 5, inPoint: 100, outPoint: 110, sourceDuration: 111, speed: 2 },
          { id: 'b', type: 'video', start: 5, end: 20, inPoint: 0, outPoint: 30, sourceDuration: 200, speed: 2 },
        ]),
      })
      // left has only 1 source-second of headroom (111 − 110); at S=2 that is 0.5 timeline-seconds.
      const [a] = rollEdit(p, 'a', 'b', 10).tracks![0].items
      expect(a.outPoint).toBeCloseTo(111)
      expect(a.end).toBeCloseTo(5.5)
      holdsFor(a)
    })

    it('slipItem moves the source window by delta·S with the timeline fixed', () => {
      const p = makeProject({
        tracks: vtracks([
          { id: 'a', type: 'video', start: 2, end: 8, inPoint: 5, outPoint: 17, sourceDuration: 200, speed: 2 },
        ]),
      })
      const a = slipItem(p, 'a', 3).tracks![0].items[0]
      expect(a).toMatchObject({ start: 2, end: 8, inPoint: 11, outPoint: 23 })  // ±3·2
      holdsFor(a)
    })

    it('slipItem clamps a sped clip at the source start by /S', () => {
      const p = makeProject({
        tracks: vtracks([
          { id: 'a', type: 'video', start: 2, end: 8, inPoint: 5, outPoint: 17, sourceDuration: 200, speed: 2 },
        ]),
      })
      // minDelta = −inPoint/S = −2.5; a −10 drag parks inPoint at exactly 0.
      const a = slipItem(p, 'a', -10).tracks![0].items[0]
      expect(a.inPoint).toBeCloseTo(0)
      expect(a.outPoint).toBeCloseTo(12)
      holdsFor(a)
    })

    it('slideItem re-times each neighbor by d·S in its own source', () => {
      const p = makeProject({
        tracks: vtracks([
          { id: 'p', type: 'video', start: 0,  end: 5,  inPoint: 0,   outPoint: 10,  sourceDuration: 200, speed: 2 },
          { id: 'm', type: 'video', start: 5,  end: 10, inPoint: 100, outPoint: 105, sourceDuration: 200 },
          { id: 'n', type: 'video', start: 10, end: 15, inPoint: 3,   outPoint: 13,  sourceDuration: 200, speed: 2 },
        ]),
      })
      const [prev, item, next] = slideItem(p, 'm', 2).tracks![0].items
      expect(prev).toMatchObject({ id: 'p', end: 7, outPoint: 14 })   // 10 + 2·2
      expect(item).toMatchObject({ id: 'm', start: 7, end: 12, inPoint: 100, outPoint: 105 })
      expect(next).toMatchObject({ id: 'n', start: 12, inPoint: 7 })  // 3 + 2·2
      holdsFor(prev)
      holdsFor(next)
    })
  })

  describe('setClipSpeed', () => {
    const oneClip = (over: Partial<VisualItem> = {}) => makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10, inPoint: 100, outPoint: 110, ...over }]),
    })

    it('2× halves the timeline span, leaving inPoint/outPoint untouched', () => {
      const a = setClipSpeed(oneClip(), 'a', 2).tracks![0].items[0]
      expect(a).toMatchObject({ speed: 2, start: 0, end: 5, inPoint: 100, outPoint: 110 })
      holdsFor(a)
    })

    it('0.5× doubles the timeline span', () => {
      const a = setClipSpeed(oneClip(), 'a', 0.5).tracks![0].items[0]
      expect(a).toMatchObject({ speed: 0.5, end: 20, inPoint: 100, outPoint: 110 })
      holdsFor(a)
    })

    it('clamps speed above 4 to 4', () => {
      const a = setClipSpeed(oneClip(), 'a', 10).tracks![0].items[0]
      expect(a.speed).toBe(4)
      expect(a.end).toBeCloseTo(2.5)   // 10 / 4
      holdsFor(a)
    })

    it('clamps speed below 0.25 to 0.25', () => {
      const a = setClipSpeed(oneClip(), 'a', 0.01).tracks![0].items[0]
      expect(a.speed).toBe(0.25)
      expect(a.end).toBeCloseTo(40)    // 10 / 0.25
      holdsFor(a)
    })

    it('re-speeds an already-sped clip correctly (source length is speed-invariant)', () => {
      // Start at 2× (end already 5), then 4×, then back to 1× → original 10s span.
      const at2x = oneClip({ end: 5, speed: 2 })
      const at4x = setClipSpeed(at2x, 'a', 4).tracks![0].items[0]
      expect(at4x).toMatchObject({ speed: 4, end: 2.5 })
      holdsFor(at4x)

      const back = setClipSpeed(
        makeProject({ tracks: vtracks([at4x]) }), 'a', 1,
      ).tracks![0].items[0]
      expect(back).toMatchObject({ speed: 1, end: 10, inPoint: 100, outPoint: 110 })
      holdsFor(back)
    })

    it('re-fits a clip with no stored outPoint from its current span × speed', () => {
      // No outPoint: source window is (end − start)·S. At 2× the 10s span → 20 src-seconds…
      const at2x = setClipSpeed(oneClip({ inPoint: undefined, outPoint: undefined }), 'a', 2).tracks![0].items[0]
      expect(at2x).toMatchObject({ speed: 2, end: 5 })   // 20 src-seconds / 2
      // …and back to 1× recovers the original 10s span.
      const back = setClipSpeed(makeProject({ tracks: vtracks([at2x]) }), 'a', 1).tracks![0].items[0]
      expect(back).toMatchObject({ speed: 1, end: 10 })
    })

    it('does not close the gap it opens — the next clip stays put', () => {
      const p = makeProject({
        tracks: vtracks([
          { id: 'a', type: 'video', start: 0,  end: 10, inPoint: 100, outPoint: 110 },
          { id: 'b', type: 'video', start: 10, end: 15, inPoint: 0,   outPoint: 5 },
        ]),
      })
      const out = setClipSpeed(p, 'a', 2)
      expect(out.tracks![0].items[0]).toMatchObject({ end: 5, speed: 2 })
      expect(out.tracks![0].items[1]).toMatchObject({ start: 10, end: 15 })  // gap at [5,10] left for the caller
    })

    it('returns the same reference when the clip is not found', () => {
      const p = oneClip()
      expect(setClipSpeed(p, 'nope', 2)).toBe(p)
    })

    it('is a no-op on a non-video clip — speed is video-only', () => {
      const p = makeProject({
        tracks: vtracks([{ id: 'a', type: 'image', start: 0, end: 10 }]),
      })
      const out = setClipSpeed(p, 'a', 2)
      expect(out).toBe(p)
      expect(out.tracks![0].items[0].speed).toBeUndefined()
      expect(out.tracks![0].items[0].end).toBe(10)
    })

    it('returns a new project (immutable) when it does change the clip', () => {
      const p = oneClip()
      const out = setClipSpeed(p, 'a', 2)
      expect(out).not.toBe(p)
      expect(p.tracks![0].items[0].end).toBe(10)          // input untouched
      expect(p.tracks![0].items[0].speed).toBeUndefined()
    })
  })
})
