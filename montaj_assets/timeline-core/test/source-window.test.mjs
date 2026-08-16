// montaj_assets/timeline-core/test/source-window.test.mjs
//
// T2 suite for the source-window math. This is the fidelity contract for the
// port of two legacy implementations:
//
//   (1) editor preview — montaj_assets/editor/src/video/preview/useVideoPlayback.ts:29-88
//       (playbackSrcFor / effectiveInPoint / effectiveOutPoint), whose own tests
//       live at .../preview/__tests__/useVideoPlayback.test.ts
//   (2) render          — montaj_assets/render/render.js:605-632 (inside collectAllItems),
//       whose own tests live at montaj_assets/render/test/render-helpers.test.mjs:73-127
//
// EVERY numeric case in those two suites has a counterpart here with the SAME
// numbers, so a reviewer can confirm the port is faithful from the tests alone
// and the legacy functions become deletable-by-inspection (T6 / T8).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceWindow, playbackSrcFor, seekTime, synthesizedOutPoint } from '../index.js'

/** Both variants, for the many cases where preview and render must agree. */
const VARIANTS = ['preview', 'render']

/** Float compare — the rebase is a subtraction, so 1e-9 is plenty. */
function closeTo(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}: expected a number, got ${typeof actual}`)
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ~${expected}, got ${actual}`,
  )
}

// ---------------------------------------------------------------------------
// Fixture registry — every item shape exercised below is registered here so the
// totality sweep at the bottom can assert the invariants over ALL of them.
// ---------------------------------------------------------------------------
/** @type {Array<{name: string, item: object}>} */
const ALL_FIXTURES = []
function fixture(name, item) {
  ALL_FIXTURES.push({ name, item })
  return item
}

// ---------------------------------------------------------------------------
// 1. Bug A — trim-after-cache, verbatim numbers
//    mirrors useVideoPlayback.test.ts:32-44 + :69-76 and render-helpers.test.mjs:91-103
// ---------------------------------------------------------------------------

const BUG_A = fixture('bug-a-trim-after-cache', {
  id: 'v',
  type: 'video',
  src: '/orig.mp4',
  normalizedSrc: '/orig_norm.mp4',
  normalizedInPoint: 0,
  start: 0,
  end: 16.0543,
  inPoint: 0.9157,
  outPoint: 16.97,
})

