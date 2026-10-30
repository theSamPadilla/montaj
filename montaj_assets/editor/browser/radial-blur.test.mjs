// Run: node --test montaj_assets/editor/browser/radial-blur.test.mjs
//
// The preview's spin and zoom blur (src/video/preview/radialBlurGL.ts, the
// shared WebGL2 pass, and RadialBlurSurface.tsx) against timeline-core's CPU
// reference (radialBlurReference), the contract the export meets too, in a
// real Chromium; and against the export itself (render item-blur.js's graph
// run through ffmpeg) on the same pictures.
//
// The fixture (fixtures/radial-blur.tsx) is bundled with esbuild into a temp
// dir and opened from file://. The browser is render's puppeteer and its
// pinned headless Chrome (PUPPETEER_EXECUTABLE_PATH), launched with a
// throwaway profile and no network, and closed at the end. It never reaches a
// running app or the person's browser.
//
// WebGL in the headless shell: on macOS only ANGLE's Metal backend gives a
// WebGL2 context (`--use-angle=metal`; SwiftShader fails to create one,
// measured on chrome-headless-shell 127); elsewhere ANGLE on SwiftShader
// (`--use-angle=swiftshader --enable-unsafe-swiftshader`). With no WebGL2 the
// comparisons skip and say why.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { blurFilterStep, IMAGE_BLUR_FORMAT, VIDEO_BLUR_FORMAT } from '../../render/item-blur.js'
import { buildImageItemFilterParts } from '../../render/encode-segment.js'
import { FFMPEG } from '../../render/ffmpeg-bin.js'
import { radialBlurPlan, radialBlurReference } from '../../timeline-core/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const requireFromRender = createRequire(join(HERE, '..', '..', 'render', 'package.json'))
const { default: puppeteer } = await import(pathToFileURL(requireFromRender.resolve('puppeteer')).href)

const GL_ARGS = process.platform === 'darwin'
  ? ['--use-angle=metal']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']

const BASE_ARGS = ['--use-mock-keychain', '--password-store=basic', '--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND', ...GL_ARGS]

let browser
let workDir
let url

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'radial-blur-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'radial-blur.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(workDir, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  })
  writeFileSync(join(workDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="surface"></div><div id="video"></div><script src="page.js"></script></body></html>')
  url = pathToFileURL(join(workDir, 'index.html')).href
  browser = await puppeteer.launch({
    headless: 'new',
    // File access: the video test reads a file:// clip into WebGL (see that test).
    args: [...BASE_ARGS, '--allow-file-access-from-files'],
  })
})

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

async function open({ noWebgl = false, on = browser } = {}) {
  const page = await on.newPage()
  await page.setViewport({ width: 400, height: 400, deviceScaleFactor: 1 })
  const errors = []
  const warnings = []
  page.on('pageerror', (e) => errors.push(e))
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'warn') warnings.push(m.text()) })
  if (noWebgl) {
    await page.evaluateOnNewDocument(() => {
      for (const C of [OffscreenCanvas, HTMLCanvasElement]) {
        const get = C.prototype.getContext
        C.prototype.getContext = function (kind, ...rest) { return kind === 'webgl2' ? null : get.call(this, kind, ...rest) }
      }
    })
  }
  await page.goto(url)
  await page.waitForFunction(() => window.__ready === true)
  return { page, errors, warnings }
}

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

