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
import { AUDIO_ITEM_INSET_PX, RULER_HEIGHT_PX, computeTimelineLayout } from '../draw'
import {
  AUDIO_EDGE_TOLERANCE_PX,
  FADE_GRIP_ZONE_HEIGHT_PX,
  VISUAL_EDGE_TOLERANCE_PX,
  hitTest,
  isCaptionHit,
  isEdgeHit,
  isEmptyHit,
  isItemHit,
  itemsInRect,
  normalizeRect,
} from '../hit-test'
import { KEYFRAME_DIAMOND_SIZE_PX, KEYFRAME_STRIP_BOTTOM_PAD_PX, KEYFRAME_STRIP_ZONE_HEIGHT_PX } from '../keyframe-strip'
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
    // Rows begin under the ruler strip, which owns the top of the surface.
    const contentTop = RULER_HEIGHT_PX + ROW_GAP_PX
    expect(layout.ruler).toEqual({ y: 0, height: RULER_HEIGHT_PX })
    expect(layout.rows.map(r => [r.trackIdx, r.y, r.height])).toEqual([
      [1, contentTop, VISUAL_ROW_RENDER_HEIGHT_PX],
      [0, contentTop + VISUAL_ROW_RENDER_HEIGHT_PX + ROW_GAP_PX, BASE_VISUAL_ROW_RENDER_HEIGHT_PX],
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
    const narrowY = narrowLayout.rows[0].y + 2
    expect(hitTest({ x: 6, y: narrowY }, narrowLayout, VIEWPORT)).toMatchObject({ edge: 'out' })
    expect(hitTest({ x: 1, y: narrowY }, narrowLayout, VIEWPORT)).toMatchObject({ edge: 'in' })
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

describe('hitTest — audio fade grips', () => {
  // a0 spans x 100–600 (1s–6s @ 100px/s) with no fadeIn/fadeOut set, so both
  // grips sit at the bar's own corners — see `audioFadeGripZone`'s doc for
  // the precedence this creates against the trim edge, which claims the SAME
  // x but the bar's FULL height.
  const barTop = lane0.y + AUDIO_ITEM_INSET_PX

  it('finds the fade-IN grip at the bar′s own left corner when no fade is set', () => {
    expect(at(100, barTop)).toMatchObject({ kind: 'audio-fade', itemId: 'a0', side: 'in', laneIdx: 0 })
  })

  it('finds the fade-OUT grip at the bar′s own right corner when no fade is set', () => {
    expect(at(600, barTop)).toMatchObject({ kind: 'audio-fade', itemId: 'a0', side: 'out', laneIdx: 0 })
  })

  it('takes precedence over the trim edge at the exact corner, where both zones overlap', () => {
    // (100, barTop) is also inside the audio-edge zone (±AUDIO_EDGE_TOLERANCE_PX
    // of the corner) — confirm the GRIP wins there, not the edge.
    expect(at(100, barTop).kind).toBe('audio-fade')
  })

  it('does NOT steal the trim edge below the grip′s small top zone — the full-height edge is still reachable further down', () => {
    // Same x as the corner (well within AUDIO_EDGE_TOLERANCE_PX), but below
    // FADE_GRIP_ZONE_HEIGHT_PX — resolves to the trim edge, not the grip.
    const belowGripZone = barTop + FADE_GRIP_ZONE_HEIGHT_PX + 2
    expect(at(100, belowGripZone)).toMatchObject({ kind: 'audio-edge', edge: 'in' })
  })

  it('leaves the bar BODY, away from either grip, alone', () => {
    expect(at(300, barTop)).toMatchObject({ kind: 'audio-body', itemId: 'a0' })
  })

  it('moves the grip zone to the fade′s INNER edge once a fade is set, not the corner', () => {
    const withFade = {
      id: 'p',
      audio: { tracks: [{ id: 'f0', src: 'v.mp3', start: 1, end: 6, lane: 0, fadeIn: 1, fadeOut: 0.5 }] },
    } as unknown as Project
    const fadeLayout = computeTimelineLayout(withFade)
    const fadeLane = fadeLayout.lanes[0]
    const fadeBarTop = fadeLane.y + AUDIO_ITEM_INSET_PX
    const fadeAt = (x: number, y: number) => hitTest({ x, y }, fadeLayout, VIEWPORT)

    // Track spans x 100–600 (1s–6s). fadeIn=1s -> inner edge at 100+100=200.
    // fadeOut=0.5s -> inner edge at 600-50=550.
    expect(fadeAt(200, fadeBarTop)).toMatchObject({ kind: 'audio-fade', side: 'in' })
    expect(fadeAt(550, fadeBarTop)).toMatchObject({ kind: 'audio-fade', side: 'out' })
    // The track's own corner is no longer a grip — it's ordinary trim-edge
    // territory now that the grip has moved off it.
    expect(fadeAt(100, fadeBarTop)).toMatchObject({ kind: 'audio-edge', edge: 'in' })
  })
})

describe('hitTest — keyframe strip (SP9b T3.3)', () => {
  // o0 (2s–4s, overlay) keyframed on offsetX at t=0, 0.5 and 1.5, and on
  // opacity at t=0.5 ONLY — so the union of times (the merged strip, plan
  // decision 2) is {0, 0.5, 1.5}, landing at x=200 (o0's own left edge, to
  // probe precedence over item-edge), x=250 (a diamond TWO props share, to
  // probe the "one diamond per shared instant" rule) and x=350 (offsetX
  // alone) — all at 100px/s off o0's start (2s).
  const keyframedProject = {
    id: 'p',
    tracks: [
      [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 10 },
      ],
      [{
        id: 'o0', type: 'overlay', start: 2, end: 4,
        keyframes: [
          { prop: 'offsetX', points: [{ t: 0, value: -5 }, { t: 0.5, value: 0 }, { t: 1.5, value: 10 }] },
          { prop: 'opacity', points: [{ t: 0.5, value: 1 }] },
        ],
      }],
    ],
    audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 }] },
  } as unknown as Project

  const kfLayout = computeTimelineLayout(keyframedProject)
  const kfRow = kfLayout.rows.find(r => r.trackIdx === 1)!
  // Well inside the bottom strip zone, not at its very edge.
  const KF_ZONE_Y = kfRow.y + kfRow.height - 2

  function atKf(x: number, y: number, selectedIds: string[]) {
    return hitTest({ x, y }, kfLayout, VIEWPORT, { selectedIds })
  }

  it('finds a diamond at a time only ONE prop has', () => {
    expect(atKf(350, KF_ZONE_Y, ['o0'])).toMatchObject({ kind: 'keyframe', itemId: 'o0', kfT: 1.5 })
  })

  it('finds ONE diamond at a time TWO props share', () => {
    expect(atKf(250, KF_ZONE_Y, ['o0'])).toMatchObject({ kind: 'keyframe', itemId: 'o0', kfT: 0.5 })
  })

  it('takes precedence over the item-edge trim zone at the exact corner, where both overlap', () => {
    // x=200 is o0's own left edge — also inside VISUAL_EDGE_TOLERANCE_PX of
    // it — but a keyframe sits exactly there too. The diamond must win.
    expect(atKf(200, KF_ZONE_Y, ['o0'])).toMatchObject({ kind: 'keyframe', itemId: 'o0', kfT: 0 })
  })

  it("the clickable zone reaches all the way up to the diamond's own drawn top edge (FIX 7)", () => {
    // The diamond is drawn KEYFRAME_DIAMOND_SIZE_PX + KEYFRAME_STRIP_BOTTOM_PAD_PX
    // (8 + 4 = 12px) up from the row's bottom (see drawKeyframeStrip / keyframe-
    // strip.ts's own doc). Computed independently of KEYFRAME_STRIP_ZONE_HEIGHT_PX
    // itself, so this would have failed against the old hand-picked 10px zone
    // height, which fell 2px short of the diamond's actual top edge.
    const diamondTopFromBottom = KEYFRAME_DIAMOND_SIZE_PX + KEYFRAME_STRIP_BOTTOM_PAD_PX
    const topOfDiamond = kfRow.y + kfRow.height - diamondTopFromBottom
    expect(atKf(350, topOfDiamond, ['o0'])).toMatchObject({ kind: 'keyframe', itemId: 'o0', kfT: 1.5 })
  })

  it('an in-span keyframe still hits normally (non-regression)', () => {
    expect(atKf(350, KF_ZONE_Y, ['o0'])).toMatchObject({ kind: 'keyframe', itemId: 'o0', kfT: 1.5 })
  })

  it('a point far from any diamond in x, but still within the strip zone in y, does not produce a keyframe hit', () => {
    // x=380 is well inside o0's body (200-400) but 30px from the nearest
    // diamond (x=350, t=1.5) — outside KEYFRAME_HIT_HALF_WIDTH_PX (6px). Must
    // fall through to the ordinary item-body hit, not stay stuck on 'keyframe'.
    expect(atKf(380, KF_ZONE_Y, ['o0'])).toMatchObject({ kind: 'item-body', itemId: 'o0' })
  })

  it('an out-of-span keyframe produces NO keyframe hit — the item-body of the clip actually drawn there wins instead', () => {
    // o0 (2s-4s, duration 2s) carries an OUT-OF-SPAN keyframe at t=3
    // (t > duration). Unclamped, its screen x is (o0.start + 3) * 100 = 500 —
    // which is nowhere near o0's own drawn rect (x 200-400): it lands exactly
    // where the NEXT item on the same track, o1 (4s-6s), is actually drawn.
    // Before the fix, keyframeStripZone had no span filter, so o0's phantom
    // diamond at x=500 won the hit ahead of o1's real, visible body.
    const overlapProject = {
      id: 'p',
      tracks: [
        [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10 }],
        [
          {
            id: 'o0', type: 'overlay', start: 2, end: 4,
            keyframes: [{ prop: 'offsetX', points: [{ t: 0.5, value: 0 }, { t: 3, value: 10 }] }],
          },
          { id: 'o1', type: 'overlay', start: 4, end: 6 },
        ],
      ],
    } as unknown as Project
    const overlapLayout = computeTimelineLayout(overlapProject)
    const row = overlapLayout.rows.find(r => r.trackIdx === 1)!
    const y = row.y + row.height - 2
    expect(hitTest({ x: 500, y }, overlapLayout, VIEWPORT, { selectedIds: ['o0'] }))
      .toMatchObject({ kind: 'item-body', itemId: 'o1' })
  })

  it('does not steal the row away from the diamond zone — item-body still resolves above/below it', () => {
    // Same x as a diamond, but ABOVE KEYFRAME_STRIP_ZONE_HEIGHT_PX from the
    // row's bottom: falls through to the ordinary clip body.
    expect(KEYFRAME_STRIP_ZONE_HEIGHT_PX).toBeGreaterThan(0)
    const aboveStrip = kfRow.y + 2
    expect(atKf(250, aboveStrip, ['o0'])).toMatchObject({ kind: 'item-body', itemId: 'o0' })
  })

  it('yields no keyframe hit when the overlay is NOT selected', () => {
    expect(atKf(250, KF_ZONE_Y, [])).toMatchObject({ kind: 'item-body', itemId: 'o0' })
  })

  it('yields no keyframe hit when a DIFFERENT item is selected', () => {
    expect(atKf(250, KF_ZONE_Y, ['c0'])).toMatchObject({ kind: 'item-body', itemId: 'o0' })
  })

  it('yields no keyframe hit on a selected but UN-keyframed overlay', () => {
    const plain = { id: 'p', tracks: [[{ id: 'o1', type: 'overlay', start: 2, end: 4 }]] } as unknown as Project
    const plainLayout = computeTimelineLayout(plain)
    const row = plainLayout.rows[0]
    const y = row.y + row.height - 2
    expect(hitTest({ x: 250, y }, plainLayout, VIEWPORT, { selectedIds: ['o1'] })).toMatchObject({ kind: 'item-body', itemId: 'o1' })
  })

  it('yields no keyframe hit on a selected, keyframed item that is not an overlay', () => {
    // Overlays are the only keyframeable kind (schema.ts's `KeyframeProp`
    // doc); the row scan gates on `item.type === 'overlay'` rather than
    // trusting `isKeyframed` alone, so a hand-edited video clip carrying a
    // stray `keyframes` array still never hit-tests as one.
    const videoKf = {
      id: 'p',
      tracks: [[{
        id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 4,
        keyframes: [{ prop: 'offsetX', points: [{ t: 0.5, value: 0 }] }],
      }]],
    } as unknown as Project
    const videoLayout = computeTimelineLayout(videoKf)
    const row = videoLayout.rows[0]
    const y = row.y + row.height - 2
    expect(hitTest({ x: 250, y }, videoLayout, VIEWPORT, { selectedIds: ['c0'] }).kind).not.toBe('keyframe')
  })

  it('is backward compatible: omitting `selectedIds` entirely never produces a keyframe hit', () => {
    expect(hitTest({ x: 250, y: KF_ZONE_Y }, kfLayout, VIEWPORT).kind).not.toBe('keyframe')
  })
})

