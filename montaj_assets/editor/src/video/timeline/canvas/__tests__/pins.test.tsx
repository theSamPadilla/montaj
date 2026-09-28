/// <reference types="vitest/globals" />
/**
 * Host pins in the marker strip — the whole seam, in one file.
 *
 * A pin (`TimelinePin`) is a read-only annotation the HOST owns: a time it
 * wants flagged on the ruler. It is deliberately not a `project.markers` entry,
 * because anything in the project document churns the document, mixes with the
 * operator's own bookmarks, and changes what a hash of that document says about
 * whether the last render is current. See `TimelinePin`'s own doc for the full
 * argument.
 *
 * Four properties are what make that safe, and each is asserted here against
 * the mechanism rather than against its symptom:
 *
 *   1. A pin is hit-tested BEFORE a user marker. A pin at the same instant as a
 *      marker is the ordinary case, not a corner one, and a pin that fell
 *      through would hand the host's read-only annotation to marker editing.
 *   2. Nothing in the pin path can mutate markers. No create, no move, no
 *      rename, no delete, and no call into `markers.ts` at all — asserted by
 *      spying on that module for a whole press/drag/release/double-click.
 *   3. `pins` absent behaves exactly as before. The prop is optional, and every
 *      existing consumer passes nothing.
 *   4. Both palettes carry the tokens, so dark and light stay symmetric.
 *
 * The harness (recording 2D context, stubbed `getBoundingClientRect`, fake
 * timers) is the one every other suite in this directory uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup, screen } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project, TimelinePin } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import {
  DARK_TIMELINE_PALETTE,
  LIGHT_TIMELINE_COLORS,
  LIGHT_TIMELINE_PALETTE,
  MARKER_LABEL_MAX_CHARS,
  MARKER_STRIP_HEIGHT_PX,
  TIMELINE_COLORS,
  computeTimelineLayout,
  drawPins,
  drawTimelineContent,
  type DrawContext,
  type TimelineScene,
} from '../draw'
import { MARKER_HIT_WIDTH_PX, hitTest, isMarkerHit, isPinHit } from '../hit-test'
import {
  NO_MODIFIERS,
  createPointerMachine,
  cursorForHit,
  resolveGesture,
  type PointerContext,
  type PointerEffect,
} from '../pointer-machine'
import { createViewportStore } from '../viewport'
import type { Viewport } from '../viewport'

// Property 2's instrument. Spies that WRAP the real implementations, so marker
// behaviour is unchanged and "was this reached at all" is answerable. Every
// mutation `markers.ts` exports is covered: create, move, rename, delete.
vi.mock('../../markers', async importOriginal => {
  const actual = await importOriginal<typeof import('../../markers')>()
  return {
    ...actual,
    addMarker: vi.fn(actual.addMarker),
    moveMarker: vi.fn(actual.moveMarker),
    renameMarker: vi.fn(actual.renameMarker),
    removeMarkers: vi.fn(actual.removeMarkers),
  }
})
import * as markers from '../../markers'

const MARKER_MUTATIONS = ['addMarker', 'moveMarker', 'renameMarker', 'removeMarkers'] as const

function expectNoMarkerMutation() {
  for (const name of MARKER_MUTATIONS) {
    expect(markers[name], `${name} must never be reached from a pin`).not.toHaveBeenCalled()
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const VIEWPORT: Viewport = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }

/** One video clip, nothing else — no markers, so the strip exists only if the
 *  pins put it there. */
const bareProject = {
  id: 'p-pins',
  tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 8 }]],
} as unknown as Project

/** The same project with ONE marker, at the same instant as the pin below.
 *  This collision is the fixture for property 1. */
const markerProject = {
  ...bareProject,
  markers: [{ id: 'm1', t: 2, label: 'intro' }],
} as unknown as Project

/** At 100px/s with no scroll, t=2 is x=200. */
const PINS: readonly TimelinePin[] = [{ id: 'cmt-1', t: 2, label: '1' }]
const PIN_X = 200

/** Vertical centre of the strip, taken from the layout rather than written out,
 *  so a strip-height change retargets these clicks instead of aiming them at
 *  the ruler. */
const STRIP_Y = (() => {
  const strip = computeTimelineLayout(bareProject, PINS).markers!
  return Math.round(strip.y + strip.height / 2)
})()

interface RecordedCall { method: string; args: unknown[] }

