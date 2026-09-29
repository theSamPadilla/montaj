// render/test/sdr-layer.test.mjs
/**
 * sdr-layer.js against the shared case table tests/fixtures/color_provenance_cases.json.
 * tests/test_color_provenance.py runs the same table through lib/color_provenance.py,
 * so the two resolvers cannot drift apart without one of the two suites failing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SDR_ORIGIN_MARKER, originOf, sdrLayerFor, gradeKeyFor, sameFingerprint, fpsValue,
  probeMedia, defaultDeps, ProbeError, PROBE_TIMEOUT_MS,
} from '../sdr-layer.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'color_provenance_cases.json')
const TABLE = JSON.parse(readFileSync(FIXTURE, 'utf8'))

const FAILED = { transfer: 'unknown', comment: '', width: null, height: null, fps: null, duration: null }

function depsFor(c) {
  return {
    probe: (p) => c.probes[p] ?? FAILED,
    exists: (p) => c.exists.includes(p),
  }
}

test('SDR_ORIGIN_MARKER equals the shared table (and so lib/normalize.py)', () => {
  assert.equal(SDR_ORIGIN_MARKER, TABLE.marker)
})

test('the table is not empty', () => {
  assert.ok(TABLE.cases.length >= 20)
})

for (const c of TABLE.cases) {
  test(`case: ${c.name}`, () => {
    const deps = depsFor(c)
    const raw = structuredClone(c.item)

    assert.deepEqual(originOf(c.item.src, deps), c.expect.origin, 'originOf')

    const layer = sdrLayerFor(raw, deps)
    assert.deepEqual(raw, c.item, 'sdrLayerFor must not mutate its input')
    assert.equal(layer.grade, c.expect.grade, 'grade')
    assert.equal(layer.cutoutKey, c.expect.cutoutKey, 'cutoutKey')
    assert.deepEqual(layer.item, c.expect.item ?? c.item, 'layer.item')
    assert.equal(gradeKeyFor(layer, c.decodedTransfer), c.expect.gradeKey, 'gradeKeyFor')
  })
}

test('fpsValue parses r_frame_rate strings and rejects 0/0, missing and junk', () => {
  assert.equal(fpsValue('30/1'), 30)
  assert.equal(fpsValue('30000/1001'), 30000 / 1001)
  for (const bad of ['0/0', '30/0', '0/1', '', null, undefined, 'abc', '30']) {
    assert.equal(fpsValue(bad), 0, String(bad))
  }
})

test('sameFingerprint needs a size, a rate and both durations', () => {
  const a = { width: 10, height: 10, fps: '30/1', duration: 1 }
  assert.equal(sameFingerprint(a, { ...a }), true)
  assert.equal(sameFingerprint({ ...a, width: null }, { ...a, width: null }), false)
  assert.equal(sameFingerprint({ ...a, height: null }, { ...a, height: null }), false)
  assert.equal(sameFingerprint(a, { ...a, duration: null }), false)
  assert.equal(sameFingerprint({ ...a, duration: null }, a), false)
})

test('gradeKeyFor: an ungraded layer has no key whatever it decodes', () => {
  assert.equal(gradeKeyFor({ grade: false, cutoutKey: null }, 'arib-std-b67'), null)
})

test('originOf defaults to the real probe and existsSync', () => {
  assert.equal(typeof defaultDeps.probe, 'function')
  assert.equal(typeof defaultDeps.exists, 'function')
  assert.deepEqual(originOf('/nonexistent/montaj/clip.mp4'), { colorSpace: 'sdr_bt709', original: null })
})

// ── the real probe ───────────────────────────────────────────────────────────

const HAS_FFMPEG = spawnSync(FFMPEG, ['-version']).status === 0

test('probeMedia: failure shape on a missing file and on a bad argument', () => {
  assert.deepEqual(probeMedia('/nonexistent/montaj/clip.mp4'), FAILED)
  assert.deepEqual(probeMedia(undefined), FAILED)
})

test('probeMedia: transfer, comment, display dims after rotation, r_frame_rate, duration', { skip: !HAS_FFMPEG }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdr-layer-'))
  try {
    const plain = join(dir, 'plain.mp4')
    const rotated = join(dir, 'rotated.mp4')
    let r = spawnSync(FFMPEG, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x32:rate=30000/1001:duration=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-bsf:v', 'h264_metadata=transfer_characteristics=18:colour_primaries=9:matrix_coefficients=9',
      '-metadata', `comment=${SDR_ORIGIN_MARKER}src.mov`, plain,
    ])
    assert.equal(r.status, 0, String(r.stderr))
    r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-display_rotation', '90', '-i', plain, '-c', 'copy', rotated])
    assert.equal(r.status, 0, String(r.stderr))

    const p = probeMedia(plain)
    assert.equal(p.transfer, 'arib-std-b67')
    assert.equal(p.comment, `${SDR_ORIGIN_MARKER}src.mov`)
    assert.equal(p.width, 64)
    assert.equal(p.height, 32)
    assert.equal(p.fps, '30000/1001')
    assert.ok(Math.abs(p.duration - 0.5) < 0.05, String(p.duration))

    const q = probeMedia(rotated)
    assert.equal(q.width, 32)
    assert.equal(q.height, 64)
    assert.equal(q.comment, `${SDR_ORIGIN_MARKER}src.mov`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeMedia: an untagged file has transfer unknown and an empty comment', { skip: !HAS_FFMPEG }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdr-layer-'))
  try {
    const f = join(dir, 'untagged.mp4')
    const r = spawnSync(FFMPEG, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x32:rate=30:duration=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f,
    ])
    assert.equal(r.status, 0, String(r.stderr))
    const p = probeMedia(f)
    assert.equal(p.transfer, 'unknown')
    assert.equal(p.comment, '')
    assert.equal(p.fps, '30/1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeMedia: an existing file that is not media throws a named error, it is not "SDR"', { skip: !HAS_FFMPEG }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdr-layer-'))
  try {
    const f = join(dir, 'not-a-video.mp4')
    writeFileSync(f, 'this is not a video')
    assert.throws(() => probeMedia(f), (e) => e instanceof ProbeError && e.path === f && e.reason === 'exit'
      && e.message.includes(f) && /Invalid data/.test(e.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── a failed probe, by kind (a fake spawn; shapes measured from node 24's spawnSync) ──

const ORIGINAL = '/proj/media/source.mp4'
const MARKED = '/proj/media/source_hlg.mp4'
const OK_JSON = (transfer, comment = '') => JSON.stringify({
  streams: [{ width: 64, height: 64, r_frame_rate: '30/1', color_transfer: transfer }],
  format: { duration: '1.000000', tags: comment ? { comment } : {} },
})
const ok = (transfer, comment) => ({ pid: 1, status: 0, signal: null, stdout: OK_JSON(transfer, comment), stderr: '' })
const timedOut = () => ({ pid: 1, status: null, signal: 'SIGTERM', stdout: '', stderr: '',
  error: Object.assign(new Error('spawnSync ffprobe ETIMEDOUT'), { code: 'ETIMEDOUT' }) })
const killed = () => ({ pid: 1, status: null, signal: 'SIGKILL', stdout: '', stderr: '' })
const spawnFailed = (code) => ({ pid: 0, status: null, signal: null,
  error: Object.assign(new Error(`spawnSync ffprobe ${code}`), { code }) })
const exited = (stderr) => ({ pid: 1, status: 1, signal: null, stdout: '', stderr })

/** probeMedia's options with a spawn that answers from `script` per call, recording each call. */
function fakeProbe(script, { exists = () => true } = {}) {
  const calls = []
  const sleeps = []
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts })
    const next = script.length > 1 ? script.shift() : script[0]
    return next()
  }
  return { calls, sleeps, opts: { spawn, exists, sleep: (ms) => sleeps.push(ms) } }
}

