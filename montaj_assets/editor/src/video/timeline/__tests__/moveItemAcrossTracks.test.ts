/// <reference types="vitest/globals" />
/**
 * SP5 T5 — the cross-track placement search, extracted out of VisualTrackRow so
 * the canvas pointer machine lands a dragged clip on the same track the DOM
 * rows would. VisualTrackRow now calls this function, so its behaviour is the
 * DOM path's behaviour by construction rather than by copy.
 *
 * One vertical track step is 24px (VISUAL_ROW_HEIGHT_PX) and DOWNWARD travel
 * LOWERS the index, because track 0 is the base video track at the bottom of
 * the stack.
 *
 * Tracks are `VisualTrack` OBJECTS. Most tests here only care about which items
 * end up on which track, so they build fixtures through `stack()` and read
 * results through `ids()`; the settings-preservation suite at the bottom is the
 * one that looks at the track objects themselves.
 */
import { describe, it, expect } from 'vitest'
import type { VisualItem, VisualTrack } from '../../../schema'
import { moveItemAcrossTracks } from '../timeline-model'

const clip = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'video', src: `${id}.mp4`, start, end }) as VisualItem

/** An overlay-kind item — everything below cares only about `type`, which is
 *  the whole axis the kind-lock tests are about. */
const overlay = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'overlay', start, end }) as VisualItem

const dragged = clip('d', 0, 10)

/** Tracks from bare item arrays, ids matching what the normalizer would give. */
function stack(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

function ids(tracks: VisualTrack[]): string[][] {
  return tracks.map(t => t.items.map(i => i.id))
}

describe('moveItemAcrossTracks — vertical mapping', () => {
  it('keeps the item on its own track when the drag is horizontal', () => {
    const moved = moveItemAcrossTracks({ tracks: stack([dragged], []), item: dragged, start: 2, end: 12, sourceTrackIdx: 0, dy: 0 })
    expect(ids(moved)).toEqual([['d']])
    expect(moved[0].items[0]).toMatchObject({ start: 2, end: 12 })
  })

  it('sends the item UP a track for upward travel', () => {
    const moved = moveItemAcrossTracks({ tracks: stack([dragged], []), item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -24 })
    expect(ids(moved)).toEqual([['d']])   // track 0 emptied and pruned
  })

  it('needs half a step (12px) of travel to change track', () => {
    // Rounding means 11px is still the same track, 13px is the next one. The
    // second track is occupied by a clip far enough away not to block.
    const stacked = () => stack([dragged], [clip('x', 50, 60)])
    expect(ids(moveItemAcrossTracks({ tracks: stacked(), item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -11 })))
      .toEqual([['d'], ['x']])
    expect(ids(moveItemAcrossTracks({ tracks: stacked(), item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -13 })))
      .toEqual([['x', 'd']])
  })

  it('never goes below track 0', () => {
    const moved = moveItemAcrossTracks({ tracks: stack([clip('a', 20, 30)], [dragged]), item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 500 })
    expect(ids(moved)).toEqual([['a', 'd']])
  })
})

describe('moveItemAcrossTracks — collision avoidance', () => {
  it('rejects a target track where it would overlap by more than 30% of itself', () => {
    // The dragged clip is 10s, so more than 3s of overlap is a collision.
    const tracks = stack([clip('blocker', 5, 20)], [dragged])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24 })
    expect(ids(moved)).toEqual([['blocker'], ['d']])
  })

  it('accepts a brush past a neighbour', () => {
    // Only 2s of overlap — inside the 3s tolerance.
    const tracks = stack([clip('blocker', 8, 20)], [dragged])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24 })
    expect(ids(moved)).toEqual([['blocker', 'd']])
  })

  it('searches outward from the target, taking the first free track', () => {
    // Target is track 1; it collides, so the search tries 0 then 2.
    const tracks = stack([clip('lo', 0, 10)], [clip('mid', 0, 10)], [], [dragged])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 3, dy: 48 })
    expect(ids(moved)).toEqual([['lo'], ['mid'], ['d']])
  })

  it('creates a new track above the stack when the drag points past the top', () => {
    const tracks = stack([dragged, clip('stay', 50, 60)])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -24 })
    expect(ids(moved)).toEqual([['stay'], ['d']])
  })

  it('ignores the dragged item when testing its own track for collisions', () => {
    const tracks = stack([dragged, clip('far', 50, 60)])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 1, end: 11, sourceTrackIdx: 0, dy: 0 })
    expect(ids(moved)).toEqual([['far', 'd']])
  })
})

// ── Kind lock: a video item and an overlay/image item are different worlds —
// an overlay composites on top of the video underneath it, it doesn't splice
// into that track's timeline. Neither kind may cross onto the other's track,
// even when there'd be no time-overlap. (This is only the "can't cross
// kinds" half; the fuller "video tracks form their own block below
// overlays" reorganization is separate follow-up work.)

