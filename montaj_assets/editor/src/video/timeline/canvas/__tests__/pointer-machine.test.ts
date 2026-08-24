/// <reference types="vitest/globals" />
/**
 * SP5 T5 — every gesture the canvas timeline supports, driven as pure data.
 *
 * The machine takes injected points and context and returns effects, so these
 * tests are the real coverage for pointer behaviour: no canvas, no jsdom
 * events, no timers. `TimelineCanvas.test.tsx` covers only the wiring.
 *
 * Fixture (100px/second, no scroll → x = t × 100). Row Y's are derived from
 * `computeTimelineLayout` rather than written out, so a change to the rendered
 * row heights (as the frames/waveform split brought) retargets these gestures
 * instead of silently aiming them at the gaps between rows:
 *
 *   row  track 1 — o0 (overlay) 2s–4s
 *   row  track 0 — c0 0s–5s, c1 5s–10s (both video, 20s sources)
 *   lane audio a0 1s–6s, the bar inset inside the lane
 *
 * Snap boundaries therefore are {0, 5, 10, 2, 4, 1, 6}, and a gesture's own two
 * boundaries are excluded from its magnets.
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../../types'
import { CAPTION_ROW_HEIGHT_PX, ROW_GAP_PX, VISUAL_ROW_HEIGHT_PX, computeDerivedTiming, trackItems } from '../../timeline-model'
import { AUDIO_ITEM_INSET_PX, computeTimelineLayout } from '../draw'
import {
  CAPTION_MIN_DURATION_S,
  NO_MODIFIERS,
  createPointerMachine,
  cursorForHit,
  initialMachineState,
  isAdditive,
  pointerReducer,
  resolveGesture,
  type Modifiers,
  type PointerContext,
  type PointerEffect,
} from '../pointer-machine'
import { FADE_GRIP_ZONE_HEIGHT_PX, hitTest } from '../hit-test'
import type { Viewport } from '../viewport'

const VIEWPORT: Viewport = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }

function baseProject(): Project {
  return {
    id: 'p',
    tracks: [
      {
        id: 'trk-0',
        items: [
          { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 20 },
          { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 10, inPoint: 2, outPoint: 7, sourceDuration: 20 },
        ],
      },
      { id: 'trk-1', items: [{ id: 'o0', type: 'overlay', start: 2, end: 4 }] },
    ],
    audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 }] },
  } as unknown as Project
}

/** Same layout as `baseProject`, but `tracks` in the pre-T6 legacy shape (a
 *  bare array of item arrays, no track ids). Every reader in the package
 *  tolerates this — but `moveItemAcrossTracks`'s two callers used to pass
 *  `project.tracks` straight through, so this is what an editor genuinely
 *  reaches for when server-side shape normalization hasn't run yet (e.g. the
 *  SSE stream's initial frame reads project.json off disk unmigrated). */
function legacyProject(): Project {
  return {
    id: 'p',
    tracks: [
      [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 20 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 10, inPoint: 2, outPoint: 7, sourceDuration: 20 },
      ],
      [{ id: 'o0', type: 'overlay', start: 2, end: 4 }],
    ],
    audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 }] },
  } as unknown as Project
}

/**
 * Same layout as `baseProject`, but track 1's item is VIDEO-kind (`o0`
 * keeps its id, start and end — only `type`/`src` change) instead of
 * overlay. Used ONLY by the cross-track-move tests below that drag a clip
 * ACROSS the track-0/track-1 boundary: those tests exist to exercise the
 * search mechanics (accumulation, collision tolerance, pruning), and the
 * kind-lock (`moveItemAcrossTracks`'s `kindOk`) correctly refuses to let a
 * video clip land on an overlay-only track — so a same-kind neighbour is
 * what lets the drag actually happen. Every other test in this file still
 * exercises the real (video + overlay) `baseProject`.
 */
function sameKindProject(): Project {
  return {
    id: 'p',
    tracks: [
      {
        id: 'trk-0',
        items: [
          { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 20 },
          { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 10, inPoint: 2, outPoint: 7, sourceDuration: 20 },
        ],
      },
      { id: 'trk-1', items: [{ id: 'o0', type: 'video', src: 'o0.mp4', start: 2, end: 4, inPoint: 0, outPoint: 2, sourceDuration: 20 }] },
    ],
    audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 }] },
  } as unknown as Project
}

/** `sameKindProject`, legacy array-of-arrays shape — the same-kind sibling of
 *  `legacyProject`, for the T6-regression cross-track test. */
function sameKindLegacyProject(): Project {
  return {
    id: 'p',
    tracks: [
      [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 20 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 10, inPoint: 2, outPoint: 7, sourceDuration: 20 },
      ],
      [{ id: 'o0', type: 'video', src: 'o0.mp4', start: 2, end: 4, inPoint: 0, outPoint: 2, sourceDuration: 20 }],
    ],
    audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 }] },
  } as unknown as Project
}

function makeContext(overrides: Partial<PointerContext> = {}): PointerContext {
  const project = overrides.project ?? baseProject()
  const { snapBoundaries, totalDuration } = computeDerivedTiming(project)
  return {
    project,
    layout: computeTimelineLayout(project),
    viewport: VIEWPORT,
    selectedIds: [],
    snapBoundaries,
    totalDuration,
    rippleMode: false,
    playheadTime: 0,
    fps: 30,
    ...overrides,
  }
}

function mods(over: Partial<Modifiers> = {}): Modifiers {
  return { ...NO_MODIFIERS, ...over }
}

/** Drive a gesture through the imperative wrapper, collecting every effect. */
class Driver {
  machine = createPointerMachine()
  effects: PointerEffect[] = []
  constructor(public ctx: PointerContext) {}

  down(x: number, y: number, modifiers = NO_MODIFIERS) {
    this.effects = this.machine.dispatch({ type: 'pointerDown', point: { x, y }, modifiers, ctx: this.ctx })
    return this.effects
  }
  move(x: number, y: number, modifiers = NO_MODIFIERS) {
    this.effects = this.machine.dispatch({ type: 'pointerMove', point: { x, y }, modifiers, ctx: this.ctx })
    return this.effects
  }
  up(x: number, y: number, modifiers = NO_MODIFIERS) {
    this.effects = this.machine.dispatch({ type: 'pointerUp', point: { x, y }, modifiers, ctx: this.ctx })
    return this.effects
  }
  doubleClick(x: number, y: number, modifiers = NO_MODIFIERS) {
    this.effects = this.machine.dispatch({ type: 'doubleClick', point: { x, y }, modifiers, ctx: this.ctx })
    return this.effects
  }
  cancel() {
    this.effects = this.machine.dispatch({ type: 'cancel' })
    return this.effects
  }
}

function of<T extends PointerEffect['type']>(effects: PointerEffect[], type: T) {
  return effects.filter(e => e.type === type) as Extract<PointerEffect, { type: T }>[]
}

function lastProjectChange(effects: PointerEffect[]): Project {
  const changes = of(effects, 'projectChange')
  expect(changes.length).toBeGreaterThan(0)
  return changes[changes.length - 1].project
}

function visual(project: Project, id: string) {
  return trackItems(project).flat().find(i => i.id === id)!
}

function audio(project: Project, id: string) {
  return (project.audio?.tracks ?? []).find(t => t.id === id)!
}

function trackIndexOf(project: Project, id: string): number {
  return trackItems(project).findIndex(t => t.some(i => i.id === id))
}

// Coordinates the fixture makes meaningful. The Y of each row comes from the
// layout the painter itself computes, so these stay on target at any row height.
const LAYOUT = computeTimelineLayout(baseProject())
const rowMidY = (trackIdx: number) => {
  const row = LAYOUT.rows.find(r => r.trackIdx === trackIdx)!
  return Math.round(row.y + row.height / 2)
}
const BASE_Y = rowMidY(0)      // track 0, the tall base row
const OVERLAY_Y = rowMidY(1)   // track 1, stacked above it
const LANE_Y = Math.round(LAYOUT.lanes[0].y + LAYOUT.lanes[0].height / 2)

const C0_BODY = { x: 250, y: BASE_Y }
const C0_OUT_EDGE = { x: 495, y: BASE_Y }
const C1_BODY = { x: 750, y: BASE_Y }
const C1_IN_EDGE = { x: 505, y: BASE_Y }
const A0_BODY = { x: 300, y: LANE_Y }
const A0_OUT_EDGE = { x: 597, y: LANE_Y }
// The fade grips live in the TOP `FADE_GRIP_ZONE_HEIGHT_PX` of the bar, not
// its vertical centre — `LANE_Y` above is no good for them. a0 spans 1s–6s
// with no fade set, so its corners (and therefore its un-faded grips) sit at
// x=100 (start) and x=600 (end).
const FADE_GRIP_Y = Math.round(LAYOUT.lanes[0].y + AUDIO_ITEM_INSET_PX + FADE_GRIP_ZONE_HEIGHT_PX / 2)
const A0_FADE_IN_GRIP = { x: 100, y: FADE_GRIP_Y }
const A0_FADE_OUT_GRIP = { x: 600, y: FADE_GRIP_Y }
const EMPTY = { x: 700, y: OVERLAY_Y }
/** Inside the ruler strip — the only place a scrub starts now. */
const RULER_Y = Math.round(LAYOUT.ruler.y + LAYOUT.ruler.height / 2)

// `sameKindProject`'s own layout: track 1 being VIDEO-kind (not overlay)
// makes it the TALL row too (any video track is, not just track 0), which
// shifts track 0's Y down from `BASE_Y` above — so the cross-track-move
// tests that use `sameKindProject` need their own Y's, not the ones derived
// from `baseProject`. X's are unaffected (purely time-based) and are reused
// from `C1_BODY`/`C0_BODY` above.
const SAME_KIND_LAYOUT = computeTimelineLayout(sameKindProject())
const sameKindRowMidY = (trackIdx: number) => {
  const row = SAME_KIND_LAYOUT.rows.find(r => r.trackIdx === trackIdx)!
  return Math.round(row.y + row.height / 2)
}
const SAME_KIND_BASE_Y = sameKindRowMidY(0)
const SAME_KIND_TRACK1_Y = sameKindRowMidY(1)

// ── Building blocks ──────────────────────────────────────────────────────

describe('resolveGesture — the four trim-op bindings', () => {
  const ctx = makeContext()
  const bodyHit = hitTest(C0_BODY, ctx.layout, VIEWPORT)
  const edgeHit = hitTest(C0_OUT_EDGE, ctx.layout, VIEWPORT)
  const audioBodyHit = hitTest(A0_BODY, ctx.layout, VIEWPORT)
  const audioEdgeHit = hitTest(A0_OUT_EDGE, ctx.layout, VIEWPORT)

  it('plain edge-drag trims', () => {
    expect(resolveGesture(edgeHit, mods())).toBe('trim')
  })
  it('Alt + edge-drag rolls', () => {
    expect(resolveGesture(edgeHit, mods({ alt: true }))).toBe('roll')
  })
  it('plain body-drag moves', () => {
    expect(resolveGesture(bodyHit, mods())).toBe('move')
  })
  it('Alt + body-drag slips', () => {
    expect(resolveGesture(bodyHit, mods({ alt: true }))).toBe('slip')
  })
  it('Cmd or Ctrl + body-drag slides', () => {
    expect(resolveGesture(bodyHit, mods({ meta: true }))).toBe('slide')
    expect(resolveGesture(bodyHit, mods({ ctrl: true }))).toBe('slide')
  })
  it('shift does not change what a body-drag is', () => {
    expect(resolveGesture(bodyHit, mods({ shift: true }))).toBe('move')
  })
  it('audio has no roll/slip/slide, so modifiers fall through', () => {
    expect(resolveGesture(audioBodyHit, mods({ alt: true }))).toBe('audio-move')
    expect(resolveGesture(audioBodyHit, mods({ meta: true }))).toBe('audio-move')
    expect(resolveGesture(audioEdgeHit, mods({ alt: true }))).toBe('audio-trim')
  })
  it('drags out a marquee on empty timeline', () => {
    expect(resolveGesture(hitTest(EMPTY, ctx.layout, VIEWPORT), mods())).toBe('marquee')
    expect(resolveGesture(hitTest({ x: 800, y: LANE_Y }, ctx.layout, VIEWPORT), mods())).toBe('marquee')
  })
})

describe('isAdditive — the DOM selection modifier test', () => {
  it('is shift OR meta OR ctrl, and nothing else', () => {
    expect(isAdditive(mods())).toBe(false)
    expect(isAdditive(mods({ shift: true }))).toBe(true)
    expect(isAdditive(mods({ meta: true }))).toBe(true)
    expect(isAdditive(mods({ ctrl: true }))).toBe(true)
    expect(isAdditive(mods({ alt: true }))).toBe(false)
  })
})

describe('cursorForHit', () => {
  const ctx = makeContext()
  it('matches the DOM affordances', () => {
    expect(cursorForHit(hitTest(C0_BODY, ctx.layout, VIEWPORT))).toBe('grab')
    expect(cursorForHit(hitTest(C0_OUT_EDGE, ctx.layout, VIEWPORT))).toBe('ew-resize')
    expect(cursorForHit(hitTest(A0_BODY, ctx.layout, VIEWPORT))).toBe('grab')
    // Empty track area is the plain arrow, not a hand: there is nothing to
    // click there, only a selection to drag out.
    expect(cursorForHit(hitTest(EMPTY, ctx.layout, VIEWPORT))).toBe('default')
    // The ruler advertises the horizontal drag that scrubbing is.
    expect(cursorForHit(hitTest({ x: 400, y: RULER_Y }, ctx.layout, VIEWPORT))).toBe('ew-resize')
    // A fade grip is a resize too, but DIAGONAL (it sits at a top corner), so
    // you can tell it apart from an edge trim's horizontal ew-resize: the
    // fade-in grip (top-left) is nwse, the fade-out grip (top-right) is nesw.
    expect(cursorForHit(hitTest(A0_FADE_IN_GRIP, ctx.layout, VIEWPORT))).toBe('nwse-resize')
    expect(cursorForHit(hitTest(A0_FADE_OUT_GRIP, ctx.layout, VIEWPORT))).toBe('nesw-resize')
  })
})

// ── Hover ────────────────────────────────────────────────────────────────

describe('hover', () => {
  it('emits a cursor only when it changes', () => {
    const d = new Driver(makeContext())
    expect(of(d.move(C0_BODY.x, C0_BODY.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'grab' }])
    expect(d.move(C0_BODY.x + 20, C0_BODY.y)).toEqual([])
    expect(of(d.move(C0_OUT_EDGE.x, C0_OUT_EDGE.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'ew-resize' }])
    expect(of(d.move(EMPTY.x, EMPTY.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'default' }])
  })

  it('never edits anything', () => {
    const d = new Driver(makeContext())
    d.move(C0_BODY.x, C0_BODY.y)
    expect(of(d.effects, 'projectChange')).toEqual([])
    expect(of(d.effects, 'select')).toEqual([])
    expect(d.machine.state.kind).toBe('idle')
  })
})

// ── Click-to-seek and scrubbing ──────────────────────────────────────────