const isProbeError = (path, reason) => (e) => {
  assert.ok(e instanceof ProbeError, `a ProbeError, got ${e}`)
  assert.equal(e.path, path)
  assert.equal(e.reason, reason)
  assert.ok(e.message.includes(path), `the message names the file: ${e.message}`)
  return true
}

test('probeMedia: a timeout is retried once, and a second one throws "timeout"', () => {
  const once = fakeProbe([timedOut, () => ok('bt709')])
  assert.equal(probeMedia(ORIGINAL, once.opts).transfer, 'bt709')
  assert.equal(once.calls.length, 2)
  assert.equal(once.calls[0].opts.timeout, PROBE_TIMEOUT_MS)

  const twice = fakeProbe([timedOut])
  assert.throws(() => probeMedia(ORIGINAL, twice.opts), isProbeError(ORIGINAL, 'timeout'))
  assert.equal(twice.calls.length, 2)
})

test('probeMedia: killed by a signal (jetsam, a crash) is retried once, then throws "killed"', () => {
  const once = fakeProbe([killed, () => ok('bt709')])
  assert.equal(probeMedia(ORIGINAL, once.opts).transfer, 'bt709')
  const twice = fakeProbe([killed])
  assert.throws(() => probeMedia(ORIGINAL, twice.opts), isProbeError(ORIGINAL, 'killed'))
  assert.equal(twice.calls.length, 2)
})

for (const code of ['EAGAIN', 'ENOMEM']) {
  test(`probeMedia: a ${code} spawn failure is retried once after a backoff, then throws "spawn"`, () => {
    const once = fakeProbe([() => spawnFailed(code), () => ok('bt709')])
    assert.equal(probeMedia(ORIGINAL, once.opts).transfer, 'bt709')
    assert.equal(once.calls.length, 2)
    assert.equal(once.sleeps.length, 1)
    assert.ok(once.sleeps[0] > 0)

    const twice = fakeProbe([() => spawnFailed(code)])
    assert.throws(() => probeMedia(ORIGINAL, twice.opts), (e) => isProbeError(ORIGINAL, 'spawn')(e) && e.message.includes(code))
    assert.equal(twice.calls.length, 2)
  })
}

