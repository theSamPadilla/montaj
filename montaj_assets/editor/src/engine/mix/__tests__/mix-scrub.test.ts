/**
 * §190 T4: scrub grains from the conformed cache. The Worker renders them
 * (window, direction, every active segment, gaps, cold cache) and the worklet
 * sounds them while paused (live gain and mute, plan fades, no allocation).
 * Both are the shipped strings, run through mix-harness.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearCurrentTime,
  fakeFetch,
  pcmF32,
  processorRig,
  seg,
  workerRig,
  type Msg,
  type WorkerRig,
} from './mix-harness'

const SR = 48000
const URL_A = 'http://h/a.pcm'
const URL_B = 'http://h/b.pcm'

afterEach(() => clearCurrentTime())

/** A ramp file: the left channel is 0.1 * source seconds, the right its negation. */
function ramp(seconds: number, rate = SR) {
  return pcmF32(Math.round(seconds * rate), rate, (t) => 0.1 * t, (t) => -0.1 * t)
}

const hann = (j: number, n: number) => 0.5 * (1 - Math.cos((2 * Math.PI * j) / (n - 1)))

type Grain = Msg & { id: string; ver: number; time: number; frames: number; pcm: Float32Array }
const grains = (rig: WorkerRig) => rig.fromWorker.filter((m) => m.t === 'grain') as Grain[]

async function started(files: Record<string, Uint8Array>, segments: Array<Record<string, unknown>>, opts = {}) {
  const f = fakeFetch(files, opts)
  const rig = workerRig(f.fetch)
  rig.send({ t: 'plan', planGen: 1, segments })
  rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: false })
  await rig.settle()
  return { rig, f }
}

const scrub = (rig: WorkerRig, time: number, dir: 1 | -1 = 1, lenS = 0.08) =>
  rig.send({ t: 'scrub', time, dir, lenS })

