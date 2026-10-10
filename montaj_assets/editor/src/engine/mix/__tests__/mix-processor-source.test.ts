/**
 * §190 T2: the mix processor's rules, tested against the shipped string.
 *
 * The string runs under `new Function` with a fake `AudioWorkletProcessor`,
 * fake ports and a driven `currentTime` (mix-harness.ts). These are the rules
 * that live ONLY in the string: the mix, the gain smoothing, the fade curves,
 * starvation, the transport fades and the clock.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { exportFadeGain, placeK, timelineTimeAt } from '../mix-protocol'
import {
  MIX_PROCESSOR_NAME,
  QUANTUM,
  clearCurrentTime,
  constBlock,
  processorRig,
  seg,
  type Msg,
  type ProcessorRig,
} from './mix-harness'

const SR = 48000
const FADE = 240 // 5 ms at 48 kHz
const SMOOTH = 480 // 10 ms at 48 kHz

afterEach(() => clearCurrentTime())

function lastReport(rig: ProcessorRig): Msg {
  const r = rig.reports()
  return r[r.length - 1]
}

function play(rig: ProcessorRig, seq = 1) {
  rig.send({ t: 'play', seq })
}

/** Transport fade-in gain at frame i after play (0-based). */
const fadeIn = (i: number) => Math.min(1, (i + 1) / FADE)

describe('registration', () => {
  it('registers the name MixClock builds its node with, once per scope', () => {
    const scope: Record<string, unknown> = {}
    expect(processorRig({}, scope).registeredAs).toBe(MIX_PROCESSOR_NAME)
    expect(MIX_PROCESSOR_NAME).toBe('montaj-mix')
    // A second addModule on the shared context must not register twice.
    expect(processorRig({}, scope).registeredAs).toBe(null)
  })
})

describe('mixing', () => {
  it('sums two overlapping segments, each from its own blocks', () => {
    const rig = processorRig()
    rig.fromWorker({
      t: 'segments',
      planGen: 1,
      segs: [seg('A', { tlStart: 0, tlEnd: 1 }), seg('B', { tlStart: 1024 / SR, tlEnd: 1 })],
    })
    rig.fromWorker(constBlock('A', 0, 0, 0, 2048, 0.25, -0.25))
    rig.fromWorker(constBlock('B', 0, 0, 1024, 1024, 0.5, 0.5))
    play(rig)
    const [L, R] = rig.render(16)
    for (const i of [0, 100, 239]) expect(L[i]).toBeCloseTo(0.25 * fadeIn(i), 6)
    for (const i of [240, 600, 1023]) {
      expect(L[i]).toBeCloseTo(0.25, 6)
      expect(R[i]).toBeCloseTo(-0.25, 6)
    }
    for (const i of [1024, 1500, 2047]) {
      expect(L[i]).toBeCloseTo(0.75, 6)
      expect(R[i]).toBeCloseTo(0.25, 6)
    }
    expect(lastReport(rig).underrunFrames).toBe(0)
  })

  it('places a segment by its timeline span and stops it at tlEnd', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A', { tlStart: 0, tlEnd: 1000 / SR })] })
    rig.fromWorker(constBlock('A', 0, 0, 0, 2048, 0.5))
    play(rig)
    const [L] = rig.render(16)
    expect(L[999]).toBeCloseTo(0.5, 6)
    expect(L[1000]).toBe(0)
    // Past its end a segment is not starving: there is nothing it owes.
    expect(lastReport(rig).underrunFrames).toBe(0)
  })

  it('drops blocks of another generation or another segment version', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A', { ver: 3 })] })
    rig.fromWorker(constBlock('A', 5, 3, 0, 1024, 0.5)) // wrong gen
    rig.fromWorker(constBlock('A', 0, 2, 0, 1024, 0.5)) // stale version
    play(rig)
    const [L] = rig.render(4)
    expect(Array.from(L).every((v) => v === 0)).toBe(true)
  })

  it('a version bump empties what was queued for the segment', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    rig.fromWorker(constBlock('A', 0, 0, 0, 4096, 0.5))
    rig.fromWorker({ t: 'segments', planGen: 2, segs: [seg('A', { ver: 1 })] })
    play(rig)
    const [L] = rig.render(4)
    expect(Array.from(L).every((v) => v === 0)).toBe(true)
  })
})

