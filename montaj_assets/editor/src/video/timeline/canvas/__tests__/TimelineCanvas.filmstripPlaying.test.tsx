/**
 * §683: while the preview plays the timeline asks for no filmstrip, and the
 * pause itself repaints so the held-back request goes out (nothing else would
 * repaint a timeline sitting still).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { createViewportStore } from '../viewport'

let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect

beforeEach(() => {
  realGetContext = HTMLCanvasElement.prototype.getContext
  realGetRect = Element.prototype.getBoundingClientRect
  HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, {
      get: (_t, prop: string) => (prop === 'createLinearGradient' ? () => ({ addColorStop: () => {} }) : () => {}),
      set: () => true,
    })
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
  Element.prototype.getBoundingClientRect = function () {
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
  settings: { resolution: [1080, 1920], fps: 30 },
  tracks: [{ id: 't0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', proxySrc: 'a_proxy.mp4', start: 0, end: 8, inPoint: 0, outPoint: 8 }] }],
} as unknown as Project

const NO_SELECTION: string[] = []

describe('TimelineCanvas filmstrips and playback', () => {
  it('asks for no strip while playing, and asks once the preview pauses', () => {
    const getFilmstrip = vi.fn(() => new Promise<never>(() => {}))
    const store = createViewportStore()
    const clock = createPlaybackClock()
    const surface = (playing: boolean) => (
      <TimelineCanvas project={project} clock={clock} store={store} totalDuration={20} fps={30} selectedIds={NO_SELECTION}
        getFilmstrip={getFilmstrip} resolveFilePath={(p: string) => p} playing={playing} />
    )
    const utils = render(surface(true))
    act(() => { vi.advanceTimersByTime(100) })
    expect(getFilmstrip).not.toHaveBeenCalled()
    utils.rerender(surface(false))
    act(() => { vi.advanceTimersByTime(100) })
    expect(getFilmstrip).toHaveBeenCalledTimes(1)
    expect(getFilmstrip.mock.calls[0][0]).toMatchObject({ projectId: 'p1', src: 'a_proxy.mp4' })
  })
})
