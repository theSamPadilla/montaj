// montaj_assets/render/test/encode-args-golden.test.mjs
//
// THE RENDER-OUTPUT-UNCHANGED GATE (SP2 T5 + T8).
//
// SP2 moved render's timeline arithmetic into @bycrux/timeline-core. The whole
// bet of that migration is that the bytes ffmpeg is asked to produce do not
// change. This file is how that bet is checked, permanently:
//
//     post-swap collectAllItems + planSegments + encodeSegment(..., {_dryRun:true})
//         must deep-equal
//     expected/encode-args.<fixture>.json, captured by T5 from the PRE-T7 pipeline
//
// The goldens are the *legacy* pipeline's output, frozen before segment-plan.js
// (T7) or collectAllItems (T8) were touched. Comparing today's fully-swapped
// pipeline against them is a direct, end-to-end "the encoder gets identical
// arguments" assertion — not resolver-vs-resolver, which would be tautological.
//
// WHY THIS LIVES IN render/, NOT timeline-core/ (SP2 T8, part 4A):
// T5 originally ran this comparison from timeline-core/test/corpus.test.mjs,
// which imported it from scripts/regen-goldens.mjs, which imported
// ../../render/{render,segment-plan,encode-segment}.js. That made
// timeline-core's "zero runtime deps, hermetic suite" claim false: `npm test`
// in timeline-core pulled in puppeteer + esbuild and — after T7 made
// segment-plan.js import @bycrux/timeline-core — resolved the package back
// through render/node_modules, a genuine cycle. The comparison always belonged
// on the render side of the boundary (the plan's atomized table assigns this
// file to "T5+T8"); moving it here closes the cycle. timeline-core's
// scripts/regen-goldens.mjs is now pure resolver-only and imports no render code.
//
// WHY IT NEEDS NO ffmpeg AND IS FULLY DETERMINISTIC:
// `encodeSegment(..., {_dryRun: true})` returns `{inputs, filterParts, args}`
// without touching ffmpeg or the disk. Verified line by line against
// encode-segment.js — those are the only four side-effecting paths in the
// function:
//   `const zscaleAvailable = opts._dryRun ? true : hasZscale()` and the
//   `lut3dAvailable` line beside it
//         — pin the HDR→SDR filter choice; no `ffmpeg -filters` subprocess.
//   `if (!opts._dryRun) mkdirSync(dirname(outputPath), ...)`
//         — outputPath is a fixed `/corpus/...` literal and is never created;
//           it only appears as a string at the tail of `args`.
//   `item.hasAudio ?? (opts._dryRun || fileHasAudio(item.src))`
//         — assumes audio present; no ffprobe subprocess.
//   `runFfmpeg(...)` — unreachable: the dry-run branch returns first.
// Every `src` in the corpus is a plausible-but-nonexistent `/corpus/...` path,
// and `item.colorTransfer` is never stamped by collectAllItems (render.js does
// that in a separate ffprobe pass), so `detectFromTransfer(undefined)` always
// yields the project's own default color space. Nothing machine-specific can
// leak in — the determinism test below asserts that rather than assuming it.
//
// ONE STANDING HAZARD, if a future fixture is ever added to the corpus: an
// HDR-source fixture WOULD leak a machine-specific string. Its conversion step
// is the Montaj Vivid chain, which embeds `lut3d=file=<absolute path to
// montaj_assets/luts/*.cube>` — a path that differs on every checkout. Adding
// an HDR fixture therefore needs the golden to normalize that path first. The
// determinism test below will not catch it (the path is stable within one
// machine); a second machine would be the one to find out.
//
// IF THIS FAILS: render output changed. That is the alarm this file exists to
// raise. Do NOT regenerate the goldens to make it green — regenerating destroys
// the signal forever (see the freeze banner at the bottom of this file). Find
// what changed in collectAllItems / planSegments / encode-segment.js first.
//
// ── 2026-08-17 · SP6b (Vivid pipeline integration) — deliberate render change,
//    goldens legitimately UNCHANGED ────────────────────────────────────────────
// SP6b changed the segment encoder's HDR→SDR behavior on purpose, in two ways:
//
//   1. LUT migration. `buildColorConversionFilter`'s HDR→SDR arm no longer
//      emits `zscale=t=linear…tonemap=hable:desat=0…`; it emits the Montaj
//      Vivid chain (`zscale=matrixin=2020_ncl:rangein=limited:range=full,
//      format=rgb48le,lut3d=file=<cube>:interp=tetrahedral,zscale=tin=bt709:
//      t=bt709:pin=bt709:p=bt709:m=bt709:rin=full:r=tv`), with a PQ→HLG
//      pre-step for PQ sources.
//      The old chains survive only as fallbacks for builds missing lut3d/zscale.
//
//   2. Step reordering in `buildVideoItemFilterParts`. The conversion moved
//      from the head of the per-item chain to between scale and pad, so
//      tone-mapping runs on canvas-sized frames instead of full-resolution
//      ones (a 4K source feeding a 1080 canvas was paying ~9× the pixels).
//
// Either would normally trip this gate. Neither did, and that is the correct
// outcome rather than a missed alarm: BOTH corpus fixtures are `sdr_bt709`
// projects whose items carry no `colorTransfer`, so `buildColorConversionFilter`
// returns `''` for every item and there has never been a conversion step in
// these goldens to change. With an empty conversion step the reorder is a
// no-op on the emitted string — `setpts,crop,scale,pad` either way.
//
// Verified, not assumed: post-change the gate passed untouched, and the
// compare-only regenerator (`MONTAJ_UNFREEZE_ENCODE_ARGS_GOLDENS=1 node
// test/encode-args-golden.test.mjs --regen`) reported both files `unchanged —
// already current, not rewritten`, with `git diff` on expected/ empty. No
// fixture was regenerated and no mtime moved. The HDR behavior this SP actually
// changed is covered where it can be exercised for real instead: the chain and
// ordering assertions in encode-segment.test.mjs, and the aspect-mismatched HLG
// integration fixture in sample-frame.test.mjs, which proves letterbox bars
// still come out black through the new order.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { collectAllItems, collectPuppeteerSegments } from '../render.js'
import { planSegments } from '../segment-plan.js'
import { encodeSegment } from '../encode-segment.js'

