/**
 * §190 T2: MixClock, the main-thread side, against fake node, Worker and
 * channel objects: what it sends, and how it turns reports into `now()` and
 * `displayNow()`. The three parties running together are in
 * mix-pipeline.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { MasterClock } from '../../audio-clock'
import { createMixClock, clampRate, type MixClock, type MixClockOptions } from '../mix-clock'
import { MIX_CACHE_BYTES, MIX_MAX_EXTRAPOLATION_MS, MIX_PROCESSOR_NAME, type MixReport } from '../mix-protocol'

interface Sent {
  msg: Record<string, unknown>
  transfer?: unknown[]
}

async function rig(over: Partial<MixClockOptions> = {}) {
  let nowMs = 1000
  const nodeSent: Sent[] = []
  const workerSent: Sent[] = []
  const connected: unknown[] = []
  let disconnected = false
  let terminated = false
  let nodeOptions: AudioWorkletNodeOptions | null = null
  const errors: string[] = []
  const node = {
    port: {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage(msg: Record<string, unknown>, transfer?: unknown[]) {
        nodeSent.push({ msg, transfer })
      },
    },
    connect(d: unknown) {
      connected.push(d)
    },
    disconnect() {
      disconnected = true
    },
  }
  const worker = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage(msg: Record<string, unknown>, transfer?: unknown[]) {
      workerSent.push({ msg, transfer })
    },
    terminate() {
      terminated = true
    },
  }
  const ctx = {
    sampleRate: 48000,
    destination: { dest: true } as unknown as AudioDestinationNode,
    outputLatency: 0.02,
    baseLatency: 0.005,
  }
  const clock = await createMixClock({
    context: ctx,
    nowMs: () => nowMs,
    loadModule: async () => {},
    createNode: (_c, o) => {
      nodeOptions = o
      return node
    },
    spawnWorker: () => worker,
    createChannel: () => ({ port1: 'PORT1', port2: 'PORT2' }),
    baseUrl: 'http://app.local/editor/index.html',
    onError: (m) => errors.push(m),
    ...over,
  })
  const report = (r: Partial<MixReport>) =>
    node.port.onmessage?.({
      data: {
        t: 'report',
        seq: 0,
        gen: 0,
        playing: false,
        rate: 1,
        k: 0,
        renderedFrames: 0,
        timelineTime: 0,
        contextTime: 0,
        underrunFrames: 0,
        primingFrames: 0,
        starving: [],
        queuedFrames: 0,
        ...r,
      },
    } as MessageEvent)
  return {
    clock,
    node,
    worker,
    ctx,
    nodeSent,
    workerSent,
    connected,
    errors,
    report,
    get nodeOptions() {
      return nodeOptions
    },
    get disconnected() {
      return disconnected
    },
    get terminated() {
      return terminated
    },
    setNow(ms: number) {
      nowMs = ms
    },
    lastNode: () => nodeSent[nodeSent.length - 1].msg,
  }
}

describe('construction', () => {
  it('builds the node, connects it, and wires the channel: one port to the worklet, one to the Worker', async () => {
    const r = await rig()
    expect(r.nodeOptions).toMatchObject({
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sampleRate: 48000, reportIntervalS: 0.05, smoothingS: 0.01, transportFadeS: 0.005, startTime: 0 },
    })
    expect(r.connected).toEqual([r.ctx.destination])
    expect(r.nodeSent[0]).toEqual({ msg: { t: 'connect', port: 'PORT1' }, transfer: ['PORT1'] })
    expect(r.workerSent[0].msg).toMatchObject({
      t: 'init',
      port: 'PORT2',
      sampleRate: 48000,
      aheadS: 1.5,
      refillS: 0.25,
      blockS: 0.25,
      cacheBytes: MIX_CACHE_BYTES,
    })
    expect(r.workerSent[0].transfer).toEqual(['PORT2'])
    expect(MIX_PROCESSOR_NAME).toBe('montaj-mix')
  })

  it('connects where it is told, or nowhere', async () => {
    const dest = { mine: true } as unknown as AudioNode
    expect((await rig({ destination: dest })).connected).toEqual([dest])
    expect((await rig({ destination: null })).connected).toEqual([])
  })

  it('rejects when the worklet cannot load (the caller picks the fallback)', async () => {
    await expect(rig({ loadModule: async () => Promise.reject(new Error('no worklet')) })).rejects.toThrow('no worklet')
  })

  it('disconnects the node if the Worker cannot start', async () => {
    let disconnected = false
    await expect(
      createMixClock({
        context: { sampleRate: 48000, destination: {} as AudioDestinationNode },
        loadModule: async () => {},
        createNode: () => ({
          port: { onmessage: null, postMessage() {} },
          connect() {},
          disconnect() {
            disconnected = true
          },
        }),
        spawnWorker: () => {
          throw new Error('no Worker')
        },
      }),
    ).rejects.toThrow('no Worker')
    expect(disconnected).toBe(true)
  })

  it('is a MasterClock as far as a caller can tell', async () => {
    const r = await rig()
    const asMaster: MasterClock = r.clock
    expect(asMaster.kind).toBe('audio')
    const s = asMaster.stats()
    for (const key of ['kind', 'playing', 'samplesConsumed', 'underrunFrames', 'queuedFrames', 'queuedSeconds']) {
      expect(s).toHaveProperty(key)
    }
  })
})

describe('now()', () => {
  it('holds the start time while paused', async () => {
    const r = await rig({ startTime: 3 })
    expect(r.clock.now()).toBe(3)
    r.setNow(5000)
    expect(r.clock.now()).toBe(3)
    expect(r.clock.displayNow()).toBe(3)
  })

  it('advances from play before any report, and stalls at the extrapolation cap', async () => {
    const r = await rig()
    r.clock.play()
    expect(r.lastNode()).toEqual({ t: 'play', seq: 1 })
    r.setNow(1020)
    expect(r.clock.now()).toBeCloseTo(0.02, 9)
    r.setNow(9000)
    expect(r.clock.now()).toBeCloseTo(MIX_MAX_EXTRAPOLATION_MS / 1000, 9)
  })

  it('maps a report through its contextTime, correcting a late arrival with the earliest offset seen', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(2000)
    r.report({ seq: 1, playing: true, timelineTime: 0.5, contextTime: 10 })
    expect(r.clock.now()).toBeCloseTo(0.5, 9)
    r.setNow(2030)
    expect(r.clock.now()).toBeCloseTo(0.53, 9)
    // The next report left the audio thread at perf 2100 but arrived 20 ms late.
    r.setNow(2120)
    r.report({ seq: 1, playing: true, timelineTime: 0.6, contextTime: 10.1 })
    expect(r.clock.now()).toBeCloseTo(0.62, 9)
  })

  it('ignores reports from before the current transport op', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(1000)
    r.report({ seq: 0, playing: false, timelineTime: 7, contextTime: 1 })
    r.setNow(1010)
    expect(r.clock.now()).toBeCloseTo(0.01, 9)
    // stats still sees it
    expect(r.clock.stats().timelineTime).toBe(7)
  })

  it('holds a small backward correction instead of stepping back', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(2000)
    r.report({ seq: 1, playing: true, timelineTime: 0.5, contextTime: 10 })
    r.setNow(2030)
    expect(r.clock.now()).toBeCloseTo(0.53, 9)
    r.setNow(2031)
    r.report({ seq: 1, playing: true, timelineTime: 0.525, contextTime: 10.031 })
    expect(r.clock.now()).toBeCloseTo(0.53, 9)
    r.setNow(2040)
    expect(r.clock.now()).toBeCloseTo(0.534, 9)
  })

  it('runs at the report rate', async () => {
    const r = await rig()
    r.clock.setRate(2)
    r.clock.play()
    r.setNow(2000)
    r.report({ seq: 2, gen: 1, playing: true, rate: 2, timelineTime: 1, contextTime: 5 })
    r.setNow(2050)
    expect(r.clock.now()).toBeCloseTo(1.1, 9)
  })
})

describe('transport', () => {
  it('pause freezes where the fade will end, then adopts the worklet final reading', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(2000)
    r.report({ seq: 1, playing: true, timelineTime: 0.5, contextTime: 10 })
    r.setNow(2100)
    r.clock.pause()
    expect(r.lastNode()).toEqual({ t: 'pause', seq: 2 })
    expect(r.clock.playing).toBe(false)
    expect(r.clock.now()).toBeCloseTo(0.6 + 0.005, 9)
    r.setNow(3000)
    expect(r.clock.now()).toBeCloseTo(0.605, 9)
    r.report({ seq: 2, playing: false, timelineTime: 0.6049, contextTime: 10.105 })
    expect(r.clock.now()).toBe(0.6049)
    // Play resumes from there.
    r.clock.play()
    r.setNow(3010)
    expect(r.clock.now()).toBeCloseTo(0.6149, 9)
  })

  it('seek while playing starts a generation and reaches the target after the 5 ms fade', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(2000)
    r.clock.seek(4)
    expect(r.lastNode()).toEqual({ t: 'seek', seq: 2, gen: 1, time: 4 })
    expect(r.clock.now()).toBe(4)
    r.setNow(2004)
    expect(r.clock.now()).toBe(4)
    r.setNow(2015)
    expect(r.clock.now()).toBeCloseTo(4.01, 9)
    // A report from the old generation is ignored.
    r.report({ seq: 1, gen: 0, playing: true, timelineTime: 0.2, contextTime: 10 })
    expect(r.clock.now()).toBeCloseTo(4.01, 9)
    expect(r.clock.stats().gen).toBe(1)
  })

  it('seek while paused moves the frozen time at once; mediaS is ignored', async () => {
    const r = await rig()
    r.clock.seek(2.5, 99)
    expect(r.clock.now()).toBe(2.5)
    expect(r.lastNode()).toEqual({ t: 'seek', seq: 1, gen: 1, time: 2.5 })
  })

  it('setRate clamps, opens a generation, and is also setTransportRate', async () => {
    const r = await rig()
    r.clock.setRate(100)
    expect(r.lastNode()).toEqual({ t: 'rate', seq: 1, gen: 1, rate: 16 })
    r.clock.setTransportRate(-0.001)
    expect(r.lastNode()).toEqual({ t: 'rate', seq: 2, gen: 2, rate: -1 / 16 })
    const n = r.nodeSent.length
    r.clock.setRate(-1 / 16) // unchanged: nothing sent
    expect(r.nodeSent.length).toBe(n)
    expect(clampRate(0)).toBe(1)
    expect(clampRate(Number.NaN)).toBe(1)
    expect(clampRate(-3)).toBe(-3)
  })

  it('setRate while playing keeps the clock continuous through the switch', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(2000)
    r.report({ seq: 1, playing: true, timelineTime: 1, contextTime: 10 })
    r.setNow(2010)
    r.clock.setRate(2)
    // 1.01 now; the worklet switches 5 ms later at 1.015, then runs 2x.
    expect(r.clock.now()).toBeCloseTo(1.015, 9)
    r.setNow(2025)
    expect(r.clock.now()).toBeCloseTo(1.015 + 0.02, 9)
  })
})

describe('displayNow()', () => {
  it('is now() less the output latency, held at the start until the first audio is out', async () => {
    const r = await rig({ startTime: 1 })
    r.clock.play()
    r.setNow(1010)
    expect(r.clock.displayNow()).toBe(1) // 1.01 - 0.025 is before the play position
    r.setNow(1100)
    expect(r.clock.displayNow()).toBeCloseTo(1.1 - 0.025, 9)
    r.ctx.outputLatency = 0.2 // a Bluetooth device
    expect(r.clock.displayNow()).toBe(1)
  })

  it('after a pause, glides to the stop point over the latency rather than jumping', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(2000)
    r.report({ seq: 1, playing: true, timelineTime: 0.5, contextTime: 10 })
    expect(r.clock.displayNow()).toBeCloseTo(0.475, 9)
    r.clock.pause()
    expect(r.clock.displayNow()).toBeCloseTo(0.475, 9)
    r.setNow(2010)
    expect(r.clock.displayNow()).toBeCloseTo(0.485, 9)
    r.setNow(2100)
    expect(r.clock.displayNow()).toBeCloseTo(0.505, 9)
  })

  it('subtracts rate x latency at other rates', async () => {
    const r = await rig()
    r.clock.setRate(2)
    r.clock.play()
    r.setNow(2000)
    r.report({ seq: 2, gen: 1, playing: true, rate: 2, timelineTime: 3, contextTime: 10 })
    expect(r.clock.displayNow()).toBeCloseTo(3 - 2 * 0.025, 9)
  })
})

describe('plan, params and stats', () => {
  it('sends the plan to the Worker with absolute URLs and a plan generation', async () => {
    const r = await rig()
    r.clock.setPlan({
      segments: [
        { id: 'a', url: '/api/files?path=x.pcm', tlStart: 0, tlEnd: 1 },
        { id: 'b', url: 'http://other/y.pcm', tlStart: 1 },
      ],
    })
    const m = r.workerSent[r.workerSent.length - 1].msg as { t: string; planGen: number; segments: Array<{ url: string }> }
    expect(m.t).toBe('plan')
    expect(m.planGen).toBe(1)
    expect(m.segments.map((s) => s.url)).toEqual(['http://app.local/api/files?path=x.pcm', 'http://other/y.pcm'])
  })

  it('sends live overrides and the master gain to the worklet', async () => {
    const r = await rig()
    r.clock.setParams({ a: { mute: true }, b: { gain: 0.5 } })
    expect(r.lastNode()).toEqual({ t: 'params', segments: { a: { mute: true }, b: { gain: 0.5 } } })
    r.clock.setVolume(0.7)
    expect(r.lastNode()).toEqual({ t: 'params', master: 0.7 })
  })

  it('scrub sends a grain request to the Worker, only while paused (§190 T4)', async () => {
    const r = await rig()
    const last = () => r.workerSent[r.workerSent.length - 1].msg
    r.clock.scrub(2.5, -1, 0.08)
    expect(last()).toEqual({ t: 'scrub', time: 2.5, dir: -1, lenS: 0.08 })
    const n = r.workerSent.length
    r.clock.scrub(Number.NaN, 1, 0.08)
    r.clock.scrub(1, 1, 0)
    expect(r.workerSent.length).toBe(n)
    r.clock.play()
    r.clock.scrub(1, 1, 0.08)
    expect(r.workerSent.length).toBe(n)
    r.clock.pause()
    r.clock.scrub(1, 1, 0.08)
    expect(last()).toEqual({ t: 'scrub', time: 1, dir: 1, lenS: 0.08 })
  })

  it('stats carry the report, the Worker stats and the MasterClock fields', async () => {
    const r = await rig()
    r.report({ renderedFrames: 4800, underrunFrames: 12, primingFrames: 300, starving: ['x'], queuedFrames: 24000 })
    r.worker.onmessage?.({ data: { t: 'stats', cacheBytes: 123, resampleMs: 4 } } as MessageEvent)
    const s = r.clock.stats()
    expect(s).toMatchObject({
      kind: 'audio',
      playing: false,
      samplesConsumed: 4800,
      renderedFrames: 4800,
      underrunFrames: 12,
      primingFrames: 300,
      starving: ['x'],
      queuedFrames: 24000,
      queuedSeconds: 0.5,
      latencyS: 0.025,
      sampleRate: 48000,
    })
    expect(s.worker).toMatchObject({ cacheBytes: 123, resampleMs: 4 })
  })

  it('passes Worker errors to onError', async () => {
    const r = await rig()
    r.worker.onmessage?.({ data: { t: 'error', message: 'fetch x: HTTP 404', planGen: 1 } } as MessageEvent)
    expect(r.errors).toEqual(['fetch x: HTTP 404'])
  })
})

describe('dispose', () => {
  it('stops the Worker and the node, once, and freezes the clock', async () => {
    const r = await rig()
    r.clock.play()
    r.setNow(1050)
    r.clock.dispose()
    expect(r.terminated).toBe(true)
    expect(r.disconnected).toBe(true)
    expect(r.workerSent[r.workerSent.length - 1].msg).toEqual({ t: 'dispose' })
    expect(r.lastNode()).toEqual({ t: 'dispose' })
    const n = r.nodeSent.length
    r.clock.dispose()
    r.clock.play()
    r.clock.seek(3)
    expect(r.nodeSent.length).toBe(n)
    r.setNow(5000)
    expect(r.clock.now()).toBeCloseTo(0.05, 9)
  })
})

// Compile-time: MixClock is assignable to MasterClock (the line above in
// 'is a MasterClock' fails `tsc` otherwise).
export type _MixIsMaster = MixClock extends MasterClock ? true : never