interface Recorder {
  ctx: DrawContext
  calls: RecordedCall[]
  of: (method: string) => RecordedCall[]
}

function recordingContext(): Recorder {
  const calls: RecordedCall[] = []
  const props: Record<string, unknown> = {}
  const proxy = new Proxy({}, {
    get(_t, prop: string) {
      if (prop in props) return props[prop]
      if (prop === 'createLinearGradient') {
        return () => ({ addColorStop: () => {} } as unknown as CanvasGradient)
      }
      return (...args: unknown[]) => { calls.push({ method: prop, args }) }
    },
    set(_t, prop: string, value: unknown) {
      props[prop] = value
      calls.push({ method: `set:${prop}`, args: [value] })
      return true
    },
  }) as unknown as DrawContext
  return { ctx: proxy, calls, of: (method: string) => calls.filter(c => c.method === method) }
}

const STRIP_RECT = { y: 0, height: MARKER_STRIP_HEIGHT_PX }

function scene(over: Partial<TimelineScene> = {}): TimelineScene {
  const p = over.project ?? markerProject
  return {
    project: p,
    viewport: VIEWPORT,
    layout: computeTimelineLayout(p, over.pins ?? []),
    selectedIds: [],
    surfaceWidth: 1000,
    surfaceHeight: 200,
    ...over,
  }
}

function fillStyles(r: Recorder): unknown[] {
  return r.of('set:fillStyle').map(c => c.args[0])
}

// ── Property 4: both palettes gained the tokens ──────────────────────────

describe('the pin tokens exist in both palettes', () => {
  it('is present in dark and in light', () => {
    // `TimelineColors` is derived from the DARK set, so the light set failing to
    // carry a key is a type error — this asserts the values are real at runtime
    // too, which the type cannot.
    expect(typeof TIMELINE_COLORS.pinFlag).toBe('string')
    expect(typeof TIMELINE_COLORS.pinText).toBe('string')
    expect(typeof LIGHT_TIMELINE_COLORS.pinFlag).toBe('string')
    expect(typeof LIGHT_TIMELINE_COLORS.pinText).toBe('string')
    expect(DARK_TIMELINE_PALETTE.colors.pinFlag).toBe(TIMELINE_COLORS.pinFlag)
    expect(LIGHT_TIMELINE_PALETTE.colors.pinFlag).toBe(LIGHT_TIMELINE_COLORS.pinFlag)
  })

  it('steps the light tone rather than copying the dark one', () => {
    // The palette's standing rule: light is an inversion, not a copy. The
    // repo's own symmetry suite enforces this across every key; asserted here
    // too so a change to these two tokens fails in the file that owns them.
    expect(LIGHT_TIMELINE_COLORS.pinFlag).not.toBe(TIMELINE_COLORS.pinFlag)
    expect(LIGHT_TIMELINE_COLORS.pinText).not.toBe(TIMELINE_COLORS.pinText)
  })

  it('is not the marker colour in either mode', () => {
    // The one job the colour has: "this flag is not yours". A pin painted in the
    // marker's own hue would still paint, still hit-test and still report its
    // click — and would be indistinguishable from a bookmark the operator can
    // drag, which is the entire misunderstanding the colour exists to prevent.
    expect(TIMELINE_COLORS.pinFlag).not.toBe(TIMELINE_COLORS.markerFlag)
    expect(TIMELINE_COLORS.pinFlag).not.toBe(TIMELINE_COLORS.markerFlagSelected)
    expect(LIGHT_TIMELINE_COLORS.pinFlag).not.toBe(LIGHT_TIMELINE_COLORS.markerFlag)
    expect(LIGHT_TIMELINE_COLORS.pinFlag).not.toBe(LIGHT_TIMELINE_COLORS.markerFlagSelected)
  })
})

// ── The strip's layout ───────────────────────────────────────────────────

describe('the strip is reserved for pins as well as markers', () => {
  it('appears for a project with pins and NO markers', () => {
    expect(computeTimelineLayout(bareProject).markers).toBeUndefined()
    const withPins = computeTimelineLayout(bareProject, PINS)
    expect(withPins.markers).toEqual({ y: 0, height: MARKER_STRIP_HEIGHT_PX })
    // Everything below moves down by the strip, exactly as a first marker does.
    expect(withPins.rows[0].y - computeTimelineLayout(bareProject).rows[0].y).toBe(MARKER_STRIP_HEIGHT_PX)
  })

  it('does not add a SECOND strip when the project already has markers', () => {
    expect(computeTimelineLayout(markerProject, PINS)).toEqual(computeTimelineLayout(markerProject))
  })
})