// The corpus ships INSIDE @bycrux/timeline-core (`files` lists fixtures/ and
// expected/), so resolve it through the package rather than by relative path:
// this keeps working whether the dependency is the `file:../timeline-core`
// symlink it is today or a real installed tarball later.
const require = createRequire(import.meta.url)
const CORE_ROOT = dirname(require.resolve('@bycrux/timeline-core'))
const FIXTURES_DIR = join(CORE_ROOT, 'fixtures')
const EXPECTED_DIR = join(CORE_ROOT, 'expected')

/**
 * The fixtures T5 captured legacy encode-args goldens for.
 *
 * `source-crop` is the mandatory one (Bug B — the sourceCrop/sourceWidth/
 * sourceHeight whitelist fields, which is exactly what T8's swap risks
 * dropping). `source-crop-missing-dims` is the cheap companion that evidences
 * the `sourcecrop-missing-dims-silent-drop` registry entry: its golden contains
 * no `crop=` filter step at all.
 *
 * `opaque-overlay` is deliberately absent. Its overlay needs a `webmPath` that
 * only renderer.js's real headless-browser render produces, so capturing it
 * would mean inventing a field the pipeline derives from a non-deterministic
 * subprocess. The opaqueVideo dry-run behavior is covered hand-built, with no
 * project dependency, in encode-segment.test.mjs.
 *
 * `geometry-non-identity` (SP9a-1 T1) closes the blind spot the other two
 * fixtures share: both use identity geometry (`scale: 1, offsetX: 0,
 * offsetY: 0`), where `xPx = yPx = 0` and the scaled box collapses to the
 * full canvas, so neither exercises the scale/offset arithmetic at all. This
 * fixture carries a video item (`scale: 0.62, offsetX: 12.5, offsetY: -7.25`)
 * and an image item (`scale: 1.35, offsetX: -20, offsetY: 8`) on a
 * non-square canvas, so a transposed w/h or x/y formula would be caught. It
 * deliberately carries NO overlay item — see :121-131 above for why an
 * overlay would freeze a `null` (`ov.webmPath`) into the golden permanently.
 * Captured pre-refactor, before SP9a-1 T2-T4 swapped the call sites onto
 * @bycrux/timeline-core's `toPixelBox`, so this golden is the proof that the
 * swap changes no bytes for non-identity geometry either.
 */
export const ENCODE_ARGS_FIXTURES = ['source-crop', 'source-crop-missing-dims', 'geometry-non-identity']

/**
 * Run the REAL render pipeline over one corpus fixture in dry-run mode.
 *
 * This is the render-dependent half of what used to be
 * timeline-core/scripts/regen-goldens.mjs "Part C". It is both what the gate
 * below compares and what the (frozen) regenerator at the bottom would write.
 *
 * @param {string} fixtureName bare name, no `.json`
 * @returns {Promise<object>} the golden object
 */
export async function buildEncodeArgsGolden(fixtureName) {
  const project = JSON.parse(readFileSync(join(FIXTURES_DIR, `${fixtureName}.json`), 'utf8'))
  const { settings } = project
  const fps = settings.fps
  const [vw, vh] = settings.resolution

  const { imageItems, videoItems } = collectAllItems(project)
  const allItems = [...imageItems, ...videoItems] // compose.js:64 tie order, reproduced verbatim
  const puppeteerSegs = collectPuppeteerSegments(project, fps, vw, vh, '/corpus/render-output.segments')
  const segments = planSegments(allItems, puppeteerSegs, vw, vh, fps)

  const encoded = []
  for (let i = 0; i < segments.length; i++) {
    const outputPath = `/corpus/render-output/segment-${i}.mp4`
    const result = await encodeSegment(segments[i], outputPath, { _dryRun: true })
    encoded.push({ start: segments[i].start, end: segments[i].end, outputPath, ...result })
  }

  return { fixture: fixtureName, fps, vw, vh, segments: encoded }
}

