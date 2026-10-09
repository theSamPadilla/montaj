// render/test/three-frame-blank.test.mjs
//
// PL85.1 T6: a 3D overlay frame that did not draw is retried, then fails as
// three_frame_blank, instead of shipping blank.
//
// A <Canvas frameloop="never"> draws only when the shim's __setFrame asks it
// to. Forced one at a time, each of these captured the canvas blank before the
// fix, with the chunk (and the render) succeeding:
//   - the first frame set before r3f had mounted (its first measure late, as on
//     a starved main thread): nothing was registered to draw;
//   - a WebGL context lost before the draw, or after it and before the capture;
//   - a canvas resized after the draw, which clears it;
//   - a Canvas with no useThreeFrame() at all.
// And r3f committed each frame's props after the shim's draw, so a prop driven
// by `frame` was drawn one frame late (a chunk's first frame showed frame 0).
//
// (a)-(j) run the render path itself: a real worker Chrome, the real bundle,
// renderer.js's renderChunk and its ffmpeg, and the frames read back out of the
// chunk's MKV. (k) is sample-frame.js's sampleOverlay, (l) render.js's own fail
// line. The failures are forced from outside the overlay by a script added to
// each new page (evaluateOnNewDocument), never by load: the loss through
// WEBGL_lose_context, a late measure through ResizeObserver.
// `__montajThreeWaitMs` shortens the in-page wait so a failing case fails fast.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { FFMPEG } from '../ffmpeg-bin.js'
import * as R from '../renderer.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { toFileHref } from '../file-url.js'

const SIZE = 160
const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')

// An unlit red plane over the centre of a transparent page: a drawn frame is
// opaque red there, a blank one is transparent.
const PLANE = `export default function Plane() {
  return (
    <Canvas frameloop="never" flat style={{ position: 'absolute', inset: 0 }} camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: true, antialias: false, alpha: true }}>
      <FrameBridge />
      <mesh><planeGeometry args={[2, 2]} /><meshBasicMaterial color="#ff0000" toneMapped={false} /></mesh>
    </Canvas>
  )
}
function FrameBridge() { useThreeFrame(); return null }
`
// The same scene with no useThreeFrame(): nothing ever draws it.
const NO_BRIDGE = `export default function NoBridge() {
  return (
    <Canvas frameloop="never" flat style={{ position: 'absolute', inset: 0 }} camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: true, antialias: false, alpha: true }}>
      <mesh><planeGeometry args={[2, 2]} /><meshBasicMaterial color="#ff0000" toneMapped={false} /></mesh>
    </Canvas>
  )
}
`
// A red square placed by a prop r3f applies: left before frame 5, right from 5.
const MOVING = `export default function Moving({ frame }) {
  const x = frame < 5 ? -1.5 : 1.5
  return (
    <Canvas frameloop="never" flat style={{ position: 'absolute', inset: 0 }} camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: true, antialias: false, alpha: true }}>
      <FrameBridge />
      <mesh position={[x, 0, 0]}><planeGeometry args={[1, 1]} /><meshBasicMaterial color="#ff0000" toneMapped={false} /></mesh>
    </Canvas>
  )
}
function FrameBridge() { useThreeFrame(); return null }
`
const FLAT = `export default function Flat() {
  return <div style={{ position: 'absolute', inset: 0, background: '#00ff00' }} />
}
`

let base, projDir
const bundles = {}

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-three-blank-')))
  const ws = join(base, 'ws')
  projDir = join(ws, 'proj')
  mkdirSync(join(projDir, 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = ws
  for (const [name, jsx] of Object.entries({ Plane: PLANE, NoBridge: NO_BRIDGE, Moving: MOVING, Flat: FLAT })) {
    const componentPath = join(projDir, 'overlays', `${name}.jsx`)
    writeFileSync(componentPath, jsx)
    bundles[name] = await bundleComponent({
      componentPath, props: {}, fps: 30, durationFrames: 30, width: SIZE, height: SIZE, projectDir: projDir,
    })
    bundles[name].componentPath = componentPath
  }
})