describe('Worker: a scrub grain', () => {
  it('is a Hann-windowed read of the source at natural pitch, from the position forwards', async () => {
    const { rig } = await started({ [URL_A]: ramp(4) }, [
      { id: 'A', url: URL_A, format: 'pcm_f32le', tlStart: 1, tlEnd: 3, srcIn: 0.5 },
    ])
    scrub(rig, 1.5)
    await rig.settle()
    const [g] = grains(rig)
    expect(g.id).toBe('A')
    expect(g.ver).toBe(0)
    expect(g.time).toBe(1.5)
    expect(g.frames).toBe(3840)
    expect(g.pcm.length).toBe(3840 * 2)
    // Source at the position is 0.5 + (1.5 - 1) = 1.0 s; sample j is 1.0 + j / SR.
    for (const j of [400, 1920, 3000]) {
      const w = hann(j, 3840)
      expect(g.pcm[j * 2] / w).toBeCloseTo(0.1 * (1 + j / SR), 4)
      expect(g.pcm[j * 2 + 1] / w).toBeCloseTo(-0.1 * (1 + j / SR), 4)
    }
    // Zero at both ends (no click), full level in the middle.
    expect(g.pcm[0]).toBe(0)
    expect(Math.abs(g.pcm[3839 * 2])).toBeLessThan(1e-6)
    expect(g.pcm[1920 * 2]).toBeGreaterThan(0.1 * 1.0 * 0.99)
  })

  it('reads backwards for a reverse scrub: the same window over the source running back from the position', async () => {
    const { rig } = await started({ [URL_A]: ramp(4) }, [
      { id: 'A', url: URL_A, format: 'pcm_f32le', tlStart: 1, tlEnd: 3, srcIn: 0.5 },
    ])
    scrub(rig, 2, -1)
    await rig.settle()
    const [g] = grains(rig)
    expect(g.frames).toBe(3840)
    // Source at 2 is 1.5 s; sample j is 1.5 - j / SR, so the grain falls.
    for (const j of [400, 1920, 3000]) {
      expect(g.pcm[j * 2] / hann(j, 3840)).toBeCloseTo(0.1 * (1.5 - j / SR), 4)
    }
    const early = g.pcm[500 * 2] / hann(500, 3840)
    const late = g.pcm[3000 * 2] / hann(3000, 3840)
    expect(early).toBeGreaterThan(late)
  })

  it('is made for every segment active at the position, lanes included, each tagged with its id', async () => {
    const { rig } = await started({ [URL_A]: ramp(4), [URL_B]: ramp(4) }, [
      { id: 'clip:a', url: URL_A, format: 'pcm_f32le', tlStart: 0, tlEnd: 3 },
      { id: 'lane:m', url: URL_B, format: 'pcm_f32le', tlStart: 1, tlEnd: 2, srcIn: 2 },
      { id: 'clip:b', url: URL_A, format: 'pcm_f32le', tlStart: 3, tlEnd: 5 },
    ])
    scrub(rig, 1.5)
    await rig.settle()
    const got = grains(rig)
    expect(got.map((g) => g.id).sort()).toEqual(['clip:a', 'lane:m'])
    const lane = got.find((g) => g.id === 'lane:m')!
    expect(lane.pcm[1920 * 2] / hann(1920, 3840)).toBeCloseTo(0.1 * (2.5 + 1920 / SR), 4)
    const clip = got.find((g) => g.id === 'clip:a')!
    expect(clip.pcm[1920 * 2] / hann(1920, 3840)).toBeCloseTo(0.1 * (1.5 + 1920 / SR), 4)
  })

  it('is silent over a gap: nothing active, nothing sent', async () => {
    const { rig } = await started({ [URL_A]: ramp(4) }, [
      { id: 'A', url: URL_A, format: 'pcm_f32le', tlStart: 0, tlEnd: 1 },
      { id: 'B', url: URL_A, format: 'pcm_f32le', tlStart: 2, tlEnd: 3 },
    ])
    scrub(rig, 1.5)
    scrub(rig, 5)
    await rig.settle()
    expect(grains(rig)).toEqual([])
  })

  it('is cut to the segment, so it never reads past a cut, and stays windowed to zero at the cut', async () => {
    const { rig } = await started({ [URL_A]: ramp(4) }, [
      { id: 'A', url: URL_A, format: 'pcm_f32le', tlStart: 1, tlEnd: 1.52 },
    ])
    scrub(rig, 1.5) // forwards: 0.02 s left
    scrub(rig, 1.03, -1) // backwards: 0.03 s back to the start
    await rig.settle()
    const [fwd, back] = grains(rig)
    expect(fwd.frames).toBe(960)
    expect(Math.abs(fwd.pcm[959 * 2])).toBeLessThan(1e-6)
    expect(back.frames).toBe(1440)
    expect(Math.abs(back.pcm[1439 * 2])).toBeLessThan(1e-6)
  })

  it('follows the clip speed, and the conformed file\'s own rate', async () => {
    const { rig } = await started({ [URL_A]: ramp(4, 24000) }, [
      { id: 'A', url: URL_A, format: 'pcm_f32le', sampleRate: 24000, tlStart: 0, tlEnd: 2, srcIn: 0.25, speed: 2 },
    ])
    scrub(rig, 0.5)
    await rig.settle()
    const [g] = grains(rig)
    expect(g.frames).toBe(3840)
    // Source at 0.5 is 0.25 + 0.5 * 2 = 1.25 s, read at 2 source seconds per second.
    for (const j of [400, 1920, 3000]) {
      expect(g.pcm[j * 2] / hann(j, 3840)).toBeCloseTo(0.1 * (1.25 + (2 * j) / SR), 3)
    }
  })

  it('waits for a cold block and sounds when it lands; a fourth waiting grain bumps the oldest', async () => {
    const { rig, f } = await started(
      { [URL_A]: ramp(4) },
      [{ id: 'A', url: URL_A, format: 'pcm_f32le', tlStart: 0, tlEnd: 3 }],
      { hold: true },
    )
    for (const t of [1.1, 1.2, 1.3, 1.4]) scrub(rig, t)
    await rig.settle()
    expect(grains(rig)).toEqual([])
    expect(f.log.length).toBeGreaterThan(0)
    f.release()
    await rig.settle()
    expect(grains(rig).map((g) => g.time)).toEqual([1.2, 1.3, 1.4])
  })

  it('is not rendered for a malformed request', async () => {
    const { rig } = await started({ [URL_A]: ramp(4) }, [{ id: 'A', url: URL_A, format: 'pcm_f32le', tlStart: 0, tlEnd: 3 }])
    scrub(rig, Number.NaN)
    scrub(rig, 1, 1, 0)
    await rig.settle()
    expect(grains(rig)).toEqual([])
  })
})

// ── the worklet ─────────────────────────────────────────────────────────────

function constGrain(id: string, frames: number, l: number, over: Record<string, unknown> = {}): Msg {
  const pcm = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) pcm[i * 2] = pcm[i * 2 + 1] = l
  return { t: 'grain', id, ver: 0, time: 1, frames, pcm, ...over }
}

function paused(segs: Array<Record<string, unknown>> = [seg('A')]) {
  const rig = processorRig()
  rig.fromWorker({ t: 'segments', planGen: 1, segs })
  return rig
}

