// PL83 Task 1: a child killed by a signal is child_killed with its signal; the
// engine's own timeout is not a kill; sync spawns share one pure helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FFMPEG } from '../ffmpeg-bin.js'
import { childKilledError, isChildKilled, syncResultError } from '../child-killed.js'
import { spawnAsync } from '../renderer.js'
import { runFfmpeg } from '../encode-segment.js'
import { deriveSdr } from '../derive-sdr.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'captured-kills', 'ffmpeg-sigkill.json')
const LONG = ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '600', '-f', 'null', '-']

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** pids of this process's ffmpeg children (ps scan, polled until one appears). */
async function findFfmpegChild() {
  for (let i = 0; i < 100; i++) {
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout
    for (const line of ps.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (m && Number(m[2]) === process.pid && /ffmpeg/.test(m[3])) return Number(m[1])
    }
    await sleep(50)
  }
  throw new Error('no ffmpeg child appeared')
}

async function killWhenRunning(promise, signal = 'SIGKILL') {
  const pid = await findFfmpegChild()
  await sleep(300)
  process.kill(pid, signal)
  return promise.then(() => assert.fail('expected a rejection'), e => e)
}

function saveCapture(err, stderrTail) {
  if (existsSync(FIXTURE)) return
  const ver = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0]
  writeFileSync(FIXTURE, JSON.stringify({
    message: err.message, stderrTail, signal: err.signal,
    capturedAt: new Date().toISOString(), ffmpeg: ver,
  }, null, 2) + '\n')
}

test('spawnAsync: a SIGKILLed ffmpeg rejects child_killed with its signal', async () => {
  const err = await killWhenRunning(spawnAsync(FFMPEG, LONG, 'ffmpeg test encode failed', 'test-phase'))
  assert.equal(err.code, 'child_killed')
  assert.equal(err.child, 'ffmpeg')
  assert.equal(err.signal, 'SIGKILL')
  assert.equal(err.phase, 'test-phase')
  assert.ok(isChildKilled(err))
  assert.match(err.message, /^ffmpeg test encode failed:/)
  saveCapture(err, err.message.split('\n').slice(1))
})

test('spawnAsync: a plain exit code stays a plain error', async () => {
  await assert.rejects(spawnAsync(FFMPEG, ['-y', '-i', '/nonexistent/x.mp4', '-f', 'null', '-'], 'boom'),
    e => e.code !== 'child_killed' && /^boom:/.test(e.message))
})

test('runFfmpeg: a SIGKILLed ffmpeg reports its signal, not a timeout', async () => {
  const p = runFfmpeg(LONG, 120_000, tmpdir())
  const pid = await findFfmpegChild()
  await sleep(300)
  process.kill(pid, 'SIGKILL')
  const r = await p
  assert.equal(r.signal, 'SIGKILL')
  assert.notEqual(r.timedOut, true)
})

test('runFfmpeg: the engine\'s own timeout is flagged timedOut, so callers do not call it a kill', async () => {
  const r = await runFfmpeg(LONG, 300, tmpdir())
  assert.equal(r.timedOut, true)
})

test('deriveSdr: a SIGKILLed ffmpeg rejects child_killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl83-kill-'))
  try {
    const master = join(dir, 'hdr.mp4')
    const mk = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '60',
      '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', master], { encoding: 'utf8' })
    if (mk.status !== 0) return // no libx265 here: nothing to derive from
    const err = await killWhenRunning(deriveSdr(master, join(dir, 'sdr.mp4')))
    assert.equal(err.code, 'child_killed')
    assert.equal(err.child, 'ffmpeg')
    assert.equal(err.signal, 'SIGKILL')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncResultError: a signal is child_killed, an exit code is null', () => {
  const k = syncResultError({ status: null, signal: 'SIGKILL' }, { child: 'ffmpeg', phase: 'concat', message: 'm' })
  assert.equal(k.code, 'child_killed')
  assert.equal(k.child, 'ffmpeg')
  assert.equal(k.signal, 'SIGKILL')
  assert.equal(k.phase, 'concat')
  assert.equal(k.message, 'm')
  assert.equal(syncResultError({ status: 1, signal: null }, { child: 'ffmpeg', phase: 'concat' }), null)
  // spawnSync's own timeout carries error + SIGTERM: not a kill from outside
  assert.equal(syncResultError({ status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') }, { child: 'ffmpeg' }), null)
})

test('childKilledError carries code, child, signal, phase', () => {
  const e = childKilledError({ child: 'ffmpeg', signal: 'SIGKILL', phase: 'p', message: 'x' })
  assert.ok(e instanceof Error)
  assert.deepEqual([e.code, e.child, e.signal, e.phase, e.message], ['child_killed', 'ffmpeg', 'SIGKILL', 'p', 'x'])
  assert.equal(isChildKilled(new Error('no')), false)
})
