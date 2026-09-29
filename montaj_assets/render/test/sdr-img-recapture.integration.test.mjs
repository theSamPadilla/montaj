// render/test/sdr-img-recapture.integration.test.mjs
//
// PV42 T7, end to end: an overlay whose JSX shows a local <img> is captured
// twice on `--export both` of an HDR project. The HDR pass's capture carries the
// HDR-converted image (renderer.js's interceptor), which is wrong for the SDR
// file, so render.js re-captures that segment at sdr_bt709 for the SDR compose.
//
// The image is three flat squares of known colour. In the SDR output each
// square's interior must read as its authored colour (within +-4 per channel),
// decoded with the file's own matrix and range. Without the re-capture the
// squares come out HDR-converted and far off: `MONTAJ_RENDER_JS` points this
// file at another checkout's render.js (a throwaway worktree of the pre-T7
// base) to measure that; the numbers are in the commit message.
//
// Also: the HDR master of `--export both` equals the `--export auto` master,
// frame for frame, so the re-capture never touched the HDR pass.
//
// GATING: zscale + lut3d + libx265 in MONTAJ_FFMPEG, Python importing
// lib.normalize (MONTAJ_PYTHON), as per-layer-sdr.integration.test.mjs.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDER_JS = process.env.MONTAJ_RENDER_JS || path.join(HERE, '..', 'render.js')
const MONTAJ_ROOT = path.resolve(HERE, '..', '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

const S = 480            // output is S x S; the 1080 design canvas scales by S/1080
const FPS = 30
const N = 15
const SQ = 160           // one square in the output: 360 design px * S/1080
// Authored sRGB colours of the three squares.
const COLORS = [[200, 50, 100], [40, 160, 80], [60, 90, 220]]

function capabilitySkip() {
  const reason = capabilityReason()
  // Opt-in loud mode: a skipped PV42 proof must fail, not pass by omission.
  if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}. Point MONTAJ_FFMPEG/MONTAJ_FFPROBE at the managed build (~/.local/share/montaj/models/ffmpeg is a directory; the binaries are inside), or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
  return reason
}
function capabilityReason() {
  const filters = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/^[A-Z. ]+ zscale\b/m.test(filters) || !/^[A-Z. ]+ lut3d\b/m.test(filters) || !/\blibx265\b/.test(encoders)) {
    return `${FFMPEG} lacks zscale + lut3d + libx265 (set MONTAJ_FFMPEG)`
  }
  const py = spawnSync(PYTHON, ['-c', 'import lib.normalize'], { cwd: MONTAJ_ROOT, encoding: 'utf8' })
  if (py.status !== 0) return `${PYTHON} cannot import lib.normalize (set MONTAJ_PYTHON)`
  return false
}
const SKIP = capabilitySkip()

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Mean rgb of the 60 x 60 interior of square `i`, frame N, YUV read as BT.709 limited. */
function interior(file, i) {
  const x = i * SQ + 50
  const vf = `select=eq(n\\,${N}),crop=60:60:${x}:50,`
    + 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24'
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', timeout: 30_000 })
  assert.equal(r.status, 0, `frame read of ${file} failed: ${r.stderr}`)
  assert.equal(r.stdout.length, 60 * 60 * 3)
  const sum = [0, 0, 0]
  for (let p = 0; p < r.stdout.length; p += 3) for (let c = 0; c < 3; c++) sum[c] += r.stdout[p + c]
  return sum.map(v => v / (60 * 60))
}

