// render/test/renderer-frame-cleanup.integration.test.mjs
//
// §128: a failed chunk leaves nothing behind. renderChunk removed its frame
// dir only on success, so a failed chunk (a full disk included) left its
// frames in TMPDIR, and an AI retrying the render found less room each time.
//
// §131: frames now stream into the chunk's ffmpeg and never reach TMPDIR, so
// what a failed chunk could leave is its ffmpeg running and a partial MKV.
// These cases check TMPDIR stays free of frames, no chunk ffmpeg outlives the
// render, and no chunk MKV is left. A failure mid-capture, deterministic, is
// in stream-frames.test.mjs.
//
// Real Chrome, a real bundle. A chunk fails when its output path sits under a
// regular file, so making the chunk's directory throws.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync, existsSync } from 'node:fs'
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

/** Frame dirs or frame PNGs anywhere under `dir` (a dir that vanishes mid-walk, a Chrome profile, is skipped). */
function framesUnder(dir) {
  const found = []
  const walk = d => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (/^montaj-frames-/.test(e.name) || /^frame-\d+\.png$/.test(e.name)) found.push(join(d, e.name))
      if (e.isDirectory()) walk(join(d, e.name))
    }
  }
  walk(dir)
  return found
}

/** This process's chunk encoders still running (pgrep -f on their stdin input). */
function chunkEncoders() {
  const r = spawnSync('pgrep', ['-P', String(process.pid), '-f', 'image2pipe'], { encoding: 'utf8' })
  return r.stdout.split('\n').map(Number).filter(Boolean)
}

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

test('a chunk that fails leaves no frames in TMPDIR and no encoder running', { timeout: 120_000 }, async () => {
  const bundle = await bundleComponent({
    componentPath: overlay, props: {}, fps: 30, durationFrames: 4, width: SIZE, height: SIZE,
    projectDir: join(ws, 'proj'),
  })
  // A TMPDIR of this test's own, where frames went before §131.
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
    assert.deepEqual(framesUnder(frames), [], 'no frames in TMPDIR')
    assert.deepEqual(chunkEncoders(), [], 'no chunk ffmpeg left running')
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
      // Fails at once: its chunk dir cannot be made.
      { ...common, id: 'quick', frameCount: 2, startSeconds: 0, endSeconds: 2 / 30, outputPath: join(blocker, 'q', 'quick.mkv') },
      // Loading or capturing, its ffmpeg running, when the first fails.
      { ...common, id: 'long', frameCount: 120, startSeconds: 0, endSeconds: 4, outputPath: join(base, 'segs', 'long.mkv') },
    ], { workers: 2, chunkSize: 120 }))
    assert.deepEqual(framesUnder(frames), [], 'no worker left frames in TMPDIR')
    assert.deepEqual(chunkEncoders(), [], 'the stopped worker\'s chunk ffmpeg is gone')
    const segs = join(base, 'segs')
    const mkvs = existsSync(segs) ? readdirSync(segs).filter(n => n.endsWith('.mkv')) : []
    assert.deepEqual(mkvs, [], 'the stopped worker left no partial chunk MKV')
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
