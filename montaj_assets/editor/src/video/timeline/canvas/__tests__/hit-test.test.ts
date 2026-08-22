/// <reference types="vitest/globals" />
/**
 * SP5 T5 — hit-testing. Pure arithmetic over the painter's own layout, so the
 * whole surface is covered here without a canvas or a browser.
 *
 * The fixture runs at 100px per second with no scroll, so x is exactly
 * `t * 100`. The Y of each row is taken from the layout rather than written
 * out — the rows are tall enough now to hold a filmstrip over a waveform, and
 * hardcoded Y's would aim these probes at the gaps between them.
 *
 *   row  track 1 (overlays) — o0 spans x 200–400
 *   row  track 0 (base, taller) — c0 x 0–500, c1 x 500–1000
 *   lane audio a0 x 100–600, the bar inset inside the lane
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
import {
  AUDIO_LANE_HEIGHT_PX,
  BASE_VISUAL_ROW_RENDER_HEIGHT_PX,
  ROW_GAP_PX,
  VISUAL_ROW_RENDER_HEIGHT_PX,
} from '../../timeline-model'

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

const overlayRow = layout.rows.find(r => r.trackIdx === 1)!
const baseRow = layout.rows.find(r => r.trackIdx === 0)!
const lane0 = layout.lanes[0]

const OVERLAY_Y = Math.round(overlayRow.y + overlayRow.height / 2)
const BASE_Y = Math.round(baseRow.y + baseRow.height / 2)
const LANE_Y = Math.round(lane0.y + lane0.height / 2)
/** Inside the gap between two rows. */
const ROW_GAP_Y = overlayRow.y + overlayRow.height + 1
/** Inside the lane but above/below the inset audio bar. */
const LANE_ABOVE_BAR_Y = lane0.y + 1
const LANE_BELOW_BAR_Y = lane0.y + lane0.height - 2

function at(x: number, y: number) {
  return hitTest({ x, y }, layout, VIEWPORT)
}

describe('hitTest — geometry sanity', () => {
  it('the fixture lays out where the assertions below assume', () => {
    expect(layout.rows.map(r => [r.trackIdx, r.y, r.height])).toEqual([
      [1, 0, VISUAL_ROW_RENDER_HEIGHT_PX],
      [0, VISUAL_ROW_RENDER_HEIGHT_PX + ROW_GAP_PX, BASE_VISUAL_ROW_RENDER_HEIGHT_PX],
    ])
    expect(layout.lanes.map(l => [l.laneIndex, l.y, l.height])).toEqual([[baseRow.y + baseRow.height + ROW_GAP_PX, AUDIO_LANE_HEIGHT_PX]].map(([y, h]) => [0, y, h]))
  })
})

describe('hitTest — visual items', () => {
  it('finds a clip body and reports its track', () => {
    const hit = at(250, BASE_Y)
    expect(hit.kind).toBe('item-body')
    expect(hit.itemId).toBe('c0')
    expect(hit.trackIdx).toBe(0)
    expect(hit.item?.id).toBe('c0')
    expect(hit.edge).toBeUndefined()
  })

  it('finds the in and out trim handles', () => {
    expect(at(5, BASE_Y)).toMatchObject({ kind: 'item-edge', itemId: 'c0', edge: 'in' })
    expect(at(495, BASE_Y)).toMatchObject({ kind: 'item-edge', itemId: 'c0', edge: 'out' })
  })

  it('honours the handle width exactly at its boundaries', () => {
    // The handles are 10px wide and sit inside the clip: 0–10 and 490–500.
    expect(at(10, BASE_Y).edge).toBe('in')
    expect(at(10.5, BASE_Y).kind).toBe('item-body')
    expect(at(490, BASE_Y).edge).toBe('out')
    expect(at(489.5, BASE_Y).kind).toBe('item-body')
  })

  it('takes the tolerance from options when given', () => {
    const hit = hitTest({ x: 30, y: BASE_Y }, layout, VIEWPORT, { visualEdgeTolerancePx: 40 })
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
    expect(at(500, BASE_Y)).toMatchObject({ kind: 'item-edge', itemId: 'c1', edge: 'in' })
  })

  it('finds an overlay on the row above the base track', () => {
    expect(at(300, OVERLAY_Y)).toMatchObject({ kind: 'item-body', itemId: 'o0', trackIdx: 1 })
  })

  it('reports empty track area with the row it belongs to', () => {
    expect(at(700, OVERLAY_Y)).toMatchObject({ kind: 'empty-row', trackIdx: 1 })
  })
})

