/**
 * §450: sped-up clips sounded warbly and robotic in the preview while the
 * export (ffmpeg `atempo`) sounded clean.
 *
 * Measured causes, each pinned here on the path playback actually runs
 * (`createStreamStretch`, fed decoder-sized pushes):
 *
 *  1. The stream was cut into 2048-frame blocks, each stretched by a fresh
 *     whole-buffer WSOLA and linearly crossfaded into the last. The two
 *     renderings of each overlap were not phase-aligned, so the level dipped
 *     once per block: a ~26 Hz amplitude warble at speed 1.12.
 *  2. The similarity search reached only ±128 samples, less than half the
 *     pitch period of a voice below ~190 Hz, so frames overlapped out of phase
 *     and harmonics partly cancelled.
 *
 * The signals are steady harmonic stacks whose period divides the RMS window,
 * so an ideal stretch has a perfectly flat envelope at the input's level.
 */
import { describe, it, expect } from 'vitest'
import { createStreamStretch } from '../audio-clock'
import { timeStretch } from '../time-stretch'

const RATE = 48000
const SPEED = 1.12
const FACTOR = 1 / SPEED

/** A voice-like harmonic stack at `f0` with a falling spectral tilt and fixed phases. */
function harmonicStack(f0: number, frames: number): Float32Array {
  const out = new Float32Array(frames)
  for (let k = 1; k * f0 < 4000; k++) {
    const amp = 0.3 / k
    const phase = (k * 2.399) % (2 * Math.PI)
    for (let i = 0; i < frames; i++) out[i] += amp * Math.sin((2 * Math.PI * k * f0 * i) / RATE + phase)
  }
  return out
}

/** A speech-like voiced signal: a gliding ~120 Hz harmonic stack under ~4.5 Hz syllables. */
function voiced(frames: number): Float32Array {
  const out = new Float32Array(frames)
  let cycles = 0
  for (let i = 0; i < frames; i++) {
    const t = i / RATE
    const f0 = 120 + 20 * Math.sin(2 * Math.PI * 0.3 * t)
    const ph = t % 0.22
    const env = ph < 0.17 ? 0.2 + 0.8 * 0.5 * (1 - Math.cos((2 * Math.PI * ph) / 0.17)) : 0.2
    let s = 0
    for (let k = 1; k * f0 < 4000; k++) s += Math.sin(2 * Math.PI * k * cycles + k) / k
    out[i] = 0.2 * env * s
    cycles += f0 / RATE
  }
  return out
}

/** Feed `x` in `chunk`-frame pushes (a decoded Opus packet is 960) and join what comes out. */
function streamed(x: Float32Array, factor: number, chunk = 960): Float32Array {
  const s = createStreamStretch(1, factor)
  const parts: Float32Array[] = []
  for (let off = 0; off < x.length; off += chunk) parts.push(s.push(x.slice(off, Math.min(x.length, off + chunk))))
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** RMS over consecutive `win`-sample windows, skipping `margin` samples at each end. */
function rmsEnvelope(x: Float32Array, win: number, margin: number): number[] {
  const env: number[] = []
  for (let s = margin; s + win <= x.length - margin; s += win / 4) {
    let q = 0
    for (let i = 0; i < win; i++) q += x[s + i] * x[s + i]
    env.push(Math.sqrt(q / win))
  }
  return env
}

const db = (a: number, b: number) => 20 * Math.log10(a / b)

describe('§450: the playback time-stretch at speed 1.12', () => {
  it('streams with no block seams: decoder-sized pushes give exactly the whole-buffer stretch', () => {
    const x = voiced(2 * RATE)
    const whole = timeStretch(x, 1, FACTOR)
    const out = streamed(x, FACTOR)
    // The stream holds back only its look-ahead; nearly all of it is out.
    expect(out.length).toBeGreaterThan(0.9 * whole.length)
    let maxDiff = 0
    for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - whole[i]))
    expect(maxDiff).toBe(0)
  })

  it('has no block-rate warble: a steady 100 Hz voice keeps a flat level through the stream', () => {
    const x = harmonicStack(100, 3 * RATE) // period 480 samples
    const inLevel = rmsEnvelope(x, 480, 0)[0]
    const env = rmsEnvelope(streamed(x, FACTOR), 480, 4800)
    expect(env.length).toBeGreaterThan(100)
    // Was an 8 dB swing, a dip once per 2048-frame block.
    expect(db(Math.max(...env), Math.min(...env))).toBeLessThan(0.5)
    expect(Math.abs(db(Math.min(...env), inLevel))).toBeLessThan(0.5)
  })

  it('keeps a low voice in phase: a steady 96 Hz voice keeps its level, whole-buffer too', () => {
    // Period 500 samples: the old ±128 search could not reach its half-period (250). Was a 3.5 dB swing.
    const x = harmonicStack(96, 3 * RATE)
    const inLevel = rmsEnvelope(x, 500, 0)[0]
    const env = rmsEnvelope(timeStretch(x, 1, FACTOR), 500, 4800)
    expect(db(Math.max(...env), Math.min(...env))).toBeLessThan(0.5)
    expect(Math.abs(db(Math.min(...env), inLevel))).toBeLessThan(0.5)
  })
})
