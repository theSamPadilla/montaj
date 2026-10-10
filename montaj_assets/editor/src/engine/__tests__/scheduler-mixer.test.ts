/**
 * §190 T3: the scheduler on the preview mixer's project clock, and the picture
 * planned at the audible instant in both modes.
 *
 * Same approach as scheduler.test.ts (dumb fakes, time driven by hand), with
 * its own small host: these tests care about which clock is driven and where
 * the picture is planned, not about session lifecycles, which that file covers.
 *
 * The project is two cuts off ONE proxy, the commonest timeline there is:
 * `a` plays source 0-2 s over timeline 0-2 s, `b` plays source 5-7 s over
 * timeline 2-4 s. A frame request at media position m arrives as `m * 1e6` µs.
 */
import { describe, expect, it } from 'vitest'
import type { EditorProject as Project, VisualItem } from '../../schema'
import type { MasterClock } from '../audio-clock'
import type { ChunkSource } from '../demux'
import type { FrameServer, FrameServerStats } from '../frame-server'
import {
  createScheduler,
  type ClipSource,
  type ProjectClock,
  type SourceHost,
  type SourceRequest,
  type SourceState,
} from '../scheduler'

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]

class FakeClock implements MasterClock {
  playing = false
  disposed = false
  readonly seeks: number[] = []
  plays = 0
  constructor(
    readonly kind: 'audio' | 'fallback',
    public t: number,
  ) {}
  now() {
    return this.t
  }
  play() {
    this.playing = true
    this.plays++
  }
  pause() {
    this.playing = false
  }
  seek(projectS: number) {
    this.seeks.push(projectS)
    this.t = projectS
  }
  setVolume() {}
  setTransportRate() {}
  stats() {
    return { kind: this.kind, playing: this.playing, samplesConsumed: 0, underrunFrames: 0, queuedFrames: 0, queuedSeconds: 0 }
  }
  dispose() {
    this.disposed = true
    this.playing = false
  }
}

/** MixClock's shape as the scheduler sees it: `now()` is what is rendering, `displayNow()` what is audible. */
class FakeProjectClock extends FakeClock implements ProjectClock {
  /** Audible lag while playing; `displayNow` is held at `floor` like MixClock's. */
  lag = 0
  floor = 0
  constructor(t = 0) {
    super('audio', t)
  }
  displayNow() {
    return this.playing ? Math.max(this.t - this.lag, this.floor) : this.t
  }
  play() {
    super.play()
    this.floor = this.t
  }
  seek(projectS: number) {
    super.seek(projectS)
    this.floor = projectS
  }
}

const video: ChunkSource = {
  kind: 'video',
  codec: 'avc1.64001f',
  fps: 30,
  durationS: 10,
  coded: { width: 1280, height: 720 },
  samples: [],
  presIndex: [],
  firstPresentationTsUs: 0,
}

class FakeFrameServer implements FrameServer {
  decodeAheadFrames = 8
  readonly video = video
  readonly starts: number[] = []
  readonly pulls: number[] = []
  readonly seekTargets: number[] = []
  constructor(readonly src: string) {}
  seek(targetTsUs: number) {
    this.seekTargets.push(targetTsUs)
    return { reqId: this.seekTargets.length, frame: Promise.resolve(null) }
  }
  startStream(targetTsUs: number) {
    this.starts.push(targetTsUs)
    return this.starts.length
  }
  stopStream() {}
  nextFrameFor(clockUs: number) {
    this.pulls.push(clockUs)
    return { frame: null, dropped: 0 }
  }
  stats(): FrameServerStats {
    return { buffered: 0, inFlightFrames: 0, inFlightBatches: 0, received: 0, dropped: 0, atEndOfSource: false, drained: false, lastError: null }
  }
  dispose() {}
}

/** Every clip is ready the moment it is retained, all on one server, each with its own clock. */
class FakeHost implements SourceHost {
  readonly server = new FakeFrameServer('/p/take_proxy.mp4')
  readonly sources = new Map<string, ClipSource>()
  readonly retains: SourceRequest[][] = []
  readonly fallbacks: FakeClock[] = []
  retain(requests: readonly SourceRequest[]) {
    this.retains.push([...requests])
    for (const r of requests) {
      if (this.sources.has(r.clipId)) continue
      this.sources.set(r.clipId, {
        clipId: r.clipId,
        src: r.src,
        frameServer: this.server,
        clock: new FakeClock('audio', r.anchorProjectS),
        timebase: { start: r.item.start, inPoint: r.item.inPoint ?? 0, firstPresentationTsUs: 0 },
      })
    }
  }
  state(clipId: string): SourceState {
    const source = this.sources.get(clipId)
    return source ? { status: 'ready', source } : { status: 'idle' }
  }
  fallbackClock(startProjectS: number) {
    const clock = new FakeClock('fallback', startProjectS)
    this.fallbacks.push(clock)
    return clock
  }
  clockOf(clipId: string): FakeClock {
    return this.sources.get(clipId)!.clock as FakeClock
  }
}