// ── Pins paint ───────────────────────────────────────────────────────────

describe('drawPins', () => {
  it('draws a flag and its label at the pin time', () => {
    const r = recordingContext()
    drawPins(r.ctx, PINS, VIEWPORT, STRIP_RECT, 1000)
    const text = r.of('fillText')
    expect(text).toHaveLength(1)
    expect(text[0].args[0]).toBe('1')
    expect(text[0].args[1] as number).toBeGreaterThanOrEqual(PIN_X)
    expect(r.of('fillRect').length).toBeGreaterThan(0)
    expect(fillStyles(r)).toContain(TIMELINE_COLORS.pinFlag)
    expect(fillStyles(r)).toContain(TIMELINE_COLORS.pinText)
  })

  it('draws nothing at all for an empty list', () => {
    const r = recordingContext()
    drawPins(r.ctx, [], VIEWPORT, STRIP_RECT, 1000)
    expect(r.calls).toHaveLength(0)
  })

  it('skips a pin scrolled out of view', () => {
    const r = recordingContext()
    drawPins(r.ctx, [{ id: 'far', t: 500, label: '1' }], VIEWPORT, STRIP_RECT, 1000)
    expect(r.of('fillText')).toHaveLength(0)
  })

  it('truncates a long label instead of letting it run across the strip', () => {
    const r = recordingContext()
    drawPins(r.ctx, [{ id: 'p', t: 0, label: 'a'.repeat(400) }], VIEWPORT, STRIP_RECT, 1000)
    expect((r.of('fillText')[0].args[0] as string).length).toBeLessThanOrEqual(MARKER_LABEL_MAX_CHARS)
  })

  it('paints in the light tone on a light ground', () => {
    const r = recordingContext()
    drawPins(r.ctx, PINS, VIEWPORT, STRIP_RECT, 1000, LIGHT_TIMELINE_PALETTE)
    expect(fillStyles(r)).toContain(LIGHT_TIMELINE_COLORS.pinFlag)
    expect(fillStyles(r)).not.toContain(TIMELINE_COLORS.pinFlag)
  })
})

describe('the content pass paints the pins', () => {
  it('paints a pin passed on the scene', () => {
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: bareProject, pins: PINS }))
    expect(fillStyles(r)).toContain(TIMELINE_COLORS.pinFlag)
  })

  it('paints the pin AFTER the marker at the same instant', () => {
    // Paint order is the picture's half of the precedence `hitTest` enforces:
    // the flag you see and the flag you hit must be the same one. Reverse this
    // and a pin sitting on a marker is invisible while still winning the click.
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: markerProject, pins: PINS }))
    const styles = fillStyles(r)
    expect(styles.indexOf(TIMELINE_COLORS.pinFlag))
      .toBeGreaterThan(styles.indexOf(TIMELINE_COLORS.markerFlag))
  })
})

// ── Property 3: `pins` absent is unchanged ───────────────────────────────

describe('pins absent behaves exactly as before', () => {
  it('paints byte-identical calls with no pins and with an empty list', () => {
    const without = recordingContext()
    drawTimelineContent(without.ctx, scene({ project: markerProject }))
    const empty = recordingContext()
    drawTimelineContent(empty.ctx, scene({ project: markerProject, pins: [] }))
    expect(empty.calls).toEqual(without.calls)
    expect(fillStyles(empty)).not.toContain(TIMELINE_COLORS.pinFlag)
  })

  it('hit-tests the marker strip exactly as before', () => {
    const layout = computeTimelineLayout(markerProject)
    const withOpt = hitTest({ x: PIN_X, y: STRIP_Y }, layout, VIEWPORT, { markers: markerProject.markers })
    const withPinsEmpty = hitTest({ x: PIN_X, y: STRIP_Y }, layout, VIEWPORT, { markers: markerProject.markers, pins: [] })
    expect(withPinsEmpty).toEqual(withOpt)
    expect(withOpt.kind).toBe('marker')
  })

  it('leaves a marker-less, pin-less project with no strip at all', () => {
    const layout = computeTimelineLayout(bareProject)
    expect(layout.markers).toBeUndefined()
    // The top band is still the RULER, so a click up there still scrubs.
    expect(hitTest({ x: PIN_X, y: 4 }, layout, VIEWPORT, { pins: [] }).kind).toBe('ruler')
  })
})

