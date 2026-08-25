/// <reference types="vitest/globals" />
/**
 * Clicks that land on the timeline COLUMN but on no row: the readout strip
 * above the tracks, the gaps between rows, the space under the last one.
 *
 * These went dead in canvas mode and nothing noticed. `handleContainerClick`
 * mapped x→time through the scrubber bar's rect, and canvas mode doesn't
 * render that bar, so `scrubberRef.current` was null and every such click fell
 * out of an early return. The visible symptom was a ~40px strip under the
 * toolbar that looked like timeline and ignored you — including for the thing
 * people most expect from a background click, dropping the selection.
 *
 * There was no failing assertion to catch that: "looks live, does nothing" is
 * invisible to a test that doesn't ask. So these ask.
 *
 * jsdom lays everything out at 0×0, so the canvas surface's rect is stubbed to
 * a real one via `installCanvasHarness` — without it every click reads as x=0
 * in a 0-wide surface and the seek half of this can't be observed at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline from '../Timeline'
import { installCanvasHarness, SURFACE_LEFT } from './_canvasSelect'

let uninstall: () => void

beforeEach(() => {
  uninstall = installCanvasHarness()
})

afterEach(() => {
  cleanup()
  uninstall()
})

/** 10s of content. NOT a round 100px/second on the fitted surface — "fit" is
 *  computed against `computeDerivedTiming().totalDuration`, which is content
 *  duration PLUS drag headroom (`+ max(5, content * 0.2)`), so 10s of content
 *  fits as 15s of fitted timeline (≈66.7px/s here), not 100px/s. Nothing below
 *  asserts the scale, so the exact value was never load-bearing — this note is
 *  just so a reader doesn't assume a round number computing their own point. */
function makeProject(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
  } as unknown as Project
}

function mount(clockAt = 0) {
  const clock = createPlaybackClock(clockAt)
  const onSelectIds = vi.fn()
  const utils = render(
    <Timeline
      project={makeProject()}
      clock={clock}
      selectedIds={['clip-0']}
      onSelectIds={onSelectIds}
    />,
  )
  // The strip is the column's own background: the row area is a child, so
  // clicking the root element itself is exactly a click that hit no row.
  const root = utils.container.firstElementChild as HTMLElement
  return { clock, onSelectIds, root, ...utils }
}

describe('Timeline — background clicks in canvas mode', () => {
  it('clears the selection', () => {
    const { root, onSelectIds } = mount()
    fireEvent.click(root, { clientX: 600, clientY: 10 })
    expect(onSelectIds).toHaveBeenCalledWith([])
  })

  it('seeks to the clicked time on the canvas axis', () => {
    const { root, clock } = mount()
    // 600 - SURFACE_LEFT = 500px into a 1000px surface showing 10s of content.
    fireEvent.click(root, { clientX: 600, clientY: 10 })
    expect(clock.get()).toBeGreaterThan(0)
    expect(clock.get()).toBeLessThan(10)
  })

  it('does not seek from over the track rail, but still clears the selection', () => {
    const { root, clock, onSelectIds } = mount(4)
    fireEvent.click(root, { clientX: SURFACE_LEFT - 20, clientY: 10 })
    expect(onSelectIds).toHaveBeenCalledWith([])
    expect(clock.get()).toBe(4)   // no time axis over the rail
  })

  it('leaves a click on a button alone — the zoom and readout controls are chrome', () => {
    const { root, clock, onSelectIds } = mount(4)
    const button = document.createElement('button')
    root.appendChild(button)
    fireEvent.click(button, { clientX: 600, clientY: 10, bubbles: true })
    expect(onSelectIds).not.toHaveBeenCalled()
    expect(clock.get()).toBe(4)
  })

  it('leaves a click on a [data-timeline-chrome] readout alone', () => {
    const { root, clock, onSelectIds } = mount(4)
    const readout = document.createElement('span')
    readout.setAttribute('data-timeline-chrome', '')
    root.appendChild(readout)
    fireEvent.click(readout, { clientX: 600, clientY: 10, bubbles: true })
    expect(onSelectIds).not.toHaveBeenCalled()
    expect(clock.get()).toBe(4)
  })
})