describe('hitTest — outside the rows', () => {
  it('treats the gap between rows as background', () => {
    expect(at(300, ROW_GAP_Y).kind).toBe('background')
  })

  it('treats anything below the last lane as background', () => {
    expect(at(300, 500).kind).toBe('background')
  })

  it('treats negative y as the ruler, so a scrub survives drifting off the top', () => {
    // Everything at or above the ruler's bottom edge is the ruler, including
    // points off the surface entirely. A pointer that wanders above the strip
    // mid-scrub is still scrubbing; reporting `background` there would drop the
    // gesture the moment the hand rose.
    expect(at(300, -5).kind).toBe('ruler')
    expect(at(300, -5).t).toBeCloseTo(3)
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
    // Below the ruler: with no rows or lanes there is nothing but background.
    expect(hitTest({ x: 100, y: RULER_HEIGHT_PX + 10 }, empty, VIEWPORT).kind).toBe('background')
    // The ruler itself is still there, even with nothing to rule over.
    expect(hitTest({ x: 100, y: 2 }, empty, VIEWPORT).kind).toBe('ruler')
  })

  it('survives a viewport with no scale yet', () => {
    const unscaled: Viewport = { pxPerSecond: 0, scrollSeconds: 0, widthPx: 0 }
    const hit = hitTest({ x: 100, y: 60 }, layout, unscaled)
    // Every clip collapses to x=0, so a point at x=100 is past all of them.
    expect(hit.kind).toBe('empty-row')
    expect(hit.t).toBe(0)
  })
})

