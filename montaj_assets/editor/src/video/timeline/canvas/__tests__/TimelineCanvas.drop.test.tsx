/// <reference types="vitest/globals" />
/**
 * Footage-bin drop wiring — the browser-owned half of dragging a clip from the
 * (host-side) footage bin onto the canvas timeline.
 *
 * The placement math itself (ripple vs snap, whole-source window, id) is proven
 * as pure data over `insertClipAt` in `cuts.insert.test.ts`. What can only be
 * shown with a mounted surface is here: that a `drop` carrying our MIME reaches
 * the drop target in surface coordinates, lands a new clip on the main video
 * track at the time under the cursor, and commits through the same
 * `onProjectChange`+`onOverlayEdit` pair a discrete edit uses — and that a drop
 * with no footage MIME is left entirely alone.
 *
 * jsdom has no 2D canvas and lays everything out at 0×0, so both are stubbed —
 * the same harness the pointer-wiring suite uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import { FOOTAGE_DND_MIME, type FootageDropPayload } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { createViewportStore } from '../viewport'
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

function dragEvent(type: string, x: number, dataTransfer: unknown) {
  const e = new MouseEvent(type, { clientX: x, clientY: 20, bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer })
  return e
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
})
