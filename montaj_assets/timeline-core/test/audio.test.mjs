// montaj_assets/timeline-core/test/audio.test.mjs
//
// T4 suite for `audioWindow`, the pure half of the preview's per-track audio
// sync. Its WINDOW must be the export's window (render/mix-audio.js) for every
// track shape — see src/audio.js's module header. The shape-by-shape proof
// against the export's real ffmpeg args is render/test/audio-window-parity.test.mjs;
// this file pins the rule itself.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { audioWindow, audioSourceWindow } from '../index.js'

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
// 2. A declared `end` and a stored `outPoint` both bind: first one wins
// ---------------------------------------------------------------------------
//
// This section used to be "the derived-outPoint rule beats a stale stored
// outPoint": audioWindow ignored `outPoint` entirely and derived the source
// end from `end - start`. The export never did — mix-audio.js hands the stored
// `outPoint` to ffmpeg's `-to` — so a track with `outPoint` short of its span
// previewed at full length and exported truncated (KNOWN-DIVERGENCES D1). The
// preview now takes the export's window, so those tests asserted the
// divergence, not a feature.

describe('audioWindow: declared end and stored outPoint', () => {
  test('a stored outPoint short of the span stops the track at the outPoint, as the export does', () => {
    // Span [10, 20), inPoint 5, outPoint 12: the source slice is [5, 12), so the
    // track is audible over [10, 17) — the export's `-ss 5 -to 12` exactly.
    const track = { start: 10, end: 20, inPoint: 5, outPoint: 12 }
    assert.equal(audioWindow(track, 16.9).active, true)
    const w = audioWindow(track, 18)
    closeTo(w.trackTime, 13, 'trackTime = (18-10)+5')
    assert.equal(w.active, false, 'source slice [5, 12) is exhausted at trackTime 12')
  })

  test('a stored outPoint past the declared end stops the track at the end', () => {
    // The right half of a split music bed carries `outPoint = sourceDuration`
    // (cuts.ts splitAudioTrack) while its `end` is where the bar stops.
    const track = { start: 10, end: 20, inPoint: 10, outPoint: 60 }
    assert.equal(audioWindow(track, 19.9).active, true)
    assert.equal(audioWindow(track, 20).active, false)
  })

  test('a declared end with no outPoint stops the track at the end', () => {
    const track = { start: 0, end: 10, inPoint: 0 }
    const w = audioWindow(track, 9.999999)
    assert.equal(w.active, true)
    assert.ok(w.trackTime < 10)
    assert.equal(audioWindow(track, 10).active, false)
  })
})

// ---------------------------------------------------------------------------
// 2b. No usable `end`: open-ended, like the export
// ---------------------------------------------------------------------------
//
// `end` is optional (engine/validate.py does not require it; the export plays
// such a track at its natural length). audioWindow used to default a missing
// `end` to 0, so `t >= end` held for every t and the track was NEVER active in
// preview while the export played it in full.

describe('audioWindow: a track with no usable end is open-ended', () => {
  test('{start: 4} is active at t=5 — the reported bug', () => {
    const w = audioWindow({ start: 4 }, 5)
    assert.equal(w.active, true)
    closeTo(w.trackTime, 1, 'trackTime = 5 - 4')
  })

  test('{start: 4} is active from its start with no upper bound (the file ends it)', () => {
    const track = { start: 4 }
    assert.equal(audioWindow(track, 3.999).active, false)
    assert.equal(audioWindow(track, 4).active, true)
    assert.equal(audioWindow(track, 1000).active, true)
  })

  test('end <= start, a null end and a non-numeric end all count as undeclared', () => {
    for (const end of [4, 2, -1, null, undefined, 'x', Number.NaN, Infinity]) {
      const track = /** @type {any} */ ({ start: 4, end })
      assert.equal(audioWindow(track, 5).active, true, `end=${String(end)} at t=5`)
      assert.equal(audioWindow(track, 500).active, true, `end=${String(end)} at t=500`)
    }
  })

  test('{start, inPoint, outPoint} with no end plays outPoint - inPoint', () => {
    // Source slice [3, 8) → 5s, placed at 2 → audible over [2, 7).
    const track = { start: 2, inPoint: 3, outPoint: 8 }
    assert.equal(audioWindow(track, 2).active, true)
    assert.equal(audioWindow(track, 6.999).active, true)
    closeTo(audioWindow(track, 6).trackTime, 7, 'trackTime = (6-2)+3')
    assert.equal(audioWindow(track, 7).active, false)
  })

  test('an outPoint at or before the inPoint counts as undeclared too', () => {
    // `outPoint: 0` exists on disk; handed to ffmpeg as `-to 0` it aborted the
    // whole render ("-to value smaller than -ss").
    for (const track of [{ start: 1, outPoint: 0 }, { start: 1, inPoint: 5, outPoint: 3 }, { start: 1, inPoint: 5, outPoint: 5 }]) {
      assert.equal(audioWindow(track, 100).active, true, JSON.stringify(track))
    }
  })

  test('with no end there is no fade-out anchor, so the fade-out is not applied', () => {
    // The export emits no `afade=t=out` for such a track (mix-audio.js
    // buildFadeFilters). The old `end ?? 0` put `remaining` below zero and
    // held the gain at 0 for the whole track.
    const track = { start: 12, fadeOut: 2, volume: 0.8 }
    closeTo(audioWindow(track, 13).gain, 0.8, 'full volume, no fade-out')
    closeTo(audioWindow({ start: 12, fadeIn: 2 }, 13).gain, 0.5, 'the fade-in still anchors to start')
  })
})

