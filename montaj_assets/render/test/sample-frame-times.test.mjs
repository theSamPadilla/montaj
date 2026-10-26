// Several --at in one node process: one frame file per time, paths printed in order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'

const SCRIPT = new URL('../sample-frame.js', import.meta.url).pathname
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'times-'))
  const src = join(dir, 'red.mp4')
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=3:r=10', '-pix_fmt', 'yuv420p', src])
  assert.equal(r.status, 0, r.stderr?.toString())
  const pj = join(dir, 'project.json')
  writeFileSync(pj, JSON.stringify({
    settings: { resolution: [1080, 1920], fps: 10 },
    tracks: [{ type: 'video', items: [
      { id: 'c1', type: 'video', src, start: 0, end: 3, inPoint: 0, outPoint: 3, sourceWidth: 64, sourceHeight: 48 },
    ] }],
  }))
  return { dir, pj }
}

test('several --at with --frames-dir write f_NNNN.png in order and print each path', { skip: !hasFfmpeg }, () => {
  const { dir, pj } = fixture()
  const fd = join(dir, 'frames')
  const p = spawnSync('node', [SCRIPT, '--mode', 'frame', '--raw', '--project', pj,
    '--at', '2', '--at', '0.5', '--at', '1', '--frames-dir', fd], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  const lines = p.stdout.trim().split('\n')
  assert.deepEqual(lines, [0, 1, 2].map(i => join(fd, `f_000${i}.png`)))
  for (const l of lines) assert.ok(existsSync(l))
})

test('several --at without --frames-dir is refused', { skip: !hasFfmpeg }, () => {
  const { dir, pj } = fixture()
  const p = spawnSync('node', [SCRIPT, '--mode', 'frame', '--raw', '--project', pj,
    '--at', '1', '--at', '2', '--out', join(dir, 'o.png')], { encoding: 'utf8' })
  assert.equal(p.status, 1)
  assert.match(p.stderr, /frames-dir/)
})

test('a failing time exits 1 naming the time', { skip: !hasFfmpeg }, () => {
  const { dir, pj } = fixture()
  const p = spawnSync('node', [SCRIPT, '--mode', 'frame', '--project', join(dir, 'nope.json'),
    '--at', '1', '--at', '7', '--frames-dir', join(dir, 'f')], { encoding: 'utf8' })
  assert.equal(p.status, 1)
  assert.match(p.stderr, /sample_failed/)
  assert.match(p.stderr, /1s/)
})

test('one --at still needs --out and prints that path', { skip: !hasFfmpeg }, () => {
  const { dir, pj } = fixture()
  const out = join(dir, 'one.png')
  const p = spawnSync('node', [SCRIPT, '--mode', 'frame', '--raw', '--project', pj, '--at', '1', '--out', out], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  assert.equal(p.stdout.trim(), out)
})
