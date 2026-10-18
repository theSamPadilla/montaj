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
//   - a frame with no motion in its shutter exactly the unblurred frame;
//   - the page handed exactly frameTimes (the centred 3D shutter, §390), once per frame;
//   - a stage's camera cuts keeping every sub-frame inside its shot;
//   - frames at opacity 0 written from the chunk's first such capture, never set or captured (§392);
//   - a chunk with a keyframe changing within one frame averaging its other frames in the page (§392);
//   - a page that cannot average (no float render target) falling back to the
//     sub-frame captures, the same bytes as the 2D path;
//   - a keyframed slide, drawn outside the canvas, captured per sub-frame, the same bytes as the 2D path;
//   - a canvas remounted between sub-frames still rendering every frame;
//   - a page that cannot average a later frame (its 3D tree gone) restarting the chunk per sub-frame.
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
import { frameTimes } from '../motion-blur.js'

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
const HOLD_STAGE = `export default function Stage({ frame }) {
  return (
    <Canvas KEY frameloop="never" flat style={{ position: 'absolute', inset: 0 }} camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: true, antialias: true, alpha: false }}>
      <FrameBridge />
      <color attach="background" args={['#203040']} />
      <mesh position={[-2.5 + 0.5 * frame, 0, 0]} rotation={[0.4, 0.6, 0]}>
        <boxGeometry args={[0.9, 0.9, 0.9]} /><meshBasicMaterial color="#ffcc33" toneMapped={false} />
      </mesh>
    </Canvas>
  )
}
function FrameBridge() { useThreeFrame(); return null }
`
// Fields of a job's keyframes, as the render hands them: a slide of 20% across the chunk.
const SLIDE = [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: FRAMES / FPS, value: 20 }] }]
// §392: hidden until between frames 2 and 3 (no frame's shutter sees the switch), then shown.
const WINDOW = [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 2.5 / FPS, value: 0 }, { t: 2.6 / FPS, value: 1 }] }]
// §392: a fade inside frame 4's shutter only (3.75 to 4.25): every other frame holds still.
const STEP = [{ prop: 'opacity', points: [{ t: 0, value: 1 }, { t: 4.05 / FPS, value: 1 }, { t: 4.15 / FPS, value: 0.4 }] }]
const CASES = {
  opaque: { jsx: stage({ alpha: false, preserve: true, antialias: true }), opaque: true },
  alpha: { jsx: stage({ alpha: true, preserve: false, antialias: false }), opaque: false },
  // The app's own transparent stage: a preserved buffer, antialiased, with alpha.
  // MEASURED 4 on ~600 antialiased edge pixels, one over the others: the captures are straight-alpha 8-bit PNGs, and a
  // partly covered edge pixel quantises each of the 5 captures before tmix averages them.
  alphaAA: { jsx: stage({ alpha: true, preserve: true, antialias: true }), opaque: false, tol: 4 },
  // Not in the parity loop: each has its own test below.
  slide: { jsx: stage({ alpha: false, preserve: true, antialias: true }), opaque: true, keyframes: SLIDE, own: true },
  remount: { jsx: HOLD_STAGE.replace('KEY', "key={frame >= 2.5 ? 'b' : 'a'}"), opaque: true, own: true },
  window: { jsx: stage({ alpha: true, preserve: true, antialias: true }), opaque: false, keyframes: WINDOW, own: true },
  step: { jsx: stage({ alpha: true, preserve: true, antialias: true }), opaque: false, keyframes: STEP, own: true },
  // The 3D tree leaves at frame 3: the page then has nothing to average (no_canvas), after it averaged frames 0 to 2.
  gone: {
    own: true, opaque: true,
    jsx: `export default function Stage({ frame }) {
  return frame >= 3 ? <div style={{ position: 'absolute', inset: 0, background: '#203040' }} /> : (
    <Canvas frameloop="never" flat style={{ position: 'absolute', inset: 0 }} camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: true, antialias: true, alpha: false }}>
      <FrameBridge />
      <color attach="background" args={['#203040']} />
      <mesh position={[-2.5 + 0.5 * frame, 0, 0]}><boxGeometry args={[0.9, 0.9, 0.9]} /><meshBasicMaterial color="#ffcc33" toneMapped={false} /></mesh>
    </Canvas>
  )
}
function FrameBridge() { useThreeFrame(); return null }
`,
  },
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
      ...(c.keyframes ? { keyframes: c.keyframes } : {}),
    })
    bundles[name].componentPath = componentPath
  }
})

