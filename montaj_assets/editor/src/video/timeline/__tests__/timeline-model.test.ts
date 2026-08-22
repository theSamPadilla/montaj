import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import type { AudioTrack, VisualItem } from '../../../schema'
import {
  computeAutoCrossfade,
  computeDerivedTiming,
  groupAudioLanes,
  mapTrackItems,
  normalizeTracks,
  trackItems,
} from '../timeline-model'

function track(overrides: Partial<AudioTrack> = {}): AudioTrack {
  return { id: 't0', src: 'a.mp3', start: 0, end: 2, ...overrides }
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: 'p1', ...overrides } as unknown as Project
}

describe('computeDerivedTiming', () => {
  it('derives snap boundaries, content duration, and padded total duration from tracks + audio', () => {
    const p = project({
      tracks: [[
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 4, end: 10 },
      ]],
      audio: { tracks: [track({ start: 2, end: 6 })] },
    } as unknown as Partial<Project>)

    const { snapBoundaries, contentDuration, totalDuration } = computeDerivedTiming(p)
    expect(snapBoundaries.sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 10])
    expect(contentDuration).toBe(10)
    // max(5, 10 * 0.2) = 5s padding beyond content
    expect(totalDuration).toBe(15)
  })

  it('uses the 5s minimum headroom when 20% of content duration is smaller', () => {
    const p = project({
      tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 2 }]],
    } as unknown as Partial<Project>)

    const { contentDuration, totalDuration } = computeDerivedTiming(p)
    expect(contentDuration).toBe(2)
    expect(totalDuration).toBe(7) // 2 + max(5, 0.4) = 7
  })

  it('returns zeroed timing for a project with no tracks or audio', () => {
    const { snapBoundaries, contentDuration, totalDuration } = computeDerivedTiming(project())
    expect(snapBoundaries).toEqual([])
    expect(contentDuration).toBe(0)
    expect(totalDuration).toBe(5)
  })
})

describe('computeAutoCrossfade', () => {
  it('returns null (no-change signal) when there are no audio tracks', () => {
    expect(computeAutoCrossfade(project())).toBeNull()
    expect(computeAutoCrossfade(project({ audio: { tracks: [] } }))).toBeNull()
  })

  it('returns null when tracks do not overlap, leaving any stale fade values untouched', () => {
    // The overlap check is a strict `a.end > b.start` — touching (not
    // overlapping) tracks never enter the fade-assignment branch at all, so
    // pre-existing fade values (e.g. left over from before the tracks were
    // moved apart) are not cleared. This mirrors the original inline effect
    // exactly: there is no "un-fade" branch, only "set fade while overlapping".
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 2, fadeOut: 1 }),
          track({ id: 'b', start: 2, end: 4, fadeIn: 1 }),
        ],
      },
    })
    expect(computeAutoCrossfade(p)).toBeNull()
  })

  it('adds fade-out/fade-in on overlapping tracks, sized to the overlap', () => {
    const p = project({
      audio: { tracks: [track({ id: 'a', start: 0, end: 3 }), track({ id: 'b', start: 2, end: 5 })] },
    })
    const next = computeAutoCrossfade(p)
    expect(next).not.toBeNull()
    const tracks = next!.audio!.tracks
    expect(tracks.find(t => t.id === 'a')!.fadeOut).toBe(1)
    expect(tracks.find(t => t.id === 'b')!.fadeIn).toBe(1)
  })

  it('shrinks an existing fade as two still-overlapping tracks are moved further apart', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 3, fadeOut: 2 }),
          track({ id: 'b', start: 2.5, end: 5, fadeIn: 2 }),
        ],
      },
    })
    const next = computeAutoCrossfade(p)
    expect(next).not.toBeNull()
    const tracks = next!.audio!.tracks
    expect(tracks.find(t => t.id === 'a')!.fadeOut).toBe(0.5)
    expect(tracks.find(t => t.id === 'b')!.fadeIn).toBe(0.5)
  })

  it('returns null when existing fades already match the overlap (no-change signal, loop-safe)', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 3, fadeOut: 1 }),
          track({ id: 'b', start: 2, end: 5, fadeIn: 1 }),
        ],
      },
    })
    expect(computeAutoCrossfade(p)).toBeNull()
  })

  it('is idempotent on a non-0.1-multiple overlap — a second pass over its own output is a no-op', () => {
    // Overlap = 0.37s, which rounds to 0.4. The bug this guards: the change
    // check compared the ROUNDED assignment (0.4) against the RAW overlap
    // (0.37), which never match, so `changed` was permanently true for any
    // overlap that wasn't already a multiple of 0.1s — merely opening an
    // already-processed project reported a change (and, via Timeline.tsx's
    // effect, wrote to disk and pushed a no-op undo entry) forever.
    const p = project({
      audio: { tracks: [track({ id: 'a', start: 0, end: 3.37 }), track({ id: 'b', start: 3, end: 6 })] },
    })
    const first = computeAutoCrossfade(p)
    expect(first).not.toBeNull()
    const tracks = first!.audio!.tracks
    expect(tracks.find(t => t.id === 'a')!.fadeOut).toBe(0.4)
    expect(tracks.find(t => t.id === 'b')!.fadeIn).toBe(0.4)

    // Re-running on the already-processed project must be a no-op.
    expect(computeAutoCrossfade(first!)).toBeNull()
  })

  it('ignores overlap when either track is muted', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 3, muted: true }),
          track({ id: 'b', start: 2, end: 5 }),
        ],
      },
    })
    expect(computeAutoCrossfade(p)).toBeNull()
  })

  it('preserves original track order and untouched tracks in the returned project', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'solo', start: 20, end: 22 }),
          track({ id: 'a', start: 0, end: 3 }),
          track({ id: 'b', start: 2, end: 5 }),
        ],
      },
    })
    const next = computeAutoCrossfade(p)
    expect(next).not.toBeNull()
    expect(next!.audio!.tracks.map(t => t.id)).toEqual(['solo', 'a', 'b'])
    expect(next!.audio!.tracks.find(t => t.id === 'solo')!.fadeOut).toBeUndefined()
  })
})