describe('gain smoothing', () => {
  function steady(): ProcessorRig {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    rig.fromWorker(constBlock('A', 0, 0, 0, 48000, 1))
    play(rig)
    rig.render(4) // past the transport fade
    return rig
  }

  it('ramps a gain change linearly over 10 ms', () => {
    const rig = steady()
    rig.send({ t: 'params', segments: { A: { gain: 0.5 } } })
    const [L] = rig.render(8)
    expect(L[0]).toBeCloseTo(1 - 0.5 / SMOOTH, 6)
    expect(L[239]).toBeCloseTo(1 - (0.5 * 240) / SMOOTH, 6)
    expect(L[SMOOTH - 1]).toBeCloseTo(0.5, 6)
    expect(L[SMOOTH + 100]).toBeCloseTo(0.5, 6)
    // No step anywhere: adjacent samples differ by one ramp step at most.
    let maxStep = 0
    for (let i = 1; i < L.length; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]))
    expect(maxStep).toBeLessThanOrEqual(0.5 / SMOOTH + 1e-6)
  })

  it('mutes within 10 ms without a click, and unmutes to the override gain', () => {
    const rig = steady()
    rig.send({ t: 'params', segments: { A: { gain: 0.5 } } })
    rig.render(8)
    rig.send({ t: 'params', segments: { A: { mute: true } } })
    let [L] = rig.render(4)
    expect(L[0]).toBeCloseTo(0.5 - 0.5 / SMOOTH, 6)
    expect(L[SMOOTH - 1]).toBe(0)
    expect(L[SMOOTH]).toBe(0)
    rig.send({ t: 'params', segments: { A: { mute: false } } })
    ;[L] = rig.render(4)
    expect(L[SMOOTH - 1]).toBeCloseTo(0.5, 6)
  })

  it('multiplies the override onto the base gain, and keeps overrides across plan changes', () => {
    const rig = processorRig()
    rig.send({ t: 'params', segments: { A: { gain: 0.5 } } }) // before the segment exists
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A', { gain: 1.5 })] })
    rig.fromWorker(constBlock('A', 0, 0, 0, 8192, 1))
    play(rig)
    let [L] = rig.render(4)
    expect(L[300]).toBeCloseTo(0.75, 6)
    rig.fromWorker({ t: 'segments', planGen: 2, segs: [seg('A', { gain: 2 })] })
    ;[L] = rig.render(8)
    expect(L[SMOOTH + 10]).toBeCloseTo(1, 6)
  })

  it('smooths the master gain too', () => {
    const rig = steady()
    rig.send({ t: 'params', master: 0 })
    const [L] = rig.render(4)
    expect(L[0]).toBeCloseTo(1 - 1 / SMOOTH, 6)
    expect(L[SMOOTH - 1]).toBe(0)
  })
})

/**
 * Captured from the export's own ffmpeg (montaj-app desktop/vendor/ffmpeg,
 * "ffmpeg version 8.1.2", 2026-10-09):
 *   ffmpeg -f lavfi -i aevalsrc=1:s=48000:d=0.2 \
 *     -af afade=t=in:st=0:d=0.1:curve=<tri|exp|log> -f f32le -c:a pcm_f32le -
 * Sample index -> gain. The fade-out (afade=t=out:st=0.1:d=0.1) is the exact
 * mirror: out[4800 + i] === in[4800 - i], also captured.
 */
