// render/test/empty-frames.integration.test.mjs (§392(c))
//
// A frame where the overlay draws nothing (the component renders null) is
// captured once per chunk and that capture written for every later such
// frame: a screenshot of a transparent page that draws nothing grows Chrome's
// GPU process by about a viewport-sized surface. Through the real path (a
// worker Chrome, the real bundle, renderChunk and its ffmpeg), held to:
//   - one screenshot for the empty frames, one per drawn frame;
//   - the empty frames fully transparent, the drawn ones drawn;
//   - an opaque capture (no alpha) never reuses: every frame is captured.
// Tiny on purpose: 160x90, 8 frames, a red box on frames 3 to 5.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FFMPEG } from '../ffmpeg-bin.js'
import * as R from '../renderer.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'

const [W, H] = [160, 90]
const FPS = 30
const FRAMES = 8
const JSX = `export default function Box({ frame }) {
  return frame >= 3 && frame < 6 ? <div style={{ position: 'absolute', left: 20, top: 20, width: 40, height: 30, background: '#ff0000' }} /> : null
}
`
let base
const bundles = {}

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-empty-frames-')))
  const projDir = join(base, 'ws', 'proj')
  mkdirSync(join(projDir, 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = join(base, 'ws')
  const componentPath = join(projDir, 'overlays', 'box.jsx')
  writeFileSync(componentPath, JSX)
  for (const opaque of [false, true]) {
    bundles[opaque] = await bundleComponent({ componentPath, props: {}, fps: FPS, durationFrames: FRAMES, width: W, height: H, opaque, projectDir: projDir })
    bundles[opaque].componentPath = componentPath
  }
})

after(() => {
  for (const b of Object.values(bundles)) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

let jobs = 0
function job(opaque) {
  const b = bundles[opaque]
  const id = `overlay-1--box-${++jobs}`
  return {
    id, componentPath: b.componentPath, htmlPath: b.htmlPath, fps: FPS, width: W, height: H, captureScale: 1,
    frameCount: FRAMES, startSeconds: 0, endSeconds: FRAMES / FPS, outputPath: join(base, 'segs', `${id}.mkv`),
    boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts, opaque, subframes: 1,
    frameStart: 0, frameEnd: FRAMES, chunkIndex: 0, totalChunks: 1,
  }
}

/** Counts every screenshot the pages `worker` opens take. */
function countShots(worker, shots) {
  const newPage = worker.browser.newPage.bind(worker.browser)
  worker.browser.newPage = async (...a) => {
    const page = await newPage(...a)
    const shot = page.screenshot.bind(page)
    page.screenshot = (...b) => { shots.n++; return shot(...b) }
    return page
  }
}

function framesOf(mkv) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', mkv, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, `decoding ${mkv}: ${r.stderr}`)
  const size = W * H * 4
  return Array.from({ length: r.stdout.length / size }, (_, i) => r.stdout.subarray(i * size, (i + 1) * size))
}

test('§392(c): empty frames of a transparent overlay are written from one capture', { timeout: 120_000 }, async () => {
  const shots = { n: 0 }
  const worker = await R.launchWorkerBrowser({})
  countShots(worker, shots)
  let frames
  try {
    frames = framesOf((await R.renderChunk(worker, job(false))).webmPath)
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(frames.length, FRAMES)
  assert.equal(shots.n, 4, 'one capture for the five empty frames, one per drawn frame')
  for (const f of [0, 1, 2, 6, 7]) assert.ok(frames[f].every((b) => b === 0), `frame ${f} is fully transparent`)
  for (const f of [3, 4, 5]) assert.ok(frames[f].some((b) => b !== 0), `frame ${f} draws the box`)
})

test('§392(c): an opaque capture never reuses: every frame is captured', { timeout: 120_000 }, async () => {
  const shots = { n: 0 }
  const worker = await R.launchWorkerBrowser({})
  countShots(worker, shots)
  try {
    const frames = framesOf((await R.renderChunk(worker, job(true))).webmPath)
    assert.equal(frames.length, FRAMES)
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(shots.n, FRAMES)
})

test('§392(c): a software-composited browser renders the same overlay', { timeout: 120_000 }, async () => {
  const gpu = await R.launchWorkerBrowser({})
  const sw = await R.launchWorkerBrowser({ gpuCompositing: false })
  assert.equal(sw.gpuCompositing, false)
  let a, b
  try {
    a = framesOf((await R.renderChunk(gpu, job(false))).webmPath)
    b = framesOf((await R.renderChunk(sw, job(false))).webmPath)
  } finally {
    await gpu.close().catch(() => {})
    await sw.close().catch(() => {})
  }
  for (let f = 0; f < FRAMES; f++) assert.ok(Buffer.compare(a[f], b[f]) === 0, `frame ${f}: a flat box composites the same either way`)
})
