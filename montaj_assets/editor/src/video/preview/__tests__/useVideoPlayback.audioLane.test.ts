/**
 * The legacy player's audio lanes (`project.audio.tracks`), driven through the
 * hook's real effects: the canvas clock is held still (rAF is captured, never
 * run) and the playhead is moved by re-rendering with a new `currentTime`, the
 * way `PreviewPlayer` feeds it.
 *
 * Two regressions, one per describe block:
 *
 *   1. A track with no `end` never played: timeline-core's `audioWindow`
 *      defaulted `end` to 0, so the lane was never inside its window. The
 *      export plays such a track at its natural length.
 *   2. `play()` on an element that has reached the end of its file restarts it
 *      from 0, so a lane whose window outlasts its file (a short SFX with no
 *      `end`) would be restarted on every tick after it finished.
 *
 * The engine path (`useEnginePlayback`) has the same pair of tests in
 * `useEnginePlayback.test.tsx`'s audio-lane block.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject } from '../../../schema'

// jsdom implements neither `play()` nor `pause()`. Module scope, not a per-test
// spy: Testing Library's cleanup unmounts the hook, and the lane teardown
// pauses every element, after any per-test restore would have run.
Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get(this: HTMLMediaElement & { __paused?: boolean }) { return this.__paused !== false },
})
HTMLMediaElement.prototype.play = function (this: HTMLMediaElement & { __paused?: boolean }) {
  this.__paused = false
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement & { __paused?: boolean }) {
  this.__paused = true
}

const audioEls: HTMLAudioElement[] = []
let RealAudio: typeof Audio

beforeEach(() => {
  audioEls.length = 0
  RealAudio = window.Audio
  ;(window as unknown as { Audio: unknown }).Audio = class extends RealAudio {
    constructor(src?: string) { super(src); audioEls.push(this as unknown as HTMLAudioElement) }
  }
  // jsdom has no Web Audio; the lane wiring reads this shared context.
  ;(window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx = {
    state: 'running',
    outputLatency: 0,
    baseLatency: 0,
    resume: () => Promise.resolve(),
    destination: {},
    createMediaElementSource: () => ({ connect: () => {} }),
    createGain: () => ({ gain: { value: 1 }, connect: () => {} }),
  }
  // Hold the canvas clock still: the playhead only moves when a test says so.
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1)
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
})

afterEach(() => {
  ;(window as unknown as { Audio: unknown }).Audio = RealAudio
  delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
  vi.restoreAllMocks()
})

function projectWith(track: Record<string, unknown>): EditorProject {
  return {
    id: 'audio-lane',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [],
    audio: { tracks: [{ id: 'lane', src: '/lane.mp3', ...track }] },
  } as unknown as EditorProject
}

function fileOf(el: HTMLAudioElement, duration: number, ended = false) {
  Object.defineProperty(el, 'duration', { configurable: true, get: () => duration })
  Object.defineProperty(el, 'ended', { configurable: true, get: () => ended })
}

/** Mount at t=0, start playback, then move the playhead to `t`. */
function playAt(project: EditorProject, t: number, file?: { duration: number; ended?: boolean }) {
  const view = renderHook(
    ({ time }: { time: number }) => useVideoPlayback(project, time, () => {}, (p) => p),
    { initialProps: { time: 0 } },
  )
  expect(view.result.current.isCanvasProject).toBe(true)
  expect(audioEls).toHaveLength(1)
  const el = audioEls[0]
  if (file) fileOf(el, file.duration, file.ended)
  const play = vi.spyOn(el, 'play')
  act(() => { view.result.current.setIsPlaying(true) })
  act(() => { view.rerender({ time: t }) })
  return { play, el }
}

describe('useVideoPlayback — a lane with no usable end plays', () => {
  it('plays {start: 2} at t = 3', () => {
    const { play } = playAt(projectWith({ start: 2 }), 3)
    expect(play).toHaveBeenCalled()
  })

  it('plays {start: 2, end: 2} at t = 3 (a zero-width window is no window)', () => {
    const { play } = playAt(projectWith({ start: 2, end: 2 }), 3)
    expect(play).toHaveBeenCalled()
  })

  it('does not play before the lane starts', () => {
    const { play } = playAt(projectWith({ start: 2 }), 1)
    expect(play).not.toHaveBeenCalled()
  })
})

describe('useVideoPlayback — a lane whose source is exhausted is never replayed', () => {
  // A 3s file on a lane spanning [2, 8): the audio runs out at t = 5, three
  // seconds before the window does. An explicit `end`, so these fail on the
  // missing guard alone and not on the no-`end` bug above.
  const outlasting = () => projectWith({ start: 2, end: 8 })

  it('plays while the file has audio left', () => {
    const { play } = playAt(outlasting(), 4, { duration: 3 })
    expect(play).toHaveBeenCalled()
  })

  it('never calls play() once the playhead is past the end of the file', () => {
    const { play } = playAt(outlasting(), 6, { duration: 3, ended: true })
    expect(play).not.toHaveBeenCalled()
  })

  it('does not restart an ended lane that is only drift-behind the end of its file', () => {
    // trackTime 2.9 against a 3s file: inside the 0.3s re-seek tolerance, so
    // the element has already played everything there is.
    const { play } = playAt(outlasting(), 4.9, { duration: 3, ended: true })
    expect(play).not.toHaveBeenCalled()
  })

  it('plays an ended lane again once the playhead is back inside its audio', () => {
    const { play } = playAt(outlasting(), 3, { duration: 3, ended: true })
    expect(play).toHaveBeenCalled()
  })
})
