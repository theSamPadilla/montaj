/**
 * §190 T5: the `<video>` path's mixer control, against a fake MixClock and a
 * fake conform client. The video is the clock; the mixer follows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLegacyMixer, MIX_DRIFT_S, type LegacyMixer } from '../legacy-mixer'
import type { MixerState } from '../../../engine'
import type { ProjectMixPlan } from '../../../engine/mix/audio-plan'
import type { ConformClient } from '../../../engine/mix/conform-client'
import type { MixClock } from '../../../engine/mix/mix-clock'
import type { EditorProject } from '../../../schema'

const PROJECT = { id: 'p', tracks: [] } as unknown as EditorProject

function fakeClock() {
  const calls: string[] = []
  const clock = {
    playing: false,
    mixNow: 0,
    calls,
    now: () => clock.mixNow,
    play: () => { clock.playing = true; calls.push('play') },
    pause: () => { clock.playing = false; calls.push('pause') },
    seek: (t: number) => { clock.mixNow = t; calls.push(`seek:${t}`) },
    setRate: () => { calls.push('rate') },
    setVolume: (v: number) => { calls.push(`volume:${v}`) },
    setPlan: (p: { segments: unknown[] }) => { calls.push(`plan:${p.segments.length}`) },
    setParams: () => { calls.push('params') },
    dispose: () => { calls.push('dispose') },
  }
  return clock
}

function fakeConform() {
  let listener: (() => void) | null = null
  const client = {
    request: vi.fn(),
    lookup: () => null,
    state: () => undefined,
    onChange: (l: () => void) => { listener = l; return () => { listener = null } },
    dispose: vi.fn(),
    fire: () => listener?.(),
  }
  return client
}

const READY: ProjectMixPlan = { plan: { segments: [{ id: 'clip:a' }] } as never, unconformedMain: [], unconformedLanes: [], unconformedOverlays: [] }
const WAITING: ProjectMixPlan = { ...READY, unconformedMain: ['/a.mov'] }

describe('legacy mixer (the <video> path)', () => {
  let clock: ReturnType<typeof fakeClock>
  let conform: ReturnType<typeof fakeConform>
  let plan: ProjectMixPlan
  let playing: boolean
  let videoT: number
  let states: MixerState[]
  let mixer: LegacyMixer

  const start = async (create?: () => Promise<MixClock>) => {
    mixer = createLegacyMixer(
      {
        createMixClock: create ?? (() => Promise.resolve(clock as unknown as MixClock)),
        buildMixPlan: () => plan,
        audioSourcePaths: () => ['/a.mov'],
        conform: conform as unknown as ConformClient,
      },
      { playing: () => playing, time: () => videoT, project: () => PROJECT, onChange: (s) => states.push(s) },
    )
    await vi.waitFor(() => expect(conform.request).toHaveBeenCalled())
  }
  const settled = () => new Promise((r) => setTimeout(r, 0))

  beforeEach(() => {
    clock = fakeClock()
    conform = fakeConform()
    plan = READY
    playing = false
    videoT = 0
    states = []
  })
  afterEach(() => mixer?.dispose())

  it('switches into the mixer while paused, and says what it covers', async () => {
    await start()
    await settled()
    expect(states).toHaveLength(1)
    expect(states[0].active).toBe(true)
    expect(clock.calls).toContain('plan:1')
  })

  it('does not switch mid-play: a conform that lands while playing waits for the pause', async () => {
    plan = WAITING
    await start()
    await settled()
    expect(states).toHaveLength(0)

    playing = true
    plan = READY
    conform.fire()
    await settled()
    expect(states).toHaveLength(0)
    expect(clock.calls).not.toContain('plan:1')

    playing = false
    mixer.setPlaying(false, 3)
    expect(states.map((s) => s.active)).toEqual([true])
  })

  it('switches at a seek while playing, and the mixer starts at the video time', async () => {
    plan = WAITING
    await start()
    await settled()
    playing = true
    plan = READY
    conform.fire()
    videoT = 7
    mixer.seek(7)
    expect(states.map((s) => s.active)).toEqual([true])
    expect(clock.calls.slice(-2)).toEqual(['seek:7', 'play'])
  })

  it('stays off while a main-track source has no conform', async () => {
    plan = WAITING
    await start()
    await settled()
    mixer.setPlaying(true, 0)
    mixer.seek(5)
    expect(states).toHaveLength(0)
    expect(clock.calls.filter((c) => c === 'play')).toHaveLength(0)
  })

  it('play, pause and seek follow the video; the rate is never touched', async () => {
    await start()
    await settled()
    clock.calls.length = 0
    playing = true
    mixer.setPlaying(true, 2)
    expect(clock.calls).toEqual(['seek:2', 'play'])
    mixer.seek(9)
    expect(clock.calls).toContain('seek:9')
    playing = false
    mixer.setPlaying(false, 9)
    expect(clock.calls[clock.calls.length - 1]).toBe('pause')
    expect(clock.calls).not.toContain('rate')
  })

  it('re-syncs only past 40 ms of drift: not at 39 ms, yes at 41 ms', async () => {
    await start()
    await settled()
    playing = true
    mixer.setPlaying(true, 10)
    clock.calls.length = 0
    clock.mixNow = 10
    expect(MIX_DRIFT_S).toBe(0.04)
    mixer.follow(10.039)
    mixer.follow(9.961)
    expect(clock.calls).toEqual([])
    mixer.follow(10.041)
    expect(clock.calls).toEqual(['seek:10.041'])
    clock.calls.length = 0
    clock.mixNow = 10
    mixer.follow(9.959)
    expect(clock.calls).toEqual(['seek:9.959'])
  })

  it('does not follow while the mixer is paused or not in charge', async () => {
    plan = WAITING
    await start()
    await settled()
    mixer.follow(50)
    expect(clock.calls).toEqual([])
  })

  it('a createMixClock that rejects leaves today\'s path: no state, no conform, no throw', async () => {
    mixer = createLegacyMixer(
      { createMixClock: () => Promise.reject(new Error('no AudioWorklet')), conform: conform as unknown as ConformClient },
      { playing: () => false, time: () => 0, project: () => PROJECT, onChange: (s) => states.push(s) },
    )
    await settled()
    mixer.setPlaying(true, 1)
    mixer.seek(2)
    mixer.follow(3)
    mixer.projectChanged(PROJECT)
    expect(states).toHaveLength(0)
    expect(conform.request).not.toHaveBeenCalled()
  })

  it('the volume reaches the mixer', async () => {
    await start()
    mixer.setVolume(0)
    await settled()
    expect(clock.calls).toContain('volume:0')
  })
})
