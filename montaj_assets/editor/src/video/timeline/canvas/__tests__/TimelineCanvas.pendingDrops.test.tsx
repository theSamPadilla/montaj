/// <reference types="vitest/globals" />
/**
 * Pending-import ghosts, at the COMPONENT level — the seam between the host's
 * `PendingDrop[]` and the pixels.
 *
 * `pending-drop.test.ts` proves the painter given an already-resolved
 * `PendingDropBand`. What it cannot reach is the half that lives in
 * `TimelineCanvas`: turning a host's `trackIndex` into a row rectangle
 * (`pendingDropBands`), and repainting the overlay when the prop changes. Both
 * are exactly the join a unit test of either side alone would miss — a ghost
 * resolved against the wrong row, or a correct ghost that never gets painted
 * because nothing marked the layer dirty.
 *
 * The redraw case is the one worth being careful about: the overlay layer is
 * repainted only by the clock, the viewport or a gesture, none of which fire
 * here. So the assertion is deliberately before/after — nothing painted on the
 * first pass, a ghost painted after the prop change — because a test that only
 * looked at the first render would pass with the redraw effect deleted.
 *
 * jsdom has no 2D canvas, so `getContext` hands back a RECORDING proxy, one per
 * canvas element: this surface stacks two (content below, overlay above), and a
 * single shared recorder could not tell which layer a ghost landed on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project, PendingDrop } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { createViewportStore } from '../viewport'
import { timeToX } from '../viewport'
import {
  PENDING_DROP_INSET_PX,
  PENDING_DROP_RADIUS_PX,
  computeTimelineLayout,
} from '../draw'

// ── Recording context, one per canvas element ────────────────────────────

interface RecordedCall { method: string; args: unknown[] }

interface Recorder {
  calls: RecordedCall[]
  of: (method: string) => RecordedCall[]
  reset: () => void
}

const recorders = new Map<HTMLCanvasElement, Recorder>()

function recorderFor(canvas: HTMLCanvasElement) {
  let rec = recorders.get(canvas)
  if (!rec) {
    const calls: RecordedCall[] = []
    rec = {
      calls,
      of: (method: string) => calls.filter(c => c.method === method),
      reset: () => { calls.length = 0 },
    }
    recorders.set(canvas, rec)
  }
  return rec
}

function contextFor(canvas: HTMLCanvasElement) {
  const rec = recorderFor(canvas)
  const props: Record<string, unknown> = {}
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop in props) return props[prop]
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
      return (...args: unknown[]) => { rec.calls.push({ method: prop, args }) }
    },
    set(_t, prop: string, value: unknown) {
      props[prop] = value
      rec.calls.push({ method: `set:${prop}`, args: [value] })
      return true
    },
  })
}

let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect

beforeEach(() => {
  recorders.clear()
  realGetContext = HTMLCanvasElement.prototype.getContext
  realGetRect = Element.prototype.getBoundingClientRect
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return contextFor(this)
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
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
  recorders.clear()
})

// Two video tracks, so a `trackIndex` actually chooses between rows that sit at
// DIFFERENT y — with one row every assertion below would pass by accident.
const project = {
  id: 'p',
  tracks: [
    { id: 'trk-0', items: [{ id: 'a0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }] },
    { id: 'trk-1', items: [{ id: 'b0', type: 'video', src: 'b.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2, sourceDuration: 20 }] },
  ],
  audio: { tracks: [] },
} as unknown as Project

const TOTAL_DURATION = 20

function drop(over: Partial<PendingDrop> = {}): PendingDrop {
  return { id: 'pd-1', atTime: 3, durationSec: 2, trackIndex: 0, label: 'C0042.MP4', ...over }
}

function mount(pendingDrops?: readonly PendingDrop[]) {
  const store = createViewportStore()
  const clock = createPlaybackClock()

  const props = {
    project,
    clock,
    store,
    totalDuration: TOTAL_DURATION,
    fps: 30,
    selectedIds: [] as string[],
  }

  const utils = render(<TimelineCanvas {...props} pendingDrops={pendingDrops} />)
  act(() => { vi.advanceTimersByTime(32) })

  const canvases = utils.container.querySelectorAll('canvas')
  const overlay = recorderFor(canvases[1] as HTMLCanvasElement)
  const content = recorderFor(canvases[0] as HTMLCanvasElement)

  // Pin the scale so x is readable: x = t × 100. Until this lands the surface
  // sits at its own fit scale (1000px / 20s = 50px/s), and the paint that
  // already happened at THAT scale is still in the recorders — so they are
  // cleared between marking the layers dirty and flushing the frame, leaving
  // exactly one settled paint to assert on.
  act(() => { store.set({ pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }) })
  overlay.reset()
  content.reset()
  act(() => { vi.advanceTimersByTime(32) })

  return {
    ...utils,
    store,
    // The surface stacks content first, overlay second (see TimelineCanvas's
    // JSX) — ghosts belong to the overlay.
    overlay,
    content,
    setPendingDrops(next?: readonly PendingDrop[]) {
      utils.rerender(<TimelineCanvas {...props} pendingDrops={next} />)
      act(() => { vi.advanceTimersByTime(32) })
    },
  }
}

/** Where the painter should start the ghost's rounded path, derived from the
 *  layout the canvas itself draws from — never a hard-coded pixel. The fill
 *  path opens at `(x + radius, y)`; see `roundRectPath`. */