// Spin and zoom at small and large amounts; centres inside, on an edge and
// outside the picture; the picture alone, letterboxed in a square box, and
// on an engine-style canvas with black bars; and a picture with alpha.
const PIC = { w: 160, h: 90 }
const ALONE = { pic: PIC, box: PIC, at: { x: 0, y: 0 } }
const LETTERBOX = { pic: PIC, box: { w: 160, h: 160 }, at: { x: 0, y: 35 } }
const CASES = [
  ['spin 4, centre inside', { type: 'spin', amount: 4, center: { x: 0.4, y: 0.55 }, ...ALONE }],
  ['spin 30, centre inside', { type: 'spin', amount: 30, center: { x: 0.4, y: 0.55 }, ...ALONE }],
  ['spin 120, centre inside', { type: 'spin', amount: 120, center: { x: 0.4, y: 0.55 }, ...ALONE }],
  ['spin 30, centre on the left edge', { type: 'spin', amount: 30, center: { x: 0, y: 0.5 }, ...ALONE }],
  ['spin 60, centre outside', { type: 'spin', amount: 60, center: { x: 1.3, y: -0.2 }, ...ALONE }],
  ['zoom 5, centre inside', { type: 'zoom', amount: 5, center: { x: 0.4, y: 0.55 }, ...ALONE }],
  ['zoom 40, centre inside', { type: 'zoom', amount: 40, center: { x: 0.4, y: 0.55 }, ...ALONE }],
  ['zoom 180, centre inside', { type: 'zoom', amount: 180, center: { x: 0.4, y: 0.55 }, ...ALONE }],
  ['zoom 60, centre on the top edge', { type: 'zoom', amount: 60, center: { x: 0.5, y: 0 }, ...ALONE }],
  ['zoom 80, centre outside', { type: 'zoom', amount: 80, center: { x: -0.4, y: 1.2 }, ...ALONE }],
  ['spin 45, letterboxed, centre at the box centre', { type: 'spin', amount: 45, center: { x: 0.5, y: 0.5 }, ...LETTERBOX }],
  ['zoom 50, letterboxed, centre above the picture', { type: 'zoom', amount: 50, center: { x: 0.5, y: 0.1 }, ...LETTERBOX }],
  ['spin 45, engine canvas with black bars', { type: 'spin', amount: 45, center: { x: 0.5, y: 0.5 }, ...LETTERBOX, source: 'engine' }],
  ['zoom 70, engine canvas with black bars', { type: 'zoom', amount: 70, center: { x: 0.3, y: 0.4 }, ...LETTERBOX, source: 'engine' }],
  ['spin 50, picture with alpha', { type: 'spin', amount: 50, center: { x: 0.5, y: 0.5 }, ...ALONE, alpha: true }],
  ['zoom 60, picture with alpha', { type: 'zoom', amount: 60, center: { x: 0.6, y: 0.4 }, ...ALONE, alpha: true }],
]