describe('Bug A: trim-after-cache (cache origin 0, inPoint trimmed to 0.9157)', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: rebases by normalizedInPoint=0, so inPoint stays 0.9157 and outPoint stays 16.97 (NOT 16.97-0.9157)`, () => {
      const w = sourceWindow(BUG_A, variant)
      assert.equal(w.src, '/orig_norm.mp4')
      assert.equal(w.usedNormalizedCache, true)
      closeTo(w.inPoint, 0.9157, `${variant} inPoint`)
      closeTo(w.outPoint, 16.97, `${variant} outPoint`)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Legacy clips with no normalizedInPoint → origin defaults to inPoint → rebase to 0
//    mirrors useVideoPlayback.test.ts:11-14 + :48-53 and render-helpers.test.mjs:73-89
// ---------------------------------------------------------------------------

const LEGACY_CACHE_RENDER = fixture('legacy-cache-render-numbers', {
  id: 'primary',
  type: 'video',
  src: '/orig.mp4',
  normalizedSrc: '/orig_normalized_hdr.mp4',
  start: 0,
  end: 5,
  inPoint: 3.5,
  outPoint: 8.5,
})

const LEGACY_CACHE_EDITOR = fixture('legacy-cache-editor-numbers', {
  inPoint: 496.92,
  outPoint: 514.92,
  normalizedSrc: '/cache/window.mp4',
})

describe('Legacy cache without normalizedInPoint: origin = inPoint → rebase to 0', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: inPoint 3.5 / outPoint 8.5 → 0 / 5.0 (render-helpers.test.mjs:73-89 numbers)`, () => {
      const w = sourceWindow(LEGACY_CACHE_RENDER, variant)
      assert.equal(w.src, '/orig_normalized_hdr.mp4')
      assert.equal(w.usedNormalizedCache, true)
      closeTo(w.inPoint, 0, `${variant} inPoint`)
      closeTo(w.outPoint, 5.0, `${variant} outPoint`)
    })

    test(`${variant}: inPoint 496.92 / outPoint 514.92 → 0 / 18 (useVideoPlayback.test.ts:11-14,48-53 numbers)`, () => {
      const w = sourceWindow(LEGACY_CACHE_EDITOR, variant)
      assert.equal(w.usedNormalizedCache, true)
      closeTo(w.inPoint, 0, `${variant} inPoint`)
      closeTo(w.outPoint, 18, `${variant} outPoint`)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Non-zero cache origin
//    mirrors useVideoPlayback.test.ts:40-44 and :78-82
// ---------------------------------------------------------------------------

const NONZERO_ORIGIN = fixture('nonzero-cache-origin', {
  inPoint: 6,
  outPoint: 20,
  normalizedInPoint: 5,
  normalizedSrc: '/cache/window.mp4',
})

describe('Non-zero cache origin (normalizedInPoint 5)', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: inPoint 6 → 1 and outPoint 20 → 15`, () => {
      const w = sourceWindow(NONZERO_ORIGIN, variant)
      assert.equal(w.usedNormalizedCache, true)
      closeTo(w.inPoint, 1, `${variant} inPoint`)
      closeTo(w.outPoint, 15, `${variant} outPoint`)
    })
  }
})

// ---------------------------------------------------------------------------
// 4. No cache at all → everything passes through untouched
//    mirrors useVideoPlayback.test.ts:16-18 + :55-57 and render-helpers.test.mjs:104-114
// ---------------------------------------------------------------------------

const NO_CACHE = fixture('no-cache', {
  id: 'primary',
  type: 'video',
  src: '/orig.mp4',
  start: 0,
  end: 5,
  inPoint: 3.5,
  outPoint: 8.5,
})

const NO_CACHE_EDITOR = fixture('no-cache-editor-numbers', {
  inPoint: 496.92,
  outPoint: 514.92,
  src: '/orig.mov',
})

describe('No normalizedSrc: src and in/outPoint pass through unchanged', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: src '/orig.mp4', inPoint 3.5, outPoint 8.5 survive verbatim`, () => {
      const w = sourceWindow(NO_CACHE, variant)
      assert.equal(w.src, '/orig.mp4')
      assert.equal(w.usedNormalizedCache, false)
      assert.equal(w.inPoint, 3.5)
      assert.equal(w.outPoint, 8.5)
    })

    test(`${variant}: inPoint 496.92 / outPoint 514.92 survive verbatim (editor numbers)`, () => {
      const w = sourceWindow(NO_CACHE_EDITOR, variant)
      assert.equal(w.src, '/orig.mov')
      assert.equal(w.usedNormalizedCache, false)
      assert.equal(w.inPoint, 496.92)
      assert.equal(w.outPoint, 514.92)
    })
  }
})

// ---------------------------------------------------------------------------
// 5. No inPoint and no cache → 0 (not undefined, not NaN)
//    mirrors useVideoPlayback.test.ts:27-29
// ---------------------------------------------------------------------------

const NO_INPOINT_NO_CACHE = fixture('no-inpoint-no-cache', { src: '/orig.mov', start: 0, end: 4 })

describe('Missing inPoint with no cache', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: defaults to 0, not undefined`, () => {
      const w = sourceWindow(NO_INPOINT_NO_CACHE, variant)
      assert.equal(w.inPoint, 0)
      assert.equal(w.usedNormalizedCache, false)
    })
  }
})

// ---------------------------------------------------------------------------
// 6. Absent outPoint → undefined in the result (both variants)
//    mirrors useVideoPlayback.test.ts:65-67
// ---------------------------------------------------------------------------

const NO_OUTPOINT_CACHED = fixture('no-outpoint-cached', {
  inPoint: 496.92,
  normalizedSrc: '/cache/window.mp4',
  start: 0,
  end: 18,
})

const NULL_OUTPOINT = fixture('null-outpoint', {
  src: '/orig.mov',
  inPoint: 2,
  outPoint: null,
  start: 1,
  end: 6,
})

describe('Absent outPoint', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: undefined outPoint stays undefined (caller synthesizes)`, () => {
      const w = sourceWindow(NO_OUTPOINT_CACHED, variant)
      assert.equal(w.outPoint, undefined)
    })

    test(`${variant}: null outPoint is normalized to undefined (legacy '== null' check)`, () => {
      const w = sourceWindow(NULL_OUTPOINT, variant)
      assert.equal(w.outPoint, undefined)
    })

    test(`${variant}: synthesizedOutPoint fills the gap from (end - start)`, () => {
      // cached: effective inPoint 0 (legacy origin = inPoint) + (18 - 0) = 18
      closeTo(synthesizedOutPoint(NO_OUTPOINT_CACHED, variant), 18, `${variant} synthesized`)
      // uncached: inPoint 2 + (6 - 1) = 7
      closeTo(synthesizedOutPoint(NULL_OUTPOINT, variant), 7, `${variant} synthesized`)
    })
  }
})

