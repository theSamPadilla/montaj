/// <reference types="vitest/globals" />
/**
 * Edge auto-scroll — while an item/trim/audio/caption drag holds the pointer
 * near the surface's left or right edge, the view pans to follow it (standard
 * NLE behaviour), rather than trapping the gesture at whatever was on screen
 * when the drag started.
 *
 * The ramp/clamp MATH is `edgeScrollDelta` in viewport.ts, covered exhaustively
 * as pure data in viewport.test.ts. What can only be shown with a mounted
 * component is here: that a real drag actually starts the loop, that panning
 * re-feeds the pointer machine so the dragged item keeps tracking, that it
 * clamps and stops at the legal scroll range, and that it stands down when the
 * pointer leaves the zone, the drag ends, or the gesture is a ruler scrub.
 *
 * jsdom's `performance.now()` is NOT tied to Vitest's fake timers (verified:
 * advancing the fake clock by 16ms moves it by a fraction of a millisecond of
 * REAL wall time), so the rAF loop's own frame-delta math would see near-zero
 * `dt` if left alone — dozens of ticks to see any pan at all, and a flaky
 * amount at that. `performance.now` is stubbed directly in these tests so each
 * flushed tick reports a controlled elapsed time instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { createViewportStore, maxScrollSeconds, type Viewport } from '../viewport'
import { computeTimelineLayout } from '../draw'

let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect

function stubContext() {
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
      return () => {}
    },
    set() { return true },
  })
}

beforeEach(() => {
  realGetContext = HTMLCanvasElement.prototype.getContext
  realGetRect = Element.prototype.getBoundingClientRect
  HTMLCanvasElement.prototype.getContext = (() => stubContext()) as unknown as typeof HTMLCanvasElement.prototype.getContext
  // Fixed 1000×100 surface at the page origin, matching the pointer suite's
  // harness — the edge-zone math below (x<40 / x>960) is pinned against it.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 100, width: 1000, height: 100, toJSON: () => ({}) } as DOMRect
  }
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = realGetContext
  Element.prototype.getBoundingClientRect = realGetRect
})

// A wide project (well past what 1000px×100px/s shows at once) so there is
// real room to auto-scroll into.
const project = {
  id: 'p',
  tracks: [{
    id: 'trk-0',
    items: [
      { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 20 },
      { id: 'c1', type: 'video', src: 'b.mp4', start: 4, end: 20, inPoint: 0, outPoint: 16, sourceDuration: 20 },
    ],
  }],
} as unknown as Project

const ROW_Y = (() => {
  const row = computeTimelineLayout(project).rows[0]
  return Math.round(row.y + row.height / 2)
})()

const RULER_Y = (() => {
  const ruler = computeTimelineLayout(project).ruler
  return Math.round(ruler.y + ruler.height / 2)
})()

const TOTAL_DURATION = 60
const FPS = 30

// Pinned scale: pxPerSecond=100, widthPx=1000 → 10s visible. Rightmost legal
// scrollSeconds is then maxScrollSeconds(vp, 60) = 60 - 10 + 10×0.25 = 52.5.
const PINNED_VIEWPORT: Viewport = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }
const RIGHTMOST_SCROLL = maxScrollSeconds(PINNED_VIEWPORT, TOTAL_DURATION)

function mount() {
  const store = createViewportStore()
  const clock = createPlaybackClock()
  const onProjectChange = vi.fn()
  const onOverlayEdit = vi.fn()

  const utils = render(
    <TimelineCanvas
      project={project}
      clock={clock}
      store={store}
      totalDuration={TOTAL_DURATION}
      fps={FPS}
      selectedIds={[]}
      onProjectChange={onProjectChange}
      onOverlayEdit={onOverlayEdit}
    />,
  )
  act(() => { vi.advanceTimersByTime(32) })
  act(() => { store.set(PINNED_VIEWPORT) })
  act(() => { vi.advanceTimersByTime(32) })

  return {
    ...utils,
    store,
    clock,
    onProjectChange,
    onOverlayEdit,
    surface: utils.container.querySelector('[data-timeline-canvas]') as HTMLElement,
  }
}

function mouse(type: string, x: number, y: number, init: MouseEventInit = {}) {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, ...init })
}

/** Installs a `performance.now()` stub the test fully controls: each call
 *  returns `clock.value`, which the test advances explicitly between ticks —
 *  decoupled from Vitest's fake timers (see file header). */
