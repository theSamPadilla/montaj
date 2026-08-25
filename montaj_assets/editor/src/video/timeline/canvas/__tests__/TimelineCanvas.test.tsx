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
import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { LIGHT_TIMELINE_COLORS, TIMELINE_COLORS, type TimelineMode } from '../draw'
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

// Stable identity: the content layer's redraw effect keys on the `selectedIds`
// prop, so a fresh literal on every rerender would repaint the content and
// make the guide's layer-isolation assertion meaningless. Timeline passes
// React state here, which has exactly this stability.
const NO_SELECTION: string[] = []

function mount(
  store: ViewportStore,
  clock = createPlaybackClock(),
  onRender?: () => void,
  selectedIds: string[] = NO_SELECTION,
) {
  function Sibling() { onRender?.(); return null }
  function Surface({ previewAxis = false }: { previewAxis?: boolean }) {
    return (
      <>
        <TimelineCanvas
          project={project}
          clock={clock}
          store={store}
          totalDuration={20}
          fps={30}
          selectedIds={selectedIds}
          previewAxis={previewAxis}
        />
        <Sibling />
      </>
    )
  }
  const utils = render(<Surface />)
  act(() => { vi.advanceTimersByTime(32) })
  const canvases = utils.container.querySelectorAll('canvas')
  return {
    ...utils,
    container: utils.container,
    setAxis: (on: boolean) => utils.rerender(<Surface previewAxis={on} />),
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

  it('repaints only the overlay when the axis cursor moves — it shares the playhead layer', () => {
    // Tracking the pointer must cost what moving the playhead costs: one
    // overlay repaint, no content repaint. A cursor line on the content layer
    // would repaint every clip on every mousemove, which is the exact cost this
    // surface exists to avoid — this is the test that would catch it.
    const store = createViewportStore()
    const { content, overlay, container, setAxis } = mount(store)
    act(() => { setAxis(true) })
    act(() => { vi.advanceTimersByTime(32) })

    const surface = container.querySelector('[data-timeline-canvas]') as HTMLElement
    const contentCallsBefore = content.length
    overlay.length = 0

    act(() => {
      surface.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 20, bubbles: true }))
    })
    act(() => { vi.advanceTimersByTime(32) })

    expect(overlay.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.cursor)).toBe(true)
    expect(overlay.filter(c => c.method === 'clearRect')).toHaveLength(1)
    expect(content.length).toBe(contentCallsBefore)
  })

  // ── Trim-handle hover: the one part of the affordance that needs a mount ──
  //
  // `drawTrimHandle` is covered as a pure unit in draw.test.ts. What only a
  // mounted surface can show is that resting the pointer on a handle reaches
  // the painter at all — the hit-test, the change-detection and the content
  // repaint are three separate places this can silently not happen.

  it('lights the handle under the pointer, repainting the content once', () => {
    const store = createViewportStore()
    const { content, container } = mount(store, createPlaybackClock(), undefined, ['c0'])
    const surface = container.querySelector('[data-timeline-canvas]') as HTMLElement
    content.length = 0

    // c0 ends at 8s; at 50px/s that is x=400, so x=395 is inside its out handle.
    act(() => {
      surface.dispatchEvent(new MouseEvent('mousemove', { clientX: 395, clientY: 60, bubbles: true }))
    })
    act(() => { vi.advanceTimersByTime(32) })

    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.handleFillHovered)).toBe(true)
    // The other handle stays at its resting fill — only one is ever lit.
    expect(content.filter(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.handleFill)).toHaveLength(1)
    expect(content.filter(c => c.method === 'clearRect')).toHaveLength(1)
  })

  it('takes the light off again when the pointer moves onto the clip body', () => {
    const store = createViewportStore()
    const { content, container } = mount(store, createPlaybackClock(), undefined, ['c0'])
    const surface = container.querySelector('[data-timeline-canvas]') as HTMLElement

    act(() => { surface.dispatchEvent(new MouseEvent('mousemove', { clientX: 395, clientY: 60, bubbles: true })) })
    act(() => { vi.advanceTimersByTime(32) })
    content.length = 0

    act(() => { surface.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 60, bubbles: true })) })
    act(() => { vi.advanceTimersByTime(32) })

    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.handleFillHovered)).toBe(false)
    expect(content.filter(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.handleFill)).toHaveLength(2)
  })

  it('costs no content repaint at all when nothing is selected', () => {
    // Handles are drawn on selected items only, so with an empty selection
    // there is nothing to light and hovering must stay as cheap as it was.
    const store = createViewportStore()
    const { content, container } = mount(store)
    const surface = container.querySelector('[data-timeline-canvas]') as HTMLElement
    const before = content.length

    act(() => { surface.dispatchEvent(new MouseEvent('mousemove', { clientX: 395, clientY: 60, bubbles: true })) })
    act(() => { vi.advanceTimersByTime(32) })

    expect(content.length).toBe(before)
  })

  it('never rings itself when the pointer focuses it and the keyboard drives it', () => {
    // The surface is focused by mouse (so Delete/Enter reach Timeline's root
    // guard) and then driven by keyboard — space to play/pause — which is the
    // exact sequence `:focus-visible` exists to catch. Left alone, the first
    // keypress drew a focus ring around every track at once.
    const store = createViewportStore()
    const { container } = mount(store)
    const surface = container.querySelector('[data-timeline-canvas]') as HTMLElement

    expect(surface.className).toContain('outline-none')
    // And it stays unreachable by tab, which is what makes suppressing the
    // ring free rather than a keyboard-navigation regression.
    expect(surface.getAttribute('tabindex')).toBe('-1')
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
      <TimelineCanvas project={project} clock={clock} store={store} totalDuration={20} fps={30} selectedIds={[]} />,
    )
    act(() => { vi.advanceTimersByTime(32) })
    const content = recorderFor(container.querySelectorAll('canvas')[0] as HTMLCanvasElement)
    content.length = 0

    const edited = { ...project, tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 9 }]] } as unknown as Project
    rerender(<TimelineCanvas project={edited} clock={clock} store={store} totalDuration={20} fps={30} selectedIds={[]} />)
    act(() => { vi.advanceTimersByTime(32) })

    expect(content.some(c => c.method === 'clearRect')).toBe(true)
  })

  it('keeps redrawing after a StrictMode mount/cleanup/remount cycle', () => {
    // Dev-only regression: StrictMode runs mount → cleanup → mount on the
    // same instance. If the unmount cleanup cancels the pending frame
    // without resetting `frameRef`, every redraw after the replay is
    // silently dropped — the canvas never paints again.
    const store = createViewportStore()
    const clock = createPlaybackClock()
    const { rerender, container } = render(
      <StrictMode>
        <TimelineCanvas project={project} clock={clock} store={store} totalDuration={20} fps={30} selectedIds={[]} />
      </StrictMode>,
    )
    act(() => { vi.advanceTimersByTime(32) })
    const content = recorderFor(container.querySelectorAll('canvas')[0] as HTMLCanvasElement)
    content.length = 0

    rerender(
      <StrictMode>
        <TimelineCanvas project={project} clock={clock} store={store} totalDuration={20} fps={30} selectedIds={['c0']} />
      </StrictMode>,
    )
    act(() => { vi.advanceTimersByTime(32) })

    expect(content.some(c => c.method === 'clearRect')).toBe(true)
  })
})

