/**
 * §190 T3: the engine's preview-mixer wiring, over a real `createEngine` and
 * `EngineSourceHost`, with `demux`, `frame-server` and `createMasterClock`
 * module-mocked the way source-host.test.ts does it, a fake MixClock, a fake
 * conform client and (but for one test) a fake plan builder.
 *
 * What is pinned: mixer mode is "the MixClock exists AND no main-track source
 * is unconformed"; the switch happens only while paused or at a seek; a switch
 * swaps a session's clock and never its decoder; the plan is posted once per
 * change; a dropped segment is muted before the plan drops it; a MixClock that
 * cannot be built leaves today's path whole. And, ported from the hook's old
 * latency specs (latencyCompensation.test.tsx), the engine paints and emits
 * the audible time: clock − (outputLatency + baseLatency), read live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorProject as Project, VisualItem } from '../../schema'
import type { ConformedSource, ConformLookup, ProjectMixPlan } from '../mix/audio-plan'
import type { ConformClient } from '../mix/conform-client'
import type { MixClock, MixClockStats, MixParam, MixPlan } from '../mix/mix-clock'

interface ServerState {
  disposed: boolean
}
interface ClockState {
  disposed: boolean
  muted: boolean
}

const serverInstances = vi.hoisted(() => [] as ServerState[])
const clockInstances = vi.hoisted(() => [] as ClockState[])
const videoTrack = vi.hoisted(() => () => ({
  kind: 'video' as const,
  codec: 'avc1.64001f',
  fps: 30,
  durationS: 10,
  coded: { width: 1280, height: 720 },
  samples: [] as unknown[],
  presIndex: [] as number[],
  firstPresentationTsUs: 0,
}))

vi.mock('../demux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../demux')>()
  return { ...actual, demux: vi.fn(async (src: string) => ({ src, video: videoTrack(), audio: null })) }
})

vi.mock('../frame-server', () => ({
  createFrameServer: vi.fn(() => {
    const state: ServerState = { disposed: false }
    serverInstances.push(state)
    return {
      video: videoTrack(),
      decodeAheadFrames: 8,
      seek: () => ({ reqId: 1, frame: Promise.resolve(null) }),
      startStream: () => 1,
      stopStream: () => {},
      nextFrameFor: () => ({ frame: null, dropped: 0 }),
      stats: () => ({ buffered: 0, inFlightFrames: 0, inFlightBatches: 0, received: 0, dropped: 0, atEndOfSource: false, drained: false, lastError: null }),
      dispose: () => {
        state.disposed = true
      },
    }
  }),
}))

vi.mock('../audio-clock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio-clock')>()
  return {
    ...actual,
    createMasterClock: vi.fn(async (opts: { muted?: boolean; startProjectS: number }) => {
      const state: ClockState = { disposed: false, muted: !!opts.muted }
      clockInstances.push(state)
      let playing = false
      let t = opts.startProjectS
      return {
        kind: 'audio' as const,
        get playing() {
          return playing
        },
        now: () => t,
        play: () => {
          playing = true
        },
        pause: () => {
          playing = false
        },
        seek: (next: number) => {
          t = next
        },
        setVolume: () => {},
        setTransportRate: () => {},
        stats: () => ({ kind: 'audio' as const, playing, samplesConsumed: 0, underrunFrames: 0, queuedFrames: 0, queuedSeconds: 0 }),
        dispose: () => {
          state.disposed = true
        },
      }
    }),
  }
})

import { createEngine, MIX_DROP_DELAY_MS, type EngineDeps, type MixerState } from '../index'
import { createMasterClock } from '../audio-clock'

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]

class FakeMix implements MixClock {
  readonly kind = 'audio' as const
  readonly sampleRate = 48000
  playing = false
  t = 0
  lag = 0
  floor = 0
  disposed = false
  readonly seeks: number[] = []
  readonly plans: MixPlan[] = []
  readonly params: Array<Record<string, MixParam>> = []
  readonly scrubs: Array<[number, 1 | -1, number]> = []
  readonly rates: number[] = []
  now() {
    return this.t
  }
  displayNow() {
    return this.playing ? Math.max(this.t - this.lag, this.floor) : this.t
  }
  play() {
    this.playing = true
    this.floor = this.t
  }
  pause() {
    this.playing = false
  }
  seek(projectS: number) {
    this.seeks.push(projectS)
    this.t = projectS
    this.floor = projectS
  }
  setRate(rate: number) {
    this.rates.push(rate)
  }
  setTransportRate(rate: number) {
    this.rates.push(rate)
  }
  setVolume() {}
  scrub(time: number, dir: 1 | -1, lenS: number) {
    this.scrubs.push([time, dir, lenS])
  }
  setPlan(plan: MixPlan) {
    this.plans.push(plan)
  }
  setParams(params: Record<string, MixParam>) {
    this.params.push(params)
  }
  stats() {
    return { kind: 'audio', playing: this.playing } as MixClockStats
  }
  dispose() {
    this.disposed = true
  }
}

const CONFORMED: ConformedSource = { url: '/api/files?path=/ws/x.pcm', format: 'pcm_s16le', sampleRate: 48000, channels: 2, frames: 48000 * 60 }

function fakeConform() {
  const ready = new Map<string, ConformedSource>()
  const listeners = new Set<() => void>()
  const requests: string[][] = []
  let disposed = false
  const client: ConformClient = {
    request: (paths) => {
      requests.push([...paths])
    },
    lookup: (src) => ready.get(src) ?? null,
    state: (path) => (ready.has(path) ? 'ready' : 'pending'),
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      disposed = true
    },
  }
  return {
    client,
    requests,
    get disposed() {
      return disposed
    },
    land(path: string, source: ConformedSource = CONFORMED) {
      ready.set(path, source)
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The builder's contract, small: one segment per conformed, unmuted item or lane; the rest reported by kind. */
const fakeBuilder = vi.fn((project: Project, lookup: ConformLookup): ProjectMixPlan => {
  const out: ProjectMixPlan = { plan: { segments: [] }, unconformedMain: [], unconformedLanes: [], unconformedOverlays: [] }
  ;(project.tracks ?? []).forEach((track, ti) => {
    for (const item of track.items ?? []) {
      if (item.type !== 'video' || item.muted) continue
      const c = lookup(item.src!)
      if (!c) (ti === 0 ? out.unconformedMain : out.unconformedOverlays).push(item.src!)
      else out.plan.segments.push({ id: `clip:${item.id}`, url: c.url, tlStart: item.start, tlEnd: item.end, gain: item.volume ?? 1 })
    }
  })
  for (const lane of project.audio?.tracks ?? []) {
    if (lane.muted || !lane.src) continue
    const c = lookup(lane.src)
    if (!c) out.unconformedLanes.push(lane.src)
    else out.plan.segments.push({ id: `lane:${lane.id}`, url: c.url, tlStart: lane.start ?? 0, gain: lane.volume ?? 1 })
  }
  return out
})