describe('hitTest — overlapping items', () => {
  // `a` runs 0–5 and `b` 3–9 on one track, so b covers a's whole trailing
  // second. b is later in the array, i.e. drawn on top.
  const overlapped = {
    id: 'p',
    tracks: [[
      { id: 'a', type: 'video', src: 'a.mp4', start: 0, end: 5 },
      { id: 'b', type: 'video', src: 'b.mp4', start: 3, end: 9 },
    ]],
    audio: { tracks: [
      { id: 'x', src: 'x.mp3', start: 0, end: 5, lane: 0 },
      { id: 'y', src: 'y.mp3', start: 3, end: 9, lane: 0 },
    ] },
  } as unknown as Project
  const olay = computeTimelineLayout(overlapped)
  const row = olay.rows.find(r => r.trackIdx === 0)!
  const rowY = Math.round(row.y + row.height / 2)
  const lane = olay.lanes[0]
  const laneY = Math.round(lane.y + lane.height / 2)
  const hit = (x: number, y: number) => hitTest({ x, y }, olay, VIEWPORT)

  it('reaches the buried out edge of the clip underneath', () => {
    // THE BUG: x=498 is 2px from a's end and 198px into b. Topmost-wins
    // returned b's body and stopped, so a's trailing edge was unreachable —
    // you could see it and not trim it.
    const r = hit(498, rowY)
    expect(r.kind).toBe('item-edge')
    expect(r.itemId).toBe('a')
    expect(r.edge).toBe('out')
  })

  it('still gives the overlapping clip its own body away from any edge', () => {
    // 6.5s: past a entirely, and 150px from either of b's edges.
    expect(hit(650, rowY)).toMatchObject({ kind: 'item-body', itemId: 'b' })
  })

  it('gives the overlapping clip its in edge where that is the nearer one', () => {
    // x=302 is 2px from b's start and 198px from a's end.
    expect(hit(302, rowY)).toMatchObject({ kind: 'item-edge', itemId: 'b', edge: 'in' })
  })

  it('takes the nearest edge, not the topmost, when BOTH are in range', () => {
    // A 5px overlap puts a's end (500px) and b's start (495px) inside one
    // another's tolerance, so every point between them is a candidate for
    // both and the tie-break is the whole rule.
    const tiny = {
      id: 'p',
      tracks: [[
        { id: 'a', type: 'video', src: 'a.mp4', start: 0, end: 5 },
        { id: 'b', type: 'video', src: 'b.mp4', start: 4.95, end: 9 },
      ]],
    } as unknown as Project
    const tinyLayout = computeTimelineLayout(tiny)
    const y = Math.round(tinyLayout.rows[0].y + tinyLayout.rows[0].height / 2)
    const probe = (x: number) => hitTest({ x, y }, tinyLayout, VIEWPORT)

    // 2px from b's start, 3px from a's end.
    expect(probe(497)).toMatchObject({ itemId: 'b', edge: 'in' })
    // 1px from a's end, 4px from b's start — topmost would still say b.
    expect(probe(499)).toMatchObject({ itemId: 'a', edge: 'out' })
  })

  it('falls back to the body when no edge is within tolerance', () => {
    // 4.0s: 100px from a's end, 100px from b's start. Neither edge is close,
    // so the topmost body wins, exactly as it always did.
    expect(hit(400, rowY)).toMatchObject({ kind: 'item-body', itemId: 'b' })
  })

  it('reaches a crossfaded audio bar\'s buried out edge too', () => {
    // The permanent version of the same hole: bars in a lane overlap BY
    // DESIGN, so the earlier bar's out edge was never reachable at all.
    const r = hit(498, laneY)
    expect(r.kind).toBe('audio-edge')
    expect(r.itemId).toBe('x')
    expect(r.edge).toBe('out')
  })
})

