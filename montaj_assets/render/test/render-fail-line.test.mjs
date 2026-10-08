// PL83 Task 3: every render failure is one JSON line carrying the worker count
// and chunk size once they are known; a killed child is `child_killed`.
// Unit cases first; then the integration cases, a real render.js in its own
// process group: its compose ffmpeg or a worker's Chrome SIGKILLed (the lines
// the app classifies, saved to fixtures/captured-kills), and a SIGTERM (a
// cancel), which is never child_killed.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as RJ from '../render.js'
import * as RR from '../renderer.js'
const failLine = (...a) => RJ.failLine(...a)
const currentRenderPlan = () => RR.currentRenderPlan()
import { FFMPEG } from '../ffmpeg-bin.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(HERE, '..', 'render.js')
// The engine's exact last stderr line for a real kill, which the app classifies.
const KILLS = join(HERE, 'fixtures', 'captured-kills')

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

test('failLine: workers and chunkFrames only when integers; an empty message is the code', () => {
  const none = JSON.parse(failLine('render_error', '', {}, { workers: NaN, chunkFrames: 2.5 }))
  assert.deepEqual(none, { error: 'render_error', message: 'render_error' })
  const one = JSON.parse(failLine('render_error', undefined, {}, { workers: 3, chunkFrames: undefined }))
  assert.deepEqual(one, { error: 'render_error', message: 'render_error', workers: 3 })
})

test('currentRenderPlan is null before any render plans', () => {
  assert.equal(currentRenderPlan(), null)
})

// ---- integration (needs libx264, Chrome); run when the machine is free ----
// Each spawns render.js on a 20 s clip with captions (a real Puppeteer capture,
// then a real compose encode), in its own process group, as serve does.
const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
const SKIP = /\blibx264\b/.test(enc) ? false : `${FFMPEG} lacks libx264`
const base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-fail-line-')))
after(() => rmSync(base, { recursive: true, force: true }))
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Every descendant of `rootPid`, with its full command line. */
function descendants(rootPid) {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout.split('\n')
  const rows = ps.map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], args: m[3] }))
  const out = []
  const stack = [rootPid]
  while (stack.length) {
    const p = stack.pop()
    for (const r of rows) if (r.ppid === p) { out.push(r); stack.push(r.pid) }
  }
  return out
}

let clip = null
function project(name) {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  if (!clip) {
    clip = join(base, 'clip.mp4')
    const mk = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' })
    assert.equal(mk.status, 0, mk.stderr)
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify({
    version: '0.2', id: `fail-line-${name}`, status: 'final', name: 'fail line',
    settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [{ id: 'trk-0', items: [{ id: 'c', type: 'video', src: clip, start: 0, end: 20, inPoint: 0, outPoint: 20 }] }],
    captions: { style: 'clean', segments: [{ text: 'hello there', start: 0, end: 20, words: [
      { word: 'hello', start: 0, end: 10 }, { word: 'there', start: 10, end: 20 }] }] },
    audio: { tracks: [] },
  }))
  return dir
}

/** render.js in a process group of its own (serve's kill_tree signals the group), TMPDIR = `dir`. */
function startRender(dir, extra = []) {
  const child = spawn(process.execPath, [RENDER_JS, join(dir, 'project.json'), '--out', join(dir, 'out.mp4'), ...extra], {
    env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  })
  const run = { child, stderr: '', seen: new Map() }
  child.stderr.on('data', d => { run.stderr += d })
  run.exited = new Promise(res => child.on('exit', (code, signal) => res({ code, signal })))
  // Remember what it started (pid and command line), so a failed test can stop
  // exactly those: Chrome runs in a process group of its own.
  const watch = setInterval(() => { for (const r of descendants(child.pid)) run.seen.set(r.pid, r.args) }, 250)
  run.exited.then(() => clearInterval(watch))
  return run
}

/** Stops what a render this test started left running: its group, then its Chromes by pid. */
function stopRender(run) {
  if (run.child.exitCode === null && run.child.signalCode === null) {
    try { process.kill(-run.child.pid, 'SIGKILL') } catch {}
  }
  for (const [pid, args] of run.seen) {
    const now = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).stdout.trim()
    if (now && now === args) try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

const lastLine = run => run.stderr.trim().split('\n').pop()

/**
 * Resolves once the render has logged a chunk's progress line (one per 5% of
 * its frames): the capture is under way. Frames stream into the chunk's ffmpeg
 * (§131), so no PNG lands in TMPDIR to show it.
 */
async function capturing(run) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline && run.child.exitCode === null) {
    if (/\| \d+\/\d+ \[/.test(run.stderr)) return
    await sleep(25)
  }
  assert.fail(`the capture never started\n${run.stderr.slice(-800)}`)
}

