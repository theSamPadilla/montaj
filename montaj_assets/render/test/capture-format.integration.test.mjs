// §284: an opaque chunk for an SDR master is captured as JPEG and comes out as
// the PNG capture's chunk, within JPEG's loss: same frames, same range, PSNR
// above PSNR_FLOOR. A control whose background differs by one small step must
// fall below the floor, so the comparison can say no. Motion blur off and on
// (the blur averages JPEG sub-frames in their own YCbCr).
//
// Real Chrome, a real bundle, the managed ffmpeg.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FFMPEG } from '../ffmpeg-bin.js'
import { renderChunk, launchWorkerBrowser } from '../renderer.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'

const PSNR_FLOOR = 38

// Opaque: a gradient field, moving shapes and small text, so a frame has both
// flat areas and edges.
const opaque = (bg) => `export default function Card() {
  return <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, ${bg}, rgb(40, 140, 200))' }}>
    <div style={{ position: 'absolute', left: frame * 3, top: 30 + frame, width: 40, height: 40, borderRadius: 8,
      background: 'rgb(240, 200, 40)', transform: \`rotate(\${frame * 9}deg)\` }} />
    <div style={{ position: 'absolute', left: 10, top: 110, font: '14px Helvetica, Arial', color: 'rgb(255, 40, 40)' }}>frame {Math.floor(frame)}</div>
  </div>
}
`

const SIZE = 160
const FPS = 30
const FRAMES = 30

let base, projDir
const bundles = []

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-capture-format-')))
  const ws = join(base, 'ws')
  projDir = join(ws, 'proj')
  mkdirSync(join(projDir, 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = ws
})

after(() => {
  for (const b of bundles) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

async function bundleFor(name, jsx) {
  const componentPath = join(projDir, 'overlays', `${name}.jsx`)
  writeFileSync(componentPath, jsx)
  const b = await bundleComponent({ componentPath, props: {}, fps: FPS, durationFrames: FRAMES, width: SIZE, height: SIZE, opaque: true, projectDir: projDir })
  bundles.push(b)
  return b
}

/** Renders one chunk; returns its MKV and the first bytes of every screenshot. */
async function renderWith(b, id, { sdrMaster, subframes }) {
  const worker = await launchWorkerBrowser({})
  const shots = []
  const newPage = worker.browser.newPage.bind(worker.browser)
  worker.browser.newPage = async (...a) => {
    const page = await newPage(...a)
    const screenshot = page.screenshot.bind(page)
    page.screenshot = async (opts) => {
      const bytes = await screenshot(opts)
      shots.push({ type: opts.type, head: bytes.subarray(0, 4).toString('hex') })
      return bytes
    }
    return page
  }
  try {
    const dir = join(base, id)
    mkdirSync(dir, { recursive: true })
    const job = {
      id, htmlPath: b.htmlPath, fps: FPS, width: SIZE, height: SIZE, captureScale: 1,
      frameCount: FRAMES, startSeconds: 0, endSeconds: FRAMES / FPS, outputPath: join(dir, `${id}.mkv`),
      boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts, opaque: true, sdrMaster, subframes,
      frameStart: 0, frameEnd: FRAMES, chunkIndex: 0, totalChunks: 1,
    }
    return { mkv: (await renderChunk(worker, job)).webmPath, shots }
  } finally {
    await worker.close().catch(() => {})
  }
}

function frameCount(path) {
  const r = spawnSync(FFMPEG, ['-nostdin', '-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter((l) => l && !l.startsWith('#')).length
}

/** Average PSNR (dB) of two chunks, frame by frame, in RGB. */
function psnr(a, b) {
  const r = spawnSync(FFMPEG, ['-nostdin', '-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v]format=rgb24[x];[1:v]format=rgb24[y];[x][y]psnr', '-f', 'null', '-'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const m = /average:([\d.]+|inf)/.exec(r.stderr)
  assert.ok(m, `no PSNR in: ${r.stderr.slice(-400)}`)
  return m[1] === 'inf' ? Infinity : Number(m[1])
}

for (const subframes of [1, 3]) {
  test(`subframes ${subframes}: an SDR master's opaque chunk is captured as JPEG and matches the PNG capture`, { timeout: 180_000 }, async () => {
    const b = await bundleFor(`card-${subframes}`, opaque('rgb(20, 30, 50)'))
    const png = await renderWith(b, `png-${subframes}`, { sdrMaster: false, subframes })
    const jpeg = await renderWith(b, `jpeg-${subframes}`, { sdrMaster: true, subframes })

    const shots = FRAMES * subframes
    assert.equal(png.shots.length, shots)
    assert.equal(jpeg.shots.length, shots)
    assert.ok(png.shots.every((s) => s.type === 'png' && s.head === '89504e47'), 'PNG screenshots')
    assert.ok(jpeg.shots.every((s) => s.type === 'jpeg' && s.head.startsWith('ffd8ff')), 'JPEG screenshots')

    assert.equal(frameCount(png.mkv), FRAMES)
    assert.equal(frameCount(jpeg.mkv), FRAMES)
    const same = psnr(jpeg.mkv, png.mkv)
    assert.ok(same >= PSNR_FLOOR, `JPEG chunk vs PNG chunk: ${same} dB, under ${PSNR_FLOOR}`)

    // The control: one small step of background colour, captured as PNG.
    const other = await bundleFor(`control-${subframes}`, opaque('rgb(36, 30, 50)'))
    const control = await renderWith(other, `control-${subframes}`, { sdrMaster: false, subframes })
    const differs = psnr(jpeg.mkv, control.mkv)
    assert.ok(differs < PSNR_FLOOR, `the control should fall below ${PSNR_FLOOR} dB, got ${differs}`)
  })
}