const fakeSources = (project: Project) => [
  ...(project.tracks ?? []).flatMap((t) => (t.items ?? []).filter((i) => i.type === 'video').map((i) => i.src!)),
  ...(project.audio?.tracks ?? []).map((l) => l.src!),
]

function mainClip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'a', type: 'video', src: '/media/a.mov', proxySrc: '/proxies/a_proxy.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, ...over } as VisualItem
}

function project(main: VisualItem[] = [mainClip()]): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      { id: 'main', items: main },
      { id: 'upper', items: [{ id: 'o', type: 'video', src: '/media/broll.mov', start: 1, end: 3, inPoint: 0 } as VisualItem] },
    ],
    audio: { tracks: [{ id: 'm', src: '/media/music.mp3', start: 0, end: 5, inPoint: 0, volume: 1 }] },
  } as unknown as Project
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function rig(
  over: {
    createMixClock?: () => Promise<MixClock>
    /** `false`: the real builder and source list. */
    builder?: false | ((project: Project, lookup: ConformLookup) => ProjectMixPlan)
  } = {},
) {
  const mix = new FakeMix()
  const conform = fakeConform()
  const errors: string[] = []
  const mixerStates: MixerState[] = []
  const deps: EngineDeps = {
    fileUrl: (p) => p,
    nowMs: () => 0,
    requestFrame: () => 1,
    cancelFrame: () => {},
    onError: (m) => errors.push(m),
    onMixerChange: (s) => mixerStates.push(s),
    mixer: {
      createMixClock: over.createMixClock ?? (async () => mix),
      conform: conform.client,
      ...(over.builder === false ? {} : { buildMixPlan: over.builder ?? fakeBuilder, audioSourcePaths: fakeSources }),
    },
  }
  const engine = createEngine(project(), deps)
  return { engine, mix, conform, errors, mixerStates }
}