const FFMPEG_FADE_IN: Record<'linear' | 'exp' | 'log', Array<[number, number]>> = {
  linear: [
    [0, 0], [1, 0.00020833333837799728], [48, 0.009999999776482582], [480, 0.10000000149011612],
    [1200, 0.25], [2400, 0.5], [3600, 0.75], [4320, 0.8999999761581421], [4799, 0.99979168176651], [4800, 1],
  ],
  exp: [
    [0, 9.999999747378752e-6], [1, 1.0024014045484364e-5], [48, 1.1220184205740225e-5],
    [480, 3.162277789670043e-5], [1200, 0.00017782794020604342], [2400, 0.003162277629598975],
    [3600, 0.05623413249850273], [4320, 0.3162277638912201], [4799, 0.9976043701171875], [4800, 1],
  ],
  log: [
    [0, 0], [1, 0.263751745223999], [48, 0.6000000238418579], [480, 0.800000011920929],
    [1200, 0.8795880079269409], [2400, 0.9397940039634705], [3600, 0.9750122427940369],
    [4320, 0.9908484816551208], [4799, 0.9999818801879883], [4800, 1],
  ],
}

const closeTo = (got: number, want: number) => Math.abs(got - want) <= 1e-7 + 2e-6 * Math.abs(want)

describe('fade curves match the export (ffmpeg afade)', () => {
  for (const curve of ['linear', 'exp', 'log'] as const) {
    it(`${curve}: fade-in and fade-out at sample points`, () => {
      // Starts after the transport fade, so the bus is at unity: tl 0.01 = k 480.
      const START = 480
      const rig = processorRig()
      rig.fromWorker({
        t: 'segments',
        planGen: 1,
        segs: [
          seg('F', {
            tlStart: START / SR,
            tlEnd: START / SR + 0.2,
            fadeIn: 0.1,
            fadeOut: 0.1,
            curveIn: curve,
            curveOut: curve,
          }),
        ],
      })
      rig.fromWorker(constBlock('F', 0, 0, START, 9600, 1))
      play(rig)
      const [L] = rig.render(80)
      for (const [i, want] of FFMPEG_FADE_IN[curve]) {
        expect(closeTo(L[START + i], want), `in[${i}] = ${L[START + i]}, ffmpeg ${want}`).toBe(true)
        // Fade-out sample 4800 + j mirrors fade-in sample 4800 - j.
        const j = 4800 - i
        if (j > 0 && j < 4800) {
          const got = L[START + 4800 + j]
          expect(closeTo(got, want), `out[${4800 + j}] = ${got}, ffmpeg ${want}`).toBe(true)
        }
      }
      // And the reference function in mix-protocol.ts agrees with ffmpeg.
      for (const [i, want] of FFMPEG_FADE_IN[curve]) {
        expect(closeTo(exportFadeGain(curve, i / 4800), want)).toBe(true)
      }
    })
  }

  it('defaults an unnamed curve to exp, the export default', () => {
    const rig = processorRig()
    rig.fromWorker({
      t: 'segments',
      planGen: 1,
      segs: [{ ...seg('F', { tlStart: 480 / SR, fadeIn: 0.1 }), curveIn: undefined }],
    })
    rig.fromWorker(constBlock('F', 0, 0, 480, 4800, 1))
    play(rig)
    const [L] = rig.render(40)
    expect(closeTo(L[480 + 2400], 0.003162277629598975)).toBe(true)
  })
})

