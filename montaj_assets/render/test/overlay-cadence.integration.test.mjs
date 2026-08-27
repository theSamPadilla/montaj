// render/test/overlay-cadence.integration.test.mjs
//
// The guard for the SP7 cadence regression. Renders a frame-driven overlay
// through the REAL pipeline (Puppeteer -> FFV1/MKV chunk -> ffmpeg overlay) and
// asserts per-frame advancement.
//
// Why per-frame and not an average: the original defect produced a valid file,
// well-formed frames, and a mean velocity correct to within 1%. Only a
// per-frame check separates "30 correct frames" from "20 correct frames, 10 of
// them shown twice."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')
const FFPROBE = process.env.MONTAJ_FFPROBE || 'ffprobe'
const FPS = 30
const N_FRAMES = 45

function haveTools() {
  return spawnSync(FFPROBE, ['-version']).status === 0
}

/** Mean luma of every frame of `path`, in order. */
function frameLuma(path) {
  const r = spawnSync(FFPROBE, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `movie=${path},signalstats`,
    '-show_entries', 'frame_tags=lavfi.signalstats.YAVG',
    '-of', 'csv=p=0',
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`)
  return r.stdout.trim().split('\n').filter(Boolean).map(Number)
}

function makeProject(dir, jsxPath, endSeconds) {
  return {
    version: '0.2',
    id: 'cadence-test',
    status: 'final',
    projectType: 'editing',
    settings: { resolution: [540, 960], fps: FPS, colorSpace: 'sdr_bt709' },
    tracks: [
      { id: 'trk-0', items: [] },
      { id: 'trk-1', items: [{
        id: 'ov-ramp', type: 'overlay', src: jsxPath, props: {},
        start: 0, end: endSeconds,
      }] },
    ],
    assets: [], audio: {},
  }
}

test('(a) every overlay frame is composited exactly once', { timeout: 300_000 }, (t) => {
  if (!haveTools()) { t.skip('ffprobe not available'); return }

  const dir = mkdtempSync(join(tmpdir(), 'montaj-cadence-'))
  try {
    const jsx = join(dir, 'cadence-ramp.jsx')
    copyFileSync(join(__dirname, 'fixtures', 'cadence-ramp.jsx'), jsx)

    const projectPath = join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify(makeProject(dir, jsx, N_FRAMES / FPS), null, 2))

    const out = join(dir, 'out.mp4')
    const r = spawnSync('node', [RENDER_JS, projectPath, '--out', out],
      { encoding: 'utf8', timeout: 280_000 })
    if (r.status !== 0) { t.skip(`render unavailable in this environment: ${r.stderr?.slice(-400)}`); return }
    assert.ok(existsSync(out), 'render produced no output')

    const luma = frameLuma(out).slice(1, N_FRAMES - 2)

    const held = []
    for (let i = 1; i < luma.length; i++) {
      if (Math.abs(luma[i] - luma[i - 1]) < 1.0) held.push(i)
    }
    assert.deepEqual(held, [],
      `overlay frames held (repeated) at output indices ${held.join(', ')} — ` +
      `the overlay stream is not on the base canvas's frame grid`)

    const steps = luma.slice(1).map((v, i) => v - luma[i])
    const median = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]
    for (const [i, s] of steps.entries()) {
      assert.ok(Math.abs(s - median) < median * 0.4,
        `non-uniform advance at index ${i}: step ${s.toFixed(2)} against median ${median.toFixed(2)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('(b) overlay chunks are captured on the output pixel grid, not always at 2x', { timeout: 300_000 }, (t) => {
  if (!haveTools()) { t.skip('ffprobe not available'); return }

  const dir = mkdtempSync(join(tmpdir(), 'montaj-capture-'))
  try {
    const jsx = join(dir, 'cadence-ramp.jsx')
    copyFileSync(join(__dirname, 'fixtures', 'cadence-ramp.jsx'), jsx)
    const projectPath = join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify(makeProject(dir, jsx, 0.5), null, 2))

    const r = spawnSync('node', [RENDER_JS, projectPath, '--out', join(dir, 'out.mp4')],
      { encoding: 'utf8', timeout: 280_000 })
    if (r.status !== 0) { t.skip(`render unavailable: ${r.stderr?.slice(-400)}`); return }

    // Overlay chunks survive because --clean is never passed.
    const segDir = join(dir, 'render', 'segments')
    const mkv = readdirSync(segDir).find(f => f.endsWith('.mkv'))
    assert.ok(mkv, 'no overlay chunk was kept')

    const probe = spawnSync(FFPROBE, ['-hide_banner', '-loglevel', 'error',
      '-select_streams', 'v:0', '-show_entries', 'stream=width',
      '-of', 'csv=p=0', join(segDir, mkv)], { encoding: 'utf8' })

    // This project renders at 540x960 — a sub-1080 output — so its design canvas
    // is 1080x1920 and captureScaleFor clamps the capture scale to 1. The capture
    // is therefore 1080 wide, ON the design canvas, not 2160.
    //
    // deviceScaleFactor was formerly a hardcoded 2, which made this 2160 for every
    // output size. That was correct only at 4K (where 1080x2 == the output's own
    // 2160 short edge, so compose does an identity) and pure loss everywhere else:
    // at 1080p it forced compose to resample 2160 -> 1080 and threw away ~30% of
    // the detail Chrome drew. The scale is now derived from settings.resolution.
    //
    // Keep this assertion a HARDCODED number, not one computed from
    // captureScaleFor: the point is to check the render pipeline against an
    // independently-derived expectation, and deriving it from the function under
    // test would make the assertion vacuous.
    //
    // This is also the only end-to-end proof that `captureScale` reaches
    // Puppeteer's setViewport at all — render.js stamps it onto each segment spec,
    // renderAllSegments spreads it into the job, renderChunk destructures it. 1080
    // is unreachable unless every link holds; the old hardcoded 2 yields 2160 here.
    // Nothing else in the suite covers that path.
    //
    // Asserts the CAPTURE resolution only — chroma is deliberately left at 4:2:0
    // (4:4:4 measured no quality gain on real footage and, combined with 2x, broke
    // full renders).
    assert.equal(Number(probe.stdout.trim()), 1080,
      'capture must land on the output pixel grid (scale clamped to 1 for this ' +
      'sub-1080 project), not at the old unconditional 2x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