beforeEach(() => {
  serverInstances.length = 0
  clockInstances.length = 0
  fakeBuilder.mockClear()
  vi.mocked(createMasterClock).mockClear()
})

/** Open, build the first session, conform the main track: mixer mode, paused at `at`. */
async function inMixer(at = 0) {
  const r = rig()
  r.engine.seek(at)
  await flush()
  r.conform.land('/media/a.mov')
  await flush()
  return r
}

describe('engine: which path carries the sound', () => {
  it('a MixClock that cannot be built leaves the whole session on today\'s path, silently', async () => {
    const r = rig({ createMixClock: () => Promise.reject(new Error('AudioWorklet unavailable')) })
    r.engine.seek(0)
    await flush()
    expect(vi.mocked(createMasterClock)).toHaveBeenCalledTimes(1)
    expect(clockInstances[0].disposed).toBe(false)
    expect(r.conform.requests).toEqual([])
    expect(fakeBuilder).not.toHaveBeenCalled()
    expect(r.mixerStates).toEqual([])
    expect(r.errors).toEqual([])
    expect(r.engine.status().clock).toBe('audio')
    r.engine.dispose()
  })

  it('asks for every source\'s conform when the project opens, and again for an edit\'s new ones', async () => {
    const r = rig()
    await flush()
    expect(r.conform.requests[0]).toEqual(['/media/a.mov', '/media/broll.mov', '/media/music.mp3'])
    const next = project([mainClip(), mainClip({ id: 'b', src: '/media/b.mov', proxySrc: '/proxies/b_proxy.mp4', start: 5, end: 8 })])
    r.engine.updateProject(next)
    expect(last(r.conform.requests)).toContain('/media/b.mov')
    r.engine.dispose()
  })

  it('stays on today\'s path while a main-track conform is pending, and switches when it lands, paused', async () => {
    const r = rig()
    r.engine.seek(1)
    await flush()
    expect(r.mix.seeks).toEqual([])
    expect(r.mixerStates).toEqual([])
    expect(clockInstances).toHaveLength(1)

    r.conform.land('/media/a.mov')
    await flush()
    // Mixer mode: the project clock took the transport where it stood, the
    // plan went to the mixer first, and the lane and the overlay video (not
    // conformed yet) keep their own elements.
    expect(r.mix.seeks).toEqual([1])
    expect(last(r.mix.plans)!.segments.map((s) => s.id)).toEqual(['clip:a'])
    expect(last(r.mixerStates)).toEqual({
      active: true,
      unconformedLanes: new Set(['/media/music.mp3']),
      unconformedOverlays: new Set(['/media/broll.mov']),
    })
    // The session's audio clock is gone and its decoder is not: no respawn.
    expect(clockInstances[0].disposed).toBe(true)
    expect(serverInstances).toHaveLength(1)
    expect(serverInstances[0].disposed).toBe(false)
    expect(vi.mocked(createMasterClock)).toHaveBeenCalledTimes(1)
    r.engine.dispose()
  })

  it('a conform that lands mid-play waits for the pause to switch', async () => {
    const r = rig()
    r.engine.seek(1)
    await flush()
    r.engine.play()
    r.conform.land('/media/a.mov')
    await flush()
    expect(r.mix.seeks).toEqual([])
    expect(r.mix.playing).toBe(false)
    expect(r.mixerStates).toEqual([])

    r.engine.pause()
    expect(last(r.mixerStates)?.active).toBe(true)
    expect(r.mix.seeks.length).toBe(1)
    expect(r.mix.playing).toBe(false)
    r.engine.dispose()
  })

  it('or for a seek, where the project clock takes over playing from the target', async () => {
    const r = rig()
    r.engine.seek(1)
    await flush()
    r.engine.play()
    r.conform.land('/media/a.mov')
    await flush()
    r.engine.seek(2.5)
    expect(last(r.mixerStates)?.active).toBe(true)
    expect(last(r.mix.seeks)).toBe(2.5)
    expect(r.mix.playing).toBe(true)
    expect(r.engine.status().transport).toBe('playing')
    r.engine.dispose()
  })

  it('a lane that conforms mid-play keeps its element until the pause, then moves into the plan', async () => {
    const r = await inMixer()
    r.engine.play()
    r.conform.land('/media/music.mp3')
    await flush()
    expect(last(r.mixerStates)?.unconformedLanes.has('/media/music.mp3')).toBe(true)
    expect(last(r.mix.plans)!.segments.map((s) => s.id)).toEqual(['clip:a'])

    r.engine.pause()
    expect(last(r.mixerStates)?.unconformedLanes.size).toBe(0)
    expect(last(r.mix.plans)!.segments.map((s) => s.id)).toEqual(['clip:a', 'lane:m'])
    r.engine.dispose()
  })

  it('an edit adding an unconformed main-track clip goes back to today\'s path, decoder kept', async () => {
    const r = await inMixer(1)
    const builtBefore = vi.mocked(createMasterClock).mock.calls.length
    r.engine.updateProject(project([mainClip(), mainClip({ id: 'b', src: '/media/b.mov', proxySrc: '/proxies/b_proxy.mp4', start: 5, end: 8 })]))
    await flush()
    expect(last(r.mixerStates)).toMatchObject({ active: false })
    expect(last(r.mix.plans)).toEqual({ segments: [] })
    // The clip's own audio clock is built again behind the same decoder.
    expect(vi.mocked(createMasterClock).mock.calls.length).toBe(builtBefore + 1)
    expect(serverInstances).toHaveLength(1)
    expect(serverInstances[0].disposed).toBe(false)
    expect(last(clockInstances)!.disposed).toBe(false)
    r.engine.dispose()
  })

  it('an edit mid-play that wants today\'s path keeps the mixer playing until the pause', async () => {
    const r = await inMixer(1)
    r.engine.play()
    r.engine.updateProject(project([mainClip(), mainClip({ id: 'b', src: '/media/b.mov', proxySrc: '/proxies/b_proxy.mp4', start: 5, end: 8 })]))
    await flush()
    // Never two clocks mid-play: the mixer keeps the transport, playing what
    // the plan still has, and the switch waits.
    expect(last(r.mixerStates)?.active).toBe(true)
    expect(r.mix.playing).toBe(true)
    expect(r.engine.status().clock).toBe('audio')

    r.engine.pause()
    expect(last(r.mixerStates)?.active).toBe(false)
    expect(last(r.mix.plans)).toEqual({ segments: [] })
    r.engine.dispose()
  })

  it('a plan builder that throws is today\'s path, logged once rather than per edit', async () => {
    const r = rig({
      builder: () => {
        throw new Error('boom')
      },
    })
    r.engine.seek(0)
    await flush()
    r.conform.land('/media/a.mov')
    await flush()
    r.engine.updateProject(project([mainClip({ volume: 0.5 })]))
    await flush()
    expect(r.mixerStates).toEqual([])
    expect(r.mix.seeks).toEqual([])
    expect(r.errors).toEqual(['preview mixer: plan: boom'])
    r.engine.dispose()
  })
})

