// render/test/renderer-frame-cleanup.integration.test.mjs
//
// §128: a chunk that fails after its frames are captured leaves no PNGs behind.
// renderChunk removed its frame dir only on success, so a failed chunk (a full
// disk included) left its frames in TMPDIR, and an AI retrying the render
// found less room each time.
//
// Real Chrome, a real bundle. The chunk fails after capture: its output path
// sits under a regular file, so making the chunk's directory throws.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { renderAllSegments, planChunks } from '../renderer.js'

const SIZE = 64
const JSX = `export default function Dot() {
  return <div style={{ position: 'absolute', inset: 0, background: '#ff0000' }} />
}
`

let base, ws, overlay
const realTmp = process.env.TMPDIR

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-frame-cleanup-')))
  ws = join(base, 'ws')
  mkdirSync(join(ws, 'proj', 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = ws
  overlay = join(ws, 'proj', 'overlays', 'dot.jsx')
  writeFileSync(overlay, JSX)
})

after(() => {
  if (realTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = realTmp
  if (base) rmSync(base, { recursive: true, force: true })
})

test('a chunk that fails after capturing its frames leaves no frame dir in TMPDIR', { timeout: 120_000 }, async () => {
  const bundle = await bundleComponent({
    componentPath: overlay, props: {}, fps: 30, durationFrames: 4, width: SIZE, height: SIZE,
    projectDir: join(ws, 'proj'),
  })
  // Frames go to a TMPDIR of this test's own, read by renderChunk at call time.
  const frames = join(base, 'tmp')
  mkdirSync(frames)
  process.env.TMPDIR = frames
  const blocker = join(base, 'not-a-dir')
  writeFileSync(blocker, 'a file where the chunk wants a directory')
  try {
    await assert.rejects(renderAllSegments([{
      id: 'dot', htmlPath: bundle.htmlPath, fps: 30, width: SIZE, height: SIZE, captureScale: 1,
      frameCount: 4, startSeconds: 0, endSeconds: 4 / 30, outputPath: join(blocker, 'seg', 'dot.mkv'),
      boundary: bundle.boundary, needsGoogleFonts: bundle.needsGoogleFonts,
    }], { workers: 1, chunkSize: 4 }))
    const left = readdirSync(frames).filter(n => n.startsWith('montaj-frames-'))
    assert.deepEqual(left, [], 'the failed chunk\'s frames are gone')
  } finally {
    process.env.TMPDIR = realTmp ?? ''
    if (realTmp === undefined) delete process.env.TMPDIR
    cleanupBundle(bundle.workDir)
  }
})

test('when one worker\'s chunk fails, the others stop and clean up before the render fails', { timeout: 180_000 }, async () => {
  const bundle = await bundleComponent({
    componentPath: overlay, props: {}, fps: 30, durationFrames: 120, width: SIZE, height: SIZE,
    projectDir: join(ws, 'proj'),
  })
  const frames = join(base, 'tmp2')
  mkdirSync(frames)
  process.env.TMPDIR = frames
  const blocker = join(base, 'not-a-dir-2')
  writeFileSync(blocker, 'x')
  const common = { htmlPath: bundle.htmlPath, fps: 30, width: SIZE, height: SIZE, captureScale: 1,
    boundary: bundle.boundary, needsGoogleFonts: bundle.needsGoogleFonts }
  try {
    await assert.rejects(renderAllSegments([
      // Fails right after its 2 frames: its chunk dir cannot be made.
      { ...common, id: 'quick', frameCount: 2, startSeconds: 0, endSeconds: 2 / 30, outputPath: join(blocker, 'q', 'quick.mkv') },
      // Still capturing when the first fails.
      { ...common, id: 'long', frameCount: 120, startSeconds: 0, endSeconds: 4, outputPath: join(base, 'segs', 'long.mkv') },
    ], { workers: 2, chunkSize: 120 }))
    const left = readdirSync(frames).filter(n => n.startsWith('montaj-frames-'))
    assert.deepEqual(left, [], 'no worker left its frames behind')
  } finally {
    if (realTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = realTmp
    cleanupBundle(bundle.workDir)
  }
})

test('planChunks is the plan renderAllSegments runs: the same chunk size and worker count', () => {
  const segs = [{ id: 'a', frameCount: 1410 }, { id: 'b', frameCount: 139 }]
  const plan = planChunks(segs, { workers: 12 })
  assert.equal(plan.chunkSize, 120, 'max(120, ceil(1410 / 12))')
  assert.equal(plan.subframes, 1)
  assert.equal(plan.jobs.length, 12 + 2, '1410 frames in 12 chunks, 139 in 2')
  assert.ok(plan.workerCount >= 1 && plan.workerCount <= 12)
  const long = planChunks([{ id: 'captions', frameCount: 18000 }], { workers: 12 })
  assert.equal(long.chunkSize, 1500, 'a 10-minute caption track: each worker holds 1500 frames')
})
