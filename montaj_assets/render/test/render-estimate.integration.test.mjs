// render/test/render-estimate.integration.test.mjs
//
// §213: `render.js <project.json> --estimate` prints one JSON line,
// {"estimate":{"lower":{...},"expected":{...}},"volumes":[...]}, exits 0, and
// writes nothing: no render/ dir, no lock, no master, no output, nothing in
// TMPDIR, project.json byte for byte as it was. The real render.js, spawned.
//
// GATING: needs libx264 (MONTAJ_FFMPEG picks the binary). A missing capability
// fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'

const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')

function capabilityReason() {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  return /\blibx264\b/.test(enc) ? false : `${FFMPEG} lacks libx264 (set MONTAJ_FFMPEG)`
}
const reason = capabilityReason()
if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}, or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
const SKIP = reason

const base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-render-estimate-it-')))
after(() => rmSync(base, { recursive: true, force: true }))

/** Every path under `dir`, relative and sorted. */
function listing(dir, root = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    out.push(path.slice(root.length + 1))
    if (e.isDirectory()) listing(path, root, out)
  }
  return out.sort()
}

/**
 * A draft project with a 4:4:4 clip (an SDR project re-encodes it, so a render
 * would build its master), an overlay and captions, and no colorSpace (a
 * render would detect it and write it back).
 */
function project() {
  const dir = join(base, `proj-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p',
    // Tagged, so a master of it is reused on its date alone (an untagged
    // source's master also needs normalize's marker). The frames carry the
    // tags too (setparams): ffmpeg 8 writes a frame's own colour properties
    // over the output flags, and lavfi's are unknown.
    '-vf', 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-shortest', join(dir, 'clip.mp4')],
  { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  writeFileSync(join(dir, 'title.jsx'), 'export default () => null\n')
  const json = JSON.stringify({
    version: '0.2', id: 'estimate-it', status: 'draft', name: 'estimate it',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      { id: 'trk-0', items: [{ id: 'c', type: 'video', src: 'clip.mp4', start: 0, end: 3, inPoint: 0, outPoint: 3 }] },
      // A URL the render would prefetch; an estimate never fetches.
      { id: 'trk-1', items: [{ id: 'ov', type: 'overlay', src: 'title.jsx', start: 0, end: 2, props: { image: 'https://example.invalid/a.png' } }] },
    ],
    captions: { style: 'clean', segments: [{ text: 'hello there', start: 0, end: 2, words: [
      { word: 'hello', start: 0, end: 1 }, { word: 'there', start: 1, end: 2 }] }] },
    audio: { tracks: [] },
  }, null, 2)
  writeFileSync(join(dir, 'project.json'), json)
  const tmp = `${dir}-tmp`
  mkdirSync(tmp, { recursive: true })
  return { dir, json, tmp }
}

function estimate(p, args = []) {
  return spawnSync(process.execPath, [RENDER_JS, join(p.dir, 'project.json'), '--estimate',
    '--out', join(p.dir, 'output', 'estimate it.mp4'), '--workers', '2', ...args], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, TMPDIR: p.tmp },
  })
}

test('--estimate prints one JSON line and exits 0, having written nothing', { skip: SKIP, timeout: 180_000 }, () => {
  const p = project()
  const before = listing(p.dir)
  const r = estimate(p)
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `one line on stdout: ${r.stdout}`)
  const out = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(out).sort(), ['colorSpace', 'estimate', 'hdrVisible', 'memory', 'slicing', 'volumes'])
  // §434: a 3 s project fits the default slice budget.
  assert.equal(out.slicing.sliced, false)
  assert.equal(out.slicing.budgetMB, 2000)
  assert.deepEqual(Object.keys(out.estimate).sort(), ['expected', 'lower'])
  for (const bound of ['lower', 'expected']) {
    assert.deepEqual(Object.keys(out.estimate[bound]).sort(), ['projectBytes', 'tmpBytes'])
    assert.ok(Number.isInteger(out.estimate[bound].tmpBytes) && out.estimate[bound].tmpBytes > 0)
    assert.ok(Number.isInteger(out.estimate[bound].projectBytes) && out.estimate[bound].projectBytes > 0)
  }
  // One disk (TMPDIR is beside the project here): one volume, against the expected need.
  assert.equal(out.volumes.length, 1)
  assert.deepEqual(Object.keys(out.volumes[0]).sort(), ['freeBytes', 'needBytes', 'path'])
  assert.equal(out.volumes[0].path, join(p.dir, 'render'))
  assert.equal(out.volumes[0].needBytes, out.estimate.expected.tmpBytes + out.estimate.expected.projectBytes)
  // Written nothing: no render/ (so no lock), no output/, no master, no project.json write-back.
  assert.deepEqual(listing(p.dir), before)
  assert.equal(readFileSync(join(p.dir, 'project.json'), 'utf8'), p.json)
  assert.deepEqual(readdirSync(p.tmp), [], 'nothing in TMPDIR: no bundle, no browser profile')
  // Nothing heavy started.
  assert.doesNotMatch(r.stderr, /with Puppeteer|launching|browsers ready|normalized|composing|writing back/)
})

test('--estimate counts the master the render would build for the clip', { skip: SKIP, timeout: 180_000 }, () => {
  const p = project()
  const first = JSON.parse(estimate(p).stdout)
  // Pretend an earlier render built it: a fresh master is reused, so not counted.
  writeFileSync(join(p.dir, 'clip_normalized_sdr_bt709.mp4'), readFileSync(join(p.dir, 'clip.mp4')))
  const second = JSON.parse(estimate(p).stdout)
  const master = 0.15 * 320 * 568 * 30 * 3 / 8 + 192e3 / 8 * 3
  const diff = first.estimate.expected.projectBytes - second.estimate.expected.projectBytes
  assert.ok(Math.abs(diff - master) < 0.05 * master, `the 3 s master: ${diff} vs ${master}`)
})

test('--resolution and --fps change the estimate and never the project; --resolution without --estimate is refused', { skip: SKIP, timeout: 180_000 }, () => {
  const p = project()
  const saved = JSON.parse(estimate(p).stdout)
  const uhd = JSON.parse(estimate(p, ['--resolution', '2160x3840', '--fps', '60']).stdout)
  assert.ok(uhd.estimate.expected.projectBytes > 4 * saved.estimate.expected.projectBytes)
  assert.equal(readFileSync(join(p.dir, 'project.json'), 'utf8'), p.json)

  const bad = estimate(p, ['--resolution', 'big'])
  assert.equal(bad.status, 1)
  assert.equal(JSON.parse(bad.stderr.trim().split('\n').at(-1)).error, 'invalid_argument')

  // §284: --fps and --motion-blur are a render's own now (render-overrides.integration.test.mjs);
  // --resolution still stands in for an unsaved choice in an estimate only.
  const noEstimate = spawnSync(process.execPath, [RENDER_JS, join(p.dir, 'project.json'), '--resolution', '2160x3840'],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: p.tmp } })
  assert.equal(noEstimate.status, 1)
  const line = JSON.parse(noEstimate.stderr.trim().split('\n').at(-1))
  assert.equal(line.error, 'invalid_argument')
  assert.match(line.message, /--estimate only/)
})

test('--estimate on a project it cannot plan fails like a render, JSON on stderr', { skip: SKIP, timeout: 60_000 }, () => {
  const p = project()
  rmSync(join(p.dir, 'clip.mp4'))
  const r = estimate(p)
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.equal(JSON.parse(r.stderr.trim().split('\n').at(-1)).error, 'missing_files')
})
