// render/test/fonts-fallthrough.test.mjs
//
// THE FONTS-BASE PARTITION (L1).
//
// A `fontsBaseDir` points at a vendored `fonts.css`. That stylesheet declares
// the editor's twenty picker families and nothing else — but `googleFonts`
// entries come out of project.json, and `skills/write-overlay/SKILL.md`
// documents arbitrary Google families as first-class (its own worked example
// is `["Anton", "Playfair+Display:ital@1"]`, and Anton is not a picker
// family). Linking the vendored sheet and dropping the requested entries
// renders those in a fallback face with nothing on screen to say so.
//
// So the page links the vendored sheet for the families it covers and falls
// through to fonts.googleapis.com for the rest, per family, reading the
// vendored set from `<base>/families.json`.
//
// Four properties are load-bearing here and each has its own section:
//
//   (1) NO BASE IS BYTE-IDENTICAL. Every OSS consumer depends on it. Pinned by
//       execution against a baseline captured from git, not by reading.
//   (2) ALL-VENDORED IS ZERO EGRESS. No googleapis <link>, no preconnect to
//       googleapis or gstatic. This is the entire purpose of the base; a
//       partition that leaked a preconnect would make it pointless.
//   (3) A MIX PARTITIONS, and each family lands on exactly one side.
//   (4) A MISSING OR MALFORMED MANIFEST FALLS EVERYTHING THROUGH, loudly. We
//       cannot tell what is covered; fetching a family we already have costs
//       a download, while dropping one we do not have costs the author a
//       wrong face in a finished export.
//
// Everything is asserted TWICE — once against `bundle.js` (video/overlay) and
// once against `render-carousel.js`. The two renderers share no code by
// design, and the normalisation and the manifest read must not drift apart;
// `shim-bake.test.mjs` pins their source text as identical, and this file
// pins that the identical text is wired up identically.
//
// The editor's preview loader (`montaj_assets/editor/src/lib/google-fonts.ts`)
// carries the mirror of these cases. Preview and render MUST put every family
// on the same side of the partition — a caption laid out in one face while
// editing and another at export is the Syne bug the skill's case study exists
// to document.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { generateHtml as bundleHtml } from '../bundle.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// render-carousel.js's generateHtml, extracted
// ---------------------------------------------------------------------------
//
// render-carousel.js is a CLI entry point: it parses process.argv and exits at
// module scope, so it cannot simply be imported. It exports nothing either —
// deliberately, it is not a library. Rather than leave the carousel renderer's
// font handling untested (it is the half that renders every Instagram slide),
// lift the four font functions out of the source text into a throwaway module
// and exercise the real thing.
//
// This is a harness, not a reimplementation: if the extraction stops matching
// the file the regexes fail loudly, and `shim-bake.test.mjs` separately pins
// the helper bodies as byte-identical to bundle.js's.
const HARNESS = join(tmpdir(), `carousel-fonts-harness-${process.pid}`)
// vendoredFontsHref delegates to file-url.js's fontsCssHref; the harness lives
// in tmpdir, so it imports that by absolute URL.
const FONTS_CSS_HREF_IMPORT =
  `import { fontsCssHref } from ${JSON.stringify(pathToFileURL(join(__dirname, '..', 'file-url.js')).href)}\n`

function extractCarouselHtml() {
  const src = readFileSync(join(__dirname, '..', 'render-carousel.js'), 'utf8')
  const parts = []
  for (const name of ['vendoredFontsHref', 'fontFamilyKey', 'vendoredFontsManifest', 'vendoredFamilyKeys',
                      'requiredFaces', 'vendoredFaceIndex', 'specFacesAvailable',
                      'familiesDigest', 'reportVendoredFonts']) {
    const m = src.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\n`))
    assert.ok(m, `expected a ${name} in render-carousel.js`)
    parts.push(m[0])
  }
  // generateHtml's body contains a `}` at column 0 inside its <style> template
  // literal, so it is matched to its real end (the closing </html> backtick)
  // rather than to the first line-initial brace.
  const g = src.match(/\nfunction generateHtml\([^]*?\n<\/html>`\n\}\n/)
  assert.ok(g, 'expected a generateHtml in render-carousel.js')
  parts.push(g[0].replace('\nfunction generateHtml(', '\nexport function generateHtml('))
  mkdirSync(HARNESS, { recursive: true })
  const out = join(HARNESS, 'carousel-generate-html.mjs')
  writeFileSync(out, "import { readFileSync } from 'fs'\n" + FONTS_CSS_HREF_IMPORT + parts.join('\n'))
  return out
}