describe('groupAudioLanes', () => {
  it('keeps explicit lanes and sorts ascending', () => {
    const lanes = groupAudioLanes([
      track({ id: 'b', lane: 2 }),
      track({ id: 'a', lane: 0 }),
      track({ id: 'c', lane: 2 }),
    ])
    expect(lanes.map(l => l.laneIndex)).toEqual([0, 2])
    expect(lanes[1].tracks.map(t => t.id)).toEqual(['b', 'c'])
  })

  it('auto-assigns lane-less tracks above the highest explicit lane, in array order', () => {
    const lanes = groupAudioLanes([
      track({ id: 'auto1' }),
      track({ id: 'pinned', lane: 3 }),
      track({ id: 'auto2' }),
    ])
    expect(lanes.map(l => l.laneIndex)).toEqual([3, 4, 5])
    expect(lanes.map(l => l.tracks[0].id)).toEqual(['pinned', 'auto1', 'auto2'])
  })

  it('returns nothing for no tracks', () => {
    expect(groupAudioLanes([])).toEqual([])
  })
})

// ── Track shape ────────────────────────────────────────────────────────────
//
// The load-bearing properties: normalization never mutates its input, is
// idempotent, and returns the SAME OBJECT when the project is already in
// object form (the lazy on-open migration reads that identity as "no write
// needed"). Mirrored case for case by tests/test_project_tracks.py and
// montaj_assets/render/test/project-tracks.test.mjs.