describe('scrub on the ruler', () => {
  it('seeks on press and starts scrubbing', () => {
    const d = new Driver(makeContext())
    const effects = d.down(EMPTY.x, RULER_Y)
    expect(of(effects, 'seek')).toEqual([{ type: 'seek', time: 7 }])
    expect(of(effects, 'cursor')).toEqual([{ type: 'cursor', cursor: 'ew-resize' }])
    expect(d.machine.state.kind).toBe('dragging')
  })

  it('clears the selection, so scrubbing drops what was selected', () => {
    // Otherwise a clip stayed selected while you scrubbed somewhere else, and
    // the next split or ripple-delete hit an item nowhere near the playhead.
    const d = new Driver(makeContext())
    expect(of(d.down(EMPTY.x, RULER_Y), 'select')).toEqual([{ type: 'select', id: null, additive: false }])
  })

  it('leaves the selection alone on an ADDITIVE press — shift builds a selection', () => {
    const d = new Driver(makeContext())
    expect(of(d.down(EMPTY.x, RULER_Y, mods({ shift: true })), 'select')).toEqual([])
  })

  it('magnetizes to a nearby boundary', () => {
    const d = new Driver(makeContext())
    // 5.1s is 10px from the c0/c1 cut — inside the attract radius.
    expect(of(d.down(510, RULER_Y), 'seek')).toEqual([{ type: 'seek', time: 5 }])
  })

  it('keeps seeking as the pointer drags, with hysteresis', () => {
    const d = new Driver(makeContext())
    d.down(505, RULER_Y)
    expect(of(d.effects, 'seek')[0].time).toBe(5)
    // 5.25s: past attract but well inside release, so it stays stuck on the cut.
    expect(of(d.move(525, RULER_Y), 'seek')).toEqual([{ type: 'seek', time: 5 }])
    // 5.6s clears release and the playhead comes free.
    expect(of(d.move(560, RULER_Y), 'seek')[0].time).toBeCloseTo(5.6)
  })

  it('clamps the playhead to the timeline', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, RULER_Y)
    expect(of(d.move(-500, RULER_Y), 'seek')).toEqual([{ type: 'seek', time: 0 }])
    expect(of(d.move(100000, RULER_Y), 'seek')[0].time).toBe(makeContext().totalDuration)
  })

  it('commits nothing when the scrub ends', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, RULER_Y)
    d.move(EMPTY.x + 50, RULER_Y)
    expect(of(d.up(EMPTY.x + 50, RULER_Y), 'commit')).toEqual([])
    expect(d.machine.state.kind).toBe('idle')
  })

  it('keeps scrubbing when the pointer drifts above the strip', () => {
    // hitTest claims everything at or above the ruler's bottom edge, so a hand
    // that rises off the surface mid-drag does not drop the gesture.
    const d = new Driver(makeContext())
    d.down(400, RULER_Y)
    expect(of(d.move(600, -30), 'seek')[0].time).toBeCloseTo(6)
  })
})

describe('empty track area — click seeks, drag selects', () => {
  it('does NOT seek on press: the same press may become a marquee', () => {
    const d = new Driver(makeContext())
    const effects = d.down(EMPTY.x, EMPTY.y)
    expect(of(effects, 'seek')).toEqual([])
    expect(of(effects, 'select')).toEqual([])
    expect(d.machine.state.kind).toBe('pressed')
  })

  it('seeks and clears the selection on a click that never moved', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, EMPTY.y)
    const effects = d.up(EMPTY.x, EMPTY.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: null, additive: false }])
    expect(of(effects, 'seek')).toEqual([{ type: 'seek', time: 7 }])
  })

  it('leaves the selection alone on an additive click', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, EMPTY.y, mods({ shift: true }))
    expect(of(d.up(EMPTY.x, EMPTY.y, mods({ shift: true })), 'select')).toEqual([])
  })

  it('draws a marquee once the press crosses the drag threshold', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, EMPTY.y)
    const effects = d.move(EMPTY.x + 60, EMPTY.y + 40)
    expect(of(effects, 'marquee')).toEqual([
      { type: 'marquee', rect: { x: EMPTY.x, y: EMPTY.y, width: 60, height: 40 } },
    ])
    expect(of(effects, 'cursor')).toEqual([{ type: 'cursor', cursor: 'crosshair' }])
    // A marquee is pure selection: it must never touch the project.
    expect(of(effects, 'projectChange')).toEqual([])
    expect(of(effects, 'seek')).toEqual([])
  })

  it('normalizes a box dragged up and to the left', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, EMPTY.y)
    const rect = of(d.move(EMPTY.x - 60, EMPTY.y - 10), 'marquee')[0].rect
    expect(rect).toEqual({ x: EMPTY.x - 60, y: EMPTY.y - 10, width: 60, height: 10 })
  })

  it('selects everything the box touched, and takes the box down, on release', () => {
    const d = new Driver(makeContext())
    // From empty overlay-row space at x=700, back across c1 (5s-10s) on the
    // base row below — a box spanning both rows.
    d.down(EMPTY.x, OVERLAY_Y)
    d.move(600, BASE_Y)
    const effects = d.up(600, BASE_Y)
    expect(of(effects, 'marquee')).toEqual([{ type: 'marquee', rect: null }])
    const selected = of(effects, 'selectMany')[0]
    expect(selected.ids).toContain('c1')
    expect(selected.additive).toBe(false)
    expect(of(effects, 'commit')).toEqual([])
  })

  it('extends the selection when the marquee is additive', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, OVERLAY_Y, mods({ shift: true }))
    d.move(600, BASE_Y, mods({ shift: true }))
    expect(of(d.up(600, BASE_Y, mods({ shift: true })), 'selectMany')[0].additive).toBe(true)
  })

  it('a cancelled marquee takes its box down and selects nothing', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, EMPTY.y)
    d.move(EMPTY.x + 60, EMPTY.y + 40)
    const effects = d.cancel()
    expect(of(effects, 'marquee')).toEqual([{ type: 'marquee', rect: null }])
    expect(of(effects, 'selectMany')).toEqual([])
  })

  it('marquees from an empty audio lane too', () => {
    const d = new Driver(makeContext())
    d.down(800, LANE_Y)
    expect(of(d.move(860, LANE_Y), 'marquee')).toHaveLength(1)
  })
})

// ── Selection ────────────────────────────────────────────────────────────

describe('selection', () => {
  it('selects on release, and seeks on a plain click of an unselected clip', () => {
    const d = new Driver(makeContext())
    expect(d.down(C0_BODY.x, C0_BODY.y)).toEqual([{ type: 'cursor', cursor: 'grab' }])
    const effects = d.up(C0_BODY.x, C0_BODY.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 'c0', additive: false }])
    expect(of(effects, 'seek')).toEqual([{ type: 'seek', time: 2.5 }])
  })

  it('does not seek when the clip was already selected', () => {
    const d = new Driver(makeContext({ selectedIds: ['c0'] }))
    d.down(C0_BODY.x, C0_BODY.y)
    const effects = d.up(C0_BODY.x, C0_BODY.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 'c0', additive: false }])
    expect(of(effects, 'seek')).toEqual([])
  })

  it('does not seek on an additive click', () => {
    for (const modifier of ['shift', 'meta', 'ctrl'] as const) {
      const d = new Driver(makeContext())
      d.down(C0_BODY.x, C0_BODY.y, mods({ [modifier]: true }))
      const effects = d.up(C0_BODY.x, C0_BODY.y, mods({ [modifier]: true }))
      expect(of(effects, 'select')).toEqual([{ type: 'select', id: 'c0', additive: true }])
      expect(of(effects, 'seek')).toEqual([])
    }
  })

  it('reads the modifier at release, as the DOM click handler does', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y, mods())
    expect(of(d.up(C0_BODY.x, C0_BODY.y, mods({ shift: true })), 'select'))
      .toEqual([{ type: 'select', id: 'c0', additive: true }])
  })

  it('selects an audio bar without seeking', () => {
    const d = new Driver(makeContext())
    d.down(A0_BODY.x, A0_BODY.y)
    const effects = d.up(A0_BODY.x, A0_BODY.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 'a0', additive: false }])
    expect(of(effects, 'seek')).toEqual([])
  })

  it('selects from a press on a trim handle that never became a drag', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    const effects = d.up(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 'c0', additive: false }])
    // …and does NOT persist a project that never changed.
    expect(of(effects, 'commit')).toEqual([])
  })

  it('does not select when the press turned into a drag', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    d.move(C0_BODY.x + 60, C0_BODY.y)
    expect(of(d.up(C0_BODY.x + 60, C0_BODY.y), 'select')).toEqual([])
  })
})

// ── Drag threshold ───────────────────────────────────────────────────────

describe('drag threshold', () => {
  it('ignores travel under 4px and still counts as a click', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    expect(d.move(C0_BODY.x + 2, C0_BODY.y + 1)).toEqual([])   // hypot ≈ 2.2
    expect(d.move(C0_BODY.x + 3, C0_BODY.y)).toEqual([])
    expect(d.machine.state.kind).toBe('pressed')
    expect(of(d.up(C0_BODY.x + 3, C0_BODY.y), 'select')).toHaveLength(1)
  })

  it('becomes a drag at 4px, counting diagonal travel', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    expect(of(d.move(C0_BODY.x + 4, C0_BODY.y), 'projectChange')).toHaveLength(1)
    expect(d.machine.state.kind).toBe('dragging')
  })

  it('applies to vertical travel too', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    expect(d.move(C0_BODY.x, C0_BODY.y + 3)).toEqual([])
    expect(of(d.move(C0_BODY.x, C0_BODY.y + 5), 'projectChange')).toHaveLength(1)
  })
})

// ── Item body drag (move) ────────────────────────────────────────────────

describe('body drag — move', () => {
  it('moves the clip and snaps its leading edge', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    const moved = visual(lastProjectChange(d.move(C0_BODY.x + 100, C0_BODY.y)), 'c0')
    expect(moved.start).toBeCloseTo(1)
    expect(moved.end).toBeCloseTo(6)
  })

  it('is not held back by the position it started from', () => {
    // c0's own 0s/5s boundaries are excluded from its magnets, so a 20px nudge
    // moves it rather than sticking it to the origin.
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    expect(visual(lastProjectChange(d.move(C0_BODY.x + 20, C0_BODY.y)), 'c0').start).toBeCloseTo(0.2)
  })

  it('clamps to the timeline at both ends', () => {
    const ctx = makeContext()
    const d = new Driver(ctx)
    d.down(C0_BODY.x, C0_BODY.y)
    expect(visual(lastProjectChange(d.move(-9999, C0_BODY.y)), 'c0').start).toBe(0)
    const far = visual(lastProjectChange(d.move(99999, C0_BODY.y)), 'c0')
    expect(far.end).toBeCloseTo(ctx.totalDuration)
  })

  it('emits one projectChange per move and one commit at release', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    expect(of(d.move(C0_BODY.x + 50, C0_BODY.y), 'projectChange')).toHaveLength(1)
    expect(of(d.move(C0_BODY.x + 60, C0_BODY.y), 'projectChange')).toHaveLength(1)
    expect(of(d.move(C0_BODY.x + 70, C0_BODY.y), 'projectChange')).toHaveLength(1)
    const committed = of(d.up(C0_BODY.x + 70, C0_BODY.y), 'commit')
    expect(committed).toHaveLength(1)
    expect(visual(committed[0].project, 'c0').start).toBeCloseTo(0.7)
  })

  it('accumulates across moves so the cross-track search sees its own work', () => {
    // `sameKindProject`: track 1 must be video-kind (not overlay) for this
    // move to land at all — see the fixture's own doc comment.
    const d = new Driver(makeContext({ project: sameKindProject() }))
    d.down(C1_BODY.x, SAME_KIND_BASE_Y)
    d.move(C1_BODY.x, SAME_KIND_BASE_Y - VISUAL_ROW_HEIGHT_PX)          // up one track
    const after = lastProjectChange(d.move(C1_BODY.x, SAME_KIND_BASE_Y - VISUAL_ROW_HEIGHT_PX))
    expect(trackIndexOf(after, 'c1')).toBe(1)
  })

  it('switches the cursor to grabbing', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    expect(of(d.move(C0_BODY.x + 50, C0_BODY.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'grabbing' }])
  })
})

describe('cross-track move', () => {
  it('moves a clip up a track when the vertical travel points there', () => {
    // `sameKindProject`: track 1 is video-kind here so the kind-lock doesn't
    // block the very move this test is about — see its own doc comment.
    const d = new Driver(makeContext({ project: sameKindProject() }))
    d.down(C1_BODY.x, SAME_KIND_BASE_Y)
    // 24px of upward travel is one track; c1 (5s–10s) doesn't collide with the
    // video o0 (2s–4s), so it lands on track 1.
    const after = lastProjectChange(d.move(C1_BODY.x, SAME_KIND_BASE_Y - VISUAL_ROW_HEIGHT_PX))
    expect(trackIndexOf(after, 'c1')).toBe(1)
    expect(visual(after, 'c1').start).toBeCloseTo(5)
  })

  it('stays where it is when the target track is occupied', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    // c0 (0s–5s) would overlap o0 (2s–4s) by 2s, past the 30%-of-duration
    // tolerance, so the outward search falls back to its own track.
    const after = lastProjectChange(d.move(C0_BODY.x, C0_BODY.y - VISUAL_ROW_HEIGHT_PX))
    expect(trackIndexOf(after, 'c0')).toBe(0)
  })

  it('tolerates a brush past a neighbour', () => {
    // A 5s clip may overlap by up to 1.5s. Drag c1 up while shifting it left so
    // it overlaps o0 (2s–4s) by only 1s. `sameKindProject`: track 1 is
    // video-kind so the kind-lock doesn't block the move before the overlap
    // tolerance this test is actually about ever gets exercised.
    const d = new Driver(makeContext({ project: sameKindProject() }))
    d.down(C1_BODY.x, SAME_KIND_BASE_Y)
    const after = lastProjectChange(d.move(C1_BODY.x - 200, SAME_KIND_BASE_Y - VISUAL_ROW_HEIGHT_PX))
    expect(visual(after, 'c1').start).toBeCloseTo(3)
    expect(trackIndexOf(after, 'c1')).toBe(1)
  })

  it('mints a new video track at the top of the video block, below any overlay track (Part B track grouping)', () => {
    // Two steps up from track 0 mints a new track past the top of the
    // existing (2-track) stack — but the result is RE-GROUPED: the new
    // track is video-kind, so it joins the video block (alongside the
    // remaining c1) ahead of the overlay track o0, rather than staying
    // "literally on top" at index 2 the way an un-grouped mint would.
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    const after = lastProjectChange(d.move(C0_BODY.x, C0_BODY.y - VISUAL_ROW_HEIGHT_PX * 2))
    expect(after.tracks).toHaveLength(3)
    expect(trackIndexOf(after, 'c0')).toBe(1)
  })

  it('prunes a track the move emptied', () => {
    // `sameKindProject`: o0 must be video-kind here — track 0 (its
    // destination) is video-only, so an overlay `o0` could never land there
    // and this test's own mechanic (the emptied track gets pruned) would
    // never get to run.
    const d = new Driver(makeContext({ project: sameKindProject() }))
    d.down(300, SAME_KIND_TRACK1_Y)                     // o0, the only item on track 1
    // Down two tracks and out past the end of the base track's content, where
    // nothing collides — so track 1 is left empty and disappears.
    const after = lastProjectChange(d.move(300 + 900, SAME_KIND_TRACK1_Y + 48))
    expect(visual(after, 'o0').start).toBeCloseTo(11)
    expect(after.tracks).toHaveLength(1)
    expect(trackIndexOf(after, 'o0')).toBe(0)
  })

  it('survives a cross-track drag on a legacy-shape project (T6 regression)', () => {
    // Before the T6 fix, applyMove passed `lastProject.tracks` straight to
    // moveItemAcrossTracks, which does `t.items.filter(...)` on every track —
    // a crash on a bare array. The call site now normalizes defensively, so
    // this must behave identically to the object-shape test above.
    // `sameKindLegacyProject`: same video-kind track 1 as `sameKindProject`,
    // just in the legacy array-of-arrays shape this test targets.
    const d = new Driver(makeContext({ project: sameKindLegacyProject() }))
    d.down(C1_BODY.x, SAME_KIND_BASE_Y)
    const after = lastProjectChange(d.move(C1_BODY.x, SAME_KIND_BASE_Y - VISUAL_ROW_HEIGHT_PX))
    expect(trackIndexOf(after, 'c1')).toBe(1)
    expect(visual(after, 'c1').start).toBeCloseTo(5)
  })
})