// ── Property 1: a pin wins the strip, before any marker ──────────────────

describe('hitTest resolves a pin', () => {
  const layout = computeTimelineLayout(bareProject, PINS)

  it('hits the pin on its flag and reports its id', () => {
    const hit = hitTest({ x: PIN_X, y: STRIP_Y }, layout, VIEWPORT, { pins: PINS })
    expect(hit.kind).toBe('pin')
    expect(hit.pinId).toBe('cmt-1')
    expect(hit.pin).toEqual(PINS[0])
    expect(isPinHit(hit)).toBe(true)
    // The predicate every marker-editing caller gates on must stay false, or a
    // pin reaches all of them in one step.
    expect(isMarkerHit(hit)).toBe(false)
  })

  it('hits the pin from its LABEL, not just the 2px stem', () => {
    expect(hitTest({ x: PIN_X + 40, y: STRIP_Y }, layout, VIEWPORT, { pins: PINS }).kind).toBe('pin')
  })

  it('claims nothing past the label region', () => {
    const hit = hitTest({ x: PIN_X + MARKER_HIT_WIDTH_PX + 10, y: STRIP_Y }, layout, VIEWPORT, { pins: PINS })
    expect(hit.kind).not.toBe('pin')
  })

  it('culls a pin scrolled off the LEFT exactly where the painter does', () => {
    // Same asymmetry the marker loop documents: the region is measured from the
    // true x, the cull from the painter's half-pixel-offset predicate. Without
    // the cull, a click on apparently-empty strip grabs an invisible pin.
    const scrolled = { ...VIEWPORT, scrollSeconds: 2.05 }
    expect(hitTest({ x: 10, y: STRIP_Y }, layout, scrolled, { pins: PINS }).kind).not.toBe('pin')
  })

  it('resolves to the PIN, never the marker, when both sit at the same time', () => {
    // THE assertion. `markers` and `pins` both carry something at t=2, and the
    // marker is the one with a drag, a rename and a selection behind it.
    const both = computeTimelineLayout(markerProject, PINS)
    const hit = hitTest({ x: PIN_X, y: STRIP_Y }, both, VIEWPORT, {
      markers: markerProject.markers,
      pins: PINS,
    })
    expect(hit.kind).toBe('pin')
    expect(hit.pinId).toBe('cmt-1')
    expect(hit.markerId).toBeUndefined()
    expect(hit.marker).toBeUndefined()
  })

  it('still resolves a marker that has no pin on top of it', () => {
    const both = computeTimelineLayout(markerProject, [{ id: 'elsewhere', t: 6, label: '2' }])
    const hit = hitTest({ x: PIN_X, y: STRIP_Y }, both, VIEWPORT, {
      markers: markerProject.markers,
      pins: [{ id: 'elsewhere', t: 6, label: '2' }],
    })
    expect(hit.kind).toBe('marker')
    expect(hit.markerId).toBe('m1')
  })
})

// ── Property 2: no pin press can reach a marker mutation ─────────────────

