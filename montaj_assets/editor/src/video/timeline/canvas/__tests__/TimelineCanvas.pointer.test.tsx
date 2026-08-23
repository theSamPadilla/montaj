/// <reference types="vitest/globals" />
/**
 * SP5 T5 — the pointer wiring, and only the wiring.
 *
 * Every gesture DECISION is covered as pure data in `pointer-machine.test.ts`.
 * What can only be shown with a mounted component is here: that browser events
 * reach the machine in surface coordinates, that its effects land on the right
 * callbacks, that the document-level listeners live exactly as long as the
 * gesture, and that the cursor is written without a React render.
 *
 * jsdom has no 2D canvas and lays everything out at 0×0, so both are stubbed —
 * the same harness T4's suite uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { createViewportStore } from '../viewport'
import { computeTimelineLayout } from '../draw'
import { trackItems } from '../../timeline-model'

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

// One base track (the tall row, starting at y 0) and one audio lane below it.
// Probes into the track row use small Y's, which stay inside it at any row
// height; the lane's own Y is derived below, since it moves when rows resize.
const project = {
  id: 'p',
  tracks: [{
    id: 'trk-0',
    items: [
      { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 20 },
      { id: 'c1', type: 'video', src: 'b.mp4', start: 4, end: 8, inPoint: 0, outPoint: 4, sourceDuration: 20 },
    ],
  }],
  audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 5, lane: 0 }] },
} as unknown as Project

/** Vertical centre of the audio lane, taken from the painter's own layout. */
const LANE_Y = (() => {
  const lane = computeTimelineLayout(project).lanes[0]
  return Math.round(lane.y + lane.height / 2)
})()

/** Vertical centre of the single visual row, likewise from the layout — the
 *  ruler strip offsets everything below it, so a hardcoded y aims at the gap. */
const ROW_Y = (() => {
  const row = computeTimelineLayout(project).rows[0]
  return Math.round(row.y + row.height / 2)
})()

/** Inside the ruler strip, where scrubbing lives. */
const RULER_Y = (() => {
  const ruler = computeTimelineLayout(project).ruler
  return Math.round(ruler.y + ruler.height / 2)
})()

const TOTAL_DURATION = 13
const SNAP_BOUNDARIES = [0, 4, 8, 1, 5]

function mount(overrides: Partial<React.ComponentProps<typeof TimelineCanvas>> = {}) {
  const store = createViewportStore()
  const clock = createPlaybackClock()
  const handlers = {
    onSelectItem: vi.fn(),
    onSelectItems: vi.fn(),
    onProjectChange: vi.fn(),
    onOverlayEdit: vi.fn(),
    onInspectClip: vi.fn(),
    onInspectAudio: vi.fn(),
    onHoverScrub: vi.fn(),
  }
  const renders = vi.fn()
  function Sibling() { renders(); return null }

  // Wrapped in a component so a test can flip `previewAxis` after mounting
  // without rebuilding the store, the clock or the spies.
  function Surface({ axis }: { axis?: boolean }) {
    return (
      <>
        <TimelineCanvas
          project={project}
          clock={clock}
          store={store}
          totalDuration={TOTAL_DURATION}
          selectedIds={[]}
          snapBoundaries={SNAP_BOUNDARIES}
          {...handlers}
          {...overrides}
          {...(axis === undefined ? {} : { previewAxis: axis })}
        />
        <Sibling />
      </>
    )
  }

  const utils = render(<Surface />)
  act(() => { vi.advanceTimersByTime(32) })
  // Pin the scale so the assertions can talk in whole seconds: x = t × 100.
  act(() => { store.set({ pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }) })
  act(() => { vi.advanceTimersByTime(32) })

  return {
    ...utils,
    store,
    clock,
    renders,
    ...handlers,
    rerenderWithAxis: (axis: boolean) => utils.rerender(<Surface axis={axis} />),
    surface: utils.container.querySelector('[data-timeline-canvas]') as HTMLElement,
  }
}

function mouse(type: string, x: number, y: number, init: MouseEventInit = {}) {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, ...init })
}