function clip(id: string, start: number, end: number, inPoint: number): VisualItem {
  return {
    id,
    type: 'video',
    src: '/m/take.mov',
    proxySrc: '/p/take_proxy.mp4',
    start,
    end,
    inPoint,
    outPoint: inPoint + (end - start),
  } as VisualItem
}

const project = {
  id: 'p',
  status: 'draft',
  settings: { resolution: [1080, 1920], fps: 30 },
  tracks: [{ id: 'main', items: [clip('a', 0, 2, 0), clip('b', 2, 4, 5)] }],
} as Project

function rig(latency = 0) {
  const host = new FakeHost()
  const times: Array<[number, number]> = []
  let latencyS = latency
  const scheduler = createScheduler({
    project,
    host,
    onTime: (t, raw) => times.push([t, raw]),
    latencyS: () => latencyS,
  })
  // A paused frame is only asked for when there is a canvas to put it on.
  scheduler.attach({ size: () => ({ width: 1080, height: 1920 }), paint() {}, paintBlend() {}, clear() {} })
  return {
    host,
    scheduler,
    times,
    setLatency: (s: number) => {
      latencyS = s
    },
  }
}

const us = (mediaS: number) => Math.round(mediaS * 1e6)

describe('mixer mode: the scheduler on the project clock', () => {
  it('runs a cut with no clock seek and no per-clip clock: only the picture changes session', () => {
    const { host, scheduler } = rig()
    const pc = new FakeProjectClock(0)
    scheduler.seek(1)
    scheduler.setProjectClock(pc)
    const seeksBefore = pc.seeks.length
    scheduler.play()
    expect(pc.playing).toBe(true)

    pc.t = 1.9
    scheduler.tick()
    pc.t = 2.1 // across the cut into `b`
    scheduler.tick()
    pc.t = 2.5
    scheduler.tick()

    // The project clock was never seeked at the cut, and nothing adopted a
    // per-clip clock: none was played, and the transport kept one clock.
    expect(pc.seeks.length).toBe(seeksBefore)
    expect(host.clockOf('a').plays).toBe(0)
    expect(host.clockOf('b').plays).toBe(0)
    expect(scheduler.status()).toMatchObject({ clipId: 'b', clock: 'audio', transport: 'playing' })
    expect(scheduler.now()).toBe(2.5)
    // The picture restarted its decode at b's own source position (5 + 0.1).
    expect(last(host.server.starts)).toBe(us(5.1))
  })

  it('asks the host for sessions without audio clocks, and stops asking on today\'s path', () => {
    const { host, scheduler } = rig()
    scheduler.seek(1)
    expect(last(host.retains)!.every((r) => r.noAudioClock === undefined)).toBe(true)

    scheduler.setProjectClock(new FakeProjectClock())
    expect(last(host.retains)!.length).toBeGreaterThan(0)
    expect(last(host.retains)!.every((r) => r.noAudioClock === true)).toBe(true)

    scheduler.setProjectClock(null)
    expect(last(host.retains)!.every((r) => !('noAudioClock' in r))).toBe(true)
  })

  it('paints at displayNow(), and emits it with the clock time beside it', () => {
    const { host, scheduler, times } = rig()
    const pc = new FakeProjectClock(0)
    scheduler.setProjectClock(pc)
    scheduler.play()
    pc.lag = 0.05
    pc.t = 1
    scheduler.tick()
    expect(last(host.server.pulls)).toBe(us(0.95))
    expect(last(times)).toEqual([0.95, 1])
  })

  it('keeps the picture on the outgoing clip until the cut is AUDIBLE', () => {
    const { host, scheduler, times } = rig()
    const pc = new FakeProjectClock(0)
    scheduler.setProjectClock(pc)
    scheduler.play()
    pc.lag = 0.05
    pc.t = 2.02 // the mixer is already rendering b; the speaker still plays a
    scheduler.tick()
    expect(scheduler.status().clipId).toBe('a')
    expect(last(host.server.pulls)).toBe(us(1.97))
    pc.t = 2.06
    scheduler.tick()
    expect(scheduler.status().clipId).toBe('b')
    expect(last(times)).toEqual([2.06 - 0.05, 2.06])
  })

  it('a seek is the project clock\'s seek, painted exactly there, with no teardown', () => {
    const { host, scheduler, times } = rig()
    const pc = new FakeProjectClock(0)
    scheduler.setProjectClock(pc)
    scheduler.play()
    pc.lag = 0.05
    pc.t = 0.5
    scheduler.tick()
    const sessions = new Set(host.sources.values())

    scheduler.seek(3)
    expect(last(pc.seeks)).toBe(3)
    expect(pc.playing).toBe(true)
    expect(last(times)).toEqual([3, 3])
    expect(last(host.server.starts)).toBe(us(6))
    // Every session the host had is the one it still has.
    for (const source of sessions) expect([...host.sources.values()]).toContain(source)
  })

  it('pause repaints at the frozen clock, so the paused frame is where play resumes', () => {
    const { host, scheduler, times } = rig()
    const pc = new FakeProjectClock(0)
    scheduler.setProjectClock(pc)
    scheduler.play()
    pc.lag = 0.05
    pc.t = 1.5
    scheduler.tick()
    expect(last(times)).toEqual([1.45, 1.5])

    scheduler.pause()
    expect(last(times)).toEqual([1.5, 1.5])
    expect(last(host.server.seekTargets)).toBe(us(1.5))
  })

  it('hands back to the clip\'s own clock at the same time, and pauses the project clock', () => {
    const { host, scheduler } = rig()
    const pc = new FakeProjectClock(0)
    scheduler.setProjectClock(pc)
    scheduler.seek(2.5)

    scheduler.setProjectClock(null)
    expect(pc.playing).toBe(false)
    expect(scheduler.now()).toBe(2.5)
    scheduler.play()
    expect(host.clockOf('b').playing).toBe(true)
    expect(last(host.clockOf('b').seeks)).toBe(2.5)
    expect(pc.playing).toBe(false)
  })

  it('never disposes the project clock: the engine owns it', () => {
    const { scheduler } = rig()
    const pc = new FakeProjectClock(0)
    scheduler.setProjectClock(pc)
    scheduler.dispose()
    expect(pc.disposed).toBe(false)
  })
})

