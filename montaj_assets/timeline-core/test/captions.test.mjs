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
//
// Section 6 covers `activeCaptionSegments`, the plural sibling that returns
// EVERY active segment lane-ascending (multi-row captions). Most of what it
// asserts is AGREEMENT with the singular — same quantization, same fps <= 0
// guard, same half-open predicate — because a divergence between the two is
// the failure mode that matters.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { activeCaptionSegment, activeCaptionSegments } from '../index.js'

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

// ---------------------------------------------------------------------------
// 6. activeCaptionSegments — the plural: EVERY active segment, lane-ascending
//
// The plural exists because captions gained lanes (rows): more than one caption
// can be on screen at the same instant, and the render templates + the preview
// now paint all of them. It must agree with the singular on everything except
// "how many matches come back", so most of what is asserted below is agreement.
// ---------------------------------------------------------------------------

describe('activeCaptionSegments: agreement with the singular', () => {
  test('one active segment: the plural returns exactly the singular result, by reference', () => {
    // Section 1's fixture, so the times below exercise the same quantization
    // edges the singular is pinned on.
    const track = {
      segments: [
        { id: 'a', start: 1, end: 2 },
        { id: 'b', start: 2, end: 3 },
      ],
    }
    for (const [currentTime, fps] of [[1.5, 30], [2, 30], [1.99999, 30], [1.9835, 60]]) {
      const one  = activeCaptionSegment(track, currentTime, fps)
      const many = activeCaptionSegments(track, currentTime, fps)
      assert.equal(many.length, 1, `t=${currentTime} fps=${fps}`)
      assert.equal(many[0], one, `t=${currentTime} fps=${fps}: same object reference, not a clone`)
    }
  })

  test('quantization is the singular\'s, verbatim — a sub-frame t that quantizes ONTO the next segment picks that one', () => {
    // The fixture from section 1: 1.99999 * 30 rounds to frame 60 -> t = 2.
    const track = {
      segments: [
        { id: 'a', start: 1, end: 2 },
        { id: 'b', start: 2, end: 3 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1.99999, 30).map(s => s.id), ['b'])
    assert.deepEqual(activeCaptionSegments(track, 1.00001, 30).map(s => s.id), ['a'])
  })

  test('half-open boundary: at a shared edge only the LATER segment is active', () => {
    const track = {
      segments: [
        { id: 'a', start: 0, end: 1 },
        { id: 'b', start: 1, end: 2 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1, 30).map(s => s.id), ['b'])
  })
})

describe('activeCaptionSegments: fps <= 0 guard (t collapses to 0)', () => {
  // Same guard as the singular's section 2 — asserted separately so a change to
  // one function that forgets the other fails here.
  test('fps = 0 ignores currentTime entirely and evaluates at t = 0', () => {
    const track = { segments: [{ id: 'zero', start: 0, end: 5 }] }
    assert.deepEqual(activeCaptionSegments(track, 3, 0).map(s => s.id), ['zero'])
    assert.deepEqual(activeCaptionSegments(track, 999, 0).map(s => s.id), ['zero'])
  })

  test('fps = 0 with no segment covering t = 0 returns [] even though currentTime is inside a later segment', () => {
    const track = { segments: [{ id: 'later', start: 1, end: 5 }] }
    assert.deepEqual(activeCaptionSegments(track, 3, 0), [])
  })

  test('fps = 0 agrees with the singular on which segments are active', () => {
    const track = { segments: [{ id: 'zero', start: 0, end: 5 }, { id: 'later', start: 1, end: 5 }] }
    assert.equal(activeCaptionSegments(track, 3, 0)[0], activeCaptionSegment(track, 3, 0))
  })

  test('a negative fps takes the same branch as fps = 0', () => {
    const track = { segments: [{ id: 'zero', start: 0, end: 5 }] }
    assert.deepEqual(activeCaptionSegments(track, 99, -30).map(s => s.id), ['zero'])
  })
})

describe('activeCaptionSegments: lane ordering', () => {
  test('two lanes active at once come back lane-ascending, whatever order they are stored in', () => {
    const track = {
      segments: [
        { id: 'top',    start: 0, end: 2, lane: 1 },
        { id: 'bottom', start: 0, end: 2, lane: 0 },
      ],
    }
    // Stored top-first; returned bottom-first, because lane 1 paints LAST and
    // therefore on top.
    assert.deepEqual(activeCaptionSegments(track, 1, 30).map(s => s.id), ['bottom', 'top'])
  })

  test('three lanes sort numerically, not lexicographically', () => {
    const track = {
      segments: [
        { id: 'l10', start: 0, end: 2, lane: 10 },
        { id: 'l2',  start: 0, end: 2, lane: 2 },
        { id: 'l0',  start: 0, end: 2, lane: 0 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1, 30).map(s => s.id), ['l0', 'l2', 'l10'])
  })

  test('lane-less segments are all treated as lane 0 and keep document order', () => {
    const track = {
      segments: [
        { id: 'first',  start: 0, end: 2 },
        { id: 'second', start: 0, end: 2 },
        { id: 'third',  start: 0, end: 2 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1, 30).map(s => s.id), ['first', 'second', 'third'])
  })

  test('a lane-less segment sorts equal to an explicit lane 0 — document order breaks the tie', () => {
    const track = {
      segments: [
        { id: 'explicit0', start: 0, end: 2, lane: 0 },
        { id: 'laneless',  start: 0, end: 2 },
        { id: 'lane1',     start: 0, end: 2, lane: 1 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1, 30).map(s => s.id), ['explicit0', 'laneless', 'lane1'])
  })

  test('the sort is stable within a lane — same lane, reversed storage order, preserved', () => {
    const track = {
      segments: [
        { id: 'b', start: 0, end: 2, lane: 3 },
        { id: 'a', start: 0, end: 2, lane: 3 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1, 30).map(s => s.id), ['b', 'a'])
  })

  test('only ACTIVE segments are returned — an inactive higher lane is not dragged in', () => {
    const track = {
      segments: [
        { id: 'now',   start: 0, end: 2, lane: 0 },
        { id: 'later', start: 5, end: 7, lane: 1 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1, 30).map(s => s.id), ['now'])
  })
})

describe('activeCaptionSegments: no-match cases return []', () => {
  test('empty segments array', () => {
    assert.deepEqual(activeCaptionSegments({ segments: [] }, 1, 30), [])
  })

  test('missing segments field entirely', () => {
    assert.deepEqual(activeCaptionSegments({}, 1, 30), [])
  })

  test('null / undefined captions track', () => {
    assert.deepEqual(activeCaptionSegments(null, 1, 30), [])
    assert.deepEqual(activeCaptionSegments(undefined, 1, 30), [])
  })

  test('t inside a gap between two segments', () => {
    const track = {
      segments: [
        { id: 'a', start: 0, end: 1, lane: 0 },
        { id: 'b', start: 2, end: 3, lane: 1 },
      ],
    }
    assert.deepEqual(activeCaptionSegments(track, 1.5, 30), [])
  })

  test('t past every segment / before every segment', () => {
    assert.deepEqual(activeCaptionSegments({ segments: [{ id: 'a', start: 0, end: 1 }] }, 99, 30), [])
    assert.deepEqual(activeCaptionSegments({ segments: [{ id: 'a', start: 5, end: 6 }] }, 0, 30), [])
  })

  test('a segment missing start/end is never active (the ?? NaN totality trick)', () => {
    assert.deepEqual(activeCaptionSegments({ segments: [{ id: 'broken' }] }, 0, 30), [])
    assert.deepEqual(activeCaptionSegments({ segments: [{ id: 'noEnd', start: 0 }] }, 0, 30), [])
  })
})

describe('activeCaptionSegments: purity', () => {
  test('does not mutate or re-order the captions track', () => {
    const track = {
      segments: [
        { id: 'top',    start: 0, end: 2, lane: 1 },
        { id: 'bottom', start: 0, end: 2, lane: 0 },
      ],
    }
    const before = structuredClone(track)
    activeCaptionSegments(track, 1, 30)
    // The sort happens on a fresh array, never on `captions.segments` itself.
    assert.deepEqual(track, before)
    assert.deepEqual(track.segments.map(s => s.id), ['top', 'bottom'])
  })

  test('returns a fresh array each call, holding the original segment objects', () => {
    const track = { segments: [{ id: 'a', start: 0, end: 1 }] }
    const a = activeCaptionSegments(track, 0.5, 30)
    const b = activeCaptionSegments(track, 0.5, 30)
    assert.notEqual(a, b, 'a caller may sort/splice the result without affecting the next call')
    assert.equal(a[0], b[0], 'the segments inside are the originals, not clones')
    assert.equal(a[0], track.segments[0])
  })
})