describe('starvation', () => {
  it('is isolated to the starving segment; the others and the clock play on', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A'), seg('B')] })
    rig.fromWorker(constBlock('A', 0, 0, 0, 4096, 0.25))
    rig.fromWorker(constBlock('B', 0, 0, 0, 512, 0.5))
    play(rig)
    const [L] = rig.render(16)
    expect(L[400]).toBeCloseTo(0.75, 6)
    // B ran out at 512: A alone, uninterrupted.
    for (const i of [512, 1000, 2047]) expect(L[i]).toBeCloseTo(0.25, 6)
    rig.send({ t: 'report' })
    const r = lastReport(rig)
    expect(r.k).toBe(2048)
    expect(r.underrunFrames).toBe(2048 - 512)
    expect(r.primingFrames).toBe(0)
    expect(r.starving).toEqual(['B'])
  })

  it('counts the wait for a first block after a seek as priming, not underrun', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    play(rig)
    rig.render(4)
    rig.send({ t: 'report' })
    expect(lastReport(rig).primingFrames).toBe(512)
    expect(lastReport(rig).underrunFrames).toBe(0)
  })

  it('ramps a starved segment back in rather than starting mid-waveform', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    play(rig)
    rig.render(4) // starving: k = 512
    rig.fromWorker(constBlock('A', 0, 0, 512, 2048, 1))
    const [L] = rig.render(4)
    expect(L[0]).toBeCloseTo(1 / FADE, 6)
    expect(L[FADE - 1]).toBeCloseTo(1, 6)
  })

  it('reports the starving set per interval, then clears it', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    play(rig)
    rig.render(2)
    rig.send({ t: 'report' })
    expect(lastReport(rig).starving).toEqual(['A'])
    rig.fromWorker(constBlock('A', 0, 0, 256, 4096, 1))
    rig.render(2)
    rig.send({ t: 'report' })
    expect(lastReport(rig).starving).toEqual([])
  })
})

