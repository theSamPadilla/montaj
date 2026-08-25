// render/test/resolver-parity.test.mjs
/**
 * CROSS-ENGINE PARITY GATE for `planSegments` (SP2 T7).
 *
 * `segment-plan.js` used to own the boundary pipeline, the containment
 * predicate and the overlay ordering outright. It now delegates all three to
 * `@bycrux/timeline-core`. This file is the permanent gate that keeps the
 * delegation honest — it stays in the tree forever, not just for the swap.
 *
 * ── Why three implementations, not two ──────────────────────────────────────
 *
 * The obvious harness ("run legacy, run the resolver, compare") stops meaning
 * anything the moment `planSegments` IS the resolver: it degenerates into
 * comparing X to X. So this file compares THREE independent things on every
 * case:
 *
 *   1. `legacyPlanSegments` — a FROZEN, verbatim copy of the pre-T7
 *      `segment-plan.js` algorithm, inlined below. It imports nothing. It is
 *      the reference implementation and it never changes. See its banner.
 *   2. `resolverPlanSegments` — the wrapper composed here, in the test, from
 *      the `@bycrux/timeline-core` LEVEL-1 primitives (`boundariesFrom`,
 *      `activeIn`, `captionsLast`, `byTrackIdx`). This is the canonical shape
 *      `src/activation.js`'s module header prescribes for T7.
 *   3. `planSegments` — whatever `../segment-plan.js` actually ships today.
 *
 * All three must produce deep-equal plans. Each pair carries its own meaning:
 *
 *   (1) vs (3) — the real gate. Frozen legacy behavior vs. the shipped
 *                production function. Post-swap this is legacy-vs-resolver:
 *                the only comparison that can still catch the resolver
 *                drifting away from what render used to do. A change to
 *                `@bycrux/timeline-core` that alters segment planning fails
 *                HERE.
 *   (1) vs (2) — pins the resolver primitives themselves against frozen
 *                legacy, independently of how `segment-plan.js` happens to be
 *                written. This is the comparison that GATED the swap.
 *   (2) vs (3) — pins that the shipped wrapper is still the canonical
 *                primitive composition and has not quietly grown its own
 *                logic back.
 *
 * (1) is the load-bearing one. If someone "fixes" the frozen copy to match a
 * new resolver behavior, the gate is gone — hence the banner on it.
 *
 * ── What the cases are ──────────────────────────────────────────────────────
 *
 * • EVERY fixture in `@bycrux/timeline-core/fixtures` (13 of them), × fps
 *   ∈ {24, 30, 60}, pushed through the REAL `collectAllItems` /
 *   `collectPuppeteerSegments` from `render.js` and merged exactly the way
 *   `compose.js:64` merges them (`[...imageItems, ...videoItems]` — the tie
 *   order KNOWN-DIVERGENCES.md D7 describes is baked in right here). No
 *   fixture is hand-picked or skipped; a skipped fixture is a hole in the gate.
 *
 * • SYNTHETIC PROJECTS, also pushed through the real collectors. The corpus is
 *   a resolver corpus, not a render corpus: it has NO project with captions,
 *   only one with an opaque overlay, and none that puts an image and a video
 *   on the same track. Those paths would go completely untested on the corpus
 *   alone, so they are authored here. They depend on no media files, same as
 *   the corpus.
 *
 * • RAW-ARRAY CASES for the two shapes the collectors structurally cannot
 *   emit: a caption segment appearing BEFORE overlays in the input array
 *   (real render always pushes the caption spec last, so the captions-last
 *   partition is a no-op there and would never actually be exercised), and
 *   items missing optional fields.
 *
 * ── Vacuousness guards ──────────────────────────────────────────────────────
 *
 * A green harness that compared zero segments would be worthless, so the run
 * counts what it actually exercised and the last test asserts floors on those
 * counts. See `EXERCISED` / the "harness is not vacuous" test.
 *
 * ── Documented divergences ──────────────────────────────────────────────────
 *
 * Two inputs make legacy and the resolver legitimately disagree. They are NOT
 * papered over and they are NOT in the parity table — they get their own
 * tests, at the bottom, that pin the difference in both directions. Neither is
 * reachable from `compose.js`. See those tests for the full argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

import { boundariesFrom, activeIn, captionsLast, byTrackIdx } from '@bycrux/timeline-core'
import { planSegments } from '../segment-plan.js'
import { collectAllItems, collectPuppeteerSegments } from '../render.js'

// The corpus ships INSIDE @bycrux/timeline-core (`files` lists fixtures/), so
// resolve it through the package rather than by a hardcoded node_modules path:
// this keeps working whether the dependency is the `file:../timeline-core`
// symlink it is today or a real installed tarball later, and it doesn't break
// if npm ever hoists the package somewhere other than render/node_modules.
// Same resolution encode-args-golden.test.mjs uses.
const require = createRequire(import.meta.url)
const FIXTURE_DIR = join(dirname(require.resolve('@bycrux/timeline-core')), 'fixtures')

/** The frame rates every case is run at. */
const RATES = [24, 30, 60]

