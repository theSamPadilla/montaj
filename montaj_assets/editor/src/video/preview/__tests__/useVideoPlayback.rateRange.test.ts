/**
 * A clip whose speed no <video> can play. Chrome accepts `playbackRate` only in
 * [0.0625, 16] and THROWS outside it, so an AI-made near-freeze (`speed: 0.05`)
 * crashed the whole preview panel. Every assignment is clamped now, and such a
 * HELD clip is driven by seeking a paused element to `inPoint + S·(t − start)`
 * while the project clock runs at real time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem } from '../../../schema'

/** A <video> that behaves like Chrome's on rate and play/pause. */
function strictVideo(): HTMLVideoElement & { plays: number } {
  const el = document.createElement('video') as HTMLVideoElement & { plays: number }
  let t = 0, rate = 1, paused = true
  el.plays = 0
  Object.defineProperty(el, 'currentTime', { get: () => t, set: (v: number) => { t = v }, configurable: true })
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true })
  Object.defineProperty(el, 'playbackRate', {
    get: () => rate,
    set: (v: number) => {
      if (!(v >= 0.0625 && v <= 16)) {
        throw new DOMException(`Failed to set the 'playbackRate' property on 'HTMLMediaElement': The provided playback rate (${v}) is not in the supported playback range.`, 'NotSupportedError')
      }
      rate = v
    },
    configurable: true,
  })
  el.play = () => { paused = false; el.plays++; return Promise.resolve() }
  el.pause = () => { paused = true }
  ;(el as unknown as { __montajGain: unknown }).__montajGain = { gain: { value: 1 } }
  return el
}

function project(items: VisualItem[]): EditorProject {
  return { id: 'p', status: 'draft', settings: { resolution: [1080, 1920] }, tracks: [{ id: 'trk-0', items }] } as unknown as EditorProject
}

// Sam's clip, moved to t=0: 3.11 project seconds over 0.1555 source seconds.
const freeze = (extra: Partial<VisualItem> = {}): VisualItem =>
  ({ id: 'held', type: 'video', src: '/w/a.mp4', start: 0, end: 3.11, inPoint: 9.24, outPoint: 9.3955, speed: 0.05, ...extra }) as VisualItem
const fast = (extra: Partial<VisualItem> = {}): VisualItem =>
  ({ id: 'fast', type: 'video', src: '/w/a.mp4', start: 0, end: 2, inPoint: 0, outPoint: 40, speed: 20, ...extra }) as VisualItem
const plain = (start: number, end: number): VisualItem =>
  ({ id: 'plain', type: 'video', src: '/w/b.mp4', start, end, inPoint: 0, outPoint: end - start }) as VisualItem