describe('transport', () => {
  function ramp(): ProcessorRig {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    // Value = k / 1e5: any skip or repeat shows.
    const pcm = new Float32Array(48000 * 2)
    for (let i = 0; i < 48000; i++) pcm[i * 2] = pcm[i * 2 + 1] = i / 1e5
    rig.fromWorker({ t: 'block', gen: 0, id: 'A', ver: 0, k0: 0, frames: 48000, pcm })
    return rig
  }

  it('play fades in over 5 ms', () => {
    const rig = ramp()
    play(rig)
    const [L] = rig.render(4)
    for (const i of [0, 1, 120, 239, 240, 300]) expect(L[i]).toBeCloseTo((i / 1e5) * fadeIn(i), 7)
  })

  it('pause fades out over 5 ms, the clock runs through the fade and then stops', () => {
    const rig = ramp()
    play(rig)
    rig.render(8) // k = 1024
    rig.send({ t: 'pause', seq: 2 })
    const [L] = rig.render(4)
    for (const j of [0, 100, 238]) expect(L[j]).toBeCloseTo(((1024 + j) / 1e5) * (1 - (j + 1) / FADE), 7)
    expect(L[239]).toBe(0)
    expect(Array.from(L.subarray(240)).every((v) => v === 0)).toBe(true)
    const r = lastReport(rig)
    expect(r.playing).toBe(false)
    expect(r.seq).toBe(2)
    expect(r.k).toBe(1024 + FADE)
    expect(r.timelineTime).toBeCloseTo((1024 + FADE) / SR, 12)
    rig.render(4)
    rig.send({ t: 'report' })
    expect(lastReport(rig).k).toBe(1024 + FADE)
    // The Worker hears the stop.
    const tw = rig.toWorker().filter((m) => m.t === 'transport')
    expect(tw[tw.length - 1]).toMatchObject({ gen: 0, k: 1024 + FADE, playing: false })
  })

  it('resume continues the same generation from the frame it stopped at, nothing dropped', () => {
    const rig = ramp()
    play(rig)
    rig.render(8)
    rig.send({ t: 'pause', seq: 2 })
    rig.render(4)
    rig.send({ t: 'play', seq: 3 })
    const [L] = rig.render(4)
    const k0 = 1024 + FADE
    for (const j of [0, 100, 239, 300]) expect(L[j]).toBeCloseTo(((k0 + j) / 1e5) * fadeIn(j), 7)
    expect(rig.proc.gen).toBe(0)
  })

  it('play during the pause fade cancels it', () => {
    const rig = ramp()
    play(rig)
    rig.render(8)
    rig.send({ t: 'pause', seq: 2 })
    rig.render(1) // 128 of 240 fade frames
    rig.send({ t: 'play', seq: 3 })
    const [L] = rig.render(4)
    expect(L[L.length - 1]).toBeCloseTo((1024 + 128 + 511) / 1e5, 7)
    expect(lastReport(rig).playing).toBe(true)
  })

  it('seek while playing: fade out, switch generation at the target, adopt the blocks sent during the fade, fade in', () => {
    const rig = ramp()
    play(rig)
    rig.render(8) // k = 1024
    rig.send({ t: 'seek', seq: 2, gen: 1, time: 2 })
    // The Worker hears the pending generation before the fade ends.
    const tw = rig.toWorker().filter((m) => m.t === 'transport')
    expect(tw[tw.length - 1]).toMatchObject({ gen: 1, anchorTime: 2, rate: 1, k: 0, playing: true })
    rig.fromWorker(constBlock('A', 1, 0, 0, 4096, 0.7))
    const [L] = rig.render(4)
    for (const j of [0, 100, 238]) expect(L[j]).toBeCloseTo(((1024 + j) / 1e5) * (1 - (j + 1) / FADE), 7)
    // Switched at frame 240: the new generation's audio, fading in.
    for (const j of [0, 50, 239, 260]) expect(L[FADE + j]).toBeCloseTo(0.7 * fadeIn(j), 6)
    expect(rig.proc.gen).toBe(1)
    rig.send({ t: 'report' })
    const r = lastReport(rig)
    expect(r.gen).toBe(1)
    expect(r.k).toBe(512 - FADE)
    expect(r.timelineTime).toBeCloseTo(2 + (512 - FADE) / SR, 12)
    expect(r.primingFrames).toBe(0)
    // A late block of the old generation is dropped.
    rig.fromWorker(constBlock('A', 0, 0, 512, 2048, 9))
    const [L2] = rig.render(1)
    expect(L2[0]).toBeCloseTo(0.7, 6)
  })

  it('seek while paused switches at once', () => {
    const rig = ramp()
    rig.send({ t: 'seek', seq: 1, gen: 4, time: 3.5 })
    expect(rig.proc.gen).toBe(4)
    const r = lastReport(rig)
    expect(r).toMatchObject({ gen: 4, seq: 1, k: 0, playing: false })
    expect(r.timelineTime).toBe(3.5)
    const tw = rig.toWorker().filter((m) => m.t === 'transport')
    expect(tw[tw.length - 1]).toMatchObject({ gen: 4, anchorTime: 3.5, k: 0, playing: false })
    // The queue went with the old generation.
    play(rig, 2)
    const [L] = rig.render(2)
    expect(Array.from(L).every((v) => v === 0)).toBe(true)
  })

  it('a seek during the pause fade lands paused', () => {
    const rig = ramp()
    play(rig)
    rig.render(8)
    rig.send({ t: 'pause', seq: 2 })
    rig.send({ t: 'seek', seq: 3, gen: 1, time: 5 })
    rig.render(4)
    const r = lastReport(rig)
    expect(r).toMatchObject({ gen: 1, playing: false, k: 0 })
    expect(r.timelineTime).toBe(5)
  })
})

