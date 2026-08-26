/// <reference types="vitest/globals" />
/**
 * Footage-bin drop wiring — the browser-owned half of dragging a clip from the
 * (host-side) footage bin onto the canvas timeline.
 *
 * The placement math itself (ripple vs snap, whole-source window, id) is proven
 * as pure data over `insertClipAt` in `cuts.insert.test.ts`, and the target-row
 * rule over `placeDroppedClip` in `placement.test.ts`. What can only be shown
 * with a mounted surface is here: that a `drop` reaches the drop target in
 * surface coordinates, that a bin drop lands a new clip at the time AND on the
 * row under the cursor and commits through the same
 * `onProjectChange`+`onOverlayEdit` pair a discrete edit uses, and that a drop
 * carrying neither our MIME nor files is left entirely alone.
 *
 * The second half covers the OS-FILE drop: the package cannot place a `File`
 * itself (no duration, no proxy, no host path), so it only reports where the
 * drop landed through `onImportFilesToTimeline` — and, crucially, does not
 * claim the drag AT ALL when the host passes no such hook, which is the
 * inert-for-Hub/LP guarantee.
 *
 * jsdom has no 2D canvas, no `DragEvent`, and lays everything out at 0×0. The
 * canvas and the rect are stubbed (the same harness the pointer-wiring suite
 * uses); a file drag is simulated by putting `files` and `types: ['Files']` on
 * the DataTransfer stub, which is exactly the pair the handler reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import { FOOTAGE_DND_MIME, type FootageDropPayload } from '../../../../types'
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

// One video track with two butted clips: c0 [0,4], c1 [4,8].
const project = {
  id: 'p',
  tracks: [{
    id: 'trk-0',
    items: [
      { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 20 },
      { id: 'c1', type: 'video', src: 'b.mp4', start: 4, end: 8, inPoint: 0, outPoint: 4, sourceDuration: 20 },
    ],
  }],
  audio: { tracks: [] },
} as unknown as Project

const TOTAL_DURATION = 13

const PAYLOAD: FootageDropPayload = {
  src: 'new.mp4',
  proxySrc: 'new.proxy.mp4',
  sourceDuration: 2,
  sourceWidth: 1920,
  sourceHeight: 1080,
  name: 'New Clip',
}

function mount(overrides: Partial<React.ComponentProps<typeof TimelineCanvas>> = {}) {
  const store = createViewportStore()
  const clock = createPlaybackClock()
  const handlers = {
    onSelectItem: vi.fn(),
    onProjectChange: vi.fn(),
    onOverlayEdit: vi.fn(),
    onInspectClip: vi.fn(),
    onInspectAudio: vi.fn(),
    onHoverScrub: vi.fn(),
  }

  const utils = render(
    <TimelineCanvas
      project={project}
      clock={clock}
      store={store}
      totalDuration={TOTAL_DURATION}
      fps={30}
      selectedIds={[]}
      {...handlers}
      {...overrides}
    />,
  )
  act(() => { vi.advanceTimersByTime(32) })
  // Pin the scale so the assertions can talk in whole seconds: x = t × 100.
  act(() => { store.set({ pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }) })
  act(() => { vi.advanceTimersByTime(32) })

  return {
    ...utils,
    store,
    clock,
    ...handlers,
    surface: utils.container.querySelector('[data-timeline-canvas]') as HTMLElement,
  }
}

/** A footage-bin drag payload wrapped in a minimal DataTransfer stub — jsdom
 *  has no DragEvent, so a `drop` MouseEvent carries the stub directly. */
function makeDataTransfer(entries: Record<string, string>) {
  return {
    types: Object.keys(entries),
    dropEffect: 'none',
    getData: (t: string) => entries[t] ?? '',
    setData: () => {},
  }
}

/** An OS-file drag. jsdom has no `DragEvent` and no real file list, so the
 *  stub carries the two things the handler actually reads: `types: ['Files']`
 *  during `dragover` (where `getData` is unreadable by design) and `files` on
 *  the drop itself. Deliberately carries NO footage MIME. */