function expectedGhostOrigin(trackIdx: number, atTime: number, store: ReturnType<typeof createViewportStore>) {
  const row = computeTimelineLayout(project).rows.find(r => r.trackIdx === trackIdx)
  if (!row) throw new Error(`no row for trackIdx ${trackIdx}`)
  return [
    timeToX(atTime, store.get()) + PENDING_DROP_RADIUS_PX,
    row.y + PENDING_DROP_INSET_PX,
  ]
}

/** The first path the ghost lays down. `setLineDash` is unique to the ghost on
 *  this layer, so its presence is what proves one was drawn at all. */
function ghostOrigin(overlay: Recorder): unknown[] | null {
  if (overlay.of('setLineDash').length === 0) return null
  return overlay.of('moveTo')[0]?.args ?? null
}

describe('TimelineCanvas — pending-drop ghosts', () => {
  it('resolves a trackIndex naming a real row to THAT row\'s rectangle', () => {
    // trackIdx 1 is drawn ABOVE trackIdx 0 (rows descend from the top), so
    // this y is nothing like the base row's — the two cases can't be confused.
    const { overlay, store } = mount([drop({ trackIndex: 1 })])
    expect(ghostOrigin(overlay)).toEqual(expectedGhostOrigin(1, 3, store))
  })

  it('resolves the other row to ITS rectangle, at a different y', () => {
    const { overlay, store } = mount([drop({ trackIndex: 0 })])
    expect(ghostOrigin(overlay)).toEqual(expectedGhostOrigin(0, 3, store))
    // Guard against the two expectations having collapsed into one value.
    expect(expectedGhostOrigin(0, 3, store)).not.toEqual(expectedGhostOrigin(1, 3, store))
  })

  it('falls back to the base video row for trackIndex -1', () => {
    // -1 is "no preference" — the base video row is the LOWEST trackIdx that
    // holds video, which here is trkIdx 0, drawn at the bottom.
    const { overlay, store } = mount([drop({ trackIndex: -1 })])
    expect(ghostOrigin(overlay)).toEqual(expectedGhostOrigin(0, 3, store))
  })

  it('falls back to the base video row for a trackIndex past the end, without throwing', () => {
    // The host's list is asynchronous: the project can lose a track between the
    // drop and the ghost being drawn, leaving a trackIndex that names nothing.
    expect(() => {
      const { overlay, store } = mount([drop({ trackIndex: 99 })])
      expect(ghostOrigin(overlay)).toEqual(expectedGhostOrigin(0, 3, store))
    }).not.toThrow()
  })

  it('resolves each drop in a list independently', () => {
    const { overlay, store } = mount([
      drop({ id: 'pd-1', trackIndex: 1, atTime: 3 }),
      drop({ id: 'pd-2', trackIndex: 0, atTime: 6 }),
    ])
    // Each band lays two paths (fill, then the dashed outline inset by half the
    // stroke), so the fill origins are the even entries.
    const origins = overlay.of('moveTo').filter((_, i) => i % 2 === 0).map(c => c.args)
    expect(origins).toEqual([
      expectedGhostOrigin(1, 3, store),
      expectedGhostOrigin(0, 6, store),
    ])
  })

  it('paints no ghost when pendingDrops is absent or empty', () => {
    for (const value of [undefined, [] as PendingDrop[]]) {
      const { overlay } = mount(value)
      expect(overlay.of('setLineDash')).toHaveLength(0)
      cleanup()
    }
  })

  // ── The redraw wiring ──
  //
  // Nothing else repaints this layer here: the clock never ticks, the viewport
  // is already settled, no gesture runs. So if the prop change did not mark the
  // overlay dirty, the "after" assertion below would still see an empty
  // recorder — which is exactly what makes this a test of the wiring rather
  // than of the first render.

  it('repaints the overlay when pendingDrops APPEARS on a mounted surface', () => {
    const { overlay, store, setPendingDrops } = mount()
    expect(ghostOrigin(overlay)).toBeNull()

    overlay.reset()
    setPendingDrops([drop({ trackIndex: 1 })])
    expect(ghostOrigin(overlay)).toEqual(expectedGhostOrigin(1, 3, store))
  })

  it('repaints when a ghost MOVES, and the new band is at the new row', () => {
    const { overlay, store, setPendingDrops } = mount([drop({ trackIndex: 1 })])
    expect(ghostOrigin(overlay)).toEqual(expectedGhostOrigin(1, 3, store))

    overlay.reset()
    setPendingDrops([drop({ trackIndex: 0, atTime: 6 })])
    expect(ghostOrigin(overlay)).toEqual(expectedGhostOrigin(0, 6, store))
  })

  it('repaints with the ghost GONE when the host retracts it', () => {
    // The retraction is the half that actually matters in production: a ghost
    // that never comes down outlives the import it stood for.
    const { overlay, setPendingDrops } = mount([drop()])
    expect(ghostOrigin(overlay)).not.toBeNull()

    overlay.reset()
    setPendingDrops([])
    expect(overlay.of('clearRect').length).toBeGreaterThan(0)
    expect(overlay.of('setLineDash')).toHaveLength(0)
  })

  it('keeps ghosts off the CONTENT layer, which clips and filmstrips own', () => {
    const { content } = mount([drop()])
    expect(content.of('setLineDash')).toHaveLength(0)
  })
})
