/**
 * SP4 T4 — master-clock unit tests.
 *
 * What is testable here and what is not, stated plainly (plan: "no pretend-
 * integration tests against mocks of the whole browser"): vitest/jsdom has no
 * Web Audio and no WebCodecs, so the real AudioDecoder → ring → worklet
 * pipeline cannot run in this suite at all. It is therefore built so that
 * every DECISION it makes is a pure function tested directly — the project↔
 * media mapping, the extrapolation (including its ceiling), the PCM volume
 * scaling, the resampler's phase carry, the codec normalization — plus the
 * one integration property that survives the absence of the browser: that
 * `createMasterClock` NEVER throws and hands back a coherent wall-clock
 * transport on every failure path. Real decode behavior belongs to T9's
 * operator parity checklist.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { sourceWindow } from '@bycrux/timeline-core'
import {
  MAX_EXTRAPOLATION_MS,
  STRETCH_STEP_FRAMES,
  audioTrackIsDecodable,
  createMasterClock,
  createStreamStretch,
  extrapolateSamples,
  mediaTsUsForProjectTime,
  normalizeAudioCodec,
  projectTimeForMediaTsUs,
  projectTimeForSamples,
  resampleInterleaved,
  scaleAndInterleavePlanes,
  type ClipTimebase,
} from '../audio-clock'
import type { ChunkSource, SampleRef } from '../demux'

// ── Fixtures ────────────────────────────────────────────────────────────────

function packet(tsUs: number, durUs = 20_000): SampleRef {
  return { tsUs, dtsUs: tsUs, durUs, isKey: true, data: new Uint8Array([1]) }
}

function audioTrack(overrides: Partial<ChunkSource> = {}): ChunkSource {
  const samples = [packet(0), packet(20_000), packet(40_000)]
  return {
    kind: 'audio',
    // Verbatim from mp4box, capitalized — the casing IS the SP1 §7.5 bug.
    codec: 'Opus',
    fps: 50,
    durationS: 0.06,
    coded: { width: 0, height: 0 },
    audio: { sampleRate: 48000, channelCount: 2 },
    samples,
    presIndex: samples.map((_, i) => i),
    firstPresentationTsUs: 0,
    ...overrides,
  }
}

const TIMEBASE: ClipTimebase = { start: 0, inPoint: 0, firstPresentationTsUs: 0 }

/** jsdom has neither; the guard branch in `createMasterClock` is the common real-world path too. */
function stubWebCodecsAudioPresent() {
  ;(globalThis as unknown as { AudioDecoder: unknown }).AudioDecoder = class {}
  ;(globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = class {}
}

afterEach(() => {
  delete (globalThis as unknown as { AudioDecoder?: unknown }).AudioDecoder
  delete (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode
  vi.restoreAllMocks()
})

// ── normalizeAudioCodec (SP1 §7.5) ──────────────────────────────────────────

describe('normalizeAudioCodec', () => {
  it("lowercases mp4box's capitalized 'Opus' — the SP1 §7.5 bug", () => {
    expect(normalizeAudioCodec('Opus')).toBe('opus')
    // The exact comparison that silently sent every proxy to the wall clock.
    expect('Opus'.startsWith('opus')).toBe(false)
    expect(normalizeAudioCodec('Opus').startsWith('opus')).toBe(true)
  })

  it('leaves an already-normalized codec alone', () => {
    expect(normalizeAudioCodec('opus')).toBe('opus')
    expect(normalizeAudioCodec('mp4a.40.2')).toBe('mp4a.40.2')
  })

  it("expands a bare 'mp4a' to AAC-LC, the only form configure() accepts", () => {
    expect(normalizeAudioCodec('mp4a')).toBe('mp4a.40.2')
    expect(normalizeAudioCodec('MP4A')).toBe('mp4a.40.2')
  })
})

describe('audioTrackIsDecodable', () => {
  it('accepts any track that carries a decoder description', () => {
    expect(audioTrackIsDecodable(audioTrack({ codec: 'mp4a.40.2', description: new Uint8Array([1, 2]) }))).toBe(true)
  })

  it('accepts description-less Opus (in-band config) despite mp4box casing', () => {
    expect(audioTrackIsDecodable(audioTrack({ codec: 'Opus', description: undefined }))).toBe(true)
  })

  it('rejects description-less AAC — the QuickTime-v1 case configure() can never satisfy (SP1 §7.1)', () => {
    expect(audioTrackIsDecodable(audioTrack({ codec: 'mp4a', description: undefined }))).toBe(false)
  })
})

// ── Project ↔ media time mapping ────────────────────────────────────────────

describe('project-time mapping', () => {
  it('maps media µs through firstPresentationTsUs and clip start/inPoint', () => {
    const tb: ClipTimebase = { start: 4, inPoint: 10, firstPresentationTsUs: 0 }
    // 10s into the file is the clip's own in-point → the clip's first frame.
    expect(projectTimeForMediaTsUs(tb, 10_000_000)).toBeCloseTo(4, 9)
    // 2.5s further in → 2.5s into the clip on the timeline.
    expect(projectTimeForMediaTsUs(tb, 12_500_000)).toBeCloseTo(6.5, 9)
  })

  it('subtracts a non-zero container origin (media timestamps need not start at 0)', () => {
    // 68333µs is the real first-frame cts the spike measured on its source.
    const tb: ClipTimebase = { start: 0, inPoint: 0, firstPresentationTsUs: 68_333 }
    expect(projectTimeForMediaTsUs(tb, 68_333)).toBeCloseTo(0, 9)
    expect(projectTimeForMediaTsUs(tb, 1_068_333)).toBeCloseTo(1, 9)
  })

  it('round-trips through mediaTsUsForProjectTime', () => {
    const tb: ClipTimebase = { start: 3.25, inPoint: 7.5, firstPresentationTsUs: 68_333 }
    for (const projectS of [3.25, 4, 9.125, 100]) {
      expect(projectTimeForMediaTsUs(tb, mediaTsUsForProjectTime(tb, projectS))).toBeCloseTo(projectS, 9)
    }
  })

  it('scales the in-clip offset by per-clip speed (S>1 consumes more source per project-second)', () => {
    const tb: ClipTimebase = { start: 4, inPoint: 10, firstPresentationTsUs: 0, speed: 2 }
    // 1s of project time past the clip start consumes 2s of source at speed 2, so
    // media 12s (2s past inPoint) maps back to 1s into the clip → project 5.
    expect(projectTimeForMediaTsUs(tb, 12_000_000)).toBeCloseTo(5, 9)
    // Forward: 1s into the clip → 2s past inPoint = media 12s.
    expect(mediaTsUsForProjectTime(tb, 5)).toBeCloseTo(12_000_000, 3)
  })

  it('round-trips at speed 1, 2 and 0.5 (mappers stay exact inverses under speed)', () => {
    for (const speed of [1, 2, 0.5]) {
      const tb: ClipTimebase = { start: 3.25, inPoint: 7.5, firstPresentationTsUs: 68_333, speed }
      for (const projectS of [3.25, 4, 9.125, 100]) {
        expect(projectTimeForMediaTsUs(tb, mediaTsUsForProjectTime(tb, projectS))).toBeCloseTo(projectS, 9)
      }
    }
  })

  it('an absent speed is bit-identical to speed 1 (strict no-op default)', () => {
    const without: ClipTimebase = { start: 2, inPoint: 5, firstPresentationTsUs: 100 }
    const withOne: ClipTimebase = { ...without, speed: 1 }
    for (const mediaTsUs of [100, 5_000_100, 12_345_678]) {
      expect(projectTimeForMediaTsUs(without, mediaTsUs)).toBe(projectTimeForMediaTsUs(withOne, mediaTsUs))
    }
    for (const projectS of [2, 7.5, 42]) {
      expect(mediaTsUsForProjectTime(without, projectS)).toBe(mediaTsUsForProjectTime(withOne, projectS))
    }
  })

  it('reproduces useVideoPlayback\'s formula for a proxy clip (full-source src, no rebase)', () => {
    // The legacy hook computes: projectT = clip.start + (video.currentTime - effectiveInPoint(clip)).
    // `video.currentTime` is time in the LOADED file — which for the engine is
    // (mediaTsUs - firstPresentationTsUs) / 1e6.
    const clip = { start: 12, end: 20, inPoint: 30, src: '/orig.mov', proxySrc: '/orig_proxy_hable1.mp4' }
    const win = sourceWindow(clip, 'preview')
    expect(win.src).toBe('/orig_proxy_hable1.mp4')
    expect(win.inPoint).toBe(30) // the proxy covers the FULL source — never rebased

    const tb: ClipTimebase = { start: clip.start, inPoint: win.inPoint, firstPresentationTsUs: 0 }
    const fileTimeS = 33.5
    const legacy = clip.start + (fileTimeS - win.inPoint)
    expect(projectTimeForMediaTsUs(tb, fileTimeS * 1e6)).toBeCloseTo(legacy, 9)
    expect(legacy).toBeCloseTo(15.5, 9)
  })

  it("reproduces the same formula for a normalizedSrc window cache (rebased in-point)", () => {
    // The cache plays from its own 0, so effectiveInPoint rebases — using the
    // raw clip.inPoint here would land every seek 496.92s off.
    const clip = { start: 2, end: 6, inPoint: 496.92, normalizedSrc: '/cache/window.mp4' }
    const win = sourceWindow(clip, 'preview')
    expect(win.src).toBe('/cache/window.mp4')
    expect(win.inPoint).toBe(0)

    const tb: ClipTimebase = { start: clip.start, inPoint: win.inPoint, firstPresentationTsUs: 0 }
    const fileTimeS = 1.5
    expect(projectTimeForMediaTsUs(tb, fileTimeS * 1e6)).toBeCloseTo(clip.start + fileTimeS - win.inPoint, 9)
  })
})

// ── Clock extrapolation ─────────────────────────────────────────────────────

describe('extrapolateSamples', () => {
  it('returns the reported count when no time has passed', () => {
    expect(extrapolateSamples(4800, 0, 48000)).toBe(4800)
  })

  it('advances at the sample rate between the worklet\'s ~10Hz reports', () => {
    // 50ms into a 100ms report gap: half a report interval of samples.
    expect(extrapolateSamples(4800, 50, 48000)).toBeCloseTo(4800 + 2400, 9)
    expect(extrapolateSamples(0, 100, 48000)).toBeCloseTo(4800, 9)
  })

  it('is a pure time→samples conversion at any sample rate', () => {
    expect(extrapolateSamples(0, 100, 44100)).toBeCloseTo(4410, 9)
  })

  it('clamps at the ceiling so a suspended context stalls instead of running away', () => {
    const capped = extrapolateSamples(0, 60_000, 48000)
    expect(capped).toBeCloseTo((MAX_EXTRAPOLATION_MS / 1000) * 48000, 9)
    // One minute suspended must not read as one minute of playback.
    expect(capped).toBeLessThan(48000)
  })

  it('clamps a backwards clock to zero elapsed', () => {
    expect(extrapolateSamples(4800, -500, 48000)).toBe(4800)
  })
})

describe('projectTimeForSamples', () => {
  it('converts rendered frames to project seconds off the ring anchor', () => {
    expect(projectTimeForSamples(5, 48000, 48000)).toBeCloseTo(6, 9)
    expect(projectTimeForSamples(0, 0, 48000)).toBe(0)
    expect(projectTimeForSamples(2.5, 22050, 44100)).toBeCloseTo(3, 9)
  })

  it('composes with extrapolateSamples into a continuous reading between reports', () => {
    const rate = 48000
    // Last report said 1s of audio had played; 50ms of wall time has passed.
    const projected = extrapolateSamples(rate, 50, rate)
    expect(projectTimeForSamples(10, projected, rate)).toBeCloseTo(11.05, 9)
  })

  it('advances project time at the transport rate R (default 1)', () => {
    // 1s of rendered audio is 2s of project time at R=2, 0.5s at R=0.5, 1s at R=1.
    expect(projectTimeForSamples(0, 48000, 48000, 2)).toBeCloseTo(2, 9)
    expect(projectTimeForSamples(0, 48000, 48000, 0.5)).toBeCloseTo(0.5, 9)
    expect(projectTimeForSamples(0, 48000, 48000)).toBeCloseTo(1, 9)
    // R scales only the sample term, off the anchor.
    expect(projectTimeForSamples(10, 22050, 44100, 2)).toBeCloseTo(11, 9)
  })
})

// ── PCM scaling ─────────────────────────────────────────────────────────────

describe('scaleAndInterleavePlanes', () => {
  const left = new Float32Array([0.1, 0.2, 0.3])
  const right = new Float32Array([-0.1, -0.2, -0.3])

  it('interleaves planes as [L0,R0,L1,R1,…]', () => {
    expect(Array.from(scaleAndInterleavePlanes([left, right], 3, 1))).toEqual([
      0.1, -0.1, 0.2, -0.2, 0.3, -0.3,
    ].map((v) => Math.fround(v)))
  })

  it('volume 1.0 is a pure interleave (no level change)', () => {
    const out = scaleAndInterleavePlanes([left], 3, 1)
    expect(Array.from(out)).toEqual(Array.from(left))
  })

  it('volume 0 (a muted clip) produces silence, not a skipped chunk', () => {
    const out = scaleAndInterleavePlanes([left, right], 3, 0)
    expect(out.length).toBe(6)
    // `-0` is a legitimate product of scaling a negative sample by 0 and is
    // bit-identical silence to a device; compare by value, not by sign bit.
    expect(Array.from(out).every((v) => v === 0)).toBe(true)
  })

  it('attenuates below 1.0', () => {
    const out = scaleAndInterleavePlanes([new Float32Array([0.5]), new Float32Array([1])], 1, 0.5)
    expect(Array.from(out)).toEqual([Math.fround(0.25), Math.fround(0.5)])
  })

  it('amplifies above 1.0 and does NOT clamp — parity with the legacy GainNode', () => {
    // The schema allows volume up to 2.0. A GainNode at 2.0 emits >1.0 samples
    // too and lets AudioDestinationNode do the clipping; clamping here would
    // make the engine quieter than the legacy player on amplified clips.
    const out = scaleAndInterleavePlanes([new Float32Array([0.8, -0.9])], 2, 2)
    expect(Array.from(out)).toEqual([Math.fround(1.6), Math.fround(-1.8)])
    expect(out[0]).toBeGreaterThan(1)
    expect(out[1]).toBeLessThan(-1)
  })

  it('handles a mono source (one plane) without inventing a second channel', () => {
    const out = scaleAndInterleavePlanes([new Float32Array([1, 2, 3])], 3, 1)
    expect(out.length).toBe(3)
  })
})

// ── Resampling (shared-context rate mismatch) ───────────────────────────────

describe('resampleInterleaved', () => {
  it('is a zero-cost identity when the context already runs at the decoded rate', () => {
    const input = new Float32Array([1, 2, 3, 4])
    const out = resampleInterleaved(input, 2, 1, 0)
    expect(out.pcm).toBe(input) // same reference — no copy on the common path
    expect(out.phase).toBe(0)
  })

  it('halves the frame count when the render rate is half the decoded rate', () => {
    const input = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    const out = resampleInterleaved(input, 1, 2, 0)
    expect(Array.from(out.pcm)).toEqual([0, 2, 4, 6])
  })

  it('interpolates between input frames rather than dropping to nearest', () => {
    const input = new Float32Array([0, 1])
    const out = resampleInterleaved(input, 1, 0.5, 0)
    // positions 0, 0.5, 1(clamped tail), 1.5(clamped tail)
    expect(out.pcm[0]).toBeCloseTo(0, 6)
    expect(out.pcm[1]).toBeCloseTo(0.5, 6)
  })

  it('carries phase across chunks so 48kHz→44.1kHz does not drift', () => {
    const ratio = 48000 / 44100
    const chunkFrames = 1024
    const chunks = 40
    let phase = 0
    let outFrames = 0
    for (let c = 0; c < chunks; c++) {
      const out = resampleInterleaved(new Float32Array(chunkFrames * 2), 2, ratio, phase)
      phase = out.phase
      outFrames += out.pcm.length / 2
    }
    const expected = (chunks * chunkFrames * 44100) / 48000
    // Without the carried phase this accumulates a whole frame of error per
    // chunk (~40 frames here) instead of staying inside one.
    expect(Math.abs(outFrames - expected)).toBeLessThanOrEqual(1)
    expect(phase).toBeGreaterThanOrEqual(0)
    expect(phase).toBeLessThan(ratio)
  })

  it('returns an empty buffer and preserves phase for an empty chunk', () => {
    const out = resampleInterleaved(new Float32Array(0), 2, 1.5, 0.25)
    expect(out.pcm.length).toBe(0)
    expect(out.phase).toBe(0.25)
  })
})

// ── createMasterClock: never throws, always coherent ────────────────────────

describe('createMasterClock — fallback selection', () => {
  it('falls back for a canvas project (no audio track at all)', async () => {
    const clock = await createMasterClock({ audio: null, timebase: TIMEBASE, startProjectS: 0 })
    expect(clock.kind).toBe('fallback')
    expect(clock.reason).toBe('no audio track')
  })

  it('falls back for a track that demuxed zero packets', async () => {
    const clock = await createMasterClock({
      audio: audioTrack({ samples: [], presIndex: [] }),
      timebase: TIMEBASE,
      startProjectS: 0,
    })
    expect(clock.kind).toBe('fallback')
  })

  it('falls back for a muted clip — there is nothing to sync to', async () => {
    stubWebCodecsAudioPresent()
    const clock = await createMasterClock({
      audio: audioTrack(),
      timebase: TIMEBASE,
      startProjectS: 0,
      muted: true,
    })
    expect(clock.kind).toBe('fallback')
    expect(clock.reason).toBe('clip is muted')
  })

  it('falls back when the browser has no WebCodecs audio (jsdom, and real browsers)', async () => {
    const clock = await createMasterClock({ audio: audioTrack(), timebase: TIMEBASE, startProjectS: 0 })
    expect(clock.kind).toBe('fallback')
    expect(clock.reason).toMatch(/unavailable/)
  })

  it('falls back for description-less AAC without ever calling configure() (SP1 §7.1)', async () => {
    stubWebCodecsAudioPresent()
    const clock = await createMasterClock({
      audio: audioTrack({ codec: 'mp4a', description: undefined }),
      timebase: TIMEBASE,
      startProjectS: 0,
    })
    expect(clock.kind).toBe('fallback')
    expect(clock.reason).toMatch(/no decoder description/)
  })

  it('degrades to wall-clock (never rejects) when the audio graph itself fails to build', async () => {
    // WebCodecs audio present but no Web Audio at all: getSharedAudioContext
    // throws inside the audio path. The caller only ever awaits this function.
    stubWebCodecsAudioPresent()
    const onError = vi.fn()
    const clock = await createMasterClock({
      audio: audioTrack(),
      timebase: TIMEBASE,
      startProjectS: 0,
      onError,
    })
    expect(clock.kind).toBe('fallback')
    expect(clock.reason).toBeTruthy()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatch(/audio clock:/)
  })
})

describe('createMasterClock — fallback transport coherence', () => {
  async function fallbackClock(startProjectS: number, nowRef: { t: number }) {
    const clock = await createMasterClock({
      audio: null,
      timebase: TIMEBASE,
      startProjectS,
      nowMs: () => nowRef.t,
    })
    expect(clock.kind).toBe('fallback')
    return clock
  }

  it('starts parked at startProjectS and does not advance until play()', async () => {
    const now = { t: 1000 }
    const clock = await fallbackClock(2, now)
    expect(clock.playing).toBe(false)
    now.t += 5000
    expect(clock.now()).toBe(2)
  })

  it('advances in real time while playing', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(2, now)
    clock.play()
    expect(clock.playing).toBe(true)
    now.t += 1500
    expect(clock.now()).toBeCloseTo(3.5, 9)
  })

  it('freezes where it read on pause and resumes from there', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.play()
    now.t += 1000
    clock.pause()
    expect(clock.playing).toBe(false)
    now.t += 10_000 // a long think
    expect(clock.now()).toBeCloseTo(1, 9)
    clock.play()
    now.t += 500
    expect(clock.now()).toBeCloseTo(1.5, 9)
  })

  it('play() and pause() are idempotent', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.play()
    now.t += 1000
    clock.play() // must not re-base the start
    expect(clock.now()).toBeCloseTo(1, 9)
    clock.pause()
    clock.pause()
    now.t += 1000
    expect(clock.now()).toBeCloseTo(1, 9)
  })

  it('seeks while paused without starting playback', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.seek(12.25)
    expect(clock.now()).toBe(12.25)
    expect(clock.playing).toBe(false)
    now.t += 3000
    expect(clock.now()).toBe(12.25)
  })

  it('seeks during playback and keeps playing from the target', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.play()
    now.t += 2000
    clock.seek(30)
    expect(clock.playing).toBe(true)
    expect(clock.now()).toBeCloseTo(30, 9)
    now.t += 250
    expect(clock.now()).toBeCloseTo(30.25, 9)
  })

  it('freezes the reading on dispose instead of snapping back to the anchor', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.play()
    now.t += 4000
    clock.dispose()
    expect(clock.playing).toBe(false)
    now.t += 4000
    expect(clock.now()).toBeCloseTo(4, 9)
  })

  it('changes transport rate mid-playback with no discontinuity, then advances at the new rate', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.play()
    now.t += 1000 // 1s at 1× → project 1
    expect(clock.now()).toBeCloseTo(1, 9)
    clock.setTransportRate(2)
    // Continuous: no jump at the instant of the change.
    expect(clock.now()).toBeCloseTo(1, 9)
    now.t += 1000 // 1s at 2× → +2 → project 3
    expect(clock.now()).toBeCloseTo(3, 9)
    clock.setTransportRate(0.5)
    expect(clock.now()).toBeCloseTo(3, 9)
    now.t += 1000 // 1s at 0.5× → +0.5 → project 3.5
    expect(clock.now()).toBeCloseTo(3.5, 9)
  })

  it('a rate change while paused takes effect on resume, with no jump', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(5, now)
    clock.setTransportRate(3) // paused: nothing moves yet
    expect(clock.now()).toBe(5)
    now.t += 10_000
    expect(clock.now()).toBe(5)
    clock.play()
    now.t += 1000 // 1s at 3× → +3
    expect(clock.now()).toBeCloseTo(8, 9)
  })

  it('seek keeps the current transport rate', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.setTransportRate(2)
    clock.play()
    now.t += 500 // +1 → 1
    expect(clock.now()).toBeCloseTo(1, 9)
    clock.seek(10)
    expect(clock.now()).toBeCloseTo(10, 9)
    now.t += 500 // still 2× → +1 → 11
    expect(clock.now()).toBeCloseTo(11, 9)
  })

  it('reports fallback stats with no ring numbers to invent', async () => {
    const now = { t: 0 }
    const clock = await fallbackClock(0, now)
    clock.play()
    expect(clock.stats()).toEqual({
      kind: 'fallback',
      reason: 'no audio track',
      playing: true,
      samplesConsumed: 0,
      underrunFrames: 0,
      queuedFrames: 0,
      queuedSeconds: 0,
    })
  })
})