function makeFileDataTransfer(files: File[]) {
  return {
    types: ['Files'],
    files,
    dropEffect: 'none',
    getData: () => '',
    setData: () => {},
  }
}

/** `y` defaults to 20 — with the stubbed rect that is the 4px gap between the
 *  ruler (0..18) and the first row, i.e. "no preferred track", which is what
 *  every pre-existing case here dropped onto. */
function dragEvent(type: string, x: number, dataTransfer: unknown, y = 20) {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer })
  return e
}

// Two video tracks, so a drop's y actually chooses between rows: trk-0 is
// occupied from 0..10, trk-1 only from 0..2.
const twoTrackProject = {
  id: 'p2',
  tracks: [
    {
      id: 'trk-0',
      items: [
        { id: 'a0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 },
      ],
    },
    {
      id: 'trk-1',
      items: [
        { id: 'b0', type: 'video', src: 'b.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2, sourceDuration: 20 },
      ],
    },
  ],
  audio: { tracks: [] },
} as unknown as Project

/** The vertical centre of the row drawn for `trackIdx`, read from the layout
 *  the canvas itself draws from rather than hard-coded — that is the whole
 *  point: the test says WHY this y maps to that track. */
function rowCenterY(p: Project, trackIdx: number): number {
  const row = computeTimelineLayout(p).rows.find(r => r.trackIdx === trackIdx)
  if (!row) throw new Error(`no row for trackIdx ${trackIdx}`)
  return row.y + row.height / 2
}

describe('TimelineCanvas — footage-bin drop', () => {
  it('inserts a clip on the main video track at the time under the cursor', () => {
    const { surface, onProjectChange, onOverlayEdit } = mount()
    // x=900 → t=9, past c1's end (8); a 2s clip lands free at [9, 11].
    const dt = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify(PAYLOAD) })
    act(() => { surface.dispatchEvent(dragEvent('drop', 900, dt)) })

    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)

    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const items = trackItems(committed)[0]
    expect(items).toHaveLength(3)
    const placed = items.find(i => i.src === 'new.mp4')
    expect(placed).toMatchObject({
      type: 'video',
      start: 9,
      end: 11,
      inPoint: 0,
      outPoint: 2,
      sourceDuration: 2,
      proxySrc: 'new.proxy.mp4',
    })
    // The two originals are untouched.
    expect(items.filter(i => i.id === 'c0' || i.id === 'c1')).toHaveLength(2)
  })

  it('places by the same x→time map at a second position', () => {
    const { surface, onOverlayEdit } = mount()
    // x=1000 → t=10; a 2s clip lands free at [10, 12].
    const dt = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify(PAYLOAD) })
    act(() => { surface.dispatchEvent(dragEvent('drop', 1000, dt)) })
    const placed = trackItems(onOverlayEdit.mock.calls[0][0] as Project)[0].find(i => i.src === 'new.mp4')
    expect(placed).toMatchObject({ start: 10, end: 12 })
  })

  it('ripples later clips right by the new clip length when the magnet is on', () => {
    const { surface, onOverlayEdit } = mount({ rippleMode: true })
    // Drop at t=0: with ripple on, everything at/after shifts right by len (2).
    const dt = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify(PAYLOAD) })
    act(() => { surface.dispatchEvent(dragEvent('drop', 0, dt)) })

    const items = trackItems(onOverlayEdit.mock.calls[0][0] as Project)[0]
    expect(items).toHaveLength(3)
    expect(items.find(i => i.src === 'new.mp4')).toMatchObject({ start: 0, end: 2 })
    expect(items.find(i => i.id === 'c0')).toMatchObject({ start: 2, end: 6 })
    expect(items.find(i => i.id === 'c1')).toMatchObject({ start: 6, end: 10 })
  })

  it('does nothing on a drop that carries no footage MIME', () => {
    const { surface, onProjectChange, onOverlayEdit } = mount()
    const dt = makeDataTransfer({ 'text/plain': 'hello' })
    const e = dragEvent('drop', 900, dt)
    act(() => { surface.dispatchEvent(e) })
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
    // A non-footage drop is left for the browser — not intercepted.
    expect(e.defaultPrevented).toBe(false)
  })

  it('ignores a malformed payload without throwing', () => {
    const { surface, onProjectChange, onOverlayEdit } = mount()
    const bad = makeDataTransfer({ [FOOTAGE_DND_MIME]: '{ not json' })
    const missing = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify({ name: 'x' }) })
    expect(() => {
      act(() => { surface.dispatchEvent(dragEvent('drop', 900, bad)) })
      act(() => { surface.dispatchEvent(dragEvent('drop', 900, missing)) })
    }).not.toThrow()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })

  it('accepts the drag on dragover, so the browser will fire a drop', () => {
    const { surface } = mount()
    const dt = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify(PAYLOAD) })
    const e = dragEvent('dragover', 500, dt)
    act(() => { surface.dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('copy')
  })

  it('leaves an unrelated dragover alone', () => {
    const { surface } = mount()
    const dt = makeDataTransfer({ 'text/plain': 'x' })
    const e = dragEvent('dragover', 500, dt)
    act(() => { surface.dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(false)
    expect(dt.dropEffect).toBe('none')
  })

  // ── The target row is now the one under the cursor, via `placeDroppedClip` ──

  it('lands on a DIFFERENT video track when the preferred row is occupied there', () => {
    // Aimed at trk-0 (the row the drop is over), whose clip spans 0..10 — so
    // the 2s clip cannot go where it was dropped. It moves to the nearest
    // video row with room, trk-1, at the SAME time. The old rule pinned every
    // bin drop to the first video track and would have overlapped a0.
    const { surface, onOverlayEdit } = mount({ project: twoTrackProject })
    const dt = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify(PAYLOAD) })
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, dt, rowCenterY(twoTrackProject, 0)))
    })

    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const tracks = trackItems(committed)
    expect(tracks[0].map(i => i.id)).toEqual(['a0'])
    const placed = tracks[1].find(i => i.src === 'new.mp4')
    expect(placed).toMatchObject({ start: 9, end: 11 })
  })

  it('honours the row under the cursor when that row has room', () => {
    // Same project, same time — dropped over trk-1 this time, which is free
    // there, so it stays put rather than being pulled to the base row.
    const { surface, onOverlayEdit } = mount({ project: twoTrackProject })
    const dt = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify(PAYLOAD) })
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, dt, rowCenterY(twoTrackProject, 1)))
    })
    const tracks = trackItems(onOverlayEdit.mock.calls[0][0] as Project)
    expect(tracks[1].find(i => i.src === 'new.mp4')).toMatchObject({ start: 9, end: 11 })
  })
})

