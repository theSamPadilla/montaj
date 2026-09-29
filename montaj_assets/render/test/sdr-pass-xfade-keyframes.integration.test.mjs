// render/test/sdr-pass-xfade-keyframes.integration.test.mjs
//
// PV42: two cases the minimal acceptance-render set moved out of the render
// gates and into tests, both on `--export both` of an HLG project.
//
// (1) A crossfade across origins. Clip A is HDR origin (a flat colour stretched
//     to HLG, tagged, no SDR-origin marker: stands in for camera HDR), clip B is
//     an untagged SDR bt709 clip, overlapping A by 0.5 s on one track (an
//     overlap on one track is a crossfade). In the SDR file A must be the
//     Vivid-graded HLG source, B the SDR source as authored, and every frame of
//     the overlap must sit between them and move from A toward B.
// (2) Keyframed overlay. An overlay with `offsetX` keyframes draws three flat
//     authored squares (JSX, no <img>). In the SDR file each square's interior
//     is its authored colour, and its left edge is where it is in the HDR
//     master at the same instant: the keyframes carried into the SDR compose
//     and were not applied twice.
//
// Both also check that the HDR master of `--export both` equals the
// `--export auto` master, frame for frame.
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
import { buildVividLutChain } from '../encode-segment.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDER_JS = path.join(HERE, '..', 'render.js')
const MONTAJ_ROOT = path.resolve(HERE, '..', '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

const S = 512
const FPS = 30

function capabilitySkip() {
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

/** Frame n of `file` as rgb24, w x h. `matrix` true reads YUV as BT.709 limited. */
function frame(file, n, w, h, { chain = '', bt709 = true } = {}) {
  const vf = [`select=eq(n\\,${n})`, chain,
    bt709 ? 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc' : 'scale=out_range=pc',
    'format=rgb24'].filter(Boolean).join(',')
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read of ${file} failed: ${r.stderr}`)
  assert.equal(r.stdout.length, w * h * 3, `${file}: expected one ${w}x${h} frame`)
  return r.stdout
}

/** Per-channel mean of the box (x, y, bw, bh) of an rgb24 frame. */
function boxMean(buf, w, x, y, bw, bh) {
  const sum = [0, 0, 0]
  for (let j = y; j < y + bh; j++) for (let i = x; i < x + bw; i++) {
    for (let c = 0; c < 3; c++) sum[c] += buf[(j * w + i) * 3 + c]
  }
  return sum.map(v => v / (bw * bh))
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

const dirs = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  const tmp = path.join(dir, 'tmp')
  mkdirSync(tmp)
  return { dir, tmp }
}

/** A flat colour clip stretched to HLG at 203 nits, tagged only (HDR origin). */
function hlgFlat(file, hex, dur) {
  ff(['-f', 'lavfi', '-i', `color=c=${hex}:size=${S}x${S}:rate=${FPS}:duration=${dur}`,
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,'
      + 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv,'
      + 'zscale=t=arib-std-b67:p=bt2020:m=bt2020nc:npl=203,format=yuv420p10le',
    '-c:v', 'libx265', '-x265-params',
    `lossless=1:keyint=${FPS / 2}:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error`,
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-pix_fmt', 'yuv420p10le', '-an', file])
}

// ---------------------------------------------------------------------------
// (1) Crossfade across origins
// ---------------------------------------------------------------------------

test('--export both, HLG project: an HDR clip crossfades into an SDR clip inside the SDR file',
  { skip: SKIP, timeout: 400_000 }, async (t) => {
    const { dir, tmp } = scratch('montaj-xfade-')
    const a = path.join(dir, 'a_hlg.mp4')
    const b = path.join(dir, 'b_sdr.mp4')
    hlgFlat(a, '0xc85a3c', 1)
    // B: a flat SDR colour, BT.709 limited, every colour tag unknown.
    ff(['-f', 'lavfi', '-i', `color=c=0x2864c8:size=${S}x${S}:rate=${FPS}:duration=1`,
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,'
        + 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=unknown',
      '-c:v', 'libx264', '-qp', '0', '-g', String(FPS / 2), '-pix_fmt', 'yuv420p', '-an', b])

    const projectPath = path.join(dir, 'xfade.json')
    writeFileSync(projectPath, JSON.stringify({
      version: '0.2', status: 'final', name: 'xfade',
      settings: { resolution: [S, S], fps: FPS, colorSpace: 'hdr_hlg' },
      tracks: [[
        { id: 'a', type: 'video', src: a, start: 0, end: 1, inPoint: 0, muted: true },
        { id: 'b', type: 'video', src: b, start: 0.5, end: 1.5, inPoint: 0, muted: true },
      ]],
      audio: { tracks: [] },
    }, null, 2))

    const auto = path.join(dir, 'out-auto', 'x.mp4')
    const both = path.join(dir, 'out-both', 'x.mp4')
    const sdr = path.join(dir, 'out-both', 'x-sdr.mp4')
    await render(projectPath, auto, tmp)
    const run = await render(projectPath, both, tmp, ['--export', 'both'])
    assert.deepEqual(run.outputs, [both, sdr])

    // The overlap is t in [0.5, 1.0] = frames 15..30. Frame 14 is A alone, frame
    // 30 is B alone (p = 1 at the end of the overlap).
    const mean = (n) => boxMean(frame(sdr, n, S, S), S, 128, 128, 256, 256)
    const nA = 14
    const nB = 30
    const ps = [0.25, 0.5, 0.75]
    const nMid = ps.map(p => Math.round((0.5 + 0.5 * p) * FPS))
    const A = mean(nA)
    const B = mean(nB)
    const mids = nMid.map(mean)
    const fmt = (v) => `[${v.map(x => x.toFixed(1)).join(', ')}]`
    t.diagnostic(`A (frame ${nA}) ${fmt(A)}`)
    ps.forEach((p, i) => t.diagnostic(`p=${p} (frame ${nMid[i]}) ${fmt(mids[i])}`))
    t.diagnostic(`B (frame ${nB}) ${fmt(B)}`)

    // Ends: A is the Vivid-graded HLG source, B is the SDR source as authored.
    const vivid = `${buildVividLutChain('hdr_hlg')},format=yuv420p`
    const idealA = boxMean(frame(a, nA, S, S, { chain: vivid }), S, 128, 128, 256, 256)
    const idealB = boxMean(frame(b, 10, S, S), S, 128, 128, 256, 256)
    t.diagnostic(`ideal A ${fmt(idealA)}, ideal B ${fmt(idealB)}`)
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(A[c] - idealA[c]) <= 1.5, `A ch${c}: ${A[c].toFixed(2)} vs graded source ${idealA[c].toFixed(2)}`)
      assert.ok(Math.abs(B[c] - idealB[c]) <= 1.5, `B ch${c}: ${B[c].toFixed(2)} vs SDR source ${idealB[c].toFixed(2)}`)
    }

    // Inside the overlap: between the ends, and moving from A toward B.
    const seq = [A, ...mids, B]
    for (const m of mids) {
      for (let c = 0; c < 3; c++) {
        const lo = Math.min(A[c], B[c]) - 2
        const hi = Math.max(A[c], B[c]) + 2
        assert.ok(m[c] >= lo && m[c] <= hi, `crossfade ch${c} ${m[c].toFixed(2)} outside [${lo.toFixed(1)}, ${hi.toFixed(1)}]`)
      }
    }
    for (let c = 0; c < 3; c++) {
      const dir_ = Math.sign(B[c] - A[c])
      for (let i = 1; i < seq.length; i++) {
        assert.ok(dir_ * (seq[i][c] - seq[i - 1][c]) >= -1,
          `ch${c} step ${i - 1} to ${i}: ${seq[i - 1][c].toFixed(2)} to ${seq[i][c].toFixed(2)} moves away from B`)
      }
    }
    // The blend is real: the mid-point is neither end.
    const dist = (u, v) => Math.max(...u.map((x, c) => Math.abs(x - v[c])))
    assert.ok(dist(mids[1], A) > 10 && dist(mids[1], B) > 10, 'p=0.5 must be a blend, not one of the ends')

    assert.equal(decodedMd5(both), decodedMd5(auto), 'the HDR master must be the --export auto master')
  })

// ---------------------------------------------------------------------------
// (2) Keyframed overlay
// ---------------------------------------------------------------------------

const COLORS = [[200, 50, 100], [40, 160, 80], [60, 90, 220]]

/** Runs of pixels on row y that differ from the row's first pixel: [[left, right], ...]. */
function runs(buf, w, y) {
  const at = (x, c) => buf[(y * w + x) * 3 + c]
  const out = []
  let start = -1
  for (let x = 0; x < w; x++) {
    const on = [0, 1, 2].some(c => Math.abs(at(x, c) - at(0, c)) > 40)
    if (on && start < 0) start = x
    if (!on && start >= 0) { out.push([start, x - 1]); start = -1 }
  }
  if (start >= 0) out.push([start, w - 1])
  return out
}

test('--export both, HLG project: keyframed overlay squares are as authored and where the HDR master has them',
  { skip: SKIP, timeout: 400_000 }, async (t) => {
    const { dir, tmp } = scratch('montaj-kf-')
    const video = path.join(dir, 'hlg.mp4')
    // Mid-grey HLG, tagged HLG / BT.2020.
    ff(['-f', 'lavfi', '-i', `color=c=gray:size=${S}x${S}:rate=${FPS}:duration=1`,
      '-vf', 'format=yuv420p10le',
      '-c:v', 'libx265', '-x265-params',
      `keyint=${FPS / 2}:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error`,
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
      '-pix_fmt', 'yuv420p10le', '-an', video])

    const jsx = path.join(dir, 'squares.jsx')
    const sq = (i, left) => `<div style={{ position: 'absolute', left: ${left}, top: 400, width: 200, height: 200, `
      + `background: 'rgb(${COLORS[i].join(',')})' }} />`
    writeFileSync(jsx, `export default function Squares() {
  return (
    <div style={{ width: 1080, height: 1080, position: 'relative' }}>
      ${sq(0, 60)}
      ${sq(1, 400)}
      ${sq(2, 740)}
    </div>
  )
}
`)
    const projectPath = path.join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify({
      version: '0.2', id: 'sdr-kf', status: 'final', projectType: 'editing',
      settings: { resolution: [S, S], fps: FPS, colorSpace: 'hdr_hlg' },
      tracks: [
        { id: 'trk-0', items: [{ id: 'v', type: 'video', src: video, start: 0, end: 1, inPoint: 0, muted: true }] },
        { id: 'trk-1', items: [{
          id: 'ov', type: 'overlay', src: jsx, props: {}, start: 0, end: 1,
          keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 1, value: 10 }] }],
        }] },
      ],
      assets: [], audio: { tracks: [] },
    }, null, 2))

    const auto = path.join(dir, 'out-auto', 'p.mp4')
    const both = path.join(dir, 'out-both', 'p.mp4')
    const sdr = path.join(dir, 'out-both', 'p-sdr.mp4')
    await render(projectPath, auto, tmp)
    const run = await render(projectPath, both, tmp, ['--export', 'both'])
    assert.deepEqual(run.outputs, [both, sdr])

    const Y = Math.round(S * 500 / 1080)  // a row through the middle of the squares
    const failures = []
    const lefts = []
    for (const n of [6, 24]) {  // 20% and 80% of the second
      const s = frame(sdr, n, S, S)
      const h = frame(both, n, S, S, { bt709: false })
      const rs = runs(s, S, Y)
      const rh = runs(h, S, Y)
      t.diagnostic(`frame ${n}: SDR runs ${JSON.stringify(rs)}, HDR runs ${JSON.stringify(rh)}`)
      assert.equal(rs.length, 3, `frame ${n}: expected 3 squares in the SDR file, found ${JSON.stringify(rs)}`)
      assert.equal(rh.length, 3, `frame ${n}: expected 3 squares in the HDR master, found ${JSON.stringify(rh)}`)
      for (let i = 0; i < 3; i++) {
        const [l, r] = rs[i]
        const cx = Math.round((l + r) / 2)
        const got = boxMean(s, S, cx - 20, Y - 20, 40, 40)
        const off = Math.max(...got.map((v, c) => Math.abs(v - COLORS[i][c])))
        const dx = Math.abs(l - rh[i][0])
        t.diagnostic(`frame ${n} square ${i}: want ${COLORS[i]} got ${got.map(v => v.toFixed(1))} off ${off.toFixed(1)}; `
          + `left edge SDR ${l} HDR ${rh[i][0]}`)
        if (off > 4) failures.push(`frame ${n} square ${i}: colour off by ${off.toFixed(1)}`)
        if (dx > 2) failures.push(`frame ${n} square ${i}: left edge SDR ${l} vs HDR ${rh[i][0]}`)
      }
      lefts.push(rs[0][0])
    }
    const moved = lefts[1] - lefts[0]
    // The keyframes did move the squares between the two instants (else the
    // edge comparison above proves nothing about them).
    assert.ok(Math.abs(moved) >= 10, `the overlay did not move between frames 6 and 24 (${moved})`)
    assert.deepEqual(failures, [])
    assert.equal(decodedMd5(both), decodedMd5(auto), 'the HDR master must be the --export auto master')
  })