let carouselHtml
before(async () => {
  ;({ generateHtml: carouselHtml } = await import(extractCarouselHtml()))
})

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TMPS = []
/** A fonts base holding a `families.json`. `families === null` writes no
 *  manifest at all; a non-array `raw` writes a malformed one.
 *
 *  `faceData` — `{ faces, requested }` — adds the face-level half of the
 *  manifest. Omitting it writes a manifest with NO face information, which is
 *  a real shape rather than a test convenience: it is what a payload vendored
 *  before the face refinement existed looks like, and it deliberately leaves
 *  the partition at family level. The cases below that omit it are asserting
 *  that fallback; the ones that pass it are asserting the refinement. */
function fontsBase(families, raw, faceData) {
  const dir = mkdtempSync(join(tmpdir(), 'fontsbase-'))
  TMPS.push(dir)
  if (raw !== undefined) writeFileSync(join(dir, 'families.json'), raw)
  else if (families !== null) writeFileSync(join(dir, 'families.json'), JSON.stringify({ families, ...faceData }))
  return dir
}
after(() => {
  for (const d of TMPS) rmSync(d, { recursive: true, force: true })
  rmSync(HARNESS, { recursive: true, force: true })
})

/** Run `fn`, returning [result, stderrLines]. generateHtml reports
 *  fall-through on stderr — never stdout, which carries render.js's JSON
 *  result and render-carousel.js's output directory. */
function capturingStderr(fn) {
  const original = console.error
  const lines = []
  console.error = (...a) => lines.push(a.join(' '))
  try {
    return [fn(), lines]
  } finally {
    console.error = original
  }
}

/** Both renderers under one signature: (googleFonts, fontsBaseDir) → html.
 *  bundle.js carries an extra `opaque` parameter the carousel has no concept
 *  of; everything asserted below is identical across the two regardless. */
const RENDERERS = () => [
  ['bundle.js', (fonts, base) => bundleHtml(1080, 1920, false, fonts, base)],
  ['render-carousel.js', (fonts, base) => carouselHtml(1080, 1350, fonts, base)],
]

const hasGoogleEgress = (html) => /fonts\.(googleapis|gstatic)\.com|preconnect/.test(html)

// ---------------------------------------------------------------------------
// (1) No base: byte-identical
// ---------------------------------------------------------------------------
//
// The fall-through added a manifest read and a partition. Neither may execute
// without a base, and the emitted page must not move by a byte — pinned by
// running the CURRENT function against a copy of the same function from
// `git show HEAD:`, across every no-base and rejected-base shape, rather than
// by eyeballing the diff.
describe('fonts: with no base, the page is byte-identical to the pre-fall-through renderer', () => {
  const CASES = [
    [[], ''],
    [['Anton'], ''],
    [['Anton', 'Inter:wght@400;700'], ''],
    [['Baloo+2:wght@400;500;600;700;800', 'Playfair+Display:ital@1'], ''],
    // Bases the guard rejects must land on the same untouched output — the
    // manifest read must not run for them either.
    [['Anton'], '//evil.test'],
    [['Anton'], '//evil.test/fonts'],
    [['Anton'], 'fonts/editor'],
    [['Anton'], './fonts'],
    [['Anton'], 'https://evil.test/f'],
    [['Anton'], 'file:///x/fonts'],
    [['Anton'], 42],
    [['Anton'], null],
    [['Anton'], undefined],
  ]

  test('bundle.js', async () => {
    const { execFileSync } = await import('node:child_process')
    const baseline = join(HARNESS, 'bundle.HEAD.js')
    writeFileSync(baseline, execFileSync('git', ['show', 'HEAD:montaj_assets/render/bundle.js'],
      { cwd: join(__dirname, '..', '..', '..'), encoding: 'utf8', maxBuffer: 1 << 24 }))
    // esbuild is a sibling-resolved dependency of render/, so the baseline has
    // to resolve its imports from there.
    const { symlinkSync, existsSync } = await import('node:fs')
    if (!existsSync(join(HARNESS, 'node_modules'))) {
      symlinkSync(join(__dirname, '..', 'node_modules'), join(HARNESS, 'node_modules'))
    }
    // bundle.js imports './file-url.js' (vendoredFontsHref delegates to it), so
    // that sibling must resolve too. Harmless for a baseline that predates it.
    if (!existsSync(join(HARNESS, 'file-url.js'))) {
      symlinkSync(join(__dirname, '..', 'file-url.js'), join(HARNESS, 'file-url.js'))
    }
    const { generateHtml: head } = await import(baseline)
    for (const [fonts, base] of CASES) {
      const [now] = capturingStderr(() => bundleHtml(1080, 1920, false, fonts, base))
      assert.equal(now, head(1080, 1920, false, fonts, base),
        `no-base output moved for ${JSON.stringify([fonts, base])} — every OSS consumer depends on it not moving`)
    }
  })

  test('render-carousel.js', async () => {
    const { execFileSync } = await import('node:child_process')
    const headSrc = join(HARNESS, 'render-carousel.HEAD.js')
    writeFileSync(headSrc, execFileSync('git', ['show', 'HEAD:montaj_assets/render/render-carousel.js'],
      { cwd: join(__dirname, '..', '..', '..'), encoding: 'utf8', maxBuffer: 1 << 24 }))
    // The baseline predates three of the four helpers, so extract whichever of
    // them it has — the regexes below tolerate their absence for this file only.
    const src = readFileSync(headSrc, 'utf8')
    const parts = []
    for (const name of ['vendoredFontsHref', 'fontFamilyKey', 'vendoredFontsManifest', 'vendoredFamilyKeys',
                      'requiredFaces', 'vendoredFaceIndex', 'specFacesAvailable',
                      'familiesDigest', 'reportVendoredFonts']) {
      const m = src.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\n`))
      if (m) parts.push(m[0])
    }
    const g = src.match(/\nfunction generateHtml\([^]*?\n<\/html>`\n\}\n/)
    assert.ok(g, 'expected a generateHtml in the HEAD render-carousel.js')
    parts.push(g[0].replace('\nfunction generateHtml(', '\nexport function generateHtml('))
    const out = join(HARNESS, 'carousel-head.mjs')
    writeFileSync(out, "import { readFileSync } from 'fs'\n" + FONTS_CSS_HREF_IMPORT + parts.join('\n'))
    const { generateHtml: head } = await import(out)
    for (const [fonts, base] of CASES) {
      const [now] = capturingStderr(() => carouselHtml(1080, 1350, fonts, base))
      assert.equal(now, head(1080, 1350, fonts, base),
        `no-base output moved for ${JSON.stringify([fonts, base])}`)
    }
  })
})