after(() => {
  for (const b of Object.values(bundles)) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

/** renderChunk's job for frames [frameStart, frameEnd) of `name`'s bundle. */
function job(name, frameStart, frameEnd) {
  const b = bundles[name]
  const id = `overlay-1--${name.toLowerCase()}-${frameStart}-${Math.random().toString(16).slice(2, 8)}`
  return {
    id, componentPath: b.componentPath, htmlPath: b.htmlPath, fps: 30, width: SIZE, height: SIZE, captureScale: 1,
    frameCount: 30, startSeconds: 0, endSeconds: 1,
    outputPath: join(base, 'segs', `${id}.mkv`), boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts,
    opaque: false, subframes: 1, frameStart, frameEnd, chunkIndex: 0, totalChunks: 1,
  }
}

/** Every page this worker opens runs `scripts` (functions, with their args) before its own. */
function forcing(worker, ...scripts) {
  const newPage = worker.browser.newPage.bind(worker.browser)
  worker.browser.newPage = async (...a) => {
    const page = await newPage(...a)
    for (const [fn, arg] of scripts) await page.evaluateOnNewDocument(fn, arg)
    return page
  }
}

// Forcing scripts. They run in the page, so they carry no closures.
const waitMs = [(ms) => { window.__montajThreeWaitMs = ms }, 300]
/** The first ResizeObserver notifications arrive `ms` late: r3f mounts late. */
const lateMeasure = (ms) => [(ms) => {
  const RO = window.ResizeObserver
  window.ResizeObserver = class extends RO {
    constructor(cb) { super((...a) => setTimeout(() => cb(...a), ms)) }
  }
}, ms]
/**
 * Every canvas's WebGL context is lost on `frame`, before its draw or after it
 * (before the capture), `times` times; a `permanent` loss never restores.
 */
const loseContext = (opts) => [(opts) => {
  let lost = 0
  const lose = () => {
    lost++
    for (const c of document.querySelectorAll('canvas')) {
      const gl = c.getContext('webgl2') ?? c.getContext('webgl')
      const ext = gl?.getExtension('WEBGL_lose_context')
      if (!ext) continue
      if (opts.permanent) ext.restoreContext = () => {}
      ext.loseContext()
    }
  }
  wrapSetFrame(async (n, setFrame) => {
    const due = n === opts.frame && lost < opts.times
    if (due && opts.when === 'before') lose()
    const r = await setFrame(n)
    if (due && opts.when === 'after') lose()
    return r
  })
  function wrapSetFrame(wrap) {
    let inner
    Object.defineProperty(window, '__setFrame', {
      configurable: true,
      get() { return inner },
      set(fn) { inner = (n) => wrap(n, fn) },
    })
  }
}, opts]
/** On `frame`, after the draw and before the capture, the canvas is resized once. */
const resizeAfterDraw = (frame) => [(frame) => {
  let done = false
  let inner
  Object.defineProperty(window, '__setFrame', {
    configurable: true,
    get() { return inner },
    set(fn) {
      inner = async (n) => {
        const r = await fn(n)
        if (n === frame && !done) {
          done = true
          for (const c of document.querySelectorAll('canvas')) c.width += 2
        }
        return r
      }
    },
  })
}, frame]

/** The chunk's frames, decoded to RGBA. */
function framesOf(mkv) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', mkv, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, `decoding ${mkv}: ${r.stderr}`)
  const size = SIZE * SIZE * 4
  return Array.from({ length: r.stdout.length / size }, (_, i) => r.stdout.subarray(i * size, (i + 1) * size))
}

function pixel(frame, x, y) {
  const i = (Math.round(y) * SIZE + Math.round(x)) * 4
  return [...frame.subarray(i, i + 4)]
}
const isRed = ([r, g, b, a]) => r > 200 && g < 60 && b < 60 && a > 200
const isClear = ([, , , a]) => a < 20
/** 'red' or 'blank' at the centre of each frame, else the pixel. */
const centres = (frames) => frames.map(f => {
  const p = pixel(f, SIZE / 2, SIZE / 2)
  return isRed(p) ? 'red' : isClear(p) ? 'blank' : `rgba(${p})`
})

/** Renders the chunk on a fresh worker with `scripts` forced; returns the centres, or the error. */
async function renderForced(j, ...scripts) {
  const worker = await R.launchWorkerBrowser({})
  forcing(worker, ...scripts)
  try {
    const { webmPath } = await R.renderChunk(worker, j)
    return { frames: framesOf(webmPath) }
  } catch (err) {
    return { err }
  } finally {
    await worker.close().catch(() => {})
  }
}

const chunkMkvOf = j => j.outputPath.replace(/\.mkv$/, '') + '-chunk-0.mkv'

test('(a) a 3D overlay renders every frame drawn, as before', { timeout: 120_000 }, async () => {
  const { frames, err } = await renderForced(job('Plane', 0, 3), waitMs)
  assert.ifError(err)
  assert.deepEqual(centres(frames), ['red', 'red', 'red'])
})

test('(b) a 2D overlay page reports no 3D canvas and marks nothing', { timeout: 120_000 }, async () => {
  const worker = await R.launchWorkerBrowser({})
  try {
    const page = await worker.browser.newPage()
    await page.goto(toFileHref(bundles.Flat.htmlPath), { waitUntil: 'networkidle0' })
    assert.equal(await page.evaluate(() => window.__setFrame(1)), null,
      '__setFrame on a page with no 3D canvas returns null: no wait, and no check after the capture')
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-montaj-three]').length), 0)
  } finally {
    await worker.close().catch(() => {})
  }
  const { frames, err } = await renderForced(job('Flat', 0, 2))
  assert.ifError(err)
  assert.deepEqual(frames.map(f => pixel(f, SIZE / 2, SIZE / 2).slice(0, 3).map(v => v > 200 ? 1 : 0)), [[0, 1, 0], [0, 1, 0]])
})

