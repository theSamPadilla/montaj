/**
 * §190 T3: ducking in the mix processor, held to the export's ffmpeg.
 *
 * The export ducks a lane with `sidechaincompress=threshold=0.02:ratio=R:
 * attack=A:release=B`, keyed by the mix built before it
 * (render/mix-audio.js:162-179). The worklet runs the same detector and gain
 * computer on its ducked segments, keyed by the lower stages. Every number
 * below marked "ffmpeg" was captured from the export's own binary, not derived.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { exportDuckGain, type MixDuck } from '../mix-protocol'
import { clearCurrentTime, constBlock, processorRig, QUANTUM, seg, type ProcessorRig } from './mix-harness'

const SR = 48000
/** Segments start here, past the 5 ms transport fade, so the bus is at unity. */
const START = 480

afterEach(() => clearCurrentTime())

const duck = (ratio: number, attackMs: number, releaseMs: number): MixDuck => ({
  threshold: 0.02,
  ratio,
  attackMs,
  releaseMs,
})

/**
 * Captured from the export's ffmpeg (montaj-app desktop/vendor/ffmpeg,
 * "ffmpeg version 8.1.2", 2026-10-09), main input a constant 1 so the output
 * IS the gain:
 *
 *   ffmpeg -f lavfi -i "aevalsrc=1|1:s=48000:d=<d>" -f lavfi -i "aevalsrc=<key L>|<key R>:s=48000:d=<d>" \
 *     -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.02:ratio=<r>:attack=<a>:release=<b>" \
 *     -c:a pcm_f32le -f f32le -
 *
 * Sample index -> gain (both channels equal).
 */
const FFMPEG_CASES: Array<{
  name: string
  duck: MixDuck
  frames: number
  key: (i: number) => [number, number]
  gains: Array<[number, number]>
}> = [
  {
    name: 'a 0.5 key for 1 s, then silence (attack, steady state, release)',
    duck: duck(4, 300, 500),
    frames: 72000,
    key: (i) => (i < 48000 ? [0.5, 0.5] : [0, 0]),
    gains: [
      [1, 1], [100, 0.3433956801891327], [1000, 0.15208761394023895], [3600, 0.1062198132276535],
      [10000, 0.09162045270204544], [30000, 0.08945076912641525], [47999, 0.08944277465343475],
      [48000, 0.08944836258888245], [50000, 0.10135933011770248], [60000, 0.18937402963638306],
      [71000, 0.376636803150177],
    ],
  },
  {
    name: 'a key at the threshold (inside the knee)',
    duck: duck(4, 300, 500),
    frames: 48000,
    key: () => [0.02, 0.02],
    gains: [
      [1, 1], [1000, 1], [3600, 0.9699918627738953], [10000, 0.9177622199058533],
      [30000, 0.9071668386459351], [47999, 0.907126247882843],
    ],
  },
  {
    name: 'a 440 Hz key, louder on the left (RMS detection, channels averaged), ratio 20',
    duck: duck(20, 300, 500),
    frames: 48000,
    key: (i) => {
      const s = Math.sin((2 * Math.PI * 440 * i) / SR)
      return [0.3 * s, 0.1 * s]
    },
    gains: [
      [1, 1], [100, 0.7916362285614014], [1000, 0.3058009445667267], [3600, 0.19059528410434723],
      [10000, 0.15329036116600037], [30000, 0.1453624814748764], [47000, 0.14516130089759827],
    ],
  },
  {
    name: 'a 10 ms attack',
    duck: duck(4, 10, 500),
    frames: 12000,
    key: () => [0.5, 0.5],
    gains: [
      [0, 0.5385648012161255], [1, 0.4159409701824188], [5, 0.277218222618103], [100, 0.11039306968450546],
      [1000, 0.08945044130086899], [10000, 0.08944272249937057],
    ],
  },
]

function keyBlock(id: string, frames: number, key: (i: number) => [number, number]) {
  const pcm = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    const [l, r] = key(i)
    pcm[i * 2] = l
    pcm[i * 2 + 1] = r
  }
  return { t: 'block', gen: 0, id, ver: 0, k0: START, frames, pcm }
}

