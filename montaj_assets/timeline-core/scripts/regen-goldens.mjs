#!/usr/bin/env node
// montaj_assets/timeline-core/scripts/regen-goldens.mjs
//
// Regenerates every committed golden under expected/ from the fixtures under
// fixtures/. Run it with:
//
//     cd montaj_assets/timeline-core && node scripts/regen-goldens.mjs
//
// WHAT THIS SCRIPT DOES NOT DO: validate that the numbers it writes are
// correct. It only freezes "whatever the resolver currently computes" into
// expected/*.json. T5's actual contract-preserving work is the HAND-AUDIT —
// tracing every value in the diff back to the legacy line that produces it —
// which happens AFTER running this script and BEFORE committing the result.
// See fixtures/README.md and the T5 report for the audit trail.
//
// SCOPE: resolver goldens ONLY. computeGolden(project) below calls the real
// @bycrux/timeline-core resolver (../index.js) over every fixture and writes
// one expected/<fixtureName>.json per fixture. It never writes, reads or
// recomputes the two expected/encode-args.*.json goldens.
//
// ── SP2 T8: this script is now PURE (part 4A) ───────────────────────────────
//
// It used to also own "Part C", the legacy encode-args goldens, and for that it
// imported ../../render/{render,segment-plan,encode-segment}.js. Because
// test/corpus.test.mjs imports computeGolden from here, those render imports
// were transitively part of THIS PACKAGE'S TEST SUITE: `npm test` pulled in
// puppeteer + esbuild, and — once T7 made render/segment-plan.js import
// @bycrux/timeline-core — resolved this package back through
// render/node_modules. A real cycle, and it made the package's "zero runtime
// dependencies, hermetic suite" claim false. Proven by copying the package to a
// directory with no sibling render/: every suite passed except corpus.test.mjs,
// which died with ERR_MODULE_NOT_FOUND.
//
// The encode-args comparison always belonged on the render side of the boundary
// — it is a statement about RENDER's output, not about the resolver — so it now
// lives entirely in montaj_assets/render/test/encode-args-golden.test.mjs, which
// both checks the goldens on every render test run and (subject to the freeze
// below) is the only thing that can regenerate them. Nothing reachable from
// test/** imports across the package boundary any more; the transitive
// hermeticity test at the end of test/activation.test.mjs section 3 enforces it.
//
// DO NOT reintroduce a render/ import here. It would silently un-hermetic the
// suite again, and that test is what will catch you.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  planBoundaries,
  resolveAt,
  resolveSegment,
  visualDuration,
  projectEnd,
  sourceWindow,
  seekTime,
  synthesizedOutPoint,
  audioWindow,
} from '../index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)
export const FIXTURES_DIR = join(ROOT, 'fixtures')
export const EXPECTED_DIR = join(ROOT, 'expected')

const FPS_LIST = [24, 30, 60]
const VARIANTS = /** @type {const} */ (['preview', 'render'])

// ---------------------------------------------------------------------------
// Part A/B — resolver goldens
// ---------------------------------------------------------------------------

/**
 * Sample the timestamps worth calling resolveAt at for a project: every item
 * boundary (start/end, across every track — this is what guarantees the
 * "exact boundary times" the plan asks for, pinning the LATER-clip-wins
 * tiebreak automatically for every fixture that has adjacent items), the
 * midpoint between each pair of consecutive boundaries (covers mid-clip and
 * mid-gap), one point past the last boundary, and — when the earliest
 * boundary is > 0 — one point before it (covers negative-start fixtures and
 * "before anything starts").
 *
 * @param {object} project
 * @returns {number[]} ascending, deduped
 */
