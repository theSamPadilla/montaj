/**
 * §733: the J/K/L shuttle's transport rate R on the legacy `<video>` path.
 *
 * Sam: "Hitting L gives me the 1.5x, 2x, 4x but I dont see the speed kicking
 * in". The shuttle called `setRate`, which only the engine path had; a project
 * on the `<video>` fallback kept advancing 1 project-second a second at every
 * shuttle speed. Now every layer of this path follows R: the active slot plays
 * at S·R (pitch-corrected), the gap/held and canvas clocks count R x their wall
 * time, the lanes play at R, and a clip whose S·R no element can play is HELD
 * (§684). R = 1 is exactly the old behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem } from '../../../schema'

// jsdom implements neither `play()` nor `pause()` on the lanes' <audio>.
// Module scope: Testing Library's cleanup pauses every lane after a per-test
// restore would have run.
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

/** A <video> that behaves like Chrome's on rate and play/pause. */
type StrictVideo = HTMLVideoElement & { plays: number }
function strictVideo(): StrictVideo {
  const el = document.createElement('video') as StrictVideo
  let t = 0, rate = 1, paused = true
  el.plays = 0
  Object.defineProperty(el, 'currentTime', { get: () => t, set: (v: number) => { t = v }, configurable: true })
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true })
  Object.defineProperty(el, 'playbackRate', {
    get: () => rate,
    set: (v: number) => {
      if (!(v >= 0.0625 && v <= 16)) throw new DOMException(`The provided playback rate (${v}) is not in the supported playback range.`, 'NotSupportedError')
      rate = v
    },
    configurable: true,
  })
  el.play = () => { paused = false; el.plays++; return Promise.resolve() }
  el.pause = () => { paused = true }
  ;(el as unknown as { __montajGain: unknown }).__montajGain = { gain: { value: 1 } }
  return el
}

function project(items: VisualItem[], audio?: Record<string, unknown>[]): EditorProject {
  return {
    id: 'p', status: 'draft', settings: { resolution: [1080, 1920] }, tracks: [{ id: 'trk-0', items }],
    ...(audio ? { audio: { tracks: audio } } : {}),
  } as unknown as EditorProject
}

const clip = (id: string, start: number, end: number, speed = 1): VisualItem =>
  ({ id, type: 'video', src: `/w/${id}.mp4`, start, end, inPoint: 0, outPoint: (end - start) * speed, ...(speed !== 1 ? { speed } : {}) }) as VisualItem
const overlay = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'overlay', src: `/overlays/${id}.jsx`, start, end }) as VisualItem