describe('TimelineCanvas — theme mode', () => {
  // The canvas coalesces every redraw into one rAF and repaints only the
  // layers marked dirty, so a theme flip that isn't wired into that
  // dirty-marking leaves BOTH layers showing the previous theme's pixels until
  // something unrelated happens to touch them — and on a paused, untouched
  // timeline the overlay layer is touched by nothing at all. These tests are
  // about that wiring, not about the colours (draw.test.ts owns those).
  function mountWithMode(initial: TimelineMode) {
    const store = createViewportStore()
    const clock = createPlaybackClock()
    function Surface({ mode }: { mode: TimelineMode }) {
      return (
        <TimelineCanvas
          project={project}
          clock={clock}
          store={store}
          totalDuration={20}
          fps={30}
          selectedIds={NO_SELECTION}
          mode={mode}
        />
      )
    }
    const utils = render(<Surface mode={initial} />)
    act(() => { vi.advanceTimersByTime(32) })
    const canvases = utils.container.querySelectorAll('canvas')
    return {
      content: recorderFor(canvases[0] as HTMLCanvasElement),
      overlay: recorderFor(canvases[1] as HTMLCanvasElement),
      setMode: (mode: TimelineMode) => {
        utils.rerender(<Surface mode={mode} />)
        act(() => { vi.advanceTimersByTime(32) })
      },
    }
  }

  it('repaints BOTH layers with the new palette when the mode flips', () => {
    const { content, overlay, setMode } = mountWithMode('dark')

    // Baseline: the surface really did come up dark.
    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.rowBackground)).toBe(true)
    content.length = 0
    overlay.length = 0

    setMode('light')

    // Content: repainted, and repainted LIGHT — not merely repainted.
    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === LIGHT_TIMELINE_COLORS.rowBackground)).toBe(true)
    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.rowBackground)).toBe(false)
    // Overlay: nothing else on this idle surface would ever repaint it, so a
    // fresh clear+playhead pass here is the whole proof that the flip marked
    // it dirty too. (Its one mark, the playhead, is red in both modes by
    // design — see draw.test.ts — so the colour can't be the tell.)
    expect(overlay.some(c => c.method === 'clearRect')).toBe(true)
    expect(overlay.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.playhead)).toBe(true)
  })

  it('flips back to dark, so the dependency is the mode and not "changed once"', () => {
    const { content, setMode } = mountWithMode('light')
    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === LIGHT_TIMELINE_COLORS.rowBackground)).toBe(true)
    content.length = 0

    setMode('dark')
    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.rowBackground)).toBe(true)
    expect(content.some(c => c.method === 'set:fillStyle' && c.args[0] === LIGHT_TIMELINE_COLORS.rowBackground)).toBe(false)
  })

  it('does not repaint when a rerender leaves the mode alone', () => {
    // The other half of the contract: a host re-rendering for any other reason
    // must not cost a full two-layer repaint.
    const { content, overlay, setMode } = mountWithMode('dark')
    content.length = 0
    overlay.length = 0
    setMode('dark')
    expect(content).toHaveLength(0)
    expect(overlay).toHaveLength(0)
  })
})
