// render/test/disk-preflight.integration.test.mjs
//
// §128: a render that certainly will not fit on disk is refused before it
// writes anything heavy, with the one line the app's failure card and the AI
// read: {"error":"insufficient_disk","message":"Not enough free space to
// export. Free up N.N GB and try again.","needBytes",...,"freeBytes",...,
// "path",...}. The real render.js, spawned; MONTAJ_TEST_DISK_FREE_BYTES stands
// in for a nearly full disk.
//
// GATING: needs libx264 (MONTAJ_FFMPEG picks the binary). A missing capability
// fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, realpathSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { estimateRenderDisk, checkDiskSpace } from '../disk-space.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')

function capabilityReason() {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  return /\blibx264\b/.test(enc) ? false : `${FFMPEG} lacks libx264 (set MONTAJ_FFMPEG)`
}
const reason = capabilityReason()
if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}, or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
const SKIP = reason

const base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-disk-preflight-')))
after(() => rmSync(base, { recursive: true, force: true }))

function project() {
  const dir = join(base, `proj-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const clip = join(dir, 'clip.mp4')
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x568:r=30:d=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  writeFileSync(join(dir, 'project.json'), JSON.stringify({
    version: '0.2', id: 'disk-preflight', status: 'final', name: 'disk preflight',
    settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [{ id: 'trk-0', items: [{ id: 'c', type: 'video', src: clip, start: 0, end: 2, inPoint: 0, outPoint: 2 }] }],
    captions: { style: 'clean', segments: [{ text: 'hello there', start: 0, end: 2, words: [
      { word: 'hello', start: 0, end: 1 }, { word: 'there', start: 1, end: 2 }] }] },
    audio: { tracks: [] },
  }))
  return dir
}

function render(dir, env) {
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp, { recursive: true })
  const started = Date.now()
  const r = spawnSync(process.execPath, [RENDER_JS, join(dir, 'project.json'), '--out', join(dir, 'render', 'out.mp4')], {
    encoding: 'utf8', timeout: 300_000, env: { ...process.env, TMPDIR: tmp, ...env },
  })
  return { ...r, ms: Date.now() - started, tmp }
}

const lastJsonLine = (stderr) => {
  const lines = stderr.trim().split('\n').filter((l) => l.startsWith('{'))
  return JSON.parse(lines.at(-1))
}

test('a disk that certainly cannot hold the render refuses it before any work, with the line the card reads', { skip: SKIP, timeout: 300_000 }, async () => {
  const dir = project()
  const r = render(dir, { MONTAJ_TEST_DISK_FREE_BYTES: '1000' })
  assert.equal(r.status, 1, r.stderr)
  const line = lastJsonLine(r.stderr)
  assert.equal(line.error, 'insufficient_disk')
  assert.match(line.message, /^Not enough free space to export\. Free up \d+\.\d GB and try again\.$/)
  assert.ok(line.needBytes > 1000, `needBytes ${line.needBytes}`)
  assert.equal(line.freeBytes, 1000)
  assert.equal(line.path, join(dir, 'render'), 'one disk here: the project is named')
  assert.equal(line.phase, 'preflight')
  assert.ok(line.estimate && line.estimate.lower && line.estimate.expected, 'the estimate is recorded')
  // Nothing heavy started: no frames, no capture, no normalize, no output.
  assert.doesNotMatch(r.stderr, /with Puppeteer|normalized|encoding segment/)
  assert.deepEqual(readdirSync(r.tmp).filter((n) => n.startsWith('montaj-frames-')), [])
  assert.equal(existsSync(join(dir, 'render', 'out.mp4')), false)
})

test('a disk with room lets the same render through the check', { skip: SKIP, timeout: 300_000 }, async () => {
  const dir = project()
  const r = render(dir, { MONTAJ_TEST_DISK_FREE_BYTES: String(1e15) })
  assert.doesNotMatch(r.stderr, /insufficient_disk/)
  assert.match(r.stderr, /with Puppeteer/, 'it went on to capture')
})

test('a long captioned video passes a disk that holds its project files and a per-worker TMPDIR, though not the PNG frames it used to need', () => {
  // 10 minutes of captions at 1080x1920 with 12 workers. The PNG frames in TMPDIR
  // alone used to be counted: the old lower bound was 0.5 x 18000 frames x
  // 1080x1920 x 0.03 bytes = 560 MB. They stream now (§131), so the lower bound
  // is the profiles and the bundle only.
  const OLD_TMP_LOWER = 0.5 * 18000 * 1080 * 1920 * 0.03
  const est = estimateRenderDisk({
    segments: [{ frames: 18000, sparse: true }], width: 1080, height: 1920, workerCount: 12, durationSeconds: 600,
  })
  assert.ok(est.lower.tmpBytes < 100e6, `tmp lower bound ${est.lower.tmpBytes}`)
  assert.ok(OLD_TMP_LOWER > est.lower.tmpBytes + 400e6)
  // Free space between the new lower bound and the old one: one disk, so the
  // two needs add. Passes now; the old bound (560 MB of frames) refused it.
  const free = est.lower.projectBytes + est.lower.tmpBytes + 200e6
  const disk = {
    statfs: () => ({ bavail: Math.floor(free / 4096), bsize: 4096 }),
    stat: () => ({ dev: 1 }),
  }
  const check = checkDiskSpace({ tmpDir: '/tmp', projectDir: '/proj/render', estimate: est.lower, ...disk })
  assert.equal(check.short, null, 'the render is let through')
  assert.ok(free < est.lower.projectBytes + OLD_TMP_LOWER, 'a disk the old lower bound would have refused')
})

test('render.js maps a disk that ran out mid-render to the same line, after removing its bundles', () => {
  const src = readFileSync(RENDER_JS, 'utf8')
  const at = src.indexOf('}).catch(err => {')
  assert.ok(at > 0)
  const handler = src.slice(at, src.indexOf('\n  })\n', at))
  assert.match(handler, /cleanupBundle\(dir\)/)
  assert.match(handler, /if \(isDiskFull\(err\)\)/)
  assert.match(handler, /phase: 'mid-render'/)
  assert.ok(handler.indexOf('isDiskFull') < handler.indexOf("'render_error'"), 'before the generic failure')
})