describe('moveItemAcrossTracks — kind lock (video vs overlay)', () => {
  it('does not let a video item land on an overlay track — skips it for a same-kind track', () => {
    const videoDragged = clip('d', 0, 10)
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [videoDragged, clip('stay', 50, 60)] },
      { id: 'trk-1', items: [overlay('ov', 50, 60)] },
    ]
    // One step up from track 0 targets track 1 — the overlay track. There is
    // no time-overlap with `ov`, so the OLD (kind-blind) search would have
    // placed the video item there; it must instead fall back to its own
    // (video) track.
    const moved = moveItemAcrossTracks({ tracks, item: videoDragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -24 })
    expect(ids(moved)).toEqual([['stay', 'd'], ['ov']])
  })

  it('does not let an overlay item land on a video track — skips it for a same-kind track', () => {
    const ovDragged = overlay('d', 0, 10)
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [clip('vid', 50, 60)] },
      { id: 'trk-1', items: [ovDragged, overlay('stay', 50, 60)] },
    ]
    // One step down from track 1 targets track 0 — the video track. Again no
    // time-overlap, so only the kind gate keeps the overlay item off it.
    const moved = moveItemAcrossTracks({ tracks, item: ovDragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24 })
    expect(ids(moved)).toEqual([['vid'], ['stay', 'd']])
  })

  it('still mints a new track past the top when every same-kind track is blocked', () => {
    // Track 1 is overlay-kind (wrong kind, even though there's no
    // time-overlap with `ov`); track 0 is video-kind but occupied by an
    // overlapping clip (wrong reason, but still blocked). Neither works, so
    // the search must mint a new (video) track above the stack.
    const videoDragged = clip('d', 0, 10)
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [videoDragged, clip('blocker', 2, 8)] },
      { id: 'trk-1', items: [overlay('ov', 50, 60)] },
    ]
    const moved = moveItemAcrossTracks({ tracks, item: videoDragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -24 })
    expect(ids(moved)).toEqual([['blocker'], ['ov'], ['d']])
  })
})

describe('moveItemAcrossTracks — bookkeeping', () => {
  it('carries the item\'s other props through untouched', () => {
    const rich = { ...dragged, inPoint: 3, outPoint: 13, muted: true } as VisualItem
    const moved = moveItemAcrossTracks({ tracks: stack([rich]), item: rich, start: 5, end: 15, sourceTrackIdx: 0, dy: 0 })
    expect(moved[0].items[0]).toMatchObject({ inPoint: 3, outPoint: 13, muted: true, start: 5, end: 15 })
  })

  it('prunes tracks the move left empty', () => {
    const tracks = stack([clip('a', 0, 10)], [dragged])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 20, end: 30, sourceTrackIdx: 1, dy: 24 })
    expect(ids(moved)).toEqual([['a', 'd']])
  })

  it('does not mutate the tracks it was given', () => {
    const tracks = stack([clip('a', 0, 10)], [dragged])
    const before = JSON.stringify(tracks)
    moveItemAcrossTracks({ tracks, item: dragged, start: 20, end: 30, sourceTrackIdx: 1, dy: 24 })
    expect(JSON.stringify(tracks)).toBe(before)
  })

  it('gives a newly minted top track an id that collides with nothing', () => {
    // `trk-2` is deliberately squatting on the id the index rule would hand out
    // for the new track, so the normalizer's dedupe suffix has to kick in.
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [dragged, clip('stay', 50, 60)] },
      { id: 'trk-2', items: [clip('b', 50, 60)] },
    ]
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -240 })
    expect(moved.map(t => t.id)).toEqual(['trk-0', 'trk-2', 'trk-2-2'])
    expect(ids(moved)).toEqual([['stay'], ['b'], ['d']])
  })
})

// ── The reason tracks became objects ─────────────────────────────────────────
//
// This is the bug the whole shape change exists to make impossible. Track
// settings used to have nowhere to live but a second array indexed alongside
// `tracks`. The prune below deletes a track from the MIDDLE of the stack, so
// every index above it shifts down by one — and a parallel array, which has no
// idea a prune happened, keeps handing out settings by the OLD index. The
// result is silent: no error, no crash, the timeline just quietly plays a
// different track at the wrong volume.
//
// Settings that live ON the track object travel with the track through the
// filter, so there is no index to get out of step. Both tests below would fail
// against a parallel-array implementation.

describe('moveItemAcrossTracks — settings survive the prune', () => {
  /** Three tracks, each with settings only IT should ever carry. */
  function settled(soloItem: VisualItem): VisualTrack[] {
    return [
      { id: 'trk-a', items: [clip('a', 0, 10)], volume: 0.2 },
      { id: 'trk-b', items: [soloItem], volume: 0.5 },
      { id: 'trk-c', items: [clip('c', 0, 10)], muted: true },
    ]
  }

  it('does not shift a pruned middle track\'s settings onto the track above it', () => {
    const solo = clip('solo', 40, 50)
    // Downward travel lowers the index, so trk-b's ONLY item lands on trk-a and
    // trk-b is pruned. trk-c moves from index 2 to index 1.
    const moved = moveItemAcrossTracks({
      tracks: settled(solo), item: solo, start: 40, end: 50, sourceTrackIdx: 1, dy: 24,
    })

    expect(ids(moved)).toEqual([['a', 'solo'], ['c']])
    expect(moved.map(t => t.id)).toEqual(['trk-a', 'trk-c'])
    // Each survivor still carries ITS OWN settings, not the ones its new index
    // used to point at.
    expect(moved[0]).toMatchObject({ id: 'trk-a', volume: 0.2 })
    expect(moved[0].muted).toBeUndefined()
    expect(moved[1]).toMatchObject({ id: 'trk-c', muted: true })
    expect(moved[1].volume).toBeUndefined()   // trk-b's 0.5 did not follow the index down
  })

  it('keeps settings intact when the prune also mints a new top track', () => {
    const solo = clip('solo', 40, 50)
    // Two steps up from track 1 is index 3, one past the end — a new track.
    const moved = moveItemAcrossTracks({
      tracks: settled(solo), item: solo, start: 40, end: 50, sourceTrackIdx: 1, dy: -48,
    })

    expect(ids(moved)).toEqual([['a'], ['c'], ['solo']])
    expect(moved.map(t => t.id)).toEqual(['trk-a', 'trk-c', 'trk-3'])
    expect(moved.map(t => [t.volume, t.muted])).toEqual([
      [0.2, undefined],
      [undefined, true],
      [undefined, undefined],   // a fresh track carries no settings at all
    ])
  })
})
