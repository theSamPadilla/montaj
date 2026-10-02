// render/test/image-load-wait.integration.test.mjs
//
// A capture waits for every <img> on the page to load and decode, not only the
// extension-less props URLs fetched on demand (props-url-extensionless).
//
// The failure this pins (PL22, pw_screen): an overlay that shows its
// screenshot only from frame 1 has no <img> on the page at frame 0, where every
// capture page starts. A fresh page (every sample, and the first frame of every
// render chunk) jumps to its frame and inserts the <img> in that same commit,
// and the capture went ahead after two animation frames. When the image took
// longer than that to load (a machine under load), the frame came out as an
// empty white window, and the 24 h sample cache then served that blank again
// for the same props.
//
// The image is named by absolute path, as overlays get it, and lives outside
// the render dir the suite runs from. Its load is held back deterministically:
// the page guard lets the request continue (page-guard.js), and the test delays
// that `continue()` for the one image file, so the page, the read boundary and
// Chrome's own file load are the production ones.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HTTPRequest } from 'puppeteer'
import { FFMPEG } from '../ffmpeg-bin.js'
import { fromFileHref } from '../file-url.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { renderAllSegments } from '../renderer.js'
import { sampleOverlay, buildOverlayCacheKey } from '../sample-frame.js'

const SIZE = 64
const SHOT_RGB = [0x22, 0x66, 0xcc]
const WHITE = [0xff, 0xff, 0xff]
// Far longer than a capture takes, so the capture that does not wait is
// always ahead of the image.
const DELAY_MS = 1500

let base, ws, shot, overlay

// White window; the screenshot only from frame 1, as pw_screen's appears once
// its ground has faded in.
const JSX = `export default function Shot({ shot }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
      {frame >= 1 && <img src={shot} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />}
    </div>
  )
}
`

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-image-wait-')))
  ws = join(base, 'ws')
  mkdirSync(join(ws, 'proj', 'overlays'), { recursive: true })
  mkdirSync(join(base, 'My Screens'))
  process.env.MONTAJ_WORKSPACE_DIR = ws
  shot = join(base, 'My Screens', 'projects page.png')
  const hex = SHOT_RGB.map(v => v.toString(16).padStart(2, '0')).join('')
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${SIZE}x${SIZE}`,
    '-frames:v', '1', '-pix_fmt', 'rgb24', shot], { encoding: 'utf8' })
  assert.equal(r.status, 0, `ffmpeg (${FFMPEG}) could not make the screenshot: ${r.stderr}`)
  overlay = join(ws, 'proj', 'overlays', 'shot.jsx')
  writeFileSync(overlay, JSX)
})

after(() => { if (base) rmSync(base, { recursive: true, force: true }) })

/**
 * Holds every page request for `file` back by `ms` (Infinity: never let go)
 * before the guard's `continue()` reaches Chrome. Returns the undo.
 */
function holdImage(file, ms) {
  const original = HTTPRequest.prototype.continue
  HTTPRequest.prototype.continue = async function (...args) {
    const url = this.url()
    if (url.startsWith('file:') && fromFileHref(url) === file) {
      await new Promise(resolve => { if (ms !== Infinity) setTimeout(resolve, ms) })
    }
    return original.apply(this, args)
  }
  return () => { HTTPRequest.prototype.continue = original }
}

/** [r, g, b] at the centre of frame `n` of an image or video. */
function centrePixel(file, n = 0) {
  const r = spawnSync(FFMPEG, ['-loglevel', 'error', '-i', file,
    '-vf', `select=eq(n\\,${n}),crop=2:2:iw/2-1:ih/2-1,scale=1:1:flags=area,format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  assert.equal(r.status, 0, `ffmpeg could not read ${file}: ${r.stderr}`)
  assert.equal(r.stdout.length, 3, `${file} has no frame ${n}`)
  return [...r.stdout]
}

function assertColour(file, rgb, tolerance, label, n = 0) {
  const px = centrePixel(file, n)
  assert.ok(px.every((v, i) => Math.abs(v - rgb[i]) <= tolerance),
    `${label}: frame ${n} centre pixel ${px} is not ${rgb} (${rgb === WHITE ? 'the screenshot drawn' : 'an empty window'})`)
}

async function withStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = (c, ...rest) => { text += String(c); return orig(c, ...rest) }
  try { return [await fn(), text] } finally { process.stderr.write = orig }
}