test('(c) a first frame set before r3f has mounted waits for it, and is drawn', { timeout: 120_000 }, async () => {
  // r3f's first measure 1.5 s late: frame 0 is set long before its root exists.
  const { frames, err } = await renderForced(job('Plane', 0, 2), lateMeasure(1500))
  assert.ifError(err)
  assert.deepEqual(centres(frames), ['red', 'red'])
})

test('(d) r3f never mounting in time fails as three_frame_blank (not_rendered)', { timeout: 120_000 }, async () => {
  const j = job('Plane', 0, 2)
  const { err } = await renderForced(j, waitMs, lateMeasure(30_000))
  assert.ok(err, 'the chunk must fail, not render a blank frame')
  assert.equal(err.code, 'three_frame_blank')
  assert.equal(err.reason, 'not_rendered')
  assert.equal(err.frame, 0)
  assert.equal(err.attempts, 3, 'tried, then retried twice')
  assert.match(err.message, /Plane\.jsx/, 'the error names the overlay')
  assert.equal(existsSync(chunkMkvOf(j)), false, 'no partial chunk is left')
})

test('(e) a context lost before the draw is restored, and the frame drawn', { timeout: 120_000 }, async () => {
  const { frames, err } = await renderForced(job('Plane', 0, 3), loseContext({ frame: 1, when: 'before', times: 1 }))
  assert.ifError(err)
  assert.deepEqual(centres(frames), ['red', 'red', 'red'])
})

test('(f) a context lost after the draw, before the capture, is drawn and captured again', { timeout: 120_000 }, async () => {
  const { frames, err } = await renderForced(job('Plane', 0, 3), loseContext({ frame: 1, when: 'after', times: 1 }))
  assert.ifError(err)
  assert.deepEqual(centres(frames), ['red', 'red', 'red'])
})

