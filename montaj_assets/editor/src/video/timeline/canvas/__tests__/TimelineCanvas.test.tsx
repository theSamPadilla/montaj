/// <reference types="vitest/globals" />
/**
 * SP5 T4 — the canvas surface's wiring. The painter and the viewport math are
 * covered as pure units elsewhere; what's asserted here is the part only a
 * mounted component can show: that redraws happen imperatively.
 *
 * jsdom has no 2D canvas and no ResizeObserver, so both are stubbed — the
 * component's own scheduling, subscriptions and layer split are what's under
 * test, not the rasterizer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { TIMELINE_COLORS } from '../draw'
import { createViewportStore, type ViewportStore } from '../viewport'

interface RecordedCall { method: string; args: unknown[] }

const recorders = new Map<HTMLCanvasElement, RecordedCall[]>()
let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect

function recorderFor(canvas: HTMLCanvasElement): RecordedCall[] {
  const existing = recorders.get(canvas)
  if (existing) return existing
  const calls: RecordedCall[] = []
  recorders.set(canvas, calls)
  return calls
}

function contextFor(canvas: HTMLCanvasElement) {
  const calls = recorderFor(canvas)
  const props: Record<string, unknown> = {}
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop in props) return props[prop]
      if (prop === 'createLinearGradient') {
        return () => ({ addColorStop: () => {} })
      }
      return (...args: unknown[]) => { calls.push({ method: prop, args }) }
    },
    set(_t, prop: string, value: unknown) {
      props[prop] = value
      calls.push({ method: `set:${prop}`, args: [value] })
      return true
    },
  })
}

beforeEach(() => {
  recorders.clear()
  realGetContext = HTMLCanvasElement.prototype.getContext
  realGetRect = Element.prototype.getBoundingClientRect
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return contextFor(this)
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
  // jsdom lays everything out at 0×0; the surface needs a size to paint into.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 120, width: 1000, height: 120, toJSON: () => ({}) } as DOMRect
  }
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = realGetContext
  Element.prototype.getBoundingClientRect = realGetRect
})

const project = {
  id: 'p1',
  tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 8 }]],
  audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 5 }] },
} as unknown as Project

function mount(store: ViewportStore, clock = createPlaybackClock(), onRender?: () => void) {
  function Sibling() { onRender?.(); return null }
  const utils = render(
    <>
      <TimelineCanvas
        project={project}
        clock={clock}
        store={store}
        totalDuration={20}
        selectedIds={[]}
        markers={[null, null]}
      />
      <Sibling />
    </>,
  )
  act(() => { vi.advanceTimersByTime(32) })
  const canvases = utils.container.querySelectorAll('canvas')
  return {
    ...utils,
    clock,
    content: recorderFor(canvases[0] as HTMLCanvasElement),
    overlay: recorderFor(canvases[1] as HTMLCanvasElement),
  }
}

describe('TimelineCanvas', () => {
  it('paints both layers on mount and sizes the viewport from the surface', () => {
    const store = createViewportStore()
    const { content, overlay } = mount(store)

    expect(content.some(c => c.method === 'clearRect')).toBe(true)
    expect(overlay.some(c => c.method === 'clearRect')).toBe(true)
    // First layout starts fitted: 20s across 1000px.
    expect(store.get()).toMatchObject({ widthPx: 1000, pxPerSecond: 50, scrollSeconds: 0 })
    // Backing stores follow the CSS box (dpr 1 in jsdom).
    expect(document.querySelector('canvas')!.getAttribute('width')).toBe('1000')
  })

  it('moves the playhead without repainting the content or re-rendering React', () => {
    const store = createViewportStore()
    const renders = vi.fn()
    const { content, overlay, clock } = mount(store, createPlaybackClock(), renders)

    const contentCallsBefore = content.length
    const rendersBefore = renders.mock.calls.length
    overlay.length = 0

    act(() => { clock.set(3) })
    act(() => { vi.advanceTimersByTime(32) })

    expect(overlay.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.playhead)).toBe(true)
    expect(content.length).toBe(contentCallsBefore)
    expect(renders.mock.calls.length).toBe(rendersBefore)
  })

  it('coalesces a burst of clock ticks into a single frame', () => {
    const store = createViewportStore()
    const { overlay, clock } = mount(store)
    overlay.length = 0

    act(() => { for (let t = 1; t <= 10; t++) clock.set(t) })
    act(() => { vi.advanceTimersByTime(32) })

    expect(overlay.filter(c => c.method === 'clearRect')).toHaveLength(1)
  })

  it('zooms at the cursor on ⌘/Ctrl-wheel without re-rendering React', () => {
    const store = createViewportStore()
    const renders = vi.fn()
    const { container } = mount(store, createPlaybackClock(), renders)
    const rendersBefore = renders.mock.calls.length
    const surface = container.querySelector('[data-timeline-canvas]') as HTMLElement

    const before = store.get()
    act(() => {
      surface.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 500, bubbles: true, cancelable: true }))
    })

    expect(store.get().pxPerSecond).toBeCloseTo(before.pxPerSecond * Math.exp(0.2), 6)
    expect(renders.mock.calls.length).toBe(rendersBefore)
  })

  it('leaves a plain wheel to the page', () => {
    const store = createViewportStore()
    const { container } = mount(store)
    const surface = container.querySelector('[data-timeline-canvas]') as HTMLElement
    const before = store.get()

    const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    act(() => { surface.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(false)
    expect(store.get()).toEqual(before)
  })

  it('repaints the content when the project changes', () => {
    const store = createViewportStore()
    const clock = createPlaybackClock()
    const { rerender, container } = render(
      <TimelineCanvas project={project} clock={clock} store={store} totalDuration={20} selectedIds={[]} markers={[null, null]} />,
    )
    act(() => { vi.advanceTimersByTime(32) })
    const content = recorderFor(container.querySelectorAll('canvas')[0] as HTMLCanvasElement)
    content.length = 0

    const edited = { ...project, tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 9 }]] } as unknown as Project
    rerender(<TimelineCanvas project={edited} clock={clock} store={store} totalDuration={20} selectedIds={[]} markers={[null, null]} />)
    act(() => { vi.advanceTimersByTime(32) })

    expect(content.some(c => c.method === 'clearRect')).toBe(true)
  })
})