// Hand-cranked clock: rAF callbacks queue up and run on `frame(ms)`.
let now = 0
let queue: FrameRequestCallback[] = []
beforeEach(() => {
  now = 1000
  queue = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function frame(ms: number) {
  now += ms
  const run = queue
  queue = []
  act(() => { for (const cb of run) cb(now) })
}

function mount(items: VisualItem[], at = 0) {
  const times: number[] = []
  const p = project(items)
  const h = renderHook(
    ({ p, t }: { p: EditorProject; t: number }) => useVideoPlayback(p, t, (x: number) => times.push(x), (path) => path),
    { initialProps: { p, t: 0 } },
  )
  const v0 = strictVideo(), v1 = strictVideo()
  h.result.current.video0Ref.current = v0
  h.result.current.video1Ref.current = v1
  const live = { ...p }
  h.rerender({ p: live, t: at })
  const scrub = (t: number) => h.rerender({ p: live, t })
  const active = () => (h.result.current.activeSlotRef.current === 0 ? v0 : v1)
  /** What PreviewPlayer's slot wiring does on a press of play. */
  const play = () => { active().play(); act(() => { h.result.current.setIsPlaying(true) }); act(() => { h.result.current.handleTimeUpdate() }) }
  return { ...h, v0, v1, active, times, play, scrub, last: () => times[times.length - 1] }
}

describe('a clip outside the playable rate range (legacy <video> preview)', () => {
  it('a scrub into a 0.05x clip does not throw and shows inPoint + 0.05 x elapsed', () => {
    const h = mount([freeze()], 2)
    expect(h.active().currentTime).toBeCloseTo(9.24 + 0.05 * 2, 6)
  })

  it('a scrub into a 20x clip does not throw and shows inPoint + 20 x elapsed', () => {
    const h = mount([fast()], 0.5)
    expect(h.active().currentTime).toBeCloseTo(0 + 20 * 0.5, 6)
  })

  it('playing a 0.05x clip holds the element paused and runs the project clock at real time', () => {
    const h = mount([freeze()])
    h.play()
    expect(h.v0.paused).toBe(true)
    expect(h.result.current.isPlaying).toBe(true)
    frame(16)
    frame(1000)
    expect(h.last()).toBeCloseTo(1.016, 3)
    expect(h.v0.currentTime).toBeCloseTo(9.24 + 0.05 * 1.016, 2)
    frame(1000)
    expect(h.last()).toBeCloseTo(2.016, 3)
    expect(h.v0.currentTime).toBeCloseTo(9.24 + 0.05 * 2.016, 2)
    expect(h.v0.paused).toBe(true)
  })

  it('playing a 20x clip seeks it at 20 source seconds a second', () => {
    const h = mount([fast()])
    h.play()
    frame(500)
    expect(h.last()).toBeCloseTo(0.5, 3)
    expect(h.v0.currentTime).toBeCloseTo(10, 2)
    expect(h.v0.paused).toBe(true)
  })

  it('a held clip hands on to a contiguous next clip, which plays at its own rate', () => {
    const h = mount([freeze(), plain(3.11, 5)])
    h.play()
    frame(16)
    frame(3200)
    expect(h.result.current.activeSlotRef.current).toBe(1)
    expect(h.v1.plays).toBe(1)
    expect(h.v1.playbackRate).toBe(1)
    expect(h.times).toContain(3.11)
    expect(h.result.current.isPlaying).toBe(true)
  })

  it('a held clip followed by a gap runs the gap clock to the next clip', () => {
    const h = mount([freeze(), plain(4, 6)])
    h.play()
    frame(16)
    frame(3200) // past 3.11: now in the gap
    expect(h.result.current.showVideo).toBe(false)
    expect(h.v1.plays).toBe(0)
    frame(1000) // past 4: the next clip starts
    expect(h.v1.plays).toBe(1)
    expect(h.last()).toBe(4)
  })

  it('a held clip at the end of the project stops there', () => {
    const h = mount([freeze()])
    h.play()
    frame(16)
    frame(4000)
    expect(h.last()).toBeCloseTo(3.11, 6)
    expect(h.result.current.isPlaying).toBe(false)
  })

  it('pause in a held clip stops the clock, and play resumes from the same time', () => {
    const h = mount([freeze()])
    h.play()
    frame(16)
    frame(1000)
    const at = h.last()
    act(() => { h.result.current.togglePlay() })
    expect(h.result.current.isPlaying).toBe(false)
    frame(1000)
    expect(h.last()).toBe(at)
    h.play()
    frame(16)
    frame(500)
    expect(h.last()).toBeCloseTo(at + 0.516, 3)
  })

  it('a scrub while playing a held clip keeps the held clock running from the new time', async () => {
    const h = mount([freeze()])
    h.play()
    frame(16)
    frame(500)
    h.scrub(2.5)
    await new Promise((r) => setTimeout(r, 150)) // the post-seek guard clears after 100 ms
    expect(h.result.current.isPlaying).toBe(true)
    frame(16)
    frame(300)
    expect(h.last()).toBeCloseTo(2.816, 3)
    // Within a frame: the element re-seeks only when the picture would change.
    expect(Math.abs(h.v0.currentTime - (9.24 + 0.05 * 2.816))).toBeLessThanOrEqual(1 / 60)
  })

  it('a scrub while playing from a held clip into an in-range one plays that one', async () => {
    const h = mount([freeze(), plain(3.11, 6)])
    h.play()
    frame(16)
    frame(500)
    h.scrub(4)
    await new Promise((r) => setTimeout(r, 150))
    expect(h.active().paused).toBe(false)
    expect(h.result.current.isPlaying).toBe(true)
  })

  it('an in-range clip still plays its element at its own speed', () => {
    const h = mount([plain(0, 4)])
    h.play()
    expect(h.v0.paused).toBe(false)
    expect(h.v0.playbackRate).toBe(1)
  })
})