test('WebGL pass against the CPU reference: within a few codes, alpha kept, nothing outside the picture', { timeout: 120_000 }, async (t) => {
  const { page, errors } = await open()
  try {
    if (!(await page.evaluate(() => window.__webgl2))) { t.skip(`no WebGL2 in this Chromium with ${GL_ARGS.join(' ')}`); return }
    let worstAll = 0
    let meanMax = 0
    for (const [label, c] of CASES) {
      const r = await page.evaluate((c) => window.__compare(c), c)
      assert.equal(r.res, 'drawn', `${label}: ${r.res}`)
      t.diagnostic(`${label}: ${r.passes} pass(es) x ${r.taps} taps (travel ${r.travel.toFixed(1)} px): worst ${r.worst}, mean ${r.mean.toFixed(2)} codes, alpha worst ${r.worstAlpha}; ${r.moved.toFixed(1)} codes from the sharp picture`)
      worstAll = Math.max(worstAll, r.worst)
      meanMax = Math.max(meanMax, r.mean)
      assert.ok(r.worst <= 6, `${label}: worst ${r.worst} codes`)
      assert.ok(r.mean < 2, `${label}: mean ${r.mean.toFixed(2)} codes`)
      assert.ok(r.worstAlpha <= 1, `${label}: alpha off by ${r.worstAlpha}`)
      assert.equal(r.outside, 0, `${label}: something drawn outside the picture`)
      // Control: it blurred (a pass-through would match the reference only where nothing moves).
      assert.ok(r.moved > (c.amount < 10 ? 1 : 4), `${label}: only ${r.moved.toFixed(2)} codes from the sharp picture`)
    }
    t.diagnostic(`all cases: worst ${worstAll}, largest mean ${meanMax.toFixed(2)} codes`)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// ── Preview against export ──────────────────────────────────────────────────
//
// The same picture through the preview's pass (in Chromium) and through the
// export's graph (ffmpeg): the image graph (RGB, the picture's size known)
// for a picture alone; the real image builder for a letterboxed one (a
// contain fit, its size probed from the file), which an engine-style canvas
// source must match too; and the
// video graph (YUV) once. Compared inside the picture where the preview reads
// colour back (alpha 128 or more: getImageData unpremultiplies 8 bits), and
// away from pixels the reference covers under 1/16, where the export fades to
// the source (render item-blur.js). Measured (headless shell 127, ANGLE Metal,
// ffmpeg 8.1.2): RGB worst 7, mean under 0.65; the YUV graph worst 8, mean
// under 1. Both renderers must plan on the same picture size: near the
// picture's edges a pass drops what it moves outside (deviation 2), so a plan
// with other tap counts lands differently there (measured: the export planned
// on the box rather than the picture, 58 codes at the worst edge pixel).

/** Runs an export chain (from [0:v] to [o]) over raw RGBA bytes. */
function exportRgba(rgba, w, h, chain) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-',
    '-filter_complex', chain, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { input: Buffer.from(rgba), maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, String(r.stderr).slice(-1500))
  return r.stdout
}

const PARITY = [
  ['spin 30, centre inside', CASES[1][1]],
  ['spin 120, centre inside', CASES[2][1]],
  ['spin 30, centre on the left edge', CASES[3][1]],
  ['spin 60, centre outside', CASES[4][1]],
  ['zoom 40, centre inside', CASES[6][1]],
  ['zoom 180, centre inside', CASES[7][1]],
  ['zoom 80, centre outside', CASES[9][1]],
  ['spin 45, letterboxed', CASES[10][1]],
  ['zoom 50, letterboxed, centre above the picture', CASES[11][1]],
  ['spin 45, engine canvas', CASES[12][1]],
  ['zoom 70, engine canvas', CASES[13][1]],
  ['spin 50, picture with alpha', CASES[14][1]],
  ['zoom 60, picture with alpha', CASES[15][1]],
  ['spin 30, video graph (YUV)', { ...CASES[1][1], yuv: true }],
]

test('preview (WebGL) against export (ffmpeg): within a few codes inside the picture', { timeout: 180_000 }, async (t) => {
  const { page, errors } = await open()
  try {
    if (!(await page.evaluate(() => window.__webgl2))) { t.skip(`no WebGL2 in this Chromium with ${GL_ARGS.join(' ')}`); return }
    let worstAll = 0
    let meanMax = 0
    for (const [label, c] of PARITY) {
      const p = await page.evaluate((c) => window.__preview(c), c)
      assert.equal(p.res, 'drawn', `${label}: ${p.res}`)
      const { pic, box, at } = c
      const item = { blur: c.amount, blurType: c.type, blurX: c.center.x, blurY: c.center.y }
      let exp
      let ew
      let ey
      if (box.h === pic.h && box.w === pic.w) {
        const format = c.yuv ? VIDEO_BLUR_FORMAT : IMAGE_BLUR_FORMAT
        const step = blurFilterStep(item, { vw: pic.w, vh: pic.h, format, alpha: !c.yuv, name: 'q',
          picture: { w: pic.w, h: pic.h, exact: true }, box: { w: pic.w, h: pic.h } })
        exp = exportRgba(p.picture, pic.w, pic.h, `[0:v]${step},format=rgba[o]`)
        ew = pic.w
        ey = 0
      } else {
        // The builder probes the image's size (a contain fit), so it gets a real file.
        const png = join(workDir, `parity-${PARITY.findIndex(([l]) => l === label)}.png`)
        const wr = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${pic.w}x${pic.h}`, '-i', '-',
          '-frames:v', '1', png], { input: Buffer.from(p.picture) })
        assert.equal(wr.status, 0, String(wr.stderr))
        const full = { type: 'image', src: png, start: 0, end: 1, fit: 'contain', scale: 1, offsetX: 0, offsetY: 0, opacity: 1, ...item }
        const chain = buildImageItemFilterParts(full, box.w, box.h, 0, '[canvas]', 1, 0).filterParts[0]
        exp = exportRgba(p.picture, pic.w, pic.h, `${chain.slice(0, -'[img0]'.length)},format=rgba[o]`)
        assert.equal(exp.length, box.w * box.h * 4)
        ew = box.w
        ey = at.y
      }
      // The reference's coverage, for the thin pixels the export fades to the source.
      const center = [c.center.x * box.w - at.x, c.center.y * box.h - at.y]
      const plan = radialBlurPlan({ type: c.type, amount: c.amount, center, rect: pic })
      const { coverage } = radialBlurReference({ data: p.picture, width: pic.w, height: pic.h }, { type: c.type, plan, center })
      let worst = 0
      let sum = 0
      let n = 0
      for (let j = 0; j < pic.h; j++) for (let i = 0; i < pic.w; i++) {
        if (coverage[j * pic.w + i] < 1 / 16) continue
        const g = ((j + at.y) * box.w + (i + at.x)) * 4
        const e = ((j + ey) * ew + i + (ew === box.w ? at.x : 0)) * 4
        if (p.got[g + 3] < 128) continue
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.abs(p.got[g + ch] - exp[e + ch])
          worst = Math.max(worst, d)
          sum += d
          n++
        }
      }
      const mean = sum / Math.max(1, n)
      t.diagnostic(`${label}: worst ${worst}, mean ${mean.toFixed(2)} codes`)
      worstAll = Math.max(worstAll, worst)
      meanMax = Math.max(meanMax, mean)
      assert.ok(worst <= 10, `${label}: worst ${worst} codes`)
      assert.ok(mean < 2, `${label}: mean ${mean.toFixed(2)} codes`)
    }
    t.diagnostic(`preview against export, all cases: worst ${worstAll}, largest mean ${meanMax.toFixed(2)} codes`)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('timing at 1080x1920 (diagnostic only; the GPU this runs on)', { timeout: 120_000 }, async (t) => {
  const { page } = await open()
  try {
    if (!(await page.evaluate(() => window.__webgl2))) { t.skip('no WebGL2'); return }
    // spin 0.01: one pass of 2 taps, so upload, fit, out and the read back alone.
    for (const [type, amount] of [['spin', 0.01], ['spin', 10], ['spin', 30], ['spin', 90], ['zoom', 10], ['zoom', 40], ['zoom', 150]]) {
      const ms = await page.evaluate((o) => window.__timing(o), { type, amount, w: 1080, h: 1920, runs: 10 })
      t.diagnostic(`${type} ${amount} at 1080x1920: ${ms.toFixed(1)} ms a draw, read back included`)
    }
  } finally { await page.close() }
})

test('RadialBlurSurface draws what the pass draws, at the box\'s size; loses its context and comes back', { timeout: 60_000 }, async (t) => {
  const { page, errors, warnings } = await open()
  try {
    if (!(await page.evaluate(() => window.__webgl2))) { t.skip('no WebGL2'); return }
    const opts = { type: 'zoom', amount: 60, w: 120, h: 80, center: { x: 0.3, y: 0.6 } }
    let s = await page.evaluate((o) => window.__surface(o), opts)
    await frames(page)
    s = await page.evaluate((o) => window.__surface(o), opts)
    assert.equal(s.mounted, true)
    assert.equal(s.width, 120)
    assert.equal(s.height, 80)
    assert.equal(s.worst, 0, 'the surface\'s pixels are the pass\'s')
    assert.deepEqual(s.status, [true])

    // Lost: the next draw finds it and the surface renders nothing.
    assert.equal(await page.evaluate(() => window.__lose()), true)
    await frames(page)
    await page.evaluate(() => window.__redraw())
    await page.waitForFunction(() => window.__surfaceState().canvases === 0)
    assert.deepEqual((await page.evaluate(() => window.__surfaceState())).status, [true, false])
    assert.equal(warnings.filter((w) => w.includes('spin and zoom blurs show unblurred')).length, 1)

    // Restored: it renders and draws again.
    await page.evaluate(() => window.__restore())
    await page.waitForFunction(() => window.__surfaceState().canvases === 1, { timeout: 10_000 })
    await page.waitForFunction(() => window.__surfaceState().status.at(-1) === true, { timeout: 10_000 })
    s = await page.evaluate((o) => window.__surface(o), opts)
    assert.equal(s.worst, 0, 'draws the same after the restore')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('a <video> source: drawn on the frame a seek lands on, and on every presented frame while it plays', { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open()
  try {
    if (!(await page.evaluate(() => window.__webgl2))) { t.skip('no WebGL2'); return }
    const clip = pathToFileURL(join(HERE, 'fixtures', 'play-glyph-clip.mp4')).href
    await page.evaluate((src) => window.__videoSurface(src), clip)
    await page.waitForFunction(() => window.__videoState().draws > 0 && window.__videoState().painted > 0.99, { timeout: 10_000 })
    // A seek: the frame it lands on is drawn.
    const before = (await page.evaluate(() => window.__videoState())).draws
    await page.evaluate(() => { window.__video().currentTime = 1.2 })
    await page.waitForFunction((n) => window.__videoState().draws > n, { timeout: 10_000 }, before)
    // Playback: requestVideoFrameCallback draws frame after frame.
    const atPlay = (await page.evaluate(() => window.__videoState())).draws
    await page.evaluate(() => { const v = window.__video(); v.currentTime = 0; return v.play() })
    await new Promise((r) => setTimeout(r, 800))
    const playing = await page.evaluate(() => { const s = window.__videoState(); window.__video().pause(); return s })
    t.diagnostic(`${playing.draws - atPlay} draws in 0.8 s of playback`)
    assert.ok(playing.draws - atPlay >= 10, `only ${playing.draws - atPlay} draws while playing`)
    assert.ok(playing.painted > 0.99, 'the picture is painted')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('a cross-origin <video> (file:// without file access): renders nothing, says so once, no error', { timeout: 60_000 }, async (t) => {
  const strict = await puppeteer.launch({ headless: 'new', args: BASE_ARGS })
  try {
    const { page, errors, warnings } = await open({ on: strict })
    if (!(await page.evaluate(() => window.__webgl2))) { t.skip('no WebGL2'); return }
    await page.evaluate((src) => window.__videoSurface(src), pathToFileURL(join(HERE, 'fixtures', 'play-glyph-clip.mp4')).href)
    await page.waitForFunction(() => window.__video().readyState >= 2, { timeout: 10_000 })
    await page.waitForFunction(() => document.querySelectorAll('#video canvas').length === 0, { timeout: 10_000 })
    assert.equal((await page.evaluate(() => window.__videoState())).draws, 0)
    assert.equal(warnings.filter((w) => w.includes('cross-origin')).length, 1, warnings.join('\n'))
    assert.deepEqual(errors, [])
  } finally { await strict.close() }
})

test('no WebGL2: the surface renders nothing, says so once, and the host is told', { timeout: 60_000 }, async () => {
  const { page, errors, warnings } = await open({ noWebgl: true })
  try {
    const s = await page.evaluate(() => window.__surface({ type: 'spin', amount: 30, w: 100, h: 60, center: { x: 0.5, y: 0.5 } }))
    await page.evaluate(() => window.__surface({ type: 'spin', amount: 40, w: 100, h: 60, center: { x: 0.5, y: 0.5 } }))
    await frames(page)
    assert.equal(s.mounted, false)
    assert.equal(await page.evaluate(() => window.__surfaceState().canvases), 0)
    assert.deepEqual(await page.evaluate(() => window.__surfaceState().status), [false])
    assert.equal(warnings.filter((w) => w.includes('spin and zoom blurs show unblurred')).length, 1, warnings.join('\n'))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