describe('the clock', () => {
  it('maps frames to timeline time through rate changes, continuously', () => {
    const rig = processorRig()
    play(rig)
    rig.render(10) // k = 1280 at rate 1
    rig.send({ t: 'rate', seq: 2, gen: 1, rate: 2 })
    // The switch lands where the clock will be when the fade ends.
    const anchor = (1280 + FADE) / SR
    const tw = rig.toWorker().filter((m) => m.t === 'transport')
    expect(tw[tw.length - 1]).toMatchObject({ gen: 1, rate: 2, k: 0 })
    expect(tw[tw.length - 1].anchorTime).toBeCloseTo(anchor, 12)
    rig.render(10)
    rig.send({ t: 'report' })
    const r = lastReport(rig)
    const k = 1280 - FADE
    expect(r).toMatchObject({ gen: 1, rate: 2, k })
    expect(r.timelineTime).toBeCloseTo(timelineTimeAt(k, anchor, 2, SR), 12)
    expect(r.timelineTime).toBeCloseTo(anchor + (2 * k) / SR, 12)
  })

  it('a rate change while paused re-anchors at the frozen time', () => {
    const rig = processorRig({ startTime: 1.5 })
    rig.send({ t: 'rate', seq: 1, gen: 1, rate: 0.5 })
    expect(lastReport(rig)).toMatchObject({ gen: 1, rate: 0.5, k: 0, timelineTime: 1.5 })
    play(rig, 2)
    rig.render(375) // 48000 frames
    rig.send({ t: 'report' })
    expect(lastReport(rig).timelineTime).toBeCloseTo(1.5 + 0.5, 12)
  })

  it('runs backwards at a negative rate and places segments on the reversed axis', () => {
    const rig = processorRig({ startTime: 1 })
    rig.send({ t: 'rate', seq: 1, gen: 1, rate: -1 })
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A', { tlStart: 0, tlEnd: 0.5 })] })
    const s = rig.proc.segs[0]
    expect([s.kStart, s.kEnd]).toEqual([24000, 48000])
    expect(placeK(0.5, 1, -1, SR)).toBe(24000)
    play(rig, 2)
    rig.render(100)
    rig.send({ t: 'report' })
    expect(lastReport(rig).timelineTime).toBeCloseTo(1 - 12800 / SR, 12)
  })

  it('never stalls on starvation', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    play(rig)
    rig.render(50)
    rig.send({ t: 'report' })
    expect(lastReport(rig).k).toBe(50 * QUANTUM)
  })

  it('reports about 20 times a second, with contextTime at the end of the rendered quantum', () => {
    const rig = processorRig()
    play(rig)
    const before = rig.reports().length
    const beforeW = rig.toWorker().length
    rig.render(375) // 1 s
    const cadence = rig.reports().slice(before)
    expect(cadence.length).toBeGreaterThanOrEqual(19)
    expect(cadence.length).toBeLessThanOrEqual(21)
    for (const r of cadence) {
      // timelineTime and contextTime describe the same instant: both advance 1:1 at rate 1.
      expect((r.contextTime as number) - (r.timelineTime as number)).toBeCloseTo(0, 9)
    }
    // The same clock reaches the Worker.
    const clocks = rig.toWorker().slice(beforeW).filter((m) => m.t === 'clock')
    expect(clocks.length).toBe(cadence.length)
    expect(clocks[clocks.length - 1].k).toBe(cadence[cadence.length - 1].k)
  })

  it('places segments with the same expression the Worker uses', () => {
    const rig = processorRig()
    rig.send({ t: 'seek', seq: 1, gen: 1, time: 0.1234567 })
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A', { tlStart: 0.5, tlEnd: 1.7654321 })] })
    const s = rig.proc.segs[0]
    expect(s.kStart).toBe(placeK(0.5, 0.1234567, 1, SR))
    expect(s.kEnd).toBe(placeK(1.7654321, 0.1234567, 1, SR))
  })
})

describe('dispose', () => {
  it('goes silent and lets the node be collected', () => {
    const rig = processorRig()
    rig.fromWorker({ t: 'segments', planGen: 1, segs: [seg('A')] })
    rig.fromWorker(constBlock('A', 0, 0, 0, 4096, 1))
    play(rig)
    rig.send({ t: 'dispose' })
    const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)]
    expect(rig.proc.process([], [out])).toBe(false)
    expect(Array.from(out[0]).every((v) => v === 0)).toBe(true)
    expect(rig.worker.other?.closed).toBe(true)
  })
})