describe('hitTest — an audio bar with no declared window', () => {
  // `groupAudioLanes` resolves the window, so the painter, the hit-test and the
  // pointer machine all address the same bar. Without that, this lane's
  // x-coordinates are NaN, and NaN loses every comparison in `spanZone` — so
  // the bar reported a body hit at EVERY x in the lane, including well past
  // its end, and the gesture that followed did NaN arithmetic. The contract is
  // that the bar is grabbable where it is drawn and only there. Note which
  // assertions actually guard it: a plain body hit does NOT, because NaN bounds
  // fall through to 'body' everywhere. The in-handle and past-the-end cases do.
  const p = {
    id: 'p',
    tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10 }]],
    audio: { tracks: [{ id: 'bed', src: 'song.mp3' }] },
  } as unknown as Project
  const l = computeTimelineLayout(p)
  const lane = l.lanes[0]
  const LANE_MID_Y = lane.y + lane.height / 2

  it('a bar with no declared start/end is still grabbable', () => {
    // Vertically centred in the lane. The fixture viewport runs at 100px/s
    // from t=0, so x=40 is t=0.4 — past the in handle, nowhere near the out.
    const hit = hitTest({ x: 40, y: LANE_MID_Y }, l, VIEWPORT)
    expect(hit.kind).toBe('audio-body')
    expect(hit.itemId).toBe('bed')
  })

  it('and its in-handle is where the bar actually starts', () => {
    // This is the half that FAILS on revert. The body assertion above does not:
    // with NaN bounds every comparison in `spanZone` is false, so it falls
    // through to 'body' at every x and reports a body hit anyway. Only a zone
    // that NaN cannot produce proves the window was resolved — the in handle
    // needs `x <= x0 + tolerance` to be TRUE, which NaN never satisfies.
    const hit = hitTest({ x: 2, y: LANE_MID_Y }, l, VIEWPORT)
    expect(hit.kind).toBe('audio-edge')
    expect(hit.edge).toBe('in')
    expect(hit.itemId).toBe('bed')
  })

  it('and is not grabbable past the end of the resolved window', () => {
    // The window resolves to the project's content duration (10s → x=1000).
    const hit = hitTest({ x: 1200, y: LANE_MID_Y }, l, VIEWPORT)
    expect(hit.kind).toBe('empty-lane')
    expect(hit.itemId).toBeUndefined()
  })
})

