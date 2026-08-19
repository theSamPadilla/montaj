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

// One base track (row y 0–56) and one audio lane (y 60–100).
const project = {
  id: 'p',
  tracks: [[
    { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 20 },
    { id: 'c1', type: 'video', src: 'b.mp4', start: 4, end: 8, inPoint: 0, outPoint: 4, sourceDuration: 20 },
  ]],
  audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 5, lane: 0 }] },
} as unknown as Project

const TOTAL_DURATION = 13
const SNAP_BOUNDARIES = [0, 4, 8, 1, 5]

function mount(overrides: Partial<React.ComponentProps<typeof TimelineCanvas>> = {}) {
  const store = createViewportStore()
  const clock = createPlaybackClock()
  const handlers = {
    onSelectItem: vi.fn(),
    onProjectChange: vi.fn(),
    onOverlayEdit: vi.fn(),
    onInspectClip: vi.fn(),
    onInspectAudio: vi.fn(),
    setMarkers: vi.fn(),
  }
  const renders = vi.fn()
  function Sibling() { renders(); return null }

  const utils = render(
    <>
      <TimelineCanvas
        project={project}
        clock={clock}
        store={store}
        totalDuration={TOTAL_DURATION}
        selectedIds={[]}
        markers={[null, null]}
        snapBoundaries={SNAP_BOUNDARIES}
        {...handlers}
        {...overrides}
      />
      <Sibling />
    </>,
  )
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
    surface: utils.container.querySelector('[data-timeline-canvas]') as HTMLElement,
  }
}

function mouse(type: string, x: number, y: number, init: MouseEventInit = {}) {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, ...init })
}

describe('TimelineCanvas — pointer wiring', () => {
  it('seeks the clock from a press on empty timeline', () => {
    const { surface, clock } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, 20)) })
    expect(clock.get()).toBeCloseTo(9)
    act(() => { document.dispatchEvent(mouse('mouseup', 900, 20)) })
  })

  it('converts client coordinates into surface coordinates', () => {
    // The stubbed rect is at the origin, so shift it and check the seek moves.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { x: 200, y: 50, top: 50, left: 200, right: 1200, bottom: 150, width: 1000, height: 100, toJSON: () => ({}) } as DOMRect
    }
    const { surface, clock } = mount()
    // Client (1100, 70) is surface (900, 20) — empty track area at t=9.
    act(() => { surface.dispatchEvent(mouse('mousedown', 1100, 70)) })
    expect(clock.get()).toBeCloseTo(9)
    act(() => { document.dispatchEvent(mouse('mouseup', 1100, 70)) })
  })

  it('selects a clip on a click, through the host\'s own handler', () => {
    const { surface, onSelectItem, onProjectChange } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, 20)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 200, 20)) })
    expect(onSelectItem).toHaveBeenCalledWith('c0', false)
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('passes the additive modifier through', () => {
    const { surface, onSelectItem } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, 20, { shiftKey: true })) })
    act(() => { document.dispatchEvent(mouse('mouseup', 200, 20, { shiftKey: true })) })
    expect(onSelectItem).toHaveBeenCalledWith('c0', true)
  })

  it('drives a drag through onProjectChange per move and onOverlayEdit once', () => {
    const { surface, onProjectChange, onOverlayEdit, onSelectItem } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, 20)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 250, 20)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 300, 20)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 300, 20)) })

    expect(onProjectChange).toHaveBeenCalledTimes(2)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    expect(onSelectItem).not.toHaveBeenCalled()

    const committed = onOverlayEdit.mock.calls[0][0] as Project
    expect((committed.tracks ?? []).flat().find(i => i.id === 'c0')).toMatchObject({ start: 1, end: 5 })
  })

  it('trims from a press on the out handle', () => {
    const { surface, onProjectChange } = mount()
    // c0 ends at t=4 → x=400; its out handle is 390–400.
    act(() => { surface.dispatchEvent(mouse('mousedown', 396, 20)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 296, 20)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 296, 20)) })

    const edited = onProjectChange.mock.calls[0][0] as Project
    expect((edited.tracks ?? []).flat().find(i => i.id === 'c0')).toMatchObject({ end: 3, outPoint: 3 })
  })

  it('cycles the markers on a double-click over empty timeline', () => {
    const { surface, setMarkers } = mount()
    act(() => { surface.dispatchEvent(mouse('dblclick', 900, 20)) })
    expect(setMarkers).toHaveBeenCalledWith([9, null])
  })

  it('opens the inspectors on a double-click over an item', () => {
    const { surface, onInspectClip, onInspectAudio } = mount()
    act(() => { surface.dispatchEvent(mouse('dblclick', 200, 20)) })
    expect(onInspectClip).toHaveBeenCalledWith('c0')
    act(() => { surface.dispatchEvent(mouse('dblclick', 300, 80)) })
    expect(onInspectAudio).toHaveBeenCalledWith('a0')
  })

  it('writes the cursor straight to the node, without a React render', () => {
    const { surface, renders } = mount()
    const before = renders.mock.calls.length

    act(() => { surface.dispatchEvent(mouse('mousemove', 200, 20)) })
    expect(surface.style.cursor).toBe('grab')

    act(() => { surface.dispatchEvent(mouse('mousemove', 396, 20)) })
    expect(surface.style.cursor).toBe('ew-resize')

    act(() => { surface.dispatchEvent(mouse('mousemove', 900, 20)) })
    expect(surface.style.cursor).toBe('pointer')

    expect(renders.mock.calls.length).toBe(before)
  })

  it('keeps the document listeners only for the length of a gesture', () => {
    const { surface, clock, onProjectChange } = mount()

    // No press: page-wide movement is ignored.
    act(() => { document.dispatchEvent(mouse('mousemove', 500, 20)) })
    expect(onProjectChange).not.toHaveBeenCalled()

    act(() => { surface.dispatchEvent(mouse('mousedown', 900, 20)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 950, 20)) })
    expect(clock.get()).toBeCloseTo(9.5)
    act(() => { document.dispatchEvent(mouse('mouseup', 950, 20)) })

    // After release, movement over the page no longer scrubs.
    act(() => { document.dispatchEvent(mouse('mousemove', 100, 20)) })
    expect(clock.get()).toBeCloseTo(9.5)
  })

  it('ignores non-primary buttons', () => {
    const { surface, clock } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, 20, { button: 2 })) })
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
    act(() => { surface.dispatchEvent(mouse('mousedown', 900, 20)) })
    const seeked = clock.get()
    unmount()
    act(() => { document.dispatchEvent(mouse('mousemove', 100, 20)) })
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
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, 20)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 200, 4)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 200, -24)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 200, -24)) })

    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const tracks = committed.tracks ?? []
    // The true 44px upward travel must land c0 on a NEW track above its
    // source track, not undo the drag back onto the track it started on.
    expect(tracks).toHaveLength(2)
    expect(tracks[0].some(i => i.id === 'c0')).toBe(false)
    expect(tracks[1].some(i => i.id === 'c0')).toBe(true)
  })

  it('does nothing when the host supplies no edit callbacks', () => {
    const { surface } = mount({ onProjectChange: undefined, onOverlayEdit: undefined, onSelectItem: undefined })
    expect(() => {
      act(() => { surface.dispatchEvent(mouse('mousedown', 200, 20)) })
      act(() => { document.dispatchEvent(mouse('mousemove', 300, 20)) })
      act(() => { document.dispatchEvent(mouse('mouseup', 300, 20)) })
    }).not.toThrow()
  })
})