describe('hitTest — audio lanes', () => {
  it('finds a bar body and its lane', () => {
    expect(at(300, LANE_Y)).toMatchObject({ kind: 'audio-body', itemId: 'a0', laneIdx: 0 })
    expect(at(300, LANE_Y).track?.id).toBe('a0')
  })

  it('finds the bar trim handles at the narrower audio tolerance', () => {
    expect(AUDIO_EDGE_TOLERANCE_PX).toBe(6)
    expect(at(103, LANE_Y)).toMatchObject({ kind: 'audio-edge', edge: 'in' })
    expect(at(597, LANE_Y)).toMatchObject({ kind: 'audio-edge', edge: 'out' })
    // 8px in from the start is past the 6px handle — that's bar body.
    expect(at(108, LANE_Y).kind).toBe('audio-body')
  })

  it('treats the lane inset above and below the bar as lane background', () => {
    expect(at(300, LANE_ABOVE_BAR_Y).kind).toBe('empty-lane')
    expect(at(300, LANE_BELOW_BAR_Y).kind).toBe('empty-lane')
  })

  it('reports empty lane area', () => {
    expect(at(800, LANE_Y)).toMatchObject({ kind: 'empty-lane', laneIdx: 0 })
  })
})

describe('hitTest — outside the rows', () => {
  it('treats the gap between rows as background', () => {
    expect(at(300, ROW_GAP_Y).kind).toBe('background')
  })

  it('treats anything below the last lane as background', () => {
    expect(at(300, 500).kind).toBe('background')
  })

  it('treats negative y as background', () => {
    expect(at(300, -5).kind).toBe('background')
  })

  it('still reports a time for points off either end of the surface', () => {
    expect(at(-50, BASE_Y)).toMatchObject({ kind: 'empty-row', t: -0.5 })
    expect(at(5000, BASE_Y)).toMatchObject({ kind: 'empty-row', t: 50 })
  })
})

describe('hitTest — time', () => {
  it('always reports the time under x, whatever was hit', () => {
    expect(at(250, BASE_Y).t).toBeCloseTo(2.5)
    expect(at(250, ROW_GAP_Y).t).toBeCloseTo(2.5)
    expect(at(250, LANE_Y).t).toBeCloseTo(2.5)
  })

  it('accounts for scroll', () => {
    const scrolled: Viewport = { ...VIEWPORT, scrollSeconds: 3 }
    expect(hitTest({ x: 250, y: 60 }, layout, scrolled).t).toBeCloseTo(5.5)
  })
})

describe('hitTest — predicates', () => {
  it('classifies each kind', () => {
    expect(isEdgeHit(at(5, BASE_Y))).toBe(true)
    expect(isEdgeHit(at(250, BASE_Y))).toBe(false)
    expect(isItemHit(at(250, BASE_Y))).toBe(true)
    expect(isItemHit(at(300, LANE_Y))).toBe(true)
    expect(isItemHit(at(700, OVERLAY_Y))).toBe(false)
    expect(isEmptyHit(at(700, OVERLAY_Y))).toBe(true)
    expect(isEmptyHit(at(300, ROW_GAP_Y))).toBe(true)
    expect(isEmptyHit(at(800, LANE_Y))).toBe(true)
    expect(isEmptyHit(at(250, BASE_Y))).toBe(false)
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