// ── Edge trims ───────────────────────────────────────────────────────────

describe('edge trim', () => {
  it('shortens a clip and walks its outPoint with it', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    const trimmed = visual(lastProjectChange(d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y)), 'c0')
    expect(trimmed.end).toBeCloseTo(4)
    expect(trimmed.outPoint).toBeCloseTo(4)
    expect(trimmed.start).toBe(0)
    expect(trimmed.inPoint).toBe(0)
  })

  it('walks the inPoint on an in-edge trim', () => {
    const d = new Driver(makeContext())
    d.down(C1_IN_EDGE.x, C1_IN_EDGE.y)
    const trimmed = visual(lastProjectChange(d.move(C1_IN_EDGE.x + 100, C1_IN_EDGE.y)), 'c1')
    expect(trimmed.start).toBeCloseTo(6)
    expect(trimmed.inPoint).toBeCloseTo(3)
    expect(trimmed.end).toBe(10)
  })

  it('recomputes from the pressed-at project rather than compounding', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y)
    d.move(C0_OUT_EDGE.x - 200, C0_OUT_EDGE.y)
    // Back to where it started: the clip is back to its original length, which
    // could not happen if each move applied its delta to the previous result.
    const back = visual(lastProjectChange(d.move(C0_OUT_EDGE.x, C0_OUT_EDGE.y)), 'c0')
    expect(back.end).toBeCloseTo(5)
    expect(back.outPoint).toBeCloseTo(5)
  })

  it('keeps a clip at least 0.1s long', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    expect(visual(lastProjectChange(d.move(-9999, C0_OUT_EDGE.y)), 'c0').end).toBeCloseTo(0.1)
  })

  it('shows the resize cursor while trimming', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    expect(of(d.move(C0_OUT_EDGE.x - 50, C0_OUT_EDGE.y), 'cursor')).toEqual([])  // already ew-resize
    expect(d.machine.state.cursor).toBe('ew-resize')
  })

  it('commits once at release', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y)
    const committed = of(d.up(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y), 'commit')
    expect(committed).toHaveLength(1)
    expect(visual(committed[0].project, 'c0').end).toBeCloseTo(4)
  })

  it('propagates the delta across a multi-selection', () => {
    const d = new Driver(makeContext({ selectedIds: ['c0', 'o0'] }))
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    const next = lastProjectChange(d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y))
    expect(visual(next, 'c0').end).toBeCloseTo(4)
    expect(visual(next, 'o0').end).toBeCloseTo(3)   // 4s − 1s
  })

  it('leaves unselected items alone when only one clip is selected', () => {
    const d = new Driver(makeContext({ selectedIds: ['c0'] }))
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    const next = lastProjectChange(d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y))
    expect(visual(next, 'o0').end).toBe(4)
  })
})

describe('edge trim — ripple mode', () => {
  it('closes the gap a trim opens', () => {
    const d = new Driver(makeContext({ rippleMode: true }))
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    const next = lastProjectChange(d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y))
    expect(visual(next, 'c0').end).toBeCloseTo(4)
    expect(visual(next, 'c1').start).toBeCloseTo(4)   // pulled back by 1s
    expect(visual(next, 'c1').end).toBeCloseTo(9)
  })

  it('leaves the gap open with ripple off', () => {
    const d = new Driver(makeContext({ rippleMode: false }))
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    const next = lastProjectChange(d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y))
    expect(visual(next, 'c1').start).toBe(5)
  })

  it('does not ripple a body move', () => {
    const d = new Driver(makeContext({ rippleMode: true }))
    d.down(C0_BODY.x, C0_BODY.y)
    const next = lastProjectChange(d.move(C0_BODY.x + 100, C0_BODY.y))
    expect(visual(next, 'c1').start).toBe(5)
  })
})

// ── Alt / Cmd trim ops ───────────────────────────────────────────────────

describe('Alt + edge-drag — roll', () => {
  it('moves the shared boundary, leaving both clips in place', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y, mods({ alt: true }))
    const next = lastProjectChange(d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y, mods({ alt: true })))
    expect(visual(next, 'c0').end).toBeCloseTo(4)
    expect(visual(next, 'c0').outPoint).toBeCloseTo(4)
    expect(visual(next, 'c0').start).toBe(0)
    expect(visual(next, 'c1').start).toBeCloseTo(4)
    expect(visual(next, 'c1').inPoint).toBeCloseTo(1)
    expect(visual(next, 'c1').end).toBe(10)          // the pair's span is unchanged
  })

  it('rolls the same boundary from either side', () => {
    const d = new Driver(makeContext())
    d.down(C1_IN_EDGE.x, C1_IN_EDGE.y, mods({ alt: true }))
    const next = lastProjectChange(d.move(C1_IN_EDGE.x - 100, C1_IN_EDGE.y, mods({ alt: true })))
    expect(visual(next, 'c0').end).toBeCloseTo(4)
    expect(visual(next, 'c1').start).toBeCloseTo(4)
  })

  it('does nothing when there is no adjacent neighbour', () => {
    const d = new Driver(makeContext())
    // c0's in edge has nothing before it.
    d.down(5, 60, mods({ alt: true }))
    expect(of(d.move(100, 60, mods({ alt: true })), 'projectChange')).toEqual([])
    expect(of(d.up(100, 60, mods({ alt: true })), 'commit')).toEqual([])
  })

  it('reads the modifier at press, so releasing Alt mid-drag keeps rolling', () => {
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y, mods({ alt: true }))
    const next = lastProjectChange(d.move(C0_OUT_EDGE.x - 100, C0_OUT_EDGE.y, mods()))
    expect(visual(next, 'c1').start).toBeCloseTo(4)
  })
})

describe('Alt + body-drag — slip', () => {
  it('moves the source window while the clip stays put', () => {
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y, mods({ alt: true }))
    const slipped = visual(lastProjectChange(d.move(C1_BODY.x + 100, C1_BODY.y, mods({ alt: true }))), 'c1')
    // Dragging right pulls the media right, bringing EARLIER frames into view.
    expect(slipped.inPoint).toBeCloseTo(1)
    expect(slipped.outPoint).toBeCloseTo(6)
    expect(slipped.start).toBe(5)
    expect(slipped.end).toBe(10)
  })

  it('slips the other way when dragged left', () => {
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y, mods({ alt: true }))
    const slipped = visual(lastProjectChange(d.move(C1_BODY.x - 100, C1_BODY.y, mods({ alt: true }))), 'c1')
    expect(slipped.inPoint).toBeCloseTo(3)
    expect(slipped.outPoint).toBeCloseTo(8)
  })

  it('clamps at the start of the source media', () => {
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y, mods({ alt: true }))
    const slipped = visual(lastProjectChange(d.move(C1_BODY.x + 9999, C1_BODY.y, mods({ alt: true }))), 'c1')
    expect(slipped.inPoint).toBe(0)
    expect(slipped.outPoint).toBe(5)
  })

  it('emits nothing for a clip with no source window to slip', () => {
    const d = new Driver(makeContext())
    d.down(300, OVERLAY_Y, mods({ alt: true }))          // o0, an overlay
    expect(of(d.move(400, OVERLAY_Y, mods({ alt: true })), 'projectChange')).toEqual([])
  })
})

describe('Cmd/Ctrl + body-drag — slide', () => {
  it('moves the clip and lets its neighbour absorb it', () => {
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y, mods({ meta: true }))
    const next = lastProjectChange(d.move(C1_BODY.x + 100, C1_BODY.y, mods({ meta: true })))
    expect(visual(next, 'c1').start).toBeCloseTo(6)
    expect(visual(next, 'c1').end).toBeCloseTo(11)
    expect(visual(next, 'c1').inPoint).toBe(2)     // the source window is untouched
    expect(visual(next, 'c0').end).toBeCloseTo(6)  // the neighbour grew
    expect(visual(next, 'c0').outPoint).toBeCloseTo(6)
    expect(visual(next, 'c0').start).toBe(0)
  })

  it('works with ctrl as well as meta', () => {
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y, mods({ ctrl: true }))
    expect(visual(lastProjectChange(d.move(C1_BODY.x + 100, C1_BODY.y, mods({ ctrl: true }))), 'c1').start)
      .toBeCloseTo(6)
  })

  it('clamps rather than crushing the neighbour below its minimum', () => {
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y, mods({ meta: true }))
    const next = lastProjectChange(d.move(C1_BODY.x - 9999, C1_BODY.y, mods({ meta: true })))
    expect(visual(next, 'c0').end - visual(next, 'c0').start).toBeCloseTo(0.1)
  })
})

// ── Audio ────────────────────────────────────────────────────────────────

describe('audio bar drag', () => {
  it('repositions the bar', () => {
    const d = new Driver(makeContext())
    d.down(A0_BODY.x, A0_BODY.y)
    const moved = audio(lastProjectChange(d.move(A0_BODY.x + 100, A0_BODY.y)), 'a0')
    expect(moved.start).toBeCloseTo(2)
    expect(moved.end).toBeCloseTo(7)
    expect(moved.lane).toBe(0)
  })

  it('moves the bar down a lane on downward travel', () => {
    const d = new Driver(makeContext())
    d.down(A0_BODY.x, A0_BODY.y)
    expect(audio(lastProjectChange(d.move(A0_BODY.x, A0_BODY.y + 40)), 'a0').lane).toBe(1)
  })

  it('never goes above lane 0', () => {
    const d = new Driver(makeContext())
    d.down(A0_BODY.x, A0_BODY.y)
    expect(audio(lastProjectChange(d.move(A0_BODY.x, A0_BODY.y - 200)), 'a0').lane).toBe(0)
  })

  it('commits once at release', () => {
    const d = new Driver(makeContext())
    d.down(A0_BODY.x, A0_BODY.y)
    d.move(A0_BODY.x + 100, A0_BODY.y)
    expect(of(d.up(A0_BODY.x + 100, A0_BODY.y), 'commit')).toHaveLength(1)
  })
})

describe('audio bar trim', () => {
  it('extends the bar and its source window', () => {
    const d = new Driver(makeContext())
    d.down(A0_OUT_EDGE.x, A0_OUT_EDGE.y)
    const trimmed = audio(lastProjectChange(d.move(A0_OUT_EDGE.x + 100, A0_OUT_EDGE.y)), 'a0')
    expect(trimmed.end).toBeCloseTo(7)
    expect(trimmed.outPoint).toBeCloseTo(6)
    expect(trimmed.inPoint).toBe(0)
  })

  it('walks the inPoint on an in-edge trim', () => {
    const d = new Driver(makeContext())
    d.down(103, LANE_Y)
    const trimmed = audio(lastProjectChange(d.move(203, LANE_Y)), 'a0')
    expect(trimmed.start).toBeCloseTo(2)
    expect(trimmed.inPoint).toBeCloseTo(1)
  })

  it('never trims audio with ripple, even when ripple mode is on', () => {
    const d = new Driver(makeContext({ rippleMode: true }))
    d.down(A0_OUT_EDGE.x, A0_OUT_EDGE.y)
    const next = lastProjectChange(d.move(A0_OUT_EDGE.x - 100, A0_OUT_EDGE.y))
    expect(visual(next, 'c1').start).toBe(5)
  })
})

describe('audio fade drag', () => {
  // `baseProject`'s a0 with a fade already set on one side — used by the
  // clamp/remove tests below, which need a non-zero starting value to drag
  // away from. Same track id/span, so `FADE_GRIP_Y` and the shared `LAYOUT`
  // still apply: fade values don't move the lane geometry.
  function withFadeOut(fadeOut: number): Project {
    const p = baseProject()
    return { ...p, audio: { tracks: [{ ...p.audio!.tracks[0], fadeOut }] } }
  }
  function withFadeIn(fadeIn: number): Project {
    const p = baseProject()
    return { ...p, audio: { tracks: [{ ...p.audio!.tracks[0], fadeIn }] } }
  }

  it('sets fadeIn dragging the fade-in grip inward (right)', () => {
    const d = new Driver(makeContext())
    d.down(A0_FADE_IN_GRIP.x, A0_FADE_IN_GRIP.y)
    const faded = audio(lastProjectChange(d.move(A0_FADE_IN_GRIP.x + 100, A0_FADE_IN_GRIP.y)), 'a0')
    expect(faded.fadeIn).toBeCloseTo(1)
    expect(faded.fadeOut ?? 0).toBe(0)
  })

  it('sets fadeOut dragging the fade-out grip inward (left)', () => {
    const d = new Driver(makeContext())
    d.down(A0_FADE_OUT_GRIP.x, A0_FADE_OUT_GRIP.y)
    const faded = audio(lastProjectChange(d.move(A0_FADE_OUT_GRIP.x - 150, A0_FADE_OUT_GRIP.y)), 'a0')
    expect(faded.fadeOut).toBeCloseTo(1.5)
    expect(faded.fadeIn ?? 0).toBe(0)
  })

  it('clamps fadeIn at zero — dragging outward past the corner cannot go negative', () => {
    const d = new Driver(makeContext())
    d.down(A0_FADE_IN_GRIP.x, A0_FADE_IN_GRIP.y)
    const faded = audio(lastProjectChange(d.move(A0_FADE_IN_GRIP.x - 100, A0_FADE_IN_GRIP.y)), 'a0')
    expect(faded.fadeIn).toBe(0)
  })

  it('removes an existing fadeIn when dragged back past the corner', () => {
    // fadeIn:2 puts the grip at t=1+2=3 → x=300.
    const d = new Driver(makeContext({ project: withFadeIn(2) }))
    d.down(300, FADE_GRIP_Y)
    const faded = audio(lastProjectChange(d.move(300 - 500, FADE_GRIP_Y)), 'a0')
    expect(faded.fadeIn).toBe(0)
  })

  it('clamps so fadeIn + fadeOut never exceeds the bar\'s duration', () => {
    // duration is 5s (1s–6s); fadeOut is already 3s, so fadeIn can grow to at
    // most 2s no matter how far the grip is dragged.
    const d = new Driver(makeContext({ project: withFadeOut(3) }))
    d.down(A0_FADE_IN_GRIP.x, A0_FADE_IN_GRIP.y)
    const faded = audio(lastProjectChange(d.move(A0_FADE_IN_GRIP.x + 1000, A0_FADE_IN_GRIP.y)), 'a0')
    expect(faded.fadeIn).toBeCloseTo(2)
    expect(faded.fadeOut).toBe(3)   // untouched — this drag only ever touches its own side
  })

  it('shows the diagonal fade-resize cursor while dragging a fade grip', () => {
    const d = new Driver(makeContext())
    d.down(A0_FADE_IN_GRIP.x, A0_FADE_IN_GRIP.y)
    // Already nwse-resize from the press-time hit (the fade-in grip's diagonal),
    // and the fade gesture holds that same cursor, so the move emits no change.
    expect(of(d.move(A0_FADE_IN_GRIP.x + 50, A0_FADE_IN_GRIP.y), 'cursor')).toEqual([])
    expect(d.machine.state.cursor).toBe('nwse-resize')
  })

  it('emits one projectChange per move and a single commit at release', () => {
    const d = new Driver(makeContext())
    d.down(A0_FADE_IN_GRIP.x, A0_FADE_IN_GRIP.y)
    expect(of(d.move(A0_FADE_IN_GRIP.x + 50, A0_FADE_IN_GRIP.y), 'projectChange')).toHaveLength(1)
    expect(of(d.move(A0_FADE_IN_GRIP.x + 80, A0_FADE_IN_GRIP.y), 'projectChange')).toHaveLength(1)
    const committed = of(d.up(A0_FADE_IN_GRIP.x + 80, A0_FADE_IN_GRIP.y), 'commit')
    expect(committed).toHaveLength(1)
    expect(audio(committed[0].project, 'a0').fadeIn).toBeCloseTo(0.8)
  })

  it('never disturbs the audio-trim gesture on the same bar\'s edge', () => {
    // A0_OUT_EDGE sits in the bar's full-height edge zone, well below the
    // fade grip's small top zone — the trim gesture must fire, not a fade.
    const d = new Driver(makeContext())
    d.down(A0_OUT_EDGE.x, A0_OUT_EDGE.y)
    const trimmed = audio(lastProjectChange(d.move(A0_OUT_EDGE.x + 100, A0_OUT_EDGE.y)), 'a0')
    expect(trimmed.end).toBeCloseTo(7)
    expect(trimmed.fadeIn ?? 0).toBe(0)
  })
})

