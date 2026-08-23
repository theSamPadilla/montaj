/// <reference types="vitest/globals" />
/**
 * Pane-fill — the surface grows past its tracks to occupy the empty area at the
 * bottom of the resizable timeline pane, so a click/drag there hits the canvas
 * (deselect, seek, marquee) instead of dead page space.
 *
 * The arithmetic is proven as a pure unit (`paneFillHeight`); the wiring —
 * measuring the marked scroll viewport, growing the surface, and hit-testing
 * the extended region as `background` so a click deselects — needs a mounted
 * surface. jsdom lays everything out at 0×0, so `getBoundingClientRect` is
 * stubbed per-element: the scroll viewport is 600px tall, the surface starts
 * 100px down, leaving 500px of fill below the ~186px of tracks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import TimelineCanvas, { paneFillHeight } from '../TimelineCanvas'
import { createViewportStore } from '../viewport'

describe('paneFillHeight', () => {
  it('is the viewport height less the surface offset and the padding below it', () => {
    expect(paneFillHeight(600, 100, 12)).toBe(488)
    expect(paneFillHeight(600, 100, 0)).toBe(500)
  })

  it('never goes negative when the surface offset already exceeds the viewport', () => {
    // The tracks alone already overflow the pane: the fill floors at 0 and the
    // caller's Math.max keeps the layout height instead.
    expect(paneFillHeight(200, 260, 0)).toBe(0)
  })
})

// One base video track (120px row) + one audio lane (40px): layout height ~186,
// comfortably under the 500px of pane fill the stubs produce.
const project = {
  id: 'p',
  tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 8, inPoint: 0, outPoint: 8, sourceDuration: 8 }] }],
  audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 1, end: 5 }] },
} as unknown as Project

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

function rect(top: number, bottom: number): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 1000, bottom, width: 1000, height: bottom - top, toJSON: () => ({}) } as DOMRect
}

beforeEach(() => {
  realGetContext = HTMLCanvasElement.prototype.getContext
  realGetRect = Element.prototype.getBoundingClientRect
  HTMLCanvasElement.prototype.getContext = (() => stubContext()) as unknown as typeof HTMLCanvasElement.prototype.getContext
  // The scroll viewport is 600px tall; the surface begins 100px down it, so the
  // fill below the tracks is 600 − 100 = 500px. Everything else keeps the 0×0
  // that would otherwise apply.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLElement && this.hasAttribute('data-timeline-scroll')) return rect(0, 600)
    if (this instanceof HTMLElement && this.hasAttribute('data-timeline-canvas')) return rect(100, 600)
    return rect(0, 120)
  }
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = realGetContext
  Element.prototype.getBoundingClientRect = realGetRect
})

function mount(overrides: Partial<React.ComponentProps<typeof TimelineCanvas>> = {}) {
  const store = createViewportStore()
  const clock = createPlaybackClock()
  const onSelectItem = vi.fn()
  const utils = render(
    <div data-timeline-scroll>
      <TimelineCanvas
        project={project}
        clock={clock}
        store={store}
        totalDuration={20}
        fps={30}
        selectedIds={[]}
        onSelectItem={onSelectItem}
        {...overrides}
      />
    </div>,
  )
  act(() => { vi.advanceTimersByTime(32) })
  const surface = utils.container.querySelector('[data-timeline-canvas]') as HTMLElement
  return { ...utils, store, clock, onSelectItem, surface }
}

describe('TimelineCanvas — pane fill', () => {
  it('grows the surface to fill the pane below the tracks', () => {
    const { surface } = mount()
    // 500px of fill dominates the ~186px of tracks.
    expect(surface.style.height).toBe('500px')
  })

  it('deselects on a click in the extended area below the tracks', () => {
    // y=400 is well past the last lane (~186) but inside the 500px surface, so
    // it hit-tests as background — a press+release there clears the selection,
    // exactly as clicking bare timeline does.
    const { surface, onSelectItem } = mount({ selectedIds: ['c0'] })
    act(() => {
      surface.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 400, clientY: 400, bubbles: true }))
      surface.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 400, clientY: 400, bubbles: true }))
    })
    expect(onSelectItem).toHaveBeenCalledWith(null, false)
  })
})