// ---------------------------------------------------------------------------
// 7. nobg divergence matrix — 2x2x2 over {remove_bg} x {nobg_src} x {nobg_preview_src},
//    always with a normalizedSrc present.
//
//    Registry: KNOWN-DIVERGENCES.md entry "nobg precedence" (owner: SP4).
//    The headline row is remove_bg + nobg_src WITHOUT nobg_preview_src:
//    preview takes the (rebased) normalized cache while render takes the
//    (un-rebased) nobg ProRes. That is a real, currently-shipping divergence;
//    SP2 documents it, it does not fix it.
//
//    Expectations below are written out literally rather than derived, so this
//    table is a specification and not a second implementation.
// ---------------------------------------------------------------------------

const CACHE_SRC = '/cache/win.mp4'
const NOBG_SRC = '/orig_nobg.mov'
const NOBG_PREVIEW_SRC = '/orig_nobg.webm'
const MATRIX_BASE = {
  id: 'v',
  type: 'video',
  src: '/orig.mov',
  normalizedSrc: CACHE_SRC,
  normalizedInPoint: 5,
  inPoint: 6, // rebased -> 1
  outPoint: 20, // rebased -> 15
  start: 0,
  end: 14,
}
const REBASED = { inPoint: 1, outPoint: 15, usedNormalizedCache: true }
const RAW = { inPoint: 6, outPoint: 20, usedNormalizedCache: false }

const NOBG_MATRIX = [
  {
    label: 'remove_bg=F nobg_src=- nobg_preview_src=-',
    flags: {},
    preview: { src: CACHE_SRC, ...REBASED },
    render: { src: CACHE_SRC, ...REBASED },
  },
  {
    label: 'remove_bg=F nobg_src=- nobg_preview_src=set',
    flags: { nobg_preview_src: NOBG_PREVIEW_SRC },
    preview: { src: NOBG_PREVIEW_SRC, ...RAW },
    render: { src: CACHE_SRC, ...REBASED },
  },
  {
    label: 'remove_bg=F nobg_src=set nobg_preview_src=-',
    flags: { nobg_src: NOBG_SRC },
    // render ignores nobg_src unless remove_bg is also true
    preview: { src: CACHE_SRC, ...REBASED },
    render: { src: CACHE_SRC, ...REBASED },
  },
  {
    label: 'remove_bg=F nobg_src=set nobg_preview_src=set',
    flags: { nobg_src: NOBG_SRC, nobg_preview_src: NOBG_PREVIEW_SRC },
    preview: { src: NOBG_PREVIEW_SRC, ...RAW },
    render: { src: CACHE_SRC, ...REBASED },
  },
  {
    label: 'remove_bg=T nobg_src=- nobg_preview_src=-',
    flags: { remove_bg: true },
    // no nobg_src to choose, so render falls back to the cache
    preview: { src: CACHE_SRC, ...REBASED },
    render: { src: CACHE_SRC, ...REBASED },
  },
  {
    label: 'remove_bg=T nobg_src=- nobg_preview_src=set',
    flags: { remove_bg: true, nobg_preview_src: NOBG_PREVIEW_SRC },
    preview: { src: NOBG_PREVIEW_SRC, ...RAW },
    render: { src: CACHE_SRC, ...REBASED },
  },
  {
    label:
      'remove_bg=T nobg_src=set nobg_preview_src=-  <<< HEADLINE DIVERGENCE (KNOWN-DIVERGENCES.md: nobg precedence)',
    flags: { remove_bg: true, nobg_src: NOBG_SRC },
    preview: { src: CACHE_SRC, ...REBASED }, // rebased cache
    render: { src: NOBG_SRC, ...RAW }, // un-rebased full-source ProRes
  },
  {
    label: 'remove_bg=T nobg_src=set nobg_preview_src=set',
    flags: { remove_bg: true, nobg_src: NOBG_SRC, nobg_preview_src: NOBG_PREVIEW_SRC },
    // Both variants skip the cache here — by design: the preview WebM and the
    // render ProRes are both FULL-source alpha artifacts, so neither rebases.
    preview: { src: NOBG_PREVIEW_SRC, ...RAW },
    render: { src: NOBG_SRC, ...RAW },
  },
]