describe('audio lane magnet', () => {
  // Own fixture: a lane with a real gap between two MAGNETIC clips, so a
  // commit has something to close. b0/b1 sit in lane 1, non-magnetic, purely
  // as the drag target for the cross-lane-inheritance test below.
  function magnetProject(): Project {
    return {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', start: 0, end: 10 }] }],
      audio: { tracks: [
        { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0, magnetic: true },
        { id: 'a1', src: 'm.mp3', start: 5, end: 8, lane: 0, magnetic: true },
        { id: 'b0', src: 'n.mp3', start: 5, end: 7, lane: 1 },
      ] },
    } as unknown as Project
  }

  const project = magnetProject()
  const layout = computeTimelineLayout(project)
  const lane0Y = Math.round(layout.lanes[0].y + layout.lanes[0].height / 2)
  const lane1Y = Math.round(layout.lanes[1].y + layout.lanes[1].height / 2)

  it('leaves the mid-drag (projectChange) frames alone — reflow is commit-only', () => {
    const d = new Driver(makeContext({ project: magnetProject() }))
    // a0 spans [0,2] → body inside that span.
    d.down(50, lane0Y)
    // +1.5s: still short of a1 (start 5), and far enough from every snap
    // candidate ({-2,0,3,5,6,8,10}, all >0.2s away) not to get caught.
    const mid = lastProjectChange(d.move(200, lane0Y))
    expect(audio(mid, 'a0').start).toBeCloseTo(1.5)
    expect(audio(mid, 'a1').start).toBe(5) // untouched mid-drag — a real gap still exists
  })

  it('snaps the magnetic lane gapless on release, leaving a non-magnetic lane alone', () => {
    const d = new Driver(makeContext({ project: magnetProject() }))
    d.down(50, lane0Y)
    d.move(200, lane0Y)
    const committed = of(d.up(200, lane0Y), 'commit')
    expect(committed).toHaveLength(1)
    const out = committed[0].project
    const finalA0 = audio(out, 'a0')
    const finalA1 = audio(out, 'a1')
    expect(finalA0.start).toBeCloseTo(1.5)
    expect(finalA0.end).toBeCloseTo(3.5)
    expect(finalA1.start).toBeCloseTo(finalA0.end) // gap closed, duration (3) preserved
    expect(finalA1.end).toBeCloseTo(6.5)
    // b0's lane (1) carries no magnetic clip — untouched by the same commit.
    expect(audio(out, 'b0')).toMatchObject({ start: 5, end: 7 })
  })

  it('a clip dragged onto a magnetic lane adopts that lane\'s magnet state', () => {
    const d = new Driver(makeContext({ project: magnetProject() }))
    // b0 spans [5,7] in lane 1 → body inside that span.
    d.down(600, lane1Y)
    // Straight up one lane (dy = -AUDIO_LANE_HEIGHT_PX), no horizontal travel:
    // destLane = max(0, 1 + round(-40/40)) = 0, which holds only a0/a1 —
    // both magnetic — so b0 should adopt magnetic: true.
    const mid = lastProjectChange(d.move(600, lane1Y - 40))
    const movedB0 = audio(mid, 'b0')
    expect(movedB0.lane).toBe(0)
    expect(movedB0.magnetic).toBe(true)
  })

  it('a clip dragged onto an EMPTY lane leaves magnetic untouched', () => {
    const d = new Driver(makeContext({ project: magnetProject() }))
    d.down(600, lane1Y)
    // Straight down one lane, into lane 2 — nothing lives there yet.
    const mid = lastProjectChange(d.move(600, lane1Y + 40))
    const movedB0 = audio(mid, 'b0')
    expect(movedB0.lane).toBe(2)
    expect(movedB0.magnetic).toBeUndefined()
  })
})

// ── Inspection ───────────────────────────────────────────────────────────

describe('double-click', () => {
  // Double-clicking bare timeline used to place the A/B range markers. That
  // feature is gone: background double-clicks now emit nothing at all, and a
  // clip or audio bar still opens its inspector.
  it('does nothing on empty timeline', () => {
    const d = new Driver(makeContext())
    expect(d.doubleClick(700, 20)).toEqual([])
  })

  it('does nothing on an empty audio lane', () => {
    const d = new Driver(makeContext())
    expect(d.doubleClick(800, LANE_Y)).toEqual([])
  })

  it('does nothing past the end of the timeline', () => {
    const d = new Driver(makeContext())
    expect(d.doubleClick(-100, 20)).toEqual([])
  })

  it('opens the clip inspector on a clip', () => {
    const d = new Driver(makeContext())
    const effects = d.doubleClick(C0_BODY.x, C0_BODY.y)
    expect(effects).toEqual([{ type: 'inspect', target: 'visual', id: 'c0' }])
  })

  it('opens the audio inspector on a bar', () => {
    const d = new Driver(makeContext())
    expect(d.doubleClick(A0_BODY.x, A0_BODY.y)).toEqual([{ type: 'inspect', target: 'audio', id: 'a0' }])
  })
})

describe('no row is ever inert', () => {
  // Rows used to fade and go `pointer-events-none` on every track that didn't
  // hold the selection while a marker was down. With markers gone, nothing
  // dims for selection reasons and every row stays clickable.
  it('selects a clip on a track that holds none of the selection', () => {
    const d = new Driver(makeContext({ selectedIds: ['c0'] }))
    // o0 lives on track 1, which holds no part of the selection.
    d.down(300, OVERLAY_Y)
    expect(of(d.up(300, OVERLAY_Y), 'select')).toEqual([{ type: 'select', id: 'o0', additive: false }])
  })

  it('keeps the row holding the selection live', () => {
    const d = new Driver(makeContext({ selectedIds: ['c0'] }))
    d.down(C0_BODY.x, C0_BODY.y)
    expect(of(d.up(C0_BODY.x, C0_BODY.y), 'select')).toEqual([{ type: 'select', id: 'c0', additive: false }])
  })

  it('keeps audio lanes live', () => {
    const d = new Driver(makeContext({ selectedIds: ['c0'] }))
    d.down(A0_BODY.x, A0_BODY.y)
    expect(of(d.up(A0_BODY.x, A0_BODY.y), 'select')).toEqual([{ type: 'select', id: 'a0', additive: false }])
  })
})

// ── Interruption and degenerate state ────────────────────────────────────

describe('cancel', () => {
  it('drops a gesture without committing', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    d.move(C0_BODY.x + 100, C0_BODY.y)
    expect(of(d.cancel(), 'commit')).toEqual([])
    expect(d.machine.state.kind).toBe('idle')
  })

  it('resets the cursor', () => {
    const d = new Driver(makeContext())
    d.move(C0_BODY.x, C0_BODY.y)
    expect(of(d.cancel(), 'cursor')).toEqual([{ type: 'cursor', cursor: 'default' }])
  })

  it('leaves a released gesture alone', () => {
    const d = new Driver(makeContext())
    expect(d.cancel()).toEqual([])
  })
})

// ── Press-time snap boundaries (self-snap regression) ────────────────────

describe('press-time snap boundaries — echoed-project self-snap', () => {
  // Live bug: VideoEditor echoes every `projectChange` back through Timeline's
  // re-render, and Timeline's `computeDerivedTiming` memo recomputes
  // `snapBoundaries` from THAT echoed project. Mid-gesture the boundary list
  // therefore contains the dragged item's own CURRENT (moved) edges, not just
  // the edges it started from. If a gesture read `ctx.snapBoundaries` live it
  // would find its last position back in its own magnet list and snap to
  // itself — repeatedly, since every subsequent move re-derives the same
  // trap. These tests drive the machine exactly the way Timeline does: apply
  // each `projectChange` to a running project and rebuild `snapBoundaries`
  // from it before the next move, the way the real memo would.
  function threeClipProject(): Project {
    return {
      id: 'p3',
      tracks: [
        {
          id: 'trk-0',
          items: [
            { id: 'x0', type: 'video', src: 'a.mp4', start: 0, end: 3, inPoint: 0, outPoint: 3, sourceDuration: 20 },
            { id: 'x1', type: 'video', src: 'b.mp4', start: 3, end: 6, inPoint: 0, outPoint: 3, sourceDuration: 20 },
            { id: 'x2', type: 'video', src: 'c.mp4', start: 6, end: 9, inPoint: 0, outPoint: 3, sourceDuration: 20 },
          ],
        },
      ],
    } as unknown as Project
  }

  /** Timeline's live memo, reproduced: fold the latest `projectChange` into a
   *  running project and rebuild `snapBoundaries` (and `totalDuration`) from
   *  it, exactly as `computeDerivedTiming` would on the next render. */
  function echoProjectChange(ctx: PointerContext, effects: PointerEffect[]): PointerContext {
    const changes = of(effects, 'projectChange')
    if (changes.length === 0) return ctx
    const project = changes[changes.length - 1].project
    const derived = computeDerivedTiming(project)
    return { ...ctx, project, snapBoundaries: derived.snapBoundaries, totalDuration: derived.totalDuration }
  }

  it('tracks the cursor through a body drag instead of magnetizing to its own echoed position', () => {
    const project = threeClipProject()
    const layout = computeTimelineLayout(project)
    const row = layout.rows.find(r => r.trackIdx === 0)!
    const y = row.y + row.height / 2
    const bodyX = 4 * VIEWPORT.pxPerSecond // inside x1's body (3s–6s), clear of both edge handles

    const d = new Driver(makeContext({ project }))
    d.down(bodyX, y)

    const starts: number[] = []
    for (let i = 1; i <= 12; i++) {
      const effects = d.move(bodyX + i * 4, y)
      d.ctx = echoProjectChange(d.ctx, effects)
      starts.push(visual(lastProjectChange(effects), 'x1').start)
    }

    // Must track the cursor — not plateau at an echoed position and jump.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1] - 1e-9)
    }
    expect(new Set(starts.map(s => s.toFixed(6))).size).toBeGreaterThanOrEqual(10)
    expect(starts[starts.length - 1]).toBeCloseTo(3 + 48 / VIEWPORT.pxPerSecond, 6)
  })

  it('tracks the cursor through an edge trim instead of freezing at its own echoed position', () => {
    const project = threeClipProject()
    const layout = computeTimelineLayout(project)
    const row = layout.rows.find(r => r.trackIdx === 0)!
    const y = row.y + row.height / 2
    const endEdgeX = 6 * VIEWPORT.pxPerSecond - 2 // inside x1's out-edge handle (end = 6s)

    const d = new Driver(makeContext({ project }))
    d.down(endEdgeX, y)

    const ends: number[] = []
    for (let i = 1; i <= 5; i++) {
      const effects = d.move(endEdgeX - i * 4, y)
      d.ctx = echoProjectChange(d.ctx, effects)
      ends.push(visual(lastProjectChange(effects), 'x1').end)
    }

    // Must not freeze at the first applied position.
    expect(new Set(ends.map(e => e.toFixed(6))).size).toBeGreaterThanOrEqual(5)
    expect(ends[ends.length - 1]).toBeCloseTo(6 - 20 / VIEWPORT.pxPerSecond, 6)
  })
})

// ── The snap guide ───────────────────────────────────────────────────────
//
// The magnet is deliberately hard to escape (44px of release against 20px of
// attract), which is only usable because the guide says where you are held.
// These tests are the contract between the two: the machine reports the
// BOUNDARY and its tier, once per change, and takes it down the moment the
// gesture ends.

const guide = (time: number | null, strength: 'strong' | 'weak' | null) =>
  [{ type: 'snapGuide', time, strength }]

describe('snap guide', () => {
  it('raises a guide on capture and drops it on release, once each', () => {
    const d = new Driver(makeContext())

    // Pressing at 5.05s captures the cut at 5. A scrub tiers everything
    // strong: the playhead belongs to no row, so it has no "own track".
    d.down(505, RULER_Y)
    expect(of(d.effects, 'snapGuide')).toEqual(guide(5, 'strong'))

    // Still held at 5.25s — past attract, well inside release. The guide has
    // not MOVED, so nothing is emitted: a drag held against one boundary must
    // not spray an effect per pointer event.
    expect(of(d.move(525, RULER_Y), 'snapGuide')).toEqual([])

    // 5.6s clears release.
    expect(of(d.move(560, RULER_Y), 'snapGuide')).toEqual(guide(null, null))
    // …and stays down without re-announcing itself.
    expect(of(d.move(580, RULER_Y), 'snapGuide')).toEqual([])
  })

  it('takes the guide down when a gesture ends still snapped', () => {
    const d = new Driver(makeContext())
    d.down(505, RULER_Y)
    expect(of(d.up(505, RULER_Y), 'snapGuide')).toEqual(guide(null, null))
  })

  it('takes the guide down on a cancelled gesture', () => {
    const d = new Driver(makeContext())
    d.down(505, RULER_Y)
    expect(of(d.cancel(), 'snapGuide')).toEqual(guide(null, null))
  })

  it('marks the boundary a dragged clip\'s TAIL caught, not its start', () => {
    // o0 is 2s–4s on track 1. Dragged one second right its END lands exactly
    // on track 0's cut at 5 — the magnet's snap point is the START it implies
    // (3), which is a whole clip away from the edge the user is watching.
    const d = new Driver(makeContext())
    d.down(300, OVERLAY_Y)
    expect(of(d.move(400, OVERLAY_Y), 'snapGuide')).toEqual(guide(5, 'weak'))
  })

  it('marks the boundary a dragged clip\'s HEAD caught', () => {
    // Same clip one second left: its start lands on the audio bar's start at 1.
    const d = new Driver(makeContext())
    d.down(300, OVERLAY_Y)
    expect(of(d.move(200, OVERLAY_Y), 'snapGuide')).toEqual(guide(1, 'weak'))
  })

  it('marks a same-track trim as strong', () => {
    // c0's out edge pulled all the way out to c1's end at 10 — the same row,
    // so the full magnet and a bold guide.
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    expect(of(d.move(995, C0_OUT_EDGE.y), 'snapGuide')).toEqual(guide(10, 'strong'))
  })

  it('marks a cross-track trim as weak', () => {
    // Same gesture, aimed instead at o0's end at 4 — one row up. It still
    // catches, because 4.05 is 5px away and the weak radius is 6, but it
    // announces itself as the hint it is.
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    expect(of(d.move(400, C0_OUT_EDGE.y), 'snapGuide')).toEqual(guide(4, 'weak'))
  })

  it('lets a cross-track boundary go by at a distance a same-track one would hold', () => {
    // 4.10 is 10px from o0's end: inside the strong radius, outside the weak
    // one. Before the tiers this snapped, and dragging the base video track
    // past a busy overlay row was a fight.
    const d = new Driver(makeContext())
    d.down(C0_OUT_EDGE.x, C0_OUT_EDGE.y)
    expect(of(d.move(410, C0_OUT_EDGE.y), 'snapGuide')).toEqual([])
  })

  it('shows no guide when the op refuses to put the edge where the magnet asked', () => {
    // o0's out edge dragged back past its own start: the magnet catches t=0,
    // but a clip cannot be shorter than 0.1s, so the edge lands at 2.1 and the
    // alignment never happens. A guide at 0 would be pointing at nothing.
    const d = new Driver(makeContext())
    d.down(397, OVERLAY_Y)
    expect(of(d.move(2, OVERLAY_Y), 'snapGuide')).toEqual([])
  })

  it('tiers audio by LANE, so two bars sharing a lane pull on each other', () => {
    // Lanes, not tracks: a lane can hold several bars and reads as one row, and
    // a bar with no explicit `lane` gets an auto-assigned one. Reading
    // `track.lane ?? 0` instead of grouping would file every unlabelled bar
    // under lane 0 and call them all same-lane.
    const project = {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 12, inPoint: 0, outPoint: 12, sourceDuration: 20 }] }],
      audio: {
        tracks: [
          { id: 'a0', src: 'v.mp3', start: 1, end: 6, lane: 0 },
          { id: 'a1', src: 'w.mp3', start: 8, end: 11, lane: 0 },
          { id: 'b0', src: 'm.mp3', start: 3, end: 4, lane: 1 },
        ],
      },
    } as unknown as Project
    const ctx = makeContext({ project })
    const lane0 = ctx.layout.lanes.find(l => l.laneIndex === 0)!
    const y = Math.round(lane0.y + lane0.height / 2)

    // a0's out edge (t=6, x=600) dragged to 8.1 — a1's start, same lane. 10px
    // out, so only the strong radius can reach it.
    const strongDrag = new Driver(ctx)
    strongDrag.down(597, y)
    expect(of(strongDrag.move(810, y), 'snapGuide')).toEqual(guide(8, 'strong'))

    // The same edge dragged to 4.04 — b0's end, one lane down, 4px out. It
    // catches, but only just, and announces itself as the hint it is.
    const weakDrag = new Driver(ctx)
    weakDrag.down(597, y)
    expect(of(weakDrag.move(401, y), 'snapGuide')).toEqual(guide(4, 'weak'))
  })

  it('never guides a slip, which has no timeline snap points at all', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y, mods({ alt: true }))
    expect(of(d.move(C0_BODY.x + 100, C0_BODY.y, mods({ alt: true })), 'snapGuide')).toEqual([])
  })
})

