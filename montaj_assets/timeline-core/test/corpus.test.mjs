// montaj_assets/timeline-core/test/corpus.test.mjs
//
// T5's corpus golden suite. THREE separate contracts are checked here:
//
//   1. Every fixture under fixtures/*.json, recomputed fresh through the real
//      resolver (../index.js) via computeGolden (scripts/regen-goldens.mjs),
//      deep-equals its committed expected/*.json.
//
//      IF THIS FAILS: something changed the resolver's output. Do NOT
//      just run `node scripts/regen-goldens.mjs` and commit the diff — the
//      goldens ARE the contract (see fixtures/README.md and T5's own report):
//      a wrong golden launders a bug. Regenerate, then HAND-AUDIT the diff
//      against the legacy code paths cited in src/*.js's module headers and
//      in KNOWN-DIVERGENCES.md before committing anything.
//
//   2. Corpus completeness: no fixture without a golden, no golden without a
//      fixture (except the two `encode-args.*.json` goldens, which are keyed
//      by fixture NAME, not a 1:1 fixture file).
//
//   3. KNOWN-DIVERGENCES.md completeness: the summary table names all eight
//      plan-mandated entries, and every `fixtures/*.json` path mentioned
//      anywhere in the file actually exists — a stale/typo'd fixture pointer
//      fails loudly instead of silently rotting.
//
// ── WHAT IS NOT CHECKED HERE ANY MORE (SP2 T8, part 4A) ─────────────────────
//
// T5 also ran the "Part C" legacy encode-args comparison from this file: real
// collectAllItems + planSegments + encodeSegment(...,{_dryRun:true}) against
// expected/encode-args.*.json. That reached across the package boundary —
// this file imported scripts/regen-goldens.mjs, which imported
// ../../render/{render,segment-plan,encode-segment}.js — so `npm test` here
// dragged in puppeteer + esbuild and, after T7, resolved @bycrux/timeline-core
// back through render/node_modules. A genuine cycle, and the reason this
// package's "hermetic suite" claim was false until T8.
//
// The comparison is a statement about RENDER's output, not the resolver's, and
// it now lives where it belongs:
//
//     montaj_assets/render/test/encode-args-golden.test.mjs
//
// It runs on every render test run and is strictly stronger there — post-swap
// render code against pre-T7 goldens, which is the actual "SP2 changed no
// bytes" gate. Those goldens are FROZEN; see that file's banner before even
// thinking about regenerating them.
//
// What survives here is the completeness half: ENCODE_ARGS_FIXTURES (a pure
// string array, no render import) still has to name real fixtures with
// committed goldens.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  computeGolden,
  ENCODE_ARGS_FIXTURES,
  FIXTURES_DIR,
  EXPECTED_DIR,
} from '../scripts/regen-goldens.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)

const REGEN_HINT =
  'Resolver output drifted from the committed golden. Run `node scripts/regen-goldens.mjs`, ' +
  'then HAND-AUDIT the diff against the legacy code paths cited in src/*.js\'s module headers ' +
  'and KNOWN-DIVERGENCES.md before committing — the goldens are the contract, not a snapshot to rubber-stamp.'

/**
 * The committed goldens are JSON on disk, and JSON.stringify silently drops
 * object keys whose value is `undefined` (e.g. `Geometry.sourceCrop` on an
 * item that doesn't have one). The live resolver output, by contrast, always
 * sets those keys explicitly to `undefined` (see index.d.ts's `Geometry` —
 * `sourceCrop`/`sourceWidth`/`sourceHeight` are typed `X | undefined`, not
 * optional). `assert.deepEqual` treats "key present with value undefined" and
 * "key absent" as UNEQUAL, so a fresh in-memory object never structurally
 * matches its own round-tripped JSON without first serializing it the same
 * way the golden was written. This is not a fudge — it's the correct
 * comparison for a JSON-file golden: compare what would be written, not the
 * richer in-memory shape JSON can't represent anyway.
 */
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value))
}

function fixtureNames() {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}

// ---------------------------------------------------------------------------
// 1. Resolver goldens — every fixture, recomputed fresh
// ---------------------------------------------------------------------------

