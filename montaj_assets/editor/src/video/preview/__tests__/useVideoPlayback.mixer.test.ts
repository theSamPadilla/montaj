/**
 * §190 T5: the `<video>` hook under the preview mixer. The mixer is faked at
 * the seam the hook sees (`mixerDeps`): a fake MixClock, a fake conform client
 * and a plan the test controls. Covers what the hook does with it: silence the
 * main-track <video>, drop the covered lanes' <audio>, forward the transport,
 * and stay on today's path until (and unless) the mixer is ready.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { ProjectMixPlan } from '../../../engine/mix/audio-plan'
import type { ConformClient } from '../../../engine/mix/conform-client'
import type { MixClock } from '../../../engine/mix/mix-clock'
import type { EditorProject, VisualItem } from '../../../schema'

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

const MUSIC = '/media/music.mp3'
const VO = '/media/vo.wav'

function project(): EditorProject {
  return {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [{ id: 'trk-0', items: [{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, volume: 0.8 } as VisualItem] }],
    audio: { tracks: [{ id: 'music', src: MUSIC, start: 0, end: 10 }, { id: 'vo', src: VO, start: 0, end: 10 }] },
  } as unknown as EditorProject
}

const ready = (unconformedLanes: string[] = []): ProjectMixPlan => ({
  plan: { segments: [] }, unconformedMain: [], unconformedLanes, unconformedOverlays: [],
})
const waiting = (): ProjectMixPlan => ({ ...ready(), unconformedMain: ['/a.mp4'] })

function fakeClock() {
  const calls: string[] = []
  const clock = {
    playing: false,
    calls,
    now: () => 0,
    play: () => { clock.playing = true; calls.push('play') },
    pause: () => { clock.playing = false; calls.push('pause') },
    seek: (t: number) => { calls.push(`seek:${t}`) },
    setRate: () => { calls.push('rate') },
    setVolume: (v: number) => { calls.push(`volume:${v}`) },
    setPlan: () => {},
    setParams: () => {},
    dispose: () => {},
  }
  return clock
}

describe('useVideoPlayback with the preview mixer', () => {
  let RealAudio: typeof Audio
  const elements: HTMLAudioElement[] = []
  let clock: ReturnType<typeof fakeClock>
  let plan: ProjectMixPlan
  let fireConform: () => void
  let mixerDeps: Parameters<typeof useVideoPlayback>[5]

  beforeEach(() => {
    elements.length = 0
    RealAudio = window.Audio
    ;(window as unknown as { Audio: unknown }).Audio = class extends RealAudio {
      constructor(src?: string) { super(src); elements.push(this as unknown as HTMLAudioElement) }
    }
    ;(window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx = {
      state: 'running', outputLatency: 0, baseLatency: 0, resume: () => Promise.resolve(), destination: {},
      createMediaElementSource: () => ({ connect: () => {} }),
      createGain: () => ({ gain: { value: 1 }, connect: () => {} }),
    }
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    clock = fakeClock()
    plan = ready([VO])
    let listener: (() => void) | null = null
    fireConform = () => listener?.()
    const conform = {
      request: () => {}, lookup: () => null, state: () => undefined, dispose: () => {},
      onChange: (l: () => void) => { listener = l; return () => { listener = null } },
    }
    mixerDeps = {
      createMixClock: () => Promise.resolve(clock as unknown as MixClock),
      buildMixPlan: () => plan,
      audioSourcePaths: () => ['/a.mp4', MUSIC, VO],
      conform: conform as unknown as ConformClient,
    }
  })
  afterEach(() => {
    ;(window as unknown as { Audio: unknown }).Audio = RealAudio
    delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
    vi.restoreAllMocks()
  })

  const live = () => elements.filter((el) => (el.getAttribute('src') ?? '') !== '')

  async function mount(deps: typeof mixerDeps = mixerDeps, muted = false) {
    const view = renderHook(
      ({ t }: { t: number }) => useVideoPlayback(project(), t, () => {}, (p) => p, muted, deps),
      { initialProps: { t: 0 } },
    )
    const video = document.createElement('video')
    let ct = 0
    Object.defineProperty(video, 'currentTime', { get: () => ct, set: (v: number) => { ct = v }, configurable: true })
    const writes: number[] = []
    let value = Number.NaN
    ;(video as unknown as { __montajGain: unknown }).__montajGain = {
      gain: { get value() { return value }, set value(v: number) { value = v; writes.push(v) } },
    }
    view.result.current.video0Ref.current = video
    view.rerender({ t: 0 })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    return { view, video, gain: () => value }
  }

  it('before the mixer is ready, today\'s path: video audible, every lane has its element', async () => {
    plan = waiting()
    const { gain } = await mount()
    expect(gain()).toBeCloseTo(0.8, 10)
    expect(live()).toHaveLength(2)
  })

  it('once the plan is ready, the video is silent and only the uncovered lane keeps an element', async () => {
    const { gain, view } = await mount()
    expect(gain()).toBe(0)
    const kept = live()
    expect(kept).toHaveLength(1)
    expect(kept[0].src).toContain(VO)
    expect(view.result.current.audioInMix('/other.mov')).toBe(true)
  })

  it('does not take over mid-play: a conform landing while playing waits for the pause', async () => {
    plan = waiting()
    const { gain, view } = await mount()
    act(() => { view.result.current.setIsPlaying(true) })
    plan = ready()
    act(() => { fireConform() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(gain()).toBeCloseTo(0.8, 10)
    expect(live()).toHaveLength(2)
    expect(clock.calls).not.toContain('play')

    act(() => { view.result.current.setIsPlaying(false) })
    expect(gain()).toBe(0)
    expect(live()).toHaveLength(0)
  })

  it('play and pause of the video play and pause the mixer; a scrub seeks it', async () => {
    const { view } = await mount()
    clock.calls.length = 0
    act(() => { view.result.current.setIsPlaying(true) })
    expect(clock.calls).toContain('play')
    act(() => { view.result.current.setIsPlaying(false) })
    expect(clock.calls[clock.calls.length - 1]).toBe('pause')
    act(() => { view.rerender({ t: 6 }) })
    expect(clock.calls).toContain('seek:6')
    // The seek holds the transport for 100 ms, then settles on the video's own state.
    await act(async () => { await new Promise((r) => setTimeout(r, 130)) })
    expect(clock.calls[clock.calls.length - 1]).toBe('pause')
    expect(clock.calls).not.toContain('rate')
  })

  it('while playing, the video\'s time is what the mixer follows (re-seeked past 40 ms)', async () => {
    const { view, video } = await mount()
    act(() => { view.result.current.setIsPlaying(true) })
    clock.calls.length = 0
    video.currentTime = 0.039
    act(() => { view.result.current.handleTimeUpdate() })
    expect(clock.calls).toEqual([])
    video.currentTime = 0.041
    act(() => { view.result.current.handleTimeUpdate() })
    expect(clock.calls).toEqual(['seek:0.041'])
  })

  it('a createMixClock that rejects keeps today\'s path for the session', async () => {
    const { gain, view } = await mount({ ...mixerDeps as object, createMixClock: () => Promise.reject(new Error('no worklet')) })
    act(() => { view.result.current.setIsPlaying(true) })
    act(() => { view.result.current.setIsPlaying(false) })
    expect(gain()).toBeCloseTo(0.8, 10)
    expect(live()).toHaveLength(2)
  })

  it('a muted host (the project grid hover) never builds a mixer', async () => {
    const createMixClock = vi.fn(() => Promise.resolve(clock as unknown as MixClock))
    const { gain } = await mount({ ...mixerDeps as object, createMixClock }, true)
    expect(createMixClock).not.toHaveBeenCalled()
    expect(gain()).toBe(0)
  })

  it('mixerDeps false never builds a mixer', async () => {
    const { gain } = await mount(false)
    expect(gain()).toBeCloseTo(0.8, 10)
    expect(live()).toHaveLength(2)
  })
})
