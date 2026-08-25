/// <reference types="vitest/globals" />
/**
 * SP5 T5 — the cross-track placement search, extracted out of VisualTrackRow so
 * the canvas pointer machine lands a dragged clip on the same track the DOM
 * rows would have. VisualTrackRow and its DOM control arm are retired, so this
 * file is now the only coverage for this placement search.
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
    // the search must mint a new (video) track above the stack. The result
    // is then re-grouped into the canonical video-block/overlay-block stack
    // (see `normalizeTrackOrder`), so the minted video track lands ahead of
    // the overlay track in the final order, not merely "above" it positionally.
    const videoDragged = clip('d', 0, 10)
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [videoDragged, clip('blocker', 2, 8)] },
      { id: 'trk-1', items: [overlay('ov', 50, 60)] },
    ]
    const moved = moveItemAcrossTracks({ tracks, item: videoDragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -24 })
    expect(ids(moved)).toEqual([['blocker'], ['d'], ['ov']])
  })
})

// ── Ripple-insert (`makeSpace`, magnet/ripple mode ON) ──────────────────
//
// Everything above exercises the DEFAULT (`makeSpace` omitted, i.e. magnet
// off) path and must keep passing byte-for-byte — that is the whole contract
// of the flag being optional. These tests are the ON path: a colliding
// target track stops being disqualifying and instead gets pushed open to fit
// the dropped item, CapCut-style.

describe('moveItemAcrossTracks — ripple-insert (makeSpace: true)', () => {
  it('ripple-inserts on the target track instead of fanning out when it collides', () => {
    // Same fixture as "rejects a target track where it would overlap by more
    // than 30% of itself" above (which asserts the magnet-OFF fallback lands
    // `d` back on its own track). With makeSpace on, the target (track 0, the
    // base track) is no longer disqualified by the collision — `blocker`
    // shifts right by `d`'s own duration (10s) instead.
    const tracks = stack([clip('blocker', 5, 20)], [dragged])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24, makeSpace: true })
    expect(ids(moved)).toEqual([['blocker', 'd']])
    expect(moved[0].items[0]).toMatchObject({ id: 'blocker', start: 15, end: 30 })
    expect(moved[0].items[1]).toMatchObject({ id: 'd', start: 0, end: 10 })
  })

  it('only pushes items starting at or after the drop point, leaving earlier items alone', () => {
    const tracks = stack([clip('early', 0, 3), clip('blocker', 5, 20)], [dragged])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 4, end: 14, sourceTrackIdx: 1, dy: 24, makeSpace: true })
    expect(ids(moved)).toEqual([['early', 'blocker', 'd']])
    expect(moved[0].items[0]).toMatchObject({ id: 'early', start: 0, end: 3 })        // untouched — starts before the drop point
    expect(moved[0].items[1]).toMatchObject({ id: 'blocker', start: 15, end: 30 })    // pushed right by 10s
    expect(moved[0].items[2]).toMatchObject({ id: 'd', start: 4, end: 14 })
  })

  it('drops into a genuine gap unchanged — nothing to push', () => {
    const tracks = stack([clip('far', 50, 60)], [dragged])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24, makeSpace: true })
    expect(ids(moved)).toEqual([['far', 'd']])
    expect(moved[0].items[0]).toMatchObject({ id: 'far', start: 50, end: 60 })
  })

  it('does not push the dragged item against itself when it collides on its own track', () => {
    // A same-track re-drop (dy: 0) that overlaps a later neighbour on the
    // SAME track it started on — the dragged item is excluded from its own
    // track before the push, so it can never end up shifting itself.
    const tracks = stack([dragged, clip('x', 12, 20)])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 10, end: 20, sourceTrackIdx: 0, dy: 0, makeSpace: true })
    expect(ids(moved)).toEqual([['x', 'd']])
    expect(moved[0].items[0]).toMatchObject({ id: 'x', start: 22, end: 30 })
    expect(moved[0].items[1]).toMatchObject({ id: 'd', start: 10, end: 20 })
  })

  it('keeps the kind-lock even with makeSpace on — a video item never ripple-inserts onto an overlay track', () => {
    const videoDragged = clip('d', 0, 10)
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [overlay('ov', 0, 20)] },
      { id: 'trk-1', items: [videoDragged] },
    ]
    // One step down targets track 0 — overlay-kind, so the kind gate refuses
    // it regardless of `makeSpace`; the item falls back to its own (now
    // empty) track rather than ripple-inserting into the overlay. The result
    // is then re-grouped into the canonical video-block/overlay-block stack
    // (`normalizeTrackOrder`), which is why the video track leads even though
    // it was positionally second.
    const moved = moveItemAcrossTracks({ tracks, item: videoDragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24, makeSpace: true })
    expect(ids(moved)).toEqual([['d'], ['ov']])
    expect(moved[1].items[0]).toMatchObject({ id: 'ov', start: 0, end: 20 })  // untouched — no ripple happened
  })

  it('still mints a new track when every existing track is kind-blocked, even with makeSpace on', () => {
    // Both existing tracks are overlay-kind from the dragged item's point of
    // view (track 1 mixes the dragged video item with an overlay — an
    // unusual shape, but one the kind gate has to cope with either way), so
    // there is no kind-ok candidate anywhere in the array — only past its
    // end, same as the magnet-off "mint" case.
    const videoDragged = clip('d', 0, 10)
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [overlay('ov0', 0, 5)] },
      { id: 'trk-1', items: [videoDragged, overlay('ov1', 50, 60)] },
    ]
    const moved = moveItemAcrossTracks({ tracks, item: videoDragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 0, makeSpace: true })
    expect(ids(moved)).toEqual([['d'], ['ov0'], ['ov1']])
  })
})

// ── Track grouping (Part B): the result is ALWAYS canonical ─────────────
//
// `moveItemAcrossTracks` re-groups its own output into the video-block/
// overlay-block stack (`normalizeTrackOrder`) before returning, so every
// mid-drag frame is already canonical rather than relying on a later pass to
// fix it up.

const trackKind = (t: VisualTrack): 'video' | 'overlay' =>
  t.items.some(i => i.type === 'video') ? 'video' : 'overlay'

describe('moveItemAcrossTracks — result is canonically grouped', () => {
  it('a newly-minted video track (past the top of the stack, over an overlay track) lands in the video block, not stranded above the overlay', () => {
    // trk-0 is fully occupied by an overlapping blocker (can't share), and
    // trk-1 is overlay-kind (kind-lock rules it out too) — the search mints
    // a new track two steps up. Before Part B that new track would simply
    // sit "on top" (index 2, above the overlay track); the re-group now
    // moves it back down into the video block, ahead of the overlay track.
    const videoDragged = clip('d', 0, 10)
    const tracks: VisualTrack[] = [
      { id: 'trk-0', items: [videoDragged, clip('blocker', 0, 10)] },
      { id: 'trk-1', items: [overlay('ov', 50, 60)] },
    ]
    const moved = moveItemAcrossTracks({ tracks, item: videoDragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -48 })
    expect(ids(moved)).toEqual([['blocker'], ['d'], ['ov']])
    expect(moved.map(trackKind)).toEqual(['video', 'video', 'overlay'])
  })

  it('the result is always canonical — matches its own re-grouping — for an ordinary same-kind move too', () => {
    const tracks = stack([dragged], [clip('x', 50, 60)])
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -13 })
    const videoGroup = moved.filter(t => trackKind(t) === 'video')
    const overlayGroup = moved.filter(t => trackKind(t) === 'overlay')
    expect(moved).toEqual([...videoGroup, ...overlayGroup])
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
