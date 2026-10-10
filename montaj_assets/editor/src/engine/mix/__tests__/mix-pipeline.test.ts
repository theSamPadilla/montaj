/**
 * §190 T2: the three parties together, in jsdom: MixClock (main), the shipped
 * processor string (the audio thread) and the shipped Worker string, joined by
 * the message bus, with an in-memory ranged `fetch` standing in for the
 * conformed files. The audio thread is simulated one 128-frame quantum at a
 * time, and the clocks (`currentTime`, `performance.now`) advance with it.
 *
 * What this proves that the per-module specs cannot: the protocol between
 * them (connect, init, plan, segments, transport, clock, blocks, reports)
 * composes, and two back-to-back segments come out as one continuous signal.
 * The real-browser check of the same thing is
 * montaj_assets/render/test/mix-engine.puppeteer.test.mjs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createMixClock, type MixClock, type MixNodeLike } from '../mix-clock'
import { mixProcessorSource } from '../mix-processor-source'
import {
  Bus,
  QUANTUM,
  clearCurrentTime,
  fakeFetch,
  loadWorkerSource,
  pcmF32,
  portPair,
  setCurrentTime,
  tick,
  type Processor,
} from './mix-harness'

const SR = 48000
const HZ = 440
const W = (2 * Math.PI * HZ) / SR

afterEach(() => clearCurrentTime())

interface Pipeline {
  clock: MixClock
  proc: Processor
  /** Render n quanta, letting messages and fetches through between them. */
  render(quanta: number, onQuantum?: (frame: number) => void): Promise<void>
  out: number[]
  frame(): number
  settle(): Promise<void>
}

async function pipeline(files: Record<string, Uint8Array>): Promise<Pipeline> {
  const bus = new Bus()
  let simMs = 0
  setCurrentTime(0)
  const f = fakeFetch(files)

  // The audio thread.
  const [nodePort, procPort] = portPair(bus)
  let proc: Processor | null = null
  class FakeAudioWorkletProcessor {
    port = procPort
  }
  let cls: (new (o: unknown) => Processor) | null = null
  new Function('AudioWorkletProcessor', 'registerProcessor', 'globalThis', mixProcessorSource)(
    FakeAudioWorkletProcessor,
    (_name: string, c: new (o: unknown) => Processor) => {
      cls = c
    },
    {},
  )

  // The Worker.
  const workerObj = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage(m: unknown) {
      bus.push(() => self.onmessage?.({ data: m }))
    },
    terminate() {},
  }
  const { self } = loadWorkerSource(f.fetch, (m) => workerObj.onmessage?.({ data: m } as MessageEvent), bus)

  const clock = await createMixClock({
    context: { sampleRate: SR, destination: {} as AudioDestinationNode, outputLatency: 0, baseLatency: 0 },
    nowMs: () => simMs,
    loadModule: async () => {},
    createNode: (_ctx, options) => {
      proc = new cls!(options)
      return { port: nodePort, connect() {}, disconnect() {} } as unknown as MixNodeLike
    },
    spawnWorker: () => workerObj,
    createChannel: () => {
      const [a, b] = portPair(bus)
      return { port1: a, port2: b }
    },
    baseUrl: 'http://h/',
  })

  const out: number[] = []
  let frame = 0
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      bus.drain()
      await tick()
      if (bus.size === 0) {
        await tick()
        if (bus.size === 0) return
      }
    }
  }
  return {
    clock,
    proc: proc!,
    out,
    frame: () => frame,
    settle,
    async render(quanta, onQuantum) {
      for (let q = 0; q < quanta; q++) {
        onQuantum?.(frame)
        bus.drain()
        const o = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)]
        proc!.process([], [o])
        for (let i = 0; i < QUANTUM; i++) out.push(o[0][i])
        frame += QUANTUM
        simMs += (QUANTUM / SR) * 1000
        setCurrentTime(frame / SR)
        bus.drain()
        // Let fetches resolve now and then, as a real network would between quanta.
        if (q % 4 === 0) await tick()
      }
    },
  }
}

/** A phase-continuous 440 Hz sine, split across two files at t = 1 s. */
function splitSine() {
  const a = pcmF32(SR, SR, (t) => 0.5 * Math.sin(2 * Math.PI * HZ * t))
  const b = pcmF32(SR * 2, SR, (t) => 0.5 * Math.sin(2 * Math.PI * HZ * (t + 1)))
  return { 'http://h/a.pcm': a, 'http://h/b.pcm': b }
}

const PLAN = {
  segments: [
    { id: 'A', url: '/a.pcm', format: 'pcm_f32le' as const, tlStart: 0, tlEnd: 1 },
    { id: 'B', url: '/b.pcm', format: 'pcm_f32le' as const, tlStart: 1, tlEnd: 2.5 },
  ],
}

/** Largest |x[n] - 2cos(w)x[n-1] + x[n-2]|: 0 for a pure sine, large at any gap, step or slip. */
function sineResidual(x: number[], from: number, to: number): { max: number; at: number } {
  const c = 2 * Math.cos(W)
  let max = 0
  let at = -1
  for (let n = Math.max(from, 2); n < to; n++) {
    const e = Math.abs(x[n] - c * x[n - 1] + x[n - 2])
    if (e > max) {
      max = e
      at = n
    }
  }
  return { max, at }
}