// ---------------------------------------------------------------------------
// (2) All-vendored: zero egress
// ---------------------------------------------------------------------------
describe('fonts: a project using only vendored families reaches Google not at all', () => {
  for (const [label, render] of RENDERERS()) {
    test(`${label}: the vendored stylesheet is the only <link> on the page`, () => {
      // `Playfair+Display:ital@1` USED TO BE the third spec here, and this
      // test asserted zero egress for it. That was wrong and it is the bug
      // this face-level partition fixes: no italic face is vendored for any
      // family, so that spec was silently resolving to a browser-synthesised
      // oblique. It is now `wght@700`, a face that genuinely is on disk, and
      // the italic spec has its own test below asserting it falls THROUGH.
      const base = fontsBase(['Baloo 2', 'Inter', 'Playfair Display'], undefined, {
        faces: {
          'Baloo 2': { normal: [400, 500] },
          Inter: { normal: [400, 700] },
          'Playfair Display': { normal: [400, 700] },
        },
      })
      const [html, warnings] = capturingStderr(() =>
        render(['Baloo+2:wght@400;500', 'Inter:wght@400;700', 'Playfair+Display:wght@700'], base))
      assert.match(html, new RegExp(`<link rel="stylesheet" href="file://${base}/fonts\\.css">`))
      assert.equal(hasGoogleEgress(html), false,
        'a googleapis link OR a preconnect here makes the whole vendoring pointless')
      assert.equal((html.match(/<link /g) ?? []).length, 1)
      // The digest line always goes out — it is what a human compares against
      // the editor's — but there must be no fall-through line behind it.
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /vendored set [0-9a-f]{8} \(3 families\)/)
      assert.doesNotMatch(warnings[0], /not in the vendored set/)
    })

    test(`${label}: case and '+'-vs-space differences do not force needless egress`, () => {
      // CSS font-family matching is case-insensitive, so a spec that differs
      // from the manifest only in case names a family the vendored sheet
      // genuinely serves. Treating it as unvendored would buy nothing but a
      // fetch from Google.
      const base = fontsBase(['Baloo 2', 'Source Serif 4'])
      const [html] = capturingStderr(() => render(['BALOO+2:wght@400', 'Source Serif 4'], base))
      assert.equal(hasGoogleEgress(html), false)
    })
  }
})