describe('TimelineCanvas — pointer wiring', () => {
  it('seeks the clock from a click on empty timeline', () => {
    // On release, not on press: the same press may turn out to be a marquee.
    const { surface, clock } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, ROW_Y)) })
    expect(clock.get()).toBe(0)
    act(() => { document.dispatchEvent(mouse('mouseup', 900, ROW_Y)) })
    expect(clock.get()).toBeCloseTo(9)
  })

  it('seeks on PRESS from the ruler, and keeps scrubbing', () => {
    const { surface, clock } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, RULER_Y)) })
    expect(clock.get()).toBeCloseTo(9)
    act(() => { document.dispatchEvent(mouse('mousemove', 600, RULER_Y)) })
    expect(clock.get()).toBeCloseTo(6)
    act(() => { document.dispatchEvent(mouse('mouseup', 600, RULER_Y)) })
  })

  it('drags a marquee across empty track area and selects what it caught', () => {
    const { surface, onSelectItems } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 300, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 300, ROW_Y)) })
    expect(onSelectItems).toHaveBeenCalledTimes(1)
    const [ids, additive] = onSelectItems.mock.calls[0]
    expect(ids).toEqual(expect.arrayContaining(['c1']))
    expect(additive).toBe(false)
  })

  it('converts client coordinates into surface coordinates', () => {
    // The stubbed rect is at the origin, so shift it and check the seek moves.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { x: 200, y: 50, top: 50, left: 200, right: 1200, bottom: 150, width: 1000, height: 100, toJSON: () => ({}) } as DOMRect
    }
    const { surface, clock } = mount()
    // Client x=1100 is surface x=900 — empty track area at t=9. The y is the
    // row's own centre pushed down by the stubbed rect's top edge.
    act(() => { surface.dispatchEvent(mouse('mousedown', 1100, 50 + ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 1100, 50 + ROW_Y)) })
    expect(clock.get()).toBeCloseTo(9)
  })

  it('selects a clip on a click, through the host\'s own handler', () => {
    const { surface, onSelectItem, onProjectChange } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 200, ROW_Y)) })
    expect(onSelectItem).toHaveBeenCalledWith('c0', false)
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('passes the additive modifier through', () => {
    const { surface, onSelectItem } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y, { shiftKey: true })) })
    act(() => { document.dispatchEvent(mouse('mouseup', 200, ROW_Y, { shiftKey: true })) })
    expect(onSelectItem).toHaveBeenCalledWith('c0', true)
  })

  it('drives a drag through onProjectChange per move and onOverlayEdit once', () => {
    const { surface, onProjectChange, onOverlayEdit, onSelectItem } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 250, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 300, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 300, ROW_Y)) })

    expect(onProjectChange).toHaveBeenCalledTimes(2)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    expect(onSelectItem).not.toHaveBeenCalled()

    const committed = onOverlayEdit.mock.calls[0][0] as Project
    expect(trackItems(committed).flat().find(i => i.id === 'c0')).toMatchObject({ start: 1, end: 5 })
  })

  it('trims from a press on the out handle', () => {
    const { surface, onProjectChange } = mount()
    // c0 ends at t=4 → x=400; its out handle is 390–400.
    act(() => { surface.dispatchEvent(mouse('mousedown', 396, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 296, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 296, ROW_Y)) })

    const edited = onProjectChange.mock.calls[0][0] as Project
    expect(trackItems(edited).flat().find(i => i.id === 'c0')).toMatchObject({ end: 3, outPoint: 3 })
  })

  it('does nothing on a double-click over empty timeline', () => {
    const { surface, onProjectChange, onSelectItem, onInspectClip } = mount()
    act(() => { surface.dispatchEvent(mouse('dblclick', 900, ROW_Y)) })
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onSelectItem).not.toHaveBeenCalled()
    expect(onInspectClip).not.toHaveBeenCalled()
  })

  it('opens the inspectors on a double-click over an item', () => {
    const { surface, onInspectClip, onInspectAudio } = mount()
    act(() => { surface.dispatchEvent(mouse('dblclick', 200, ROW_Y)) })
    expect(onInspectClip).toHaveBeenCalledWith('c0')
    act(() => { surface.dispatchEvent(mouse('dblclick', 300, LANE_Y)) })
    expect(onInspectAudio).toHaveBeenCalledWith('a0')
  })

  it('writes the cursor straight to the node, without a React render', () => {
    const { surface, renders } = mount()
    const before = renders.mock.calls.length

    act(() => { surface.dispatchEvent(mouse('mousemove', 200, ROW_Y)) })
    expect(surface.style.cursor).toBe('grab')

    act(() => { surface.dispatchEvent(mouse('mousemove', 396, ROW_Y)) })
    expect(surface.style.cursor).toBe('ew-resize')

    act(() => { surface.dispatchEvent(mouse('mousemove', 900, ROW_Y)) })
    // Empty track area is the plain arrow: nothing to click, only a marquee
    // to drag out.
    expect(surface.style.cursor).toBe('default')

    act(() => { surface.dispatchEvent(mouse('mousemove', 900, RULER_Y)) })
    expect(surface.style.cursor).toBe('ew-resize')

    expect(renders.mock.calls.length).toBe(before)
  })

  it('keeps the document listeners only for the length of a gesture', () => {
    const { surface, clock, onProjectChange } = mount()

    // No press: page-wide movement is ignored.
    act(() => { document.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
    expect(onProjectChange).not.toHaveBeenCalled()

    // Driven from the ruler, which is where a drag still moves the clock.
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, RULER_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 950, RULER_Y)) })
    expect(clock.get()).toBeCloseTo(9.5)
    act(() => { document.dispatchEvent(mouse('mouseup', 950, RULER_Y)) })

    // After release, movement over the page no longer scrubs.
    act(() => { document.dispatchEvent(mouse('mousemove', 100, ROW_Y)) })
    expect(clock.get()).toBeCloseTo(9.5)
  })

  it('ignores non-primary buttons', () => {
    const { surface, clock } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, ROW_Y, { button: 2 })) })
    expect(clock.get()).toBe(0)
  })

  it('swallows the click so the DOM chrome above cannot seek a second time', () => {
    // Timeline's own container click seeks by percentage of totalDuration,
    // which is not the canvas' time axis. The press has already seeked.
    const onOuterClick = vi.fn()
    const { surface } = mount()
    document.addEventListener('click', onOuterClick)
    try {
      act(() => { surface.dispatchEvent(mouse('click', 900, 20)) })
      expect(onOuterClick).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('click', onOuterClick)
    }
  })

  it('unmounts without leaving document listeners behind', () => {
    const { surface, clock, unmount } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, ROW_Y)) })
    const seeked = clock.get()
    unmount()
    act(() => { document.dispatchEvent(mouse('mousemove', 100, ROW_Y)) })
    expect(clock.get()).toBe(seeked)
  })

  it('freezes the surface rect for a gesture, so a mid-drag reflow cannot shift its own points', () => {
    // Simulates the real bug: the drag's own `projectChange` echo adds a new
    // track row, which reflows the page and shifts the container's rect
    // (here, up by one row's worth — 44px — via scroll anchoring). A live
    // re-read of the rect on every move would make the SAME physical cursor
    // travel compute a different surface delta partway through the gesture.
    const { surface, onOverlayEdit } = mount()

    // Rect at press: top 0. Rect for every read after that: top -44. Installed
    // only now, after `mount()` — mounting itself does one rect read (surface
    // setup) that must not consume the "at mousedown" slot below.
    let reads = 0
    Element.prototype.getBoundingClientRect = function (this: Element) {
      reads += 1
      const top = reads === 1 ? 0 : -44
      return { x: 0, y: top, top, left: 0, right: 1000, bottom: top + 100, width: 1000, height: 100, toJSON: () => ({}) } as DOMRect
    }

    // c0 is on the sole video track (row y 0–56). Press its body, then drag
    // straight up 44px in PAGE coordinates — one row's worth — well past the
    // drag threshold, to a new top track.
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 200, 4)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 200, -24)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 200, -24)) })

    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const tracks = committed.tracks ?? []
    // The true 44px upward travel must land c0 on a NEW track above its
    // source track, not undo the drag back onto the track it started on.
    expect(tracks).toHaveLength(2)
    expect(tracks[0].items.some(i => i.id === 'c0')).toBe(false)
    expect(tracks[1].items.some(i => i.id === 'c0')).toBe(true)
  })

  it('does nothing when the host supplies no edit callbacks', () => {
    const { surface } = mount({ onProjectChange: undefined, onOverlayEdit: undefined, onSelectItem: undefined })
    expect(() => {
      act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 300, ROW_Y)) })
      act(() => { document.dispatchEvent(mouse('mouseup', 300, ROW_Y)) })
    }).not.toThrow()
  })
})