describe('engine in mixer mode', () => {
  it('a seek is the mixer\'s seek: no plan rebuild, no new session', async () => {
    const r = await inMixer()
    const builds = fakeBuilder.mock.calls.length
    const plans = r.mix.plans.length
    r.engine.seek(3)
    expect(last(r.mix.seeks)).toBe(3)
    expect(fakeBuilder.mock.calls.length).toBe(builds)
    expect(r.mix.plans.length).toBe(plans)
    expect(serverInstances).toHaveLength(1)
    r.engine.dispose()
  })

  it('edits rebuild the plan once per task, and only a changed plan is posted', async () => {
    const r = await inMixer()
    const plans = r.mix.plans.length
    const builds = fakeBuilder.mock.calls.length
    r.engine.updateProject(project([mainClip({ volume: 0.7 })]))
    r.engine.updateProject(project([mainClip({ volume: 0.5 })]))
    await flush()
    expect(fakeBuilder.mock.calls.length).toBe(builds + 1)
    expect(r.mix.plans.length).toBe(plans + 1)
    expect(last(r.mix.plans)!.segments[0].gain).toBe(0.5)

    r.engine.updateProject(project([mainClip({ volume: 0.5 })]))
    await flush()
    expect(r.mix.plans.length).toBe(plans + 1)
    r.engine.dispose()
  })

  it('a mute fades the clip out before the plan drops it, and an unmute clears that fade', async () => {
    const r = await inMixer()
    r.engine.play()
    const plans = r.mix.plans.length
    r.engine.updateProject(project([mainClip({ muted: true })]))
    await flush()
    expect(last(r.mix.params)).toEqual({ 'clip:a': { mute: true } })
    expect(r.mix.plans.length).toBe(plans)
    // Mute is a plan change in mixer mode, never a respawn.
    expect(serverInstances).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, MIX_DROP_DELAY_MS + 10))
    expect(last(r.mix.plans)!.segments).toEqual([])

    r.engine.updateProject(project([mainClip()]))
    await flush()
    expect(last(r.mix.params)).toEqual({ 'clip:a': { mute: false } })
    expect(last(r.mix.plans)!.segments.map((s) => s.id)).toEqual(['clip:a'])
    r.engine.dispose()
  })

  it('a segment dropped while the mixer is silent goes at once, with no fade', async () => {
    const r = await inMixer()
    r.engine.updateProject(project([mainClip({ muted: true })]))
    await flush()
    expect(r.mix.params).toEqual([])
    expect(last(r.mix.plans)!.segments).toEqual([])
    r.engine.dispose()
  })

  it('dispose disposes the MixClock, and leaves an injected conform client to its owner', async () => {
    const r = await inMixer()
    r.engine.dispose()
    expect(r.mix.disposed).toBe(true)
    expect(r.conform.disposed).toBe(false)
  })
})