// The sample cache entry for this overlay at `frame` (the key sampleOverlay
// builds). By key, not by listing the folder: other test files sample into the
// same cache while these run.
const cachedPng = frame => join(tmpdir(), 'montaj-sample-cache',
  `${buildOverlayCacheKey(overlay, { shot }, frame, SIZE, SIZE, [], false, 30)}.png`)

// (a) the sample path (sampleOverlay, which sampleFrame samples each overlay through)
test('sampleOverlay: a screenshot that mounts on the sampled frame and loads slowly is drawn, and cached', { timeout: 120_000 }, async () => {
  const release = holdImage(shot, DELAY_MS)
  try {
    const res = await sampleOverlay({
      componentPath: overlay, props: { shot }, frame: 2, fps: 30, width: SIZE, height: SIZE, durationFrames: 30,
      outPath: join(base, 'sample.png'), projectDir: join(ws, 'proj'),
    })
    assertColour(res.pngPath, SHOT_RGB, 2, 'sample')
    assert.equal(res.degraded, false, 'the image arrived before the capture: nothing to keep out of the cache')
    assert.ok(existsSync(cachedPng(2)), 'the sample was cached')
  } finally {
    release()
  }
})

// (b) the render path: the first frame of a render chunk is a fresh page
test('renderAllSegments: the first frame of a later chunk draws a screenshot that loads slowly', { timeout: 300_000 }, async () => {
  const dir = join(base, 'chunks')
  mkdirSync(dir)
  const release = holdImage(shot, DELAY_MS)
  let workDir
  try {
    const bundle = await bundleComponent({
      componentPath: overlay, props: { shot }, fps: 30, durationFrames: 6, width: SIZE, height: SIZE,
      projectDir: join(ws, 'proj'),
    })
    workDir = bundle.workDir
    // Chunks [0, 3) and [3, 6): frame 3 is the second page's first capture.
    const [seg] = await renderAllSegments([{
      id: 'shot', htmlPath: bundle.htmlPath, fps: 30, width: SIZE, height: SIZE, captureScale: 1,
      frameCount: 6, startSeconds: 0, endSeconds: 0.2, outputPath: join(dir, 'shot.mkv'),
      boundary: bundle.boundary, needsGoogleFonts: bundle.needsGoogleFonts,
    }], { workers: 1, chunkSize: 3 })
    // Every frame at once, so a failure shows which frames lost the screenshot.
    // Through yuv420p and back: a few levels either way.
    const near = (px, rgb) => px.every((v, i) => Math.abs(v - rgb[i]) <= 8)
    const seen = [0, 1, 2, 3, 4, 5].map(n => {
      const px = centrePixel(seg.webmPath, n)
      return near(px, SHOT_RGB) ? 'screenshot' : near(px, WHITE) ? 'empty window' : String(px)
    })
    assert.deepEqual(seen, ['empty window', 'screenshot', 'screenshot', 'screenshot', 'screenshot', 'screenshot'],
      'frames 0 to 5 (chunk 2 starts at frame 3)')
  } finally {
    release()
    if (workDir) cleanupBundle(workDir)
  }
})

// The cap: an image that never loads is waited for 35 s, then the frame is
// captured anyway, the image is named, and the sample is not cached.
test('sampleOverlay: an image still loading after the 35 s cap is captured without it, named, and not cached', { timeout: 120_000 }, async () => {
  const release = holdImage(shot, Infinity)
  try {
    const started = Date.now()
    const [res, log] = await withStderr(() => sampleOverlay({
      // Frame 3, not 2: a key of its own, so no sample above can answer it.
      componentPath: overlay, props: { shot }, frame: 3, fps: 30, width: SIZE, height: SIZE, durationFrames: 30,
      outPath: join(base, 'capped.png'), projectDir: join(ws, 'proj'),
    }))
    assert.ok(Date.now() - started >= 35_000, `captured after ${Date.now() - started} ms, before the cap`)
    assertColour(res.pngPath, WHITE, 2, 'capped sample')
    assert.ok(log.includes(`[montaj] captured before these images loaded (35 s): ${shot}`), log)
    assert.equal(res.degraded, true, 'a sample captured with an image still loading is not cached')
    assert.equal(existsSync(cachedPng(3)), false, 'nothing was written to the sample cache')
  } finally {
    release()
  }
})
