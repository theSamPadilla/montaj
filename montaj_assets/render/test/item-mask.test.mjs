import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { planItemMask, writeItemMask } from '../item-mask.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const still = { mask: { shape: 'ellipse', w: 0.5, h: 0.5, feather: 0.05 } }
const grow = { mask: { shape: 'ellipse', w: 0.2, h: 0.2 }, keyframes: [{ prop: 'maskW', points: [{ t: 0, value: 0.2 }, { t: 1, value: 1 }] }] }

test('no mask: no plan', () => { assert.equal(planItemMask({}, 100, 100, 0, 1, 30, '/x'), null) })
test('a still mask is one PNG frame, looped', () => {
  const p = planItemMask(still, 200, 100, 0, 2, 30, '/d/m3')
  assert.equal(p.kind, 'still')
  assert.equal(p.path, '/d/m3.png')
  assert.deepEqual(p.inputArgs, ['-loop', '1', '-framerate', '30', '-t', '2', '-i', '/d/m3.png'])
})
test('a keyframed mask is a per-frame ffv1 file', () => {
  const p = planItemMask(grow, 200, 100, 0, 1, 10, '/d/m3')
  assert.equal(p.kind, 'frames')
  assert.equal(p.path, '/d/m3.mkv')
  assert.deepEqual(p.inputArgs, ['-i', '/d/m3.mkv'])
  assert.equal(p.frames, 11)
})
test('write: a still mask PNG is box-sized gray, white centre, black corner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-'))
  const p = planItemMask(still, 64, 64, 0, 1, 30, join(dir, 'm'))
  return writeItemMask(p).then(() => {
    assert.ok(existsSync(p.path))
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', p.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    assert.equal(r.stdout.length, 64 * 64)
    assert.ok(r.stdout[32 * 64 + 32] > 245)
    assert.ok(r.stdout[0] < 10)
  })
})
test('write: a growing mask covers more each frame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-'))
  const p = planItemMask(grow, 64, 64, 0, 1, 10, join(dir, 'm'))
  const t0 = Date.now()
  return writeItemMask(p).then(() => {
    console.log(`growing mask write: ${Date.now() - t0} ms`)
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', p.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
    const sum = (f) => r.stdout.subarray(f * 4096, (f + 1) * 4096).reduce((a, b) => a + b, 0)
    assert.equal(r.stdout.length, 11 * 4096)
    assert.ok(sum(10) > sum(5) && sum(5) > sum(0))
  })
})
test('write: feather blurs the edge (no hard step)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-'))
  const p = planItemMask({ mask: { shape: 'wipe', x: 0.5, feather: 0.1 } }, 100, 10, 0, 1, 30, join(dir, 'm'))
  return writeItemMask(p).then(() => {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', p.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    // sigma = 0.1 x min(100, 10) = 1 px; the edge sits between pixels 49 and 50
    const row = [...r.stdout.subarray(500, 600)]
    assert.ok(row[49] > 140 && row[49] < 235)
    assert.ok(row[50] > 20 && row[50] < 115)
    assert.ok(Math.abs(row[49] + row[50] - 255) < 25)
    assert.ok(row[40] > row[49] && row[60] < row[50])
    assert.ok(row[2] > 245 && row[97] < 10)
  })
})
