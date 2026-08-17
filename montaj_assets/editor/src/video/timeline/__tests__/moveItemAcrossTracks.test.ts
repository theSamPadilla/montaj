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
 */
import { describe, it, expect } from 'vitest'
import type { VisualItem } from '../../../schema'
import { moveItemAcrossTracks } from '../timeline-model'

const clip = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'video', src: `${id}.mp4`, start, end }) as VisualItem

const dragged = clip('d', 0, 10)

function ids(tracks: VisualItem[][]): string[][] {
  return tracks.map(t => t.map(i => i.id))
}

describe('moveItemAcrossTracks — vertical mapping', () => {
  it('keeps the item on its own track when the drag is horizontal', () => {
    const moved = moveItemAcrossTracks({ tracks: [[dragged], []], item: dragged, start: 2, end: 12, sourceTrackIdx: 0, dy: 0 })
    expect(ids(moved)).toEqual([['d']])
    expect(moved[0][0]).toMatchObject({ start: 2, end: 12 })
  })

  it('sends the item UP a track for upward travel', () => {
    const moved = moveItemAcrossTracks({ tracks: [[dragged], []], item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -24 })
    expect(ids(moved)).toEqual([['d']])   // track 0 emptied and pruned
  })

  it('needs half a step (12px) of travel to change track', () => {
    // Rounding means 11px is still the same track, 13px is the next one. The
    // second track is occupied by a clip far enough away not to block.
    const stacked = () => [[dragged], [clip('x', 50, 60)]]
    expect(ids(moveItemAcrossTracks({ tracks: stacked(), item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -11 })))
      .toEqual([['d'], ['x']])
    expect(ids(moveItemAcrossTracks({ tracks: stacked(), item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -13 })))
      .toEqual([['x', 'd']])
  })

  it('never goes below track 0', () => {
    const moved = moveItemAcrossTracks({ tracks: [[clip('a', 20, 30)], [dragged]], item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 500 })
    expect(ids(moved)).toEqual([['a', 'd']])
  })
})

describe('moveItemAcrossTracks — collision avoidance', () => {
  it('rejects a target track where it would overlap by more than 30% of itself', () => {
    // The dragged clip is 10s, so more than 3s of overlap is a collision.
    const tracks = [[clip('blocker', 5, 20)], [dragged]]
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24 })
    expect(ids(moved)).toEqual([['blocker'], ['d']])
  })

  it('accepts a brush past a neighbour', () => {
    // Only 2s of overlap — inside the 3s tolerance.
    const tracks = [[clip('blocker', 8, 20)], [dragged]]
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 1, dy: 24 })
    expect(ids(moved)).toEqual([['blocker', 'd']])
  })

  it('searches outward from the target, taking the first free track', () => {
    // Target is track 1; it collides, so the search tries 0 then 2.
    const tracks = [[clip('lo', 0, 10)], [clip('mid', 0, 10)], []]
    const moved = moveItemAcrossTracks({ tracks: [...tracks, [dragged]], item: dragged, start: 0, end: 10, sourceTrackIdx: 3, dy: 48 })
    expect(ids(moved)).toEqual([['lo'], ['mid'], ['d']])
  })

  it('creates a new track above the stack when the drag points past the top', () => {
    const tracks = [[dragged, clip('stay', 50, 60)]]
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 0, end: 10, sourceTrackIdx: 0, dy: -24 })
    expect(ids(moved)).toEqual([['stay'], ['d']])
  })

  it('ignores the dragged item when testing its own track for collisions', () => {
    const tracks = [[dragged, clip('far', 50, 60)]]
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 1, end: 11, sourceTrackIdx: 0, dy: 0 })
    expect(ids(moved)).toEqual([['far', 'd']])
  })
})

describe('moveItemAcrossTracks — bookkeeping', () => {
  it('carries the item\'s other props through untouched', () => {
    const rich = { ...dragged, inPoint: 3, outPoint: 13, muted: true } as VisualItem
    const moved = moveItemAcrossTracks({ tracks: [[rich]], item: rich, start: 5, end: 15, sourceTrackIdx: 0, dy: 0 })
    expect(moved[0][0]).toMatchObject({ inPoint: 3, outPoint: 13, muted: true, start: 5, end: 15 })
  })

  it('prunes tracks the move left empty', () => {
    const tracks = [[clip('a', 0, 10)], [dragged]]
    const moved = moveItemAcrossTracks({ tracks, item: dragged, start: 20, end: 30, sourceTrackIdx: 1, dy: 24 })
    expect(ids(moved)).toEqual([['a', 'd']])
  })

  it('does not mutate the tracks it was given', () => {
    const tracks = [[clip('a', 0, 10)], [dragged]]
    const before = JSON.stringify(tracks)
    moveItemAcrossTracks({ tracks, item: dragged, start: 20, end: 30, sourceTrackIdx: 1, dy: 24 })
    expect(JSON.stringify(tracks)).toBe(before)
  })
})