export function sampleTimestamps(project) {
  const raw = new Set([0])
  for (const track of project.tracks ?? []) {
    for (const item of track ?? []) {
      if (Number.isFinite(item.start)) raw.add(item.start)
      if (Number.isFinite(item.end)) raw.add(item.end)
    }
  }
  const sorted = [...raw].sort((a, b) => a - b)
  const out = new Set(sorted)
  for (let i = 0; i < sorted.length - 1; i++) out.add((sorted[i] + sorted[i + 1]) / 2)
  if (sorted.length > 0) {
    out.add(sorted[sorted.length - 1] + 1)
    if (sorted[0] > 0) out.add(sorted[0] - 1)
  } else {
    out.add(1)
  }
  return [...out].sort((a, b) => a - b)
}

/** Serialize a ResolvedItem: `item` -> `itemId`, everything computed kept as-is. */
function serializeResolvedItem(ri) {
  return {
    itemId: ri.item?.id ?? null,
    trackIdx: ri.trackIdx,
    kind: ri.kind,
    window: ri.window,
    seek: ri.seek,
    geometry: ri.geometry,
  }
}

function serializeScene(scene) {
  return { t: scene.t, items: scene.items.map(serializeResolvedItem) }
}

/**
 * The three timestamps `seekTime`/`synthesizedOutPoint`/`audioWindow` are
 * sampled at for one interval: start, midpoint, end. Deduped for zero-length
 * intervals.
 */
function threePoints(start, end) {
  const pts = [start, (start + end) / 2, end].filter(Number.isFinite)
  return [...new Set(pts)]
}

/**
 * @param {object} project
 * @returns {object} the golden — see fixtures/README.md for the documented shape
 */