describe('corpus: resolver goldens match committed expected/*.json', () => {
  for (const name of fixtureNames()) {
    test(name, () => {
      const project = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8'))
      const fresh = jsonRoundTrip(computeGolden(project))
      const committed = JSON.parse(readFileSync(join(EXPECTED_DIR, `${name}.json`), 'utf8'))
      assert.deepEqual(fresh, committed, `${REGEN_HINT}\n  fixture: fixtures/${name}.json`)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Corpus completeness — no orphan fixtures, no orphan goldens
// ---------------------------------------------------------------------------

test('corpus: every fixture has a golden, every resolver golden has a fixture', () => {
  const fixtures = new Set(fixtureNames())
  const resolverGoldens = new Set(
    readdirSync(EXPECTED_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('encode-args.'))
      .map((f) => f.replace(/\.json$/, '')),
  )
  const missingGolden = [...fixtures].filter((f) => !resolverGoldens.has(f))
  const orphanGolden = [...resolverGoldens].filter((f) => !fixtures.has(f))
  assert.deepEqual(missingGolden, [], 'fixture(s) with no expected/<name>.json golden')
  assert.deepEqual(orphanGolden, [], 'expected/<name>.json golden(s) with no matching fixture')
})

test('corpus: every ENCODE_ARGS_FIXTURES entry names a real fixture and has a committed golden', () => {
  // The comparison itself moved to render/test/encode-args-golden.test.mjs
  // (T8, part 4A), which declares its own copy of this list. This is the
  // completeness half, and the thing that catches the two lists drifting:
  // if the render side adds a fixture name here without committing a golden —
  // or the frozen goldens are deleted — this fails.
  const fixtures = new Set(fixtureNames())
  for (const name of ENCODE_ARGS_FIXTURES) {
    assert.ok(fixtures.has(name), `ENCODE_ARGS_FIXTURES names "${name}", which has no fixtures/${name}.json`)
    assert.ok(
      existsSync(join(EXPECTED_DIR, `encode-args.${name}.json`)),
      `missing expected/encode-args.${name}.json for ENCODE_ARGS_FIXTURES entry "${name}"`,
    )
  }
})

test('corpus: exactly 15 named scenarios (the plan\'s fixture count, +1 in SP3 T4 for proxy-matrix.json, +1 in SP9a-1 T1 for geometry-non-identity.json)', () => {
  assert.equal(fixtureNames().length, 15, 'fixtures/*.json count drifted from the 15 scenarios the plan names')
})

// ---------------------------------------------------------------------------
// 3. KNOWN-DIVERGENCES.md completeness
// ---------------------------------------------------------------------------

const REGISTRY_PATH = join(ROOT, 'KNOWN-DIVERGENCES.md')
const registryText = readFileSync(REGISTRY_PATH, 'utf8')

const MANDATED_ENTRY_IDS = [
  'rotation',
  'opaque-in-preview',
  'dead-render-outpoint',
  'audio-duration-mismatch',
  'caption-1080x1920-hardcode',
  'nobg-precedence',
  'loop-not-rendered-transition-dead-field',
  'sourcecrop-missing-dims-silent-drop',
]

/** Parse the `## Summary` markdown table into an array of id -> full row (cells). */
function parseSummaryTable(text) {
  const lines = text.split('\n')
  const headingIdx = lines.findIndex((l) => l.trim() === '## Summary')
  assert.ok(headingIdx >= 0, 'KNOWN-DIVERGENCES.md must have a "## Summary" heading')
  const rows = []
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break // next section — table ended
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length === 0) continue
    if (cells.every((c) => /^-+$/.test(c))) continue // "| --- | --- |" separator row
    if (cells[0].toLowerCase() === 'id') continue // header row
    rows.push(cells)
  }
  assert.ok(rows.length > 0, 'KNOWN-DIVERGENCES.md\'s "## Summary" table has no data rows — parser or file is broken')
  return rows
}

test('KNOWN-DIVERGENCES.md: summary table contains all eight plan-mandated entry ids', () => {
  const rows = parseSummaryTable(registryText)
  const ids = rows.map((cells) => cells[0].replace(/`/g, ''))
  const missing = MANDATED_ENTRY_IDS.filter((id) => !ids.includes(id))
  assert.deepEqual(missing, [], `missing mandated entry id(s) in the summary table: ${missing.join(', ')}`)
})

test('KNOWN-DIVERGENCES.md: every fixtures/*.json path named anywhere in the file exists on disk', () => {
  const matches = [...registryText.matchAll(/fixtures\/([\w.-]+\.json)/g)].map((m) => m[1])
  assert.ok(matches.length > 0, 'no fixtures/*.json references found in KNOWN-DIVERGENCES.md at all — check the regex/file')
  const missing = [...new Set(matches)].filter((name) => !existsSync(join(FIXTURES_DIR, name)))
  assert.deepEqual(missing, [], `KNOWN-DIVERGENCES.md references fixture(s) that do not exist: ${missing.join(', ')}`)
})

test('KNOWN-DIVERGENCES.md: every expected/*.json path named anywhere in the file exists on disk', () => {
  const matches = [...registryText.matchAll(/expected\/([\w.-]+\.json)/g)].map((m) => m[1])
  const missing = [...new Set(matches)].filter((name) => !existsSync(join(EXPECTED_DIR, name)))
  assert.deepEqual(missing, [], `KNOWN-DIVERGENCES.md references expected golden(s) that do not exist: ${missing.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 4. fixtures/README.md registry-id consistency
//
// Only fixture/golden *paths* were machine-checked above — the registry
// *ids* fixtures/README.md's scenario table names (e.g.
// `sourcecrop-missing-dims-silent-drop`) were free text, so a rename in
// KNOWN-DIVERGENCES.md (or a typo in the README) could rot silently. This
// closes that gap.
// ---------------------------------------------------------------------------

const FIXTURES_README_PATH = join(FIXTURES_DIR, 'README.md')
const fixturesReadmeText = readFileSync(FIXTURES_README_PATH, 'utf8')

/**
 * Parse fixtures/README.md's "## Scenario → fixture → registry map" table
 * and return the raw "Registry entry (KNOWN-DIVERGENCES.md)" cell (the last
 * column) for every data row.
 */
function parseFixturesReadmeRegistryColumn(text) {
  const lines = text.split('\n')
  const headingIdx = lines.findIndex((l) => l.trim() === '## Scenario → fixture → registry map')
  assert.ok(headingIdx >= 0, 'fixtures/README.md must have a "## Scenario → fixture → registry map" heading')
  const cells = []
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break // next section — table ended
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const rowCells = trimmed.split('|').slice(1, -1).map((c) => c.trim())
    if (rowCells.length === 0) continue
    if (rowCells.every((c) => /^-+$/.test(c))) continue // "| --- | --- | --- |" separator row
    if (rowCells[0].toLowerCase() === 'fixture') continue // header row
    cells.push(rowCells[rowCells.length - 1]) // last column: "Registry entry (KNOWN-DIVERGENCES.md)"
  }
  assert.ok(cells.length > 0, 'fixtures/README.md\'s scenario table has no data rows — parser or file is broken')
  return cells
}

test('fixtures/README.md: every backticked registry id in the scenario table\'s registry column appears in KNOWN-DIVERGENCES.md\'s summary table', () => {
  const summaryRows = parseSummaryTable(registryText)
  const summaryIds = new Set(summaryRows.map((cells) => cells[0].replace(/`/g, '')))

  const registryCells = parseFixturesReadmeRegistryColumn(fixturesReadmeText)
  const claimedIds = new Set()
  for (const cell of registryCells) {
    // A cell starting with "none" claims no registry id at all — skip it
    // rather than picking through its prose for unrelated backticked
    // function/file names (e.g. "none — this is the FIX itself
    // (source-window.js `usedNormalizedCacheFor`/`sourceWindow`)"). For
    // cells that DO claim an id, only treat a backticked token as a
    // candidate id if it has the registry's own id SHAPE — multiple
    // hyphen-joined words, letters/digits only — which is what excludes
    // incidental backticked file references like `durations.js` (contains a
    // `.`) or bare identifiers like `sourceWindow` (no hyphen) from being
    // checked as if they were ids. Deliberately CASE-INSENSITIVE here: every
    // real registry id is all-lowercase, but the whole point of this test is
    // to catch a wrong-case id (e.g. `sourceCrop-missing-dims-silent-drop`
    // instead of `sourcecrop-missing-dims-silent-drop`) — lower-casing the
    // shape check would make that exact typo invisible, and the `summaryIds`
    // comparison below is still case-sensitive, so a mis-cased id still
    // fails as "not present".
    if (/^none\b/i.test(cell)) continue
    for (const m of cell.matchAll(/`([^`]+)`/g)) {
      const token = m[1]
      if (/^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)+$/.test(token)) claimedIds.add(token)
    }
  }

  assert.ok(claimedIds.size > 0, 'no registry ids parsed out of fixtures/README.md at all — check the regex/file')
  const missing = [...claimedIds].filter((id) => !summaryIds.has(id))
  assert.deepEqual(
    missing,
    [],
    `fixtures/README.md's scenario table names registry id(s) not present in KNOWN-DIVERGENCES.md's summary table: ${missing.join(', ')}`,
  )
})
