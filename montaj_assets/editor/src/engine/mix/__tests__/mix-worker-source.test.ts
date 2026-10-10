/**
 * §190 T2: the feeder Worker, tested against the shipped string.
 *
 * Two layers. The DSP and cache internals come out through the test hook and
 * are tested as functions: the WSOLA port against time-stretch.ts (identical
 * output), the streaming wrapper against audio-clock.ts's, the resampler on a
 * sine, int16 conversion and the LRU. Then the Worker runs whole: a plan, a
 * transport and clock from a fake worklet port, and an in-memory ranged
 * `fetch`, and the blocks it posts are checked frame by frame against the
 * source they must carry.
 */
import { describe, it, expect } from 'vitest'
import { timeStretch } from '../../time-stretch'
import { createStreamStretch, resampleInterleaved } from '../../audio-clock'
import { placeK } from '../mix-protocol'
import { Bus, fakeFetch, loadWorkerSource, pcmS16, workerRig, type Msg, type WorkerInternals } from './mix-harness'

const SR = 48000

function internals(): WorkerInternals {
  return loadWorkerSource(() => Promise.reject(new Error('no fetch')), () => {}, new Bus()).internals
}

/** Deterministic test signal: two tones and a little LCG noise, stereo interleaved. */
function testSignal(frames: number, channels = 2): Float32Array {
  const out = new Float32Array(frames * channels)
  let seed = 12345
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let i = 0; i < frames; i++) {
    const t = i / SR
    out[i * channels] = 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * noise()
    if (channels > 1) out[i * channels + 1] = 0.4 * Math.sin(2 * Math.PI * 660 * t + 0.3)
  }
  return out
}

describe('WSOLA: the port is identical to time-stretch.ts', () => {
  const w = internals()
  const x = testSignal(24000)
  for (const f of [0.5, 0.8, 1 / 1.1, 1.25, 2, 1, 1 / 3]) {
    it(`factor ${f.toFixed(4)}, stereo`, () => {
      const a = w.timeStretch(x, 2, f)
      const b = timeStretch(x, 2, f)
      expect(a.length).toBe(b.length)
      // Bit for bit, not merely close.
      const ab = new Uint32Array(a.buffer, a.byteOffset, a.length)
      const bb = new Uint32Array(b.buffer, b.byteOffset, b.length)
      expect(ab.every((v, i) => v === bb[i])).toBe(true)
    })
  }
  it('mono, and the same input checks', () => {
    const m = testSignal(9000, 1)
    expect(Array.from(w.timeStretch(m, 1, 0.7))).toEqual(Array.from(timeStretch(m, 1, 0.7)))
    expect(() => w.timeStretch(m, 1, 0)).toThrow(/finite positive/)
    expect(() => w.timeStretch(m, 0, 1)).toThrow(/positive integer/)
    expect(w.timeStretch(new Float32Array(0), 2, 2).length).toBe(0)
  })
})

describe('streaming stretch', () => {
  const w = internals()
  const x = testSignal(48000)

  it('without drift correction, emits exactly what audio-clock.ts createStreamStretch emits', () => {
    for (const f of [0.5, 1 / 1.1, 1.5]) {
      const ours = w.createStreamStretch(2, f, false)
      const theirs = createStreamStretch(2, f)
      for (let off = 0; off < 48000; off += 960) {
        const chunk = x.slice(off * 2, (off + 960) * 2)
        const a = ours.push(chunk)
        const b = theirs.push(chunk.slice())
        expect(Array.from(a)).toEqual(Array.from(b))
      }
    }
  })

  it('with drift correction, the cumulative output never leaves the ideal length', () => {
    for (const f of [1 / 1.1, 1 / 0.9, 0.37, 2.3]) {
      const s = w.createStreamStretch(2, f, true)
      let inFrames = 0
      let outFrames = 0
      for (let i = 0; i < 300; i++) {
        const chunk = testSignal(2048)
        inFrames += 2048
        outFrames += s.push(chunk).length / 2
        const blocks = Math.floor(inFrames / 2048)
        expect(outFrames).toBe(Math.round((blocks * 2048 - 1024) * f))
      }
    }
  })

  it('the uncorrected wrapper does drift, which is why the correction exists', () => {
    const f = 1 / 1.1
    const s = w.createStreamStretch(2, f, false)
    let outFrames = 0
    for (let i = 0; i < 300; i++) outFrames += s.push(testSignal(2048)).length / 2
    expect(Math.abs(outFrames - Math.round((300 * 2048 - 1024) * f))).toBeGreaterThan(10)
  })
})