// ---------------------------------------------------------------------------
// (1) The frozen legacy reference
// ---------------------------------------------------------------------------

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LEGACY REFERENCE, FROZEN AT SP2 T7 — DO NOT "FIX" THIS FUNCTION.          │
 * │                                                                           │
 * │ A verbatim copy of `segment-plan.js`'s algorithm as it stood BEFORE it    │
 * │ delegated to @bycrux/timeline-core. It deliberately imports nothing: it   │
 * │ is the independent yardstick this whole file exists to measure against.   │
 * │                                                                           │
 * │ If a change to the resolver makes this disagree with `planSegments`, the  │
 * │ correct response is to fix the RESOLVER or to consciously record a new    │
 * │ divergence — never to edit this copy into agreement. Editing it deletes   │
 * │ the gate.                                                                 │
 * │                                                                           │
 * │ The three behaviors it pins, each recording a real production bug (the    │
 * │ full reasoning lives in `segment-plan.js` and, verbatim, in               │
 * │ `@bycrux/timeline-core/src/activation.js`):                               │
 * │   • quantize to the frame grid  — the freeze-and-pop / drift bug          │
 * │   • floor every boundary at 0   — the "black top for the first ~0.3s" bug │
 * │   • dedupe by INTEGER FRAME     — the IEEE-754 cancellation bug (never an │
 * │                                   epsilon/gap test)                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function legacyPlanSegments(allItems, puppeteerSegs, vw, vh, fps) {
  const frameDur = 1 / fps
  const quantize = t => Math.round(t * fps) / fps
  const boundary = t => Math.max(0, quantize(t))

  const boundaries = new Set()
  for (const item of allItems) {
    boundaries.add(boundary(item.start))
    boundaries.add(boundary(item.end))
  }
  for (const seg of puppeteerSegs) {
    boundaries.add(boundary(seg.startSeconds))
    boundaries.add(boundary(seg.endSeconds))
  }

  if (boundaries.size === 0) return []

  const frameOf = t => Math.round(t * fps)
  const sorted = [...boundaries].sort((a, b) => a - b)
  const snapped = [sorted[0]]
  let lastFrame = frameOf(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const f = frameOf(sorted[i])
    if (f === lastFrame) continue
    snapped.push(sorted[i])
    lastFrame = f
  }

  const segments = []

  for (let i = 0; i < snapped.length - 1; i++) {
    const start = snapped[i]
    const end = snapped[i + 1]

    const items = allItems
      .filter(v => v.start <= start + frameDur && v.end >= end - frameDur)
      .sort((a, b) => a.trackIdx - b.trackIdx)

    const activeOverlays = puppeteerSegs.filter(
      s => s.startSeconds <= start + frameDur && s.endSeconds >= end - frameDur
    )
    const overlays = [
      ...activeOverlays.filter(o => !o.isCaption),
      ...activeOverlays.filter(o => o.isCaption),
    ]

    const hasOpaque = overlays.some(o => o.opaque)

    segments.push({ start, end, items, opaqueVideo: hasOpaque, overlays, vw, vh, fps })
  }

  return segments
}

// ---------------------------------------------------------------------------
// (2) The resolver composition, written here rather than imported
// ---------------------------------------------------------------------------