function readGolden(fixtureName) {
  return JSON.parse(readFileSync(join(EXPECTED_DIR, `encode-args.${fixtureName}.json`), 'utf8'))
}

/**
 * The goldens are JSON on disk, and JSON.stringify drops keys whose value is
 * `undefined`. Compare what WOULD be written, not the richer in-memory shape
 * JSON cannot represent — the same round-trip corpus.test.mjs uses, and the
 * correct comparison for a JSON-file golden.
 */
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value))
}

const FAIL_HINT =
  '\n\n  RENDER OUTPUT CHANGED. This golden is the frozen PRE-T7 legacy pipeline\n' +
  '  output; the swap onto @bycrux/timeline-core is supposed to reproduce it\n' +
  '  exactly. Do NOT regenerate to make this pass — regenerating turns the gate\n' +
  '  into resolver-vs-resolver and the signal is gone permanently. Diff\n' +
  '  collectAllItems / planSegments / encode-segment.js against the golden first.'

describe('encode-args golden: post-swap render pipeline == pre-T7 legacy output', () => {
  for (const fixtureName of ENCODE_ARGS_FIXTURES) {
    test(`${fixtureName}: inputs + filterParts + args are byte-identical`, async () => {
      const fresh = jsonRoundTrip(await buildEncodeArgsGolden(fixtureName))
      assert.deepEqual(fresh, readGolden(fixtureName), `fixtures/${fixtureName}.json${FAIL_HINT}`)
    })
  }

  test('the dry-run pipeline is deterministic (same fixture twice → identical args)', async () => {
    // Guards the gate itself: a golden comparison is only meaningful if the
    // thing it compares cannot vary run to run. If a machine-specific path,
    // timestamp or probe result ever leaks into the dry-run path, this fails
    // before anyone is tempted to blame the golden.
    for (const fixtureName of ENCODE_ARGS_FIXTURES) {
      const a = jsonRoundTrip(await buildEncodeArgsGolden(fixtureName))
      const b = jsonRoundTrip(await buildEncodeArgsGolden(fixtureName))
      assert.deepEqual(a, b, `${fixtureName}: dry-run output varies between runs`)
    }
  })

  test('source-crop: the golden actually contains the crop filter the whitelist forwards', async () => {
    // Without this, the gate could pass vacuously if BOTH the golden and the
    // fresh run lost the crop. The golden is frozen and cannot change, so
    // asserting the crop is present in it pins that the comparison above is
    // testing something real about sourceCrop/sourceWidth/sourceHeight.
    const golden = readGolden('source-crop')
    const filters = golden.segments.flatMap((s) => s.filterParts).join('\n')
    assert.match(filters, /crop=/, 'expected a crop= step in the frozen source-crop golden')
  })

  test('source-crop-missing-dims: NO crop filter — the silent drop, frozen [registry: sourcecrop-missing-dims-silent-drop]', async () => {
    // KNOWN-DIVERGENCES.md `sourcecrop-missing-dims-silent-drop`, evidenced end
    // to end. collectAllItems forwards `sourceCrop` faithfully (see
    // render-helpers.test.mjs), but buildVideoItemFilterParts' gate needs
    // sourceWidth/sourceHeight too, so the reframe vanishes with no warning.
    // Documented as expected-for-now; the fix is owned by SP4.
    const golden = readGolden('source-crop-missing-dims')
    const filters = golden.segments.flatMap((s) => s.filterParts).join('\n')
    assert.doesNotMatch(filters, /crop=/, 'the missing-dims silent drop stopped being silent — update the registry')
  })

  test('no frozen golden contains a rotate= step (SP9a-2)', async () => {
    // The goldens are the render-output-unchanged guarantee: they prove
    // rotation support changed NOTHING for pre-existing (unrotated) content.
    // That guarantee passes VACUOUSLY the moment a rotation fixture ever
    // creeps into ENCODE_ARGS_FIXTURES — none of today's corpus fixtures
    // carry a `rotation` field, so none of these frozen goldens should ever
    // contain a `rotate=` filter step. This assertion is what makes the gate
    // honest rather than trusting that omission stays accidental.
    //
    // Do NOT "fix" a failure here by regenerating a golden, and do NOT add a
    // rotation fixture to ENCODE_ARGS_FIXTURES to give this something to
    // pass against — no legitimate golden can exist for a feature that did
    // not exist when these were frozen. Pixel-level rotation-direction
    // coverage lives in rotation.integration.test.mjs, which drives ffmpeg
    // directly and deliberately stays out of this frozen corpus.
    for (const fixtureName of ENCODE_ARGS_FIXTURES) {
      const golden = readGolden(fixtureName)
      const filters = golden.segments.flatMap((s) => s.filterParts).join('\n')
      assert.doesNotMatch(filters, /rotate=/,
        `${fixtureName}: frozen golden unexpectedly contains a rotate= step`)
    }
  })
})