/** Key K at stage 0 and a constant-1 ducked segment D at stage 1, both from START. */
function duckRig(d: MixDuck, frames: number, key: (i: number) => [number, number]): ProcessorRig {
  const rig = processorRig()
  const span = { tlStart: START / SR, tlEnd: (START + frames) / SR }
  rig.fromWorker({
    t: 'segments',
    planGen: 1,
    segs: [seg('K', { ...span, stage: 0 }), seg('D', { ...span, stage: 1, duck: d })],
  })
  rig.fromWorker(keyBlock('K', frames, key))
  rig.fromWorker(constBlock('D', 0, 0, START, frames, 1))
  rig.send({ t: 'play', seq: 1 })
  return rig
}

const quantaFor = (frames: number) => Math.ceil((START + frames) / QUANTUM)

describe('ducking matches the export (ffmpeg sidechaincompress)', () => {
  for (const c of FFMPEG_CASES) {
    it(c.name, () => {
      const rig = duckRig(c.duck, c.frames, c.key)
      const [L, R] = rig.render(quantaFor(c.frames))
      for (const [i, want] of c.gains) {
        const [kl, kr] = c.key(i)
        // The output is the key plus the ducked constant 1, i.e. key + gain.
        const gotL = L[START + i] - Math.fround(kl)
        const gotR = R[START + i] - Math.fround(kr)
        expect(Math.abs(gotL - want), `L gain[${i}] = ${gotL}, ffmpeg ${want}`).toBeLessThan(1e-6)
        expect(Math.abs(gotR - want), `R gain[${i}] = ${gotR}, ffmpeg ${want}`).toBeLessThan(1e-6)
      }
    })
  }

  it('the steady state is the textbook reduction, and exportDuckGain agrees with ffmpeg', () => {
    // A key of constant |x| = 0.5 settles the detector at 0.25: 28 dB over a
    // 0.02 threshold, so ratio 4 takes off 21 dB and ratio 20 takes 26.6 dB.
    expect(exportDuckGain(duck(4, 300, 500), 0.25)).toBeCloseTo(25 ** -0.75, 12)
    expect(exportDuckGain(duck(20, 300, 500), 0.25)).toBeCloseTo(25 ** -0.95, 12)
    // ffmpeg's settled values, from the captures above.
    expect(Math.abs(exportDuckGain(duck(4, 10, 500), 0.25) - 0.08944272249937057)).toBeLessThan(1e-7)
    expect(Math.abs(exportDuckGain(duck(4, 300, 500), 0.02 ** 2) - 0.907126247882843)).toBeLessThan(1e-6)
    // Below the knee's start (threshold / sqrt(knee) = 0.0119): untouched.
    expect(exportDuckGain(duck(4, 300, 500), 0.0118 ** 2)).toBe(1)
  })
})