describe('worklet: scrub grains', () => {
  it('sound while the clock is paused, and never move it', () => {
    const rig = paused()
    rig.fromWorker(constGrain('A', 300, 0.5))
    const [L, R] = rig.render(4)
    expect(L[0]).toBeCloseTo(0.5, 6)
    expect(R[299]).toBeCloseTo(0.5, 6)
    expect(L[300]).toBe(0)
    expect(rig.proc.k).toBe(0)
    expect(rig.proc.state).toBe(0)
  })

  it('carry the segment\'s base gain and live gain, as the mix does', () => {
    const rig = paused([seg('A', { gain: 0.5 })])
    rig.send({ t: 'params', segments: { A: { gain: 0.5 } } })
    rig.fromWorker(constGrain('A', 128, 1))
    expect(rig.render(1)[0][10]).toBeCloseTo(0.25, 6)
  })

  it('respect a mute set while paused, and an unmute', () => {
    const rig = paused()
    rig.send({ t: 'params', segments: { A: { mute: true } } })
    rig.fromWorker(constGrain('A', 128, 1))
    expect(Array.from(rig.render(1)[0]).every((v) => v === 0)).toBe(true)
    rig.send({ t: 'params', segments: { A: { mute: false } } })
    rig.fromWorker(constGrain('A', 128, 0.8))
    expect(rig.render(1)[0][10]).toBeCloseTo(0.8, 6)
  })

  it('take the master gain and the plan\'s fades at the grain\'s timeline position', () => {
    const rig = paused([seg('A', { tlStart: 0, tlEnd: 10, fadeIn: 1 })])
    rig.send({ t: 'params', master: 0.5 })
    rig.fromWorker(constGrain('A', 128, 1, { time: 0.5 })) // linear fade-in, half way
    expect(rig.render(1)[0][10]).toBeCloseTo(0.25, 6)
    rig.fromWorker(constGrain('A', 128, 1, { time: 5 })) // past the fade
    expect(rig.render(1)[0][10]).toBeCloseTo(0.5, 6)
  })

  it('sum with each other, and are dropped for a stale version, an unknown id, or a running clock', () => {
    const rig = paused([seg('A'), seg('B', { ver: 2 })])
    rig.fromWorker(constGrain('A', 256, 0.25))
    rig.fromWorker(constGrain('B', 256, 0.5, { ver: 2 }))
    rig.fromWorker(constGrain('B', 256, 0.9, { ver: 1 }))
    rig.fromWorker(constGrain('Z', 256, 0.9))
    expect(rig.render(1)[0][10]).toBeCloseTo(0.75, 6)
    rig.render(2)

    rig.send({ t: 'play', seq: 1 })
    rig.fromWorker(constGrain('A', 256, 1))
    const [L] = rig.render(1) // nothing is queued for A, so the mix is silent; the grain is not heard
    expect(L[100]).toBe(0)
  })

  it('are limited where they sum: several loud grains stay within full scale, smoothly', () => {
    const rig = paused([seg('A'), seg('B', { ver: 2 }), seg('C', { ver: 3 })])
    rig.fromWorker(constGrain('A', 256, 0.9))
    rig.fromWorker(constGrain('B', 256, 0.8, { ver: 2 }))
    rig.fromWorker(constGrain('C', 256, -1, { ver: 3 })) // negative side, too
    rig.fromWorker(constGrain('A', 256, 0.9))
    rig.fromWorker(constGrain('B', 256, 0.8, { ver: 2 }))
    const [L, R] = rig.render(2) // 0.9 + 0.8 + 0.9 + 0.8 - 1 = 2.4 before the limiter
    for (const ch of [L, R]) {
      for (let i = 0; i < 256; i++) expect(Math.abs(ch[i])).toBeLessThanOrEqual(1)
      expect(ch[10]).toBeGreaterThan(0.9) // louder than the knee, not flattened to it
      expect(ch[10]).toBeLessThan(1)
    }
    const neg = paused([seg('A'), seg('B', { ver: 2 })])
    neg.fromWorker(constGrain('A', 128, -0.9))
    neg.fromWorker(constGrain('B', 128, -0.9, { ver: 2 }))
    const v = neg.render(1)[0][10]
    expect(v).toBeLessThan(-0.9)
    expect(v).toBeGreaterThanOrEqual(-1)
  })

  it('leave a single grain at normal level untouched, up to the knee', () => {
    for (const l of [0.01, 0.5, 0.9, -0.9]) {
      const rig = paused()
      rig.fromWorker(constGrain('A', 128, l))
      const [L, R] = rig.render(1)
      expect(Math.abs(L[10] - l)).toBeLessThan(1e-6)
      expect(Math.abs(R[10] - l)).toBeLessThan(1e-6)
    }
  })

  it('allocate nothing while they sound: fixed slots, no typed arrays made in process()', () => {
    const rig = paused()
    const slotsOf = () => (rig.proc as unknown as { grains: unknown[] }).grains
    const before = [...slotsOf()]
    expect(before).toHaveLength(16)
    for (let i = 0; i < 20; i++) rig.fromWorker(constGrain('A', 512, 0.01)) // more than the slots
    expect(slotsOf()).toHaveLength(16)
    expect(slotsOf().every((s, i) => s === before[i])).toBe(true)

    const g = globalThis as unknown as { Float32Array: typeof Float32Array }
    const Real = g.Float32Array
    let made = 0
    g.Float32Array = class extends Real {
      constructor(...args: unknown[]) {
        super(...(args as [number]))
        made++
      }
    } as typeof Float32Array
    try {
      const out = [new Real(128), new Real(128)]
      const proc = rig.proc as unknown as { process(i: unknown[], o: Float32Array[][]): boolean }
      for (let q = 0; q < 8; q++) proc.process([], [out])
    } finally {
      g.Float32Array = Real
    }
    expect(made).toBe(0)
  })
})