describe('degenerate context', () => {
  it('edits nothing before the surface has a scale', () => {
    const unscaled: Viewport = { pxPerSecond: 0, scrollSeconds: 0, widthPx: 0 }
    const d = new Driver(makeContext({ viewport: unscaled }))
    // Every clip collapses to zero width, so a press lands on empty track area.
    d.down(0, 60)
    expect(of(d.move(200, 60), 'projectChange')).toEqual([])
  })

  it('starts idle with the default cursor', () => {
    expect(initialMachineState()).toEqual({ kind: 'idle', cursor: 'default' })
  })

  it('is a pure reducer — the same input twice gives the same output', () => {
    const ctx = makeContext()
    const event = { type: 'pointerDown' as const, point: { x: 700, y: 20 }, modifiers: NO_MODIFIERS, ctx }
    const a = pointerReducer(initialMachineState(), event)
    const b = pointerReducer(initialMachineState(), event)
    expect(a.effects).toEqual(b.effects)
    expect(a.state).toEqual(b.state)
  })

  it('never mutates the project it is given', () => {
    const ctx = makeContext()
    const before = JSON.stringify(ctx.project)
    const d = new Driver(ctx)
    d.down(C0_BODY.x, C0_BODY.y)
    d.move(C0_BODY.x + 100, C0_BODY.y)
    d.up(C0_BODY.x + 100, C0_BODY.y)
    expect(JSON.stringify(ctx.project)).toBe(before)
  })
})


// ── Butted neighbours (the narration-snapping regression) ────────────────

/**
 * Voice-over is recorded as takes that butt end-to-end, so a voice clip's start
 * is numerically equal to its neighbour's end. Snap origins used to be excluded
 * by VALUE, which deleted the neighbour's boundary along with the clip's own —
 * handing every butted clip a timeline whose one useful magnet had been quietly
 * removed. Excluding by identity keeps the neighbour; `originGuard` suppresses
 * it only while the gesture is still sitting on it.
 */
describe('butted neighbours snap back', () => {
  /** Two audio bars sharing lane 0, butted at `join`, over a video bed. */
  function butted(join: number, secondEnd: number): Project {
    return {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 30, inPoint: 0, outPoint: 30, sourceDuration: 60 },
      ] }],
      audio: { tracks: [
        { id: 'vo1', src: 'vo1.wav', start: 0, end: join, lane: 0 },
        { id: 'vo2', src: 'vo2.wav', start: join, end: secondEnd, lane: 0 },
      ] },
    } as unknown as Project
  }

  /** Grab vo2's body, optionally pull well clear first, then land its start at
   *  `landAt` seconds. `viaEscape` is what a real drag away-and-back does; the
   *  origin boundary only re-arms once the gesture has cleared it. */
  function dragVo2(
    ctx: PointerContext, grabT: number, from: number, landAt: number,
    { viaEscape = true } = {},
  ) {
    const lane = ctx.layout.lanes[0]
    const y = Math.round(lane.y + lane.height / 2)
    const d = new Driver(ctx)
    const originX = grabT * 100
    d.down(originX, y)
    if (viaEscape) d.move(originX + 300, y)     // 300px out, far past the 44px release
    return d.move(originX + (landAt - from) * 100, y)
  }

  it('snaps a butted bar back onto its neighbour once pulled clear', () => {
    const project = butted(4, 9)
    const ctx = makeContext({ project, viewport: VIEWPORT, ...computeDerivedTiming(project) })
    // Grabbed at t=6, aiming vo2's start at 4.08 — 8px past vo1's end, well
    // inside the strong radius and well outside the release radius of the
    // origin it started on, so the boundary is armed.
    const effects = dragVo2(ctx, 6, 4, 4.08)
    expect(audio(lastProjectChange(effects), 'vo2').start).toBe(4)
    expect(of(effects, 'snapGuide')).toEqual(guide(4, 'strong'))
  })

  it('still lets a butted bar start moving without a 44px fight', () => {
    // The origin is suppressed while the gesture sits on it, so the first small
    // drag moves the clip rather than being swallowed by the magnet.
    const project = butted(4, 9)
    const ctx = makeContext({ project, viewport: VIEWPORT, ...computeDerivedTiming(project) })
    const effects = dragVo2(ctx, 6, 4, 4.12, { viaEscape: false })
    expect(audio(lastProjectChange(effects), 'vo2').start).toBeCloseTo(4.12)
  })

  it('a gapped neighbour was always fine, and still is', () => {
    const project = butted(4, 9)
    ;(project.audio!.tracks as unknown as Array<Record<string, unknown>>)[1] = {
      id: 'vo2', src: 'vo2.wav', start: 5, end: 10, lane: 0,
    }
    const ctx = makeContext({ project, viewport: VIEWPORT, ...computeDerivedTiming(project) })
    expect(audio(lastProjectChange(dragVo2(ctx, 7, 5, 4.08)), 'vo2').start).toBe(4)
  })

  it('a bar never snaps to its own edges — only to a real neighbour', () => {
    // vo2 alone in its lane: pulled clear of the origin there is nothing at 4
    // for it to catch, so it lands exactly where it was put.
    const project = {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 30, inPoint: 0, outPoint: 30, sourceDuration: 60 },
      ] }],
      audio: { tracks: [{ id: 'vo2', src: 'vo2.wav', start: 4, end: 9, lane: 0 }] },
    } as unknown as Project
    const ctx = makeContext({ project, viewport: VIEWPORT, ...computeDerivedTiming(project) })
    expect(audio(lastProjectChange(dragVo2(ctx, 6, 4, 4.08)), 'vo2').start).toBeCloseTo(4.08)
  })

  it('applies to butted VIDEO clips too — the same bug, less often seen', () => {
    // c0 0-5 and c1 5-10 are butted on track 0. Drag c1 left toward 5.08.
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y)
    const effects = d.move(C1_BODY.x - (5 - 5.08) * 100 - 300, C1_BODY.y)
    // Pulled well clear (3s left), then the assertion that matters is simply
    // that c0's end is a live magnet rather than having been filtered away.
    const boundaries = of(effects, 'snapGuide')
    expect(boundaries.length).toBeGreaterThanOrEqual(0)
    const d2 = new Driver(makeContext())
    d2.down(C1_BODY.x, C1_BODY.y)
    d2.move(C1_BODY.x - 300, C1_BODY.y)                    // break away
    const back = d2.move(C1_BODY.x + (5.08 - 5) * 100 - 0, C1_BODY.y)  // return to 5.08
    expect(visual(lastProjectChange(back), 'c1').start).toBe(5)
  })
})

// ── Playhead grab ──────────────────────────────────────────────────────────
// Grabbing the full-height playhead line anywhere it is reachable scrubs, on
// the same path the ruler uses. The fixture playhead sits at x = playheadTime
// × 100 (100px/s, no scroll).
describe('playhead grab', () => {
  it('grabs the playhead through a clip body and scrubs from the press', () => {
    // Playhead at x=700, inside c1's body (x 500–1000).
    const d = new Driver(makeContext({ playheadTime: 7 }))
    const eff = d.down(700, BASE_Y)
    const st = d.machine.state
    expect(st.kind).toBe('dragging')
    if (st.kind === 'dragging') expect(st.gesture).toBe('scrub')
    expect(of(eff, 'seek').length).toBeGreaterThan(0)
    expect(of(d.move(760, BASE_Y), 'seek').length).toBeGreaterThan(0)
  })

  it('does not clear the selection when grabbing the playhead (D3)', () => {
    const d = new Driver(makeContext({ playheadTime: 7, selectedIds: ['c1'] }))
    expect(of(d.down(700, BASE_Y), 'select')).toEqual([])
  })

  it('yields to a trim edge: a handle under the playhead still trims (D1)', () => {
    // Playhead at x=505, right on c1's in-edge handle.
    const d = new Driver(makeContext({ playheadTime: 5.05 }))
    d.down(C1_IN_EDGE.x, C1_IN_EDGE.y)
    expect(d.machine.state.kind).toBe('pressed')          // not a scrub
    d.move(C1_IN_EDGE.x + 20, C1_IN_EDGE.y)
    const st = d.machine.state
    expect(st.kind).toBe('dragging')
    if (st.kind === 'dragging') expect(st.gesture).toBe('trim')
  })

  it('an empty press away from the playhead is still a press, not a scrub', () => {
    const d = new Driver(makeContext({ playheadTime: 1 }))  // playhead at x=100
    d.down(EMPTY.x, EMPTY.y)                                 // x=700, far away
    expect(d.machine.state.kind).toBe('pressed')
  })

  it('hovering the playhead shows the scrub cursor (D2)', () => {
    const d = new Driver(makeContext({ playheadTime: 7 }))
    expect(of(d.move(700, BASE_Y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'ew-resize' }])
  })

  it('the ruler still clears the selection, unlike a playhead grab', () => {
    const d = new Driver(makeContext({ selectedIds: ['c1'] }))
    expect(of(d.down(400, RULER_Y), 'select')).toEqual([{ type: 'select', id: null, additive: false }])
  })
})

// ── Multi-select move: the selection travels as one ────────────────────────
describe('multi-select move', () => {
  it('shifts every selected item by one delta, preserving the gaps', () => {
    const d = new Driver(makeContext({ selectedIds: ['c0', 'c1'] }))
    d.down(C0_BODY.x, C0_BODY.y)
    const eff = d.move(C0_BODY.x + 120, C0_BODY.y)
    // A group move never re-selects — the selection is preserved as-is.
    expect(of(eff, 'selectMany')).toEqual([])
    const proj = lastProjectChange(eff)
    const c0 = visual(proj, 'c0'), c1 = visual(proj, 'c1')
    const delta = c0.start - 0
    expect(delta).toBeGreaterThan(0)
    expect(c1.start - 5).toBeCloseTo(delta)     // c1 shifted by the SAME delta
    expect(c0.end - c0.start).toBeCloseTo(5)    // durations preserved
    expect(c1.end - c1.start).toBeCloseTo(5)
  })

  it('a drag on an item NOT in the selection selects just it and moves it alone', () => {
    const d = new Driver(makeContext({ selectedIds: ['c1'] }))
    d.down(C0_BODY.x, C0_BODY.y)                 // press c0, which is not selected
    const eff = d.move(C0_BODY.x + 120, C0_BODY.y)
    expect(of(eff, 'selectMany')).toEqual([{ type: 'selectMany', ids: ['c0'], additive: false }])
    const proj = lastProjectChange(eff)
    expect(visual(proj, 'c0').start).toBeGreaterThan(0)   // c0 moved
    expect(visual(proj, 'c1').start).toBe(5)               // c1 untouched
  })

  it('clamps the group as a body so no member leaves the timeline', () => {
    // c0 already starts at 0, so dragging the pair hard left cannot move it.
    const d = new Driver(makeContext({ selectedIds: ['c0', 'c1'] }))
    d.down(C0_BODY.x, C0_BODY.y)
    const changes = of(d.move(C0_BODY.x - 300, C0_BODY.y), 'projectChange')
    if (changes.length) {
      const proj = changes[changes.length - 1].project
      expect(visual(proj, 'c0').start).toBe(0)
      expect(visual(proj, 'c1').start).toBe(5)
    }
  })
})

// ── Captions ─────────────────────────────────────────────────────────────
//
// Caption blocks live in the canvas timeline now, and behave exactly like
// overlay clips: click to select, drag the body to re-time, drag an edge to
// trim, group-move with whatever else is selected. Their ids share the ONE
// `selectedIds` array with clips and audio, which is what makes a mixed
// clip+caption drag land as a single undo.
//
// Its own fixture — one clip and a caption band, nothing else — so the base
// project's row geometry above stays exactly as those tests assume:
//
//   band caption s0 1s–2s (with word timings), s1 3.44s–4.5s, one id-less
//   row  track 0 — c0 0s–10s
//
// s1's start is 3.44 on purpose: at 30fps that is frame 103.2, the fractional
// part below 0.5 that makes the naive seek-to-`start` land in the PREVIOUS
// segment. See the click-seek suite.

const CAPTION_FPS = 30

function captionProject(): Project {
  return {
    id: 'p',
    tracks: [{
      id: 'trk-0',
      items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }],
    }],
    captions: {
      style: 'pop',
      segments: [
        {
          id: 's0',
          text: 'hello there',
          start: 1,
          end: 2,
          words: [
            { word: 'hello', start: 1, end: 1.6 },
            { word: 'there', start: 1.6, end: 2 },
          ],
        },
        { id: 's1', text: 'second', start: 3.44, end: 4.5 },
        // No id yet — `backfillCaptionIds` has not run. Never hittable.
        { text: 'unminted', start: 7, end: 8 },
      ],
    },
  } as unknown as Project
}

const CAPTION_LAYOUT = computeTimelineLayout(captionProject())
const CAPTION_Y = Math.round(CAPTION_LAYOUT.captions![0].y + CAPTION_LAYOUT.captions![0].height / 2)

const S0_BODY = { x: 150, y: CAPTION_Y }
const S0_IN_EDGE = { x: 102, y: CAPTION_Y }
const S0_OUT_EDGE = { x: 198, y: CAPTION_Y }
const S1_BODY = { x: 400, y: CAPTION_Y }
/** s1's in handle (s1 spans x 344–450). */
const S1_IN_EDGE = { x: 346, y: CAPTION_Y }
/** Over the id-less segment (x 700–800), which is band background. */
const UNMINTED = { x: 750, y: CAPTION_Y }
/** The gap between s0 and s1. */
const CAPTION_GAP = { x: 260, y: CAPTION_Y }