test('(g) a context that stays lost fails as three_frame_blank (context_lost), naming overlay and frame', { timeout: 120_000 }, async () => {
  for (const when of ['before', 'after']) {
    const j = job('Plane', 0, 3)
    const { err } = await renderForced(j, waitMs, loseContext({ frame: 1, when, times: 99, permanent: true }))
    assert.ok(err, `${when}: the chunk must fail, not render a blank frame`)
    assert.equal(err.code, 'three_frame_blank', `${when}: ${err.message}`)
    assert.equal(err.reason, 'context_lost', when)
    assert.equal(err.frame, 1, when)
    assert.equal(err.attempts, 3, when)
    assert.match(err.message, /Plane\.jsx \(overlay-1--plane-0-/, `${when}: the error names the overlay and its segment`)
    assert.equal(existsSync(chunkMkvOf(j)), false, `${when}: no partial chunk is left`)
  }
})

test('(h) a canvas resized after its draw is drawn and captured again', { timeout: 120_000 }, async () => {
  const { frames, err } = await renderForced(job('Plane', 0, 3), resizeAfterDraw(1))
  assert.ifError(err)
  assert.deepEqual(centres(frames), ['red', 'red', 'red'])
})

test('(i) a Canvas with no useThreeFrame() fails as three_frame_blank (no_bridge)', { timeout: 120_000 }, async () => {
  const { err } = await renderForced(job('NoBridge', 0, 2), waitMs)
  assert.ok(err, 'the chunk must fail, not render a blank frame')
  assert.equal(err.code, 'three_frame_blank')
  assert.equal(err.reason, 'no_bridge')
  assert.equal(err.frame, 0)
})

test('(j) a prop driven by frame is drawn on its own frame, not the one before', { timeout: 120_000 }, async () => {
  // A chunk from frame 4: its page mounts at frame 0, then jumps to 4.
  const { frames, err } = await renderForced(job('Moving', 4, 7))
  assert.ifError(err)
  const LEFT = SIZE / 2 - 0.32 * SIZE, RIGHT = SIZE / 2 + 0.32 * SIZE
  const side = frames.map(f => isRed(pixel(f, LEFT, SIZE / 2)) ? 'left' : isRed(pixel(f, RIGHT, SIZE / 2)) ? 'right' : 'none')
  assert.deepEqual(side, ['left', 'right', 'right'], 'frames 4, 5, 6: the square moves right on frame 5')
})

test('(k) the sample path: a 3D sample is drawn, and one that cannot draw fails as three_frame_blank', { timeout: 120_000 }, async () => {
  // sample-frame.js reads TMPDIR for its cache once, at import: a scratch one.
  const realTmp = process.env.TMPDIR
  process.env.TMPDIR = join(base, 'sample-tmp')
  mkdirSync(process.env.TMPDIR, { recursive: true })
  try {
    const { sampleOverlay } = await import('../sample-frame.js')
    const outPath = join(base, 'sample.png')
    await sampleOverlay({ componentPath: bundles.Plane.componentPath, frame: 3, width: SIZE, height: SIZE, outPath, projectDir: projDir })
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', outPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 24 })
    assert.equal(r.status, 0)
    assert.ok(isRed(pixel(r.stdout, SIZE / 2, SIZE / 2)), `the sampled 3D canvas is drawn, got rgba(${pixel(r.stdout, SIZE / 2, SIZE / 2)})`)

    // The sample launches its own Chrome, so the short wait comes from the overlay itself.
    const shortWait = join(projDir, 'overlays', 'NoBridgeShort.jsx')
    writeFileSync(shortWait, `window.__montajThreeWaitMs = 300\n${NO_BRIDGE}`)
    const err = await sampleOverlay({ componentPath: shortWait, frame: 0, width: SIZE, height: SIZE, outPath: join(base, 'blank.png'), projectDir: projDir })
      .then(() => null, e => e)
    assert.ok(err, 'the sample must fail, not return a blank 3D sample')
    assert.equal(err.sampleError, 'three_frame_blank')
    assert.equal(err.reason, 'no_bridge')
    assert.match(err.message, /NoBridgeShort\.jsx/)
  } finally {
    if (realTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = realTmp
  }
})

test('(l) render.js fails the render with a three_frame_blank line naming the overlay, frame and reason', { timeout: 180_000 }, async (t) => {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/\blibx264\b/.test(enc)) { t.skip(`${FFMPEG} lacks libx264`); return }
  const dir = join(base, 'render-l')
  mkdirSync(join(dir, 'overlays'), { recursive: true })
  const clip = join(dir, 'clip.mp4')
  const mk = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=270x480:r=30:d=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' })
  assert.equal(mk.status, 0, mk.stderr)
  const overlay = join(dir, 'overlays', 'NoBridgeShort.jsx')
  writeFileSync(overlay, `window.__montajThreeWaitMs = 300\n${NO_BRIDGE}`)
  writeFileSync(join(dir, 'project.json'), JSON.stringify({
    version: '0.2', id: 'three-blank-l', status: 'final', name: 'three blank',
    settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [
      { id: 'trk-0', items: [{ id: 'c', type: 'video', src: clip, start: 0, end: 1, inPoint: 0, outPoint: 1 }] },
      { id: 'trk-1', items: [{ id: 'ov', type: 'overlay', src: overlay, start: 0, end: 1, props: {} }] },
    ],
    audio: { tracks: [] },
  }))
  const child = spawn(process.execPath, [RENDER_JS, join(dir, 'project.json'), '--out', join(dir, 'out.mp4'), '--workers', '1'], {
    env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const code = await new Promise(res => child.on('exit', res))
  const line = JSON.parse(stderr.trim().split('\n').pop())
  assert.equal(code, 1, stderr.slice(-800))
  assert.equal(line.error, 'three_frame_blank', stderr.slice(-800))
  assert.equal(line.reason, 'no_bridge')
  assert.equal(line.frame, 0)
  assert.match(line.overlay, /NoBridgeShort\.jsx \(overlay-\d+--ov\)/)
  assert.equal(existsSync(join(dir, 'out.mp4')), false, 'nothing is exported')
})
