// render/test/scene3d-motion-blur.integration.test.mjs (§377)
//
// A 3D overlay under motion blur averages each frame's sub-frames in its page,
// on the GPU (three-bridge.js averageThreeFrames, three-blur.js), and is
// captured once per frame. Before, every sub-frame was a screenshot and the
// chunk's ffmpeg averaged them (tmix). This renders the same chunk both ways,
// through the real path (a worker Chrome, the real bundle, renderChunk and its
// ffmpeg, the frames read back out of the chunk's MKV), and holds them to:
//   - the same frame count;
//   - the same pixels within a small tolerance, opaque (an antialiased canvas
//     with no alpha, its drawing buffer preserved, as the app's 3D stage is)
//     and transparent (an alpha canvas whose buffer is not preserved), compared
//     premultiplied, as both averages are made;
//   - a frame with no motion exactly the unblurred frame;
//   - the page handed exactly subframeTimes, once per frame;
//   - a page that cannot average (no float render target) falling back to the
//     sub-frame captures, the same bytes as the 2D path.
// The stand-in stage is a box sliding right, then holding still from STOP.
// Tiny on purpose: 160x90, 8 frames.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FFMPEG } from '../ffmpeg-bin.js'
import * as R from '../renderer.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { subframeTimes } from '../motion-blur.js'

const [W, H] = [160, 90]
const FPS = 30
const N = 5
const FRAMES = 8
const STOP = 5 // the box holds still from this frame on
// Per channel, 0..255, premultiplied: the tmix average truncates and works on
// 8-bit premultiplied values, the page's rounds once from an exact sum.
const TOL = 3

const stage = ({ alpha, preserve, antialias }) => `export default function Stage({ frame }) {
  const x = -2.5 + 0.5 * Math.min(frame, ${STOP})
  return (
    <Canvas frameloop="never" flat style={{ position: 'absolute', inset: 0 }} camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: ${preserve}, antialias: ${antialias}, alpha: ${alpha} }}>
      <FrameBridge />
      ${alpha ? '' : `<color attach="background" args={['#203040']} />`}
      <mesh position={[x, 0, 0]} rotation={[0.4, 0.6, 0]}>
        <boxGeometry args={[0.9, 0.9, 0.9]} /><meshBasicMaterial color="#ffcc33" toneMapped={false} />
      </mesh>
    </Canvas>
  )
}
function FrameBridge() { useThreeFrame(); return null }
`
const CASES = {
  opaque: { jsx: stage({ alpha: false, preserve: true, antialias: true }), opaque: true },
  alpha: { jsx: stage({ alpha: true, preserve: false, antialias: false }), opaque: false },
}

let base
const bundles = {}

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-scene3d-blur-')))
  const ws = join(base, 'ws')
  const projDir = join(ws, 'proj')
  mkdirSync(join(projDir, 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = ws
  for (const [name, c] of Object.entries(CASES)) {
    const componentPath = join(projDir, 'overlays', `${name}.jsx`)
    writeFileSync(componentPath, c.jsx)
    bundles[name] = await bundleComponent({
      componentPath, props: {}, fps: FPS, durationFrames: FRAMES, width: W, height: H, opaque: c.opaque, projectDir: projDir,
    })
    bundles[name].componentPath = componentPath
  }
})

