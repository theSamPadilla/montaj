#!/usr/bin/env node
/**
 * render-carousel.js — Render a carousel project.json into per-slide PNGs.
 *
 * Usage:
 *   node render-carousel.js --project-json <path> [--out <dir>] [--clean]
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

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)

if (!argv.length || argv[0] === '--help') {
  process.stderr.write('Usage: render-carousel.js --project-json <path> [--out <dir>] [--clean]\n')
  process.exit(1)
}

let projectJsonArg = null
let outArg         = null
let cleanArg       = false

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--project-json') { projectJsonArg = argv[++i]; continue }
  if (argv[i] === '--out')          { outArg         = argv[++i]; continue }
  if (argv[i] === '--clean')        { cleanArg       = true;      continue }
  process.stderr.write(`Unknown argument: ${argv[i]}\n`)
  process.stderr.write('Usage: render-carousel.js --project-json <path> [--out <dir>] [--clean]\n')
  process.exit(1)
}

if (!projectJsonArg) {
  fail('missing_argument', '--project-json is required')
}

main(projectJsonArg, { out: outArg, clean: cleanArg }).catch(err => {
  fail('render_error', err.message ?? String(err))
})

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(projectJsonPath, { out, clean }) {
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
    args:      ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'],
  })

  const manifestSlides = []

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
            await page.setViewport({ width, height, deviceScaleFactor: 1 })
            await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30_000 })

            // Belt-and-suspenders: wait for all images to finish loading
            await page.evaluate(() =>
              Promise.all(
                [...document.images].map(img =>
                  img.complete ? null : new Promise(r => { img.onload = img.onerror = r })
                )
              )
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

        manifestSlides.push({ index: i + 1, file: fileName, width, height })
        log(`  → ${outFile}`)
      } catch (err) {
        fail('render_error', `slide ${i + 1} (id=${slide.id}): ${err.message}`)
      }
    }
  } finally {
    await browser.close()
  }

  // 4. Write manifest
  const manifest = { aspect, resolution: [width, height], slides: manifestSlides }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Step output convention: output dir on stdout
  process.stdout.write(outDir + '\n')
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
import { interpolate, spring } from 'montaj/render'
import * as __iconPh__ from '@phosphor-icons/react'
import { FontAwesomeIcon as __iconFaIcon__ } from '@fortawesome/react-fontawesome'
import * as __iconFaSolid__ from '@fortawesome/free-solid-svg-icons'
import * as __iconFaBrands__ from '@fortawesome/free-brands-svg-icons'
import { Slide } from ${JSON.stringify(slidePath)}
${overlayImports}

// Bare-global fallbacks — overlays that read globals directly won't crash
window.interpolate = interpolate
window.spring      = spring
window.Ph          = __iconPh__
window.FaIcon      = __iconFaIcon__
window.FaSolid     = __iconFaSolid__
window.FaBrands    = __iconFaBrands__
window.fps         = 30
window.duration    = 60
window.frame       = 0
window.props       = {}

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
      'montaj/render': join(__dirname, 'core', 'index.js'),
    },
    nodePaths: [join(__dirname, 'node_modules')],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'silent',
  })

  writeFileSync(htmlPath, generateHtml(width, height))

  return workDir
}

// ---------------------------------------------------------------------------
// HTML page template
// ---------------------------------------------------------------------------

function generateHtml(width, height) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
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