// ---------------------------------------------------------------------------
// (3) All-unvendored, and the mix
// ---------------------------------------------------------------------------
describe('fonts: families the vendored set does not declare fall through to Google', () => {
  for (const [label, render] of RENDERERS()) {
    test(`${label}: all-unvendored keeps the vendored link and adds the full googleapis URL`, () => {
      const base = fontsBase(['Inter', 'Baloo 2'])
      const [html, warnings] = capturingStderr(() => render(['Anton', 'Syne:wght@800'], base))
      // The vendored stylesheet is NOT linked: none of the requested families
      // is in it, so it would serve nothing but a request.
      assert.doesNotMatch(html, /fonts\.css/)
      assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/)
      assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/)
      assert.match(html, /css2\?family=Anton&family=Syne:wght@800&display=swap/)
      assert.equal(warnings.length, 2, 'the digest line, then the fall-through line')
      assert.match(warnings[0], /vendored set [0-9a-f]{8} \(2 families\)/)
      assert.match(warnings[1], /not in the vendored set/)
      assert.match(warnings[1], /Anton, Syne:wght@800/)
    })

    test(`${label}: a MIX puts each family on exactly one side`, () => {
      const base = fontsBase(['Baloo 2', 'Playfair Display', 'Inter'])
      const [html, warnings] = capturingStderr(() =>
        render(['Baloo+2:wght@400;500', 'Anton', 'Playfair+Display:ital@1'], base))

      // Both links present, vendored first.
      const links = html.match(/<link [^>]*>/g) ?? []
      assert.equal(links.length, 4, `expected vendored + 2 preconnect + googleapis, got:\n${links.join('\n')}`)
      assert.match(links[0], new RegExp(`href="file://${base}/fonts\\.css"`))

      // Anton, and ONLY Anton, crosses to Google. A regression that fell
      // everything through would still look right in the export and would
      // silently restore the egress this feature removes.
      const google = links[3]
      assert.match(google, /css2\?family=Anton&display=swap/)
      assert.doesNotMatch(google, /Baloo/)
      assert.doesNotMatch(google, /Playfair/)

      assert.equal(warnings.length, 2)
      assert.match(warnings[0], /vendored set [0-9a-f]{8} \(3 families\)/)
      assert.match(warnings[1], /fonts\.googleapis\.com: Anton$/)
    })

    test(`${label}: an empty families array is a valid manifest meaning "nothing vendored"`, () => {
      const base = fontsBase([])
      const [html, warnings] = capturingStderr(() => render(['Anton'], base))
      assert.match(html, /css2\?family=Anton&display=swap/)
      // The ordinary fall-through line, NOT the "cannot tell" one — an empty
      // list is an answer, not a fault, even though both end up sending
      // everything to Google.
      assert.match(warnings.join('\n'), /not in the vendored set/)
      assert.doesNotMatch(warnings.join('\n'), /no readable families\.json/)
    })

    test(`${label}: an empty googleFonts emits no links at all, base or no base`, () => {
      const base = fontsBase(['Inter'])
      const [html] = capturingStderr(() => render([], base))
      assert.equal((html.match(/<link /g) ?? []).length, 0)
    })
  }
})

// ---------------------------------------------------------------------------
// (4) The missing-manifest failure mode
// ---------------------------------------------------------------------------
//
// DELIBERATE: an unreadable manifest means NOTHING is vendored. The vendored
// stylesheet is not linked at all and every requested family comes from
// Google, loudly.
//
// The tempting opposite — assume the sheet covers what was asked for — is the
// SILENT-wrong option and is the defect this whole partition exists to fix.
// This one is loud-wrong: every glyph is correct, preview and render still
// agree (the editor applies the identical rule when a host sets a base with
// no family list), and the only cost is egress, which is the one failure the
// log line already detects.
describe('fonts: a missing or malformed families.json', () => {
  const BAD = [
    ['no manifest file at all', null, undefined],
    ['unparseable JSON', null, '{ not json'],
    ['JSON that is not an object', null, '42'],
    ['an object with no families key', null, '{"fonts":["Inter"]}'],
    ['a families value that is not an array', null, '{"families":"Inter"}'],
    ['null', null, 'null'],
  ]

  for (const [label, render] of RENDERERS()) {
    for (const [what, families, raw] of BAD) {
      test(`${label}: ${what} falls every family through, and says so`, () => {
        const base = fontsBase(families, raw)
        const [html, warnings] = capturingStderr(() => render(['Inter:wght@400', 'Anton'], base))
        // No vendored link at all: we cannot prove it serves anything, and a
        // stylesheet whose coverage is unknown is worse than no stylesheet —
        // it is the thing that makes a fallback face look intentional.
        assert.doesNotMatch(html, /fonts\.css/)
        assert.match(html, /css2\?family=Inter:wght@400&family=Anton&display=swap/)
        assert.equal(warnings.length, 1)
        assert.match(warnings[0], /no readable families\.json/)
        assert.match(warnings[0], /treating NOTHING as vendored/)
      })
    }

    test(`${label}: a non-string entry in the manifest is dropped, not crashed on`, () => {
      const base = fontsBase(null, '{"families":["Inter", 7, null, "Baloo 2"]}')
      const [html, warnings] = capturingStderr(() => render(['Inter:wght@400', 'Anton'], base))
      assert.match(html, /css2\?family=Anton&display=swap/)
      assert.doesNotMatch(html, /family=Inter/)
      assert.match(warnings.join('\n'), /not in the vendored set/)
    })
  }
})

