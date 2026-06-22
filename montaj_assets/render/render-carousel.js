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

const __dirname = dirname(fileURLToPath(import.meta.url))

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
        const workDir = await bundleSlide({ slide, width, height, projectDir })

        try {
          const htmlPath = join(workDir, 'index.html')
          const page     = await browser.newPage()

          try {
            await page.setViewport({ width, height, deviceScaleFactor: scale })
            await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30_000 })

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

async function bundleSlide({ slide, width, height, projectDir }) {
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

function resolveAsset(p) {
  if (!p) return p
  if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p
  if (p.startsWith('/')) return 'file://' + p
  return 'file://' + projectDir + '/' + p
}

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

  writeFileSync(htmlPath, generateHtml(width, height, googleFonts))

  return workDir
}

// ---------------------------------------------------------------------------
// HTML page template
// ---------------------------------------------------------------------------

function generateHtml(width, height, googleFonts = []) {
  // Each entry is appended verbatim as a `family=...` parameter on the Google
  // Fonts CSS2 API URL (entries are pre-formatted, e.g. "Archivo+Black" /
  // "Inter:wght@400;600;700;800" — spaces as '+'). We intentionally do NOT
  // URL-encode: the API requires literal '+', ':', '@', ';'. Same shape the
  // video renderer (bundle.js) and the editor preview emit.
  const fontLinks = googleFonts.length === 0 ? '' : `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${googleFonts.map(f => `family=${f}`).join('&')}&display=swap">`
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