describe('engine: shuttle and scrub in mixer mode (§190 T4)', () => {
  it('hands out no scrub sink until mixer mode, then one that reaches the MixClock', async () => {
    const r = rig()
    r.engine.seek(1)
    await flush()
    expect(r.engine.mixerScrub()).toBeNull()
    r.conform.land('/media/a.mov')
    await flush()
    const sink = r.engine.mixerScrub()
    expect(sink).not.toBeNull()
    sink!(2.5, -1, 0.08)
    expect(r.mix.scrubs).toEqual([[2.5, -1, 0.08]])
    r.engine.dispose()
  })

  it('and none again once an edit sends the session back to today\'s path', async () => {
    const r = await inMixer(1)
    expect(r.engine.mixerScrub()).not.toBeNull()
    r.engine.updateProject(project([mainClip(), mainClip({ id: 'b', src: '/media/b.mov', proxySrc: '/proxies/b_proxy.mp4', start: 5, end: 8 })]))
    await flush()
    expect(r.engine.mixerScrub()).toBeNull()
    r.engine.dispose()
  })

  it('the transport rate, forward or backward, reaches the MixClock, paused or playing', async () => {
    const r = await inMixer(1)
    r.engine.setRate(2)
    r.engine.setRate(-2)
    r.engine.setRate(1)
    expect(r.mix.rates).toEqual([2, -2, 1])
    r.engine.play()
    r.engine.setRate(4)
    expect(last(r.mix.rates)).toBe(4)
    r.engine.dispose()
  })

  it('a rate set before the switch is carried onto the MixClock with the transport', async () => {
    const r = rig()
    r.engine.seek(1)
    await flush()
    r.engine.setRate(2)
    r.conform.land('/media/a.mov')
    await flush()
    expect(last(r.mix.rates)).toBe(2)
    r.engine.dispose()
  })
})

