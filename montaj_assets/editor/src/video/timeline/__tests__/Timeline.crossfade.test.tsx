/// <reference types="vitest/globals" />
/**
 * The auto-crossfade pass must land as ONE commit, on a delay — not one per
 * change. Audio timing moves on every mousemove of a drag, and the effect used
 * to `onOverlayEdit` (commit) synchronously on each, which recorded dozens of
 * undo entries for a single audio move. It is now debounced; a drag's own
 * commit folds the fade into its single undo step, and this pass is the
 * catch-all for audio-timing changes that arrive outside a gesture.
 *
 * jsdom lays out at 0×0 and has no 2D canvas, so both are stubbed the same way
 * the sibling background-click test does — the canvas-mode timeline mounts a
 * real <canvas> surface underneath Timeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline, { CROSSFADE_COMMIT_DELAY_MS } from '../Timeline'

let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect

beforeEach(() => {
  vi.useFakeTimers()
  realGetContext = HTMLCanvasElement.prototype.getContext
  realGetRect = Element.prototype.getBoundingClientRect
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
        return () => {}
      },
      set() { return true },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 200, width: 1000, height: 200, toJSON: () => ({}) } as DOMRect
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = realGetContext
  Element.prototype.getBoundingClientRect = realGetRect
})

/** Two audio tracks that overlap by 1s and carry NO fades — so
 *  `computeAutoCrossfade` has a real change to make (fadeOut/fadeIn = 1). */
function projectWithOverlap(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
    audio: { tracks: [
      { id: 'a0', src: 'v.mp3', start: 0, end: 5, lane: 0 },
      { id: 'a1', src: 'w.mp3', start: 4, end: 9, lane: 0 },
    ] },
  } as unknown as Project
}

/** Same shape, but the fades are already correct — the pass must find nothing. */
function projectAlreadyFaded(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
    audio: { tracks: [
      { id: 'a0', src: 'v.mp3', start: 0, end: 5, lane: 0, fadeOut: 1 },
      { id: 'a1', src: 'w.mp3', start: 4, end: 9, lane: 0, fadeIn: 1 },
    ] },
  } as unknown as Project
}

function mount(project: Project) {
  const onOverlayEdit = vi.fn()
  const onProjectChange = vi.fn()
  render(
    <Timeline
      project={project}
      clock={createPlaybackClock(0)}
      selectedIds={[]}
      onSelectIds={vi.fn()}
      timeline={{ canvas: true }}
      onProjectChange={onProjectChange}
      onOverlayEdit={onOverlayEdit}
    />,
  )
  return { onOverlayEdit, onProjectChange }
}

describe('Timeline — auto-crossfade commit is debounced', () => {
  it('does not commit synchronously, then commits once after the delay', () => {
    const { onOverlayEdit } = mount(projectWithOverlap())
    // The per-change commit is exactly the audio-move-undo bug — it must not
    // fire on mount / on the audio-timing change itself.
    expect(onOverlayEdit).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(CROSSFADE_COMMIT_DELAY_MS) })

    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const a0 = committed.audio!.tracks.find(t => t.id === 'a0')!
    const a1 = committed.audio!.tracks.find(t => t.id === 'a1')!
    expect(a0.fadeOut).toBe(1)
    expect(a1.fadeIn).toBe(1)
  })

  it('never commits when the crossfade is already applied (idempotent)', () => {
    const { onOverlayEdit } = mount(projectAlreadyFaded())
    act(() => { vi.advanceTimersByTime(CROSSFADE_COMMIT_DELAY_MS * 4) })
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })
})
