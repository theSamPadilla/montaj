// PL83 Task 3: every render failure is one JSON line carrying the worker count
// and chunk size once they are known; a killed child is `child_killed`.
// Unit cases first; the integration case (SIGKILL the render's own ffmpeg) is last.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as RJ from '../render.js'
import * as RR from '../renderer.js'
const failLine = (...a) => RJ.failLine(...a)
const currentRenderPlan = () => RR.currentRenderPlan()
import { FFMPEG } from '../ffmpeg-bin.js'

const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')

test('failLine: child_killed line with the plan, in key order', () => {
  const line = failLine('child_killed', 'msg', { child: 'ffmpeg', signal: 'SIGKILL', phase: 'encoding' }, { workers: 5, chunkFrames: 240 })
  assert.equal(line, '{"error":"child_killed","message":"msg","child":"ffmpeg","signal":"SIGKILL","phase":"encoding","workers":5,"chunkFrames":240}')
  assert.ok(!line.includes('\n'))
})

test('failLine: any failure carries the plan when known, omits it when not', () => {
  const withPlan = JSON.parse(failLine('missing_files', 'gone', undefined, { workers: 2, chunkFrames: 120 }))
  assert.equal(withPlan.workers, 2)
  assert.equal(withPlan.chunkFrames, 120)
  const noPlan = JSON.parse(failLine('missing_files', 'gone', {}, null))
  assert.deepEqual(Object.keys(noPlan), ['error', 'message'])
})

test('failLine: extra never overrides error or message', () => {
  const o = JSON.parse(failLine('a', 'b', { error: 'x', message: 'y', k: 1 }, null))
  assert.equal(o.error, 'a')
  assert.equal(o.message, 'b')
  assert.equal(o.k, 1)
})

test('currentRenderPlan is null before any render plans', () => {
  assert.equal(currentRenderPlan(), null)
})

// ---- integration (needs libx264, Chrome); run when the machine is free ----
const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
const SKIP = /\blibx264\b/.test(enc) ? false : `${FFMPEG} lacks libx264`
const base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-fail-line-')))
after(() => rmSync(base, { recursive: true, force: true }))

function descendants(rootPid) {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout.split('\n')
  const rows = ps.map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], comm: m[3] }))
  const out = []
  const stack = [rootPid]
  while (stack.length) {
    const p = stack.pop()
    for (const r of rows) if (r.ppid === p) { out.push(r); stack.push(r.pid) }
  }
  return out
}

test('SIGKILL of the render\'s own ffmpeg: last stderr line is child_killed with the plan', { skip: SKIP, timeout: 240_000 }, async () => {
  const dir = join(base, 'proj')
  mkdirSync(dir, { recursive: true })
  const clip = join(dir, 'clip.mp4')
  const mk = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' })
  assert.equal(mk.status, 0, mk.stderr)
  writeFileSync(join(dir, 'project.json'), JSON.stringify({
    version: '0.2', id: 'fail-line', status: 'final', name: 'fail line',
    settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [{ id: 'trk-0', items: [{ id: 'c', type: 'video', src: clip, start: 0, end: 20, inPoint: 0, outPoint: 20 }] }],
    captions: { style: 'clean', segments: [{ text: 'hello there', start: 0, end: 20, words: [
      { word: 'hello', start: 0, end: 10 }, { word: 'there', start: 10, end: 20 }] }] },
    audio: { tracks: [] },
  }))
  const child = spawn(process.execPath, [RENDER_JS, join(dir, 'project.json'), '--out', join(dir, 'out.mp4')], {
    env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const exited = new Promise(res => child.on('exit', res))

  let killed = null
  const deadline = Date.now() + 200_000
  while (!killed && Date.now() < deadline && child.exitCode === null) {
    killed = descendants(child.pid).find(r => r.comm.split('/').pop() === 'ffmpeg') ?? null
    if (!killed) await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(killed, `render's ffmpeg child never appeared\n${stderr.slice(-800)}`)
  process.kill(killed.pid, 'SIGKILL')
  const code = await exited
  assert.equal(code, 1, stderr.slice(-800))
  const last = JSON.parse(stderr.trim().split('\n').pop())
  assert.equal(last.error, 'child_killed')
  assert.equal(last.child, 'ffmpeg')
  assert.equal(last.signal, 'SIGKILL')
  assert.ok(Number.isInteger(last.workers) && last.workers >= 1, JSON.stringify(last))
  assert.ok(Number.isInteger(last.chunkFrames) && last.chunkFrames >= 1, JSON.stringify(last))
})