function decodedMd5(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'md5', '-'],
    { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `md5 of ${file} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function render(projectPath, out, tmp, args = []) {
  mkdirSync(path.dirname(out), { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RENDER_JS, projectPath, '--out', out, ...args], {
      env: { ...process.env, TMPDIR: tmp },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const kill = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('error', (err) => { clearTimeout(kill); reject(err) })
    child.on('close', (code) => {
      clearTimeout(kill)
      if (code !== 0) reject(new Error(`render ${args.join(' ')} exited ${code}:\n${stderr.slice(-2000)}`))
      else resolve({ stdout, stderr, outputs: stdout.trim().split('\n').filter(Boolean) })
    })
  })
}

let dirToClean = null
after(() => { if (dirToClean) rmSync(dirToClean, { recursive: true, force: true }) })

test('--export both, HLG project with an <img> overlay: SDR squares as authored, HDR master untouched',
  { skip: SKIP, timeout: 400_000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'montaj-sdrimg-'))
    dirToClean = dir
    const tmp = path.join(dir, 'tmp')
    mkdirSync(tmp)

    // PNG: three 120 x 120 flat squares side by side, from exact rgb24 bytes
    // (an ffmpeg `color` source is not exact: it converts through YUV).
    const png = path.join(dir, 'squares.png')
    const raw = path.join(dir, 'squares.rgb')
    const px = Buffer.alloc(360 * 120 * 3)
    for (let y = 0; y < 120; y++) for (let x = 0; x < 360; x++) {
      Buffer.from(COLORS[Math.floor(x / 120)]).copy(px, (y * 360 + x) * 3)
    }
    writeFileSync(raw, px)
    ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '360x120', '-i', raw,
      '-frames:v', '1', '-update', '1', '-pix_fmt', 'rgb24', png])

    // A small mid-grey HLG clip, tagged HLG / BT.2020.
    const video = path.join(dir, 'hlg.mp4')
    ff(['-f', 'lavfi', '-i', `color=c=gray:size=${S}x${S}:rate=${FPS}:duration=1`,
      '-vf', 'format=yuv420p10le',
      '-c:v', 'libx265', '-x265-params',
      `keyint=${FPS / 2}:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error`,
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
      '-pix_fmt', 'yuv420p10le', '-an', video])

    const jsx = path.join(dir, 'squares.jsx')
    writeFileSync(jsx, `export default function Squares() {
  return (
    <div style={{ width: 1080, height: 1080, position: 'relative' }}>
      <img src="file://${png}" style={{ position: 'absolute', left: 0, top: 0, width: 1080, height: 360 }} />
    </div>
  )
}
`)
    const projectPath = path.join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify({
      version: '0.2', id: 'sdr-img', status: 'final', projectType: 'editing',
      settings: { resolution: [S, S], fps: FPS, colorSpace: 'hdr_hlg' },
      tracks: [
        { id: 'trk-0', items: [{ id: 'v', type: 'video', src: video, start: 0, end: 1, inPoint: 0, muted: true }] },
        { id: 'trk-1', items: [{ id: 'ov-img', type: 'overlay', src: jsx, props: {}, start: 0, end: 1 }] },
      ],
      assets: [], audio: { tracks: [] },
    }, null, 2))

    const auto = path.join(dir, 'out-auto', 'p.mp4')
    const both = path.join(dir, 'out-both', 'p.mp4')
    const bothSdr = path.join(dir, 'out-both', 'p-sdr.mp4')
    await render(projectPath, auto, tmp)
    const run = await render(projectPath, both, tmp, ['--export', 'both'])
    assert.deepEqual(run.outputs, [both, bothSdr])

    // Numbers first, so a failing run (or a run against the pre-T7 base) still reports them.
    let worst = 0
    for (let i = 0; i < COLORS.length; i++) {
      const got = interior(bothSdr, i)
      const off = Math.max(...got.map((v, c) => Math.abs(v - COLORS[i][c])))
      worst = Math.max(worst, off)
      t.diagnostic(`SDR square ${i}: want ${COLORS[i]} got ${got.map(v => v.toFixed(1))} max off ${off.toFixed(1)}`)
    }
    t.diagnostic(`worst per-channel deviation ${worst.toFixed(1)}`)

    assert.match(run.stderr, /re-capturing 1 overlay segment\(s\) with images for SDR/)
    assert.ok(worst <= 4, `SDR squares must be within 4 of authored, worst ${worst.toFixed(1)}`)
    assert.equal(decodedMd5(both), decodedMd5(auto), 'the HDR master must be the --export auto master')
  })