export function computeGolden(project) {
  const fps = project.settings?.fps ?? 30

  const planBoundariesByFps = {}
  for (const f of FPS_LIST) planBoundariesByFps[f] = planBoundaries(project, f)

  const timestamps = sampleTimestamps(project)
  const resolveAtOut = { timestamps, preview: [], render: [] }
  for (const variant of VARIANTS) {
    for (const t of timestamps) {
      resolveAtOut[variant].push(serializeScene(resolveAt(project, t, { variant })))
    }
  }

  const segBoundaries = planBoundaries(project, fps)
  const segments = []
  for (let i = 0; i < segBoundaries.length - 1; i++) {
    const segStart = segBoundaries[i]
    const segEnd = segBoundaries[i + 1]
    segments.push({ segStart, segEnd, scene: serializeScene(resolveSegment(project, segStart, segEnd, fps)) })
  }

  const sourceWindowOut = {}
  const seekTimeOut = {}
  const synthesizedOutPointOut = {}
  for (const track of project.tracks ?? []) {
    for (const item of track ?? []) {
      if (item.type !== 'video' || !item.id) continue
      sourceWindowOut[item.id] = {
        preview: sourceWindow(item, 'preview'),
        render: sourceWindow(item, 'render'),
      }
      synthesizedOutPointOut[item.id] = {
        preview: synthesizedOutPoint(item, 'preview'),
        render: synthesizedOutPoint(item, 'render'),
      }
      const pts = threePoints(item.start, item.end)
      seekTimeOut[item.id] = { preview: {}, render: {} }
      for (const variant of VARIANTS) {
        for (const t of pts) seekTimeOut[item.id][variant][String(t)] = seekTime(item, t, variant)
      }
    }
  }

  const audioWindowOut = {}
  for (const track of project.audio?.tracks ?? []) {
    if (!track.id) continue
    const pts = threePoints(track.start, track.end)
    audioWindowOut[track.id] = {}
    for (const t of pts) audioWindowOut[track.id][String(t)] = audioWindow(track, t)
  }

  return {
    planBoundaries: planBoundariesByFps,
    durations: { visualDuration: visualDuration(project), projectEnd: projectEnd(project) },
    resolveAt: resolveAtOut,
    resolveSegment: { fps, segments },
    sourceWindow: sourceWindowOut,
    seekTime: seekTimeOut,
    synthesizedOutPoint: synthesizedOutPointOut,
    audioWindow: audioWindowOut,
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

function regenResolverGoldens() {
  const names = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort()
  for (const name of names) {
    const project = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'))
    const golden = computeGolden(project)
    writeJson(join(EXPECTED_DIR, name), golden)
    console.log(`wrote expected/${name}`)
  }
  return names
}

// ---------------------------------------------------------------------------
// The encode-args goldens — FROZEN, and NOT regenerable from here (SP2 T8, 4B)
// ---------------------------------------------------------------------------
//
// expected/encode-args.source-crop.json and
// expected/encode-args.source-crop-missing-dims.json are not resolver goldens
// and this script does not write them. They are the RENDER pipeline's output
// (collectAllItems + planSegments + encodeSegment(...,{_dryRun:true})) captured
// by T5 from the PRE-T7 code, before render was swapped onto this package.
//
// That timing is the entire point. They are the only artifact proving the SP2
// migration did not change what ffmpeg is asked to encode. Since T7/T8 the
// generator IS the resolver, so regenerating them would quietly turn the gate
// from "render output is unchanged since before SP2" into "the resolver agrees
// with itself" — a test that can never fail again, including across a real
// regression. Regeneration therefore lives behind a staged opt-in, in the file
// that owns the comparison:
//
//     MONTAJ_UNFREEZE_ENCODE_ARGS_GOLDENS=1 \
//       node montaj_assets/render/test/encode-args-golden.test.mjs --regen
//
// That command COMPARES ONLY. A golden whose bytes still match is never
// rewritten (its mtime does not even move); a golden whose bytes CHANGED is
// refused, with the diff printed, and overwriting it additionally requires
// `--i-am-deliberately-changing-render-output`. Read the banner before you use
// it: if the gate is failing, fixing the render code is almost always the
// correct response.
//
// The list stays here because test/corpus.test.mjs uses it for a completeness
// check (every named fixture exists and has a committed golden) — a pure
// string array, no render import required. render/test/encode-args-golden.test.mjs
// declares the same list; the corpus test's completeness assertion is what
// catches the two drifting apart.
//
// Why these two and not others: source-crop is the mandatory one (Bug B — the
// sourceCrop/sourceWidth/sourceHeight whitelist fields). source-crop-missing-dims
// is the cheap companion evidencing `sourcecrop-missing-dims-silent-drop` — no
// crop= step appears anywhere in its args. opaque-overlay.json is deliberately
// excluded: its overlay needs a `webmPath` that only renderer.js's real
// headless-browser render produces (renderer.js:116), so capturing it would mean
// inventing a field the pipeline derives from a non-deterministic subprocess.
// That case is covered hand-built, with no project/media dependency, by
// render/test/encode-segment.test.mjs's "dry-run: opaqueVideo segment keeps the
// clip audio but drops its video".
export const ENCODE_ARGS_FIXTURES = ['source-crop', 'source-crop-missing-dims']

const FROZEN_NOTICE = `
NOTE: expected/encode-args.*.json were NOT touched — they are frozen pre-T7
artifacts and this script cannot write them. They are the render-output-unchanged
gate for the whole SP2 migration; regenerating them destroys that signal
permanently. See montaj_assets/render/test/encode-args-golden.test.mjs.
`

async function main() {
  const names = regenResolverGoldens()
  console.log(`\nregenerated ${names.length} resolver golden(s).`)
  console.log(FROZEN_NOTICE.trimEnd())
}

// Run ONLY when this file is executed directly (`node scripts/regen-goldens.mjs`),
// NOT when it is imported. test/corpus.test.mjs imports computeGolden /
// ENCODE_ARGS_FIXTURES / FIXTURES_DIR / EXPECTED_DIR
// from this module to avoid duplicating golden-computation logic — if `main()`
// ran on import too, every `npm test` would silently overwrite expected/*.json
// with freshly-computed output BEFORE comparing against it, making the golden
// test tautological (it would always pass, even across a real regression).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