// ---------------------------------------------------------------------------
// The transition golden (clip crossfade, T8)
// ---------------------------------------------------------------------------
//
// WHY THIS IS NOT A MEMBER OF `ENCODE_ARGS_FIXTURES`. That array is the frozen
// PRE-T7 legacy corpus, and the `no frozen golden contains a rotate= step` test
// above spells out the rule this obeys: no legitimate frozen golden can exist
// for a feature that did not exist when those files were captured. Adding
// `clip-crossfade` to the array would mint an `expected/encode-args.*.json`
// from today's pipeline and quietly relabel it "the pre-T7 output", which is
// exactly the tautology the freeze banner exists to prevent. (It would also
// break the freeze-mechanism block below, which asserts a three-element
// `['identical','identical','identical']`.)
//
// So the expectation lives HERE, inline, and it is a golden in the only sense
// that matters: the exact graph, frozen, byte for byte. It runs the same real
// pipeline the frozen corpus does — `collectAllItems` -> `planSegments` ->
// `encodeSegment(..., {_dryRun:true})` — over timeline-core's `clip-crossfade`
// fixture, so it pins the whole chain and not just the encoder's arithmetic.
//
// What makes it worth its length is the segments on either SIDE of the overlap.
// The item objects are shared across every segment they are active in, so the
// outgoing clip reaches [0,3) still carrying its `crossfade` field; if the
// gating were on the field's mere presence rather than on the segment's own
// progress through the span, that segment would carry an audio fade-out ramp
// and the clip would die to silence three seconds before the transition began.