// ── The caption band ──────────────────────────────────────────────────────
// Captions hit-test exactly like clips and audio bars now: the band is a
// rectangle in the same layout, and its blocks resolve through the same
// `resolveRow`. A separate fixture so the assertions above keep the geometry
// they were written against.
describe('hitTest — the caption band', () => {
  const captioned = {
    ...project,
    captions: {
      style: 'pop',
      segments: [
        // Deliberately NOT butted (a 1s gap): the gap is where "empty band"
        // is probed, and it keeps each edge test aimed at one segment only.
        { id: 's0', text: 'one', start: 0, end: 2 },
        { id: 's1', text: 'two', start: 3, end: 5 },
        // No id — before `backfillCaptionIds` has run. Draws, never hittable.
        { text: 'three', start: 6, end: 8 },
      ],
    },
  } as unknown as Project

  const l = computeTimelineLayout(captioned)
  const band = l.captions![0]
  const BAND_Y = Math.round(band.y + band.height / 2)
  const capBaseRow = l.rows.find(r => r.trackIdx === 0)!
  const inBand = (x: number, y: number = BAND_Y) => hitTest({ x, y }, l, VIEWPORT)

  it('sits immediately above the base video row', () => {
    expect(band.y + band.height + ROW_GAP_PX).toBe(capBaseRow.y)
    // …and below the overlay row, so it is genuinely between the two.
    expect(band.y).toBeGreaterThan(l.rows.find(r => r.trackIdx === 1)!.y)
  })

  it('resolves a segment body', () => {
    const hit = inBand(100)
    expect(hit.kind).toBe('caption-body')
    expect(hit.itemId).toBe('s0')
    expect(hit.segment?.text).toBe('one')
    expect(hit.t).toBeCloseTo(1)
  })

  it('resolves both trim handles', () => {
    expect(inBand(2)).toMatchObject({ kind: 'caption-edge', itemId: 's0', edge: 'in' })
    expect(inBand(198)).toMatchObject({ kind: 'caption-edge', itemId: 's0', edge: 'out' })
    expect(inBand(302)).toMatchObject({ kind: 'caption-edge', itemId: 's1', edge: 'in' })
    expect(inBand(498)).toMatchObject({ kind: 'caption-edge', itemId: 's1', edge: 'out' })
  })

  it('grabs handles at the AUDIO tolerance, not the visual one', () => {
    // 7px in is body at 6px tolerance and would be the in-handle at 10px.
    expect(AUDIO_EDGE_TOLERANCE_PX).toBeLessThan(VISUAL_EDGE_TOLERANCE_PX)
    expect(inBand(AUDIO_EDGE_TOLERANCE_PX - 1).kind).toBe('caption-edge')
    expect(inBand(AUDIO_EDGE_TOLERANCE_PX + 1).kind).toBe('caption-body')
  })

  it('reports background for the gaps between blocks, and past the last one', () => {
    // Not a kind of its own: `background` already means marquee here, seek
    // here, clear the selection — which is right for a gap in the band.
    expect(inBand(250).kind).toBe('background')
    expect(inBand(900).kind).toBe('background')
    expect(isEmptyHit(inBand(250))).toBe(true)
  })

  it('never hits a segment that has no id yet', () => {
    // x 600–800 is where the id-less segment is drawn.
    expect(inBand(700).kind).toBe('background')
    expect(inBand(602).kind).toBe('background')
  })

  it('hit-tests the FULL band height, inset and all', () => {
    // The painter insets blocks by 4px top and bottom; the hit-test does not.
    // A 40px row whose outer 8px silently missed would read as broken.
    expect(inBand(100, band.y).kind).toBe('caption-body')
    expect(inBand(100, band.y + band.height - 1).kind).toBe('caption-body')
    // …and the pixel below the band belongs to the gap, not to the band.
    expect(inBand(100, band.y + band.height).kind).not.toBe('caption-body')
  })

  it('reports the band lane on every caption hit — a single-band project is all lane 0', () => {
    expect(inBand(100).captionLane).toBe(0)
    expect(inBand(2).captionLane).toBe(0)
    // Not a caption hit, so no lane to report.
    expect(inBand(250).captionLane).toBeUndefined()
  })

  it('classifies caption hits through the predicates', () => {
    expect(isCaptionHit(inBand(100))).toBe(true)
    expect(isCaptionHit(inBand(2))).toBe(true)
    expect(isCaptionHit(inBand(250))).toBe(false)
    // Load-bearing: `grabsPlayhead` and the hover-handle pass both key off this.
    expect(isEdgeHit(inBand(2))).toBe(true)
    expect(isEdgeHit(inBand(100))).toBe(false)
    // Deliberately excluded — see the predicate's own comment.
    expect(isItemHit(inBand(100))).toBe(false)
  })

  it('leaves the rows and lanes below it exactly where they were', () => {
    // The band pushes the base row down, so every other probe here has to keep
    // reading its Y from the layout — this asserts the layout still resolves.
    expect(hitTest({ x: 250, y: Math.round(capBaseRow.y + capBaseRow.height / 2) }, l, VIEWPORT))
      .toMatchObject({ kind: 'item-body', itemId: 'c0' })
  })

  describe('itemsInRect', () => {
    const caught = (r: { x: number; y: number; width: number; height: number }) =>
      itemsInRect(r, l, VIEWPORT).sort()

    it('catches caption ids when the box crosses the band', () => {
      const rect = normalizeRect({ x: 100, y: band.y }, { x: 350, y: band.y + band.height })
      expect(caught(rect)).toEqual(['s0', 's1'])
    })

    it('skips id-less segments the box crosses', () => {
      const rect = normalizeRect({ x: 550, y: band.y }, { x: 900, y: band.y + band.height })
      expect(caught(rect)).toEqual([])
    })

    it('catches captions alongside clips and bars in one tall box', () => {
      const rect = normalizeRect(
        { x: 98, y: l.rows.find(r => r.trackIdx === 1)!.y },
        { x: 104, y: l.lanes[0].y + l.lanes[0].height },
      )
      // t=1: s0 (0–2), c0 (0–5) and a0 (1–6) are live; o0 (2–4) is not.
      expect(caught(rect)).toEqual(['a0', 'c0', 's0'])
    })

    it('catches nothing from the band when the box stays clear of it', () => {
      const rect = normalizeRect({ x: 0, y: capBaseRow.y }, { x: 1000, y: capBaseRow.y + 4 })
      expect(caught(rect)).toEqual(['c0', 'c1'])
    })
  })
})