describe('the pin path is read-only', () => {
  function makeContext(over: Partial<PointerContext> = {}): PointerContext {
    const project = over.project ?? markerProject
    const pins = over.pins ?? PINS
    return {
      project,
      layout: computeTimelineLayout(project, pins),
      viewport: VIEWPORT,
      selectedIds: [],
      snapBoundaries: [],
      totalDuration: 20,
      rippleMode: false,
      playheadTime: 0,
      fps: 30,
      pins,
      ...over,
    }
  }

  function drive(ctx: PointerContext) {
    const machine = createPointerMachine()
    const all: PointerEffect[] = []
    const push = (fx: PointerEffect[]) => { all.push(...fx); return fx }
    return {
      down: (x: number, y: number) => push(machine.dispatch({ type: 'pointerDown', point: { x, y }, modifiers: NO_MODIFIERS, ctx })),
      move: (x: number, y: number) => push(machine.dispatch({ type: 'pointerMove', point: { x, y }, modifiers: NO_MODIFIERS, ctx })),
      up: (x: number, y: number) => push(machine.dispatch({ type: 'pointerUp', point: { x, y }, modifiers: NO_MODIFIERS, ctx })),
      dbl: (x: number, y: number) => push(machine.dispatch({ type: 'doubleClick', point: { x, y }, modifiers: NO_MODIFIERS, ctx })),
      all,
    }
  }

  beforeEach(() => { vi.clearAllMocks() })

  it('resolves a pin press to no gesture at all', () => {
    const ctx = makeContext()
    const hit = hitTest({ x: PIN_X, y: STRIP_Y }, ctx.layout, VIEWPORT, { markers: markerProject.markers, pins: PINS })
    expect(hit.kind).toBe('pin')
    // Null here is the line that makes a pin read-only: no gesture means
    // `applyGesture` is never called for it, so no mutation module is reachable.
    expect(resolveGesture(hit, NO_MODIFIERS)).toBeNull()
  })

  it('reports a click and nothing else', () => {
    const d = drive(makeContext())
    d.down(PIN_X, STRIP_Y)
    const fx = d.up(PIN_X, STRIP_Y)
    expect(fx.filter(e => e.type === 'pinClick')).toEqual([{ type: 'pinClick', id: 'cmt-1' }])
    // Not a selection: a pin's id names nothing in the project, so handing it to
    // the host's selection would leave Delete pointed at a phantom.
    expect(fx.some(e => e.type === 'select' || e.type === 'selectMany')).toBe(false)
    expect(fx.some(e => e.type === 'seek')).toBe(false)
    expectNoMarkerMutation()
  })

  it('emits no project write for a press, a drag and a release on a pin', () => {
    const d = drive(makeContext())
    d.down(PIN_X, STRIP_Y)
    d.move(PIN_X + 120, STRIP_Y)
    d.move(PIN_X + 240, STRIP_Y)
    d.up(PIN_X + 240, STRIP_Y)
    expect(d.all.filter(e => e.type === 'projectChange')).toEqual([])
    expect(d.all.filter(e => e.type === 'commit')).toEqual([])
    expectNoMarkerMutation()
  })

  it('opens no rename box on a double-click', () => {
    const d = drive(makeContext())
    expect(d.dbl(PIN_X, STRIP_Y)).toEqual([])
    expect(d.all.filter(e => e.type === 'editMarker')).toEqual([])
    expectNoMarkerMutation()
  })

  it('never scrubs, even with the playhead sitting on the pin', () => {
    // A host pins the times its own data is about, which is routinely where the
    // operator has parked the playhead while looking at them. Without the
    // `grabsPlayhead` exclusion this is the likeliest pin click there is, and it
    // seeks instead of reporting.
    const d = drive(makeContext({ playheadTime: 2 }))
    const pressed = d.down(PIN_X, STRIP_Y)
    expect(pressed.filter(e => e.type === 'seek')).toEqual([])
    const fx = d.up(PIN_X, STRIP_Y)
    expect(fx.filter(e => e.type === 'pinClick')).toEqual([{ type: 'pinClick', id: 'cmt-1' }])
    expect(fx.some(e => e.type === 'seek')).toBe(false)
  })

  it('shows the hand cursor, not a retime cursor', () => {
    const ctx = makeContext()
    const hit = hitTest({ x: PIN_X, y: STRIP_Y }, ctx.layout, VIEWPORT, { pins: PINS })
    expect(cursorForHit(hit)).toBe('pointer')
  })

  it('leaves the MARKER gestures intact beside the pin', () => {
    // Property 3 at the gesture layer: a marker with no pin on it still drags,
    // still renames, still writes the project.
    const project = markerProject
    const pins: readonly TimelinePin[] = [{ id: 'elsewhere', t: 6, label: '2' }]
    const d = drive(makeContext({ project, pins }))
    d.down(PIN_X, STRIP_Y)
    d.move(PIN_X + 100, STRIP_Y)
    expect(d.all.filter(e => e.type === 'projectChange').length).toBeGreaterThan(0)
    expect(markers.moveMarker).toHaveBeenCalled()
    d.up(PIN_X + 100, STRIP_Y)
    expect(d.all.filter(e => e.type === 'commit').length).toBeGreaterThan(0)
  })
})

// ── The mounted surface ──────────────────────────────────────────────────

