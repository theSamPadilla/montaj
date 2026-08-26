import { describe, it, expect } from 'vitest'
import { insertClipAt, newClipId } from '../cuts'
import type { EditorProject as Project, VisualItem, VisualTrack } from '../../schema'

/** Object-shape visual tracks carrying the ids `normalizeTracks` would hand out
 *  — mirrors the fixture helper in `cuts.test.ts`. */
function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

// Minimal project factory — only the fields the insert helper touches.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([]),
    ...over,
  }
}

const EPS = 1e-6

/** No two items on a track overlap by more than float slop. */
function assertNoOverlaps(items: VisualItem[]): void {
  const sorted = [...items].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end - EPS)
  }
}

/** Every id present except the known source ids — the freshly inserted clip. */
function inserted(items: VisualItem[], sourceIds: string[]): VisualItem {
  const found = items.find(i => !sourceIds.includes(i.id))
  expect(found).toBeDefined()
  return found!
}

describe('insertClipAt — ripple', () => {
  it('shifts later clips right by exactly the new length and drops at the drop time', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 10 },
        { id: 'c', type: 'video', start: 10, end: 15 },
      ]),
    })
    const out = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 3 }, 5, { ripple: true })
    const items = out.tracks![0].items

    expect(items).toHaveLength(4)
    expect(items.find(i => i.id === 'a')).toMatchObject({ start: 0, end: 5 })   // before the drop — unchanged
    expect(items.find(i => i.id === 'b')).toMatchObject({ start: 8, end: 13 })  // shifted right by 3
    expect(items.find(i => i.id === 'c')).toMatchObject({ start: 13, end: 18 }) // shifted right by 3

    const clip = inserted(items, ['a', 'b', 'c'])
    expect(clip).toMatchObject({ start: 5, end: 8 })

    assertNoOverlaps(items)
    // returned items are sorted by start
    const starts = items.map(i => i.start)
    expect(starts).toEqual([...starts].sort((x, y) => x - y))
  })

  it('snaps to the nearest edge of a straddling clip instead of dropping inside it', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 10 }]),
    })
    const out = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 3 }, 5, { ripple: true })
    const items = out.tracks![0].items

    expect(items).toHaveLength(2)
    assertNoOverlaps(items)

    const clip = inserted(items, ['a'])
    // the new clip must sit at a boundary of the straddled clip, never inside it
    expect([0, 10]).toContain(clip.start)
  })

  it('snaps a straddled drop to the START at/before the midpoint (including exactly 50%), and to the END past it', () => {
    // Sam's product call (2026-08-25): never split a clip. A drop in the
    // first half of a clip — including dead center — means "put the new
    // clip before this one"; only a drop strictly past the midpoint pushes
    // the new clip after it. See insertClipAt's doc comment.
    const straddler = (): VisualItem[] => [{ id: 'a', type: 'video', start: 0, end: 10 }]

    const before = insertClipAt(
      makeProject({ tracks: vtracks(straddler()) }), 'trk-0', { src: 'n.mp4', sourceDuration: 2 }, 4, { ripple: true },
    )
    expect(inserted(before.tracks![0].items, ['a']).start).toBe(0)

    const tie = insertClipAt(
      makeProject({ tracks: vtracks(straddler()) }), 'trk-0', { src: 'n.mp4', sourceDuration: 2 }, 5, { ripple: true },
    )
    expect(inserted(tie.tracks![0].items, ['a']).start).toBe(0)

    const after = insertClipAt(
      makeProject({ tracks: vtracks(straddler()) }), 'trk-0', { src: 'n.mp4', sourceDuration: 2 }, 6, { ripple: true },
    )
    expect(inserted(after.tracks![0].items, ['a']).start).toBe(10)
  })

  it('snaps to the nearest edge when the drop point straddles the second of two clips', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 10 },
        { id: 'b', type: 'video', start: 10, end: 20 },
      ]),
    })
    const out = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 4 }, 15, { ripple: true })
    const items = out.tracks![0].items

    expect(items).toHaveLength(3)
    assertNoOverlaps(items)

    // order preserved: 'a' still precedes 'b' on the timeline
    const a = items.find(i => i.id === 'a')!
    const b = items.find(i => i.id === 'b')!
    expect(a.start).toBeLessThan(b.start)

    const clip = inserted(items, ['a', 'b'])
    // the new clip must sit at a boundary of the straddled clip 'b', never inside it
    expect([10, 20]).toContain(clip.start)
  })
})