// Hand-cranked clock: rAF callbacks queue up and run on `frame(ms)`.
let now = 0
let queue: FrameRequestCallback[] = []
const audioEls: HTMLAudioElement[] = []
let RealAudio: typeof Audio
beforeEach(() => {
  now = 1000
  queue = []
  audioEls.length = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
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
})
afterEach(() => {
  ;(window as unknown as { Audio: unknown }).Audio = RealAudio
  delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function frame(ms: number) {
  now += ms
  const run = queue
  queue = []
  act(() => { for (const cb of run) cb(now) })
}

function mount(items: VisualItem[], at = 0, audio?: Record<string, unknown>[]) {
  const times: number[] = []
  const p = project(items, audio)
  const h = renderHook(
    ({ p, t }: { p: EditorProject; t: number }) => useVideoPlayback(p, t, (x: number) => times.push(x), (path) => path, false, false),
    { initialProps: { p, t: 0 } },
  )
  const v0 = strictVideo(), v1 = strictVideo()
  h.result.current.video0Ref.current = v0
  h.result.current.video1Ref.current = v1
  const live = { ...p }
  h.rerender({ p: live, t: at })
  const scrub = (t: number) => h.rerender({ p: live, t })
  const active = () => (h.result.current.activeSlotRef.current === 0 ? v0 : v1)
  /** A press of play, then what PreviewPlayer's slot `onPlay` does once the element plays. */
  const play = () => { act(() => { h.result.current.togglePlay() }); act(() => { h.result.current.setIsPlaying(true) }) }
  const setRate = (r: number) => act(() => { h.result.current.setRate(r) })
  return { ...h, v0, v1, active, times, play, scrub, setRate, last: () => times[times.length - 1] }
}

describe('§733: the shuttle rate on the legacy <video> path', () => {
  it('setRate(2) while playing plays the active slot at S x 2, pitch-corrected, and project time advances 2x', () => {
    const h = mount([clip('a', 0, 4, 1.5)])
    h.play()
    expect(h.v0.playbackRate).toBe(1.5)
    h.setRate(2)
    expect(h.v0.paused).toBe(false)
    expect(h.v0.playbackRate).toBe(3)
    expect(h.v0.preservesPitch).toBe(true)
    // Half a wall second at 3x consumes 1.5 source seconds: by S alone that is 1 project second.
    h.v0.currentTime = 1.5
    act(() => { h.result.current.handleTimeUpdate() })
    expect(h.last()).toBeCloseTo(1, 6)
  })

  it('the shuttle from idle (play, then setRate before the element reports playing) still lands', () => {
    const h = mount([clip('a', 0, 4, 1.5)])
    act(() => { h.result.current.togglePlay() })
    h.setRate(4)
    act(() => { h.result.current.setIsPlaying(true) })
    expect(h.v0.paused).toBe(false)
    expect(h.v0.playbackRate).toBe(6)
  })

  it('a rate set while paused is stored, and the next play uses it', () => {
    const h = mount([clip('a', 0, 4, 1.5)])
    h.setRate(2)
    expect(h.v0.paused).toBe(true)
    h.play()
    expect(h.v0.playbackRate).toBe(3)
  })

  it('setRate(1) restores the slot to its clip speed exactly', () => {
    const h = mount([clip('a', 0, 4, 1.5)])
    h.play()
    h.setRate(4)
    h.setRate(1)
    expect(h.v0.playbackRate).toBe(1.5)
    expect(h.v0.paused).toBe(false)
  })

  it('the gap clock advances 2x wall time, re-anchors on a change without a jump, and 1x restores it', () => {
    const h = mount([clip('a', 0, 1), clip('b', 4, 6)], 1.5)
    h.play() // in the gap: the gap clock drives time
    frame(500)
    expect(h.last()).toBeCloseTo(2, 6)
    h.setRate(2)
    frame(0)
    expect(h.last()).toBeCloseTo(2, 6) // continuous
    frame(500)
    expect(h.last()).toBeCloseTo(3, 6)
    h.setRate(1)
    frame(0)
    expect(h.last()).toBeCloseTo(3, 6)
    frame(500)
    expect(h.last()).toBeCloseTo(3.5, 6)
  })

  it('the next clip after a gap starts at S x R', () => {
    const h = mount([clip('a', 0, 1), clip('b', 2, 6, 1.5)], 1.5)
    h.play()
    h.setRate(2)
    frame(16)
    frame(300) // 1.5 + 2 x 0.316 > 2: the gap is over
    expect(h.v1.paused).toBe(false)
    expect(h.v1.playbackRate).toBe(3)
  })

  it('the canvas clock advances 2x wall time', () => {
    const h = mount([overlay('o', 0, 10)])
    expect(h.result.current.isCanvasProject).toBe(true)
    h.setRate(2)
    act(() => { h.result.current.setIsPlaying(true) })
    frame(16) // anchor only
    frame(1000)
    expect(h.last()).toBeCloseTo(2, 6)
    h.setRate(1)
    frame(1000)
    expect(h.last()).toBeCloseTo(3, 6)
  })

  it('audio lanes play at R, pitch-corrected; a rate no element plays holds them silent; 1x resumes', () => {
    const h = mount([overlay('o', 0, 10)], 0, [{ id: 'lane', src: '/lane.mp3', start: 0, end: 10 }])
    act(() => { h.result.current.setIsPlaying(true) })
    const lane = audioEls[0]
    expect(lane).toBeDefined()
    expect(lane.paused).toBe(false)
    expect(lane.playbackRate).toBe(1)
    h.setRate(2)
    expect(lane.playbackRate).toBe(2)
    expect(lane.preservesPitch).toBe(true)
    // The playhead moves on (by less than a scrub: a canvas scrub stops playback) and the lanes re-sync.
    h.scrub(0.01)
    expect(lane.playbackRate).toBe(2)
    expect(lane.paused).toBe(false)
    h.setRate(20)
    expect(lane.paused).toBe(true)
    h.scrub(0.02)
    expect(lane.paused).toBe(true)
    h.setRate(1)
    h.scrub(0.03)
    expect(lane.paused).toBe(false)
    expect(lane.playbackRate).toBe(1)
  })

  it('a clip at speed 8 under R 4 (32x) is held, silent, with its clock at 4x; back at 1x it plays at 8x from there', () => {
    const h = mount([clip('eight', 0, 4, 8)])
    h.play()
    expect(h.v0.playbackRate).toBe(8)
    h.setRate(4)
    expect(h.v0.paused).toBe(true) // held: the element is paused, so it makes no sound
    expect(h.result.current.isPlaying).toBe(true)
    frame(16)
    frame(250)
    const t = h.last()
    expect(t).toBeCloseTo(0.266 * 4, 6)
    expect(Math.abs(h.v0.currentTime - 8 * t)).toBeLessThanOrEqual(1 / 60)
    h.setRate(1)
    expect(h.v0.paused).toBe(false)
    expect(h.v0.playbackRate).toBe(8)
    expect(h.v0.currentTime).toBeCloseTo(8 * t, 6)
    expect(h.result.current.isPlaying).toBe(true)
    // The held clock is gone: no rAF of it runs on.
    const before = h.times.length
    frame(500)
    expect(h.times.slice(before).every((x) => Math.abs(x - t) < 1e-6)).toBe(true)
  })
})
