#!/usr/bin/env node
/**
 * render-carousel.js — Render a carousel project.json into per-slide PNGs.
 *
 * Usage:
 *   node render-carousel.js --project-json <path> [--out <dir>] [--clean] [--scale <1|2|3>]
 *
 * --scale defaults to 2 (high-DPI): slides rasterize at 2× the design canvas
 * (e.g. portrait 1080×1350 → 2160×2700 PNGs) so they stay crisp on desktop /
 * Retina. deviceScaleFactor scales only the raster — the logical viewport stays
 * at the design resolution, so layout/coordinates are pixel-identical to 1×.
 * Pass --scale 1 to opt back into 1× (design-resolution) output.
 *
 * stdout: absolute path to the output directory (follows step output convention)
 * stderr: progress lines + JSON error on failure
 * exit 0 on success, exit 1 on failure
 */
import esbuild        from 'esbuild'
import puppeteer      from 'puppeteer'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, unlinkSync, existsSync } from 'fs'
import { resolve, join, dirname }                         from 'path'
import { fileURLToPath }                                  from 'url'
import { tmpdir }                                         from 'os'
import { randomBytes }                                    from 'crypto'
import { toFileHref, fontsCssHref, assetResolverSource } from './file-url.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Absolute directory holding a vendored fonts.css, set by whoever spawns this
// process (the Electron shell; nothing in the CLI/OSS case). Same env var,
// same "configuration, never project data" contract as render.js's
// MONTAJ_FONTS_DIR — see that file, and vendoredFontsHref's doc comment
// below, for why a base must never travel inside a project/slide. This file
// is its own CLI entry point (not spawned via render.js), so it needs its own
// read rather than inheriting one. Unset → '', which bundleSlide's own
// default already treats as "no base" and falls back to today's googleapis
// output byte-for-byte.
const MONTAJ_FONTS_DIR = process.env.MONTAJ_FONTS_DIR || ''

// ---------------------------------------------------------------------------
// Utilities (must be defined before CLI parsing so fail() is usable up-top)
// ---------------------------------------------------------------------------

const TTY = process.stderr.isTTY
const C   = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