describe('resampler (4-point Lagrange)', () => {
  const w = internals()

  function sine(frames: number, hz: number, rate: number): Float32Array {
    const out = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i++) out[i * 2] = out[i * 2 + 1] = 0.8 * Math.sin((2 * Math.PI * hz * i) / rate)
    return out
  }

  it('resamples a 1 kHz sine 48 kHz -> 44.1 kHz within 2e-5 of the true waveform, far better than linear', () => {
    const ratio = 48000 / 44100
    const input = sine(48000, 1000, 48000)
    const rs = w.createResampler(ratio)
    rs.push(input)
    const out = new Float32Array(44000 * 2)
    const got = rs.pull(out, 0, 44000)
    expect(got).toBe(44000)
    let maxErr = 0
    for (let j = 3; j < got; j++) {
      const want = 0.8 * Math.sin((2 * Math.PI * 1000 * j * ratio) / 48000)
      maxErr = Math.max(maxErr, Math.abs(out[j * 2] - want), Math.abs(out[j * 2 + 1] - want))
    }
    const lin = resampleInterleaved(input, 2, ratio, 0).pcm
    let linErr = 0
    for (let j = 3; j < 44000; j++) {
      const want = 0.8 * Math.sin((2 * Math.PI * 1000 * j * ratio) / 48000)
      linErr = Math.max(linErr, Math.abs(lin[j * 2] - want))
    }
    console.log(`[mix resampler] 1 kHz sine 48k->44.1k: cubic max error ${maxErr.toExponential(2)}, linear ${linErr.toExponential(2)}`)
    expect(maxErr).toBeLessThan(2e-5)
    expect(linErr / maxErr).toBeGreaterThan(50)
  })

  it('upsamples 44.1 kHz -> 48 kHz as accurately', () => {
    const ratio = 44100 / 48000
    const rs = w.createResampler(ratio)
    rs.push(sine(44100, 1000, 44100))
    const out = new Float32Array(47000 * 2)
    const got = rs.pull(out, 0, 47000)
    let maxErr = 0
    // From output 3 on: before it, the stream start's assumed history frame is in the kernel.
    for (let j = 3; j < got; j++) {
      maxErr = Math.max(maxErr, Math.abs(out[j * 2] - 0.8 * Math.sin((2 * Math.PI * 1000 * j * ratio) / 44100)))
    }
    expect(maxErr).toBeLessThan(2e-5)
    // The edge itself is small.
    expect(Math.abs(out[2] - 0.8 * Math.sin((2 * Math.PI * 1000 * ratio) / 44100))).toBeLessThan(2e-3)
  })

  it('streams: uneven pushes and pulls give the same samples as one pass', () => {
    const ratio = 48000 / 44100
    const input = sine(20000, 1234, 48000)
    const one = w.createResampler(ratio)
    one.push(input)
    const ref = new Float32Array(18000 * 2)
    const n1 = one.pull(ref, 0, 18000)

    const s = w.createResampler(ratio)
    const out = new Float32Array(18000 * 2)
    let got = 0
    let at = 0
    const sizes = [1, 7, 333, 2048, 5, 4000]
    for (let i = 0; at < 20000; i++) {
      const n = Math.min(sizes[i % sizes.length], 20000 - at)
      s.push(input.slice(at * 2, (at + n) * 2))
      at += n
      got += s.pull(out, got, Math.min(17 + (i % 50), 18000 - got))
    }
    got += s.pull(out, got, 18000 - got)
    expect(got).toBe(n1)
    expect(Array.from(out.subarray(0, got * 2))).toEqual(Array.from(ref.subarray(0, n1 * 2)))
  })

  it('CPU: costs a small fraction of real time (measured, logged)', () => {
    const ratio = 48000 / 44100
    const seconds = 10
    const input = sine(48000 * seconds, 440, 48000)
    const rs = w.createResampler(ratio)
    const out = new Float32Array(4096 * 2)
    let produced = 0
    const t0 = performance.now()
    for (let at = 0; at < input.length / 2; at += 12000) {
      rs.push(input.subarray(at * 2, (at + 12000) * 2))
      let n
      while ((n = rs.pull(out, 0, 4096)) > 0) produced += n
    }
    const ms = performance.now() - t0
    // It really did the work: one output frame per 48000/44100 input frames.
    expect(Math.abs(produced - 44100 * seconds)).toBeLessThan(4)
    console.log(`[mix resampler] ${seconds} s stereo 48k->44.1k in ${ms.toFixed(1)} ms = ${((ms / (seconds * 1000)) * 100).toFixed(3)}% of real time`)
    expect(ms).toBeLessThan(seconds * 1000 * 0.25)
  })
})