describe('insertClipAt — non-ripple', () => {
  it('places at the drop time inside a free gap and leaves others untouched', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 10, end: 15 },
      ]),
    })
    const out = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 2 }, 6, { ripple: false })
    const items = out.tracks![0].items

    expect(items.find(i => i.id === 'a')).toMatchObject({ start: 0, end: 5 })
    expect(items.find(i => i.id === 'b')).toMatchObject({ start: 10, end: 15 })
    expect(inserted(items, ['a', 'b'])).toMatchObject({ start: 6, end: 8 })
    assertNoOverlaps(items)
  })

  it('snaps into the nearest fitting gap when the drop window overlaps a clip', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 6, end: 20 },
      ]),
    })
    // Drop at 3 overlaps 'a'; the [5,6] gap fits a length-1 clip exactly.
    const out = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 1 }, 3, { ripple: false })
    const items = out.tracks![0].items

    expect(items.find(i => i.id === 'a')).toMatchObject({ start: 0, end: 5 })
    expect(items.find(i => i.id === 'b')).toMatchObject({ start: 6, end: 20 })
    expect(inserted(items, ['a', 'b'])).toMatchObject({ start: 5, end: 6 })
    assertNoOverlaps(items)
  })

  it('appends after the last item when no gap at/after the drop fits', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 10 },
      ]),
    })
    // Drop at 3, length 4: overlaps both, [5,10] gap too small → appended at 10.
    const out = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 4 }, 3, { ripple: false })
    const items = out.tracks![0].items

    expect(items.find(i => i.id === 'a')).toMatchObject({ start: 0, end: 5 })
    expect(items.find(i => i.id === 'b')).toMatchObject({ start: 5, end: 10 })
    expect(inserted(items, ['a', 'b'])).toMatchObject({ start: 10, end: 14 })
    assertNoOverlaps(items)
  })
})

describe('insertClipAt — the built item', () => {
  it('is a whole-source video item with inPoint 0, outPoint sourceDuration, and a distinct id', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'clip-0', type: 'video', start: 0, end: 4 }]) })
    const out = insertClipAt(
      p,
      'trk-0',
      { src: 'n.mp4', proxySrc: 'n_proxy.mp4', sourceDuration: 7, sourceWidth: 1920, sourceHeight: 1080 },
      100, // beyond all content → placed at the drop point
      { ripple: false },
    )
    const clip = inserted(out.tracks![0].items, ['clip-0'])

    expect(clip.type).toBe('video')
    expect(clip.src).toBe('n.mp4')
    expect(clip.proxySrc).toBe('n_proxy.mp4')
    expect(clip.inPoint).toBe(0)
    expect(clip.outPoint).toBe(7)
    expect(clip.end - clip.start).toBe(7)
    expect(clip.sourceDuration).toBe(7)
    expect(clip.sourceWidth).toBe(1920)
    expect(clip.sourceHeight).toBe(1080)
    expect(clip.id).not.toBe('clip-0')
  })

  it('omits proxySrc / sourceWidth / sourceHeight when not provided', () => {
    const p = makeProject({ tracks: vtracks([]) })
    const clip = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 2 }, 0, { ripple: false })
      .tracks![0].items[0]

    expect('proxySrc' in clip).toBe(false)
    expect('sourceWidth' in clip).toBe(false)
    expect('sourceHeight' in clip).toBe(false)
  })
})

describe('insertClipAt — misc', () => {
  it('clamps a negative drop time to 0', () => {
    const p = makeProject({ tracks: vtracks([]) })
    const clip = insertClipAt(p, 'trk-0', { src: 'n.mp4', sourceDuration: 3 }, -5, { ripple: false })
      .tracks![0].items[0]
    expect(clip).toMatchObject({ start: 0, end: 3 })
  })

  it('returns the project unchanged when the track id is unknown', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]) })
    expect(insertClipAt(p, 'nope', { src: 'n.mp4', sourceDuration: 2 }, 1, { ripple: true })).toBe(p)
  })

  it('does not mutate the input project, its items, or the clip descriptor', () => {
    const clipInput = { src: 'n.mp4', sourceDuration: 2 }
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]) })
    const before = JSON.stringify(p)
    insertClipAt(p, 'trk-0', clipInput, 1, { ripple: true })
    expect(JSON.stringify(p)).toBe(before)
    expect(clipInput).toEqual({ src: 'n.mp4', sourceDuration: 2 })
  })
})

describe('newClipId', () => {
  it('returns distinct ids that never look like a clip-<n> source id', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 500; i++) ids.add(newClipId())
    expect(ids.size).toBe(500)
    for (const id of ids) expect(id).not.toMatch(/^clip-\d+$/)
  })
})