function log(msg) {
  process.stderr.write(`${C.cyan}[render]${C.reset} ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}

// Single source of truth for the carousel raster scale. 2× by default so slides
// export at high-DPI (e.g. 1080×1350 → 2160×2700) without any caller needing to
// pass --scale. The CLI (`montaj render`) and HTTP (`POST /render`) layers both
// omit the flag when scale is unspecified, so they inherit this default. An
// explicitly passed --scale (1, 3) still wins.
const DEFAULT_SCALE = 2

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)

if (!argv.length || argv[0] === '--help') {
  process.stderr.write('Usage: render-carousel.js --project-json <path> [--out <dir>] [--clean] [--scale <1|2|3>]\n')
  process.exit(1)
}

let projectJsonArg = null
let outArg         = null
let cleanArg       = false
let scaleArg       = DEFAULT_SCALE

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--project-json') { projectJsonArg = argv[++i]; continue }
  if (argv[i] === '--out')          { outArg         = argv[++i]; continue }
  if (argv[i] === '--clean')        { cleanArg       = true;      continue }
  if (argv[i] === '--scale') {
    const raw = argv[++i]
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 3) {
      fail('invalid_argument', `--scale must be one of 1, 2, 3 (got ${JSON.stringify(raw)})`)
    }
    scaleArg = n
    continue
  }
  process.stderr.write(`Unknown argument: ${argv[i]}\n`)
  process.stderr.write('Usage: render-carousel.js --project-json <path> [--out <dir>] [--clean] [--scale <1|2|3>]\n')
  process.exit(1)
}

if (!projectJsonArg) {
  fail('missing_argument', '--project-json is required')
}

main(projectJsonArg, { out: outArg, clean: cleanArg, scale: scaleArg }).catch(err => {
  fail('render_error', err.message ?? String(err))
})

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(projectJsonPath, { out, clean, scale = DEFAULT_SCALE }) {
  const absProjectPath = resolve(projectJsonPath)
  const projectDir     = dirname(absProjectPath)

  // 1. Read + validate project.json
  let projectJson
  try {
    projectJson = JSON.parse(readFileSync(absProjectPath, 'utf8'))
  } catch (err) {
    fail('read_error', `Cannot read project.json: ${err.message}`)
  }

  if (projectJson.projectType !== 'carousel') {
    fail('not_a_carousel', `projectType must be 'carousel', got '${projectJson.projectType ?? 'undefined'}'`)
  }

  const settings = projectJson.settings ?? {}
  const [width, height] = settings.resolution ?? [1080, 1080]
  const slides    = projectJson.slides ?? []
  const aspect    = projectJson.carousel?.aspect ?? 'square'

  // 2. Resolve output directory
  const outDir = out ? resolve(out) : join(projectDir, 'render')

  // --clean: selectively delete only carousel render artifacts (slide_*.png + manifest.json)
  // so that coexisting video renders (final.mp4, etc.) in the same render/ dir are not lost.
  if (clean && existsSync(outDir)) {
    for (const f of readdirSync(outDir)) {
      if (/^slide_\d+\.png$/.test(f) || f === 'manifest.json') {
        unlinkSync(join(outDir, f))
      }
    }
  }
  mkdirSync(outDir, { recursive: true })

  // 3. Launch Puppeteer once for the whole run
  log('launching browser...')
  const browser = await puppeteer.launch({
    headless:  'new',
    // --disable-dev-shm-usage: use /tmp instead of the container's 64MB /dev/shm
    // (Docker default) so heavy renders don't crash Chromium on shm exhaustion.
    args:      ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
  })

  const manifestSlides = []
  // Per-slide failures are recorded here and the loop CONTINUES — one bad slide
  // (e.g. an undecodable asset or a missing overlay template) must never abort the
  // whole batch and silently hand back a truncated carousel. The run still exits
  // non-zero (below) so callers know the output is partial.
  const failures = []

  try {
    for (let i = 0; i < slides.length; i++) {
      const slide    = slides[i]
      const padded   = String(i + 1).padStart(2, '0')
      const fileName = `slide_${padded}.png`
      const outFile  = join(outDir, fileName)

      log(`rendering slide ${i + 1}/${slides.length} (id: ${slide.id ?? i})...`)

      try {
        const workDir = await bundleSlide({ slide, width, height, projectDir, fontsBaseDir: MONTAJ_FONTS_DIR })

        try {
          const htmlPath = join(workDir, 'index.html')
          const page     = await browser.newPage()

          try {
            await page.setViewport({ width, height, deviceScaleFactor: scale })
            await page.goto(toFileHref(htmlPath), { waitUntil: 'networkidle0', timeout: 30_000 })

            // Belt-and-suspenders: wait for all images to finish loading
            await page.evaluate(() =>
              Promise.all(
                [...document.images].map(img =>
                  img.complete ? null : new Promise(r => { img.onload = img.onerror = r })
                )
              )
            )

            // Wait for declared web fonts to be ready so text paints with the
            // real family (e.g. Archivo Black) rather than a fallback — matching
            // the editor preview. Raced against a 5s cap: a slow/blocked font
            // fetch must never hang the render (it proceeds with the fallback).
            await page.evaluate(() =>
              Promise.race([
                document.fonts ? document.fonts.ready : Promise.resolve(),
                new Promise(r => setTimeout(r, 5000)),
              ])
            )

            await page.screenshot({
              path:            outFile,
              type:            'png',
              fullPage:        false,
              omitBackground:  false,
            })
          } finally {
            await page.close()
          }
        } finally {
          rmSync(workDir, { recursive: true, force: true })
        }

        manifestSlides.push({ index: i + 1, file: fileName })
        log(`  → ${outFile}`)
      } catch (err) {
        const message = err?.message ?? String(err)
        log(`  ✗ slide ${i + 1} (id=${slide.id ?? i}) failed: ${message}`)
        failures.push({ index: i + 1, id: slide.id ?? null, error: message })
      }
    }
  } finally {
    await browser.close()
  }

  // 4. Write manifest
  const outputResolution = [width * scale, height * scale]
  const manifest = {
    aspect,
    resolution: [width, height],
    outputResolution,
    scale,
    slides: manifestSlides.map(s => ({
      ...s,
      designWidth:  width,
      designHeight: height,
      width:        outputResolution[0],
      height:       outputResolution[1],
    })),
    // Empty on a fully successful run. Populated (with the original slide index +
    // id + error) for any slide that failed — callers should treat a non-empty
    // failures[] as a partial render.
    failures,
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Step output convention: output dir on stdout. Written even on a partial run so
  // tooling can still locate the slides that DID render.
  process.stdout.write(outDir + '\n')

  // Signal partiality through the exit code without aborting (good slides + manifest
  // are already on disk). Use exitCode rather than process.exit() so stdout flushes.
  if (failures.length > 0) {
    log(`render completed with ${failures.length} failed slide(s) of ${slides.length}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// Bundle one slide into a temp directory (index.html + bundle.js)
// ---------------------------------------------------------------------------

async function bundleSlide({ slide, width, height, projectDir, fontsBaseDir = '' }) {
  const id      = randomBytes(8).toString('hex')
  const workDir = join(tmpdir(), `montaj-carousel-${id}`)
  mkdirSync(workDir, { recursive: true })

  // Collect unique overlay templates referenced by this slide
  const elements        = slide.elements ?? []
  const overlayElements = elements.filter(el => el.type === 'overlay' && el.overlay?.template)
  const uniqueTemplates = [...new Set(overlayElements.map(el => el.overlay.template))]

  // Collect the Google Fonts every element on this slide declares. Mirrors the
  // video renderer (bundle.js) and the editor preview (SlideCanvas →
  // ensureGoogleFontsLoaded): inject the SAME font stylesheet so the headless
  // Chromium render resolves identical glyphs/metrics to the on-device preview.
  // Without this, heavy display families (e.g. "Archivo Black") fall through to
  // whatever each platform's fallback chain has, so preview and final PNG drift.
  const googleFonts = [...new Set(elements.flatMap(el => el.googleFonts ?? []))]

  // Build import lines + registry entries for each unique overlay
  const overlayImports  = uniqueTemplates.map((tpl, idx) =>
    `import __overlay_${idx}__ from ${JSON.stringify(resolve(tpl))}`
  ).join('\n')

  const registryEntries = uniqueTemplates.map((tpl, idx) =>
    `  ${JSON.stringify(tpl)}: __overlay_${idx}__,`
  ).join('\n')

  const slidePath  = join(__dirname, 'templates', 'slide.jsx')
  const slideJson  = JSON.stringify(slide)
  const projDirStr = JSON.stringify(projectDir)

  const shim = `
import { createRoot } from 'react-dom/client'
import { makeOverlayGlobals } from 'montaj-overlay-runtime'
import { Slide } from ${JSON.stringify(slidePath)}
${overlayImports}

// Single source of truth for overlay globals — same factory the overlay
// renderer uses in bundle.js. Carousel is a render context too (offline
// batch, frame-stepped); use 'render' context.
const __overlayGlobals = makeOverlayGlobals('render')
for (const [__k, __v] of Object.entries(__overlayGlobals)) {
  window[__k] = __v
}

// Carousel-specific defaults (slide-instance fields, NOT part of the
// overlay JSX contract — slides set these per-instance externally).
window.fps      = 30
window.duration = 60
window.frame    = 0
window.props    = {}

const overlayRegistry = {
${registryEntries}
}

const slide      = ${slideJson}
const width      = ${width}
const height     = ${height}
const projectDir = ${projDirStr}

${assetResolverSource(projectDir)}

createRoot(document.getElementById('root')).render(
  <Slide
    slide={slide}
    width={width}
    height={height}
    overlayRegistry={overlayRegistry}
    resolveAsset={resolveAsset}
  />
)
`

  const shimPath   = join(workDir, 'shim.jsx')
  const bundlePath = join(workDir, 'bundle.js')
  const htmlPath   = join(workDir, 'index.html')

  writeFileSync(shimPath, shim)

  await esbuild.build({
    entryPoints: [shimPath],
    bundle:      true,
    format:      'esm',
    platform:    'browser',
    outfile:     bundlePath,
    jsx:         'automatic',
    loader:      { '.jsx': 'jsx', '.js': 'js', '.tsx': 'tsx', '.ts': 'ts' },
    alias: {
      'montaj/render':    join(__dirname, 'core', 'index.js'),
      // Force all transitive imports of React to resolve from render's own
      // node_modules, not from overlay-runtime's nested copy. montaj-overlay-runtime
      // is a `file:` symlink, so esbuild follows the symlink and would otherwise
      // pick up react from overlay-runtime/node_modules, producing two React
      // instances which breaks r3f's reconciler.
      'react':            join(__dirname, 'node_modules', 'react'),
      'react-dom':        join(__dirname, 'node_modules', 'react-dom'),
      'react-dom/client': join(__dirname, 'node_modules', 'react-dom', 'client'),
    },
    nodePaths: [join(__dirname, 'node_modules')],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'silent',
  })

  writeFileSync(htmlPath, generateHtml(width, height, googleFonts, fontsBaseDir))

  return workDir
}

// ---------------------------------------------------------------------------
// HTML page template
// ---------------------------------------------------------------------------

// Turn an optional fonts base into the href of a vendored stylesheet, or '' for
// "no base — emit the googleapis URL exactly as before".
//
// `fontsBaseDir` is an absolute filesystem DIRECTORY path containing a
// `fonts.css` that declares every face, and it is app CONFIGURATION threaded
// down from the caller, never project data — a project file is a document that
// gets shared, so a base read out of one would be a path an attacker chooses.
// `file://` + encodeURI is the same rewrite `resolveAsset` (above) applies to
// slide image paths so they resolve in Puppeteer's file:// page context; fonts
// take that route deliberately rather than the Electron shell's http origin,
// which does not exist when a render runs under the plain CLI.
//
// Anything that is not a SINGLE-slash absolute path is ignored rather than
// emitted as a half-formed URL: a relative path, a non-string, an `http(s)://`
// or `file://` URL, and — explicitly — a `//host`-shaped value, which passes a
// naive `startsWith('/')` and would yield `file:////host/fonts.css`. Chromium
// reads that as an empty-host local path and 404s, so it is not egress; it is
// a silent fall to system-fallback glyphs, where the googleapis URL this
// rejection falls back to at least renders.
//
// Deliberately a second, private copy of bundle.js's helper of the same name
// rather than an import: this file already keeps its own `generateHtml` and its
// own asset resolver, and the two renderers stay ignorant of each other. The
// guard must therefore stay byte-identical to bundle.js's — `shim-bake.test.mjs`
// asserts exactly that, because a rule tightened in one renderer only leaves
// the two disagreeing about what a valid base is.
// The guard itself now lives in file-url.js (fontsCssHref), portable to
// Windows drive-letter bases and refusing UNC in both spellings (`//host`,
// `\\host`); both renderers delegate to it, so they cannot drift.
function vendoredFontsHref(fontsBaseDir) {
  return fontsCssHref(fontsBaseDir)
}

// A `googleFonts` entry is a SPEC, not a family name: "Baloo+2:wght@400;500",
// "Playfair+Display:ital@1", "Anton". Everything from the first ':' is the
// axis list, and '+' is how Google's API encodes the space in a family name —
// strip the one, undo the other, and what is left is the family exactly as
// `fonts.css` spells it in its `font-family` declarations, which is what
// `families.json` lists.
//
// Case-folded because CSS font-family matching is case-insensitive: a spec
// that differs from the manifest only in case names a family the vendored
// stylesheet genuinely serves, and treating it as unvendored would buy
// nothing but a fetch from Google.
//
// Duplicated verbatim in render-carousel.js, and pinned identical by
// `shim-bake.test.mjs` — see `vendoredFontsHref` above for why the two
// renderers copy rather than import, and why a rule changed in one copy only
// is worse than the change not being made at all.
function fontFamilyKey(spec) {
  return String(spec).split(':')[0].replace(/\+/g, ' ').trim().toLowerCase()
}

// Read `<base>/families.json` — the manifest the vendoring step writes next to
// `fonts.css` — or `null` if there is no readable one. Read ONCE and handed to
// the three readers below, rather than each opening the file for itself.
//
// Parsing `fonts.css` for its `font-family` declarations, or hardcoding the
// twenty picker families here, would both work today and both rot silently the
// next time the vendored set changes — which is the exact failure this reads a
// manifest to avoid. The manifest is the contract; if it is absent, say so
// (see `reportVendoredFonts`) rather than inventing a list.
//
// Duplicated verbatim in the other renderer and pinned identical by
// `shim-bake.test.mjs`.
function vendoredFontsManifest(fontsBaseDir) {
  try {
    return JSON.parse(readFileSync(fontsBaseDir.replace(/\/+$/, '') + '/families.json', 'utf8'))
  } catch {
    return null
  }
}

// The set of family keys the manifest declares, or `null` for "there is no
// usable manifest here".
//
// `null` and an EMPTY SET lead to the same OUTPUT — nothing is treated as
// vendored — but they are still distinguished, because only `null` is a fault
// and only `null` gets the loud line. An empty `families` array is a
// well-formed manifest saying "nothing is vendored"; `null` says "I cannot
// tell", which is a misconfigured base and worth naming as one.
//
// Manifest entries go through `fontFamilyKey` too, not just the requested
// specs. That is deliberate leniency: a generator that writes Google's
// '+'-encoded spelling ("Open+Sans") into families.json instead of the
// `fonts.css` one still matches, and the failure it avoids is silent egress
// for a family sitting right there on disk.
//
// Duplicated verbatim in the other renderer and pinned identical by
// `shim-bake.test.mjs`.
function vendoredFamilyKeys(manifest) {
  if (!manifest || !Array.isArray(manifest.families)) return null
  return new Set(manifest.families.filter(f => typeof f === 'string').map(fontFamilyKey))
}

// Resolve a `googleFonts` SPEC to the concrete faces it asks Google for, or
// `null` for "I cannot parse this confidently".
//
// `null` MUST be treated as a fall-through by the caller. That is the safe
// direction and it is this feature's established philosophy: fetching a font
// we happen to have costs one request, while silently dropping one we lack
// costs the author a wrong face in a finished export with no visible cause.
//
// A spec is `Family[:axes@tuples]`, where the axes are named in one
// comma-separated list and their values in another, POSITIONALLY:
//
//   Anton                                   → normal 400  (Google's default)
//   Inter:wght@400;700                      → normal 400, normal 700
//   Playfair+Display:ital@1                 → italic 400
//   Playfair+Display:ital,wght@1,700        → italic 700
//   Playfair+Display:ital,wght@0,400;1,700  → normal 400, italic 700
//
// `ital@0` is normal and `ital@1` is italic. Any other axis (`opsz`, `slnt`, a
// custom one like `GRAD`), any variable RANGE (`wght@100..900`), a duplicated
// axis, or a tuple whose arity does not match the axis list all return `null`
// rather than a guess.
//
// Duplicated verbatim in the other renderer and pinned identical by
// `shim-bake.test.mjs`.
function requiredFaces(spec) {
  const s = String(spec)
  const colon = s.indexOf(':')
  // No axis list: Google serves the family's default face, which is normal 400.
  if (colon === -1) return [{ style: 'normal', weight: 400 }]
  const axisPart = s.slice(colon + 1)
  const at = axisPart.indexOf('@')
  // `Family:` with no '@' at all, or more than one — not a shape we model.
  if (at === -1 || axisPart.indexOf('@', at + 1) !== -1) return null
  const axes = axisPart.slice(0, at).split(',')
  const tuples = axisPart.slice(at + 1).split(';')
  const iItal = axes.indexOf('ital')
  const iWght = axes.indexOf('wght')
  // Every axis must be one we model. An unmodelled, duplicated or empty axis
  // name makes the face set unknowable, and a guess here is the silent-wrong
  // answer this whole refinement exists to delete.
  for (let i = 0; i < axes.length; i++) if (i !== iItal && i !== iWght) return null
  const faces = []
  for (const tuple of tuples) {
    const values = tuple.split(',')
    if (values.length !== axes.length) return null
    let style = 'normal'
    let weight = 400
    if (iItal !== -1) {
      const v = values[iItal]
      if (v === '0') style = 'normal'
      else if (v === '1') style = 'italic'
      else return null // an `ital` range (0..1), or junk
    }
    if (iWght !== -1) {
      const v = values[iWght]
      if (!/^\d{1,4}$/.test(v)) return null // a `wght` range (100..900), or junk
      weight = Number(v)
      if (weight < 1 || weight > 1000) return null
    }
    faces.push({ style, weight })
  }
  return faces
}

// The manifest's `faces` and `requested` maps, flattened into one lookup of
// family key → available weights per style. `undefined` means the manifest
// carries NO face information at all.
//
// The vendored set is family + STYLE + WEIGHT, not family. `fonts.css` carries
// only the faces the vendoring pass actually received — every face is
// `font-style: normal`, and the weights are only the ones it asked for. So a
// family-level partition gets `Playfair+Display:ital@1` wrong: the family
// matches, the spec is treated as vendored, the real italic is never fetched,
// and the browser synthesises an oblique from the upright. `Inter:wght@300` is
// the same shape one axis over. Both are silent, and both change what the user
// sees.
//
// A face counts as AVAILABLE if it is in `faces` (we have the file) or in
// `requested` (we asked Google for it and were refused). The second half is
// not a special case: the gap between the two maps is exactly "weights Google
// does not publish", and falling through for one of those fetches a stylesheet
// that declines identically — a guaranteed-useless request rather than a
// probably-useless one. `Bebas+Neue:wght@400;700` is the only picker spec that
// exercises it; Bebas Neue ships no 700 face at all.
//
// NO face information is different from face information covering nothing.
// The first returns `undefined` and leaves the partition at family level, for
// a manifest written before this refinement existed; the second is an empty
// Map and means every requested face is genuinely absent.
//
// Duplicated verbatim in the other renderer and pinned identical by
// `shim-bake.test.mjs`.
function vendoredFaceIndex(manifest) {
  const usable = [manifest && manifest.faces, manifest && manifest.requested]
    .filter(m => m && typeof m === 'object' && !Array.isArray(m))
  if (!usable.length) return undefined
  const index = new Map()
  for (const source of usable) {
    for (const [family, styles] of Object.entries(source)) {
      if (!styles || typeof styles !== 'object') continue
      const key = fontFamilyKey(family)
      let entry = index.get(key)
      if (!entry) index.set(key, (entry = { normal: new Set(), italic: new Set() }))
      for (const style of ['normal', 'italic']) {
        const weights = styles[style]
        if (!Array.isArray(weights)) continue
        for (const w of weights) if (Number.isInteger(w)) entry[style].add(w)
      }
    }
  }
  return index
}

// Whether every face `spec` requires is available locally.
//
// A family with no entry in the index is NOT covered — the index is built from
// the same manifest as the family list, so a family present in one and absent
// from the other means the two disagree, and the safe reading of a
// disagreement is "fall through".
//
// A PARTIALLY vendored spec falls through WHOLE. `Inter:wght@400;300` goes to
// Google as one spec rather than being split into a vendored half and a
// fetched half. Splitting would mean synthesising a new spec string, and a
// spec is the author's — ours to honour or to pass on untouched, never to
// rewrite.
//
// Duplicated verbatim in the other renderer and pinned identical by
// `shim-bake.test.mjs`.
function specFacesAvailable(spec, index) {
  const entry = index.get(fontFamilyKey(spec))
  if (!entry) return false
  const required = requiredFaces(spec)
  if (!required) return false
  return required.every(f => entry[f.style].has(f.weight))
}

// A short, stable fingerprint of the vendored set, logged once per render so a
// preview/render divergence becomes two visibly different strings instead of
// something a human has to infer by watching which fonts load. The editor logs
// the same digest for the manifest its host handed it; if the two do not
// match, the two sides are partitioning against different vendored sets and
// captions WILL differ between editing and export.
//
// It fingerprints the FACES, not just the families, when face information is
// available. A families-only digest would report a match across a set that
// materially changed — re-vendor at a different weight, or drop one, and every
// family name is still identical while what the stylesheet can actually
// resolve is not. That is precisely the silent drift this exists to make loud.
//
// With NO face index the input is byte-for-byte what it was before faces
// existed, so a family-only manifest keeps producing its old digest and stays
// comparable against an older renderer. A face index changes the value exactly
// when there is new information to report, never incidentally.
//
// FNV-1a over the sorted lines, not a crypto hash, and that is deliberate: it
// has to be computable synchronously in a browser too (`crypto.subtle` is
// async), and it is a comparison token, never a security primitive. The
// editor's copy is the same algorithm over the same normalised input, and
// `fonts-fallthrough.test.mjs` pins a literal digest that the editor suite
// pins as well — this TS↔JS seam is the one place a textual comparison cannot
// reach, which is why the literal is the pin.
//
// Duplicated verbatim in the other renderer and pinned identical by
// `shim-bake.test.mjs`.
function familiesDigest(keys, faceIndex) {
  const lines = [...keys].sort().map(key => {
    const entry = faceIndex ? faceIndex.get(key) : undefined
    if (!entry) return key
    const axis = style => `${style}:${[...entry[style]].sort((a, b) => a - b).join(',')}`
    return `${key}\t${axis('normal')}\t${axis('italic')}`
  })
  let h = 0x811c9dc5
  for (const ch of lines.join('\n')) {
    h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Make the vendored set, and any fall-through out of it, visible. An author
// who names a family the vendored set does not carry should learn it here,
// while the render is running, rather than by noticing the wrong face in the
// exported video — silent is the whole defect this partition exists to fix.
// The digest line goes out unconditionally so it can be compared against the
// editor's, which logs the same digest for the list its host handed it.
//
// stderr, never stdout: render.js emits its JSON result on stdout and
// render-carousel.js emits the output directory there, so a line printed to
// stdout would corrupt a caller's parse.
//
// Duplicated verbatim in render-carousel.js and pinned identical by
// `shim-bake.test.mjs`.
function reportVendoredFonts(vendoredKeys, fellThrough, faceIndex) {
  if (vendoredKeys === null) {
    console.error('[montaj] fonts: no readable families.json at the fonts base — treating NOTHING as vendored, '
      + `so the vendored stylesheet is not linked and all ${fellThrough.length} requested families are being fetched from fonts.googleapis.com`)
    return
  }
  console.error(`[montaj] fonts: vendored set ${familiesDigest(vendoredKeys, faceIndex)} (${vendoredKeys.size} families)`)
  if (fellThrough.length) {
    console.error(`[montaj] fonts: not in the vendored set, fetching from fonts.googleapis.com: ${fellThrough.join(', ')}`)
  }
}

function generateHtml(width, height, googleFonts = [], fontsBaseDir = '') {
  // Each entry is appended verbatim as a `family=...` parameter on the Google
  // Fonts CSS2 API URL (entries are pre-formatted, e.g. "Archivo+Black" /
  // "Inter:wght@400;600;700;800" — spaces as '+'). We intentionally do NOT
  // URL-encode: the API requires literal '+', ':', '@', ';'. Same shape the
  // video renderer (bundle.js) and the editor preview emit.
  //
  // A `fontsBaseDir` changes that for the families the vendored stylesheet
  // actually declares — and ONLY those. The vendored set is built from the
  // editor's picker list, while `googleFonts` comes out of project.json, and
  // skills/write-overlay documents arbitrary Google families as first-class.
  // So the page links the vendored stylesheet for what it covers and falls
  // through to googleapis for the remainder, per family.
  //
  // The vendored <link> is emitted only when at least one requested family is
  // actually in the vendored set, and the googleapis <link> only for the
  // remainder. When the remainder is empty — the common case, a project using
  // only picker fonts — the googleapis link and both `preconnect` hints are
  // gone entirely and the page reaches Google not at all. That is the point of
  // the base; a partition that leaked a preconnect would make it pointless.
  //
  // An unreadable manifest is treated as "NOTHING is vendored": no vendored
  // link, every family from Google. The tempting opposite — assume the sheet
  // covers what was asked for — is the silent-wrong option, and it is what
  // this whole change is fixing. This one is loud-wrong: every glyph is
  // correct, preview and render still agree, and the only cost is egress,
  // which is the one failure the log line below already detects. It also
  // matches the editor exactly, where the same rule applies when a host sets
  // a base without handing over a family list.
  const vendoredHref = vendoredFontsHref(fontsBaseDir)
  //
  // The partition is family-level FIRST and then refined per FACE: a spec is
  // vendored only when its family is declared AND every face it requires is
  // available. `faceIndex === undefined` means the manifest carries no face
  // information, which leaves the refinement off and the behaviour at family
  // level — see `vendoredFaceIndex`.
  const manifest     = vendoredHref && googleFonts.length ? vendoredFontsManifest(fontsBaseDir) : null
  const vendoredKeys = vendoredFamilyKeys(manifest)
  const faceIndex    = vendoredFaceIndex(manifest)
  const covered      = f => vendoredKeys.has(fontFamilyKey(f)) && (!faceIndex || specFacesAvailable(f, faceIndex))
  const vendored     = vendoredKeys ? googleFonts.filter(f =>  covered(f)) : []
  const fellThrough  = vendoredKeys ? googleFonts.filter(f => !covered(f)) : googleFonts
  if (vendoredHref && googleFonts.length) reportVendoredFonts(vendoredKeys, fellThrough, faceIndex)
  const googleFontLinks =
    fellThrough.length === 0 ? '' : `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fellThrough.map(f => `family=${f}`).join('&')}&display=swap">`
  const fontLinks =
    googleFonts.length === 0 ? ''
    : (vendored.length ? `
<link rel="stylesheet" href="${vendoredHref}">` : '') + googleFontLinks
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">${fontLinks}
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root {
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
}
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="bundle.js"></script>
</body>
</html>`
}