describe('int16 conversion', () => {
  const w = internals()
  it('maps int16 full scale to [-1, 1) by /32768', () => {
    const buf = new Int16Array([32767, -32768, 0, 16384, -1, 1]).buffer
    expect(Array.from(w.convertPcm(buf, 'pcm_s16le', 2))).toEqual([32767 / 32768, -1, 0, 0.5, -1 / 32768, 1 / 32768])
  })
  it('duplicates mono into both channels', () => {
    const buf = new Int16Array([16384, -16384]).buffer
    expect(Array.from(w.convertPcm(buf, 'pcm_s16le', 1))).toEqual([0.5, 0.5, -0.5, -0.5])
  })
  it('passes float32 through, and keeps the first two of more channels', () => {
    const buf = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]).buffer
    expect(Array.from(w.convertPcm(buf, 'pcm_f32le', 3))).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.4), Math.fround(0.5)])
  })
  it('ignores a trailing partial frame', () => {
    const buf = new Uint8Array([0, 64, 0, 64, 0, 64]).buffer // 1.5 stereo frames
    expect(Array.from(w.convertPcm(buf, 'pcm_s16le', 2))).toEqual([0.5, 0.5])
  })
})

describe('LRU block cache', () => {
  const w = internals()
  it('evicts the least recently used past the cap; a read refreshes', () => {
    const c = w.createLru(300)
    c.set('a', { bytes: 100 })
    c.set('b', { bytes: 100 })
    c.set('c', { bytes: 100 })
    expect(c.bytes()).toBe(300)
    c.set('d', { bytes: 100 })
    expect(c.keys()).toEqual(['b', 'c', 'd'])
    c.get('b')
    c.set('e', { bytes: 100 })
    expect(c.keys()).toEqual(['d', 'b', 'e'])
    expect(c.evictions()).toBe(2)
    expect(c.bytes()).toBe(300)
  })
  it('replacing a key re-counts its bytes; an entry over the cap is kept alone', () => {
    const c = w.createLru(300)
    c.set('a', { bytes: 100 })
    c.set('a', { bytes: 250 })
    expect(c.bytes()).toBe(250)
    c.set('big', { bytes: 1000 })
    expect(c.keys()).toEqual(['big'])
    expect(c.bytes()).toBe(1000)
  })
  it('the Worker caps its cache at what init says', async () => {
    const file = pcmS16(SR * 4, SR, (t) => Math.sin(t))
    const f = fakeFetch({ 'http://h/a.pcm': file })
    // 2 blocks' worth of float32 stereo: 12000 frames * 8 bytes = 96000 (+64) each.
    const rig = workerRig(f.fetch, { cacheBytes: 200_000 })
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: 'http://h/a.pcm', tlStart: 0, tlEnd: 4 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const st = rig.internals.state()
    expect(st.cache.bytes()).toBeLessThanOrEqual(200_000)
    // And a cache that small still fills the horizon: prefetch never outruns it.
    expect(blocks(rig).reduce((n, b) => n + b.frames, 0)).toBe(72000)
  })
})