// ── Streaming time-stretch (the createAudioClock output-callback wrapper) ─────

describe('createStreamStretch', () => {
  const RATE = 48000

  /** Mono sine of `freq` Hz, `frames` samples, amplitude 0.5. */
  function sine(freq: number, frames: number, offset = 0): Float32Array {
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * (i + offset)) / RATE)
    return out
  }
  const finite = (s: Float32Array) => s.every((v) => Number.isFinite(v))
  const maxAbs = (s: Float32Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

  /** Feed a mono signal in `chunk`-frame pieces, concatenating everything emitted. */
  function feedInChunks(freq: number, totalFrames: number, factor: number, chunk = 960): Float32Array {
    const s = createStreamStretch(1, factor)
    const pieces: Float32Array[] = []
    let produced = 0
    for (let off = 0; off < totalFrames; off += chunk) {
      const n = Math.min(chunk, totalFrames - off)
      const out = s.push(sine(freq, n, off))
      if (out.length > 0) {
        pieces.push(out)
        produced += out.length
      }
    }
    const all = new Float32Array(produced)
    let at = 0
    for (const p of pieces) {
      all.set(p, at)
      at += p.length
    }
    return all
  }

  it('is a zero-copy identity at factor 1 — the strict-bypass guarantee', () => {
    const s = createStreamStretch(1, 1)
    const chunks = [sine(440, 960), sine(440, 960, 960), sine(440, 300, 1920)]
    for (const c of chunks) {
      const out = s.push(c)
      // Same reference back: no buffering, no copy, no added latency.
      expect(out).toBe(c)
    }
  })

  it('total output length ≈ input · factor across rates (chunks smaller than one WSOLA frame)', () => {
    // 960-frame chunks are smaller than the 1024 analysis frame — the whole
    // reason a streaming wrapper is needed rather than a per-chunk stretch.
    const total = 40 * STRETCH_STEP_FRAMES // large enough that block-edge loss is a small %
    for (const factor of [0.25, 0.5, 2, 4]) {
      const out = feedInChunks(440, total, factor)
      const ratio = out.length / (total * factor)
      // Short by up to ~(context + one leftover block)·factor, negligible at this size.
      expect(ratio).toBeGreaterThan(0.9)
      expect(ratio).toBeLessThan(1.05)
    }
  })

  it('preserves amplitude and never emits NaN/Infinity when slowed or sped', () => {
    for (const factor of [0.5, 2]) {
      const out = feedInChunks(440, 20 * STRETCH_STEP_FRAMES, factor)
      expect(finite(out)).toBe(true)
      // Unity-gain overlap-add of an amplitude-0.5 tone stays near 0.5 — not
      // collapsed to silence (a broken crossfade) nor blown past unity.
      expect(maxAbs(out)).toBeGreaterThan(0.3)
      expect(maxAbs(out)).toBeLessThan(0.9)
    }
  })

  it('keeps stereo channels interleaved and finite', () => {
    const s = createStreamStretch(2, 0.5)
    // Interleave a 300Hz L with a silent R.
    const frames = 8 * STRETCH_STEP_FRAMES
    const inter = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i++) inter[i * 2] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / RATE)
    const out = s.push(inter)
    expect(out.length % 2).toBe(0)
    expect(finite(out)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
  })

  it('reset() drops buffered input so a partial block never leaks across it', () => {
    const s = createStreamStretch(1, 0.5)
    // Under one block: buffered, nothing emitted yet.
    expect(s.push(sine(440, 500)).length).toBe(0)
    s.reset()
    // With the pre-reset 500 dropped, this sub-block push must still buffer, not
    // complete a block by combining with stale input.
    const out = s.push(sine(440, STRETCH_STEP_FRAMES - 500))
    expect(out.length).toBe(0)
  })

  it('adopts a new factor mid-stream without crashing and stays finite', () => {
    const s = createStreamStretch(1, 2)
    const a = s.push(sine(440, 4 * STRETCH_STEP_FRAMES))
    s.setFactor(0.5)
    const b = s.push(sine(440, 4 * STRETCH_STEP_FRAMES, 4 * STRETCH_STEP_FRAMES))
    expect(finite(a)).toBe(true)
    expect(finite(b)).toBe(true)
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
  })
})