after(() => {
  for (const b of Object.values(bundles)) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

let jobs = 0
function job(name, { subframes, scene3d, shutter }) {
  const b = bundles[name]
  const id = `overlay-1--${name}-${++jobs}`
  return {
    id, componentPath: b.componentPath, htmlPath: b.htmlPath, fps: FPS, width: W, height: H, captureScale: 1,
    frameCount: FRAMES, startSeconds: 0, endSeconds: FRAMES / FPS,
    outputPath: join(base, 'segs', `${id}.mkv`), boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts,
    opaque: CASES[name].opaque, subframes, ...(scene3d ? { scene3d: true } : {}), ...(shutter ? { shutter } : {}),
    ...(CASES[name].keyframes ? { keyframes: CASES[name].keyframes } : {}),
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

for (const name of Object.keys(CASES).filter(n => !CASES[n].own)) {
  test(`${name}: the page's average matches the sub-frame captures, frame for frame`, { timeout: 240_000 }, async () => {
    const calls = []
    const worker = await R.launchWorkerBrowser({})
    recording(worker, calls)
    let inPage, encoded, sharp
    try {
      inPage = await render(worker, job(name, { subframes: N, scene3d: true }))
      encoded = await render(worker, job(name, { subframes: N, scene3d: false, shutter: 'centred' }))
      sharp = await render(worker, job(name, { subframes: 1, scene3d: true }))
    } finally {
      await worker.close().catch(() => {})
    }

    assert.equal(inPage.length, FRAMES, 'one frame per output frame')
    assert.equal(encoded.length, FRAMES)
    assert.deepEqual(calls.map(c => c.n), Array.from({ length: FRAMES }, (_, f) => f), 'one page average per frame, no fallback, no retry')
    for (const { n, times } of calls) assert.deepEqual(times, frameTimes({ subframes: N, scene3d: true }, n), `frame ${n}: the page got the centred shutter`)

    const report = []
    for (let f = 0; f < FRAMES; f++) {
      const d = diff(inPage[f], encoded[f])
      report.push(`${f}:${d.max}/${d.pixels}px`)
      assert.ok(d.max <= (CASES[name].tol ?? TOL), `frame ${f}: the page's average is ${d.max} from the sub-frame captures' (tolerance ${CASES[name].tol ?? TOL}); ${report.join(' ')}`)
    }
    console.log(`[${name}] in-page vs sub-frame captures, frame:max/pixels differing: ${report.join(' ')}`)

    for (let f = 0; f < STOP; f++) {
      const moved = diff(inPage[f], sharp[f]).pixels
      assert.ok(moved > 20, `frame ${f} moves, so its blur must differ from the sharp frame (${moved} pixels)`)
    }
    // The centred shutter reaches a quarter frame back, so frame STOP still sees the last of the slide.
    for (let f = STOP + 1; f < FRAMES; f++) {
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
    encoded = await render(worker, job('opaque', { subframes: N, scene3d: false, shutter: 'centred' }))
  } finally {
    await worker.close().catch(() => {})
  }
  assert.deepEqual(calls.map(c => c.n), [0], 'asked once, at the chunk\'s first frame, and not again')
  assert.equal(fallback.length, FRAMES)
  for (let f = 0; f < FRAMES; f++) assert.ok(Buffer.compare(fallback[f], encoded[f]) === 0, `frame ${f}`)
})

test('a keyframed slide is drawn outside the canvas, so its chunk is captured per sub-frame, the same bytes as the 2D path', { timeout: 240_000 }, async () => {
  const calls = []
  const worker = await R.launchWorkerBrowser({})
  recording(worker, calls)
  let kept, encoded
  try {
    kept = await render(worker, job('slide', { subframes: N, scene3d: true }))
    encoded = await render(worker, job('slide', { subframes: N, scene3d: false, shutter: 'centred' }))
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(calls.length, 0, 'the page averaged nothing')
  assert.equal(kept.length, FRAMES)
  for (let f = 0; f < FRAMES; f++) assert.ok(Buffer.compare(kept[f], encoded[f]) === 0, `frame ${f}`)
})

test('a canvas remounted between sub-frames still renders every frame', { timeout: 240_000 }, async () => {
  const calls = []
  const worker = await R.launchWorkerBrowser({})
  recording(worker, calls)
  let frames
  try {
    frames = await render(worker, job('remount', { subframes: N, scene3d: true }))
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(frames.length, FRAMES, `${FRAMES}/${FRAMES} frames`)
  assert.deepEqual(calls.map(c => c.n), Array.from({ length: FRAMES }, (_, f) => f), 'no frame needed a retry')
})

test('a page that cannot average a later frame restarts the chunk per sub-frame', { timeout: 240_000 }, async () => {
  const calls = []
  const worker = await R.launchWorkerBrowser({})
  recording(worker, calls)
  const progress = []
  let frames
  try {
    const { webmPath } = await R.renderChunk(worker, job('gone', { subframes: N, scene3d: true }), { onFrame: () => progress.push(1) })
    frames = framesOf(webmPath)
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(frames.length, FRAMES, `${FRAMES}/${FRAMES} frames`)
  assert.deepEqual(calls.map(c => c.n), [0, 1, 2, 3], 'averaged until the frame it could not, then every sub-frame')
  assert.equal(progress.length, FRAMES, 'progress is not counted twice')
})

test('a stage that reports a camera cut keeps every sub-frame inside its shot (§390)', { timeout: 240_000 }, async () => {
  const calls = []
  const worker = await R.launchWorkerBrowser({})
  // The stand-in stage cuts at frame 3.5, as a scene's stage reports it (__montajCameraCuts, segment frames).
  recording(worker, calls, () => { window.__montajCameraCuts = () => [3.5] })
  let frames
  try {
    frames = await render(worker, job('opaque', { subframes: N, scene3d: true }))
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(frames.length, FRAMES)
  assert.deepEqual(calls.map(c => c.n), Array.from({ length: FRAMES }, (_, f) => f))
  const at = Object.fromEntries(calls.map(c => [c.n, c.times]))
  assert.ok(at[3].every(t => t > 2.75 && t < 3.5), `frame 3 stays before the cut: ${at[3]}`)
  assert.ok(at[4].every(t => t >= 3.5 && t < 4.25), `frame 4 stays after it: ${at[4]}`)
  assert.deepEqual(at[2], frameTimes({ subframes: N, scene3d: true }, 2), 'a frame away from the cut keeps its whole shutter')
})

/** Every page `worker` opens records the frame of each __setFrame call into `sets` (sub-frames included). */
function countingSets(worker, sets) {
  const newPage = worker.browser.newPage.bind(worker.browser)
  worker.browser.newPage = async (...a) => {
    const page = await newPage(...a)
    await page.exposeFunction('__testSet', (n) => { sets.push(n) })
    await page.evaluateOnNewDocument(() => {
      let inner
      Object.defineProperty(window, '__setFrame', {
        configurable: true,
        get() { return inner },
        set(fn) { inner = (n) => { window.__testSet(n); return fn(n) } },
      })
    })
    return page
  }
}

test('§392: a 3D frame at opacity 0 is written from the chunk\'s first such capture, never set or captured', { timeout: 240_000 }, async () => {
  const sets = []
  const worker = await R.launchWorkerBrowser({})
  countingSets(worker, sets)
  let skipped, captured
  try {
    skipped = await render(worker, job('window', { subframes: 1, scene3d: true }))
    const first = sets.splice(0)
    assert.ok(!first.includes(1) && !first.includes(2), `frames 1 and 2 were never set: ${first}`)
    assert.ok(first.includes(0) && first.includes(3), `frame 0 (the first hidden one) and the shown frames were: ${first}`)
    captured = await render(worker, job('window', { subframes: 1, scene3d: false }))
    assert.ok(sets.includes(1) && sets.includes(2), 'a 2D overlay still captures every frame')
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(skipped.length, FRAMES)
  for (let f = 0; f < FRAMES; f++) assert.ok(Buffer.compare(skipped[f], captured[f]) === 0, `frame ${f}: the same bytes as a capture`)
  assert.ok(skipped[1].every((b) => b === 0), 'a hidden frame is fully transparent')
})

test('§392: under motion blur, hidden frames are skipped in a chunk averaged in the page too', { timeout: 240_000 }, async () => {
  const calls = []
  const worker = await R.launchWorkerBrowser({})
  recording(worker, calls)
  let frames
  try {
    frames = await render(worker, job('window', { subframes: N, scene3d: true }))
  } finally {
    await worker.close().catch(() => {})
  }
  assert.equal(frames.length, FRAMES)
  assert.deepEqual(calls.map(c => c.n), [0, 3, 4, 5, 6, 7], 'frame 0 averaged as usual, 1 and 2 written from it')
  assert.ok(frames[2].every((b) => b === 0))
})

test('§392: a chunk with a keyframe changing within one frame averages its other frames in the page', { timeout: 240_000 }, async () => {
  const calls = []
  const worker = await R.launchWorkerBrowser({})
  recording(worker, calls)
  let mixed, encoded
  try {
    mixed = await render(worker, job('step', { subframes: N, scene3d: true }))
    encoded = await render(worker, job('step', { subframes: N, scene3d: false, shutter: 'centred' }))
  } finally {
    await worker.close().catch(() => {})
  }
  assert.deepEqual(calls.map(c => c.n), [0, 1, 2, 3, 5, 6, 7], 'every frame but 4 averaged in the page')
  assert.equal(mixed.length, FRAMES)
  const report = []
  for (let f = 0; f < FRAMES; f++) {
    const d = diff(mixed[f], encoded[f])
    report.push(`${f}:${d.max}/${d.pixels}px`)
    assert.ok(d.max <= 4, `frame ${f}: ${d.max} from the sub-frame captures; ${report.join(' ')}`)
  }
  assert.ok(Buffer.compare(mixed[4], encoded[4]) === 0, 'frame 4, captured per sub-frame, is the 2D path\'s bytes')
  console.log(`[step] per-frame in-page vs sub-frame captures, frame:max/pixels differing: ${report.join(' ')}`)
})