describe('transition golden: a clip crossfade, end to end through the real pipeline', () => {
  const CANVAS = '[0:v]format=yuv420p[canvas]'
  const SETPARAMS = 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709[vout]'
  const fit = (i) =>
    `[${i}:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid${i}]`

  /** @type {Array<{start: number, end: number, filterParts: string[]}>} */
  const EXPECTED = [
    // Before the overlap: clipA alone. No split, no blend, and no audio ramp.
    {
      start: 0, end: 3,
      filterParts: [
        CANVAS,
        fit(1),
        '[canvas][vid1]overlay=x=0:y=0:format=yuv420:shortest=0[iv1]',
        '[1:a:0]atrim=0:3,asetpts=PTS-STARTPTS,volume=1,aformat=channel_layouts=stereo:sample_rates=48000[a1]',
        `[iv1]${SETPARAMS}`,
      ],
    },
    // The overlap. The canvas is split, each clip composites onto its own
    // branch, and the two finished frames are lerped in the FOLDED form. Both
    // clips' audio carries a complementary `volume` ramp (NOT `afade` — it
    // cannot express a partial slice of the span; see the fix's comment in
    // encode-segment.js), which the existing amix sums.
    {
      start: 3, end: 4,
      filterParts: [
        CANVAS,
        '[canvas]split=2[xfa1][xfb1]',
        fit(1),
        '[xfa1][vid1]overlay=x=0:y=0:format=yuv420:shortest=0[iv1]',
        "[1:a:0]atrim=0:1,asetpts=PTS-STARTPTS,volume=1,volume='1-(1*t)':eval=frame,aformat=channel_layouts=stereo:sample_rates=48000[a1]",
        fit(2),
        '[xfb1][vid2]overlay=x=0:y=0:format=yuv420:shortest=0[iv2]',
        "[2:a:0]atrim=0:1,asetpts=PTS-STARTPTS,volume=1,volume='1*t':eval=frame,aformat=channel_layouts=stereo:sample_rates=48000[a2]",
        "[iv1][iv2]blend=all_expr='A+(B-A)*(1*T)'[xf1]",
        `[xf1]${SETPARAMS}`,
        '[a1][a2]amix=inputs=2:duration=longest:normalize=0[amixed]',
      ],
    },
    // After the overlap: clipB alone. Same shape as the first segment.
    {
      start: 4, end: 8,
      filterParts: [
        CANVAS,
        fit(1),
        '[canvas][vid1]overlay=x=0:y=0:format=yuv420:shortest=0[iv1]',
        '[1:a:0]atrim=0:4,asetpts=PTS-STARTPTS,volume=1,aformat=channel_layouts=stereo:sample_rates=48000[a1]',
        `[iv1]${SETPARAMS}`,
      ],
    },
  ]

  test('clip-crossfade: every segment\'s filter graph is byte-identical', async () => {
    const golden = await buildEncodeArgsGolden('clip-crossfade')
    assert.deepEqual(
      golden.segments.map((s) => ({ start: s.start, end: s.end, filterParts: s.filterParts })),
      EXPECTED,
    )
  })

  test('the blend is the FOLDED form — the literal one is a measured regression', async () => {
    // 1.86-2.01x the hard-cut baseline for the literal `A*(1-p)+B*p` on real 4K
    // HDR footage, against a 2x gate, versus 1.35-1.49x for byte-identical
    // output from this form. See the plan's Spike Results. Asserted here as
    // well as in encode-segment.test.mjs because THIS is the file someone reads
    // when they are about to change what the encoder emits.
    const golden = await buildEncodeArgsGolden('clip-crossfade')
    const filters = golden.segments.flatMap((s) => s.filterParts).join('\n')
    assert.match(filters, /blend=all_expr='A\+\(B-A\)\*/)
    assert.doesNotMatch(filters, /A\*\(1-/)
  })

  test('no FROZEN golden grew a split= or blend= step', async () => {
    // The other half of the T8 gate, and the reason this feature could be
    // landed at all: a transition must be invisible to a project that has none.
    // Every one of the three frozen fixtures is butt-joined or single-clip, so
    // none may acquire a split, a blend, or an audio ramp (afade, historically;
    // `,volume='...':eval=frame` now — see the fix's comment in
    // encode-segment.js). If one does, the gating is on the wrong thing — fix
    // the encoder, do not regenerate.
    for (const fixtureName of ENCODE_ARGS_FIXTURES) {
      const filters = readGolden(fixtureName).segments.flatMap((s) => s.filterParts).join('\n')
      assert.doesNotMatch(filters, /split=2|blend=all_expr=|afade=|,volume='/,
        `${fixtureName}: a frozen golden picked up a crossfade step`)
    }
  })
})

// ---------------------------------------------------------------------------
// The freeze mechanism itself (SP2 T8 part 4B, hardened)
// ---------------------------------------------------------------------------
//
// EVERY test below writes to a mkdtemp COPY of the goldens. None of them may
// ever point `planRegeneration` / `applyRegeneration` at the real EXPECTED_DIR
// — testing a destructive path against the artifact it destroys is the exact
// mistake that made this hardening necessary. The last test in the block
// re-hashes the real files as a backstop.

describe('freeze mechanism: identical is a no-op, changed is refused', () => {
  /** Copy the two real goldens into a throwaway dir. Returns its path. */
  function tempGoldenDir() {
    const dir = mkdtempSync(join(tmpdir(), 'montaj-freeze-'))
    for (const name of ENCODE_ARGS_FIXTURES) {
      const f = `encode-args.${name}.json`
      copyFileSync(join(EXPECTED_DIR, f), join(dir, f))
    }
    return dir
  }

  test('bytes identical → status "identical", and applying writes NOTHING (mtime does not move)', async () => {
    // The regression this whole hardening exists for: the old regenerator
    // rewrote byte-identical files, moving their mtimes. After the fact, a
    // moved mtime on a frozen artifact is indistinguishable from a real
    // regeneration and costs someone an afternoon proving it was benign.
    const dir = tempGoldenDir()
    try {
      const before = ENCODE_ARGS_FIXTURES.map((n) => statSync(join(dir, `encode-args.${n}.json`)).mtimeMs)

      const plan = await planRegeneration(dir)
      assert.deepEqual(plan.map((e) => e.status), ['identical', 'identical', 'identical'])

      // Even WITH the override, identical files are not touched.
      const result = applyRegeneration(plan, { allowOverwrite: true })
      assert.equal(result.written.length, 0, 'nothing should be written')
      assert.equal(result.refused.length, 0)
      assert.equal(result.unchanged.length, 3)

      const after = ENCODE_ARGS_FIXTURES.map((n) => statSync(join(dir, `encode-args.${n}.json`)).mtimeMs)
      assert.deepEqual(after, before, 'mtimes moved — a file was opened for writing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bytes differ → REFUSED by default, and the file on disk is left untouched', async () => {
    const dir = tempGoldenDir()
    try {
      const target = join(dir, 'encode-args.source-crop.json')
      const corrupted = readFileSync(target, 'utf8').replace('crop=1536:972:192:54', 'crop=1:2:3:4')
      writeFileSync(target, corrupted)

      const plan = await planRegeneration(dir)
      const byName = Object.fromEntries(plan.map((e) => [e.fixtureName, e]))
      assert.equal(byName['source-crop'].status, 'differs')

      const result = applyRegeneration(plan, { allowOverwrite: false })
      assert.deepEqual(result.refused.map((e) => e.fixtureName), ['source-crop'])
      assert.equal(result.written.length, 0)
      assert.equal(readFileSync(target, 'utf8'), corrupted, 'the refused file was modified anyway')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('gating is PER FILE — a matching fixture stays a no-op while the other is refused', async () => {
    const dir = tempGoldenDir()
    try {
      const changed = join(dir, 'encode-args.source-crop.json')
      const untouched = join(dir, 'encode-args.source-crop-missing-dims.json')
      writeFileSync(changed, readFileSync(changed, 'utf8').replace('crop=1536:972:192:54', 'crop=1:2:3:4'))
      const untouchedMtime = statSync(untouched).mtimeMs

      const result = applyRegeneration(await planRegeneration(dir), { allowOverwrite: false })

      assert.deepEqual(result.refused.map((e) => e.fixtureName), ['source-crop'])
      assert.deepEqual(result.unchanged.map((e) => e.fixtureName), ['source-crop-missing-dims', 'geometry-non-identity'])
      assert.equal(statSync(untouched).mtimeMs, untouchedMtime, 'the matching fixture was touched')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bytes differ + override → writes ONLY the differing file', async () => {
    const dir = tempGoldenDir()
    try {
      const changed = join(dir, 'encode-args.source-crop.json')
      const untouched = join(dir, 'encode-args.source-crop-missing-dims.json')
      writeFileSync(changed, readFileSync(changed, 'utf8').replace('crop=1536:972:192:54', 'crop=1:2:3:4'))
      const untouchedMtime = statSync(untouched).mtimeMs

      const result = applyRegeneration(await planRegeneration(dir), { allowOverwrite: true })

      assert.deepEqual(result.written.map((e) => e.fixtureName), ['source-crop'])
      assert.deepEqual(result.unchanged.map((e) => e.fixtureName), ['source-crop-missing-dims', 'geometry-non-identity'])
      assert.equal(statSync(untouched).mtimeMs, untouchedMtime, 'the matching fixture was rewritten')
      // The overwrite restored it to what the pipeline produces — which, today,
      // is byte-identical to the real committed golden.
      assert.equal(readFileSync(changed, 'utf8'), readFileSync(join(EXPECTED_DIR, 'encode-args.source-crop.json'), 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a MISSING golden is gated like a changed one, not silently recreated', async () => {
    const dir = tempGoldenDir()
    try {
      rmSync(join(dir, 'encode-args.source-crop.json'))
      const plan = await planRegeneration(dir)
      const entry = plan.find((e) => e.fixtureName === 'source-crop')
      assert.equal(entry.status, 'missing')
      assert.equal(entry.current, null)

      const result = applyRegeneration(plan, { allowOverwrite: false })
      assert.deepEqual(result.refused.map((e) => e.fixtureName), ['source-crop'])
      assert.equal(result.written.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('formatDiff shows the erasure as - and the new bytes as +', () => {
    const out = formatDiff('a\nb\nc\n', 'a\nB\nc\n')
    assert.match(out, /^\s+- b$/m, 'the committed line must appear as -')
    assert.match(out, /^\s+\+ B$/m, 'the fresh line must appear as +')
    // Context lines survive so the diff is readable in the banner.
    assert.match(out, /^\s+ {2}a$/m)
  })

  test('the REAL goldens were untouched by every test above', () => {
    // Backstop. If a future edit points one of these tests at EXPECTED_DIR,
    // this fails loudly instead of the damage being discovered by mtime weeks
    // later. The hashes are the frozen pre-T7 artifacts, independently
    // reconstructed from commit 0c5233c.
    const HASHES = {
      'source-crop': '0c4a71dce88f8ca9aebad5c51d265332d4c46d01003b354b9f101fbcc247c042',
      'source-crop-missing-dims': '01df56ae0533552602f97299ab065059317f30012008a9e985c07f1f4cb93b57',
    }
    for (const [name, expected] of Object.entries(HASHES)) {
      const bytes = readFileSync(join(EXPECTED_DIR, `encode-args.${name}.json`))
      const actual = createHash('sha256').update(bytes).digest('hex')
      assert.equal(actual, expected, `expected/encode-args.${name}.json is not the frozen pre-T7 artifact`)
    }
  })
})

// ---------------------------------------------------------------------------
// The freeze (SP2 T8, part 4B)
// ---------------------------------------------------------------------------
//
// expected/encode-args.*.json were captured from the PRE-T7 pipeline. Now that
// the generator IS the resolver, regenerating them would silently downgrade the
// gate above from "render output is unchanged since before SP2" to "the
// resolver agrees with itself" — a test that can never fail and never again
// tells anyone anything.
//
// THE DESTRUCTIVE CASE IS THE HARD ONE. Three guards get you as far as a
// COMPARISON; none of them gets you a write:
//
//   1. not running under `node --test`   (NODE_TEST_CONTEXT unset)
//   2. `--regen`
//   3. MONTAJ_UNFREEZE_ENCODE_ARGS_GOLDENS=1
//
// Past that point the outcome depends on what the comparison finds, per file:
//
//   • BYTES IDENTICAL → nothing is written. Not "written with the same
//     content" — the file is not opened for writing at all, so its mtime does
//     not move. This matters: a moved mtime on a frozen artifact is
//     indistinguishable, after the fact, from a real regeneration, and costs
//     someone an afternoon proving it was benign. Ask me how I know.
//
//   • BYTES DIFFER → REFUSED, with the diff printed, unless a fourth flag is
//     given: --i-am-deliberately-changing-render-output. This is exactly the
//     case where writing destroys the gate, so it is the case that is hard.
//     The flag is spelled out rather than terse on purpose — it should be
//     uncomfortable to type and unmistakable in shell history.
//
// The gating is PER FILE. A fixture whose bytes match is a no-op even when the
// other fixture differs and is refused.
//
// Regeneration is not part of any normal workflow. If the gate above is
// failing, fixing the render code is almost always the correct response.

const FREEZE_ENV = 'MONTAJ_UNFREEZE_ENCODE_ARGS_GOLDENS'
const REGEN_FLAG = '--regen'
const OVERWRITE_FLAG = '--i-am-deliberately-changing-render-output'

const FREEZE_BANNER = `
╔══════════════════════════════════════════════════════════════════════════════╗
║  FROZEN GOLDENS — expected/encode-args.*.json                                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  These two files are NOT snapshots. They are the render pipeline's output    ║
║  captured BEFORE SP2 swapped render onto @bycrux/timeline-core (pre-T7),     ║
║  and they are the ONLY artifact proving the swap did not change what ffmpeg  ║
║  is asked to encode.                                                         ║
║                                                                              ║
║  Regenerating them destroys that proof permanently. The generator is now     ║
║  the resolver, so a regenerated golden only ever says "the resolver agrees   ║
║  with itself" — it can never fail, including across a real regression.       ║
║                                                                              ║
║  If the gate is failing, the answer is almost always to fix the render code, ║
║  not the golden. Regenerate only after deciding, deliberately, that render   ║
║  output SHOULD change, and say so in CHANGELOG.md.                           ║
║                                                                              ║
║  To even COMPARE, from montaj_assets/render/ :                               ║
║                                                                              ║
║  ${`  ${FREEZE_ENV}=1 \\`.padEnd(76)}║
║  ${`    node test/encode-args-golden.test.mjs ${REGEN_FLAG}`.padEnd(76)}║
║                                                                              ║
║  That compares only. Identical bytes are never rewritten; a file whose bytes ║
║  CHANGED is refused and needs a fourth, deliberately awkward flag.           ║
╚══════════════════════════════════════════════════════════════════════════════╝
`

const changedBanner = (names) => `
╔══════════════════════════════════════════════════════════════════════════════╗
║  REFUSED — THE RENDER PIPELINE'S OUTPUT HAS CHANGED                          ║
╠══════════════════════════════════════════════════════════════════════════════╣
${names.map((n) => `║  ${`  • encode-args.${n}.json`.padEnd(76)}║`).join('\n')}
║                                                                              ║
║  The bytes this pipeline produces today no longer match the frozen pre-T7    ║
║  capture. Nothing has been written. Read that sentence again before you      ║
║  reach for the override: this is not a stale snapshot, it is the gate        ║
║  firing, and it is the only moment it will ever fire for this change.        ║
║                                                                              ║
║  Overwriting PERMANENTLY converts the render-output-unchanged gate into a    ║
║  resolver-vs-resolver tautology. After that it compares the current pipeline ║
║  against itself and cannot fail again — not for this regression, and not for ║
║  any future one. There is no undo; the pre-T7 pipeline only still exists     ║
║  because these two files do.                                                 ║
║                                                                              ║
║  Almost always the right move is to fix the render code so the diff below    ║
║  goes away. Overwrite ONLY if you have decided that render output SHOULD     ║
║  change, and record that decision in CHANGELOG.md.                           ║
║                                                                              ║
║  If you are certain, append:                                                 ║
║                                                                              ║
║  ${`    ${OVERWRITE_FLAG}`.padEnd(76)}║
╚══════════════════════════════════════════════════════════════════════════════╝
`

/**
 * Longest-common-subsequence line diff. Small and dependency-free because this
 * file must stay runnable with nothing but the render package installed, and
 * because a positional line-by-line comparison would render garbage the moment
 * a segment is added or removed — precisely the change most worth reading
 * carefully. The goldens are ~90 lines, so the O(n*m) table is free.
 *
 * @param {string} before
 * @param {string} after
 * @returns {Array<[' ' | '-' | '+', string]>}
 */
function lineDiff(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  /** @type {Array<[' ' | '-' | '+', string]>} */
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push([' ', a[i++]]), j++
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(['-', a[i++]])
    else out.push(['+', b[j++]])
  }
  while (i < n) out.push(['-', a[i++]])
  while (j < m) out.push(['+', b[j++]])
  return out
}

/**
 * The changed lines with a little context, capped. `-` is the committed golden
 * (what would be ERASED), `+` is what this pipeline produces now.
 *
 * @param {string} before
 * @param {string} after
 * @param {{ context?: number, maxLines?: number }} [opts]
 * @returns {string}
 */
export function formatDiff(before, after, opts = {}) {
  const context = opts.context ?? 2
  const maxLines = opts.maxLines ?? 60
  const rows = lineDiff(before, after)
  const keep = new Set()
  rows.forEach((r, idx) => {
    if (r[0] === ' ') return
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep.add(k)
  })
  const idxs = [...keep].sort((x, y) => x - y)
  const lines = []
  let prev = -1
  for (const idx of idxs) {
    if (prev >= 0 && idx > prev + 1) lines.push('   …')
    const [sign, text] = rows[idx]
    lines.push(`  ${sign} ${text}`)
    prev = idx
  }
  if (lines.length > maxLines) {
    const shown = lines.slice(0, maxLines)
    shown.push(`   … (${lines.length - maxLines} more diff lines suppressed)`)
    return shown.join('\n')
  }
  return lines.join('\n')
}

/**
 * @typedef {Object} RegenEntry
 * @property {string} fixtureName
 * @property {string} path              absolute path of the golden
 * @property {string} fresh             bytes this pipeline produces now
 * @property {string | null} current    bytes on disk, or null when absent
 * @property {'identical' | 'differs' | 'missing'} status
 */

/**
 * Build the fresh bytes for every frozen golden and compare them to disk
 * WITHOUT writing anything. Split out from the writing half so the decision and
 * the mutation can be tested independently — and so the CLI physically cannot
 * write before it has compared.
 *
 * `expectedDir` is injectable for exactly one reason: the tests for the
 * refusal/no-op behavior run against a TEMP COPY of the goldens. They must
 * never point at the real ones.
 *
 * @param {string} [expectedDir]
 * @returns {Promise<RegenEntry[]>}
 */
export async function planRegeneration(expectedDir = EXPECTED_DIR) {
  const { existsSync } = await import('node:fs')
  const entries = []
  for (const fixtureName of ENCODE_ARGS_FIXTURES) {
    const golden = await buildEncodeArgsGolden(fixtureName)
    const fresh = JSON.stringify(golden, null, 2) + '\n'
    const path = join(expectedDir, `encode-args.${fixtureName}.json`)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    const status = current === null ? 'missing' : current === fresh ? 'identical' : 'differs'
    entries.push({ fixtureName, path, fresh, current, status })
  }
  return entries
}

/**
 * Write the entries a plan says need writing — and only those.
 *
 * `identical` entries are never opened for writing, so their mtimes do not
 * move. Anything else requires `allowOverwrite`; without it the entry is
 * refused and reported, not written.
 *
 * A `missing` golden is gated the same as a changed one. You cannot destroy a
 * file that is not there, but you also cannot verify that what you are creating
 * is the pre-T7 artifact — and a frozen gate that quietly recreates itself from
 * the current pipeline is worth less than no gate at all.
 *
 * @param {RegenEntry[]} plan
 * @param {{ allowOverwrite?: boolean }} [opts]
 * @returns {{ written: RegenEntry[], unchanged: RegenEntry[], refused: RegenEntry[] }}
 */
export function applyRegeneration(plan, opts = {}) {
  const allowOverwrite = opts.allowOverwrite ?? false
  const written = []
  const unchanged = []
  const refused = []
  for (const entry of plan) {
    if (entry.status === 'identical') {
      unchanged.push(entry)
      continue
    }
    if (!allowOverwrite) {
      refused.push(entry)
      continue
    }
    writeFileSync(entry.path, entry.fresh)
    written.push(entry)
  }
  return { written, unchanged, refused }
}

// Guard 1 of 3 on the way to a comparison. NODE_TEST_CONTEXT is set by
// `node --test` (to 'child-v8') and unset on direct execution — note that
// argv[1] is the test file in BOTH cases, so the usual isMain idiom alone would
// fire under the test runner and this whole block would run mid-suite.
const invokedDirectly =
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`

async function runRegenCli() {
  const err = (s) => process.stderr.write(s)

  // Guards 2 and 3. Not satisfied → you do not even get a comparison.
  if (!process.argv.includes(REGEN_FLAG) || process.env[FREEZE_ENV] !== '1') {
    err(FREEZE_BANNER)
    return 1
  }

  err(FREEZE_BANNER)
  err('\nOpt-in acknowledged — comparing against the committed goldens (no write yet).\n\n')

  const plan = await planRegeneration()
  for (const e of plan) {
    if (e.status === 'identical') err(`  unchanged  encode-args.${e.fixtureName}.json — already current, not rewritten\n`)
    if (e.status === 'differs') err(`  CHANGED    encode-args.${e.fixtureName}.json\n`)
    if (e.status === 'missing') err(`  MISSING    encode-args.${e.fixtureName}.json — no committed golden on disk\n`)
  }

  const allowOverwrite = process.argv.includes(OVERWRITE_FLAG)
  const result = applyRegeneration(plan, { allowOverwrite })

  if (result.refused.length > 0) {
    err(changedBanner(result.refused.map((e) => e.fixtureName)))
    for (const e of result.refused) {
      err(`\n─── encode-args.${e.fixtureName}.json ${'─'.repeat(Math.max(0, 50 - e.fixtureName.length))}\n`)
      err(e.current === null ? '  (no file on disk to compare against)\n' : `${formatDiff(e.current, e.fresh)}\n`)
    }
    err(`\n  -  the committed golden (what would be ERASED)\n  +  what this pipeline produces now\n`)
    err(`\nNothing was written. ${result.unchanged.length} file(s) were already current.\n`)
    return 1
  }

  if (result.written.length === 0) {
    err('\nEvery frozen golden is already current. Nothing written, no mtimes moved.\n')
    return 0
  }

  err('\nOverride acknowledged — the render-output-unchanged gate is now spent.\n')
  for (const e of result.written) err(`wrote ${e.path}\n`)
  return 0
}

if (invokedDirectly) {
  runRegenCli()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