describe("today's path: the picture at the clock minus the output latency", () => {
  it('paints and emits clock − latency while playing, the clock\'s own time while paused', () => {
    const { host, scheduler, times } = rig(0.035)
    scheduler.seek(1)
    expect(last(times)).toEqual([1, 1])
    scheduler.play()
    host.clockOf('a').t = 1.5
    scheduler.tick()
    expect(last(times)![0]).toBeCloseTo(1.465, 9)
    expect(last(times)![1]).toBe(1.5)
    expect(last(host.server.pulls)).toBe(us(1.465))
  })

  it('reads the latency live: a device switch moves the picture on the next tick', () => {
    const { host, scheduler, times, setLatency } = rig(0.03)
    scheduler.seek(1)
    scheduler.play()
    host.clockOf('a').t = 1.5
    scheduler.tick()
    expect(last(times)![0]).toBeCloseTo(1.47, 9)
    setLatency(0.2)
    host.clockOf('a').t = 1.6
    scheduler.tick()
    expect(last(times)![0]).toBeCloseTo(1.4, 9)
  })

  it('holds the picture at the play position rather than stepping it back', () => {
    const { host, scheduler, times } = rig(0.1)
    scheduler.seek(1)
    scheduler.play()
    host.clockOf('a').t = 1.04
    scheduler.tick()
    expect(last(times)).toEqual([1, 1.04])
    host.clockOf('a').t = 1.25
    scheduler.tick()
    expect(last(times)![0]).toBeCloseTo(1.15, 9)
  })

  it('moves the SOUND to the next clip at the cut while the picture still shows the last one', () => {
    const { host, scheduler } = rig(0.05)
    scheduler.seek(1.5)
    scheduler.play()
    const a = host.clockOf('a')
    a.t = 2.02
    scheduler.tick()
    // b's clock carries the sound from the cut on (seeked to the clock time,
    // playing); a's is paused so its source never plays past its out point.
    const b = host.clockOf('b')
    expect(a.playing).toBe(false)
    expect(b.playing).toBe(true)
    expect(last(b.seeks)).toBe(2.02)
    // The picture is still `a`, 50 ms before the cut.
    expect(scheduler.status().clipId).toBe('a')
    expect(last(host.server.pulls)).toBe(us(1.97))
  })

  it('pause brings the picture up to the frozen clock', () => {
    const { host, scheduler, times } = rig(0.05)
    scheduler.seek(1)
    scheduler.play()
    host.clockOf('a').t = 1.5
    scheduler.tick()
    scheduler.pause()
    expect(last(times)).toEqual([1.5, 1.5])
    expect(last(host.server.seekTargets)).toBe(us(1.5))
  })

  it('with no output latency it is one plan, exactly as before: no repaint at pause', () => {
    const { host, scheduler, times } = rig(0)
    scheduler.seek(1)
    scheduler.play()
    host.clockOf('a').t = 1.5
    scheduler.tick()
    expect(last(times)).toEqual([1.5, 1.5])
    const seeks = host.server.seekTargets.length
    scheduler.pause()
    expect(host.server.seekTargets.length).toBe(seeks)
  })
})
