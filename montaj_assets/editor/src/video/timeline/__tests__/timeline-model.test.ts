import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import type { AudioTrack, VisualItem, VisualTrack } from '../../../schema'
import {
  AUDIO_FALLBACK_SPAN_SECONDS,
  resolveAudioWindow,
  computeAutoCrossfade,
  computeDerivedTiming,
  computeVisualCrossfade,
  groupAudioLanes,
  mapTrackItems,
  normalizeAudioTracks,
  normalizeTrackOrder,
  normalizeTracks,
  trackItems,
  updateAudioTrack,
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

  // Regression test for the sharpest edge of the id-less-audio-track defect.
  // `trackMap = new Map(updated.map(t => [t.id, t]))` keys on `t.id`; with two
  // id-less tracks, both keys are the same `undefined`, so the map collapses
  // to ONE entry (the last one processed) and `audioTracks.map(t =>
  // trackMap.get(t.id) ?? t)` hands that SAME entry back for every original
  // track — every track in the project becomes a byte-identical copy of it,
  // `src` included. This runs unconditionally on any project with two
  // overlapping audio tracks, no user edit required, which is why it's the
  // sharpest edge: it doesn't wait for a gesture like `updateAudioTrack` does.
  it('does not collapse two overlapping id-less audio tracks into copies of each other', () => {
    const p = project({
      audio: {
        tracks: [
          { src: 'music-a.mp3', start: 0, end: 3 } as AudioTrack,
          { src: 'music-b.mp3', start: 2, end: 5 } as AudioTrack,
        ],
      },
    })
    const next = computeAutoCrossfade(p)
    expect(next).not.toBeNull()
    const tracks = next!.audio!.tracks
    expect(tracks).toHaveLength(2)
    expect(new Set(tracks.map(t => t.id)).size).toBe(2)
    // Each track keeps its OWN src — neither becomes a copy of the other.
    expect(tracks.find(t => t.start === 0)!.src).toBe('music-a.mp3')
    expect(tracks.find(t => t.start === 2)!.src).toBe('music-b.mp3')
    expect(tracks.find(t => t.start === 0)!.fadeOut).toBe(1)
    expect(tracks.find(t => t.start === 2)!.fadeIn).toBe(1)
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

describe('resolveAudioWindow', () => {
  it('passes a well-formed window straight through', () => {
    expect(resolveAudioWindow(track({ start: 2, end: 9 }), 30)).toEqual({ start: 2, end: 9 })
  })

  it('defaults a missing start to 0', () => {
    const t = { id: 'a', src: 'a.mp3', end: 9 } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 30).start).toBe(0)
  })

  it('derives a missing end from outPoint minus inPoint', () => {
    const t = { id: 'a', src: 'a.mp3', start: 3, inPoint: 2, outPoint: 12 } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 30)).toEqual({ start: 3, end: 13 })
  })

  it('falls back to sourceDuration when there is no outPoint', () => {
    const t = { id: 'a', src: 'a.mp3', start: 0, sourceDuration: 8 } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 30)).toEqual({ start: 0, end: 8 })
  })

  it('falls back to the project content duration when the source length is unknown', () => {
    const t = { id: 'a', src: 'a.mp3' } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 30)).toEqual({ start: 0, end: 30 })
  })

  it('never returns a zero-width window, even with no content to measure against', () => {
    const t = { id: 'a', src: 'a.mp3' } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 0)).toEqual({ start: 0, end: AUDIO_FALLBACK_SPAN_SECONDS })
  })

  it('survives a poisoned contentDuration', () => {
    // One item with a non-numeric `end` anywhere in the project makes
    // computeDerivedTiming's contentDuration NaN; the bar must still draw.
    const t = { id: 'a', src: 'a.mp3' } as unknown as AudioTrack
    // The exact span is the only value that proves the NaN horizon was
    // REJECTED rather than propagated through Math.max.
    expect(resolveAudioWindow(t, NaN)).toEqual({ start: 0, end: AUDIO_FALLBACK_SPAN_SECONDS })
  })

  it('ignores a stale outPoint that is not past the in-point', () => {
    const t = { id: 'a', src: 'a.mp3', start: 0, outPoint: 0, sourceDuration: 180 } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 30)).toEqual({ start: 0, end: 180 })
  })

  it('treats a zero-width declared window as undeclared', () => {
    // `start: 0, end: 0` is what skills/lyrics-video shipped; it drew an
    // invisible bar for the same reason a missing window did.
    const t = { id: 'a', src: 'a.mp3', start: 0, end: 0 } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 30)).toEqual({ start: 0, end: 30 })
  })

  it('treats an inverted declared window as undeclared', () => {
    const t = { id: 'a', src: 'a.mp3', start: 10, end: 4 } as unknown as AudioTrack
    // `start` must survive: zeroing it would jump the bar to the timeline head.
    expect(resolveAudioWindow(t, 30)).toEqual({ start: 10, end: 30 })
  })

  it('treats NaN the same as absent', () => {
    const t = { id: 'a', src: 'a.mp3', start: NaN, end: NaN, sourceDuration: 4 } as unknown as AudioTrack
    expect(resolveAudioWindow(t, 30)).toEqual({ start: 0, end: 4 })
  })
})