function captionCtx(overrides: Partial<PointerContext> = {}): PointerContext {
  return makeContext({ project: captionProject(), fps: CAPTION_FPS, ...overrides })
}

function caption(project: Project, id: string) {
  return (project.captions?.segments ?? []).find(s => s.id === id)!
}

describe('caption gestures — resolution and affordances', () => {
  const ctx = captionCtx()
  const bodyHit = hitTest(S0_BODY, ctx.layout, VIEWPORT)
  const edgeHit = hitTest(S0_OUT_EDGE, ctx.layout, VIEWPORT)

  it('a body-drag re-times and an edge-drag trims', () => {
    expect(resolveGesture(bodyHit, mods())).toBe('caption-move')
    expect(resolveGesture(edgeHit, mods())).toBe('caption-trim')
  })

  it('has no roll/slip/slide, so modifiers fall through as they do for audio', () => {
    expect(resolveGesture(bodyHit, mods({ alt: true }))).toBe('caption-move')
    expect(resolveGesture(bodyHit, mods({ meta: true }))).toBe('caption-move')
    expect(resolveGesture(edgeHit, mods({ alt: true }))).toBe('caption-trim')
  })

  it('shows the resize cursor on an edge and the grab cursor on a body', () => {
    expect(cursorForHit(edgeHit)).toBe('ew-resize')
    expect(cursorForHit(bodyHit)).toBe('grab')
  })

  it('switches to the gesture cursor once the drag starts', () => {
    const move = new Driver(captionCtx())
    move.down(S0_BODY.x, S0_BODY.y)
    expect(of(move.move(S0_BODY.x + 50, S0_BODY.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'grabbing' }])

    // A trim PRESS already set `ew-resize` from the hit, and the gesture's own
    // cursor is the same one — so the machine says nothing more, because it
    // only speaks up when the cursor actually changes.
    const trim = new Driver(captionCtx())
    expect(of(trim.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'ew-resize' }])
    expect(of(trim.move(S0_OUT_EDGE.x + 50, S0_OUT_EDGE.y), 'cursor')).toEqual([])
    expect(trim.machine.state.cursor).toBe('ew-resize')
  })
})

describe('caption click — select, and seek half a frame IN', () => {
  it('selects on release and seeks to start + half a frame', () => {
    const d = new Driver(captionCtx())
    d.down(S1_BODY.x, S1_BODY.y)
    const effects = d.up(S1_BODY.x, S1_BODY.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 's1', additive: false }])
    expect(of(effects, 'seek')).toEqual([{ type: 'seek', time: 3.44 + 0.5 / CAPTION_FPS }])
  })

  it('lands inside the segment once the preview snaps the clock to the frame grid', () => {
    // The regression this exists for. CaptionPreview runs
    // `t = Math.round(currentTime * fps) / fps` before the templates' own
    // `t >= start && t < end` test, and 3.44 × 30 = 103.2 rounds DOWN.
    const snapToGrid = (t: number) => Math.round(t * CAPTION_FPS) / CAPTION_FPS
    expect(snapToGrid(3.44)).toBeLessThan(3.44)                    // seeking to `start` misses
    const d = new Driver(captionCtx())
    d.down(S1_BODY.x, S1_BODY.y)
    const seeked = of(d.up(S1_BODY.x, S1_BODY.y), 'seek')[0].time
    expect(snapToGrid(seeked)).toBeGreaterThanOrEqual(3.44)         // half a frame in does not
    expect(snapToGrid(seeked)).toBeLessThan(4.5)
  })

  it('seeks to the segment start, NOT to where the pointer clicked', () => {
    // x=400 is t=4, well inside s1 — a visual clip would seek there.
    const d = new Driver(captionCtx())
    d.down(S1_BODY.x, S1_BODY.y)
    expect(of(d.up(S1_BODY.x, S1_BODY.y), 'seek')[0].time).not.toBeCloseTo(4)
  })

  it('does not seek when the caption was already selected', () => {
    const d = new Driver(captionCtx({ selectedIds: ['s1'] }))
    d.down(S1_BODY.x, S1_BODY.y)
    const effects = d.up(S1_BODY.x, S1_BODY.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 's1', additive: false }])
    expect(of(effects, 'seek')).toEqual([])
  })

  it('does not seek on an additive click', () => {
    const d = new Driver(captionCtx())
    d.down(S1_BODY.x, S1_BODY.y, mods({ shift: true }))
    const effects = d.up(S1_BODY.x, S1_BODY.y, mods({ shift: true }))
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 's1', additive: true }])
    expect(of(effects, 'seek')).toEqual([])
  })

  it('selects from a press on a trim handle that never became a drag', () => {
    const d = new Driver(captionCtx())
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    const effects = d.up(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: 's0', additive: false }])
    expect(of(effects, 'commit')).toEqual([])
  })

  it('treats a gap in the band as background: clears the selection and seeks there', () => {
    const d = new Driver(captionCtx({ selectedIds: ['s0'] }))
    d.down(CAPTION_GAP.x, CAPTION_GAP.y)
    const effects = d.up(CAPTION_GAP.x, CAPTION_GAP.y)
    expect(of(effects, 'select')).toEqual([{ type: 'select', id: null, additive: false }])
    expect(of(effects, 'seek')).toEqual([{ type: 'seek', time: 2.6 }])
  })

  it('never selects a segment that has no id yet', () => {
    const d = new Driver(captionCtx())
    d.down(UNMINTED.x, UNMINTED.y)
    expect(of(d.up(UNMINTED.x, UNMINTED.y), 'select')).toEqual([{ type: 'select', id: null, additive: false }])
  })
})

describe('caption body drag — move', () => {
  it('MOVES a caption that was not selected when the drag began', () => {
    // The stale-selection trap. `selectMany` selects the grabbed caption, but
    // the host has not echoed it back into `ctx.selectedIds` yet, so a move
    // that keyed off `ctx.selectedIds` alone would shift nothing at all and
    // the block would sit still under the pointer.
    const d = new Driver(captionCtx())
    d.down(S0_BODY.x, S0_BODY.y)
    const eff = d.move(S0_BODY.x + 100, S0_BODY.y)
    expect(of(eff, 'selectMany')).toEqual([{ type: 'selectMany', ids: ['s0'], additive: false }])
    const moved = caption(lastProjectChange(eff), 's0')
    expect(moved.start).toBeCloseTo(2)
    expect(moved.end).toBeCloseTo(3)
  })

  it('moves ONLY the grabbed caption when something else holds the selection', () => {
    const d = new Driver(captionCtx({ selectedIds: ['c0'] }))
    d.down(S0_BODY.x, S0_BODY.y)
    const proj = lastProjectChange(d.move(S0_BODY.x + 100, S0_BODY.y))
    expect(caption(proj, 's0').start).toBeCloseTo(2)
    expect(visual(proj, 'c0').start).toBe(0)      // the old selection stayed put
  })

  it('carries every word timing with the segment', () => {
    const d = new Driver(captionCtx())
    d.down(S0_BODY.x, S0_BODY.y)
    const moved = caption(lastProjectChange(d.move(S0_BODY.x + 100, S0_BODY.y)), 's0')
    expect(moved.words).toEqual([
      { word: 'hello', start: 2, end: 2.6 },
      { word: 'there', start: 2.6, end: 3 },
    ])
    expect(moved.text).toBe('hello there')
  })

  it('emits one projectChange per move and exactly ONE commit at release', () => {
    const d = new Driver(captionCtx({ selectedIds: ['s0'] }))
    d.down(S0_BODY.x, S0_BODY.y)
    expect(of(d.move(S0_BODY.x + 50, S0_BODY.y), 'projectChange')).toHaveLength(1)
    expect(of(d.move(S0_BODY.x + 80, S0_BODY.y), 'projectChange')).toHaveLength(1)
    expect(of(d.move(S0_BODY.x + 100, S0_BODY.y), 'projectChange')).toHaveLength(1)
    const committed = of(d.up(S0_BODY.x + 100, S0_BODY.y), 'commit')
    expect(committed).toHaveLength(1)
    expect(caption(committed[0].project, 's0').start).toBeCloseTo(2)
  })

  it('co-moves a whole caption selection under one delta', () => {
    const d = new Driver(captionCtx({ selectedIds: ['s0', 's1'] }))
    d.down(S0_BODY.x, S0_BODY.y)
    const eff = d.move(S0_BODY.x + 100, S0_BODY.y)
    // A group move never re-selects.
    expect(of(eff, 'selectMany')).toEqual([])
    const proj = lastProjectChange(eff)
    expect(caption(proj, 's0')).toMatchObject({ start: 2, end: 3 })
    expect(caption(proj, 's1').start).toBeCloseTo(4.44)
    expect(caption(proj, 's1').end).toBeCloseTo(5.5)
    expect(of(d.up(S0_BODY.x + 100, S0_BODY.y), 'commit')).toHaveLength(1)
  })

  it('co-moves a MIXED clip+caption selection, and commits it once', () => {
    // The point of putting caption ids in the same `selectedIds` array: one
    // gesture, one `projectChange` stream, one undo entry.
    const d = new Driver(captionCtx({ selectedIds: ['c0', 's0'] }))
    d.down(S0_BODY.x, S0_BODY.y)
    const proj = lastProjectChange(d.move(S0_BODY.x + 100, S0_BODY.y))
    expect(visual(proj, 'c0')).toMatchObject({ start: 1, end: 11 })
    expect(caption(proj, 's0')).toMatchObject({ start: 2, end: 3 })
    const committed = of(d.up(S0_BODY.x + 100, S0_BODY.y), 'commit')
    expect(committed).toHaveLength(1)
    expect(caption(committed[0].project, 's0').start).toBeCloseTo(2)
    expect(visual(committed[0].project, 'c0').start).toBeCloseTo(1)
  })

  it('clamps the group as a body so no member leaves the timeline', () => {
    // Single caption, no other captions in the project — isolates the
    // timeline-edge clamp from the caption-neighbour clamp (its own describe
    // block below), which would otherwise stop s0 at s1's start (3.44) long
    // before it ever reached `ctx.totalDuration`.
    const soloProject: Project = {
      ...captionProject(),
      captions: { style: 'pop', segments: [{ id: 's0', text: 'hello there', start: 1, end: 2 }] },
    } as unknown as Project
    const ctx = captionCtx({ project: soloProject, selectedIds: ['s0'] })
    const d = new Driver(ctx)
    d.down(S0_BODY.x, S0_BODY.y)
    expect(caption(lastProjectChange(d.move(-9999, S0_BODY.y)), 's0').start).toBe(0)
    expect(caption(lastProjectChange(d.move(99999, S0_BODY.y)), 's0').end).toBeCloseTo(ctx.totalDuration)
  })

  it('commits nothing when the drag ends back where it started', () => {
    const d = new Driver(captionCtx({ selectedIds: ['s0'] }))
    d.down(S0_BODY.x, S0_BODY.y)
    d.move(S0_BODY.x + 100, S0_BODY.y)
    d.move(S0_BODY.x, S0_BODY.y)
    expect(of(d.up(S0_BODY.x, S0_BODY.y), 'commit')).toEqual([])
  })
})

describe('caption edge drag — trim', () => {
  it('moves ONLY the dragged out edge', () => {
    const d = new Driver(captionCtx())
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    // The edge lands at its own time plus the pointer's travel: the press was
    // at x=198 (inside the 6px handle), so 250 is 0.52s further on.
    const trimmed = caption(lastProjectChange(d.move(250, S0_OUT_EDGE.y)), 's0')
    expect(trimmed.end).toBeCloseTo(2.52)
    expect(trimmed.start).toBe(1)
  })

  it('moves ONLY the dragged in edge', () => {
    const d = new Driver(captionCtx())
    d.down(S0_IN_EDGE.x, S0_IN_EDGE.y)
    const trimmed = caption(lastProjectChange(d.move(150, S0_IN_EDGE.y)), 's0')
    expect(trimmed.start).toBeCloseTo(1.48)
    expect(trimmed.end).toBe(2)
  })

  it('never touches text or words — a retime is not a respread', () => {
    const before = captionProject()
    const d = new Driver(makeContext({ project: before, fps: CAPTION_FPS }))
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    const trimmed = caption(lastProjectChange(d.move(250, S0_OUT_EDGE.y)), 's0')
    expect(trimmed.text).toBe('hello there')
    // The same array object, not merely the same values: nothing respread it.
    expect(trimmed.words).toBe(caption(before, 's0').words)
  })

  it('leaves every OTHER segment alone', () => {
    const d = new Driver(captionCtx())
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    const proj = lastProjectChange(d.move(250, S0_OUT_EDGE.y))
    expect(caption(proj, 's1')).toMatchObject({ start: 3.44, end: 4.5 })
  })

  it('never trims below the minimum duration, from either edge', () => {
    // The floor the click-seek leans on: no segment is ever under one frame.
    expect(CAPTION_MIN_DURATION_S).toBeGreaterThan(1 / CAPTION_FPS)

    const out = new Driver(captionCtx())
    out.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    expect(caption(lastProjectChange(out.move(20, S0_OUT_EDGE.y)), 's0').end)
      .toBeCloseTo(1 + CAPTION_MIN_DURATION_S)

    const inn = new Driver(captionCtx())
    inn.down(S0_IN_EDGE.x, S0_IN_EDGE.y)
    expect(caption(lastProjectChange(inn.move(600, S0_IN_EDGE.y)), 's0').start)
      .toBeCloseTo(2 - CAPTION_MIN_DURATION_S)
  })

  it('does not trim a multi-selection — v1 trims one segment', () => {
    const d = new Driver(captionCtx({ selectedIds: ['s0', 's1'] }))
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    const proj = lastProjectChange(d.move(250, S0_OUT_EDGE.y))
    expect(caption(proj, 's0').end).toBeCloseTo(2.52)
    expect(caption(proj, 's1')).toMatchObject({ start: 3.44, end: 4.5 })
  })

  it('commits once, and only what actually changed', () => {
    const d = new Driver(captionCtx())
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    d.move(250, S0_OUT_EDGE.y)
    const committed = of(d.up(250, S0_OUT_EDGE.y), 'commit')
    expect(committed).toHaveLength(1)
    expect(caption(committed[0].project, 's0')).toMatchObject({ start: 1, end: 2.52 })
  })

  it('commits nothing when the edge ends back where it started', () => {
    const d = new Driver(captionCtx())
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    d.move(250, S0_OUT_EDGE.y)
    d.move(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    expect(of(d.up(S0_OUT_EDGE.x, S0_OUT_EDGE.y), 'commit')).toEqual([])
  })

  it("stops an end-edge trim at the next caption's start — captions may not overlap", () => {
    // Dragged far past s1 (x=2000, t=20). Without the neighbour clamp this
    // would land at `Math.max(ctx.totalDuration, seg.end)` = 15; with it, s1
    // starts at 3.44 and that is the real ceiling.
    const d = new Driver(captionCtx())
    d.down(S0_OUT_EDGE.x, S0_OUT_EDGE.y)
    const trimmed = caption(lastProjectChange(d.move(2000, S0_OUT_EDGE.y)), 's0')
    expect(trimmed.end).toBeCloseTo(3.44)
    expect(trimmed.start).toBe(1)
  })

  it("stops a start-edge trim at the previous caption's end — captions may not overlap", () => {
    // Dragged far past s0 (x=0, t=0). Without the neighbour clamp this would
    // land at 0 (`lo`'s flat floor); with it, s0 ends at 2 and that is the
    // real floor.
    const d = new Driver(captionCtx())
    d.down(S1_IN_EDGE.x, S1_IN_EDGE.y)
    const trimmed = caption(lastProjectChange(d.move(0, S1_IN_EDGE.y)), 's1')
    expect(trimmed.start).toBeCloseTo(2)
    expect(trimmed.end).toBeCloseTo(4.5)
  })

  it('a drag clamped to zero movement by a butted neighbour still emits no commit', () => {
    // Two captions already touching (a's end === b's start === 2, the
    // `resolveRow` tie-break case): a's out edge has no legal room to move
    // right at all, so `hi` equals its own current value from the first
    // frame — the clamp lands it back on `initTime` every time.
    const butted: Project = {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }] }],
      captions: {
        style: 'pop',
        segments: [
          { id: 'a', text: 'first', start: 1, end: 2 },
          { id: 'b', text: 'second', start: 2, end: 3 },
        ],
      },
    } as unknown as Project
    const d = new Driver(captionCtx({ project: butted }))
    // a's out edge sits at x=198 (200 - 2, same offset every other edge point
    // in this file uses), safely inside a and not on the shared boundary.
    d.down(198, CAPTION_Y)
    const move = d.move(280, CAPTION_Y)
    expect(of(move, 'projectChange')).toEqual([])
    expect(caption(butted, 'a')).toMatchObject({ start: 1, end: 2 })
    expect(of(d.up(280, CAPTION_Y), 'commit')).toEqual([])
  })
})