test('probeMedia: no ffprobe at all (ENOENT) throws at once, even for a missing file', () => {
  const f = fakeProbe([() => spawnFailed('ENOENT')])
  assert.throws(() => probeMedia(ORIGINAL, f.opts), (e) => isProbeError(ORIGINAL, 'spawn')(e) && e.message.includes('ENOENT'))
  assert.equal(f.calls.length, 1, 'never retried')
  const gone = fakeProbe([() => spawnFailed('ENOENT')], { exists: () => false })
  assert.throws(() => probeMedia(ORIGINAL, gone.opts), isProbeError(ORIGINAL, 'spawn'))
})

test('probeMedia: a non-zero exit on an existing file throws "exit" with stderr, trimmed and capped; never retried', () => {
  const f = fakeProbe([() => exited(`\n${ORIGINAL}: Invalid data found when processing input\n\n`)])
  assert.throws(() => probeMedia(ORIGINAL, f.opts),
    (e) => isProbeError(ORIGINAL, 'exit')(e) && e.message.includes('Invalid data found when processing input')
      && !e.message.endsWith('\n'))
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].args.includes('error'), 'ffprobe runs at -v error, so a failure says why')

  const long = fakeProbe([() => exited('x'.repeat(10_000))])
  assert.throws(() => probeMedia(ORIGINAL, long.opts), (e) => e.message.length < 1000)
})

test('probeMedia: unparseable output and no video stream throw "parse" and "no-stream"; never retried', () => {
  const garbage = fakeProbe([() => ({ pid: 1, status: 0, signal: null, stdout: '{"streams": [', stderr: '' })])
  assert.throws(() => probeMedia(ORIGINAL, garbage.opts), isProbeError(ORIGINAL, 'parse'))
  assert.equal(garbage.calls.length, 1)
  const empty = fakeProbe([() => ({ pid: 1, status: 0, signal: null, stdout: '{"streams": [], "format": {}}', stderr: '' })])
  assert.throws(() => probeMedia(ORIGINAL, empty.opts), isProbeError(ORIGINAL, 'no-stream'))
  assert.equal(empty.calls.length, 1)
})

test('probeMedia: a file that is not there keeps the failure shape (no throw)', () => {
  const gone = fakeProbe([() => exited(`${ORIGINAL}: No such file or directory`)], { exists: () => false })
  assert.deepEqual(probeMedia(ORIGINAL, gone.opts), FAILED)
})

// ── the defect: the provenance probe of an SDR original fails ─────────────────

/** originOf's deps over the real probeMedia and a fake spawn; `original` answers from `script`. */
function provenanceDeps(script, { originalExists = true } = {}) {
  const exists = (p) => p === MARKED || (p === ORIGINAL && originalExists)
  const probedOriginal = []
  const spawn = (bin, args, opts) => {
    const path = args[args.length - 1]
    if (path === MARKED) return ok('arib-std-b67', `${SDR_ORIGIN_MARKER}source.mp4`)
    probedOriginal.push(path)
    const next = script.length > 1 ? script.shift() : script[0]
    return next()
  }
  const probe = (p) => probeMedia(p, { spawn, exists, sleep: () => {} })
  return { deps: { probe, exists }, probedOriginal }
}

test('originOf: an SDR original whose probe keeps failing throws, never "HDR, graded"', () => {
  for (const fail of [timedOut, killed, () => spawnFailed('EAGAIN'), () => exited('boom'),
    () => ({ pid: 1, status: 0, signal: null, stdout: 'nope', stderr: '' })]) {
    const { deps } = provenanceDeps([fail])
    assert.throws(() => originOf(MARKED, deps), (e) => e instanceof ProbeError && e.path === ORIGINAL)
    assert.throws(() => sdrLayerFor({ type: 'video', src: MARKED }, deps), (e) => e instanceof ProbeError)
  }
})

test('originOf: a transient failure of the original\'s probe that clears on retry gives the right answer', () => {
  for (const fail of [timedOut, killed, () => spawnFailed('EAGAIN'), () => spawnFailed('ENOMEM')]) {
    const { deps, probedOriginal } = provenanceDeps([fail, () => ok('bt709')])
    assert.deepEqual(originOf(MARKED, deps), { colorSpace: 'sdr_bt709', original: ORIGINAL })
    assert.equal(probedOriginal.length, 2)
    const layer = sdrLayerFor({ type: 'video', src: MARKED }, provenanceDeps([fail, () => ok('bt709')]).deps)
    assert.equal(layer.grade, false)
    assert.equal(layer.item.src, ORIGINAL)
  }
})

test('originOf: a marked src whose original is gone stays HDR, graded (Q1), without probing it', () => {
  const { deps, probedOriginal } = provenanceDeps([() => exited('unreachable')], { originalExists: false })
  assert.deepEqual(originOf(MARKED, deps), { colorSpace: 'hdr_hlg', original: null })
  assert.equal(sdrLayerFor({ type: 'video', src: MARKED }, deps).grade, true)
  assert.equal(probedOriginal.length, 0)
})