function stubPerfNow() {
  const state = { value: 0 }
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => state.value)
  return {
    advance(ms: number) { state.value += ms },
    restore() { spy.mockRestore() },
  }
}

/** c0's start time in the most recent `projectChange` the gesture emitted.
 *  The `project` prop here is a fixed constant (nothing echoes edits back), so
 *  every emitted project is recomputed from the press-time one — the latest
 *  call is always the gesture's current position, never an accumulation. */
function lastC0Start(calls: unknown[][]): number {
  expect(calls.length).toBeGreaterThan(0)
  const emitted = calls[calls.length - 1][0] as unknown as {
    tracks: { items: { id: string; start: number }[] }[]
  }
  // Searched across every track: dragging c0 out over c1 makes the mover lift
  // it to a track of its own rather than overlap, so it is not on trk-0 by the
  // time the pan starts.
  const c0 = emitted.tracks.flatMap(t => t.items).find(i => i.id === 'c0')
  expect(c0).toBeDefined()
  return c0!.start
}

describe('TimelineCanvas — edge auto-scroll', () => {
  it('pans the view toward the right edge during a drag, re-feeding the gesture, and clamps at the rightmost legal scroll', () => {
    const perf = stubPerfNow()
    try {
      const { surface, store, onProjectChange } = mount()

      // Press c0's body and cross the drag threshold well inside the surface.
      act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 250, ROW_Y)) })
      const callsAfterRealMove = onProjectChange.mock.calls.length
      expect(callsAfterRealMove).toBeGreaterThan(0)
      expect(store.get().scrollSeconds).toBe(0)

      // Drag to x=990 — inside the 40px right edge zone of a 1000px surface —
      // and hold the pointer there without moving it further.
      act(() => { document.dispatchEvent(mouse('mousemove', 990, ROW_Y)) })

      // First tick only seeds the clock (no prior timestamp to diff against);
      // no pan yet.
      act(() => { vi.advanceTimersByTime(20) })
      expect(store.get().scrollSeconds).toBe(0)

      // Each further tick pans right at a large, clock-controlled dt (capped
      // internally at 0.1s/tick). x=990 sits 30px past the zone's boundary, so
      // the eased ramp gives (30/70)^1.5 ≈ 0.28 of the 1400px/s cap — about
      // 393px/s, i.e. ≈ 0.393s of scroll per tick at this scale — enough ticks
      // to clear the RIGHTMOST_SCROLL clamp (52.5s) and then some, to prove it
      // holds there rather than merely arriving at it.
      for (let i = 0; i < 140; i++) {
        perf.advance(1000)
        act(() => { vi.advanceTimersByTime(20) })
      }

      expect(store.get().scrollSeconds).toBeCloseTo(RIGHTMOST_SCROLL, 5)

      // The pointer's screen position never moved past x=990, yet the machine
      // was re-fed that same point on every panning tick — proof the drag
      // kept tracking as the view slid underneath it, not just on the two
      // real mousemoves above.
      expect(onProjectChange.mock.calls.length).toBeGreaterThan(callsAfterRealMove + 1)

      // Stays clamped — no overshoot, no runaway past the legal range even
      // with more frames available.
      act(() => { vi.advanceTimersByTime(200) })
      expect(store.get().scrollSeconds).toBeCloseTo(RIGHTMOST_SCROLL, 5)

      act(() => { document.dispatchEvent(mouse('mouseup', 990, ROW_Y)) })
    } finally {
      perf.restore()
    }
  })

  it('carries the dragged clip along with the pan, so it stays under the held cursor', () => {
    // The pan is only half the job. If the gesture measured its travel in raw
    // screen pixels it would report NO movement for these frames — the pointer
    // is parked — and the clip would sit at a fixed time while the timeline
    // slid out from under it, drifting away from the hand holding it. What is
    // asserted here is the other half: the clip advances by exactly the pan.
    const perf = stubPerfNow()
    try {
      const { surface, store, onProjectChange } = mount()

      // Grab c0 (0s–4s) 2.0s in, and drag to x=990 — inside the right edge
      // zone — in one move. 9.9s under the cursor, less the 2.0s grab offset.
      act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 990, ROW_Y)) })
      const beforePan = lastC0Start(onProjectChange.mock.calls)
      expect(beforePan).toBeCloseTo(7.9, 5)

      // Ten panning ticks with the pointer held exactly where it was. (The
      // first tick only seeds the frame clock — see the test above.)
      act(() => { vi.advanceTimersByTime(20) })
      for (let i = 0; i < 10; i++) {
        perf.advance(1000)
        act(() => { vi.advanceTimersByTime(20) })
      }

      const scrolled = store.get().scrollSeconds
      expect(scrolled).toBeGreaterThan(0)
      // Far from the clamp, so this is the tracking behaviour and not the
      // timeline's end holding the clip in place.
      expect(scrolled).toBeLessThan(RIGHTMOST_SCROLL)
      expect(lastC0Start(onProjectChange.mock.calls)).toBeCloseTo(beforePan + scrolled, 5)

      act(() => { document.dispatchEvent(mouse('mouseup', 990, ROW_Y)) })
    } finally {
      perf.restore()
    }
  })

  it('stops panning as soon as the pointer moves back out of the edge zone', () => {
    const perf = stubPerfNow()
    try {
      const { surface, store } = mount()
      act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 250, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 990, ROW_Y)) })

      act(() => { vi.advanceTimersByTime(20) }) // seed
      perf.advance(1000)
      act(() => { vi.advanceTimersByTime(20) }) // one real pan
      const pannedTo = store.get().scrollSeconds
      expect(pannedTo).toBeGreaterThan(0)
      expect(pannedTo).toBeLessThan(RIGHTMOST_SCROLL)

      // Pull back to the middle of the surface — well outside either zone.
      act(() => { document.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
      // The already-scheduled tick fires once more, sees the pointer is no
      // longer in a zone, and stands the loop down without panning further.
      perf.advance(1000)
      act(() => { vi.advanceTimersByTime(20) })
      expect(store.get().scrollSeconds).toBe(pannedTo)

      // No further frames are pending — continuing to advance time changes
      // nothing.
      perf.advance(5000)
      act(() => { vi.advanceTimersByTime(200) })
      expect(store.get().scrollSeconds).toBe(pannedTo)

      act(() => { document.dispatchEvent(mouse('mouseup', 500, ROW_Y)) })
    } finally {
      perf.restore()
    }
  })

  it('stops panning the instant the drag ends', () => {
    const perf = stubPerfNow()
    try {
      const { surface, store } = mount()
      act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 250, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 990, ROW_Y)) })

      act(() => { vi.advanceTimersByTime(20) }) // seed
      perf.advance(1000)
      act(() => { vi.advanceTimersByTime(20) }) // one real pan
      const pannedTo = store.get().scrollSeconds
      expect(pannedTo).toBeGreaterThan(0)

      act(() => { document.dispatchEvent(mouse('mouseup', 990, ROW_Y)) })

      // The release tears the loop down synchronously (via the same teardown
      // that removes the document listeners) — no leaked frame keeps panning.
      perf.advance(5000)
      act(() => { vi.advanceTimersByTime(200) })
      expect(store.get().scrollSeconds).toBe(pannedTo)
    } finally {
      perf.restore()
    }
  })

  it('does not auto-scroll for a ruler scrub, even with the pointer held at the edge', () => {
    const perf = stubPerfNow()
    try {
      const { surface, store, clock } = mount()
      // A press on the ruler scrubs immediately (dragging/scrub from the
      // first pointerdown) — held right at the edge zone from the start.
      act(() => { surface.dispatchEvent(mouse('mousedown', 990, RULER_Y)) })
      expect(clock.get()).toBeCloseTo(9.9)
      act(() => { document.dispatchEvent(mouse('mousemove', 990, RULER_Y)) })

      perf.advance(1000)
      act(() => { vi.advanceTimersByTime(200) })
      perf.advance(5000)
      act(() => { vi.advanceTimersByTime(200) })

      // The playhead moved (that's what a scrub does); the VIEWPORT did not.
      expect(store.get().scrollSeconds).toBe(0)

      act(() => { document.dispatchEvent(mouse('mouseup', 990, RULER_Y)) })
    } finally {
      perf.restore()
    }
  })

  it('never auto-scrolls with no active gesture', () => {
    const perf = stubPerfNow()
    try {
      const { surface, store } = mount()
      // Plain hover at the edge, no press.
      act(() => { surface.dispatchEvent(mouse('mousemove', 990, ROW_Y)) })
      perf.advance(1000)
      act(() => { vi.advanceTimersByTime(200) })
      expect(store.get().scrollSeconds).toBe(0)
    } finally {
      perf.restore()
    }
  })
})