describe('MixClock + processor + Worker', () => {
  it('two back-to-back segments play as one continuous signal, on the clock, with nothing starved', async () => {
    const p = await pipeline(splitSine())
    p.clock.setPlan(PLAN)
    await p.settle() // prefill 1.5 s while paused
    p.clock.play()
    const clockErr: number[] = []
    await p.render(Math.ceil((1.8 * SR) / QUANTUM), (frame) => {
      if (frame > 0) clockErr.push(Math.abs(p.clock.now() - frame / SR))
    })
    // Exactly the source sine, frame for frame, across the cut at frame 48000.
    let maxDev = 0
    for (let n = 240; n < p.out.length; n++) {
      maxDev = Math.max(maxDev, Math.abs(p.out[n] - 0.5 * Math.sin(W * n)))
    }
    expect(maxDev).toBeLessThan(1e-6)
    const boundary = sineResidual(p.out, SR - 2000, SR + 2000)
    expect(boundary.max).toBeLessThan(1e-5)
    // The clock agrees with the frames rendered.
    expect(Math.max(...clockErr)).toBeLessThan(0.003)
    const s = p.clock.stats()
    expect(s.underrunFrames).toBe(0)
    expect(s.primingFrames).toBe(0)
    expect(s.starving).toEqual([])
  })

  it('mute reaches silence within 10 ms of the quantum that receives it', async () => {
    const p = await pipeline(splitSine())
    p.clock.setPlan(PLAN)
    await p.settle()
    p.clock.play()
    let mutedAt = -1
    await p.render(Math.ceil((1.7 * SR) / QUANTUM), (frame) => {
      if (mutedAt < 0 && frame >= 1.5 * SR) {
        p.clock.setParams({ B: { mute: true } })
        mutedAt = frame
      }
    })
    const silentFrom = mutedAt + 480
    expect(Math.max(...p.out.slice(silentFrom).map(Math.abs))).toBe(0)
    // And it ramped, never stepped: no sample-to-sample jump above the sine's own.
    let maxJump = 0
    for (let n = mutedAt; n < silentFrom; n++) maxJump = Math.max(maxJump, Math.abs(p.out[n] - p.out[n - 1]))
    expect(maxJump).toBeLessThan(0.5 * W + 0.5 / 480 + 1e-6)
  })

  it('seek while playing lands on the target in phase, after the fade and the refill', async () => {
    const p = await pipeline(splitSine())
    p.clock.setPlan(PLAN)
    await p.settle()
    p.clock.play()
    await p.render(100)
    const seekFrame = p.frame()
    p.clock.seek(1.5)
    await p.render(200)
    // The new generation starts after the 240-frame fade; its frames are 1.5 s + j / SR.
    const start = seekFrame + 240
    const tail = p.out.length - 2000
    let maxDev = 0
    for (let n = tail; n < p.out.length; n++) {
      maxDev = Math.max(maxDev, Math.abs(p.out[n] - 0.5 * Math.sin(2 * Math.PI * HZ * (1.5 + (n - start) / SR))))
    }
    expect(maxDev).toBeLessThan(1e-6)
    expect(p.clock.now()).toBeCloseTo(1.5 + (p.frame() - start) / SR, 2)
    const s = p.clock.stats()
    expect(s.underrunFrames).toBe(0)
  })

  it('pause and resume continue the same audio without a refetch', async () => {
    const p = await pipeline(splitSine())
    p.clock.setPlan(PLAN)
    await p.settle()
    p.clock.play()
    await p.render(50)
    p.clock.pause()
    await p.render(20)
    const stoppedAt = p.clock.now()
    expect(stoppedAt).toBeCloseTo((50 * QUANTUM + 240) / SR, 6)
    const resumeFrame = p.frame()
    p.clock.play()
    await p.render(20)
    const k0 = 50 * QUANTUM + 240
    for (const j of [240, 1000, 2000]) {
      expect(p.out[resumeFrame + j]).toBeCloseTo(0.5 * Math.sin(W * (k0 + j)), 6)
    }
    expect(p.clock.stats().primingFrames).toBe(0)
  })

  it('a scrub grain sounds while paused, at the mix\'s live gain, and a muted segment stays silent (§190 T4)', async () => {
    const p = await pipeline(splitSine())
    p.clock.setPlan(PLAN)
    await p.settle()
    p.clock.seek(1.2) // B plays here; the clock stays paused
    await p.settle()
    p.clock.scrub(1.2, 1, 0.08)
    await p.settle()
    await p.render(40)
    const peak = Math.max(...p.out.slice(0, 3840).map(Math.abs))
    expect(peak).toBeGreaterThan(0.45) // a 0.5 sine under a Hann window peaks near 0.5
    expect(Math.max(...p.out.slice(3840 + 256).map(Math.abs))).toBe(0)
    expect(p.proc.k).toBe(0)

    p.out.length = 0
    p.clock.setParams({ B: { mute: true } })
    p.clock.scrub(1.2, 1, 0.08)
    await p.settle()
    await p.render(40)
    expect(Math.max(...p.out.map(Math.abs))).toBe(0)
  })
})