// ---------------------------------------------------------------------------
// The spec → family normalisation
// ---------------------------------------------------------------------------
//
// The one piece of logic that decides which side of the partition a spec lands
// on. It is duplicated in three files (both renderers and the editor loader)
// and a drift between them shows up only as a caption in the wrong face in a
// finished export. Exercised here through the public surface — a manifest
// declaring exactly one family, and a spec that must or must not match it.
describe('fonts: a googleFonts entry is a SPEC, and normalises to the family fonts.css declares', () => {
  const MATCHES = [
    ['Baloo+2:wght@400;500', 'Baloo 2'],
    ['Playfair+Display:ital@1', 'Playfair Display'],
    ['Anton', 'Anton'],
    ['Source+Serif+4:wght@400;700', 'Source Serif 4'],
    ['Inter:wght@400;600;700;800', 'Inter'],
    ['Playfair Display', 'Playfair Display'],       // a literal space, not '+'
    ['DM+SANS:wght@400', 'DM Sans'],                // case-insensitive, like CSS
    ['Bebas+Neue', 'Bebas Neue'],
    // The manifest entries go through the SAME normalisation as the specs, so
    // a generator that writes Google's '+'-encoded spelling into families.json
    // instead of the `fonts.css` one still matches. Deliberate leniency: the
    // failure it prevents is silent egress for a family that is right there
    // on disk.
    ['Open+Sans:wght@400', 'Open+Sans'],
  ]
  const MISSES = [
    ['Baloo+2:wght@400', 'Baloo'],                  // a prefix is not the family
    ['Anton', 'Antonio'],
    ['Inter:wght@400', 'Inter Tight'],
  ]

  for (const [label, render] of RENDERERS()) {
    for (const [spec, family] of MATCHES) {
      test(`${label}: ${JSON.stringify(spec)} is covered by a vendored ${JSON.stringify(family)}`, () => {
        const [html] = capturingStderr(() => render([spec], fontsBase([family])))
        assert.equal(hasGoogleEgress(html), false, `${spec} should have matched ${family}`)
      })
    }
    for (const [spec, family] of MISSES) {
      test(`${label}: ${JSON.stringify(spec)} is NOT covered by a vendored ${JSON.stringify(family)}`, () => {
        const [html] = capturingStderr(() => render([spec], fontsBase([family])))
        assert.equal(hasGoogleEgress(html), true, `${spec} should not have matched ${family}`)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// THE CROSS-LANGUAGE DIGEST GATE
// ---------------------------------------------------------------------------
//
// Both renderers and the editor log a short digest of the vendored family set
// so that a divergence becomes two visibly different strings instead of
// something a human has to infer by watching which fonts load. That only works
// if all three compute it the same way — and the editor's copy is TypeScript,
// so the textual parity test that keeps the two renderers honest cannot reach
// it.
//
// So both suites pin the same literal digest for the same manifest: this one,
// and `familiesDigest` in
// `montaj_assets/editor/src/lib/__tests__/google-fonts.test.ts`. If the two
// values ever disagree, the digest has stopped being able to prove the thing
// it exists to prove. Change one only by changing the other, deliberately.
//
// THE DIGEST COVERS FACES, NOT JUST FAMILIES. A families-only fingerprint
// would report a match across a set that materially changed — re-vendor at a
// different weight, or drop one, and every family name is still identical
// while what the stylesheet can actually resolve is not. Both pinned values
// below are asserted: the shipped manifest's, and the families-only one, which
// is unchanged from before faces existed and proves a face-less manifest still
// digests exactly as an older renderer would.
describe('fonts: the vendored-set digest is identical across the renderers and the editor', () => {
  // The twenty families the app actually vendors today.
  const PRODUCTION_20 = [
    'Baloo 2', 'Bebas Neue', 'DM Sans', 'Fredoka', 'Inter', 'JetBrains Mono', 'Lato',
    'Merriweather', 'Montserrat', 'Nunito', 'Open Sans', 'Oswald', 'Playfair Display',
    'Poppins', 'Raleway', 'Roboto', 'Rubik', 'Sniglet', 'Source Serif 4', 'Work Sans',
  ]
  // The faces those twenty actually resolve to, as `families.json` records
  // them. Bebas Neue is the one family whose `faces` and `requested` differ:
  // it publishes no 700, so we asked for one and received only the 400.
  const W = { 'Baloo 2': [400, 500, 600, 700, 800], Fredoka: [300, 400, 500, 600, 700], Sniglet: [400, 800] }
  const PRODUCTION_FACES = {}
  const PRODUCTION_REQUESTED = {}
  for (const f of PRODUCTION_20) {
    PRODUCTION_REQUESTED[f] = { normal: W[f] ?? [400, 700] }
    PRODUCTION_FACES[f] = { normal: f === 'Bebas Neue' ? [400] : (W[f] ?? [400, 700]) }
  }
  const MANIFEST = { faces: PRODUCTION_FACES, requested: PRODUCTION_REQUESTED }

  const PINNED = '1fcf41c1'            // the shipped manifest, faces included
  const PINNED_FAMILIES_ONLY = '63d7e733' // a manifest carrying no face information

  for (const [label, render] of RENDERERS()) {
    test(`${label} logs ${PINNED} for the shipped manifest`, () => {
      const base = fontsBase(PRODUCTION_20, undefined, MANIFEST)
      const [, warnings] = capturingStderr(() => render(['Inter:wght@400'], base))
      assert.equal(warnings[0], `[montaj] fonts: vendored set ${PINNED} (20 families)`)
    })

    test(`${label} logs ${PINNED_FAMILIES_ONLY} when the manifest carries no faces`, () => {
      const base = fontsBase(PRODUCTION_20)
      const [, warnings] = capturingStderr(() => render(['Inter:wght@400'], base))
      assert.equal(warnings[0], `[montaj] fonts: vendored set ${PINNED_FAMILIES_ONLY} (20 families)`)
    })
  }

  test('the digest is order- and spelling-independent, and moves when the set does', () => {
    const digestFor = (families, faceData) => {
      const [, w] = capturingStderr(() =>
        bundleHtml(1080, 1920, false, ['Inter:wght@400'], fontsBase(families, undefined, faceData)))
      return w[0].match(/vendored set ([0-9a-f]{8})/)[1]
    }
    const a = digestFor(['Inter', 'Baloo 2'])
    assert.equal(digestFor(['Baloo+2', 'inter']), a, 'sorted and normalised before hashing')
    assert.notEqual(digestFor(['Inter']), a, 'a different set must produce a different digest')
  })

  // The reason the digest had to grow. Same twenty families, one weight fewer:
  // a families-only fingerprint reports a match here, which is exactly the
  // silent drift it is supposed to make loud.
  test('dropping a single WEIGHT moves the digest, though every family name is unchanged', () => {
    const digestFor = (faceData) => {
      const [, w] = capturingStderr(() =>
        bundleHtml(1080, 1920, false, ['Inter:wght@400'], fontsBase(PRODUCTION_20, undefined, faceData)))
      return w[0].match(/vendored set ([0-9a-f]{8})/)[1]
    }
    const thinner = JSON.parse(JSON.stringify(MANIFEST))
    thinner.faces.Inter.normal = [400]
    thinner.requested.Inter.normal = [400]
    assert.equal(digestFor(thinner), '7b42f0b4')
    assert.notEqual(digestFor(thinner), PINNED,
      'a vendored set that lost a weight must not keep reporting the same digest')
  })

  // The style axis is in the input too, not only the weights.
  test('gaining an ITALIC face moves the digest', () => {
    const digestFor = (faceData) => {
      const [, w] = capturingStderr(() =>
        bundleHtml(1080, 1920, false, ['Inter:wght@400'], fontsBase(PRODUCTION_20, undefined, faceData)))
      return w[0].match(/vendored set ([0-9a-f]{8})/)[1]
    }
    const italic = JSON.parse(JSON.stringify(MANIFEST))
    italic.faces['Playfair Display'].italic = [400]
    assert.notEqual(digestFor(italic), PINNED)
  })
})

// ---------------------------------------------------------------------------
// The escaping asymmetry between the two renderers is PRESERVED
// ---------------------------------------------------------------------------
//
// bundle.js runs googleFonts entries through `escapeFontSpec` before
// interpolating them into the href; render-carousel.js does not. That
// asymmetry predates the fall-through and is not this change's to fix — but
// the fall-through re-routes every entry through a new code path, so pin that
// it survived the re-route rather than being quietly normalised away.
describe('fonts: the fall-through path escapes exactly as the direct path did', () => {
  const HOSTILE = ['A&evil=1', 'Anton" onload="window.__pwned=1']

  test('bundle.js escapes a fallen-through entry the same way it escapes a direct one', () => {
    const base = fontsBase(['Inter'])
    const [viaBase] = capturingStderr(() => bundleHtml(1080, 1920, false, HOSTILE, base))
    const [direct] = capturingStderr(() => bundleHtml(1080, 1920, false, HOSTILE, ''))
    const tag = (h) => h.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis[^]*?>/)[0]
    assert.equal(tag(viaBase), tag(direct))
    assert.match(viaBase, /family=A&amp;evil=1/)
    assert.doesNotMatch(viaBase, /onload="window/)
  })

  test('render-carousel.js still does NOT escape — the existing asymmetry is preserved, not "fixed"', () => {
    const base = fontsBase(['Inter'])
    const [viaBase] = capturingStderr(() => carouselHtml(1080, 1350, HOSTILE, base))
    const [direct] = capturingStderr(() => carouselHtml(1080, 1350, HOSTILE, ''))
    const tag = (h) => h.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis[^]*?>/)[0]
    assert.equal(tag(viaBase), tag(direct))
    assert.match(viaBase, /family=A&evil=1/)
  })
})

// ---------------------------------------------------------------------------
// (5) THE FACE-LEVEL PARTITION
// ---------------------------------------------------------------------------
//
// The vendored set is family + STYLE + WEIGHT, and a family-level partition
// gets two shapes silently wrong. `fonts.css` declares `font-style: normal`
// for every face it carries and only the weights the vendoring pass asked for,
// so:
//
//   Playfair+Display:ital@1  — family vendored, NO italic face exists. Treated
//                              as vendored, the real italic is never fetched
//                              and the browser synthesises an oblique.
//   Inter:wght@300           — family vendored, NO 300 face exists. Same
//                              failure one axis over.
//
// Neither produces a failed request or a console error; both change what the
// user sees. `skills/write-overlay/SKILL.md` uses the first as its own
// documented example, so it is not a hypothetical.
//
// The refinement can only ever move a spec from "vendored" to "fell through".
// A family absent from the family list is still unvendored regardless of faces.
describe('fonts: a spec whose FACES are not vendored falls through, even when its family is', () => {
  // The real payload's shape, trimmed to the families these cases name.
  const REAL = {
    faces: {
      'Playfair Display': { normal: [400, 700] },
      Inter: { normal: [400, 700] },
      'Bebas Neue': { normal: [400] },
    },
    requested: {
      'Playfair Display': { normal: [400, 700] },
      Inter: { normal: [400, 700] },
      // Asked for 700; Google returned only 400, because Bebas Neue publishes
      // no 700 at all. See README.md in the vendored payload.
      'Bebas Neue': { normal: [400, 700] },
    },
  }
  const FAMILIES = ['Playfair Display', 'Inter', 'Bebas Neue']

  for (const [label, render] of RENDERERS()) {
    for (const [spec, vendored, why] of [
      ['Playfair+Display:ital@1', false, 'no italic face is vendored for any family'],
      ['Playfair+Display:ital,wght@1,700', false, 'italic 700 is not on disk either'],
      ['Playfair+Display:ital@0', true, 'ital@0 is normal 400, which IS on disk'],
      ['Playfair+Display:wght@700', true, 'normal 700 is on disk'],
      ['Inter:wght@300', false, '300 was never vendored'],
      ['Inter:wght@400;700', true, 'both weights are on disk'],
      ['Inter', true, 'a bare family is normal 400, which is on disk'],
      // The `requested` half. Falling through would fetch a stylesheet that
      // omits the 700 exactly as our vendored copy does — a guaranteed-useless
      // request, not a probably-useless one.
      ['Bebas+Neue:wght@400;700', true, 'Google publishes no 700, so asking again cannot help'],
      ['Bebas+Neue:wght@500', false, '500 was neither vendored nor asked for'],
    ]) {
      test(`${label}: ${JSON.stringify(spec)} is ${vendored ? 'vendored' : 'fetched from Google'} — ${why}`, () => {
        const base = fontsBase(FAMILIES, undefined, REAL)
        const [html] = capturingStderr(() => render([spec], base))
        assert.equal(hasGoogleEgress(html), !vendored, `${spec}: ${why}`)
      })
    }

    // A spec is the AUTHOR'S string. Splitting it would mean synthesising a
    // new one, which is not ours to do — so a spec that is only partly
    // covered crosses to Google whole, exactly as written.
    test(`${label}: a PARTIALLY vendored spec falls through WHOLE, not split`, () => {
      const base = fontsBase(FAMILIES, undefined, REAL)
      const [html] = capturingStderr(() => render(['Inter:wght@400;300'], base))
      assert.match(html, /css2\?family=Inter:wght@400;300&display=swap/,
        'the spec must reach Google byte-for-byte as the author wrote it')
      assert.doesNotMatch(html, /family=Inter:wght@300&/, 'the vendored half must not be stripped out')
    })

    // The refinement narrows; it never widens.
    test(`${label}: a family absent from the family list stays unvendored however complete its faces`, () => {
      const base = fontsBase(['Inter'], undefined,
        { faces: { Inter: { normal: [400] }, Anton: { normal: [400] } } })
      const [html] = capturingStderr(() => render(['Anton'], base))
      assert.equal(hasGoogleEgress(html), true, 'faces cannot promote a family the manifest does not declare')
    })

    // A manifest predating the refinement carries no face information at all.
    // It partitions at family level — the behaviour that shipped before this —
    // rather than treating every face as missing.
    test(`${label}: a manifest with NO face information partitions at family level`, () => {
      const base = fontsBase(['Playfair Display'])
      const [html] = capturingStderr(() => render(['Playfair+Display:ital@1'], base))
      assert.equal(hasGoogleEgress(html), false,
        'with nothing to refine against, the family-level answer stands')
    })

    // Anything unparseable falls through. Fetching a font we happen to have
    // costs one request; silently dropping one we lack costs the author a
    // wrong face in a finished export.
    for (const spec of ['Inter:wght@100..900', 'Inter:opsz@14', 'Inter:slnt@-10', 'Inter:GRAD@150',
                        'Inter:ital,wght@1', 'Inter:wght@abc', 'Inter:ital@2', 'Inter:']) {
      test(`${label}: ${JSON.stringify(spec)} is not confidently parseable, so it goes to Google`, () => {
        const base = fontsBase(FAMILIES, undefined, REAL)
        const [html] = capturingStderr(() => render([spec], base))
        assert.equal(hasGoogleEgress(html), true, `${spec} must fall through rather than be guessed at`)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// (6) The whole picker, against the real manifest: still zero egress
// ---------------------------------------------------------------------------
//
// The point of the refinement is to stop silently-wrong faces, NOT to start
// fetching picker fonts from Google. All twenty `FONT_OPTIONS` specs must
// still resolve entirely locally — including `Bebas+Neue:wght@400;700`, which
// only the `requested` half of the manifest can satisfy.
describe('fonts: every picker spec is still served locally', () => {
  const PICKER = [
    'Inter:wght@400;700', 'Roboto:wght@400;700', 'Open+Sans:wght@400;700', 'Lato:wght@400;700',
    'Montserrat:wght@400;700', 'Poppins:wght@400;700', 'Raleway:wght@400;700', 'Nunito:wght@400;700',
    'Work+Sans:wght@400;700', 'DM+Sans:wght@400;700', 'Rubik:wght@400;700', 'Oswald:wght@400;700',
    'Bebas+Neue:wght@400;700', 'Playfair+Display:wght@400;700', 'Merriweather:wght@400;700',
    'Source+Serif+4:wght@400;700', 'JetBrains+Mono:wght@400;700', 'Baloo+2:wght@400;500;600;700;800',
    'Fredoka:wght@300;400;500;600;700', 'Sniglet:wght@400;800',
  ]
  const FAMILIES = PICKER.map((s) => s.split(':')[0].replace(/\+/g, ' '))
  const faces = {}
  const requested = {}
  for (const spec of PICKER) {
    const [name, axes] = spec.split(':')
    const family = name.replace(/\+/g, ' ')
    const weights = axes.slice('wght@'.length).split(';').map(Number)
    requested[family] = { normal: weights }
    // Bebas Neue is the one family that did not receive every weight it asked
    // for, so it is the one whose `faces` and `requested` differ.
    faces[family] = { normal: family === 'Bebas Neue' ? [400] : weights }
  }

  for (const [label, render] of RENDERERS()) {
    test(`${label}: all twenty picker specs reach Google not at all`, () => {
      const base = fontsBase(FAMILIES, undefined, { faces, requested })
      const [html, warnings] = capturingStderr(() => render(PICKER, base))
      assert.equal(hasGoogleEgress(html), false,
        'a picker-only project must stay zero-egress — that is the whole point of vendoring')
      assert.equal((html.match(/<link /g) ?? []).length, 1, 'the vendored stylesheet is the only <link>')
      assert.equal(warnings.length, 1, 'the digest line only — nothing fell through')
      assert.doesNotMatch(warnings[0], /not in the vendored set/)
    })

    test(`${label}: Bebas Neue is zero-egress ONLY because of \`requested\``, () => {
      // Drop the `requested` half and the same spec must cross to Google —
      // proof that the key is load-bearing rather than decorative.
      const base = fontsBase(FAMILIES, undefined, { faces })
      const [html] = capturingStderr(() => render(['Bebas+Neue:wght@400;700'], base))
      assert.equal(hasGoogleEgress(html), true,
        'without `requested`, the absent 700 face sends the spec to Google')
    })
  }
})
