// render/test/sdr-layer.test.mjs
/**
 * sdr-layer.js against the shared case table tests/fixtures/color_provenance_cases.json.
 * tests/test_color_provenance.py runs the same table through lib/color_provenance.py,
 * so the two resolvers cannot drift apart without one of the two suites failing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SDR_ORIGIN_MARKER, originOf, sdrLayerFor, gradeKeyFor, sameFingerprint, fpsValue,
  probeMedia, defaultDeps,
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
