// montaj_assets/timeline-core/test/audio.test.mjs
//
// T4 suite for `audioWindow`, the fidelity contract for the pure-arithmetic
// port of useVideoPlayback.ts:435-484 (`syncAudioTracks`). See src/audio.js's
// module header for the exact quoted original and the derived-outPoint rule
// this exists to test.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { audioWindow } from '../index.js'

/** Float compare — division in the fade math, so 1e-9 is plenty. */
function closeTo(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}: expected a number, got ${typeof actual}`)
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ~${expected}, got ${actual}`)
}

// ---------------------------------------------------------------------------
// 1. Inside / outside window
// ---------------------------------------------------------------------------

describe('audioWindow: inside / outside the timeline window', () => {
  const track = { start: 10, end: 20, inPoint: 0 }

  test('t inside [start, end) is active', () => {
    assert.equal(audioWindow(track, 15).active, true)
  })

  test('t exactly at start is active (inclusive)', () => {
    assert.equal(audioWindow(track, 10).active, true)
  })

  test('t exactly at end is NOT active (exclusive, half-open like every other activation predicate)', () => {
    assert.equal(audioWindow(track, 20).active, false)
  })

  test('t before start is not active', () => {
    assert.equal(audioWindow(track, 5).active, false)
  })

  test('t after end is not active', () => {
    assert.equal(audioWindow(track, 25).active, false)
  })

  test('trackTime is computed even when inactive (totality) but must not be trusted by the caller', () => {
    const w = audioWindow(track, 5)
    assert.equal(w.active, false)
    assert.equal(Number.isFinite(w.trackTime), true)
  })
})

// ---------------------------------------------------------------------------
// 2. The derived-outPoint rule beats a stale stored outPoint
// ---------------------------------------------------------------------------

describe('audioWindow: derived-outPoint rule (premature-silence-after-trim fix)', () => {
  test('a stale stored outPoint that would silence the track early is ignored — active stays true', () => {
    // Track trimmed so its timeline span is [10, 20] (10s), inPoint 5, so the
    // ACTUAL span it now occupies in the source is [5, 15). A stale stored
    // outPoint of 12 (left over from before the trim) would say "silence at
    // source-time 12", which is BEFORE trackTime 13 at playhead 18 — the
    // premature-silence bug. audioWindow does not even look at track.outPoint;
    // it derives 5 + (20-10) = 15, so trackTime 13 < 15 and the track is
    // still active.
    const track = { start: 10, end: 20, inPoint: 5, outPoint: 12 }
    const w = audioWindow(track, 18)
    closeTo(w.trackTime, 13, 'trackTime = (18-10)+5')
    assert.equal(w.active, true, 'derived outPoint (15) beats the stale stored outPoint (12)')
  })

  test('audioWindow never reads track.outPoint at all — removing the field changes nothing', () => {
    const withStale = { start: 0, end: 10, inPoint: 0, outPoint: 1 }
    const { outPoint: _drop, ...withoutStale } = withStale
    for (const t of [0, 3, 7, 9.999]) {
      assert.deepEqual(audioWindow(withStale, t), audioWindow(withoutStale, t))
    }
  })

  test('the derived outPoint still correctly silences a track once its actual span is exhausted', () => {
    // span [0,10), inPoint 0 -> derived outPoint = 0 + 10 = 10. At trackTime
    // >= 10 (i.e. playhead >= 10) the track goes inactive via t >= end anyway,
    // but confirm trackTime itself reaches the derived boundary at the edge.
    const track = { start: 0, end: 10, inPoint: 0 }
    const w = audioWindow(track, 9.999999)
    assert.equal(w.active, true)
    assert.ok(w.trackTime < 10)
  })
})

// ---------------------------------------------------------------------------
// 3. Fade envelope
// ---------------------------------------------------------------------------

describe('audioWindow: fade-in ramp', () => {
  test('gain ramps linearly from 0 to baseVolume over fadeIn seconds', () => {
    const track = { start: 0, end: 10, fadeIn: 2 }
    closeTo(audioWindow(track, 0).gain, 0, 'at the very start, gain is 0')
    closeTo(audioWindow(track, 1).gain, 0.5, 'halfway through the fade-in')
    closeTo(audioWindow(track, 2).gain, 1, 'fade-in complete at t = fadeIn')
    closeTo(audioWindow(track, 5).gain, 1, 'well past fade-in, full gain')
  })
})

describe('audioWindow: fade-out ramp', () => {
  test('gain ramps linearly from baseVolume to 0 over the last fadeOut seconds', () => {
    const track = { start: 0, end: 10, fadeOut: 2 }
    closeTo(audioWindow(track, 5).gain, 1, 'well before fade-out window, full gain')
    closeTo(audioWindow(track, 8).gain, 1, 'exactly at the fade-out boundary (remaining == fadeOut)')
    closeTo(audioWindow(track, 9).gain, 0.5, 'halfway through the fade-out')
    closeTo(audioWindow(track, 10).gain, 0, 'at the very end, gain is 0')
  })
})