// ── Caption bands on more than one lane ────────────────────────────────────
// Bands are emitted in DESCENDING lane order, so lane 0 sits lowest (adjacent
// to the base video row) and higher lanes stack upward. A hit has to name the
// band it landed in, because that is where a vertical drag measures its lane
// delta from.
describe('hitTest — captions across several lanes', () => {
  const laned = {
    ...project,
    captions: {
      style: 'pop',
      segments: [
        { id: 'l0', text: 'ground', start: 0, end: 2 },              // lane 0 (absent ⇒ 0)
        { id: 'l1', text: 'middle', start: 0, end: 2, lane: 1 },     // same span, one row up
        { id: 'l2', text: 'top', start: 3, end: 5, lane: 2 },
      ],
    },
  } as unknown as Project

  const l = computeTimelineLayout(laned)
  const bandFor = (lane: number) => l.captions!.find(b => b.lane === lane)!
  const midY = (lane: number) => Math.round(bandFor(lane).y + bandFor(lane).height / 2)
  const hit = (x: number, lane: number) => hitTest({ x, y: midY(lane) }, l, VIEWPORT)

  it('stacks lane 0 lowest and higher lanes above it', () => {
    expect(l.captions!.map(b => b.lane)).toEqual([2, 1, 0])
    expect(bandFor(2).y).toBeLessThan(bandFor(1).y)
    expect(bandFor(1).y).toBeLessThan(bandFor(0).y)
  })

  it('resolves each band to its own segment, and reports its lane', () => {
    expect(hit(100, 0)).toMatchObject({ kind: 'caption-body', itemId: 'l0', captionLane: 0 })
    expect(hit(100, 1)).toMatchObject({ kind: 'caption-body', itemId: 'l1', captionLane: 1 })
    expect(hit(400, 2)).toMatchObject({ kind: 'caption-body', itemId: 'l2', captionLane: 2 })
  })

  it('does not let one lane catch another lane\'s segment at the same x', () => {
    // l0 and l1 share the span 0–2s exactly. Only the band under the point
    // answers; the identically-placed segment one row up is not reachable
    // from lane 0's band.
    expect(hit(100, 0).itemId).toBe('l0')
    expect(hit(400, 0).kind).toBe('background')   // l2's span, but l2 is on lane 2
    expect(hit(100, 2).kind).toBe('background')   // l0/l1's span, but they are lower
  })

  it('reports the lane on an EDGE hit too', () => {
    expect(hit(2, 1)).toMatchObject({ kind: 'caption-edge', itemId: 'l1', edge: 'in', captionLane: 1 })
    expect(hit(198, 1)).toMatchObject({ kind: 'caption-edge', itemId: 'l1', edge: 'out', captionLane: 1 })
  })

  it('never reports a caption lane through `laneIdx`, which is the AUDIO index', () => {
    // Load-bearing: `laneIdx` is fed to `tieredBoundaries`, which ranks THAT
    // audio lane's boundaries strong. A caption on lane 0 must not hand a drag
    // audio lane 0's magnets.
    expect(hit(100, 1).laneIdx).toBeUndefined()
    expect(hit(100, 0).laneIdx).toBeUndefined()
  })

  it('still finds the rows and lanes pushed down by the extra bands', () => {
    const pushedBase = l.rows.find(r => r.trackIdx === 0)!
    expect(pushedBase.y).toBeGreaterThan(baseRow.y)
    expect(hitTest({ x: 250, y: Math.round(pushedBase.y + pushedBase.height / 2) }, l, VIEWPORT))
      .toMatchObject({ kind: 'item-body', itemId: 'c0' })
  })

  it('a marquee crossing several bands catches segments from every one of them', () => {
    const rect = normalizeRect({ x: 50, y: bandFor(2).y }, { x: 450, y: bandFor(0).y + bandFor(0).height })
    expect(itemsInRect(rect, l, VIEWPORT).sort()).toEqual(['l0', 'l1', 'l2'])
  })

  it('a marquee inside ONE band catches only that band', () => {
    const rect = normalizeRect({ x: 50, y: bandFor(1).y }, { x: 450, y: bandFor(1).y + bandFor(1).height })
    expect(itemsInRect(rect, l, VIEWPORT).sort()).toEqual(['l1'])
  })
})

