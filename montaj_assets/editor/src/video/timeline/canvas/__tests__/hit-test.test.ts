/// <reference types="vitest/globals" />
/**
 * SP5 T5 — hit-testing. Pure arithmetic over the painter's own layout, so the
 * whole surface is covered here without a canvas or a browser.
 *
 * The fixture is laid out so every coordinate in the assertions is legible:
 * 100px per second and no scroll, which makes x exactly `t * 100`.
 *
 *   row y   0– 40   track 1 (overlays) — o0 spans x 200–400
 *   gap     40– 44
 *   row y  44–100   track 0 (base, taller) — c0 x 0–500, c1 x 500–1000
 *   gap    100–104
 *   lane  104–144   audio a0 x 100–600, bar inset to y 108–140
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../../types'
import { computeTimelineLayout } from '../draw'
import {
  AUDIO_EDGE_TOLERANCE_PX,
  VISUAL_EDGE_TOLERANCE_PX,
  hitTest,
  isEdgeHit,
  isEmptyHit,
  isItemHit,
} from '../hit-test'
import type { Viewport } from '../viewport'

const VIEWPORT: Viewport = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }

const project = {
  id: 'p',
  tracks: [
    [
      { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5 },
      { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 10 },
    ],
    [{ id: 'o0', type: 'overlay', start: 2, end: 4 }],
  ],
  audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 }] },
} as unknown as Project

const layout = computeTimelineLayout(project)

function at(x: number, y: number) {
  return hitTest({ x, y }, layout, VIEWPORT)
}

describe('hitTest — geometry sanity', () => {
  it('the fixture lays out where the assertions below assume', () => {
    expect(layout.rows.map(r => [r.trackIdx, r.y, r.height])).toEqual([[1, 0, 40], [0, 44, 56]])
    expect(layout.lanes.map(l => [l.laneIndex, l.y, l.height])).toEqual([[0, 104, 40]])
  })
})

describe('hitTest — visual items', () => {
  it('finds a clip body and reports its track', () => {
    const hit = at(250, 60)
    expect(hit.kind).toBe('item-body')
    expect(hit.itemId).toBe('c0')
    expect(hit.trackIdx).toBe(0)
    expect(hit.item?.id).toBe('c0')
    expect(hit.edge).toBeUndefined()
  })

  it('finds the in and out trim handles', () => {
    expect(at(5, 60)).toMatchObject({ kind: 'item-edge', itemId: 'c0', edge: 'in' })
    expect(at(495, 60)).toMatchObject({ kind: 'item-edge', itemId: 'c0', edge: 'out' })
  })

  it('honours the handle width exactly at its boundaries', () => {
    // The handles are 10px wide and sit inside the clip: 0–10 and 490–500.
    expect(at(10, 60).edge).toBe('in')
    expect(at(10.5, 60).kind).toBe('item-body')
    expect(at(490, 60).edge).toBe('out')
    expect(at(489.5, 60).kind).toBe('item-body')
  })

  it('takes the tolerance from options when given', () => {
    const hit = hitTest({ x: 30, y: 60 }, layout, VIEWPORT, { visualEdgeTolerancePx: 40 })
    expect(hit).toMatchObject({ kind: 'item-edge', edge: 'in' })
    expect(VISUAL_EDGE_TOLERANCE_PX).toBe(10)
  })

  it('gives the out handle precedence when a clip is too narrow for two', () => {
    // A 12px clip: the two 10px zones overlap, and the out handle wins — the
    // DOM's right handle paints last and so hit-tests first.
    const narrow = {
      id: 'p', tracks: [[{ id: 'n0', type: 'video', src: 'n.mp4', start: 0, end: 0.12 }]],
    } as unknown as Project
    const narrowLayout = computeTimelineLayout(narrow)
    expect(hitTest({ x: 6, y: 10 }, narrowLayout, VIEWPORT)).toMatchObject({ edge: 'out' })
    expect(hitTest({ x: 1, y: 10 }, narrowLayout, VIEWPORT)).toMatchObject({ edge: 'in' })
  })

  it('resolves a shared boundary to the clip painted on top', () => {
    // c0 ends and c1 starts at t=5 → x=500. The later item in the array wins,
    // and the point lands in its in-handle.
    expect(at(500, 60)).toMatchObject({ kind: 'item-edge', itemId: 'c1', edge: 'in' })
  })

  it('finds an overlay on the row above the base track', () => {
    expect(at(300, 20)).toMatchObject({ kind: 'item-body', itemId: 'o0', trackIdx: 1 })
  })

  it('reports empty track area with the row it belongs to', () => {
    expect(at(700, 20)).toMatchObject({ kind: 'empty-row', trackIdx: 1 })
  })
})

describe('hitTest — audio lanes', () => {
  it('finds a bar body and its lane', () => {
    expect(at(300, 120)).toMatchObject({ kind: 'audio-body', itemId: 'a0', laneIdx: 0 })
    expect(at(300, 120).track?.id).toBe('a0')
  })

  it('finds the bar trim handles at the narrower audio tolerance', () => {
    expect(AUDIO_EDGE_TOLERANCE_PX).toBe(6)
    expect(at(103, 120)).toMatchObject({ kind: 'audio-edge', edge: 'in' })
    expect(at(597, 120)).toMatchObject({ kind: 'audio-edge', edge: 'out' })
    // 8px in from the start is past the 6px handle — that's bar body.
    expect(at(108, 120).kind).toBe('audio-body')
  })

  it('treats the lane inset above and below the bar as lane background', () => {
    expect(at(300, 105).kind).toBe('empty-lane')
    expect(at(300, 142).kind).toBe('empty-lane')
  })

  it('reports empty lane area', () => {
    expect(at(800, 120)).toMatchObject({ kind: 'empty-lane', laneIdx: 0 })
  })
})

describe('hitTest — outside the rows', () => {
  it('treats the gap between rows as background', () => {
    expect(at(300, 42).kind).toBe('background')
  })

  it('treats anything below the last lane as background', () => {
    expect(at(300, 500).kind).toBe('background')
  })

  it('treats negative y as background', () => {
    expect(at(300, -5).kind).toBe('background')
  })

  it('still reports a time for points off either end of the surface', () => {
    expect(at(-50, 60)).toMatchObject({ kind: 'empty-row', t: -0.5 })
    expect(at(5000, 60)).toMatchObject({ kind: 'empty-row', t: 50 })
  })
})

describe('hitTest — time', () => {
  it('always reports the time under x, whatever was hit', () => {
    expect(at(250, 60).t).toBeCloseTo(2.5)
    expect(at(250, 42).t).toBeCloseTo(2.5)
    expect(at(250, 120).t).toBeCloseTo(2.5)
  })

  it('accounts for scroll', () => {
    const scrolled: Viewport = { ...VIEWPORT, scrollSeconds: 3 }
    expect(hitTest({ x: 250, y: 60 }, layout, scrolled).t).toBeCloseTo(5.5)
  })
})

describe('hitTest — predicates', () => {
  it('classifies each kind', () => {
    expect(isEdgeHit(at(5, 60))).toBe(true)
    expect(isEdgeHit(at(250, 60))).toBe(false)
    expect(isItemHit(at(250, 60))).toBe(true)
    expect(isItemHit(at(300, 120))).toBe(true)
    expect(isItemHit(at(700, 20))).toBe(false)
    expect(isEmptyHit(at(700, 20))).toBe(true)
    expect(isEmptyHit(at(300, 42))).toBe(true)
    expect(isEmptyHit(at(800, 120))).toBe(true)
    expect(isEmptyHit(at(250, 60))).toBe(false)
  })
})

describe('hitTest — degenerate layouts', () => {
  it('reports background for an empty project', () => {
    const empty = computeTimelineLayout({ id: 'p' } as unknown as Project)
    expect(hitTest({ x: 100, y: 10 }, empty, VIEWPORT).kind).toBe('background')
  })

  it('survives a viewport with no scale yet', () => {
    const unscaled: Viewport = { pxPerSecond: 0, scrollSeconds: 0, widthPx: 0 }
    const hit = hitTest({ x: 100, y: 60 }, layout, unscaled)
    // Every clip collapses to x=0, so a point at x=100 is past all of them.
    expect(hit.kind).toBe('empty-row')
    expect(hit.t).toBe(0)
  })
})