describe('the key is the lower stages', () => {
  /** D's gain after 1 s with a 0.5 key at stage 0 and `others` around it. */
  function settledGain(others: Array<{ id: string; stage: number; value: number }>, keyValue = 0.5): number {
    const rig = processorRig()
    const span = { tlStart: START / SR, tlEnd: (START + SR) / SR }
    rig.fromWorker({
      t: 'segments',
      planGen: 1,
      segs: [
        seg('K', { ...span, stage: 0 }),
        seg('D', { ...span, stage: 1, duck: duck(4, 10, 500) }),
        ...others.map((o) => seg(o.id, { ...span, stage: o.stage })),
      ],
    })
    rig.fromWorker(constBlock('K', 0, 0, START, SR, keyValue))
    rig.fromWorker(constBlock('D', 0, 0, START, SR, 1))
    for (const o of others) rig.fromWorker(constBlock(o.id, 0, 0, START, SR, o.value))
    rig.send({ t: 'play', seq: 1 })
    const [L] = rig.render(quantaFor(SR))
    const i = START + SR - 1
    return L[i] - keyValue - others.reduce((n, o) => n + o.value, 0)
  }

  it('a higher stage is not in the key, nor is a segment of the ducked one\'s own stage', () => {
    const alone = settledGain([])
    expect(Math.abs(alone - 25 ** -0.75)).toBeLessThan(1e-6)
    // A loud segment above the ducked one (a later lane) and one beside it: no effect.
    expect(Math.abs(settledGain([{ id: 'X', stage: 2, value: 0.9 }]) - alone)).toBeLessThan(1e-6)
    expect(Math.abs(settledGain([{ id: 'S', stage: 1, value: 0.9 }]) - alone)).toBeLessThan(1e-6)
    // Silence below and loudness above: not ducked at all.
    expect(Math.abs(settledGain([{ id: 'X', stage: 2, value: 0.9 }], 0) - 1)).toBeLessThan(1e-6)
    // A second segment below adds to the key: 0.5 + 0.3 = 0.8 over 0.02.
    expect(Math.abs(settledGain([{ id: 'B', stage: 0, value: 0.3 }]) - 40 ** -0.75)).toBeLessThan(1e-5)
  })

  it('the plan\'s order does not matter, only the stage', () => {
    const rig = processorRig()
    const span = { tlStart: START / SR, tlEnd: (START + SR) / SR }
    rig.fromWorker({
      t: 'segments',
      planGen: 1,
      segs: [seg('D', { ...span, stage: 1, duck: duck(4, 10, 500) }), seg('K', { ...span, stage: 0 })],
    })
    rig.fromWorker(constBlock('K', 0, 0, START, SR, 0.5))
    rig.fromWorker(constBlock('D', 0, 0, START, SR, 1))
    rig.send({ t: 'play', seq: 1 })
    const [L] = rig.render(quantaFor(SR))
    expect(Math.abs(L[START + SR - 1] - 0.5 - 25 ** -0.75)).toBeLessThan(1e-6)
  })

  it('a muted key ducks nothing, as the export leaves a muted lane out of the mix', () => {
    const rig = processorRig()
    const span = { tlStart: START / SR, tlEnd: (START + SR) / SR }
    rig.fromWorker({
      t: 'segments',
      planGen: 1,
      segs: [seg('K', { ...span, stage: 0 }), seg('D', { ...span, stage: 1, duck: duck(4, 10, 500) })],
    })
    rig.send({ t: 'params', segments: { K: { mute: true } } })
    rig.fromWorker(constBlock('K', 0, 0, START, SR, 0.5))
    rig.fromWorker(constBlock('D', 0, 0, START, SR, 1))
    rig.send({ t: 'play', seq: 1 })
    const [L] = rig.render(quantaFor(SR))
    for (const i of [0, 1000, SR - 1]) expect(L[START + i]).toBeCloseTo(1, 6)
  })
})

describe('the detector', () => {
  it('runs before the ducked segment starts, so it enters already ducked, as the export\'s does', () => {
    // The export's compressor runs through the lane's leading silence (adelay),
    // so a bed that starts under speech starts ducked. Key from START, D from
    // START + 30000: D's first sample takes ffmpeg's gain at 30000.
    const rig = processorRig()
    rig.fromWorker({
      t: 'segments',
      planGen: 1,
      segs: [
        seg('K', { tlStart: START / SR, tlEnd: (START + 40000) / SR, stage: 0 }),
        seg('D', { tlStart: (START + 30000) / SR, tlEnd: (START + 40000) / SR, stage: 1, duck: duck(4, 300, 500) }),
      ],
    })
    rig.fromWorker(constBlock('K', 0, 0, START, 40000, 0.5))
    rig.fromWorker(constBlock('D', 0, 0, START + 30000, 10000, 1))
    rig.send({ t: 'play', seq: 1 })
    const [L] = rig.render(quantaFor(40000))
    expect(L[START + 29999]).toBeCloseTo(0.5, 6)
    expect(Math.abs(L[START + 30000] - 0.5 - 0.08945076912641525)).toBeLessThan(1e-6)
  })

  it('clamps an option outside sidechaincompress\'s range to it, rather than failing', () => {
    const over = duckRig({ threshold: 0.02, ratio: 1000, attackMs: 10, releaseMs: 500 }, SR, () => [0.5, 0.5])
    const at20 = duckRig(duck(20, 10, 500), SR, () => [0.5, 0.5])
    const a = over.render(quantaFor(SR))[0]
    const b = at20.render(quantaFor(SR))[0]
    expect(a[START + SR - 1]).toBe(b[START + SR - 1])
    expect(Math.abs(a[START + SR - 1] - 0.5 - 25 ** -0.95)).toBeLessThan(1e-6)
  })
})