// ── itemsInRect: what a marquee box catches ────────────────────────────────
// The one piece the marquee has always leaned on but never tested directly.
// Intersection (touch), not containment; rows in surface space, spans in time.
describe('itemsInRect', () => {
  const sorted = (r: { x: number; y: number; width: number; height: number }) =>
    itemsInRect(r, layout, VIEWPORT).sort()

  it('catches every clip a horizontal box crosses within one row', () => {
    // A box dragged LEFT from the empty tail across the base row, kept in that
    // row's own y-band: the reachable way to marquee a fully-tiled row.
    const rect = normalizeRect({ x: 800, y: BASE_Y }, { x: 300, y: BASE_Y + 4 })
    expect(sorted(rect)).toEqual(['c0', 'c1'])
  })

  it('selects a clip a box lands fully INSIDE — touch, not containment', () => {
    // x 600–700 is wholly within c1 (x 500–1000) and reaches neither edge.
    const rect = normalizeRect({ x: 600, y: BASE_Y }, { x: 700, y: BASE_Y + 4 })
    expect(sorted(rect)).toEqual(['c1'])
  })

  it('a tall thin box down one instant selects across every row at that time', () => {
    // At t=3 (x=300): o0 (2–4), c0 (0–5) and a0 (1–6) all live.
    const rect = normalizeRect(
      { x: 298, y: overlayRow.y },
      { x: 304, y: lane0.y + lane0.height },
    )
    expect(sorted(rect)).toEqual(['a0', 'c0', 'o0'])
  })

  it('selects nothing when the box stays entirely below every row', () => {
    const rect = normalizeRect(
      { x: 0, y: lane0.y + lane0.height + 20 },
      { x: 1000, y: lane0.y + lane0.height + 60 },
    )
    expect(sorted(rect)).toEqual([])
  })

  it('selects nothing when the box misses every clip in time', () => {
    // Past the last clip (x 1050–1200 → t 10.5–12) but within the base row band.
    const rect = normalizeRect({ x: 1050, y: BASE_Y }, { x: 1200, y: BASE_Y + 4 })
    expect(sorted(rect)).toEqual([])
  })
})