// ── Preview axis ─────────────────────────────────────────────────────────
//
// Off (the default) this surface behaves exactly as every case above shows —
// clicks seek, nothing hovers. On, moving the pointer reports the time under it
// so the host can preview that frame, WITHOUT touching the playback clock.

describe('TimelineCanvas — preview axis', () => {
  it('reports nothing on hover while the axis is off', () => {
    const { surface, clock, onHoverScrub } = mount()
    act(() => { surface.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
    expect(onHoverScrub).not.toHaveBeenCalled()
    expect(clock.get()).toBe(0)
  })

  it('reports the hovered time while the axis is on, without moving the clock', () => {
    const { surface, clock, onHoverScrub } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
    act(() => { vi.advanceTimersByTime(32) })
    expect(onHoverScrub).toHaveBeenCalledWith(5)
    expect(clock.get()).toBe(0)
  })

  it('tracks the pointer across the surface, one frame at a time', () => {
    const { surface, clock, onHoverScrub } = mount({ previewAxis: true })
    for (const x of [200, 640, 900]) {
      act(() => { surface.dispatchEvent(mouse('mousemove', x, 20)) })
      act(() => { vi.advanceTimersByTime(32) })
    }
    expect(onHoverScrub.mock.calls.map(c => c[0])).toEqual([2, 6.4, 9])
    expect(clock.get()).toBe(0)
  })

  it('coalesces a burst of moves into ONE request, for the latest position', () => {
    // A trackpad sweep delivers far more moves than the display can show, and
    // on long-GOP media each seek cancels the decode still in flight — the
    // reason a fast scrub flashes black. Intermediate positions are dropped,
    // not queued, so the request is always where the pointer is NOW.
    const { surface, onHoverScrub } = mount({ previewAxis: true })
    act(() => {
      for (const x of [100, 200, 300, 400, 500, 600, 700]) {
        surface.dispatchEvent(mouse('mousemove', x, 20))
      }
    })
    act(() => { vi.advanceTimersByTime(32) })
    expect(onHoverScrub.mock.calls.map(c => c[0])).toEqual([7])
  })

  it('draws the cursor line on every move, even the coalesced ones', () => {
    // Only the frame REQUEST is rate-limited. The line itself must stay glued
    // to the pointer or the affordance feels broken.
    const { surface } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousemove', 300, ROW_Y)) })
    act(() => { surface.dispatchEvent(mouse('mousemove', 800, ROW_Y)) })
    // No assertion on emissions here — TimelineCanvas.test.tsx owns the paint
    // proof; this pins that a burst never throws or drops the redraw path.
    act(() => { vi.advanceTimersByTime(32) })
  })

  it('drops a queued request when the pointer leaves before it fires', () => {
    // Otherwise a stale position lands one frame after the release and pins the
    // preview to a frame the pointer has already left.
    const { surface, onHoverScrub } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
    act(() => { surface.dispatchEvent(mouse('mouseleave', 500, 20)) })
    act(() => { vi.advanceTimersByTime(32) })
    expect(onHoverScrub.mock.calls.map(c => c[0])).toEqual([null])
  })

  it('hovers over clips too, not just bare track area', () => {
    // The pointer is over clip c0's body (row y 0-56); the preview should follow
    // it there exactly as over empty space.
    const { surface, onHoverScrub } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousemove', 250, ROW_Y)) })
    act(() => { vi.advanceTimersByTime(32) })
    expect(onHoverScrub).toHaveBeenCalledWith(2.5)
  })

  it('releases the override when the pointer leaves the surface', () => {
    const { surface, onHoverScrub } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
    act(() => { vi.advanceTimersByTime(32) })
    onHoverScrub.mockClear()
    act(() => { surface.dispatchEvent(mouse('mouseleave', 500, 20)) })
    expect(onHoverScrub).toHaveBeenCalledWith(null)
  })

  it('releases the override when a gesture starts, and the click still seeks', () => {
    // A press hands the playhead to the gesture; leaving a hover override up
    // would pin the preview to a frame the drag is moving away from.
    const { surface, clock, onHoverScrub } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
    act(() => { vi.advanceTimersByTime(32) })
    onHoverScrub.mockClear()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, ROW_Y)) })
    expect(onHoverScrub).toHaveBeenCalledWith(null)
    // The seek itself lands on release now — empty space defers, because the
    // press may still turn into a marquee.
    act(() => { document.dispatchEvent(mouse('mouseup', 900, ROW_Y)) })
    expect(clock.get()).toBeCloseTo(9)
  })

  it('clicking a clip seeks with the axis on, exactly as with it off', () => {
    const { surface, clock, onSelectItem } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 200, ROW_Y)) })
    expect(onSelectItem).toHaveBeenCalledWith('c0', false)
    expect(clock.get()).toBeCloseTo(2)
  })

  it('releases the override when the axis is switched off mid-hover', () => {
    // No further mousemove is coming to do it, so the preview would otherwise
    // stay frozen on whatever frame the pointer last rested over.
    const { surface, onHoverScrub, rerenderWithAxis } = mount({ previewAxis: true })
    act(() => { surface.dispatchEvent(mouse('mousemove', 500, ROW_Y)) })
    act(() => { vi.advanceTimersByTime(32) })
    onHoverScrub.mockClear()
    act(() => { rerenderWithAxis(false) })
    expect(onHoverScrub).toHaveBeenCalledWith(null)
  })
})