// ── The Worker as a whole ───────────────────────────────────────────────────

/** A file whose every frame encodes its own index: idx = (L + 1) * 32768 + 65536 * (R + 1) * 32768 / 32768. */
function indexFile(frames: number): Uint8Array {
  const out = new Int16Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    out[i * 2] = (i % 65536) - 32768
    out[i * 2 + 1] = Math.floor(i / 65536) - 32768
  }
  return new Uint8Array(out.buffer)
}
function frameIndex(pcm: Float32Array, j: number): number {
  const l = Math.round(pcm[j * 2] * 32768) + 32768
  const r = Math.round(pcm[j * 2 + 1] * 32768) + 32768
  return l + 65536 * r
}

const URL_A = 'http://h/a.pcm'

function blocks(rig: { fromWorker: Msg[] }, id?: string) {
  return rig.fromWorker.filter((m) => m.t === 'block' && (id === undefined || m.id === id)) as Array<
    Msg & { gen: number; id: string; ver: number; k0: number; frames: number; pcm: Float32Array }
  >
}

describe('the Worker feeds the worklet', () => {
  it('sends the mix parameters, then blocks placed by the worklet expression, carrying the right source frames', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4) })
    const rig = workerRig(f.fetch)
    rig.send({
      t: 'plan',
      planGen: 1,
      segments: [{ id: 'A', url: URL_A, tlStart: 1, tlEnd: 2.5, srcIn: 0.5, gain: 0.8, fadeIn: 0.1, curve: 'linear' }],
    })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: false })
    await rig.settle()
    // Paused, the lead is 0.5 s: A starts at 1 s, past it.
    expect(blocks(rig)).toHaveLength(0)
    rig.fromWorklet({ t: 'clock', gen: 0, k: 0, playing: true })
    await rig.settle()

    const segs = rig.fromWorker.find((m) => m.t === 'segments') as Msg & { segs: Array<Record<string, unknown>> }
    expect(segs.planGen).toBe(1)
    expect(segs.segs).toEqual([
      {
        id: 'A', ver: 0, tlStart: 1, tlEnd: 2.5, gain: 0.8, fadeIn: 0.1, fadeOut: 0, curveIn: 'linear', curveOut: 'linear',
        stage: 0, duck: null,
      },
    ])

    // A spans k [48000, 120000); the horizon is 1.5 s = 72000 frames.
    let bs = blocks(rig)
    expect(bs[0].k0).toBe(placeK(1, 0, 1, SR))
    expect(bs[0].k0).toBe(48000)
    for (let i = 1; i < bs.length; i++) expect(bs[i].k0).toBe(bs[i - 1].k0 + bs[i - 1].frames)
    expect(bs[bs.length - 1].k0 + bs[bs.length - 1].frames).toBe(72000)
    expect(bs.every((b) => b.gen === 0 && b.ver === 0 && b.frames <= 12000)).toBe(true)
    // k -> source frame (0.5 + (k / SR - 1)) * SR = k - 24000.
    for (const b of bs) for (const j of [0, 1, 5000, b.frames - 1]) expect(frameIndex(b.pcm, j)).toBe(b.k0 + j - 24000)
    // Source blocks of 0.25 s = 12000 frames = 48000 bytes, by Range.
    expect(f.log[0]).toEqual({ url: URL_A, range: 'bytes=96000-143999' })

    // The clock moves: the lead is topped up, contiguously.
    rig.fromWorklet({ t: 'clock', gen: 0, k: 30000, playing: true })
    await rig.settle()
    bs = blocks(rig)
    for (let i = 1; i < bs.length; i++) expect(bs[i].k0).toBe(bs[i - 1].k0 + bs[i - 1].frames)
    const end = bs[bs.length - 1].k0 + bs[bs.length - 1].frames
    expect(end).toBe(30000 + 72000)

    // Near the end the segment is filled exactly to its tlEnd.
    rig.fromWorklet({ t: 'clock', gen: 0, k: 100000, playing: true })
    await rig.settle()
    bs = blocks(rig)
    const last = bs[bs.length - 1]
    expect(last.k0 + last.frames).toBe(120000)
    for (const b of bs) for (const j of [0, b.frames - 1]) expect(frameIndex(b.pcm, j)).toBe(b.k0 + j - 24000)
  })

  it('fetches PCM with cache: no-store, so Chromium\'s HTTP cache never holds it', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4) })
    const inits: Array<{ cache?: string }> = []
    const rig = workerRig((url: string, init: { headers?: Record<string, string>; cache?: string }) => {
      inits.push(init)
      return f.fetch(url, init)
    })
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 3, gain: 1 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: false })
    await rig.settle()
    expect(inits.length).toBeGreaterThan(0)
    expect(inits.every((i) => i.cache === 'no-store')).toBe(true)
  })

  it('paused, a stream fills 0.5 s ahead (a drag is a stream of seeks); on play it tops up to 1.5 s', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4) })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 3, gain: 1 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: false })
    await rig.settle()
    let bs = blocks(rig)
    expect(bs[bs.length - 1].k0 + bs[bs.length - 1].frames).toBe(24000)

    rig.fromWorklet({ t: 'clock', gen: 0, k: 0, playing: true })
    await rig.settle()
    bs = blocks(rig)
    expect(bs[bs.length - 1].k0 + bs[bs.length - 1].frames).toBe(72000)
    for (let i = 1; i < bs.length; i++) expect(bs[i].k0).toBe(bs[i - 1].k0 + bs[i - 1].frames)
  })

  it('a new generation drops the old streams and refills from the new position; the cache spares refetches', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4) })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 1, tlEnd: 2.5, srcIn: 0.5 }] })
    // Playing, so the first fill is the full 1.5 s lead (paused it is 0.5 s).
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const fetchesBefore = f.log.length

    // Seek to timeline 1.6: A is active at k 0, at source frame (0.5 + 0.6) * SR = 52800.
    rig.fromWorklet({ t: 'transport', gen: 1, anchorTime: 1.6, rate: 1, k: 0, playing: true })
    await rig.settle()
    const g1 = blocks(rig).filter((b) => b.gen === 1)
    expect(g1[0].k0).toBe(0)
    expect(frameIndex(g1[0].pcm, 0)).toBe(52800)
    expect(g1.reduce((n, b) => n + b.frames, 0)).toBe(placeK(2.5, 1.6, 1, SR))
    // Source frames 24000..72000 were cached by the first fill: only blocks past them are fetched.
    const ranges = f.log.slice(fetchesBefore).map((l) => l.range)
    expect(ranges).not.toContain('bytes=96000-143999')
    expect(ranges).not.toContain('bytes=192000-239999')
  })

  it('a gain edit keeps the version and the stream; a source edit bumps the version and refills', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4) })
    const rig = workerRig(f.fetch)
    const base = { id: 'A', url: URL_A, tlStart: 0, tlEnd: 3, srcIn: 0 }
    rig.send({ t: 'plan', planGen: 1, segments: [base] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const n0 = blocks(rig).length

    rig.send({ t: 'plan', planGen: 2, segments: [{ ...base, gain: 0.3 }] })
    await rig.settle()
    let segMsgs = rig.fromWorker.filter((m) => m.t === 'segments') as Array<Msg & { segs: Array<{ ver: number; gain: number }> }>
    expect(segMsgs[segMsgs.length - 1].segs[0]).toMatchObject({ ver: 0, gain: 0.3 })
    expect(blocks(rig).length).toBe(n0)

    rig.send({ t: 'plan', planGen: 3, segments: [{ ...base, srcIn: 1 }] })
    await rig.settle()
    segMsgs = rig.fromWorker.filter((m) => m.t === 'segments') as typeof segMsgs
    expect(segMsgs[segMsgs.length - 1].segs[0].ver).toBe(1)
    const v1 = blocks(rig).filter((b) => b.ver === 1)
    expect(v1[0].k0).toBe(0)
    expect(frameIndex(v1[0].pcm, 0)).toBe(48000)
  })

  it('forwards stage and ducking to the worklet; changing either keeps the version and the stream (§190 T3)', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4) })
    const rig = workerRig(f.fetch)
    const base = { id: 'A', url: URL_A, tlStart: 0, tlEnd: 3, srcIn: 0 }
    rig.send({ t: 'plan', planGen: 1, segments: [base] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const n0 = blocks(rig).length

    const duck = { threshold: 0.02, ratio: 4, attackMs: 300, releaseMs: 500 }
    rig.send({ t: 'plan', planGen: 2, segments: [{ ...base, stage: 3, duck }] })
    await rig.settle()
    const segMsgs = rig.fromWorker.filter((m) => m.t === 'segments') as Array<Msg & { segs: Array<Record<string, unknown>> }>
    expect(segMsgs[0].segs[0]).toMatchObject({ stage: 0, duck: null })
    expect(segMsgs[segMsgs.length - 1].segs[0]).toMatchObject({ ver: 0, stage: 3, duck })
    expect(blocks(rig).length).toBe(n0)
  })

  it('stretches at speed x rate != 1 with the pitch kept, and fills exactly its span', async () => {
    const tone = pcmS16(SR * 6, SR, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t))
    const f = fakeFetch({ [URL_A]: tone })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 1, speed: 2 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const bs = blocks(rig)
    const total = bs.reduce((n, b) => n + b.frames, 0)
    expect(total).toBe(48000)
    const st = rig.internals.state().stats
    expect(st.stretchedFrames).toBeGreaterThan(0)
    // Pitch: a stretched 440 Hz tone stays at ~440 Hz (a resample would give 880).
    const pcm = new Float32Array(total)
    let at = 0
    for (const b of bs) for (let j = 0; j < b.frames; j++) pcm[at++] = b.pcm[j * 2]
    let crossings = 0
    for (let i = 4801; i < 43200; i++) if (pcm[i - 1] <= 0 && pcm[i] > 0) crossings++
    const hz = crossings / ((43200 - 4801) / SR)
    expect(hz).toBeGreaterThan(420)
    expect(hz).toBeLessThan(460)
  })

  it('resamples to the context rate', async () => {
    const tone = pcmS16(SR * 3, SR, (t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t))
    const f = fakeFetch({ [URL_A]: tone })
    const rig = workerRig(f.fetch, { sampleRate: 44100 })
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 2 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const bs = blocks(rig)
    expect(bs.reduce((n, b) => n + b.frames, 0)).toBe(Math.round(1.5 * 44100))
    let maxErr = 0
    let k = 0
    for (const b of bs) {
      for (let j = 0; j < b.frames; j++, k++) {
        if (k < 3) continue
        maxErr = Math.max(maxErr, Math.abs(b.pcm[j * 2] - 0.5 * Math.sin((2 * Math.PI * 1000 * k) / 44100)))
      }
    }
    // int16 quantization (1.5e-5) plus the interpolation error.
    expect(maxErr).toBeLessThan(1e-4)
    expect(rig.internals.state().stats.resampledFrames).toBeGreaterThan(0)
  })

  it('a segment that starts mid-file reads the real frame before it into the resampler', async () => {
    const SRC = 44100
    const tone = pcmS16(SRC * 3, SRC, (t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t))
    const f = fakeFetch({ [URL_A]: tone })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, sampleRate: SRC, tlStart: 0, tlEnd: 1, srcIn: 1 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const ratio = SRC / SR
    const first = blocks(rig)[0]
    // Output j reads source frame SRC + j * ratio. No frame is assumed: the error
    // is the interpolation's plus int16 quantization (1.5e-5).
    for (let j = 0; j < 4; j++) {
      const want = 0.5 * Math.sin((2 * Math.PI * 1000 * (SRC + j * ratio)) / SRC)
      expect(Math.abs(first.pcm[j * 2] - want), `output ${j}`).toBeLessThan(1e-4)
    }
  })

  it('at file frame 0 the frame before the start still equals the first', async () => {
    const SRC = 44100
    const tone = pcmS16(SRC * 3, SRC, (t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t))
    const f = fakeFetch({ [URL_A]: tone })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, sampleRate: SRC, tlStart: 0, tlEnd: 1 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const first = blocks(rig)[0]
    const want = 0.5 * Math.sin((2 * Math.PI * 1000 * (SRC / SR)) / SRC)
    // The edge: small, but not the interpolation's accuracy.
    expect(Math.abs(first.pcm[2] - want)).toBeLessThan(2e-3)
  })

  it('plays backwards at a negative rate', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4) })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 3 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 2, rate: -1, k: 0, playing: true })
    await rig.settle()
    const bs = blocks(rig)
    expect(bs[0].k0).toBe(0)
    expect(bs.reduce((n, b) => n + b.frames, 0)).toBe(72000)
    for (const b of bs) {
      for (const j of [0, 1, 777, b.frames - 1]) {
        if (j < b.frames) expect(frameIndex(b.pcm, j)).toBe(96000 - (b.k0 + j))
      }
    }
  })

  it('reads a server that ignores Range, and learns the file end from a short block', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(30000) }, { ignoreRange: true })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 1 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const bs = blocks(rig)
    expect(bs.reduce((n, b) => n + b.frames, 0)).toBe(48000)
    const all = new Float32Array(48000 * 2)
    for (const b of bs) all.set(b.pcm, b.k0 * 2)
    expect(frameIndex(all, 12345)).toBe(12345)
    expect(frameIndex(all, 29999)).toBe(29999)
    // Past the file: silence, and nothing is fetched beyond it.
    expect(all[30000 * 2]).toBe(0)
    expect(all[47999 * 2 + 1]).toBe(0)
    expect(rig.internals.state().knownFrames.get(URL_A)).toBe(30000)
    const fetched = f.log.length
    rig.fromWorklet({ t: 'clock', gen: 0, k: 20000, playing: true })
    await rig.settle()
    expect(f.log.length).toBe(fetched)
  })

  it('a failed fetch is reported to main and retried; that segment starves, nothing else is posted for it', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR) }, { failUrls: new Set([URL_A]) })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 7, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 1 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    const errs = rig.toMain.filter((m) => m.t === 'error')
    expect(errs.length).toBeGreaterThan(0)
    expect(errs[0]).toMatchObject({ planGen: 7 })
    expect(String(errs[0].message)).toContain(URL_A)
    expect(blocks(rig)).toEqual([])
    rig.send({ t: 'dispose' }) // stop the retry timer
    await rig.settle()
  })

  it('main only ever hears stats and errors: no PCM crosses the main thread', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 2) })
    const rig = workerRig(f.fetch)
    rig.send({ t: 'plan', planGen: 1, segments: [{ id: 'A', url: URL_A, tlStart: 0, tlEnd: 2 }] })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    rig.send({ t: 'stats' })
    await rig.settle()
    expect(rig.toMain.length).toBeGreaterThan(0)
    expect(rig.toMain.every((m) => m.t === 'stats' || m.t === 'error')).toBe(true)
    const st = rig.toMain.find((m) => m.t === 'stats')!
    expect(st).toMatchObject({ t: 'stats' })
    expect(blocks(rig).length).toBeGreaterThan(0)
  })

  it('fills an upcoming segment before it starts, so a cut needs no lead-in', async () => {
    const f = fakeFetch({ [URL_A]: indexFile(SR * 4), 'http://h/b.pcm': indexFile(SR * 4) })
    const rig = workerRig(f.fetch)
    rig.send({
      t: 'plan',
      planGen: 1,
      segments: [
        { id: 'A', url: URL_A, tlStart: 0, tlEnd: 1 },
        { id: 'B', url: 'http://h/b.pcm', tlStart: 1, tlEnd: 3, srcIn: 2 },
      ],
    })
    rig.fromWorklet({ t: 'transport', gen: 0, anchorTime: 0, rate: 1, k: 0, playing: true })
    await rig.settle()
    // At k = 0, B (starting at 48000) is inside the 1.5 s horizon: fed from its first frame.
    const b = blocks(rig, 'B')
    expect(b[0].k0).toBe(48000)
    expect(frameIndex(b[0].pcm, 0)).toBe(96000)
    const a = blocks(rig, 'A')
    expect(a[a.length - 1].k0 + a[a.length - 1].frames).toBe(48000)
  })
})