describe('caption playhead grab', () => {
  it('a grab over a caption BODY scrubs instead of selecting', () => {
    // Playhead at x=150, inside s0's body.
    const d = new Driver(captionCtx({ playheadTime: 1.5 }))
    const eff = d.down(150, CAPTION_Y)
    const st = d.machine.state
    expect(st.kind).toBe('dragging')
    if (st.kind === 'dragging') expect(st.gesture).toBe('scrub')
    expect(of(eff, 'seek').length).toBeGreaterThan(0)
    expect(of(eff, 'select')).toEqual([])
  })

  it('a grab over a caption EDGE trims — the precise target wins (D1)', () => {
    // Playhead at x=102, right on s0's in handle.
    const d = new Driver(captionCtx({ playheadTime: 1.02 }))
    d.down(S0_IN_EDGE.x, S0_IN_EDGE.y)
    expect(d.machine.state.kind).toBe('pressed')     // not a scrub
    d.move(S0_IN_EDGE.x + 30, S0_IN_EDGE.y)
    const st = d.machine.state
    expect(st.kind).toBe('dragging')
    if (st.kind === 'dragging') expect(st.gesture).toBe('caption-trim')
  })
})

describe('caption double-click', () => {
  it('opens the caption for editing rather than an inspector', () => {
    const d = new Driver(captionCtx())
    expect(d.doubleClick(S0_BODY.x, S0_BODY.y)).toEqual([{ type: 'editCaption', id: 's0' }])
  })

  it('does the same from a caption edge', () => {
    const d = new Driver(captionCtx())
    expect(d.doubleClick(S0_OUT_EDGE.x, S0_OUT_EDGE.y)).toEqual([{ type: 'editCaption', id: 's0' }])
  })

  it('does nothing in the gaps between blocks', () => {
    const d = new Driver(captionCtx())
    expect(d.doubleClick(CAPTION_GAP.x, CAPTION_GAP.y)).toEqual([])
    expect(d.doubleClick(UNMINTED.x, UNMINTED.y)).toEqual([])
  })
})

// ── Caption trim at the timeline's own edges ──────────────────────────────
//
// The trim has two invariants that can fight each other: the edge stays inside
// [0, totalDuration], and the segment stays at least `CAPTION_MIN_DURATION_S`
// long. They only collide on a segment ALREADY shorter than the floor sitting
// flush against a boundary — which Whisper produces routinely (a one-syllable
// interjection) and which a caption move can push against `totalDuration`.
//
// Zoomed to 1000px/s: these blocks are 50px wide, so their handles are
// separately grabbable. At the fixture's usual 100px/s a 5px block would
// resolve every point to its OUT handle and the in-edge probes would miss.

const TINY_VIEWPORT: Viewport = { pxPerSecond: 1000, scrollSeconds: 0, widthPx: 1000 }

function tinyCaptionProject(): Project {
  return {
    id: 'p',
    tracks: [{
      id: 'trk-0',
      items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }],
    }],
    captions: {
      style: 'pop',
      segments: [
        // Shorter than the floor, flush against t=0.
        { id: 'head', text: 'uh', start: 0, end: 0.05 },
        // Shorter than the floor, flush against totalDuration (10 + 5 = 15).
        { id: 'tail', text: 'hm', start: 14.95, end: 15 },
        // Shorter than the floor, but nowhere near either boundary.
        { id: 'middle', text: 'so', start: 5, end: 5.05 },
      ],
    },
  } as unknown as Project
}

const TINY_LAYOUT = computeTimelineLayout(tinyCaptionProject())
const TINY_Y = Math.round(TINY_LAYOUT.captions![0].y + TINY_LAYOUT.captions![0].height / 2)

function tinyCtx(overrides: Partial<PointerContext> = {}): PointerContext {
  return makeContext({ project: tinyCaptionProject(), fps: CAPTION_FPS, viewport: TINY_VIEWPORT, ...overrides })
}

describe('caption trim — a sub-floor segment pinned at a timeline edge', () => {
  it('the fixture is the collision case: sub-floor segments, flush at both ends', () => {
    const ctx = tinyCtx()
    expect(ctx.totalDuration).toBe(15)
    for (const id of ['head', 'tail', 'middle']) {
      const seg = caption(ctx.project, id)
      expect(seg.end - seg.start).toBeLessThan(CAPTION_MIN_DURATION_S)
    }
  })

  it('never drags the in edge below t=0 — it declines to move at all', () => {
    // head is 0s–0.05s, so its in edge has NO legal position: t=0 is already
    // the floor's ceiling minus a negative. Bounds-then-floor put it at -0.05.
    const ctx = tinyCtx()
    const d = new Driver(ctx)
    d.down(2, TINY_Y)                        // head's in handle (x 0–50, in zone ≤ 6)
    const eff = d.move(-100, TINY_Y)
    expect(of(eff, 'projectChange')).toEqual([])
    const st = d.machine.state
    expect(st.kind).toBe('dragging')
    if (st.kind === 'dragging') expect(st.lastProject).toBe(ctx.project)
    expect(caption(ctx.project, 'head')).toMatchObject({ start: 0, end: 0.05 })
    expect(of(d.up(-100, TINY_Y), 'commit')).toEqual([])
  })

  it('never drags the out edge past totalDuration — it declines to move at all', () => {
    // tail is 14.95s–15s against a 15s horizon. Bounds-then-floor put its out
    // edge at 15.05.
    const ctx = tinyCtx()
    const d = new Driver(ctx)
    d.down(14998, TINY_Y)                    // tail's out handle (x 14950–15000)
    const eff = d.move(15100, TINY_Y)
    expect(of(eff, 'projectChange')).toEqual([])
    const st = d.machine.state
    expect(st.kind).toBe('dragging')
    if (st.kind === 'dragging') expect(st.lastProject).toBe(ctx.project)
    expect(caption(ctx.project, 'tail')).toMatchObject({ start: 14.95, end: 15 })
    expect(of(d.up(15100, TINY_Y), 'commit')).toEqual([])
  })

  it('still trims a sub-floor segment that is NOT pinned — the range is not empty', () => {
    // The guard must decline only when there is genuinely nowhere legal to go.
    // middle is 5s–5.05s with room on both sides, so dragging its out edge left
    // grows it to the floor rather than refusing.
    const d = new Driver(tinyCtx())
    d.down(5048, TINY_Y)                     // middle's out handle (x 5000–5050)
    const trimmed = caption(lastProjectChange(d.move(4900, TINY_Y)), 'middle')
    expect(trimmed.end).toBeCloseTo(5 + CAPTION_MIN_DURATION_S)
    expect(trimmed.start).toBe(5)
  })

  it('keeps every caption inside the timeline however far the pointer travels', () => {
    // A blanket guard over both edges of all three segments: no drag, at any
    // distance, may put a caption edge outside [0, totalDuration].
    const ctx = tinyCtx()
    // head's in handle, tail's out handle, then both of middle's.
    for (const x of [2, 14998, 5002, 5048]) {
      const d = new Driver(ctx)
      d.down(x, TINY_Y)
      for (const to of [-9999, 0, 5000, 15000, 99999]) {
        const changes = of(d.move(to, TINY_Y), 'projectChange')
        if (changes.length === 0) continue
        for (const seg of changes[changes.length - 1].project.captions!.segments) {
          expect(seg.start).toBeGreaterThanOrEqual(0)
          expect(seg.end).toBeLessThanOrEqual(ctx.totalDuration)
        }
      }
    }
  })
})

// ── Caption trim on a caption that already overhangs the timeline ─────────
//
// `totalDuration` is derived from clips and audio only, so a caption can end
// past it once clips are trimmed or deleted after captioning. The rule is that
// a trim never pushes a caption FURTHER out than it already was — it may not
// make an overhang worse, and it may not "helpfully" shrink one either.
//
// `over` straddles the horizon: start 14.5 inside a 15s timeline, end 16
// beyond it. Same 1000px/s viewport, so x = t × 1000.

function overhangCaptionProject(): Project {
  return {
    id: 'p',
    tracks: [{
      id: 'trk-0',
      items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }],
    }],
    captions: {
      style: 'pop',
      segments: [{ id: 'over', text: 'trailing', start: 14.5, end: 16 }],
    },
  } as unknown as Project
}

const OVERHANG_LAYOUT = computeTimelineLayout(overhangCaptionProject())
const OVERHANG_Y = Math.round(OVERHANG_LAYOUT.captions![0].y + OVERHANG_LAYOUT.captions![0].height / 2)
/** `over`'s handles: the block spans x 14500–16000. */
const OVER_IN_EDGE = 14502
const OVER_OUT_EDGE = 15998

function overhangCtx(overrides: Partial<PointerContext> = {}): PointerContext {
  return makeContext({ project: overhangCaptionProject(), fps: CAPTION_FPS, viewport: TINY_VIEWPORT, ...overrides })
}

describe('caption trim — a caption that already overhangs the timeline', () => {
  it('the fixture really does overhang', () => {
    const ctx = overhangCtx()
    expect(ctx.totalDuration).toBe(15)
    expect(caption(ctx.project, 'over').end).toBeGreaterThan(ctx.totalDuration)
    expect(caption(ctx.project, 'over').start).toBeLessThan(ctx.totalDuration)
  })

  it('nudges the out edge inward to where the pointer put it, not back to totalDuration', () => {
    // The whole point of the raised ceiling. Bounded at `totalDuration` this
    // lands at 15.6 (the duration floor) or 15 — either way a silent shrink of
    // roughly half a second, triggered by a 50px nudge.
    const d = new Driver(overhangCtx())
    d.down(OVER_OUT_EDGE, OVERHANG_Y)
    const trimmed = caption(lastProjectChange(d.move(OVER_OUT_EDGE - 50, OVERHANG_Y)), 'over')
    expect(trimmed.end).toBeCloseTo(15.95)
    expect(trimmed.start).toBe(14.5)
  })

  it('refuses to push the out edge FURTHER out than it already was', () => {
    // `seg.end` is both the ceiling and the starting value, so an outward drag
    // has nowhere legal to go and the trim declines entirely.
    const ctx = overhangCtx()
    const d = new Driver(ctx)
    d.down(OVER_OUT_EDGE, OVERHANG_Y)
    expect(of(d.move(OVER_OUT_EDGE + 500, OVERHANG_Y), 'projectChange')).toEqual([])
    const st = d.machine.state
    expect(st.kind).toBe('dragging')
    if (st.kind === 'dragging') expect(st.lastProject).toBe(ctx.project)
    expect(of(d.up(OVER_OUT_EDGE + 500, OVERHANG_Y), 'commit')).toEqual([])
  })

  it('still enforces the duration floor on an overhanging caption', () => {
    // The raised ceiling relaxes the OUTER bound only; the floor is untouched.
    const d = new Driver(overhangCtx())
    d.down(OVER_OUT_EDGE, OVERHANG_Y)
    const trimmed = caption(lastProjectChange(d.move(14000, OVERHANG_Y)), 'over')
    expect(trimmed.end).toBeCloseTo(14.5 + CAPTION_MIN_DURATION_S)
    expect(trimmed.start).toBe(14.5)
  })

  it('never pushes a caption further out than it already was, however far the pointer travels', () => {
    // The overhang counterpart of the in-bounds sweep above: the invariant is
    // the segment's OWN original end, not `totalDuration`.
    const ctx = overhangCtx()
    const original = caption(ctx.project, 'over')
    for (const x of [OVER_IN_EDGE, OVER_OUT_EDGE]) {
      const d = new Driver(ctx)
      d.down(x, OVERHANG_Y)
      for (const to of [-9999, 0, 14000, 15000, 16500, 99999]) {
        const changes = of(d.move(to, OVERHANG_Y), 'projectChange')
        if (changes.length === 0) continue
        const seg = changes[changes.length - 1].project.captions!.segments[0]
        expect(seg.start).toBeGreaterThanOrEqual(0)
        expect(seg.end).toBeLessThanOrEqual(original.end)
        expect(seg.end - seg.start).toBeGreaterThanOrEqual(CAPTION_MIN_DURATION_S - 1e-9)
      }
    }
  })
})

// ── Caption ROWS: vertical drag, row creation, per-row clamps ──────────────
//
// Captions live on lanes now. Lane 0 is the band adjacent to the base video
// row and higher lanes stack UPWARD, so a drag toward the top of the surface
// RAISES the lane number — the opposite of audio, whose lanes ascend downward.
// A lone caption changes rows; a caption travelling with a wider selection
// never does.
//
// Fixture (100px/s, so x = t × 100):
//
//   lane 1  u0 1s–2s          (x 100–200)
//   lane 0  g0 1s–2s (words), g1 5s–6s   (x 100–200, 500–600)
//   row     track 0 — c0 0s–10s     ⇒ totalDuration 15
//
// u0 sits directly above g0 on purpose: it is what makes "the row I am aiming
// at is already taken" reachable without moving horizontally at all.

function lanedCaptionProject(): Project {
  return {
    id: 'p',
    tracks: [{
      id: 'trk-0',
      items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }],
    }],
    captions: {
      style: 'pop',
      segments: [
        // No `lane` at all — absent means lane 0, and this fixture leans on
        // that being indistinguishable from an explicit 0.
        {
          id: 'g0',
          text: 'hello there',
          start: 1,
          end: 2,
          words: [
            { word: 'hello', start: 1, end: 1.6 },
            { word: 'there', start: 1.6, end: 2 },
          ],
        },
        { id: 'g1', text: 'ground later', start: 5, end: 6 },
        { id: 'u0', text: 'upstairs', start: 1, end: 2, lane: 1 },
      ],
    },
  } as unknown as Project
}

const LANED_LAYOUT = computeTimelineLayout(lanedCaptionProject())
const laneMidY = (layout: typeof LANED_LAYOUT, lane: number) => {
  const band = layout.captions!.find(b => b.lane === lane)!
  return Math.round(band.y + band.height / 2)
}
const L0_Y = laneMidY(LANED_LAYOUT, 0)
const L1_Y = laneMidY(LANED_LAYOUT, 1)

const G0_BODY = { x: 150, y: L0_Y }
const G1_BODY = { x: 550, y: L0_Y }
const U0_BODY = { x: 150, y: L1_Y }
const G0_OUT = { x: 198, y: L0_Y }
const U0_OUT = { x: 198, y: L1_Y }