/**
 * The canonical LEVEL-1 wrapper from `@bycrux/timeline-core/src/activation.js`'s
 * module header, composed independently of `../segment-plan.js` so that
 * comparison (2) vs (3) stays a real check on the shipped file.
 */
const readPuppeteer = s => ({ start: s.startSeconds, end: s.endSeconds })

function resolverPlanSegments(allItems, puppeteerSegs, vw, vh, fps) {
  const snapped = boundariesFrom(
    [
      ...allItems.map(i => ({ start: i.start, end: i.end })),
      ...puppeteerSegs.map(readPuppeteer),
    ],
    fps,
  )

  const segments = []
  for (let i = 0; i < snapped.length - 1; i++) {
    const start = snapped[i]
    const end = snapped[i + 1]
    const items = activeIn(allItems, start, end, fps).sort(byTrackIdx)
    const overlays = captionsLast(activeIn(puppeteerSegs, start, end, fps, readPuppeteer))
    segments.push({
      start,
      end,
      items,
      opaqueVideo: overlays.some(o => o.opaque),
      overlays,
      vw,
      vh,
      fps,
    })
  }
  return segments
}

// ---------------------------------------------------------------------------
// compose.js-shaped inputs
// ---------------------------------------------------------------------------

/**
 * Build the exact pair of arrays `compose.js` hands `planSegments`, using the
 * real collectors from `render.js`:
 *
 *   render.js:249-250  segmentSpecs = collectPuppeteerSegments(...)
 *                      { imageItems, videoItems } = collectAllItems(...)
 *   compose.js:64      allItems = [...imageItems, ...videoItems]
 *
 * `segDir` only ever reaches `join()` inside the collector, so a fake path is
 * fine and nothing here touches the filesystem or needs real media.
 */
