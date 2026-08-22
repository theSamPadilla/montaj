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
import { VISUAL_ROW_HEIGHT_PX, computeDerivedTiming, trackItems } from '../../timeline-model'
import { computeTimelineLayout } from '../draw'
import {
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
import { hitTest } from '../hit-test'
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
const EMPTY = { x: 700, y: OVERLAY_Y }

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
  it('has no gesture for empty timeline', () => {
    expect(resolveGesture(hitTest(EMPTY, ctx.layout, VIEWPORT), mods())).toBeNull()
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
    expect(cursorForHit(hitTest(EMPTY, ctx.layout, VIEWPORT))).toBe('pointer')
  })
})

// ── Hover ────────────────────────────────────────────────────────────────

describe('hover', () => {
  it('emits a cursor only when it changes', () => {
    const d = new Driver(makeContext())
    expect(of(d.move(C0_BODY.x, C0_BODY.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'grab' }])
    expect(d.move(C0_BODY.x + 20, C0_BODY.y)).toEqual([])
    expect(of(d.move(C0_OUT_EDGE.x, C0_OUT_EDGE.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'ew-resize' }])
    expect(of(d.move(EMPTY.x, EMPTY.y), 'cursor')).toEqual([{ type: 'cursor', cursor: 'pointer' }])
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

describe('click-seek on empty timeline', () => {
  it('seeks on press and starts scrubbing', () => {
    const d = new Driver(makeContext())
    const effects = d.down(EMPTY.x, EMPTY.y)
    expect(of(effects, 'seek')).toEqual([{ type: 'seek', time: 7 }])
    expect(of(effects, 'cursor')).toEqual([{ type: 'cursor', cursor: 'ew-resize' }])
    expect(d.machine.state.kind).toBe('dragging')
  })

  it('clears the selection, so a click off a clip deselects it', () => {
    // Otherwise a clip stayed selected while you scrubbed somewhere else, and
    // the next split or ripple-delete hit an item nowhere near the playhead.
    const d = new Driver(makeContext())
    expect(of(d.down(EMPTY.x, EMPTY.y), 'select')).toEqual([{ type: 'select', id: null, additive: false }])
  })

  it('leaves the selection alone on an ADDITIVE press — shift builds a selection', () => {
    const d = new Driver(makeContext())
    expect(of(d.down(EMPTY.x, EMPTY.y, mods({ shift: true })), 'select')).toEqual([])
  })

  it('magnetizes to a nearby boundary', () => {
    const d = new Driver(makeContext())
    // 5.1s is 10px from the c0/c1 cut — inside the 18px attract radius.
    expect(of(d.down(510, 20), 'seek')).toEqual([{ type: 'seek', time: 5 }])
  })

  it('keeps seeking as the pointer drags, with hysteresis', () => {
    const d = new Driver(makeContext())
    d.down(505, 20)
    expect(of(d.effects, 'seek')[0].time).toBe(5)
    // 5.25s: past attract but inside release, so it stays stuck on the cut.
    expect(of(d.move(525, 20), 'seek')).toEqual([{ type: 'seek', time: 5 }])
    // 5.4s clears release and the playhead comes free.
    expect(of(d.move(540, 20), 'seek')[0].time).toBeCloseTo(5.4)
  })

  it('clamps the playhead to the timeline', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, EMPTY.y)
    expect(of(d.move(-500, 20), 'seek')).toEqual([{ type: 'seek', time: 0 }])
    expect(of(d.move(100000, 20), 'seek')[0].time).toBe(makeContext().totalDuration)
  })

  it('commits nothing when the scrub ends', () => {
    const d = new Driver(makeContext())
    d.down(EMPTY.x, EMPTY.y)
    d.move(EMPTY.x + 50, EMPTY.y)
    expect(of(d.up(EMPTY.x + 50, EMPTY.y), 'commit')).toEqual([])
    expect(d.machine.state.kind).toBe('idle')
  })

  it('scrubs from an empty audio lane too', () => {
    const d = new Driver(makeContext())
    expect(of(d.down(800, LANE_Y), 'seek')).toEqual([{ type: 'seek', time: 8 }])
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
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y)
    d.move(C1_BODY.x, C1_BODY.y - VISUAL_ROW_HEIGHT_PX)          // up one track
    const after = lastProjectChange(d.move(C1_BODY.x, C1_BODY.y - VISUAL_ROW_HEIGHT_PX))
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
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y)
    // 24px of upward travel is one track; c1 (5s–10s) doesn't collide with the
    // overlay o0 (2s–4s), so it lands on track 1.
    const after = lastProjectChange(d.move(C1_BODY.x, C1_BODY.y - VISUAL_ROW_HEIGHT_PX))
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
    // it overlaps o0 (2s–4s) by only 1s.
    const d = new Driver(makeContext())
    d.down(C1_BODY.x, C1_BODY.y)
    const after = lastProjectChange(d.move(C1_BODY.x - 200, C1_BODY.y - VISUAL_ROW_HEIGHT_PX))
    expect(visual(after, 'c1').start).toBeCloseTo(3)
    expect(trackIndexOf(after, 'c1')).toBe(1)
  })

  it('creates a new top track past the end of the stack', () => {
    const d = new Driver(makeContext())
    d.down(C0_BODY.x, C0_BODY.y)
    const after = lastProjectChange(d.move(C0_BODY.x, C0_BODY.y - VISUAL_ROW_HEIGHT_PX * 2))
    expect(after.tracks).toHaveLength(3)
    expect(trackIndexOf(after, 'c0')).toBe(2)
  })

  it('prunes a track the move emptied', () => {
    const d = new Driver(makeContext())
    d.down(300, 20)                              // o0, the only item on track 1
    // Down two tracks and out past the end of the base track's content, where
    // nothing collides — so track 1 is left empty and disappears.
    const after = lastProjectChange(d.move(300 + 900, 20 + 48))
    expect(visual(after, 'o0').start).toBeCloseTo(11)
    expect(after.tracks).toHaveLength(1)
    expect(trackIndexOf(after, 'o0')).toBe(0)
  })

  it('survives a cross-track drag on a legacy-shape project (T6 regression)', () => {
    // Before the T6 fix, applyMove passed `lastProject.tracks` straight to
    // moveItemAcrossTracks, which does `t.items.filter(...)` on every track —
    // a crash on a bare array. The call site now normalizes defensively, so
    // this must behave identically to the object-shape test above.
    const d = new Driver(makeContext({ project: legacyProject() }))
    d.down(C1_BODY.x, C1_BODY.y)
    const after = lastProjectChange(d.move(C1_BODY.x, C1_BODY.y - VISUAL_ROW_HEIGHT_PX))
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
    d.down(300, 20, mods({ alt: true }))          // o0, an overlay
    expect(of(d.move(400, 20, mods({ alt: true })), 'projectChange')).toEqual([])
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
    d.down(300, 20)
    expect(of(d.up(300, 20), 'select')).toEqual([{ type: 'select', id: 'o0', additive: false }])
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
    expect(of(d.cancel(), 'cursor')).toEqual([{ type: 'cursor', cursor: 'pointer' }])
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

describe('degenerate context', () => {
  it('edits nothing before the surface has a scale', () => {
    const unscaled: Viewport = { pxPerSecond: 0, scrollSeconds: 0, widthPx: 0 }
    const d = new Driver(makeContext({ viewport: unscaled }))
    // Every clip collapses to zero width, so a press lands on empty track area.
    d.down(0, 60)
    expect(of(d.move(200, 60), 'projectChange')).toEqual([])
  })

  it('starts idle with the default cursor', () => {
    expect(initialMachineState()).toEqual({ kind: 'idle', cursor: 'pointer' })
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