describe('nobg divergence matrix (2x2x2, normalizedSrc always present)', () => {
  for (const row of NOBG_MATRIX) {
    const item = fixture(`nobg-matrix: ${row.label}`, { ...MATRIX_BASE, ...row.flags })
    for (const variant of VARIANTS) {
      const want = row[variant]
      test(`${variant} | ${row.label} -> src ${want.src}, ${want.usedNormalizedCache ? 'rebased' : 'NOT rebased'}`, () => {
        const w = sourceWindow(item, variant)
        assert.equal(w.src, want.src)
        assert.equal(w.usedNormalizedCache, want.usedNormalizedCache)
        closeTo(w.inPoint, want.inPoint, `${variant} inPoint`)
        closeTo(w.outPoint, want.outPoint, `${variant} outPoint`)
        // playbackSrcFor is the src-selection half of the same decision
        assert.equal(playbackSrcFor(item, variant), want.src)
      })
    }
  }

  test('headline divergence is asserted head-to-head: preview rebases, render does not', () => {
    const item = { ...MATRIX_BASE, remove_bg: true, nobg_src: NOBG_SRC }
    const preview = sourceWindow(item, 'preview')
    const render = sourceWindow(item, 'render')
    assert.notEqual(preview.src, render.src)
    assert.equal(preview.usedNormalizedCache, true)
    assert.equal(render.usedNormalizedCache, false)
    assert.notEqual(preview.inPoint, render.inPoint)
  })
})

// Named mirrors of the two legacy suites' nobg cases, with their own numbers.
describe('nobg cases mirrored from the legacy suites', () => {
  const EDITOR_NOBG = fixture('editor-nobg-precedence', {
    inPoint: 496.92,
    outPoint: 514.92,
    nobg_preview_src: '/nobg.webm',
    normalizedSrc: '/c.mp4',
  })

  test('preview: nobg_preview_src beats normalizedSrc and is NOT rebased (useVideoPlayback.test.ts:20-25,59-63)', () => {
    const w = sourceWindow(EDITOR_NOBG, 'preview')
    assert.equal(w.src, '/nobg.webm')
    assert.equal(w.usedNormalizedCache, false)
    assert.equal(w.inPoint, 496.92)
    assert.equal(w.outPoint, 514.92)
  })

  const RENDER_NOBG = fixture('render-nobg-not-rebased', {
    id: 'v',
    type: 'video',
    src: '/orig.mp4',
    nobg_src: '/orig_nobg.mov',
    remove_bg: true,
    normalizedSrc: '/orig_normalized_hdr.mp4',
    start: 0,
    end: 5,
    inPoint: 2.0,
    outPoint: 7.0,
  })

  test('render: nobg_src path is NOT rebased even with normalizedSrc present (render-helpers.test.mjs:116-127)', () => {
    const w = sourceWindow(RENDER_NOBG, 'render')
    assert.equal(w.src, '/orig_nobg.mov')
    assert.equal(w.usedNormalizedCache, false)
    assert.equal(w.inPoint, 2.0)
    assert.equal(w.outPoint, 7.0)
  })
})