/** SIGKILLs the first descendant `match` finds; one that exited first (ESRCH) is looked for again. */
async function killDescendant(run, match, signal = 'SIGKILL') {
  const deadline = Date.now() + 200_000
  while (Date.now() < deadline && run.child.exitCode === null) {
    const target = descendants(run.child.pid).find(match)
    if (target) {
      try { process.kill(target.pid, signal); return target } catch (e) { if (e.code !== 'ESRCH') throw e }
    }
    await sleep(100)
  }
  assert.fail(`no matching child appeared\n${run.stderr.slice(-800)}`)
}

function saveLine(name, line, about) {
  const file = join(KILLS, name)
  if (existsSync(file)) return
  writeFileSync(file, JSON.stringify({ line, capturedAt: new Date().toISOString(), ...about }, null, 2) + '\n')
}

test('SIGKILL of the render\'s compose ffmpeg: last stderr line is child_killed, segment-encode, with the plan', { skip: SKIP, timeout: 240_000 }, async () => {
  const dir = project('ffmpeg-kill')
  const run = startRender(dir, ['--workers', '2'])
  try {
    // The compose encode (its canvas input is lavfi color=black), not a chunk's
    // short PNG→FFV1 encode, which can exit before the kill lands.
    await killDescendant(run, r => /(^|\/)ffmpeg\s/.test(r.args) && r.args.includes('color=black'))
    const { code } = await run.exited
    assert.equal(code, 1, run.stderr.slice(-800))
    const line = lastLine(run)
    const last = JSON.parse(line)
    assert.equal(last.error, 'child_killed')
    assert.equal(last.child, 'ffmpeg')
    assert.equal(last.signal, 'SIGKILL')
    assert.equal(last.phase, 'segment-encode')
    assert.ok(Number.isInteger(last.workers) && last.workers >= 1, line)
    assert.ok(Number.isInteger(last.chunkFrames) && last.chunkFrames >= 1, line)
    const ffmpeg = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0]
    saveLine('render-line-ffmpeg-sigkill.json', line, { ffmpeg })
  } finally {
    stopRender(run)
  }
})

test('SIGKILL of a worker\'s Chrome mid-capture: last stderr line is child_killed, chrome, overlay-capture', { skip: SKIP, timeout: 240_000 }, async () => {
  // Not 'chrome' in the project's name: the chunk's ffmpeg (§131) runs during
  // the capture, a child of render.js too, with its output path under `dir`.
  const dir = project('browser-kill')
  const run = startRender(dir, ['--workers', '1'])
  try {
    await capturing(run)
    await killDescendant(run, r => r.ppid === run.child.pid && /Chrom/i.test(r.args) && !r.args.includes('image2pipe'))
    const { code } = await run.exited
    assert.equal(code, 1, run.stderr.slice(-800))
    const line = lastLine(run)
    const last = JSON.parse(line)
    assert.equal(last.error, 'child_killed')
    assert.equal(last.child, 'chrome')
    assert.equal(last.signal, 'SIGKILL')
    assert.equal(last.phase, 'overlay-capture')
    assert.equal(last.workers, 1)
    const { default: puppeteer } = await import('puppeteer')
    const chrome = spawnSync(puppeteer.executablePath(), ['--version'], { encoding: 'utf8' }).stdout.trim()
    saveLine('render-line-chrome-sigkill.json', line, { chrome })
  } finally {
    stopRender(run)
  }
})

// MEASURED (PL83 review): serve cancels or supersedes a render with SIGTERM to
// its process group; Puppeteer's own SIGTERM handler then SIGKILLs each Chrome
// past the worker's close(), and the last line read child_killed, chrome,
// SIGKILL: an out-of-memory to the app.
test('SIGTERM to the render\'s process group mid-capture (a cancel) is never child_killed', { skip: SKIP, timeout: 240_000 }, async () => {
  const dir = project('sigterm')
  const run = startRender(dir, ['--workers', '2'])
  try {
    await capturing(run)
    process.kill(-run.child.pid, 'SIGTERM')
    const done = await Promise.race([run.exited, sleep(60_000).then(() => null)])
    assert.ok(done, `render.js was still running 60 s after SIGTERM\n${run.stderr.slice(-800)}`)
    const line = lastLine(run) ?? ''
    let last = null
    try { last = JSON.parse(line) } catch {}
    assert.notEqual(last?.error, 'child_killed', `a cancel read as a kill: ${line}`)
    if (last) assert.equal(last.error, 'render_error', line)
  } finally {
    stopRender(run)
  }
})