describe('engine with the real plan builder', () => {
  it('asks for the sources the builder names, and keys its plan by `clip:` and `lane:` ids', async () => {
    const r = rig({ builder: false })
    r.engine.seek(0)
    await flush()
    expect(r.conform.requests[0]).toEqual(['/media/a.mov', '/media/broll.mov', '/media/music.mp3'])
    r.conform.land('/media/a.mov')
    await flush()
    expect(last(r.mixerStates)).toEqual({
      active: true,
      unconformedLanes: new Set(['/media/music.mp3']),
      unconformedOverlays: new Set(['/media/broll.mov']),
    })
    r.conform.land('/media/music.mp3')
    r.conform.land('/media/broll.mov')
    await flush()
    expect(last(r.mix.plans)!.segments.map((s) => s.id).sort()).toEqual(['clip:a', 'clip:o', 'lane:m'])
    expect(last(r.mixerStates)).toEqual({ active: true, unconformedLanes: new Set(), unconformedOverlays: new Set() })
    r.engine.dispose()
  })
})

// ── The audible time (ported from latencyCompensation.test.tsx) ─────────────

interface StubCtx {
  outputLatency: number
  baseLatency: number
}

function stubCtx(outputLatency: number, baseLatency = 0): StubCtx {
  const ctx = { outputLatency, baseLatency, state: 'running' }
  ;(window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx = ctx
  return ctx
}

function canvasProject(): Project {
  return {
    id: 'c',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'main', items: [{ id: 'img', type: 'image', src: '/bg.png', start: 0, end: 10 }] }],
  } as Project
}

function wallRig() {
  let now = 0
  const frames: Array<() => void> = []
  const times: Array<[number, number]> = []
  const engine = createEngine(canvasProject(), {
    fileUrl: (p) => p,
    nowMs: () => now,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {},
    onTime: (t, raw) => times.push([t, raw]),
    mixer: false,
  })
  return {
    engine,
    times,
    at(ms: number) {
      now = ms
      const due = frames.splice(0)
      for (const cb of due) cb()
    },
  }
}

describe('engine: the playhead and the canvas at the audible time', () => {
  afterEach(() => {
    delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
  })

  it('emits clock − (outputLatency + baseLatency) while playing, with the clock beside it', () => {
    stubCtx(0.03, 0.005)
    const r = wallRig()
    r.engine.play()
    r.at(1000)
    expect(last(r.times)![0]).toBeCloseTo(0.965, 9)
    expect(last(r.times)![1]).toBe(1)
    r.engine.dispose()
  })

  it('re-reads the latency live (a device switch)', () => {
    const ctx = stubCtx(0.03)
    const r = wallRig()
    r.engine.play()
    r.at(1000)
    expect(last(r.times)![0]).toBeCloseTo(0.97, 9)
    ctx.outputLatency = 0.2
    r.at(2000)
    expect(last(r.times)![0]).toBeCloseTo(1.8, 9)
    r.engine.dispose()
  })

  it('does not compensate while paused: a scrub shows exactly where it landed', () => {
    stubCtx(0.03)
    const r = wallRig()
    r.engine.seek(5)
    expect(last(r.times)).toEqual([5, 5])
    r.engine.dispose()
  })

  it('never shows less than the play position (the old clamp at zero, now a hold)', () => {
    stubCtx(0.5)
    const r = wallRig()
    r.engine.seek(2)
    r.engine.play()
    r.at(100)
    expect(last(r.times)).toEqual([2, 2.1])
    r.engine.dispose()
  })

  it('no shared context yet means nothing is buffered ahead of the speaker: no compensation', () => {
    const r = wallRig()
    r.engine.play()
    r.at(1000)
    expect(last(r.times)).toEqual([1, 1])
    r.engine.dispose()
  })
})