// ---------------------------------------------------------------------------
// 8. THE NaN FIX — the single sanctioned behavior change in T2.
//    Today render.js:613 computes `item.normalizedInPoint ?? item.inPoint` with
//    no `?? 0` tail, so a normalizedSrc item carrying NEITHER origin field sends
//    NaN into ffmpeg's -ss. Both variants now tail with `?? 0`.
// ---------------------------------------------------------------------------

const NAN_CASE = fixture('nan-fix-cache-with-no-origin-fields', { normalizedSrc: '/c.mp4' })
const NAN_CASE_WITH_OUT = fixture('nan-fix-cache-with-outpoint-only', {
  normalizedSrc: '/c.mp4',
  outPoint: 4,
  start: 0,
  end: 4,
})

describe('NaN fix: normalizedSrc with neither normalizedInPoint nor inPoint', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: inPoint is 0, never NaN (fixes render.js:613 missing '?? 0' tail)`, () => {
      const w = sourceWindow(NAN_CASE, variant)
      assert.equal(w.usedNormalizedCache, true)
      assert.equal(w.inPoint, 0)
      assert.equal(Number.isNaN(w.inPoint), false)
      assert.equal(Number.isFinite(w.inPoint), true)
    })

    test(`${variant}: outPoint is also finite (4 - 0), never NaN`, () => {
      const w = sourceWindow(NAN_CASE_WITH_OUT, variant)
      assert.equal(w.outPoint, 4)
      assert.equal(Number.isNaN(w.outPoint), false)
    })

    test(`${variant}: seekTime over the NaN fixture stays finite`, () => {
      const t = seekTime(NAN_CASE_WITH_OUT, 2, variant)
      assert.equal(Number.isNaN(t), false)
      assert.equal(t, 2)
    })
  }
})

// ---------------------------------------------------------------------------
// 8b. Preserved legacy quirk: an item with NO src at all.
//     render.js:612 is `chosenSrc === item.normalizedSrc`; when both are
//     undefined that comparison is TRUE, so render rebases (to 0) while preview
//     (guarded on `!!normalizedSrc`) does not. Ported verbatim on purpose — the
//     item is already unrenderable, and T8's encode-args golden must not shift.
// ---------------------------------------------------------------------------

const NO_SRC_AT_ALL = fixture('degenerate-no-src-at-all', {
  id: 'v',
  type: 'video',
  inPoint: 4,
  outPoint: 9,
  start: 0,
  end: 5,
})

describe('Degenerate item with no src, no normalizedSrc (locks in the preview/render split)', () => {
  test("render: 'undefined === undefined' makes usedNormalizedCache true → rebases to 0, and src stays undefined (render.js:611 has no '?? \"\"' tail)", () => {
    const w = sourceWindow(NO_SRC_AT_ALL, 'render')
    assert.equal(w.usedNormalizedCache, true)
    assert.equal(w.inPoint, 0)
    assert.equal(w.outPoint, 5)
    // Render deliberately preserves undefined: '' and undefined fail
    // DIFFERENTLY downstream (item.src.split('/'), existsSync(item.src)), and
    // collectAllItems' output must stay byte-identical for T8's golden.
    assert.equal(w.src, undefined)
    assert.equal(playbackSrcFor(NO_SRC_AT_ALL, 'render'), undefined)
  })

  test("preview: guard is '!!normalizedSrc', so no rebase — inPoint passes through, and src is '' (useVideoPlayback.ts:30 tail)", () => {
    const w = sourceWindow(NO_SRC_AT_ALL, 'preview')
    assert.equal(w.usedNormalizedCache, false)
    assert.equal(w.inPoint, 4)
    assert.equal(w.outPoint, 9)
    assert.equal(w.src, '')
    assert.equal(playbackSrcFor(NO_SRC_AT_ALL, 'preview'), '')
  })
})

// ---------------------------------------------------------------------------
// 9. seekTime — sourceWindow().inPoint + max(0, t - item.start)
//    (useVideoPlayback.ts:680 and encode-segment.js:217-218 are the same formula)
// ---------------------------------------------------------------------------

const SEEK_OFFSET_CLIP = fixture('seek-offset-clip-starting-at-10', {
  src: '/orig.mov',
  inPoint: 100,
  outPoint: 120,
  start: 10,
  end: 30,
})

describe('seekTime', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: t before item.start clamps the offset to 0`, () => {
      closeTo(seekTime(SEEK_OFFSET_CLIP, 4, variant), 100, `${variant} seek`)
      closeTo(seekTime(SEEK_OFFSET_CLIP, -5, variant), 100, `${variant} seek`)
    })

    test(`${variant}: t exactly at item.start returns the effective inPoint`, () => {
      closeTo(seekTime(SEEK_OFFSET_CLIP, 10, variant), 100, `${variant} seek`)
    })

    test(`${variant}: t mid-clip adds the elapsed offset`, () => {
      closeTo(seekTime(SEEK_OFFSET_CLIP, 17.5, variant), 107.5, `${variant} seek`)
    })

    test(`${variant}: with a normalized cache the offset is added to the REBASED inPoint`, () => {
      // Bug A: effective inPoint 0.9157, start 0
      closeTo(seekTime(BUG_A, 0, variant), 0.9157, `${variant} seek`)
      closeTo(seekTime(BUG_A, 5, variant), 5.9157, `${variant} seek`)
      closeTo(seekTime(BUG_A, -2, variant), 0.9157, `${variant} seek`)
    })

    test(`${variant}: an item with no start field treats start as 0`, () => {
      // NONZERO_ORIGIN has no start; effective inPoint 1
      closeTo(seekTime(NONZERO_ORIGIN, 3, variant), 4, `${variant} seek`)
    })
  }

  test('preview vs render diverge on the headline nobg row (rebased vs not)', () => {
    const item = { ...MATRIX_BASE, remove_bg: true, nobg_src: NOBG_SRC }
    closeTo(seekTime(item, 2, 'preview'), 3, 'preview seek') // 1 + 2
    closeTo(seekTime(item, 2, 'render'), 8, 'render seek') // 6 + 2
  })
})