describe('audioWindow: overlapping fades take the min', () => {
  test('near the end of a track whose fadeIn ratio is still high, fadeOut wins via Math.min', () => {
    // duration 10, fadeIn 10 (covers the whole track), fadeOut 2.
    // At t = 9: elapsed 9 -> fadeIn ratio 9/10 = 0.9; remaining 1 -> fadeOut ratio 1/2 = 0.5.
    // min(0.9, 0.5) = 0.5 -> fadeOut dominates even though fadeIn's own ratio is higher.
    const track = { start: 0, end: 10, fadeIn: 10, fadeOut: 2 }
    closeTo(audioWindow(track, 9).gain, 0.5, 'fadeOut ratio (0.5) wins over fadeIn ratio (0.9)')
  })

  test('symmetric overlapping fades at the midpoint', () => {
    const track = { start: 0, end: 10, fadeIn: 8, fadeOut: 8 }
    closeTo(audioWindow(track, 5).gain, 5 / 8, 'both fades active, ratios equal at the midpoint')
  })
})

describe('audioWindow: Math.max(0, fadeMul) clamp', () => {
  test('a negative fadeIn ratio (t before track.start) is clamped to 0, not negative', () => {
    const track = { start: 0, end: 10, fadeIn: 2 }
    const w = audioWindow(track, -1)
    assert.equal(w.active, false, 'still outside the window')
    closeTo(w.gain, 0, 'gain is clamped at 0, not -0.5')
  })

  test('a negative fadeOut ratio (t past track.end) is clamped to 0, not negative', () => {
    const track = { start: 0, end: 10, fadeOut: 2 }
    const w = audioWindow(track, 15)
    assert.equal(w.active, false)
    closeTo(w.gain, 0, 'gain is clamped at 0, not -2.5')
  })
})

// ---------------------------------------------------------------------------
// 4. Volume scaling
// ---------------------------------------------------------------------------

describe('audioWindow: volume scaling', () => {
  test('baseVolume multiplies the fade envelope, including amplification > 1', () => {
    const track = { start: 0, end: 10, volume: 2 }
    closeTo(audioWindow(track, 5).gain, 2, 'no fades in play -> gain is just baseVolume')
  })

  test('volume defaults to 1 when absent', () => {
    const track = { start: 0, end: 10 }
    closeTo(audioWindow(track, 5).gain, 1)
  })

  test('volume combines multiplicatively with an active fade', () => {
    const track = { start: 0, end: 10, fadeIn: 2, volume: 3 }
    closeTo(audioWindow(track, 1).gain, 1.5, 'baseVolume 3 * fadeMul 0.5')
  })
})

// ---------------------------------------------------------------------------
// 5. Zero-length track edge case
// ---------------------------------------------------------------------------

describe('audioWindow: zero-length track', () => {
  test('a track whose start equals its end is never active, and never throws or produces NaN/Infinity', () => {
    const track = { start: 5, end: 5, inPoint: 0 }
    const w = audioWindow(track, 5)
    assert.equal(w.active, false)
    assert.equal(Number.isFinite(w.trackTime), true)
    assert.equal(Number.isFinite(w.gain), true)
  })

  test('a zero-length track with fades set still produces finite numbers (no divide-by-zero at fade edges)', () => {
    const track = { start: 5, end: 5, fadeIn: 0, fadeOut: 0 }
    const w = audioWindow(track, 5)
    assert.equal(Number.isFinite(w.gain), true)
  })
})

// ---------------------------------------------------------------------------
// 6. Purity + determinism
// ---------------------------------------------------------------------------

describe('purity', () => {
  const FIXTURES = [
    { start: 0, end: 10, inPoint: 0 },
    { start: 10, end: 20, inPoint: 5, outPoint: 12, fadeIn: 1, fadeOut: 1, volume: 1.5 },
    { start: 5, end: 5 },
    {},
  ]

  test('audioWindow never mutates its input track', () => {
    for (const track of FIXTURES) {
      const before = structuredClone(track)
      for (const t of [-5, 0, 5, 10, 15, 999]) audioWindow(track, t)
      assert.deepEqual(track, before)
    }
  })

  test('two identical calls return deep-equal results', () => {
    for (const track of FIXTURES) {
      for (const t of [-5, 0, 5, 10, 15]) {
        assert.deepEqual(audioWindow(track, t), audioWindow(track, t))
      }
    }
  })

  test('the returned object is a fresh value each call', () => {
    const track = { start: 0, end: 10 }
    const a = audioWindow(track, 5)
    const b = audioWindow(track, 5)
    assert.notEqual(a, b)
    assert.deepEqual(a, b)
  })
})

// ---------------------------------------------------------------------------
// 7. Totality
// ---------------------------------------------------------------------------

describe('totality', () => {
  test('every numeric field is finite for a broad sweep of tracks and times', () => {
    const tracks = [
      { start: 0, end: 10 },
      { start: -5, end: 5, inPoint: 2 },
      { start: 5, end: 5 },
      { start: 0, end: 20, fadeIn: 3, fadeOut: 3, volume: 0.5 },
      { start: 0, end: 20, fadeIn: 30, fadeOut: 30 }, // fades longer than the track
      {},
    ]
    const times = [-100, -1, 0, 0.5, 5, 9.999, 10, 20, 100]
    for (const track of tracks) {
      for (const t of times) {
        const w = audioWindow(track, t)
        assert.equal(typeof w.active, 'boolean')
        assert.equal(Number.isFinite(w.trackTime), true, `trackTime not finite for ${JSON.stringify(track)} @ ${t}`)
        assert.equal(Number.isFinite(w.gain), true, `gain not finite for ${JSON.stringify(track)} @ ${t}`)
      }
    }
  })
})