after(() => {
  for (const b of Object.values(bundles)) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

let jobs = 0
function job(name, { subframes, scene3d }) {
  const b = bundles[name]
  const id = `overlay-1--${name}-${++jobs}`
  return {
    id, componentPath: b.componentPath, htmlPath: b.htmlPath, fps: FPS, width: W, height: H, captureScale: 1,
    frameCount: FRAMES, startSeconds: 0, endSeconds: FRAMES / FPS,
    outputPath: join(base, 'segs', `${id}.mkv`), boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts,
    opaque: CASES[name].opaque, subframes, ...(scene3d ? { scene3d: true } : {}),
    frameStart: 0, frameEnd: FRAMES, chunkIndex: 0, totalChunks: 1,
  }
}

/** Every page `worker` opens records each __setFrameBlurred call (its frame and times) into `calls`, and runs `scripts`. */
function recording(worker, calls, ...scripts) {
  const newPage = worker.browser.newPage.bind(worker.browser)
  worker.browser.newPage = async (...a) => {
    const page = await newPage(...a)
    await page.exposeFunction('__testBlurCall', (n, times) => { calls.push({ n, times }) })
    await page.evaluateOnNewDocument(() => {
      let inner
      Object.defineProperty(window, '__setFrameBlurred', {
        configurable: true,
        get() { return inner },
        set(fn) { inner = (n, times) => { window.__testBlurCall(n, times); return fn(n, times) } },
      })
    })
    for (const fn of scripts) await page.evaluateOnNewDocument(fn)
    return page
  }
}

/** The page has no float render target: every float colour-buffer extension is refused. */
function noFloatTarget() {
  const get = WebGL2RenderingContext.prototype.getExtension
  WebGL2RenderingContext.prototype.getExtension = function (name) {
    return /^EXT_color_buffer_(half_)?float$/.test(name) ? null : get.call(this, name)
  }
}

/** The chunk's frames, decoded to RGBA. */
function framesOf(mkv) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', mkv, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, `decoding ${mkv}: ${r.stderr}`)
  const size = W * H * 4
  return Array.from({ length: r.stdout.length / size }, (_, i) => r.stdout.subarray(i * size, (i + 1) * size))
}

async function render(worker, j) {
  const { webmPath } = await R.renderChunk(worker, j)
  return framesOf(webmPath)
}

/** The largest per-channel difference between two frames, premultiplied, and how many pixels differ at all. */
function diff(a, b) {
  let max = 0
  let pixels = 0
  for (let i = 0; i < a.length; i += 4) {
    let any = false
    for (let c = 0; c < 4; c++) {
      const pa = c === 3 ? a[i + 3] : Math.round(a[i + c] * a[i + 3] / 255)
      const pb = c === 3 ? b[i + 3] : Math.round(b[i + c] * b[i + 3] / 255)
      const d = Math.abs(pa - pb)
      if (d > max) max = d
      if (a[i + c] !== b[i + c]) any = true
    }
    if (any) pixels++
  }
  return { max, pixels }
}

for (const name of Object.keys(CASES)) {
  test(`${name}: the page's average matches the sub-frame captures, frame for frame`, { timeout: 240_000 }, async () => {
    const calls = []
    const worker = await R.launchWorkerBrowser({})
    recording(worker, calls)
    let inPage, encoded, sharp
    try {
      inPage = await render(worker, job(name, { subframes: N, scene3d: true }))
      encoded = await render(worker, job(name, { subframes: N, scene3d: false }))
      sharp = await render(worker, job(name, { subframes: 1, scene3d: true }))
    } finally {
      await worker.close().catch(() => {})
    }

    assert.equal(inPage.length, FRAMES, 'one frame per output frame')
    assert.equal(encoded.length, FRAMES)
    assert.deepEqual(calls.map(c => c.n), Array.from({ length: FRAMES }, (_, f) => f), 'one page average per frame, no fallback, no retry')
    for (const { n, times } of calls) assert.deepEqual(times, subframeTimes(n, N), `frame ${n}: the page got subframeTimes`)

    const report = []
    for (let f = 0; f < FRAMES; f++) {
      const d = diff(inPage[f], encoded[f])
      report.push(`${f}:${d.max}/${d.pixels}px`)
      assert.ok(d.max <= TOL, `frame ${f}: the page's average is ${d.max} from the sub-frame captures' (tolerance ${TOL}); ${report.join(' ')}`)
    }
    console.log(`[${name}] in-page vs sub-frame captures, frame:max/pixels differing: ${report.join(' ')}`)

    for (let f = 0; f < STOP; f++) {
      const moved = diff(inPage[f], sharp[f]).pixels
      assert.ok(moved > 20, `frame ${f} moves, so its blur must differ from the sharp frame (${moved} pixels)`)
    }
    for (let f = STOP; f < FRAMES; f++) {
      assert.ok(Buffer.compare(inPage[f], sharp[f]) === 0, `frame ${f} holds still: blurred it is exactly the unblurred frame (${diff(inPage[f], sharp[f]).pixels} pixels differ)`)
    }
  })
}

test('a page that cannot average falls back to the sub-frame captures, the same bytes as the 2D path', { timeout: 240_000 }, async () => {
  const calls = []
  const worker = await R.launchWorkerBrowser({})
  recording(worker, calls, noFloatTarget)
  let fallback, encoded
  try {
    fallback = await render(worker, job('opaque', { subframes: N, scene3d: true }))
    encoded = await render(worker, job('opaque', { subframes: N, scene3d: false }))
  } finally {
    await worker.close().catch(() => {})
  }
  assert.deepEqual(calls.map(c => c.n), [0], 'asked once, at the chunk\'s first frame, and not again')
  assert.equal(fallback.length, FRAMES)
  for (let f = 0; f < FRAMES; f++) assert.ok(Buffer.compare(fallback[f], encoded[f]) === 0, `frame ${f}`)
})
