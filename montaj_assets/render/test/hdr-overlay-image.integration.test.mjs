// render/test/hdr-overlay-image.integration.test.mjs
//
// End to end through render.js and Chromium: an HLG project whose overlay draws
// the same swatches twice, once as CSS and once as a local <img>, saved with a
// `settings.imageTone` from before the image tone was removed.
//
//   1. The saved `imageTone` is ignored, not rejected: the render succeeds.
//   2. The <img> lands exactly where the CSS does, on the graphics mapping
//      (hdr-graphics.js). The page draws the image as authored and the
//      compose maps the whole capture once. The HDR <img> interceptor that
//      used to convert images on their own is gone, and with it the double
//      conversion it would have made under the capture mapping.
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
import { graphicsToHdr } from '../hdr-graphics.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDER_JS = process.env.MONTAJ_RENDER_JS || path.join(HERE, '..', 'render.js')
const MONTAJ_ROOT = path.resolve(HERE, '..', '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

// The overlay loads its image by literal file:// path, which the read boundary
// (PV54, overlay-build.js) allows only under one of its roots: the scratch
// tmpdir stands in for the workspace, and render.js inherits it.
process.env.MONTAJ_WORKSPACE_DIR = tmpdir()

const S = 480            // output is S x S; the 1080 design canvas scales by S/1080
const FPS = 30
const N = 15
const COLORS = [[255, 255, 255], [0, 180, 216], [209, 242, 248], [128, 128, 128], [230, 25, 75]]
const BAND = S / COLORS.length   // 96 output px per swatch
const ROW = S / 3                // CSS in the middle third, <img> in the bottom third
// <img> against CSS and against the mapping's prediction, Y10 codes: one step
// of the 8-bit composite.
const TOL = 4

function capabilitySkip() {
  const reason = capabilityReason()
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

function render(projectPath, out, tmp) {
  mkdirSync(path.dirname(out), { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RENDER_JS, projectPath, '--out', out], { env: { ...process.env, TMPDIR: tmp } })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    const kill = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('error', (err) => { clearTimeout(kill); reject(err) })
    child.on('close', (code) => {
      clearTimeout(kill)
      if (code !== 0) reject(new Error(`render exited ${code}:\n${stderr.slice(-2000)}`))
      else resolve()
    })
  })
}

/** Mean Y/Cb/Cr (Y10) of a 24x24 block at swatch `i`'s centre in row `row`, frame N, as encoded. */
function codes(file, row, i) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `select=eq(n\\,${N})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', 'pipe:1'], { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read of ${file} failed: ${r.stderr}`)
  const b = r.stdout
  const n = S * S
  const at = (o) => b.readUInt16LE(o * 2)
  const cx = i * BAND + BAND / 2
  const cy = row * ROW + ROW / 2
  let y = 0, cb = 0, cr = 0
  for (let yy = cy - 12; yy < cy + 12; yy++) for (let xx = cx - 12; xx < cx + 12; xx++) y += at(yy * S + xx)
  for (let yy = cy / 2 - 6; yy < cy / 2 + 6; yy++) {
    for (let xx = cx / 2 - 6; xx < cx / 2 + 6; xx++) { cb += at(n + yy * (S / 2) + xx); cr += at(n + n / 4 + yy * (S / 2) + xx) }
  }
  return { y: y / 576, cb: cb / 144, cr: cr / 144 }
}

function predicted(rgb) {
  const [r, g, b] = graphicsToHdr(rgb.map(v => v / 255), 'hdr_hlg')
  const y = 0.2627 * r + 0.6780 * g + 0.0593 * b
  return { y: 64 + 876 * y, cb: 512 + 896 * (b - y) / 1.8814, cr: 512 + 896 * (r - y) / 1.4746 }
}
const fmt = (c) => `${c.y.toFixed(1)}/${c.cb.toFixed(1)}/${c.cr.toFixed(1)}`
const off = (a, b) => Math.max(Math.abs(a.y - b.y), Math.abs(a.cb - b.cb), Math.abs(a.cr - b.cr))

let dirToClean = null
after(() => { if (dirToClean) rmSync(dirToClean, { recursive: true, force: true }) })

test('HLG project saved with an imageTone: renders, and an overlay <img> lands where the same CSS colour does',
  { skip: SKIP, timeout: 400_000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'montaj-hdrimg-'))
    dirToClean = dir
    const tmp = path.join(dir, 'tmp')
    mkdirSync(tmp)

    // PNG: the swatches side by side, from exact rgb24 bytes (an ffmpeg `color`
    // source is not exact: it converts through YUV).
    const png = path.join(dir, 'swatches.png')
    const raw = path.join(dir, 'swatches.rgb')
    const w = 1080, h = 360
    const px = Buffer.alloc(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(COLORS[Math.floor(x / (w / COLORS.length))]).copy(px, (y * w + x) * 3)
    writeFileSync(raw, px)
    ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', raw, '-frames:v', '1', '-update', '1', '-pix_fmt', 'rgb24', png])

    const video = path.join(dir, 'hlg.mp4')
    ff(['-f', 'lavfi', '-i', `color=c=gray:size=${S}x${S}:rate=${FPS}:duration=1`,
      '-vf', 'format=yuv420p10le',
      '-c:v', 'libx265', '-x265-params',
      `keyint=${FPS / 2}:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error`,
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
      '-pix_fmt', 'yuv420p10le', '-an', video])

    const hex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
    const jsx = path.join(dir, 'swatches.jsx')
    writeFileSync(jsx, `export default function Swatches() {
  const cols = ${JSON.stringify(COLORS.map(hex))}
  return (
    <div style={{ width: 1080, height: 1080, position: 'relative' }}>
      {cols.map((c, i) => <div key={i} style={{ position: 'absolute', left: i * 216, top: 360, width: 216, height: 360, background: c }} />)}
      <img src="file://${png}" style={{ position: 'absolute', left: 0, top: 720, width: 1080, height: 360 }} />
    </div>
  )
}
`)
    const projectPath = path.join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify({
      version: '0.2', id: 'hdr-img', status: 'final', projectType: 'editing',
      // `imageTone` as an older project saved it; nothing reads it now.
      settings: { resolution: [S, S], fps: FPS, colorSpace: 'hdr_hlg', imageTone: 'punchy' },
      tracks: [
        { id: 'trk-0', items: [{ id: 'v', type: 'video', src: video, start: 0, end: 1, inPoint: 0, muted: true }] },
        { id: 'trk-1', items: [{ id: 'ov', type: 'overlay', src: jsx, props: {}, start: 0, end: 1 }] },
      ],
      assets: [], audio: { tracks: [] },
    }, null, 2))

    const out = path.join(dir, 'out', 'p.mp4')
    await render(projectPath, out, tmp)

    const failures = []
    COLORS.forEach((rgb, i) => {
      const css = codes(out, 1, i)
      const img = codes(out, 2, i)
      const want = predicted(rgb)
      t.diagnostic(`${hex(rgb)}: predicted ${fmt(want)} css ${fmt(css)} img ${fmt(img)}`)
      if (off(img, css) > TOL) failures.push(`${hex(rgb)}: <img> ${fmt(img)} vs CSS ${fmt(css)}`)
      if (off(css, want) > TOL) failures.push(`${hex(rgb)}: CSS ${fmt(css)} vs predicted ${fmt(want)}`)
    })
    assert.deepEqual(failures, [])
  })
