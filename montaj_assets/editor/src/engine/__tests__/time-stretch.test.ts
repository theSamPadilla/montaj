/**
 * WSOLA time-stretch unit tests.
 *
 * This is a pure array-math primitive with no browser dependency, so unlike the
 * rest of the engine suite it exercises the REAL thing end to end — no mocks.
 * The load-bearing property is pitch preservation: a stretch must change
 * duration WITHOUT changing frequency, which is what separates it from a
 * resample. We measure that with the zero-crossing rate of a pure tone (∝
 * frequency for a sine), asserting the rate survives the stretch rather than
 * scaling with it.
 */
import { describe, it, expect } from 'vitest'
import { timeStretch } from '../time-stretch'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RATE = 48000

/** Mono sine of `freq` Hz for `seconds`, amplitude 0.5. */
function sine(freq: number, seconds: number, rate = RATE, amp = 0.5): Float32Array {
  const n = Math.round(seconds * rate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

/** Interleave two equal-length mono channels into L,R,L,R,… */
function interleaveStereo(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    out[i * 2] = left[i]
    out[i * 2 + 1] = right[i]
  }
  return out
}

/** Pull one channel out of an interleaved buffer. */
function deinterleave(input: Float32Array, channels: number, ch: number): Float32Array {
  const n = Math.floor(input.length / channels)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = input[i * channels + ch]
  return out
}

/**
 * Zero crossings per sample. For a sine this is proportional to frequency (two
 * crossings per period), so it is our proxy for pitch. Skips the first and last
 * frame's worth of samples, where the window's own ramp lives.
 */
function zeroCrossingRate(samples: Float32Array): number {
  const margin = 1024
  let crossings = 0
  let counted = 0
  for (let i = margin + 1; i < samples.length - margin; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings++
    counted++
  }
  return counted > 0 ? crossings / counted : 0
}

function maxAbs(samples: Float32Array): number {
  let m = 0
  for (let i = 0; i < samples.length; i++) m = Math.max(m, Math.abs(samples[i]))
  return m
}

function allFinite(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) return false
  return true
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('timeStretch', () => {
  it('returns a faithful copy at factor 1 (identity), not the same buffer', () => {
    const input = sine(440, 0.25)
    const out = timeStretch(input, 1, 1)
    expect(out).not.toBe(input) // a copy, so the caller's buffer is never aliased
    expect(out.length).toBe(input.length)
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(input[i])
  })

  it('scales output length by the factor', () => {
    const input = sine(440, 1)
    // Length is exact to the rounding of `inFrames * factor` (a fraction of one
    // sample), so a tight tolerance of one frame (1024) is generous.
    const half = timeStretch(input, 1, 0.5)
    const dbl = timeStretch(input, 1, 2)
    expect(Math.abs(half.length - input.length * 0.5)).toBeLessThan(1024)
    expect(Math.abs(dbl.length - input.length * 2)).toBeLessThan(1024)
  })

  it('turns silence into silence at both 0.5 and 2.0', () => {
    const silence = new Float32Array(RATE) // 1s of zeros, mono
    for (const factor of [0.5, 2]) {
      const out = timeStretch(silence, 1, factor)
      expect(maxAbs(out)).toBeLessThan(1e-6)
      expect(allFinite(out)).toBe(true)
    }
  })

  it('preserves pitch (zero-crossing rate unchanged, NOT scaled) when slowed 2x', () => {
    const input = sine(440, 1)
    const out = timeStretch(input, 1, 2)
    const inRate = zeroCrossingRate(input)
    const outRate = zeroCrossingRate(out)
    // Preserved pitch → same per-sample crossing rate. A pitch bug would scale
    // it by the factor (here halve it), which 15% cannot hide.
    expect(Math.abs(outRate - inRate) / inRate).toBeLessThan(0.15)
  })

  it('preserves pitch (zero-crossing rate unchanged, NOT scaled) when sped up 2x', () => {
    const input = sine(440, 1)
    const out = timeStretch(input, 1, 0.5)
    const inRate = zeroCrossingRate(input)
    const outRate = zeroCrossingRate(out)
    expect(Math.abs(outRate - inRate) / inRate).toBeLessThan(0.15)
  })

  it('keeps stereo channels separate — L stays L, no bleed into a silent R', () => {
    const left = sine(440, 1)
    const right = new Float32Array(left.length) // silent R
    const input = interleaveStereo(left, right)

    const out = timeStretch(input, 2, 2)
    expect(out.length).toBeCloseTo(input.length * 2, -3) // ~2x, interleaved
    expect(allFinite(out)).toBe(true)

    const outL = deinterleave(out, 2, 0)
    const outR = deinterleave(out, 2, 1)
    // L still carries the tone at its original pitch…
    expect(Math.abs(zeroCrossingRate(outL) - zeroCrossingRate(left)) / zeroCrossingRate(left)).toBeLessThan(0.15)
    expect(maxAbs(outL)).toBeGreaterThan(0.3)
    // …and none of it bled into the silent R channel.
    expect(maxAbs(outR)).toBeLessThan(1e-6)
  })

  it('keeps distinct L/R content on its own channel (no cross-channel bleed)', () => {
    const left = sine(300, 1)
    const right = sine(900, 1)
    const input = interleaveStereo(left, right)
    const out = timeStretch(input, 2, 1.5)

    const outL = deinterleave(out, 2, 0)
    const outR = deinterleave(out, 2, 1)
    // Each channel keeps its own pitch — a bleed would drag the rates together.
    expect(Math.abs(zeroCrossingRate(outL) - zeroCrossingRate(left)) / zeroCrossingRate(left)).toBeLessThan(0.15)
    expect(Math.abs(zeroCrossingRate(outR) - zeroCrossingRate(right)) / zeroCrossingRate(right)).toBeLessThan(0.15)
  })

  it('never emits NaN or Infinity across the supported factor range', () => {
    const input = sine(440, 0.5)
    for (const factor of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]) {
      const out = timeStretch(input, 1, factor)
      expect(allFinite(out)).toBe(true)
    }
  })

  it('never emits NaN or Infinity for extreme (clamped) factors', () => {
    const input = sine(440, 0.5)
    for (const factor of [0.05, 8, 32, 1000]) {
      const out = timeStretch(input, 1, factor)
      expect(allFinite(out)).toBe(true)
    }
  })

  it('returns empty for empty input', () => {
    expect(timeStretch(new Float32Array(0), 1, 2).length).toBe(0)
    expect(timeStretch(new Float32Array(0), 2, 0.5).length).toBe(0)
  })

  it('throws on a non-finite or non-positive factor', () => {
    const input = sine(440, 0.1)
    expect(() => timeStretch(input, 1, 0)).toThrow()
    expect(() => timeStretch(input, 1, -1)).toThrow()
    expect(() => timeStretch(input, 1, Infinity)).toThrow()
    expect(() => timeStretch(input, 1, NaN)).toThrow()
  })
})