describe('TimelineCanvas — OS-file drop', () => {
  function fileList() {
    return [new File(['x'], 'C0042.MP4', { type: 'video/mp4' })]
  }

  it('reports the files, the drop time and the row released over', () => {
    const onImportFilesToTimeline = vi.fn()
    const { surface } = mount({ project: twoTrackProject, onImportFilesToTimeline })
    const files = fileList()
    // x=900 → t=9 (the pinned 100px/s scale). y is the CENTRE of the row the
    // layout draws for trackIdx 1, so this asserts a real, non-default
    // preferredTrackIndex rather than the -1 the ruler/gap would give.
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, makeFileDataTransfer(files), rowCenterY(twoTrackProject, 1)))
    })

    expect(onImportFilesToTimeline).toHaveBeenCalledTimes(1)
    const [gotFiles, placement] = onImportFilesToTimeline.mock.calls[0]
    expect(gotFiles).toEqual(files)
    expect(placement).toEqual({ atTime: 9, preferredTrackIndex: 1, ripple: false })
  })

  // The magnet is editor-internal state with no other route to the host, and
  // the host places the clip seconds later — so the value that reaches the
  // callback has to be the one in force during the GESTURE. Both values are
  // asserted: a test that only ever saw the default would prove nothing.
  it.each([true, false])('carries the ripple mode in force at drop time (%s)', (rippleMode) => {
    const onImportFilesToTimeline = vi.fn()
    const { surface } = mount({ onImportFilesToTimeline, rippleMode })
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, makeFileDataTransfer(fileList())))
    })
    expect(onImportFilesToTimeline.mock.calls[0][1].ripple).toBe(rippleMode)
  })

  it('reports ripple: false when the host never set the mode at all', () => {
    const onImportFilesToTimeline = vi.fn()
    const { surface } = mount({ onImportFilesToTimeline })
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, makeFileDataTransfer(fileList())))
    })
    expect(onImportFilesToTimeline.mock.calls[0][1].ripple).toBe(false)
  })

  it('reports -1 for a drop that lands on no video row at all', () => {
    const onImportFilesToTimeline = vi.fn()
    const { surface } = mount({ project: twoTrackProject, onImportFilesToTimeline })
    // y=20 is the gap between the ruler and the first row — no preference.
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, makeFileDataTransfer(fileList())))
    })
    expect(onImportFilesToTimeline.mock.calls[0][1].preferredTrackIndex).toBe(-1)
  })

  // ── The magnet applies to a filesystem drop too, same rule as the bin drag ──

  it('snaps a filesystem drop\'s atTime to a nearby boundary, the same magnet the bin drop uses', () => {
    const onImportFilesToTimeline = vi.fn()
    // x=995 → t=9.95, within the pinned scale's 20px/100px-per-sec = 0.2s
    // tolerance of the boundary at t=10.
    const { surface } = mount({ onImportFilesToTimeline, snapBoundaries: [10] })
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 995, makeFileDataTransfer(fileList())))
    })
    expect(onImportFilesToTimeline.mock.calls[0][1].atTime).toBe(10)
  })

  it('leaves atTime alone when no boundary is within the magnet tolerance', () => {
    const onImportFilesToTimeline = vi.fn()
    // x=900 → t=9, a full second from the boundary at 10 — outside the 0.2s
    // tolerance, so the drop point is reported unsnapped.
    const { surface } = mount({ onImportFilesToTimeline, snapBoundaries: [10] })
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, makeFileDataTransfer(fileList())))
    })
    expect(onImportFilesToTimeline.mock.calls[0][1].atTime).toBe(9)
  })

  it('does NOT touch the project — placing a file is the host\'s job', () => {
    const onImportFilesToTimeline = vi.fn()
    const { surface, onProjectChange, onOverlayEdit } = mount({ onImportFilesToTimeline })
    act(() => {
      surface.dispatchEvent(dragEvent('drop', 900, makeFileDataTransfer(fileList())))
    })
    expect(onImportFilesToTimeline).toHaveBeenCalledTimes(1)
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })

  it('does not fire on a footage-bin drop — the two paths never cross', () => {
    const onImportFilesToTimeline = vi.fn()
    const { surface, onOverlayEdit } = mount({ onImportFilesToTimeline })
    const dt = makeDataTransfer({ [FOOTAGE_DND_MIME]: JSON.stringify(PAYLOAD) })
    act(() => { surface.dispatchEvent(dragEvent('drop', 900, dt)) })
    expect(onImportFilesToTimeline).not.toHaveBeenCalled()
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
  })

  it('accepts a Files dragover — but only because a hook was supplied', () => {
    const { surface } = mount({ onImportFilesToTimeline: vi.fn() })
    const dt = makeFileDataTransfer(fileList())
    const e = dragEvent('dragover', 500, dt)
    act(() => { surface.dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('copy')
  })

  it('leaves a Files dragover to the browser with no hook — the inert guarantee', () => {
    const { surface } = mount()
    const dt = makeFileDataTransfer(fileList())
    const e = dragEvent('dragover', 500, dt)
    act(() => { surface.dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(false)
    expect(dt.dropEffect).toBe('none')
  })

  it('is a complete no-op on a file DROP with no hook', () => {
    const { surface, onProjectChange, onOverlayEdit } = mount()
    const e = dragEvent('drop', 900, makeFileDataTransfer(fileList()))
    act(() => { surface.dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(false)
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })
})