describe('TimelineCanvas — pins', () => {
  let realGetContext: typeof HTMLCanvasElement.prototype.getContext
  let realGetRect: typeof Element.prototype.getBoundingClientRect

  beforeEach(() => {
    vi.clearAllMocks()
    realGetContext = HTMLCanvasElement.prototype.getContext
    realGetRect = Element.prototype.getBoundingClientRect
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return recordingContext().ctx
    } as unknown as typeof HTMLCanvasElement.prototype.getContext
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 200, width: 1000, height: 200, toJSON: () => ({}) } as DOMRect
    }
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    HTMLCanvasElement.prototype.getContext = realGetContext
    Element.prototype.getBoundingClientRect = realGetRect
  })

  const NO_SELECTION: string[] = []

  function mount(overrides: Partial<React.ComponentProps<typeof TimelineCanvas>> = {}) {
    const store = createViewportStore()
    const clock = createPlaybackClock()
    const handlers = {
      onPinClick: vi.fn(),
      onSelectItem: vi.fn(),
      onProjectChange: vi.fn(),
      onOverlayEdit: vi.fn(),
    }
    const utils = render(
      <TimelineCanvas
        project={markerProject}
        clock={clock}
        store={store}
        totalDuration={20}
        fps={30}
        selectedIds={NO_SELECTION}
        pins={PINS}
        {...handlers}
        {...overrides}
      />,
    )
    act(() => { vi.advanceTimersByTime(32) })
    // Pin the scale so x = t × 100 and the pin's flag stands at x=200.
    act(() => { store.set({ pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }) })
    act(() => { vi.advanceTimersByTime(32) })
    return {
      ...utils,
      ...handlers,
      clock,
      surface: utils.container.querySelector('[data-timeline-canvas]') as HTMLElement,
    }
  }

  function mouse(type: string, x: number, y: number) {
    return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 })
  }

  it('reports a pin click by id, through the host\'s own handler', () => {
    const { surface, onPinClick } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', PIN_X, STRIP_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', PIN_X, STRIP_Y)) })
    expect(onPinClick).toHaveBeenCalledTimes(1)
    expect(onPinClick).toHaveBeenCalledWith('cmt-1')
  })

  it('reports the pin, not the marker underneath it, and selects nothing', () => {
    const { surface, onPinClick, onSelectItem, onProjectChange, clock } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', PIN_X, STRIP_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', PIN_X, STRIP_Y)) })
    expect(onPinClick).toHaveBeenCalledWith('cmt-1')
    expect(onSelectItem).not.toHaveBeenCalled()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(clock.get()).toBe(0)
    expectNoMarkerMutation()
  })

  it('opens no rename box when a pin is double-clicked', () => {
    const { surface } = mount()
    act(() => { surface.dispatchEvent(mouse('dblclick', PIN_X, STRIP_Y)) })
    expect(screen.queryByLabelText('Rename marker')).toBeNull()
    expectNoMarkerMutation()
  })

  it('still opens the rename box for a MARKER with no pin on it', () => {
    // The regression that matters most: adding pins must not take marker editing
    // away. Same project, the pin moved off t=2, and the marker behaves exactly
    // as it did before pins existed.
    const { surface } = mount({ pins: [{ id: 'elsewhere', t: 6, label: '2' }] })
    act(() => { surface.dispatchEvent(mouse('dblclick', PIN_X, STRIP_Y)) })
    expect(screen.getByLabelText('Rename marker')).toBeTruthy()
  })

  it('is inert when the host passes pins but no handler', () => {
    // No crash, and still no fall-through: the press is consumed by the pin
    // rather than reaching the marker or the ruler underneath.
    const { surface, onSelectItem, clock } = mount({ onPinClick: undefined })
    act(() => { surface.dispatchEvent(mouse('mousedown', PIN_X, STRIP_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', PIN_X, STRIP_Y)) })
    expect(onSelectItem).not.toHaveBeenCalled()
    expect(clock.get()).toBe(0)
    expectNoMarkerMutation()
  })

  it('leaves a project with no pins at all exactly as it was', () => {
    // No pins: the strip is the marker's alone, so the same click selects the
    // marker and the double-click renames it — the pre-pins behaviour.
    const { surface, onSelectItem, onPinClick } = mount({ pins: undefined })
    act(() => { surface.dispatchEvent(mouse('mousedown', PIN_X, STRIP_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', PIN_X, STRIP_Y)) })
    expect(onPinClick).not.toHaveBeenCalled()
    expect(onSelectItem).toHaveBeenCalledWith('m1', false)
  })
})