describe('normalizeTracks / trackItems', () => {
  /** Deliberately loose, like the functions themselves: `tracks` is whatever is
   *  on disk, legacy or object shape. */
  type Proj = { id: string; tracks?: unknown }
  interface NormTrack { id: string; items: Array<{ id: string }>; [k: string]: unknown }

  const item = (id: string) => ({ id, type: 'video', src: `${id}.mp4`, start: 0, end: 1 })

  /** The normalized tracks, typed. `normalizeTracks` hands back the caller's own
   *  project type, so the object shape has to be named at the read site. */
  const tracksOf = (p: Proj): NormTrack[] => normalizeTracks(p).tracks as NormTrack[]

  const legacy = (): Proj => ({ id: 'p1', tracks: [[item('a'), item('b')], [item('c')]] })
  const objectShape = (): Proj => ({
    id: 'p1',
    tracks: [
      { id: 'trk-0', items: [item('a'), item('b')] },
      { id: 'trk-1', items: [item('c')] },
    ],
  })

  it('turns the legacy VisualItem[][] shape into the object shape', () => {
    expect(tracksOf(legacy())).toEqual([
      { id: 'trk-0', items: [item('a'), item('b')] },
      { id: 'trk-1', items: [item('c')] },
    ])
  })

  it('carries items over by reference and preserves item + track order', () => {
    const a = item('a'), b = item('b'), c = item('c')
    const out = tracksOf({ id: 'p1', tracks: [[a, b], [c]] })
    expect(out[0].items[0]).toBe(a)
    expect(out[0].items[1]).toBe(b)
    expect(out[1].items[0]).toBe(c)
    expect(out.map(t => t.items.map(i => i.id))).toEqual([['a', 'b'], ['c']])
  })

  it('does not mutate its input, and builds new item arrays', () => {
    const p = legacy()
    const before = structuredClone(p)
    const out = tracksOf(p)
    expect(p).toEqual(before)
    expect(Array.isArray((p.tracks as unknown[])[0])).toBe(true)  // still legacy shape
    out[0].items.push(item('z'))
    expect((p.tracks as unknown[][])[0]).toHaveLength(2)
  })

  it('returns the SAME OBJECT when tracks are already normalized', () => {
    const p = objectShape()
    expect(normalizeTracks(p)).toBe(p)
  })

  it('is idempotent and converges, so a second pass needs no write', () => {
    const once = normalizeTracks(legacy())
    const twice = normalizeTracks(once)
    expect(twice).toEqual(once)
    expect(twice).toBe(once)
  })

  it('leaves a project with no tracks alone and invents no tracks key', () => {
    const missing: Proj = { id: 'p1' }
    expect(normalizeTracks(missing)).toBe(missing)
    expect('tracks' in normalizeTracks(missing)).toBe(false)

    const nulled: Proj = { id: 'p1', tracks: null }
    expect(normalizeTracks(nulled)).toBe(nulled)
    const empty: Proj = { id: 'p1', tracks: [] }
    expect(normalizeTracks(empty)).toBe(empty)
  })

  it('leaves a tracks that is not an array alone rather than throwing', () => {
    for (const bogus of ['nope', 7, { 'trk-0': [] }]) {
      const p: Proj = { id: 'p1', tracks: bogus }
      expect(normalizeTracks(p)).toBe(p)
    }
  })

  it('turns a null/string/number track into an empty track', () => {
    expect(tracksOf({ id: 'p1', tracks: [null, 'nope', 7] })).toEqual([
      { id: 'trk-0', items: [] },
      { id: 'trk-1', items: [] },
      { id: 'trk-2', items: [] },
    ])
  })

  it('coerces a missing, null or non-array items to an empty array', () => {
    expect(tracksOf({
      id: 'p1',
      tracks: [{ id: 'a' }, { id: 'b', items: null }, { id: 'c', items: 'x' }],
    })).toEqual([
      { id: 'a', items: [] },
      { id: 'b', items: [] },
      { id: 'c', items: [] },
    ])
  })

  it('fills in a missing, empty or non-string id', () => {
    const out = tracksOf({
      id: 'p1',
      tracks: [{ items: [item('a')] }, { id: '', items: [] }, { id: 7, items: [] }],
    })
    expect(out.map(t => t.id)).toEqual(['trk-0', 'trk-1', 'trk-2'])
  })

  it('lets the first holder of a duplicate id keep it', () => {
    const out = tracksOf({
      id: 'p1',
      tracks: [{ id: 'dup', items: [] }, { id: 'dup', items: [] }],
    })
    expect(out.map(t => t.id)).toEqual(['dup', 'trk-1'])
  })

  it('steps a generated id aside when an explicit id already claims the name', () => {
    const out = tracksOf({
      id: 'p1',
      tracks: [[item('a')], { id: 'trk-0', items: [item('b')] }],
    })
    expect(out.map(t => t.id)).toEqual(['trk-0-2', 'trk-0'])
  })

  it('keeps generated ids unique under repeated collision', () => {
    const out = tracksOf({
      id: 'p1',
      tracks: [[], { id: 'trk-0', items: [] }, { id: 'trk-0-2', items: [] }],
    })
    expect(out.map(t => t.id)).toEqual(['trk-0-3', 'trk-0', 'trk-0-2'])
    expect(new Set(out.map(t => t.id)).size).toBe(3)
  })

  it('carries volume / muted / enabled and unknown keys through, and adds no defaults', () => {
    const out = tracksOf({
      id: 'p1',
      tracks: [
        { id: 'trk-0', items: [], volume: 0.8, muted: false, enabled: true, somethingNew: { a: 1 } },
        [item('a')],  // forces a rebuild so the object above is copied, not returned as-is
      ],
    })
    expect(out[0]).toEqual({
      id: 'trk-0', items: [], volume: 0.8, muted: false, enabled: true, somethingNew: { a: 1 },
    })
    expect(Object.keys(out[1]).sort()).toEqual(['id', 'items'])
  })

  it('reads items out of either shape', () => {
    expect(trackItems(legacy())).toEqual([[item('a'), item('b')], [item('c')]])
    const p = objectShape()
    expect(trackItems(p)).toEqual([[item('a'), item('b')], [item('c')]])
    expect(trackItems(p)[0]).toBe((p.tracks as NormTrack[])[0].items)
    expect(trackItems(legacy()).flat().map(i => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('reads no items out of a project with no usable tracks', () => {
    const missing: Proj = { id: 'p1' }
    const nulled: Proj = { id: 'p1', tracks: null }
    const empty: Proj = { id: 'p1', tracks: [] }
    const bogus: Proj = { id: 'p1', tracks: 'nope' }
    expect(trackItems(missing)).toEqual([])
    expect(trackItems(nulled)).toEqual([])
    expect(trackItems(empty)).toEqual([])
    expect(trackItems(bogus)).toEqual([])
    expect(trackItems(null)).toEqual([])
    expect(trackItems(undefined)).toEqual([])
  })
})

describe('mapTrackItems', () => {
  type Proj = { id: string; tracks?: unknown }
  const item = (id: string) => ({ id, type: 'video', src: `${id}.mp4`, start: 0, end: 1 }) as unknown as VisualItem

  it('preserves every track\'s id and settings while rewriting its items', () => {
    const p: Proj = {
      id: 'p1',
      tracks: [
        { id: 'trk-a', items: [item('a')], volume: 0.2 },
        { id: 'trk-b', items: [item('b')], muted: true, enabled: false, somethingNew: 1 },
      ],
    }
    expect(mapTrackItems(p, items => items.map(i => ({ ...i, end: 9 })))).toEqual([
      { id: 'trk-a', items: [{ ...item('a'), end: 9 }], volume: 0.2 },
      { id: 'trk-b', items: [{ ...item('b'), end: 9 }], muted: true, enabled: false, somethingNew: 1 },
    ])
  })

  it('preserves track order and passes each track its own index', () => {
    const p: Proj = { id: 'p1', tracks: [[item('a')], [item('b')], [item('c')]] }
    const seen: number[] = []
    const out = mapTrackItems(p, (items, i) => { seen.push(i); return i === 1 ? [] : items })
    expect(seen).toEqual([0, 1, 2])
    expect(out.map(t => t.id)).toEqual(['trk-0', 'trk-1', 'trk-2'])
    expect(out.map(t => t.items.map(i => i.id))).toEqual([['a'], [], ['c']])
  })

  it('keeps a track the callback emptied — pruning is never its business', () => {
    const p: Proj = { id: 'p1', tracks: [[item('a')], [item('b')]] }
    expect(mapTrackItems(p, () => []).map(t => t.items)).toEqual([[], []])
  })

  it('tolerates the legacy shape on input and always returns the object shape', () => {
    const p: Proj = { id: 'p1', tracks: [[item('a'), item('b')], [item('c')]] }
    expect(mapTrackItems(p, items => items.slice(0, 1))).toEqual([
      { id: 'trk-0', items: [item('a')] },
      { id: 'trk-1', items: [item('c')] },
    ])
  })

  it('does not mutate its input', () => {
    const p: Proj = { id: 'p1', tracks: [{ id: 'trk-a', items: [item('a')], volume: 0.2 }] }
    const before = structuredClone(p)
    mapTrackItems(p, () => [item('z')])
    expect(p).toEqual(before)
  })

  it('reads no tracks out of a project with no usable tracks', () => {
    expect(mapTrackItems({ id: 'p1' } as Proj, items => items)).toEqual([])
    expect(mapTrackItems({ id: 'p1', tracks: null } as Proj, items => items)).toEqual([])
    expect(mapTrackItems({ id: 'p1', tracks: 'nope' } as Proj, items => items)).toEqual([])
  })
})
