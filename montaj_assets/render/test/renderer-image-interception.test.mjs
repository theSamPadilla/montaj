// render/test/renderer-image-interception.test.mjs
//
// Smoke test for the HDR image interceptor in renderer.js.
//
// Strategy: rather than exercising the full renderAllSegments pipeline
// (which requires a real JSX overlay, esbuild bundling, and many more moving
// parts), we exercise the interceptor logic end-to-end with a Puppeteer
// session wired identically to the one renderChunk creates. This covers the
// load-bearing assertion: an sRGB PNG referenced from a local HTML page is
// served back as an HDR-encoded PNG by the interceptor, and the screenshot
// captured by Puppeteer reflects the converted pixel values.
//
// Skipped on systems where `ffmpeg -filters` does not include zscale, because
// lib.normalize_image requires zscale.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import puppeteer from 'puppeteer'
import { isHdr } from '../color-space.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { renderAllSegments } from '../renderer.js'
import { sdrRecaptureSpecs, mergeSdrCaptures } from '../render.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// MONTAJ_ROOT is two levels above montaj_assets/render/
const MONTAJ_ROOT = join(__dirname, '..', '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if ffmpeg has the zscale filter available. */
function hasZscale() {
  const r = spawnSync('ffmpeg', ['-filters'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 && r.stdout.includes('zscale')
}

/** Creates a 10×10 solid-colour PNG at `path` using ffmpeg lavfi.
 *  R=200, G=50, B=100 in sRGB space. */
function createSrgbPng(path) {
  // lavfi color filter produces an RGB24 PNG. We explicitly request pix_fmt=rgb24
  // so there's no alpha channel to confuse spot-checking.
  // -update 1 is required to write a single PNG to a non-pattern path.
  const r = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', 'color=c=0xC83264:size=10x10:rate=1',
    '-frames:v', '1',
    '-pix_fmt', 'rgb24',
    '-update', '1',
    path,
  ], { encoding: 'utf8', timeout: 15_000 })
  if (r.status !== 0) throw new Error(`ffmpeg PNG creation failed:\n${r.stderr}`)
}

/** Spawn lib.normalize_image async. Returns true on success, false on failure. */
function spawnNormalizeImage(srcPath, colorSpace, outPath) {
  return new Promise((resolve) => {
    let stderr = ''
    let proc
    try {
      proc = spawn(PYTHON, [
        '-m', 'lib.normalize_image',
        '--input', srcPath,
        '--color-space', colorSpace,
        '--out', outPath,
      ], { cwd: MONTAJ_ROOT })
    } catch (err) {
      resolve(false)
      return
    }
    proc.stderr.on('data', d => { stderr += d.toString('utf8') })
    proc.on('close', (code) => {
      if (code !== 0) {
        process.stderr.write(`[test] normalize_image stderr: ${stderr.trim().slice(-300)}\n`)
        resolve(false)
      } else {
        resolve(true)
      }
    })
    proc.on('error', () => resolve(false))
  })
}

/** Read a single pixel (R,G,B) from a PNG at coordinates (x,y) using ffprobe/ffmpeg. */
function readPixelRgb(pngPath, x, y) {
  // Use ffmpeg to crop a 1x1 region and convert to rawvideo RGB24.
  const r = spawnSync('ffmpeg', [
    '-y', '-i', pngPath,
    '-vf', `crop=1:1:${x}:${y},format=rgb24`,
    '-f', 'rawvideo',
    '-frames:v', '1',
    'pipe:1',
  ], { encoding: 'buffer', timeout: 10_000 })
  if (r.status !== 0) throw new Error('ffmpeg pixel read failed')
  const buf = r.stdout
  if (buf.length < 3) throw new Error(`expected ≥3 bytes, got ${buf.length}`)
  return { r: buf[0], g: buf[1], b: buf[2] }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

// MONTAJ_REQUIRE_HDR_FFMPEG=1: a missing capability fails instead of skipping.
function skipOrThrow(t, reason) {
  if (process.env.MONTAJ_REQUIRE_HDR_FFMPEG === '1') throw new Error(`MONTAJ_REQUIRE_HDR_FFMPEG=1 but ${reason}`)
  t.skip(reason)
}

test('HDR image interceptor converts sRGB PNG to HDR-encoded values', { timeout: 60_000 }, async (t) => {
  if (!hasZscale()) {
    skipOrThrow(t, 'zscale not available in ffmpeg — skipping HDR interception test')
    return
  }

  const workDir = mkdtempSync(join(tmpdir(), 'montaj-interception-test-'))

  try {
    // 1. Create a 10×10 sRGB test PNG (R=200, G=50, B=100)
    const srcPng = join(workDir, 'test-srgb.png')
    createSrgbPng(srcPng)

    // Verify source pixel is close to our target sRGB values
    const srcPx = readPixelRgb(srcPng, 5, 5)
    // ffmpeg lavfi color=0xC83264 → R=200=0xC8, G=50=0x32, B=100=0x64
    assert.ok(Math.abs(srcPx.r - 200) <= 5, `source R should be ~200, got ${srcPx.r}`)
    assert.ok(Math.abs(srcPx.g - 50)  <= 5, `source G should be ~50, got ${srcPx.g}`)
    assert.ok(Math.abs(srcPx.b - 100) <= 5, `source B should be ~100, got ${srcPx.b}`)

    // 2. Write a minimal HTML page that loads the image
    const htmlPath = join(workDir, 'index.html')
    writeFileSync(htmlPath, `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>* { margin:0; padding:0; } html, body { width:100px; height:100px; background:black; }</style>
</head>
<body>
<img id="img" src="file://${srcPng}" style="position:absolute; left:10px; top:10px; width:10px; height:10px;" />
</body>
</html>`)

    // 3. Launch Puppeteer with the same args as renderer.js launchBrowser()
    const colorSpace = 'hdr_hlg'
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--allow-file-access-from-files'],
      protocolTimeout: 120000,
    })

    let screenshotPath
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 100, height: 100, deviceScaleFactor: 1 })

      // 4. Wire up the same interceptor logic as renderChunk
      await page.setRequestInterception(true)
      page.on('request', async (request) => {
        try {
          const resourceType = request.resourceType()
          if (resourceType !== 'image') { request.continue(); return }

          const url = request.url()
          if (/\.svg$/i.test(url)) { request.continue(); return }
          if (!url.startsWith('file://')) { request.continue(); return }

          let srcPath
          try { srcPath = decodeURIComponent(url.replace(/^file:\/\//, '')) }
          catch { request.continue(); return }

          if (!existsSync(srcPath)) { request.continue(); return }

          const dir = dirname(srcPath)
          const stem = basename(srcPath, extname(srcPath))
          // colorSpace key already starts with 'hdr_' (e.g. 'hdr_hlg'), so the
          // suffix '_${colorSpace}' produces e.g. 'logo_hdr_hlg.png' as specified.
          const outPath = join(dir, `${stem}_${colorSpace}.png`)

          if (existsSync(outPath)) {
            request.respond({ status: 200, contentType: 'image/png', body: readFileSync(outPath) })
            return
          }

          const ok = await spawnNormalizeImage(srcPath, colorSpace, outPath)
          if (ok) {
            request.respond({ status: 200, contentType: 'image/png', body: readFileSync(outPath) })
          } else {
            request.continue()
          }
        } catch (err) {
          process.stderr.write(`[test interceptor] error: ${err.message}\n`)
          try { request.continue() } catch {}
        }
      })

      await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })

      // Give the image a moment to load through the interceptor
      await page.waitForFunction(() => {
        const img = document.getElementById('img')
        return img && img.complete && img.naturalWidth > 0
      }, { timeout: 15_000 })

      screenshotPath = join(workDir, 'screenshot.png')
      await page.screenshot({ path: screenshotPath, omitBackground: false })
      await page.close()
    } finally {
      await browser.close()
    }

    // 5. Check that the cached converted file was created
    const dir = dirname(srcPng)
    const stem = basename(srcPng, extname(srcPng))
    // colorSpace key 'hdr_hlg' already contains 'hdr_' so suffix is '_hdr_hlg'
    const outPath = join(dir, `${stem}_${colorSpace}.png`)
    assert.ok(existsSync(outPath), `HDR-converted PNG should exist at ${outPath}`)

    // 6. Read the pixel at the image position (10,10) from the screenshot
    const screenshotPx = readPixelRgb(screenshotPath, 15, 15)  // center of the 10x10 image at offset 10,10

    // The converted PNG has HDR HLG encoding applied (zscale colour transform +
    // 2x brightness boost). The resulting pixel values should differ from the
    // source sRGB values by more than 30 on at least one channel — confirming
    // conversion ran rather than the sRGB passthrough being used.
    const deltaR = Math.abs(screenshotPx.r - srcPx.r)
    const deltaG = Math.abs(screenshotPx.g - srcPx.g)
    const deltaB = Math.abs(screenshotPx.b - srcPx.b)
    const maxDelta = Math.max(deltaR, deltaG, deltaB)

    assert.ok(
      maxDelta > 30,
      `Screenshot pixel should differ from sRGB source by >30 on at least one channel `
      + `(confirms HDR conversion ran). `
      + `Source: R=${srcPx.r} G=${srcPx.g} B=${srcPx.b}. `
      + `Screenshot: R=${screenshotPx.r} G=${screenshotPx.g} B=${screenshotPx.b}. `
      + `Max delta: ${maxDelta}`
    )
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('isHdr: returns true for hdr_hlg and hdr_pq, false otherwise', () => {
  assert.equal(isHdr('hdr_hlg'), true)
  assert.equal(isHdr('hdr_pq'), true)
  assert.equal(isHdr('sdr'), false)
  assert.equal(isHdr(null), false)
  assert.equal(isHdr(undefined), false)
  assert.equal(isHdr(''), false)
})

// ---------------------------------------------------------------------------
// hdrImages: the per-segment count of <img> fetches served a converted body
// (PV42 T7). render.js re-captures exactly the segments with hdrImages > 0 for
// the SDR export, because those captures carry HDR-converted pixels.
// ---------------------------------------------------------------------------

/** Render one tiny overlay whose JSX loads `imgSrc`; returns the segment result. */
async function renderImgOverlay(dir, imgSrc, colorSpace, tag) {
  const jsx = join(dir, `ov-${tag}.jsx`)
  writeFileSync(jsx, `export default function Ov() {
  return <div style={{ width: 200, height: 200 }}><img src="${imgSrc}" style={{ width: 100, height: 100 }} /></div>
}
`)
  const { htmlPath, workDir } = await bundleComponent({
    componentPath: jsx, props: {}, fps: 10, durationFrames: 2, width: 200, height: 200,
  })
  try {
    const [seg] = await renderAllSegments([{
      id: `seg-${tag}`, htmlPath, fps: 10, width: 200, height: 200,
      frameCount: 2, startSeconds: 0, endSeconds: 0.2,
      outputPath: join(dir, `seg-${tag}.mkv`),
    }], { workers: 1, colorSpace })
    return seg
  } finally {
    cleanupBundle(workDir)
  }
}

test('renderAllSegments reports hdrImages: HDR local PNG = 1, SVG-only and SDR = 0', { timeout: 120_000 }, async (t) => {
  if (!hasZscale()) { skipOrThrow(t, 'zscale not available in ffmpeg'); return }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-hdrimages-'))
  try {
    const png = join(dir, 'logo.png')
    createSrgbPng(png)
    const svg = join(dir, 'mark.svg')
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')

    const hdr = await renderImgOverlay(dir, `file://${png}`, 'hdr_hlg', 'hdr-png')
    assert.equal(hdr.hdrImages, 1, 'one converted PNG served in an HDR job')

    const vec = await renderImgOverlay(dir, `file://${svg}`, 'hdr_hlg', 'hdr-svg')
    assert.equal(vec.hdrImages, 0, 'SVG is never converted')

    const sdr = await renderImgOverlay(dir, `file://${png}`, 'sdr_bt709', 'sdr-png')
    assert.equal(sdr.hdrImages, 0, 'no interceptor in an SDR job')

    const none = await renderImgOverlay(dir, `file://${png}`, null, 'null-png')
    assert.equal(none.hdrImages, 0, 'no colour space, no interceptor')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SDR pass re-captures only segments with hdrImages > 0 and keeps the rest', () => {
  const rendered = [
    { id: 'a', webmPath: '/s/a.mkv', hdrImages: 2, offsetX: 5, opacity: 0.5, keyframes: [{}] },
    { id: 'b', webmPath: '/s/b.mkv', hdrImages: 0, offsetX: 7 },
  ]
  const specs = [
    { id: 'a', outputPath: '/s/a.mkv', htmlPath: '/w/a.html' },
    { id: 'b', outputPath: '/s/b.mkv', htmlPath: '/w/b.html' },
  ]
  const recapture = rendered.filter(s => s.hdrImages > 0)
  const respecs = sdrRecaptureSpecs(recapture, specs)
  assert.deepEqual(respecs.map(s => [s.id, s.outputPath]), [['a', '/s/sdr/a.mkv']])
  assert.equal(specs[0].outputPath, '/s/a.mkv', 'input spec not mutated')

  // Overlays `a` and `a-sdr` must not share a re-capture path.
  const both = sdrRecaptureSpecs(
    [{ id: 'a' }, { id: 'a-sdr' }],
    [{ id: 'a', outputPath: '/s/a.mkv' }, { id: 'a-sdr', outputPath: '/s/a-sdr.mkv' }])
  assert.notEqual(both[0].outputPath, both[1].outputPath)
  assert.notEqual(both[0].outputPath, '/s/a-sdr.mkv', 'a re-capture never lands on another overlay\'s own path')

  const merged = mergeSdrCaptures(rendered, [{ id: 'a', webmPath: '/s/sdr/a-chunk-0.mkv' }])
  assert.equal(merged[0].webmPath, '/s/sdr/a-chunk-0.mkv')
  assert.equal(merged[0].offsetX, 5, 'geometry carries over')
  assert.equal(merged[0].opacity, 0.5)
  assert.equal(merged[0].keyframes.length, 1)
  assert.equal(merged[1].webmPath, '/s/b.mkv', 'untouched segment keeps its capture')
  assert.equal(mergeSdrCaptures(rendered, [])[0].webmPath, '/s/a.mkv', 'nothing recaptured: identity')
})