describe('groupAudioLanes — window resolution', () => {
  it('returns the SAME object for a well-formed track (no-regression guarantee)', () => {
    const t = track({ id: 'ok', start: 0, end: 5 })
    const [lane] = groupAudioLanes([t], 30)
    expect(lane.tracks[0]).toBe(t)
  })

  it('returns a resolved copy for a track missing its end', () => {
    const t = { id: 'bed', src: 'a.mp3', start: 0 } as unknown as AudioTrack
    const [lane] = groupAudioLanes([t], 30)
    expect(lane.tracks[0]).not.toBe(t)
    expect(lane.tracks[0].end).toBe(30)
    expect(lane.tracks[0].id).toBe('bed')
    expect(t.end).toBeUndefined()   // the caller's project is never mutated
  })

  it('still groups by lane exactly as before', () => {
    const a = { id: 'a', src: 'a.mp3', lane: 2 } as unknown as AudioTrack
    const b = track({ id: 'b', lane: 0 })
    expect(groupAudioLanes([a, b], 30).map(l => l.laneIndex)).toEqual([0, 2])
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
        // Overlay-typed, not `item('a')`'s default video — both tracks stay
        // in the SAME group (empty and overlay both group as overlay), so
        // normalizeTracks' order-canonicalization doesn't move this one past
        // index 0 and this test can stay about shape-normalization alone.
        [{ id: 'a', type: 'overlay', start: 0, end: 1 }],  // forces a rebuild so the object above is copied, not returned as-is
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

// ── Track group ordering ────────────────────────────────────────────────
//
// The canonical stack: every video track first (in existing relative
// order), then every overlay track (in existing relative order). Identity
// preservation on an already-canonical project is load-bearing — see the
// function's own doc comment — so it gets its own `toBe` assertion here,
// not folded into a looser `toEqual` check.

describe('normalizeTrackOrder', () => {
  const videoItem = (id: string): VisualItem => ({ id, type: 'video', src: `${id}.mp4`, start: 0, end: 1 } as VisualItem)
  const overlayItem = (id: string): VisualItem => ({ id, type: 'overlay', start: 0, end: 1 } as unknown as VisualItem)
  const videoTrack = (id: string): VisualTrack => ({ id, items: [videoItem(`${id}-i`)] })
  const overlayTrack = (id: string): VisualTrack => ({ id, items: [overlayItem(`${id}-i`)] })
  const emptyTrack = (id: string): VisualTrack => ({ id, items: [] })
  const tracksOf = (p: Project): VisualTrack[] => normalizeTrackOrder(p).tracks as VisualTrack[]

  it('stably partitions [video, overlay, video] into [video, video, overlay]', () => {
    const v0 = videoTrack('v0')
    const o0 = overlayTrack('o0')
    const v1 = videoTrack('v1')
    const out = tracksOf(project({ tracks: [v0, o0, v1] } as unknown as Partial<Project>))
    expect(out.map(t => t.id)).toEqual(['v0', 'v1', 'o0'])
    // Stable: v0 still precedes v1 (their original relative order), and
    // every track survives BY REFERENCE — only the array's order changes.
    expect(out[0]).toBe(v0)
    expect(out[1]).toBe(v1)
    expect(out[2]).toBe(o0)
  })

  it('returns the SAME project object when tracks are already canonical', () => {
    const p = project({ tracks: [videoTrack('v0'), videoTrack('v1'), overlayTrack('o0')] } as unknown as Partial<Project>)
    expect(normalizeTrackOrder(p)).toBe(p)
  })

  it('base video (index 0) always stays first', () => {
    const base = videoTrack('base')
    const out = tracksOf(project({ tracks: [base, overlayTrack('o0'), videoTrack('v1')] } as unknown as Partial<Project>))
    expect(out[0]).toBe(base)
  })

  it('leaves an overlay-only project untouched (already canonical, no video group at all)', () => {
    const p = project({ tracks: [overlayTrack('o0'), overlayTrack('o1')] } as unknown as Partial<Project>)
    expect(normalizeTrackOrder(p)).toBe(p)
  })

  it('groups an empty track as overlay', () => {
    const v0 = videoTrack('v0')
    const out = tracksOf(project({ tracks: [emptyTrack('e0'), v0] } as unknown as Partial<Project>))
    expect(out.map(t => t.id)).toEqual(['v0', 'e0'])
  })

  it('groups a track with even one video item as video, mixed with overlay items or not', () => {
    const mixed: VisualTrack = { id: 'mixed', items: [overlayItem('a'), videoItem('b')] }
    const out = tracksOf(project({ tracks: [overlayTrack('o0'), mixed] } as unknown as Partial<Project>))
    expect(out.map(t => t.id)).toEqual(['mixed', 'o0'])
  })

  it('is a no-op for a project with no tracks, or an empty tracks array', () => {
    const noTracks = project({})
    expect(normalizeTrackOrder(noTracks)).toBe(noTracks)
    const emptyTracks = project({ tracks: [] })
    expect(normalizeTrackOrder(emptyTracks)).toBe(emptyTracks)
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

// ── Audio track id policy ────────────────────────────────────────────────
//
// Same load-bearing properties as `normalizeTracks` above: normalization
// never mutates its input, is idempotent, and returns the SAME OBJECT when
// every audio track already has a usable id (the lazy on-open migration
// reads that identity as "no write needed").

describe('normalizeAudioTracks', () => {
  /** Deliberately loose, like the function itself. */
  type Proj = { id: string; audio?: unknown }
  interface NormTrack { id: string; src: string; [k: string]: unknown }

  const raw = (id: unknown, src: string, extra: Record<string, unknown> = {}) =>
    (id === undefined ? { src, ...extra } : { id, src, ...extra })

  /** The normalized audio tracks, typed. */
  const tracksOf = (p: Proj): NormTrack[] => (normalizeAudioTracks(p).audio as { tracks: NormTrack[] }).tracks

  it('fills in distinct ids for tracks with no id at all', () => {
    const out = tracksOf({ id: 'p1', audio: { tracks: [raw(undefined, 'a.mp3'), raw(undefined, 'b.mp3')] } })
    expect(out.map(t => t.id)).toEqual(['aud-0', 'aud-1'])
    expect(new Set(out.map(t => t.id)).size).toBe(2)
  })

  it('fills in a missing, empty, or non-string id', () => {
    const out = tracksOf({
      id: 'p1',
      audio: { tracks: [raw(undefined, 'a.mp3'), raw('', 'b.mp3'), raw(7, 'c.mp3')] },
    })
    expect(out.map(t => t.id)).toEqual(['aud-0', 'aud-1', 'aud-2'])
  })

  it('lets the first holder of a duplicate id keep it', () => {
    const out = tracksOf({
      id: 'p1',
      audio: { tracks: [raw('dup', 'a.mp3'), raw('dup', 'b.mp3')] },
    })
    expect(out.map(t => t.id)).toEqual(['dup', 'aud-1'])
    // The first holder keeps ITS OWN src, not the second track's.
    expect(out[0].src).toBe('a.mp3')
    expect(out[1].src).toBe('b.mp3')
  })

  it('steps a generated id aside when an explicit id already claims the name', () => {
    const out = tracksOf({
      id: 'p1',
      audio: { tracks: [raw(undefined, 'a.mp3'), raw('aud-0', 'b.mp3')] },
    })
    expect(out.map(t => t.id)).toEqual(['aud-0-2', 'aud-0'])
  })

  it('keeps generated ids unique under repeated collision', () => {
    const out = tracksOf({
      id: 'p1',
      audio: { tracks: [raw(undefined, 'a.mp3'), raw('aud-0', 'b.mp3'), raw('aud-0-2', 'c.mp3')] },
    })
    expect(out.map(t => t.id)).toEqual(['aud-0-3', 'aud-0', 'aud-0-2'])
    expect(new Set(out.map(t => t.id)).size).toBe(3)
  })

  it('preserves existing valid ids (e.g. init.py-style `vo-01`) untouched', () => {
    const p: Proj = { id: 'p1', audio: { tracks: [raw('vo-01', 'voice.wav'), raw('music-bed', 'bed.mp3')] } }
    expect(normalizeAudioTracks(p)).toBe(p)
  })

  it('returns the SAME OBJECT when every track already has a usable id', () => {
    const p: Proj = { id: 'p1', audio: { tracks: [raw('aud-0', 'a.mp3'), raw('aud-1', 'b.mp3')] } }
    expect(normalizeAudioTracks(p)).toBe(p)
  })

  it('is idempotent and converges, so a second pass needs no write', () => {
    const once = normalizeAudioTracks({ id: 'p1', audio: { tracks: [raw(undefined, 'a.mp3'), raw(undefined, 'b.mp3')] } })
    const twice = normalizeAudioTracks(once)
    expect(twice).toBe(once)
  })

  it('carries volume / muted / fadeIn / ducking and unknown keys through untouched', () => {
    const out = tracksOf({
      id: 'p1',
      audio: {
        tracks: [raw(undefined, 'a.mp3', {
          volume: 0.15, muted: true, fadeIn: 1.5, ducking: { enabled: true, depth: -12 }, somethingNew: { a: 1 },
        })],
      },
    })
    expect(out[0]).toEqual({
      id: 'aud-0', src: 'a.mp3', volume: 0.15, muted: true, fadeIn: 1.5,
      ducking: { enabled: true, depth: -12 }, somethingNew: { a: 1 },
    })
  })

  it('does not mutate its input', () => {
    const p: Proj = { id: 'p1', audio: { tracks: [raw(undefined, 'a.mp3')] } }
    const before = structuredClone(p)
    tracksOf(p)
    expect(p).toEqual(before)
  })

  it('is tolerant of a project with no audio, or a malformed audio/tracks, and never throws', () => {
    const missing: Proj = { id: 'p1' }
    expect(normalizeAudioTracks(missing)).toBe(missing)
    expect('audio' in normalizeAudioTracks(missing)).toBe(false)

    for (const audio of [null, 'nope', 7, []]) {
      const p: Proj = { id: 'p1', audio }
      expect(() => normalizeAudioTracks(p)).not.toThrow()
      expect(normalizeAudioTracks(p)).toBe(p)
    }

    for (const tracks of [undefined, null, 'nope', {}]) {
      const p: Proj = { id: 'p1', audio: { tracks } }
      expect(() => normalizeAudioTracks(p)).not.toThrow()
      expect(normalizeAudioTracks(p)).toBe(p)
    }

    const empty: Proj = { id: 'p1', audio: { tracks: [] } }
    expect(normalizeAudioTracks(empty)).toBe(empty)
  })
})

describe('updateAudioTrack', () => {
  it('patches only the matching track when ids are already real', () => {
    const p = project({
      audio: { tracks: [track({ id: 'a', src: 'a.mp3', volume: 1 }), track({ id: 'b', src: 'b.mp3', volume: 1 })] },
    })
    const out = updateAudioTrack(p, 'a', { volume: 0.4 })
    expect(out.audio?.tracks.find(t => t.id === 'a')?.volume).toBe(0.4)
    expect(out.audio?.tracks.find(t => t.id === 'b')).toEqual(track({ id: 'b', src: 'b.mp3', volume: 1 }))
  })

  // Regression test for the actual defect: `docs/schemas/project.md` never
  // required `id` on an audio track, but every editor mutation (this
  // function included) used to key a track by `id` with `===`. Two id-less
  // tracks both read `id` as the same `undefined`, so `t.id === trackId`
  // matched BOTH of them at once — dragging one fade handle on a 2-track
  // music bed fanned the edit out and clobbered the sibling. Reproduced here
  // exactly as the live app hits it: the ids passed in are the ones
  // `normalizeAudioTracks` (VideoEditor's on-open backfill) would hand out —
  // `aud-0`/`aud-1` — but `updateAudioTrack` itself is called with the
  // ORIGINAL, still id-less project, proving it is safe even when a caller
  // hasn't normalized first.
  it('edits exactly one id-less audio track, leaving its sibling byte-for-byte untouched', () => {
    const original: Project = project({
      audio: {
        tracks: [
          { src: 'music-a.mp3', start: 0, end: 10, volume: 1 } as AudioTrack,
          { src: 'music-b.mp3', start: 10, end: 20, volume: 1 } as AudioTrack,
        ],
      },
    })
    const untouchedSibling = original.audio!.tracks[1]
    const targetId = normalizeAudioTracks(original).audio!.tracks[0].id

    const out = updateAudioTrack(original, targetId, { volume: 0.4 })

    expect(out.audio?.tracks).toHaveLength(2)
    expect(out.audio?.tracks[0].volume).toBe(0.4)
    expect(out.audio?.tracks[0].src).toBe('music-a.mp3')
    // The defect this guards against: the sibling's `src` (and every other
    // field) must be exactly what it started as — not silently fanned into
    // the edited track's values.
    expect(out.audio?.tracks[1]).toEqual({ ...untouchedSibling, id: out.audio?.tracks[1].id })
    expect(out.audio?.tracks[1].src).toBe('music-b.mp3')
    expect(out.audio?.tracks[1].volume).toBe(1)
  })
})

// ── Visual crossfade (overlays) ──────────────────────────────────────────

/** An overlay item. `extra` carries whatever the case under test needs —
 *  `opaque`, a hand-authored `keyframes` array — without a helper per shape. */
const ov = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'overlay' as const, src: 'Card.jsx', start, end, ...extra })

/** Two-track project in the OBJECT form: `tracks[0]` is the (empty) primary
 *  footage row `computeVisualCrossfade` skips wholesale, `tracks[1]` is the
 *  overlay row under test. */
const proj = (items: unknown[]) => ({
  version: '0.2',
  tracks: [{ id: 'trk-0', items: [] }, { id: 'trk-1', items }],
}) as never

const opacityTrack = (p: Project, trackIdx: number, itemIdx: number) =>
  (p as unknown as { tracks: { items: { keyframes?: { prop: string; points: unknown[] }[] }[] }[] })
    .tracks[trackIdx].items[itemIdx].keyframes?.find(k => k.prop === 'opacity')

describe('computeVisualCrossfade', () => {
  it('writes complementary opacity curves onto a transparent overlapping pair', () => {
    const out = computeVisualCrossfade(proj([ov('a', 0, 4), ov('b', 3, 8)]))!
    expect(out).not.toBeNull()
    // 'a' fades 1 -> 0 over its LAST second (item-relative t = 3 .. 4)
    expect(opacityTrack(out, 1, 0)!.points).toEqual([
      { t: 3, value: 1 }, { t: 4, value: 0 },
    ])
    // 'b' fades 0 -> 1 over its FIRST second (item-relative t = 0 .. 1)
    expect(opacityTrack(out, 1, 1)!.points).toEqual([
      { t: 0, value: 0 }, { t: 1, value: 1 },
    ])
  })

  it('holds the outgoing side when it is opaque', () => {
    const out = computeVisualCrossfade(
      proj([ov('a', 0, 4, { opaque: true }), ov('b', 3, 8, { opaque: true })]),
    )!
    expect(opacityTrack(out, 1, 0)).toBeUndefined()          // 'a' holds — no track written
    expect(opacityTrack(out, 1, 1)!.points).toEqual([
      { t: 0, value: 0 }, { t: 1, value: 1 },
    ])
  })

  it('is idempotent — a converged project reports no change', () => {
    const once = computeVisualCrossfade(proj([ov('a', 0, 4), ov('b', 3, 8)]))!
    expect(computeVisualCrossfade(once as never)).toBeNull()
  })

  it('returns null when nothing overlaps', () => {
    expect(computeVisualCrossfade(proj([ov('a', 0, 4), ov('b', 4, 8)]))).toBeNull()
  })

  it('never touches an item whose opacity was keyframed by hand', () => {
    const authored = ov('b', 3, 8, {
      keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0.5 }] }],
    })
    expect(computeVisualCrossfade(proj([ov('a', 0, 4), authored]))).toBeNull()
  })

  it('leaves clips alone — a video pair gets no keyframes', () => {
    const clip = (id: string, s: number, e: number) =>
      ({ id, type: 'video' as const, src: 'a.mov', start: s, end: e, inPoint: 0, outPoint: e - s })
    expect(computeVisualCrossfade(proj([clip('a', 0, 4), clip('b', 3, 8)]))).toBeNull()
  })

  it('preserves a non-opacity keyframe track already on the item', () => {
    const moving = ov('b', 3, 8, {
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: -20 }, { t: 1, value: 0 }] }],
    })
    const out = computeVisualCrossfade(proj([ov('a', 0, 4), moving]))!
    const kf = (out as unknown as { tracks: { items: { keyframes: { prop: string }[] }[] }[] })
      .tracks[1].items[1].keyframes
    expect(kf.map(k => k.prop).sort()).toEqual(['offsetX', 'opacity'])
  })

  it('scales the derived curve by each side\'s own base opacity', () => {
    // Both sides authored at 0.5 opacity (not via a keyframe track — that
    // would be "hand-authored" and skip derivation entirely per the test
    // above). The derived fade must ride on top of that base level, not
    // silently replace it with a full 1<->0 fade for the pair's whole
    // pre/post-overlap life.
    const out = computeVisualCrossfade(
      proj([ov('a', 0, 4, { opacity: 0.5 }), ov('b', 3, 8, { opacity: 0.5 })]),
    )!
    expect(out).not.toBeNull()
    // 'a' fades 0.5 -> 0 over its LAST second
    expect(opacityTrack(out, 1, 0)!.points).toEqual([
      { t: 3, value: 0.5 }, { t: 4, value: 0 },
    ])
    // 'b' fades 0 -> 0.5 over its FIRST second
    expect(opacityTrack(out, 1, 1)!.points).toEqual([
      { t: 0, value: 0 }, { t: 1, value: 0.5 },
    ])
  })

  it('removes a derived curve when the overlap is removed', () => {
    const faded = computeVisualCrossfade(proj([ov('a', 0, 4), ov('b', 3, 8)]))!
    const pulled = structuredClone(faded) as unknown as
      { tracks: { items: { start: number; end: number }[] }[] }
    pulled.tracks[1].items[1].start = 4
    const out = computeVisualCrossfade(pulled as never)!
    expect(out).not.toBeNull()
    expect(opacityTrack(out, 1, 0)).toBeUndefined()
    expect(opacityTrack(out, 1, 1)).toBeUndefined()
  })
})