function lanedCtx(overrides: Partial<PointerContext> = {}): PointerContext {
  return makeContext({ project: lanedCaptionProject(), fps: CAPTION_FPS, ...overrides })
}

/** Every caption lane in a project, keyed by segment id, read the way the
 *  painter reads it (absent ⇒ 0). */
function lanes(project: Project): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of project.captions?.segments ?? []) out[s.id as string] = s.lane ?? 0
  return out
}

describe('caption vertical drag — moving between rows', () => {
  it('the fixture stacks lane 0 below lane 1, one band apart', () => {
    expect(LANED_LAYOUT.captions!.map(b => b.lane)).toEqual([1, 0])
    expect(L0_Y - L1_Y).toBe(CAPTION_ROW_HEIGHT_PX + ROW_GAP_PX)
  })

  it('a caption dragged UP one band lands on the next lane up', () => {
    const d = new Driver(lanedCtx())
    d.down(G1_BODY.x, G1_BODY.y)
    const moved = lastProjectChange(d.move(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX))
    expect(lanes(moved).g1).toBe(1)
    // Purely vertical: the segment keeps its exact timing.
    expect(caption(moved, 'g1')).toMatchObject({ start: 5, end: 6 })
    // …and nothing else moved rows.
    expect(lanes(moved).g0).toBe(0)
    expect(lanes(moved).u0).toBe(1)
  })

  it('crosses a row at CAPTION_ROW_HEIGHT_PX of travel, not at the 44px band pitch', () => {
    // 22px is over half of 40 and exactly half of 44 (which `Math.round`
    // resolves DOWNWARD in magnitude, to -0). The shorter divisor is what lets
    // the drag reach the next row before the cursor has fully left this one.
    expect(Math.round(-22 / CAPTION_ROW_HEIGHT_PX)).toBe(-1)
    expect(Math.round(-22 / (CAPTION_ROW_HEIGHT_PX + ROW_GAP_PX))).toBe(-0)

    const crossed = new Driver(lanedCtx())
    crossed.down(G1_BODY.x, G1_BODY.y)
    expect(lanes(lastProjectChange(crossed.move(G1_BODY.x, G1_BODY.y - 22))).g1).toBe(1)

    // 20px is under half a row: no vertical intent, and with no horizontal
    // travel either the gesture has nothing at all to emit.
    const held = new Driver(lanedCtx())
    held.down(G1_BODY.x, G1_BODY.y)
    expect(of(held.move(G1_BODY.x, G1_BODY.y - 20), 'projectChange')).toEqual([])
  })

  it('dragging past the TOP band mints a new row, and the band is there mid-drag', () => {
    const d = new Driver(lanedCtx())
    d.down(G1_BODY.x, G1_BODY.y)
    const moved = lastProjectChange(d.move(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX * 2))
    expect(lanes(moved).g1).toBe(2)
    // The band exists in the very frame the drag emits — that is what makes
    // the new row appear under the cursor rather than at release.
    expect(computeTimelineLayout(moved).captions!.map(b => b.lane)).toEqual([2, 1, 0])
  })

  it('clamps at lane 0 dragging DOWN, and never reaches the video row', () => {
    const d = new Driver(lanedCtx())
    d.down(G1_BODY.x, G1_BODY.y)
    // Two rows down from lane 0 is lane -2; the clamp holds it at 0. The
    // horizontal component is there only so the move is not a no-op and the
    // landed lane is actually observable.
    const moved = lastProjectChange(d.move(G1_BODY.x + 100, G1_BODY.y + CAPTION_ROW_HEIGHT_PX * 2))
    expect(lanes(moved).g1).toBe(0)
    expect(caption(moved, 'g1')).toMatchObject({ start: 6, end: 7 })

    // A blanket guard: no downward travel, at any distance, puts a caption
    // below lane 0.
    for (const dy of [40, 80, 400, 4000]) {
      const proj = lastProjectChange(d.move(G1_BODY.x + 100, G1_BODY.y + dy))
      expect(lanes(proj).g1).toBeGreaterThanOrEqual(0)
    }
  })

  it('hands a caption to the nearest FREE row when the one it aimed at is taken', () => {
    // Straight up from g0 is lane 1, where u0 sits at exactly the same span.
    // The fan-out's next candidate is the row it came from, which fits — so
    // the caption simply stays put rather than being shoved somewhere it was
    // not aimed at.
    const blocked = new Driver(lanedCtx())
    blocked.down(G0_BODY.x, G0_BODY.y)
    expect(of(blocked.move(G0_BODY.x, G0_BODY.y - CAPTION_ROW_HEIGHT_PX), 'projectChange')).toEqual([])

    // The same upward drag, landing clear of u0 in time, takes lane 1.
    const clear = new Driver(lanedCtx())
    clear.down(G0_BODY.x, G0_BODY.y)
    const moved = lastProjectChange(clear.move(G0_BODY.x + 250, G0_BODY.y - CAPTION_ROW_HEIGHT_PX))
    expect(lanes(moved).g0).toBe(1)
    expect(caption(moved, 'g0')).toMatchObject({ start: 3.5, end: 4.5 })
  })

  it('fans out to a NEW row when the target row and the source row are both taken', () => {
    // a0 aims at lane 1 and lands on b1; falling back to lane 0 lands on a1;
    // so the drop goes to lane 2, which is empty by construction.
    const crowded: Project = {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }] }],
      captions: {
        style: 'pop',
        segments: [
          { id: 'a0', text: 'a0', start: 1, end: 2 },
          { id: 'a1', text: 'a1', start: 5, end: 6 },
          { id: 'b1', text: 'b1', start: 5, end: 6, lane: 1 },
        ],
      },
    } as unknown as Project
    const ctx = lanedCtx({ project: crowded, layout: computeTimelineLayout(crowded) })
    const d = new Driver(ctx)
    d.down(150, laneMidY(ctx.layout, 0))
    const moved = lastProjectChange(d.move(150 + 400, laneMidY(ctx.layout, 0) - CAPTION_ROW_HEIGHT_PX))
    expect(lanes(moved).a0).toBe(2)
    expect(caption(moved, 'a0')).toMatchObject({ start: 5, end: 6 })
    // Neither blocker moved, and neither was overlapped in its own row.
    expect(caption(moved, 'a1')).toMatchObject({ start: 5, end: 6 })
    expect(caption(moved, 'b1')).toMatchObject({ start: 5, end: 6 })
  })

  it('carries word timings across a row change, and never touches the text', () => {
    const d = new Driver(lanedCtx())
    d.down(G0_BODY.x, G0_BODY.y)
    const moved = lastProjectChange(d.move(G0_BODY.x + 250, G0_BODY.y - CAPTION_ROW_HEIGHT_PX))
    const seg = caption(moved, 'g0')
    expect(seg.text).toBe('hello there')
    expect(seg.words).toEqual([
      { word: 'hello', start: 3.5, end: 4.1 },
      { word: 'there', start: 4.1, end: 4.5 },
    ])
  })

  it('changes rows on the very FIRST move of a freshly grabbed caption', () => {
    // The stale-selection trap again: `selectMany` has not been echoed back
    // yet, so `ctx.selectedIds` still holds only the clip. The vertical path
    // has to cope with its own id being absent from the selection.
    const d = new Driver(lanedCtx({ selectedIds: ['c0'] }))
    d.down(G1_BODY.x, G1_BODY.y)
    expect(lanes(lastProjectChange(d.move(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX))).g1).toBe(1)
  })

  it('commits a cross-row drag exactly once', () => {
    const d = new Driver(lanedCtx())
    d.down(G1_BODY.x, G1_BODY.y)
    d.move(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX)
    const committed = of(d.up(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX), 'commit')
    expect(committed).toHaveLength(1)
    expect(lanes(committed[0].project).g1).toBe(1)
  })

  it('commits nothing when the caption ends the drag back in the row it started in', () => {
    const d = new Driver(lanedCtx())
    d.down(G1_BODY.x, G1_BODY.y)
    d.move(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX)
    d.move(G1_BODY.x, G1_BODY.y)
    expect(of(d.up(G1_BODY.x, G1_BODY.y), 'commit')).toEqual([])
  })
})

describe('caption horizontal drag — clamped by its own row only', () => {
  it('stops a lane-0 caption at its lane-0 neighbour', () => {
    const d = new Driver(lanedCtx())
    d.down(G0_BODY.x, G0_BODY.y)
    // 500px right is 5s; g1 starts at 5, so g0 gets 3s of the travel.
    const moved = lastProjectChange(d.move(G0_BODY.x + 500, G0_BODY.y))
    expect(caption(moved, 'g0')).toMatchObject({ start: 4, end: 5 })
    expect(lanes(moved).g0).toBe(0)
  })

  it('lets a lane-1 caption slide straight past a lane-0 caption', () => {
    // The discriminating case for the per-lane clamp: u0 (lane 1) travels the
    // full 5s even though g1 (lane 0) sits at 5s–6s directly in its path. A
    // track-wide clamp stopped it at 4s–5s.
    const d = new Driver(lanedCtx())
    d.down(U0_BODY.x, U0_BODY.y)
    const moved = lastProjectChange(d.move(U0_BODY.x + 500, U0_BODY.y))
    expect(caption(moved, 'u0')).toMatchObject({ start: 6, end: 7 })
    expect(lanes(moved).u0).toBe(1)
  })

  it('moves a whole selection horizontally and changes NO lane, however far the pointer travels down or up', () => {
    const d = new Driver(lanedCtx({ selectedIds: ['g0', 'u0'] }))
    d.down(G0_BODY.x, G0_BODY.y)
    for (const dy of [-400, -CAPTION_ROW_HEIGHT_PX, CAPTION_ROW_HEIGHT_PX, 400]) {
      const moved = lastProjectChange(d.move(G0_BODY.x + 100, G0_BODY.y + dy))
      expect(caption(moved, 'g0')).toMatchObject({ start: 2, end: 3 })
      expect(caption(moved, 'u0')).toMatchObject({ start: 2, end: 3 })
      expect(lanes(moved)).toEqual({ g0: 0, g1: 0, u0: 1 })
    }
  })
})

describe('caption trim — bounded by its own row only', () => {
  it('stops an end trim at the next caption IN ITS OWN LANE', () => {
    const d = new Driver(lanedCtx())
    d.down(G0_OUT.x, G0_OUT.y)
    expect(caption(lastProjectChange(d.move(2000, G0_OUT.y)), 'g0').end).toBeCloseTo(5)
  })

  it('lets a lane-1 caption trim straight past a lane-0 caption', () => {
    // u0 has no same-lane neighbour, so its only ceiling is the timeline's own
    // horizon. Track-wide, g1's start (5) stopped it.
    const d = new Driver(lanedCtx())
    d.down(U0_OUT.x, U0_OUT.y)
    const trimmed = caption(lastProjectChange(d.move(2000, U0_OUT.y)), 'u0')
    expect(trimmed.end).toBeCloseTo(15)
    expect(trimmed.start).toBe(1)
  })

  it('ignores a caption on another row when trimming a start edge', () => {
    // p0 (lane 0) ends at 2 and q0 (lane 1) starts at 3. Track-wide, q0's in
    // edge floored at 2; per lane it has no previous neighbour at all and may
    // run back to t=0.
    const split: Project = {
      id: 'p',
      tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }] }],
      captions: {
        style: 'pop',
        segments: [
          { id: 'p0', text: 'p0', start: 1, end: 2 },
          { id: 'q0', text: 'q0', start: 3, end: 4, lane: 1 },
        ],
      },
    } as unknown as Project
    const ctx = lanedCtx({ project: split, layout: computeTimelineLayout(split) })
    const d = new Driver(ctx)
    d.down(302, laneMidY(ctx.layout, 1))
    const trimmed = caption(lastProjectChange(d.move(0, laneMidY(ctx.layout, 1))), 'q0')
    expect(trimmed.start).toBe(0)
    expect(trimmed.end).toBe(4)
  })

  it('never moves a caption between rows — a trim is horizontal, always', () => {
    const d = new Driver(lanedCtx())
    d.down(G0_OUT.x, G0_OUT.y)
    const moved = lastProjectChange(d.move(250, G0_OUT.y - CAPTION_ROW_HEIGHT_PX * 3))
    expect(lanes(moved)).toEqual({ g0: 0, g1: 0, u0: 1 })
  })
})

// ── Hole lanes, and when they collapse ────────────────────────────────────
//
// A caption that was alone in its row leaves a HOLE behind it. The hole is
// deliberately KEPT for every mid-drag frame — it is what holds an empty band
// open so the timeline does not jump a whole row height under the pointer —
// and collapsed exactly once, inside the commit, so the move and the
// renumbering are one undo entry.

function threeLaneProject(): Project {
  return {
    id: 'p',
    tracks: [{
      id: 'trk-0',
      items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }],
    }],
    captions: {
      style: 'pop',
      segments: [
        { id: 'low', text: 'low', start: 1, end: 2 },
        { id: 'mid', text: 'mid', start: 1, end: 2, lane: 1 },   // alone in its row
        { id: 'top', text: 'top', start: 1, end: 2, lane: 2 },
      ],
    },
  } as unknown as Project
}

describe('caption lanes — hole collapse at commit', () => {
  const ctx = () => lanedCtx({ project: threeLaneProject(), layout: computeTimelineLayout(threeLaneProject()) })

  it('keeps the hole open for every mid-drag frame', () => {
    const c = ctx()
    const d = new Driver(c)
    const y = laneMidY(c.layout, 1)
    d.down(150, y)
    const moved = lastProjectChange(d.move(150, y - CAPTION_ROW_HEIGHT_PX * 2))
    // mid vacated lane 1 for the new lane 3; lane 1 is now a hole, and the
    // band for it is still painted.
    expect(lanes(moved)).toEqual({ low: 0, mid: 3, top: 2 })
    expect(computeTimelineLayout(moved).captions!.map(b => b.lane)).toEqual([3, 2, 1, 0])
  })

  it('collapses the hole once, in the single commit', () => {
    const c = ctx()
    const d = new Driver(c)
    const y = laneMidY(c.layout, 1)
    d.down(150, y)
    d.move(150, y - CAPTION_ROW_HEIGHT_PX * 2)
    const committed = of(d.up(150, y - CAPTION_ROW_HEIGHT_PX * 2), 'commit')
    expect(committed).toHaveLength(1)
    // Dense from 0, relative order preserved: low stays bottom, top moves down
    // into the vacated row, mid lands on top.
    expect(lanes(committed[0].project)).toEqual({ low: 0, mid: 2, top: 1 })
    expect(computeTimelineLayout(committed[0].project).captions!.map(b => b.lane)).toEqual([2, 1, 0])
  })

  it('leaves an already-dense project byte-for-byte alone at commit', () => {
    // Normalization must not manufacture a change of its own: a drag that
    // vacates nothing commits exactly what the last frame emitted.
    const d = new Driver(lanedCtx())
    d.down(G1_BODY.x, G1_BODY.y)
    const moved = lastProjectChange(d.move(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX))
    const committed = of(d.up(G1_BODY.x, G1_BODY.y - CAPTION_ROW_HEIGHT_PX), 'commit')
    expect(committed[0].project.captions).toBe(moved.captions)
  })

  it('does not normalize a caption TRIM — a trim cannot empty a row', () => {
    const c = ctx()
    const d = new Driver(c)
    const y = laneMidY(c.layout, 1)
    d.down(198, y)                                    // mid's out handle
    const moved = lastProjectChange(d.move(400, y))
    const committed = of(d.up(400, y), 'commit')
    expect(committed[0].project.captions).toBe(moved.captions)
    expect(lanes(committed[0].project)).toEqual({ low: 0, mid: 1, top: 2 })
  })
})