// ---------------------------------------------------------------------------
// 2c. A well-formed track is unchanged
// ---------------------------------------------------------------------------

/** audioWindow as it was before the no-`end` fix, verbatim. */
function legacyAudioWindow(track, t) {
  const start = track.start ?? 0
  const end = track.end ?? 0
  const inPt = track.inPoint ?? 0
  const trackTime = t - start + inPt
  const outPoint = inPt + (end - start)
  const outsideWindow = t < start || t >= end || trackTime < 0 || trackTime >= outPoint
  const fadeIn = track.fadeIn ?? 0
  const fadeOut = track.fadeOut ?? 0
  const baseVol = track.volume ?? 1
  const elapsed = t - start
  const remaining = end - t
  let fadeMul = 1
  if (fadeIn > 0 && elapsed < fadeIn) fadeMul = elapsed / fadeIn
  if (fadeOut > 0 && remaining < fadeOut) fadeMul = Math.min(fadeMul, remaining / fadeOut)
  return { active: !outsideWindow, trackTime, gain: baseVol * Math.max(0, fadeMul) }
}

describe('audioWindow: a track with a real end and no outPoint behaves exactly as before', () => {
  const tracks = [
    { start: 27, end: 31 },
    { start: 27, end: 31, inPoint: 2, fadeIn: 0.5, fadeOut: 1, volume: 0.7 },
    { start: 0, end: 10, fadeIn: 10, fadeOut: 2 },
  ]
  for (const track of tracks) {
    test(JSON.stringify(track), () => {
      for (let t = -2; t <= 40; t += 0.125) {
        assert.deepEqual(audioWindow(track, t), legacyAudioWindow(track, t), `t=${t}`)
      }
    })
  }
})

describe('audioSourceWindow', () => {
  test('normalizes each field the way the export reads it', () => {
    assert.deepEqual(audioSourceWindow({}), { start: 0, inPoint: 0, outPoint: null, end: null })
    assert.deepEqual(audioSourceWindow({ start: 4 }), { start: 4, inPoint: 0, outPoint: null, end: null })
    assert.deepEqual(audioSourceWindow({ start: 4, end: 4 }), { start: 4, inPoint: 0, outPoint: null, end: null })
    assert.deepEqual(audioSourceWindow({ start: 27, end: 31 }), { start: 27, inPoint: 0, outPoint: 4, end: 31 })
    assert.deepEqual(audioSourceWindow({ start: 2, inPoint: 3, outPoint: 8 }), { start: 2, inPoint: 3, outPoint: 8, end: null })
    assert.deepEqual(audioSourceWindow({ start: 10, end: 20, inPoint: 5, outPoint: 12 }), { start: 10, inPoint: 5, outPoint: 12, end: 20 })
    assert.deepEqual(audioSourceWindow({ start: 10, end: 20, inPoint: 10, outPoint: 60 }), { start: 10, inPoint: 10, outPoint: 20, end: 20 })
    // ffmpeg gets no `-ss` for an inPoint <= 0, so the source starts at 0.
    assert.deepEqual(audioSourceWindow({ start: 3, inPoint: -1 }), { start: 3, inPoint: 0, outPoint: null, end: null })
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
  // This test used to read "a track whose start equals its end is never
  // active". That asserted the bug: the export treats `end <= start` as no
  // `end` at all and plays the track at its natural length, and so does the
  // editor's timeline (`resolveAudioWindow`). start == end is open-ended now.
  test('a track whose start equals its end is open-ended (as the export plays it), and never throws or produces NaN/Infinity', () => {
    const track = { start: 5, end: 5, inPoint: 0 }
    const w = audioWindow(track, 5)
    assert.equal(w.active, true)
    assert.equal(audioWindow(track, 60).active, true)
    assert.equal(audioWindow(track, 4.999).active, false)
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
