// montaj_assets/timeline-core/test/captions.test.mjs
//
// T4 suite for `activeCaptionSegment`, the fidelity contract for the port of
// CaptionPreview.tsx:187-194:
//
//     const frame = Math.round(currentTime * fps)
//     const t = fps > 0 ? frame / fps : 0
//     const activeSeg = track.segments.find(s => t >= s.start && t < s.end) ?? null
//
// The whole point of the quantization is that the SELECTION box (driven by
// this function) must never address a different segment than the TEMPLATE
// (driven by the same frame-quantized `t` — CaptionPreview.tsx:225's
// `factory(frame, fps, ...)`). See the module header of src/captions.js.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { activeCaptionSegment } from '../index.js'

// ---------------------------------------------------------------------------
// 1. Frame quantization — the whole reason this function exists
// ---------------------------------------------------------------------------

describe('activeCaptionSegment: frame quantization', () => {
  const track = {
    segments: [
      { id: 'a', start: 1, end: 2 },
      { id: 'b', start: 2, end: 3 },
    ],
  }

  test('a t that is sub-frame BEFORE a segment start, but quantizes ONTO it, selects that segment', () => {
    // 1.99999 * 30 = 59.9997 -> round -> frame 60 -> t = 60/30 = 2 exactly.
    // Raw (unquantized) 1.99999 would fall inside segment 'a' (1 <= t < 2).
    // Quantized, it lands exactly on segment 'b's start.
    const seg = activeCaptionSegment(track, 1.99999, 30)
    assert.equal(seg?.id, 'b', 'quantization pulled the sub-frame time onto the next segment boundary')
  })

  test('without quantization the raw time would have selected the OTHER segment (sanity check on the fixture)', () => {
    // Confirms the fixture actually exercises the quantization, not a fluke.
    const rawT = 1.99999
    assert.ok(rawT >= 1 && rawT < 2, 'raw t is inside segment a, unquantized')
  })

  test('a t that quantizes DOWN onto the earlier segment stays with it', () => {
    // 1.00001 * 30 = 30.0003 -> round -> frame 30 -> t = 1 exactly -> segment a.
    const seg = activeCaptionSegment(track, 1.00001, 30)
    assert.equal(seg?.id, 'a')
  })

  test('quantization is fps-relative', () => {
    // At 60fps the same 1.99999 no longer rounds up to frame 120 (2.0):
    // 1.99999 * 60 = 119.9994 -> round -> 120 -> t = 120/60 = 2 exactly too.
    // Use a smaller offset that only survives quantization at low fps.
    const at30 = activeCaptionSegment(track, 1.9835, 30) // *30=59.505 -> round 60 -> t=2 -> 'b'
    const at60 = activeCaptionSegment(track, 1.9835, 60) // *60=119.01 -> round 119 -> t=119/60=1.9833... -> 'a'
    assert.equal(at30?.id, 'b')
    assert.equal(at60?.id, 'a')
  })
})

// ---------------------------------------------------------------------------
// 2. fps = 0 guard
// ---------------------------------------------------------------------------

describe('activeCaptionSegment: fps <= 0 guard (t collapses to 0)', () => {
  test('fps = 0 ignores currentTime entirely and evaluates at t = 0', () => {
    const track = { segments: [{ id: 'zero', start: 0, end: 5 }] }
    assert.equal(activeCaptionSegment(track, 3, 0)?.id, 'zero')
    assert.equal(activeCaptionSegment(track, 999, 0)?.id, 'zero')
  })

  test('fps = 0 with no segment covering t = 0 returns null even though currentTime is inside a later segment', () => {
    const track = { segments: [{ id: 'later', start: 1, end: 5 }] }
    assert.equal(activeCaptionSegment(track, 3, 0), null)
  })
})

// ---------------------------------------------------------------------------
// 3. No match -> null
// ---------------------------------------------------------------------------

describe('activeCaptionSegment: no-match cases return null', () => {
  test('empty segments array', () => {
    assert.equal(activeCaptionSegment({ segments: [] }, 1, 30), null)
  })

  test('missing segments field entirely', () => {
    assert.equal(activeCaptionSegment({}, 1, 30), null)
  })

  test('null / undefined captions track', () => {
    assert.equal(activeCaptionSegment(null, 1, 30), null)
    assert.equal(activeCaptionSegment(undefined, 1, 30), null)
  })

  test('t inside a gap between two segments', () => {
    const track = {
      segments: [
        { id: 'a', start: 0, end: 1 },
        { id: 'b', start: 2, end: 3 },
      ],
    }
    assert.equal(activeCaptionSegment(track, 1.5, 30), null)
  })

  test('t past every segment', () => {
    const track = { segments: [{ id: 'a', start: 0, end: 1 }] }
    assert.equal(activeCaptionSegment(track, 99, 30), null)
  })

  test('t before every segment', () => {
    const track = { segments: [{ id: 'a', start: 5, end: 6 }] }
    assert.equal(activeCaptionSegment(track, 0, 30), null)
  })
})

// ---------------------------------------------------------------------------
// 4. Half-open boundary: >= start && < end
// ---------------------------------------------------------------------------

describe('activeCaptionSegment: half-open boundary (>= start && < end)', () => {
  const track = {
    segments: [
      { id: 'a', start: 0, end: 1 },
      { id: 'b', start: 1, end: 2 },
    ],
  }

  test('exactly at a segment start selects that segment', () => {
    assert.equal(activeCaptionSegment(track, 1, 30)?.id, 'b')
  })

  test('exactly at a segment end does NOT select that segment (end exclusive)', () => {
    assert.equal(activeCaptionSegment(track, 1, 30)?.id, 'b', 'sanity: 1 belongs to b, not a')
  })

  test('the first matching segment in document order wins when the array itself is unordered', () => {
    // find() returns the first match; a malformed/out-of-order segments array
    // still resolves deterministically to the first structural match.
    const unordered = {
      segments: [
        { id: 'first', start: 0, end: 5 },
        { id: 'second', start: 0, end: 5 },
      ],
    }
    assert.equal(activeCaptionSegment(unordered, 2, 30)?.id, 'first')
  })
})

// ---------------------------------------------------------------------------
// 5. Purity + determinism
// ---------------------------------------------------------------------------

describe('purity', () => {
  test('does not mutate the captions track or its segments', () => {
    const track = {
      segments: [
        { id: 'a', start: 0, end: 1 },
        { id: 'b', start: 1, end: 2 },
      ],
    }
    const before = structuredClone(track)
    activeCaptionSegment(track, 1, 30)
    activeCaptionSegment(track, 0.5, 60)
    assert.deepEqual(track, before)
  })

  test('two identical calls return deep-equal (in fact identical) results', () => {
    const track = { segments: [{ id: 'a', start: 0, end: 1 }] }
    const a = activeCaptionSegment(track, 0.5, 30)
    const b = activeCaptionSegment(track, 0.5, 30)
    assert.deepEqual(a, b)
    assert.equal(a, b, 'returns the SAME segment object reference — activeCaptionSegment does not clone')
  })
})