// ---------------------------------------------------------------------------
// 10. synthesizedOutPoint — outPoint ?? (effective inPoint + (end - start))
// ---------------------------------------------------------------------------

const SYNTH_NO_OUTPOINT_UNCACHED = fixture('synth-no-outpoint-uncached', {
  src: '/o.mov',
  inPoint: 2,
  start: 1,
  end: 6,
})

const SYNTH_NO_OUTPOINT_CACHED = fixture('synth-no-outpoint-cached', {
  normalizedSrc: '/c.mp4',
  normalizedInPoint: 5,
  inPoint: 6,
  start: 0,
  end: 4,
})

const SYNTH_NOTHING = fixture('synth-no-inpoint-no-outpoint', { src: '/o.mov', start: 0, end: 3 })

describe('synthesizedOutPoint', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: a stored outPoint passes through (rebased when the cache is in play)`, () => {
      closeTo(synthesizedOutPoint(NO_CACHE, variant), 8.5, `${variant} synth`)
      closeTo(synthesizedOutPoint(BUG_A, variant), 16.97, `${variant} synth`)
    })

    test(`${variant}: absent outPoint synthesizes inPoint + (end - start)`, () => {
      closeTo(synthesizedOutPoint(SYNTH_NO_OUTPOINT_UNCACHED, variant), 7, `${variant} synth`)
    })

    test(`${variant}: the synthesized branch builds on the EFFECTIVE inPoint, not the raw one`, () => {
      // effective inPoint 1 (6 - origin 5) + (4 - 0) = 5.
      // NOTE: cuts.ts:121 would give 6 + 4 = 10 because it works in ORIGINAL
      // source coordinates. That difference is intentional; see the module doc.
      closeTo(synthesizedOutPoint(SYNTH_NO_OUTPOINT_CACHED, variant), 5, `${variant} synth`)
      assert.notEqual(synthesizedOutPoint(SYNTH_NO_OUTPOINT_CACHED, variant), 10)
    })

    test(`${variant}: neither inPoint nor outPoint → 0 + (end - start)`, () => {
      closeTo(synthesizedOutPoint(SYNTH_NOTHING, variant), 3, `${variant} synth`)
    })
  }
})

// ---------------------------------------------------------------------------
// 11. Variant validation — a bad variant is a programming bug, not a fallback
// ---------------------------------------------------------------------------

describe('variant validation', () => {
  for (const bad of ['Preview', 'RENDER', '', 'proxy', undefined, null, 0, {}]) {
    test(`sourceWindow throws on variant ${JSON.stringify(bad) ?? String(bad)}`, () => {
      assert.throws(() => sourceWindow(NO_CACHE, bad), TypeError)
    })
  }

  test('playbackSrcFor / seekTime / synthesizedOutPoint throw on a bad variant too', () => {
    assert.throws(() => playbackSrcFor(NO_CACHE, 'nope'), TypeError)
    assert.throws(() => seekTime(NO_CACHE, 1, 'nope'), TypeError)
    assert.throws(() => synthesizedOutPoint(NO_CACHE, 'nope'), TypeError)
  })
})

// ---------------------------------------------------------------------------
// 12. Purity + totality sweeps over every fixture registered above
// ---------------------------------------------------------------------------

describe('purity', () => {
  test('sourceWindow never mutates its input item', () => {
    for (const { name, item } of ALL_FIXTURES) {
      const before = structuredClone(item)
      for (const variant of VARIANTS) {
        sourceWindow(item, variant)
        seekTime(item, 7, variant)
        synthesizedOutPoint(item, variant)
        playbackSrcFor(item, variant)
      }
      assert.deepEqual(item, before, `fixture "${name}" was mutated`)
    }
  })

  test('two calls with the same input return deep-equal results', () => {
    for (const { name, item } of ALL_FIXTURES) {
      for (const variant of VARIANTS) {
        assert.deepEqual(
          sourceWindow(item, variant),
          sourceWindow(item, variant),
          `fixture "${name}" (${variant}) is not deterministic`,
        )
      }
    }
  })

  test('the returned object is a fresh value, not shared state', () => {
    const a = sourceWindow(BUG_A, 'preview')
    const b = sourceWindow(BUG_A, 'preview')
    assert.notEqual(a, b)
    a.inPoint = 999
    assert.equal(sourceWindow(BUG_A, 'preview').inPoint, b.inPoint)
  })
})

describe('totality', () => {
  test('every fixture yields a finite inPoint, for both variants; preview additionally always yields a string src', () => {
    assert.ok(ALL_FIXTURES.length >= 20, `expected a broad fixture set, got ${ALL_FIXTURES.length}`)
    for (const { name, item } of ALL_FIXTURES) {
      for (const variant of VARIANTS) {
        const w = sourceWindow(item, variant)
        assert.equal(Number.isFinite(w.inPoint), true, `${name} (${variant}): inPoint not finite`)
        // Preview's totality guarantee is STRONGER than render's by design:
        // useVideoPlayback.ts:30 tails its chain with `?? ''`, render.js:611
        // does not, so only render may hand back undefined (and only for an
        // item that has no src field at all).
        assert.ok(
          typeof w.src === 'string' || (variant === 'render' && w.src === undefined),
          `${name} (${variant}): src must be a string (undefined allowed for render only), got ${String(w.src)}`,
        )
        const half = playbackSrcFor(item, variant)
        assert.ok(
          typeof half === 'string' || (variant === 'render' && half === undefined),
          `${name} (${variant}): playbackSrcFor shape, got ${String(half)}`,
        )
        assert.equal(typeof w.usedNormalizedCache, 'boolean', `${name} (${variant}): flag not boolean`)
        if (w.outPoint !== undefined) {
          assert.equal(Number.isFinite(w.outPoint), true, `${name} (${variant}): outPoint not finite`)
        }
        assert.equal(
          Number.isFinite(seekTime(item, 3, variant)),
          true,
          `${name} (${variant}): seekTime not finite`,
        )
        assert.equal(
          Number.isFinite(synthesizedOutPoint(item, variant)),
          true,
          `${name} (${variant}): synthesizedOutPoint not finite`,
        )
      }
    }
  })

  test('playbackSrcFor agrees with sourceWindow().src for every fixture', () => {
    for (const { name, item } of ALL_FIXTURES) {
      for (const variant of VARIANTS) {
        assert.equal(
          playbackSrcFor(item, variant),
          sourceWindow(item, variant).src,
          `fixture "${name}" (${variant}): src halves disagree`,
        )
      }
    }
  })
})