function composeInputs(project, fps, vw, vh) {
  const { imageItems, videoItems } = collectAllItems(project)
  const puppeteerSegs = collectPuppeteerSegments(project, fps, vw, vh, '/parity/segments')
  return { allItems: [...imageItems, ...videoItems], puppeteerSegs }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * The plan projected down to the things the plan document names — segment
 * bounds, item ids AND ORDER, overlay ids AND ORDER, opaqueVideo flags, canvas.
 * Compared in addition to (not instead of) the whole-plan deep-equal, purely so
 * a failure reports something a human can read.
 */
function shapeOf(plan) {
  return plan.map(s => ({
    start: s.start,
    end: s.end,
    itemIds: s.items.map(i => i.id),
    overlayIds: s.overlays.map(o => o.id),
    opaqueVideo: s.opaqueVideo,
    vw: s.vw,
    vh: s.vh,
    fps: s.fps,
  }))
}

/**
 * `deepStrictEqual` short-circuits on reference equality, so it alone cannot
 * tell "the same object" from "a structurally identical clone". Object IDENTITY
 * is load-bearing here — `compose.js:95` mutates `seg.colorSpace`, and
 * `encode-segment.js` reads fields off the very objects `collectAllItems`
 * produced — so it gets its own explicit `===` check.
 */
function assertIdentity(label, plan, allItems, puppeteerSegs) {
  const items = new Set(allItems)
  const overlays = new Set(puppeteerSegs)
  for (const seg of plan) {
    for (const it of seg.items) {
      assert.ok(items.has(it), `${label}: seg [${seg.start},${seg.end}] item ${it.id} is a COPY, not the input object`)
    }
    for (const ov of seg.overlays) {
      assert.ok(overlays.has(ov), `${label}: seg [${seg.start},${seg.end}] overlay ${ov.id} is a COPY, not the input object`)
    }
  }
}

/** What the run actually exercised — see the "harness is not vacuous" test. */
const EXERCISED = {
  cases: 0,
  segments: 0,
  fixtures: new Set(),
  casesWithOverlays: 0,
  casesWithOpaqueSegment: 0,
  casesWithCaption: 0,
  casesWithMultiItemSegment: 0,
  emptyPlans: 0,
}

/** Run one case through all three implementations and require they agree. */
function assertParity(label, allItems, puppeteerSegs, vw, vh, fps) {
  const legacy = legacyPlanSegments(allItems, puppeteerSegs, vw, vh, fps)
  const resolver = resolverPlanSegments(allItems, puppeteerSegs, vw, vh, fps)
  const shipped = planSegments(allItems, puppeteerSegs, vw, vh, fps)

  // (1) vs (3) — the permanent gate: frozen legacy vs. what render ships.
  assert.deepStrictEqual(shapeOf(shipped), shapeOf(legacy),
    `${label}: shipped planSegments diverged from the FROZEN LEGACY reference`)
  assert.deepStrictEqual(shipped, legacy,
    `${label}: shipped planSegments diverged from the FROZEN LEGACY reference (full plan)`)

  // (1) vs (2) — the resolver primitives themselves vs. frozen legacy.
  assert.deepStrictEqual(shapeOf(resolver), shapeOf(legacy),
    `${label}: resolver composition diverged from the FROZEN LEGACY reference`)
  assert.deepStrictEqual(resolver, legacy,
    `${label}: resolver composition diverged from the FROZEN LEGACY reference (full plan)`)

  // (2) vs (3) — the shipped wrapper is still the canonical composition.
  assert.deepStrictEqual(shapeOf(shipped), shapeOf(resolver),
    `${label}: shipped planSegments diverged from the canonical resolver composition`)

  assertIdentity(label, shipped, allItems, puppeteerSegs)

  EXERCISED.cases++
  EXERCISED.segments += shipped.length
  if (shipped.length === 0) EXERCISED.emptyPlans++
  if (shipped.some(s => s.overlays.length > 0)) EXERCISED.casesWithOverlays++
  if (shipped.some(s => s.opaqueVideo)) EXERCISED.casesWithOpaqueSegment++
  if (shipped.some(s => s.overlays.some(o => o.isCaption))) EXERCISED.casesWithCaption++
  if (shipped.some(s => s.items.length > 1)) EXERCISED.casesWithMultiItemSegment++

  return shipped
}

// ---------------------------------------------------------------------------
// Corpus: every fixture, every rate
// ---------------------------------------------------------------------------

const FIXTURES = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json')).sort()

test('corpus: the fixture directory is actually populated', () => {
  // Guards against the harness silently passing because the `file:` link broke
  // or the corpus moved — a zero-fixture loop is green and meaningless.
  assert.ok(FIXTURES.length >= 13,
    `expected the SP2 corpus (13 fixtures) at ${FIXTURE_DIR}, found ${FIXTURES.length}`)
})

for (const name of FIXTURES) {
  test(`corpus parity: ${name}`, () => {
    const project = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
    const [vw, vh] = project.settings?.resolution ?? [1080, 1920]
    for (const fps of RATES) {
      const { allItems, puppeteerSegs } = composeInputs(project, fps, vw, vh)
      assertParity(`${name} @${fps}fps`, allItems, puppeteerSegs, vw, vh, fps)
    }
    EXERCISED.fixtures.add(name)
  })
}

// ---------------------------------------------------------------------------
// Synthetic projects — the render-shaped paths the resolver corpus never hits
// ---------------------------------------------------------------------------

const settings = { fps: 30, resolution: [1080, 1920], colorSpace: 'sdr_bt709' }
const vid = (id, start, end, extra = {}) =>
  ({ id, type: 'video', src: `/synthetic/${id}.mp4`, start, end, inPoint: 0, outPoint: end - start, ...extra })
const img = (id, start, end, extra = {}) =>
  ({ id, type: 'image', src: `/synthetic/${id}.jpg`, start, end, ...extra })
const ovl = (id, start, end, extra = {}) =>
  ({ id, type: 'overlay', src: `/synthetic/${id}.jsx`, start, end, ...extra })

/**
 * Every one of these is a real `project.json` shape run through the real
 * collectors, so it exercises `collectPuppeteerSegments`' overlay quantization
 * and caption span (KNOWN-DIVERGENCES.md D6) exactly as production does.
 */
const SYNTHETIC_PROJECTS = {
  // The corpus has NO fixture with captions at all, so without this the
  // isCaption path — the caption spec, its [0, totalSecs] span, and the
  // captions-last partition — is never planned.
  'captions-only': {
    settings,
    tracks: [[vid('c1', 0, 6)]],
    captions: { style: 'clean', segments: [{ start: 0, end: 3, text: 'hello' }, { start: 3, end: 6, text: 'world' }] },
  },

  // Captions AND overlays together: the caption spans the whole timeline while
  // two overlays come and go under it, so several segments carry a mixed
  // overlay list that the partition has to order.
  'captions-and-overlays': {
    settings,
    tracks: [
      [vid('c1', 0, 10)],
      [ovl('ovA', 1, 4), ovl('ovB', 3, 7)],
    ],
    captions: { style: 'pop', segments: [{ start: 0, end: 10, text: 'caption' }] },
  },

  // An opaque overlay overlapping a non-opaque one, plus a segment where only
  // the non-opaque survives: pins `opaqueVideo = overlays.some(o => o.opaque)`
  // per-segment rather than per-plan. The corpus's single opaque fixture has
  // no second overlay to confuse it with.
  'opaque-and-translucent-overlap': {
    settings,
    tracks: [
      [vid('base', 0, 12)],
      [ovl('opaqueOv', 2, 6, { opaque: true }), ovl('softOv', 4, 9, { opaque: false })],
    ],
  },

  // Image + video sharing trackIdx 0. `compose.js:64`'s `[...imageItems,
  // ...videoItems]` merge is what decides the tie (KNOWN-DIVERGENCES.md D7),
  // and no corpus fixture has two items on one track with different kinds.
  'same-trackidx-image-and-video': {
    settings,
    tracks: [[vid('v0', 0, 8), img('i0', 0, 8)]],
  },

  // Three stacked tracks: the byTrackIdx ordering has something to actually
  // order, over segments where the stack changes depth.
  'multi-track-stack': {
    settings,
    tracks: [
      [img('bg', 0, 10)],
      [vid('pip', 2, 8, { scale: 0.3, offsetX: 30, offsetY: 30 })],
      [ovl('badge', 4, 6)],
    ],
  },

  // The "black top for the first ~0.3s" shape with BOTH a negative-start
  // overlay and a negative-start visual item (the corpus's negative-start
  // fixture only has the overlay).
  'negative-start-item-and-overlay': {
    settings,
    tracks: [
      [vid('clip', 0, 5, { inPoint: 0.5, outPoint: 5.5 })],
      [ovl('reel', -0.5, 5)],
      [vid('preRoll', -2, 1)],
    ],
  },

  // Sub-frame floats straight off the editor — the freeze-and-pop case.
  'subframe-boundaries': {
    settings,
    tracks: [[vid('c1', 0, 1.875), vid('c2', 1.875, 4.7177), vid('c3', 4.7177, 8.0)]],
  },

  // Boundaries one frame apart at 30fps but NOT at 24 or 60 — the integer-frame
  // dedupe has to make a different call at each rate.
  'adjacent-frames-with-overlay': {
    settings,
    tracks: [
      [vid('c1', 0, 4.8061), vid('c2', 4.8061, 8.0)],
      [ovl('ovUrl', 2.7, 4.75), ovl('ovTerm', 5.0, 7.0)],
    ],
  },

  // Degenerates: a zero-length item, an item entirely before the origin, and a
  // project with nothing on any track.
  'zero-length-item': { settings, tracks: [[vid('c1', 0, 4), vid('pop', 4, 4), vid('c2', 4, 7)]] },
  'entirely-before-zero': { settings, tracks: [[vid('ghost', -3, -1)], [ovl('ghostOv', -2, -0.5)]] },
  'empty-project': { settings, tracks: [[]] },
  'no-tracks-at-all': { settings },
}

for (const [name, project] of Object.entries(SYNTHETIC_PROJECTS)) {
  test(`synthetic project parity: ${name}`, () => {
    const [vw, vh] = project.settings?.resolution ?? [1080, 1920]
    for (const fps of RATES) {
      const { allItems, puppeteerSegs } = composeInputs(project, fps, vw, vh)
      assertParity(`${name} @${fps}fps`, allItems, puppeteerSegs, vw, vh, fps)
    }
  })
}

// ---------------------------------------------------------------------------
// Raw-array cases — shapes the collectors structurally cannot emit
// ---------------------------------------------------------------------------

const pupp = (id, startSeconds, endSeconds, extra = {}) =>
  ({ id, componentPath: `/synthetic/${id}.jsx`, startSeconds, endSeconds, opaque: false, isCaption: false, ...extra })

const RAW_CASES = {
  // `collectPuppeteerSegments` always pushes the caption spec LAST, so on real
  // input the captions-last partition is a no-op and never proves anything.
  // Feeding the caption FIRST is the only way to actually exercise it — and to
  // catch a "sort" being substituted for the stable two-filter partition.
  'caption-first-in-input': {
    allItems: [{ id: 'c1', type: 'video', src: '/a.mp4', start: 0, end: 10, trackIdx: 0 }],
    puppeteerSegs: [
      pupp('cap', 0, 10, { isCaption: true }),
      pupp('ovA', 0, 10),
      pupp('ovB', 0, 10),
    ],
  },

  // Two captions plus two overlays, interleaved: a `sort` on isCaption would
  // pass the single-caption case above and fail this one's relative order.
  'interleaved-captions-and-overlays': {
    allItems: [{ id: 'c1', type: 'video', src: '/a.mp4', start: 0, end: 10, trackIdx: 0 }],
    puppeteerSegs: [
      pupp('capA', 0, 10, { isCaption: true }),
      pupp('ovA', 0, 10),
      pupp('capB', 0, 10, { isCaption: true }),
      pupp('ovB', 0, 10),
    ],
  },

  // Descending trackIdx in the input array — the sort has real work to do
  // rather than confirming the collector's own ordering.
  'descending-trackidx-input': {
    allItems: [
      { id: 'top', type: 'overlay', src: '/t.mp4', start: 0, end: 5, trackIdx: 4 },
      { id: 'mid', type: 'video', src: '/m.mp4', start: 0, end: 5, trackIdx: 2 },
      { id: 'bot', type: 'image', src: '/b.jpg', start: 0, end: 5, trackIdx: 0 },
    ],
    puppeteerSegs: [],
  },

  // Ties at every trackIdx, input order shuffled: pins that BOTH sorts are
  // stable and agree on the tiebreak.
  'trackidx-ties': {
    allItems: [
      { id: 'a', start: 0, end: 5, trackIdx: 1 },
      { id: 'b', start: 0, end: 5, trackIdx: 0 },
      { id: 'c', start: 0, end: 5, trackIdx: 1 },
      { id: 'd', start: 0, end: 5, trackIdx: 0 },
      { id: 'e', start: 0, end: 5, trackIdx: 1 },
    ],
    puppeteerSegs: [],
  },

  // No items at all but overlays present — the plan is driven entirely by
  // overlay boundaries and every segment has an empty items array.
  'overlays-without-items': {
    allItems: [],
    puppeteerSegs: [pupp('ovA', 1, 3), pupp('ovB', 2, 5, { opaque: true })],
  },

  // Both arrays empty: the `boundaries.size === 0 → []` early return.
  'both-empty': { allItems: [], puppeteerSegs: [] },

  // An overlay whose window is shorter than one frame at 24fps but not at 60 —
  // the containment predicate's ±frameDur slack behaves differently per rate.
  'sub-frame-overlay': {
    allItems: [{ id: 'c1', type: 'video', src: '/a.mp4', start: 0, end: 4, trackIdx: 0 }],
    puppeteerSegs: [pupp('blink', 2.0, 2.02)],
  },
}

for (const [name, { allItems, puppeteerSegs }] of Object.entries(RAW_CASES)) {
  test(`raw-array parity: ${name}`, () => {
    for (const fps of RATES) {
      assertParity(`${name} @${fps}fps`, allItems, puppeteerSegs, 1080, 1920, fps)
    }
  })
}

// ---------------------------------------------------------------------------
// Documented legacy-vs-resolver divergences — pinned, not papered over
// ---------------------------------------------------------------------------

test('divergence (KNOWN-DIVERGENCES D4): non-finite endpoints — resolver drops, legacy emits NaN', () => {
  // `boundariesFrom`'s `finiteOr0` maps a missing/non-finite start or end to 0;
  // legacy's `boundary(undefined)` is `Math.max(0, NaN)` = NaN, which lands in
  // the boundary set and reaches the encoder as a literal `-t NaN`. Adopting
  // the resolver adopts the guard.
  //
  // UNREACHABLE FROM `compose.js`: every item `collectAllItems` emits copies
  // `start`/`end` straight off a schema-required field, and every one of the 13
  // corpus fixtures is well-formed — NO corpus fixture exercises this, which is
  // why it is pinned here explicitly instead of being left to chance.
  const malformed = [{ id: 'bad', start: 0, end: undefined, trackIdx: 0 }]

  const legacy = legacyPlanSegments(malformed, [], 1080, 1920, 30)
  assert.equal(legacy.length, 1, 'legacy emits a segment for the malformed item')
  assert.ok(Number.isNaN(legacy[0].end), 'legacy segment end is NaN (the poisoned boundary)')

  const resolver = resolverPlanSegments(malformed, [], 1080, 1920, 30)
  assert.deepStrictEqual(resolver, [], 'the resolver drops the malformed item from boundary space')

  // `segment-plan.js` delegates, so it takes the resolver's side.
  assert.deepStrictEqual(planSegments(malformed, [], 1080, 1920, 30), resolver,
    'planSegments must follow the resolver guard, not legacy NaN')
})

test('divergence: an item with NO trackIdx sorts differently (byTrackIdx treats it as 0)', () => {
  // Legacy's comparator is `a.trackIdx - b.trackIdx`, which yields NaN against a
  // missing trackIdx; per ECMA-262 SortCompare a NaN result is coerced to +0, so
  // the pair is treated as EQUAL and input order survives. `byTrackIdx` uses
  // `(a.trackIdx ?? 0) - (b.trackIdx ?? 0)`, so the missing one sorts as track 0
  // and moves to the back of the stack.
  //
  // UNREACHABLE FROM `compose.js`: `collectAllItems` (render.js:597) stamps
  // `trackIdx` on every item it emits, unconditionally, and it is the only
  // producer of the array `compose.js` passes in. Pinned here so the difference
  // is recorded rather than discovered.
  const items = [
    { id: 'onTrack5', start: 0, end: 5, trackIdx: 5 },
    { id: 'noTrackIdx', start: 0, end: 5 },
  ]

  const legacy = legacyPlanSegments(items, [], 1080, 1920, 30)
  assert.deepStrictEqual(legacy[0].items.map(i => i.id), ['onTrack5', 'noTrackIdx'],
    'legacy keeps input order (NaN comparator ⇒ treated equal)')

  const shipped = planSegments(items, [], 1080, 1920, 30)
  assert.deepStrictEqual(shipped[0].items.map(i => i.id), ['noTrackIdx', 'onTrack5'],
    'byTrackIdx reads the missing trackIdx as 0 and puts it furthest back')

  // Everything else about the plan is unchanged — the divergence is ordering
  // only, not boundaries or activation.
  assert.equal(shipped.length, legacy.length)
  assert.equal(shipped[0].start, legacy[0].start)
  assert.equal(shipped[0].end, legacy[0].end)
})

// ---------------------------------------------------------------------------
// Divergences that are INERT here — confirmed empirically, not by argument
// ---------------------------------------------------------------------------

test('inert (KNOWN-DIVERGENCES D5): a track-0 overlay reaches neither input array', () => {
  // The resolver's PROJECT-shaped path honours an overlay on track 0; render
  // does not. That cannot reach this file: `collectAllItems` (render.js:599-601)
  // only emits image/video items, and `collectPuppeteerSegments` (render.js:503)
  // slices tracks from 1. `planSegments` is fed those two arrays and nothing
  // else, so the divergence is structurally out of reach — asserted here rather
  // than assumed, because the whole swap rests on it.
  const project = {
    settings,
    tracks: [
      [vid('c1', 0, 6), ovl('track0Overlay', 1, 3, { opaque: true })],
      [ovl('track1Overlay', 2, 4)],
    ],
  }
  const { allItems, puppeteerSegs } = composeInputs(project, 30, 1080, 1920)

  assert.deepStrictEqual(allItems.map(i => i.id), ['c1'],
    'collectAllItems must not emit the track-0 overlay')
  assert.deepStrictEqual(puppeteerSegs.map(s => s.id), ['overlay-0--track1Overlay'],
    'collectPuppeteerSegments must see only tracks 1+')

  // The track-0 overlay contributes no boundary at 1s or 3s and never appears.
  const plan = assertParity('d5-track0-overlay', allItems, puppeteerSegs, 1080, 1920, 30)
  assert.deepStrictEqual(plan.map(s => [s.start, s.end]), [[0, 2], [2, 4], [4, 6]])
  assert.ok(plan.every(s => !s.opaqueVideo),
    'the track-0 overlay\'s opaque flag must have no effect')
})

test('inert (KNOWN-DIVERGENCES D7): compose.js decides the same-trackIdx tie, not planSegments', () => {
  // `[...imageItems, ...videoItems]` puts ALL images before ALL videos on a
  // shared trackIdx, regardless of document order. Both sorts are stable, so
  // neither the legacy comparator nor `byTrackIdx` disturbs it — the tie is
  // settled before `planSegments` is called. Authored here video-FIRST so that a
  // plan echoing document order would be visibly different.
  const project = { settings, tracks: [[vid('vidFirst', 0, 8), img('imgSecond', 0, 8)]] }
  const { allItems, puppeteerSegs } = composeInputs(project, 30, 1080, 1920)

  assert.deepStrictEqual(allItems.map(i => i.id), ['imgSecond', 'vidFirst'],
    'compose.js-shaped merge hoists the image ahead of the video')
  assert.deepStrictEqual(allItems.map(i => i.trackIdx), [0, 0], 'both share trackIdx 0')

  const plan = assertParity('d7-tie-order', allItems, puppeteerSegs, 1080, 1920, 30)
  assert.deepStrictEqual(plan[0].items.map(i => i.id), ['imgSecond', 'vidFirst'],
    'the stable sort preserves the merge order the tie was decided by')
})

// ---------------------------------------------------------------------------
// Vacuousness guards
// ---------------------------------------------------------------------------

test('harness is not vacuous', () => {
  // node:test runs the tests in a file in declaration order, so by the time this
  // one runs every case above has contributed to EXERCISED. The floors are set
  // just under the counts observed when this gate was written (T7): they exist
  // to catch cases silently vanishing, not to be re-tuned upward on every edit.
  // Printed BEFORE the assertions so a failing floor still reports the full
  // picture, and so a passing run reports what it covered — a green gate whose
  // coverage quietly halved is otherwise invisible.
  console.log('[resolver-parity] exercised:', {
    fixtures: EXERCISED.fixtures.size,
    cases: EXERCISED.cases,
    segments: EXERCISED.segments,
    casesWithOverlays: EXERCISED.casesWithOverlays,
    casesWithOpaqueSegment: EXERCISED.casesWithOpaqueSegment,
    casesWithCaption: EXERCISED.casesWithCaption,
    casesWithMultiItemSegment: EXERCISED.casesWithMultiItemSegment,
    emptyPlans: EXERCISED.emptyPlans,
  })

  assert.equal(EXERCISED.fixtures.size, FIXTURES.length,
    `every corpus fixture must be exercised (${EXERCISED.fixtures.size}/${FIXTURES.length})`)
  // Observed at T7: cases 96, segments 203, overlays 35, opaque 9, caption 12,
  // multi-item 15, empty 12.
  assert.ok(EXERCISED.cases >= 90, `too few parity cases run: ${EXERCISED.cases}`)
  assert.ok(EXERCISED.segments >= 180, `too few segments compared: ${EXERCISED.segments}`)
  assert.ok(EXERCISED.casesWithOverlays >= 30,
    `too few cases produced overlays: ${EXERCISED.casesWithOverlays}`)
  assert.ok(EXERCISED.casesWithOpaqueSegment >= 8,
    `too few cases produced an opaqueVideo segment: ${EXERCISED.casesWithOpaqueSegment}`)
  assert.ok(EXERCISED.casesWithCaption >= 9,
    `too few cases produced a caption overlay: ${EXERCISED.casesWithCaption}`)
  assert.ok(EXERCISED.casesWithMultiItemSegment >= 12,
    `too few cases produced a segment with >1 item (byTrackIdx never ordered anything): ${EXERCISED.casesWithMultiItemSegment}`)
  assert.ok(EXERCISED.emptyPlans >= 6,
    `the empty-plan path was never exercised: ${EXERCISED.emptyPlans}`)
})
