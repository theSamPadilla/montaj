// render/test/per-layer-sdr.integration.test.mjs
//
// PV42: an HDR project's SDR export is composed per layer.
//
// It used to be the finished HDR master graded through the Montaj Vivid LUT as
// one picture, so an SDR clip (a screen recording, a download) that had been
// stretched into HLG for the master came out graded too: far darker than its
// source. Now the SDR file is a second compose at sdr_bt709 in which each video
// layer is brought to SDR on its own. An HDR-origin clip is graded once, in the
// segment encoder, from the transfer of the file it actually decodes; an
// SDR-origin clip is decoded from its SDR original, ungraded.
//
// Real ffmpeg and the real `python -m lib.normalize`, no overlays. Each clip is
// S x S and sits at 1:1 in an S x S box, so a box in the output is compared
// pixel for pixel with a reference built straight from the source file:
//   (a) an untagged testsrc2 clip, BT.709 underneath: SDR origin;
//   (b) that clip stretched to HLG (tagged, no marker): stands in for camera HDR.
// Every comparison decodes one exact frame (N) and reads YUV as BT.709 limited,
// which is what every file compared here holds.
//
// GATING: skipped without zscale + lut3d + libx265 (MONTAJ_FFMPEG picks the
// binary) or a Python that imports lib.normalize (MONTAJ_PYTHON).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildVividLutChain } from '../encode-segment.js'
import { probeColorTransfer } from '../derive-sdr.js'
import { buildNormalizedOutputPath } from '../render.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDER_JS = path.join(HERE, '..', 'render.js')
const MONTAJ_ROOT = path.resolve(HERE, '..', '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

// 512, not smaller: the tolerances below are for colour, and the output's own
// x264 generation (crf 18) is what fills them. Measured on testsrc2: one such
// generation costs about 2.4 mean abs at 64 x 64, 0.6 at 256 and 0.3 at 512,
// and more on a graded or x265-normalized frame (the PQ box: 1.3 at 256, 0.7
// at 512). The render time barely moves.
const S = 512
const FPS = 30
const N = 15  // the frame compared: t = 0.5 s

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Media and measurement
// ---------------------------------------------------------------------------

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/**
 * Frame N of `file`, the S x S box at x, as rgb24: `chain` (if any) runs on the
 * cropped frame, then YUV is read as BT.709 limited.
 */
function box(file, { x = 0, chain = '' } = {}) {
  const vf = [`select=eq(n\\,${N})`, `crop=${S}:${S}:${x}:0`, chain,
    'scale=in_color_matrix=bt709:in_range=tv:out_range=pc', 'format=rgb24'].filter(Boolean).join(',')
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read of ${file} failed: ${r.stderr}`)
  assert.equal(r.stdout.length, S * S * 3, `${file}: expected one ${S}x${S} frame`)
  return r.stdout
}

function meanAbs(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/** The Vivid grade as the segment encoder applies it, pin included. */
const vivid = (key) => `${buildVividLutChain(key)},format=yuv420p`

/** md5 of the decoded frames of the first video stream (the poster is v:1). */
function decodedMd5(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'md5', '-'],
    { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `md5 of ${file} failed: ${r.stderr}`)
  return r.stdout.trim()
}

// ---------------------------------------------------------------------------
// Fixture: built once, on first use, so a skipped file costs nothing
// ---------------------------------------------------------------------------

let fx = null
let fxDir = null
after(() => { if (fxDir) rmSync(fxDir, { recursive: true, force: true }) })

function fixture() {
  if (fx) return fx
  const dir = fxDir ?? mkdtempSync(path.join(tmpdir(), 'montaj-perlayer-'))
  fxDir = dir

  // (a): testsrc2 written as BT.709 limited YUV, every colour tag unknown (the
  // shape of a web download), lossless, a keyframe every half second so
  // normalize finds it conformant for SDR and passes it through untouched.
  const a = path.join(dir, 'a.mp4')
  ff(['-f', 'lavfi', '-i', `testsrc2=size=${S}x${S}:rate=${FPS}:duration=1`,
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,'
      + 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=unknown',
    '-c:v', 'libx264', '-qp', '0', '-g', String(FPS / 2), '-pix_fmt', 'yuv420p', '-an', a])
  assert.equal(probeColorTransfer(a) ?? 'unknown', 'unknown', '(a) must be untagged')

  // (b): (a) stretched to HLG at 203 nits, the way an SDR clip enters an HLG
  // master, but tagged only: no SDR-origin marker, so it is HDR origin.
  const b = path.join(dir, 'b.mp4')
  ff(['-i', a, '-vf', 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv,'
      + 'zscale=t=arib-std-b67:p=bt2020:m=bt2020nc:npl=203,format=yuv420p10le',
    '-c:v', 'libx265', '-x265-params',
    `lossless=1:keyint=${FPS / 2}:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error`,
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-pix_fmt', 'yuv420p10le', '-an', b])
  assert.equal(probeColorTransfer(b), 'arib-std-b67', '(b) must be tagged HLG')

  // (g): (b) already graded to SDR, tagged BT.709: the shape of an HLG item's
  // `normalizedSrc` built for an SDR project.
  const g = path.join(dir, 'b_graded_sdr.mp4')
  ff(['-i', b, '-vf', vivid('hdr_hlg'),
    '-c:v', 'libx264', '-qp', '0', '-g', String(FPS / 2), '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-an', g])

  fx = { dir, a, b, g }
  return fx
}

const clip = (id, src, extra = {}) =>
  ({ id, type: 'video', src, start: 0, end: 1, inPoint: 0, muted: true, ...extra })

/** Box (a) on the left, box (b) on the right, each S x S at 1:1. */
function twoBoxProject(name, colorSpace) {
  const { dir, a, b } = fixture()
  const projectPath = path.join(dir, `${name}.json`)
  writeFileSync(projectPath, JSON.stringify({
    version: '0.2', status: 'final', name,
    settings: { resolution: [2 * S, S], fps: FPS, colorSpace },
    tracks: [
      [clip('a', a, { scaleX: 0.5, scaleY: 1, offsetX: -25 })],
      [clip('b', b, { scaleX: 0.5, scaleY: 1, offsetX: 25 })],
    ],
    audio: { tracks: [] },
  }, null, 2))
  return projectPath
}

/**
 * Render `projectPath` to `out`, polling out's directory every few ms while it
 * runs and recording every name that mentions `hdrmaster`.
 */
function render(projectPath, out, args = []) {
  mkdirSync(path.dirname(out), { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RENDER_JS, projectPath, '--out', out, ...args], {
      env: { ...process.env, TMPDIR: fx.dir },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const scratch = new Set()
    const poll = setInterval(() => {
      try {
        for (const f of readdirSync(path.dirname(out))) if (f.includes('hdrmaster')) scratch.add(f)
      } catch { /* the directory is created by the test, before the spawn */ }
    }, 5)
    const kill = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('error', (err) => { clearInterval(poll); clearTimeout(kill); reject(err) })
    child.on('close', (code) => {
      clearInterval(poll)
      clearTimeout(kill)
      if (code !== 0) {
        reject(new Error(`render ${args.join(' ')} exited ${code}:\n${stderr.slice(-2000)}`))
        return
      }
      resolve({ stdout, stderr, outputs: stdout.trim().split('\n').filter(Boolean), scratch: [...scratch] })
    })
  })
}

/** Each render once, however many tests read it. */
const memo = new Map()
const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key) }

function hlgRenders() {
  return once('hlg', async () => {
    const { dir } = fixture()
    const projectPath = twoBoxProject('hlg', 'hdr_hlg')
    const auto = path.join(dir, 'out-auto', 'hlg.mp4')
    const both = path.join(dir, 'out-both', 'hlg.mp4')
    const autoRun = await render(projectPath, auto)
    const bothRun = await render(projectPath, both, ['--export', 'both'])
    return { auto, both, bothSdr: path.join(dir, 'out-both', 'hlg-sdr.mp4'), autoRun, bothRun }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('--export both, HLG project: the SDR clip comes out as authored, the HDR clip graded once',
  { skip: SKIP, timeout: 300_000 }, async (t) => {
    const { a, b } = fixture()
    const r = await hlgRenders()
    assert.deepEqual(r.bothRun.outputs, [r.both, r.bothSdr])

    const boxA = meanAbs(box(r.bothSdr, { x: 0 }), box(a))
    const boxB = meanAbs(box(r.bothSdr, { x: S }), box(b, { chain: vivid('hdr_hlg') }))
    t.diagnostic(`box (a) vs its source: mean abs ${boxA.toFixed(3)}`)
    t.diagnostic(`box (b) vs its source through Vivid (hdr_hlg): mean abs ${boxB.toFixed(3)}`)
    assert.ok(boxA <= 1.5, `the SDR clip must come out as its source, mean abs ${boxA.toFixed(3)} > 1.5`)
    assert.ok(boxB <= 1.5, `the HDR clip must be graded once, mean abs ${boxB.toFixed(3)} > 1.5`)
    // serve's phase marker, still logged before the SDR pass.
    assert.match(r.bothRun.stderr, /deriving SDR rendition → hlg-sdr\.mp4 \(per layer\)/)
  })

test('--export both, HLG project: the HDR master is the --export auto master, frame for frame',
  { skip: SKIP, timeout: 300_000 }, async () => {
    const r = await hlgRenders()
    assert.deepEqual(r.autoRun.outputs, [r.auto])
    assert.equal(decodedMd5(r.both), decodedMd5(r.auto))
  })

test('--export sdr, HLG project: one file, no HDR master ever written, same boxes',
  { skip: SKIP, timeout: 300_000 }, async (t) => {
    const { dir, a, b } = fixture()
    const out = path.join(dir, 'out-sdr', 'hlg.mp4')
    const run = await render(twoBoxProject('hlg-sdr-only', 'hdr_hlg'), out, ['--export', 'sdr'])

    assert.deepEqual(run.scratch, [], `an HDR master was written: ${run.scratch.join(', ')}`)
    assert.deepEqual(run.outputs, [out])
    // Every SDR-pass normalize logs its duration: a normalize killed at 600 s
    // falls back to the unconformed source without failing the render.
    assert.match(run.stderr, /SDR pass: normalized a\.mp4 in \d+\.\ds/)
    assert.match(run.stderr, /SDR pass: normalized b\.mp4 in \d+\.\ds/)
    assert.deepEqual(readdirSync(path.dirname(out)), ['hlg.mp4'])
    assert.equal(probeColorTransfer(out), 'bt709')

    const boxA = meanAbs(box(out, { x: 0 }), box(a))
    const boxB = meanAbs(box(out, { x: S }), box(b, { chain: vivid('hdr_hlg') }))
    t.diagnostic(`box (a) ${boxA.toFixed(3)}, box (b) ${boxB.toFixed(3)}`)
    assert.ok(boxA <= 1.5, `box (a): mean abs ${boxA.toFixed(3)} > 1.5`)
    assert.ok(boxB <= 1.5, `box (b): mean abs ${boxB.toFixed(3)} > 1.5`)
  })

test('--export sdr, PQ project: an HLG clip is graded from the PQ file it decodes, not from HLG',
  { skip: SKIP, timeout: 300_000 }, async (t) => {
    const { dir, b } = fixture()
    const out = path.join(dir, 'out-pq', 'pq.mp4')
    const run = await render(twoBoxProject('pq', 'hdr_pq'), out, ['--export', 'sdr'])

    // The SDR pass prepares (b) into the project's HDR space, exactly as the
    // HDR pass would, and grades that file.
    const pqFile = buildNormalizedOutputPath(b, 'hdr_pq', false)
    assert.ok(existsSync(pqFile), `the HLG clip was not normalized into PQ, or this test proves nothing:\n${run.stderr.slice(-1500)}`)
    assert.equal(probeColorTransfer(pqFile), 'smpte2084')

    const got = box(out, { x: S })
    const fromPq = meanAbs(got, box(pqFile, { chain: vivid('hdr_pq') }))
    const fromHlg = meanAbs(got, box(pqFile, { chain: vivid('hdr_hlg') }))
    t.diagnostic(`box (b) vs the PQ file through Vivid (hdr_pq): ${fromPq.toFixed(3)}, through Vivid (hdr_hlg): ${fromHlg.toFixed(3)}`)
    assert.ok(fromPq <= 1.5, `box (b) must be the PQ file graded from PQ, mean abs ${fromPq.toFixed(3)} > 1.5`)
    assert.ok(fromHlg > 5, `box (b) is as close to an HLG-keyed grade (${fromHlg.toFixed(3)}): the key did not come from the decoded file`)
  })

test('--export sdr: an HLG item whose normalizedSrc is an already graded SDR master is not graded again',
  { skip: SKIP, timeout: 300_000 }, async (t) => {
    const { dir, b, g } = fixture()
    const projectPath = path.join(dir, 'graded.json')
    // Eager normalize (no `normalize: 'lazy'`): the SDR pass must not stretch
    // the graded master into HLG only to grade it back down.
    writeFileSync(projectPath, JSON.stringify({
      version: '0.2', status: 'final', name: 'graded',
      settings: { resolution: [S, S], fps: FPS, colorSpace: 'hdr_hlg' },
      tracks: [[clip('g', b, { normalizedSrc: g, normalizedInPoint: 0 })]],
      audio: { tracks: [] },
    }, null, 2))
    const out = path.join(dir, 'out-graded', 'graded.mp4')
    await render(projectPath, out, ['--export', 'sdr'])

    const got = meanAbs(box(out), box(g))
    t.diagnostic(`box vs the graded master as it is: mean abs ${got.toFixed(3)}`)
    assert.ok(got <= 1.0, `the graded master must composite as it is, mean abs ${got.toFixed(3)} > 1.0`)
  })
