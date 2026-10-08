// PL83 Task 1: a child killed by a signal is child_killed with its signal; the
// engine's own timeout is not a kill; sync spawns share one pure helper.
// Task 2 (below): the same for a worker's Chrome and its pages.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FFMPEG } from '../ffmpeg-bin.js'
import { childKilledError, isChildKilled, syncResultError } from '../child-killed.js'
import * as CK from '../child-killed.js'
import * as R from '../renderer.js'
import { spawnAsync, renderAllSegments } from '../renderer.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'
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
  const err = await killWhenRunning(spawnAsync(FFMPEG, LONG, 'ffmpeg test encode failed', 'overlay-encode'))
  assert.equal(err.code, 'child_killed')
  assert.equal(err.child, 'ffmpeg')
  assert.equal(err.signal, 'SIGKILL')
  assert.equal(err.phase, 'overlay-encode')
  assert.ok(isChildKilled(err))
  assert.match(err.message, /^ffmpeg test encode failed:/)
  saveCapture(err, err.message.split('\n').slice(1))
})

test('spawnAsync: a plain exit code stays a plain error', async () => {
  await assert.rejects(spawnAsync(FFMPEG, ['-y', '-i', '/nonexistent/x.mp4', '-f', 'null', '-'], 'boom', 'overlay-encode'),
    e => e.code !== 'child_killed' && /^boom:/.test(e.message))
})

test('spawnAsync: the phase is required, and must be one of CHILD_KILLED_PHASES', async () => {
  await assert.rejects(async () => spawnAsync(FFMPEG, ['-version'], 'no phase'), TypeError)
  await assert.rejects(async () => spawnAsync(FFMPEG, ['-version'], 'unlisted', 'test-phase'), TypeError)
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

test('deriveSdr: a SIGKILLed ffmpeg rejects child_killed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pl83-kill-'))
  try {
    const master = join(dir, 'hdr.mp4')
    const mk = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '60',
      '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', master], { encoding: 'utf8' })
    if (mk.status !== 0) { t.skip('no libx265'); return } // nothing to derive from
    const err = await killWhenRunning(deriveSdr(master, join(dir, 'sdr.mp4')))
    assert.equal(err.code, 'child_killed')
    assert.equal(err.child, 'ffmpeg')
    assert.equal(err.signal, 'SIGKILL')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncResultError: a signal is child_killed, an exit code is null', () => {
  const k = syncResultError({ status: null, signal: 'SIGKILL' }, { child: 'ffmpeg', phase: 'segment-concat', message: 'm' })
  assert.equal(k.code, 'child_killed')
  assert.equal(k.child, 'ffmpeg')
  assert.equal(k.signal, 'SIGKILL')
  assert.equal(k.phase, 'segment-concat')
  assert.equal(k.message, 'm')
  assert.equal(syncResultError({ status: 1, signal: null }, { child: 'ffmpeg', phase: 'segment-concat' }), null)
  // spawnSync's own timeout carries error + SIGTERM: not a kill from outside
  assert.equal(syncResultError({ status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') }, { child: 'ffmpeg' }), null)
})

test('childKilledError carries code, child, signal, phase', () => {
  const e = childKilledError({ child: 'ffmpeg', signal: 'SIGKILL', phase: 'p', message: 'x' })
  assert.ok(e instanceof Error)
  assert.deepEqual([e.code, e.child, e.signal, e.phase, e.message], ['child_killed', 'ffmpeg', 'SIGKILL', 'p', 'x'])
  assert.equal(isChildKilled(new Error('no')), false)
})

// ---------------------------------------------------------------------------
// PL83 Task 2: Chrome. A worker's Chrome killed from outside (or a page whose
// renderer dies) fails the capture at once as child_killed, child 'chrome';
// the engine's own closes (recycle, close-on-failure, siblings) never count.
// Real Chrome, a real bundle. MEASURED (puppeteer 22.15, Chrome 127): on a
// SIGKILL the CDP calls in flight reject 'Target closed' ~1 ms BEFORE the
// process exit that carries the signal; a crashed page leaves its
// screenshot hanging (until protocolTimeout, 300 s), and only page 'error'
// says so.
// ---------------------------------------------------------------------------

const CHROME_FIXTURE = join(__dirname, 'fixtures', 'captured-kills', 'chrome-sigkill.json')
const DOT = `export default function Dot() {
  return <div style={{ position: 'absolute', inset: 0, background: '#ff0000' }} />
}
`
const PX = 64
let base, overlayPath
const realTmp = process.env.TMPDIR
const bundles = []

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pl83-chrome-')))
  const ws = join(base, 'ws')
  mkdirSync(join(ws, 'proj', 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = ws
  overlayPath = join(ws, 'proj', 'overlays', 'dot.jsx')
  writeFileSync(overlayPath, DOT)
})

after(() => {
  if (realTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = realTmp
  for (const b of bundles) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

async function dotBundle(frames) {
  const b = await bundleComponent({
    componentPath: overlayPath, props: {}, fps: 30, durationFrames: frames, width: PX, height: PX,
    projectDir: dirname(dirname(overlayPath)),
  })
  bundles.push(b)
  return b
}

function segment(b, id, frames) {
  return {
    id, htmlPath: b.htmlPath, fps: 30, width: PX, height: PX, captureScale: 1,
    frameCount: frames, startSeconds: 0, endSeconds: frames / 30,
    outputPath: join(base, 'segs', `${id}.mkv`), boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts,
  }
}

/** renderChunk's job for one whole segment. */
function chunkJob(seg) {
  return { ...seg, opaque: false, subframes: 1, frameStart: 0, frameEnd: seg.frameCount, chunkIndex: 0, totalChunks: 1 }
}

/** A TMPDIR of the test's own, so its frame dirs can be watched. */
function ownTmp(name) {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  process.env.TMPDIR = dir
  return dir
}

function restoreTmp() {
  if (realTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = realTmp
}

/** Resolves once a chunk under `dir` has captured `n` frames: the capture loop is running. */
async function capturing(dir, n = 3) {
  for (let i = 0; i < 2400; i++) {
    for (const d of readdirSync(dir).filter(x => x.startsWith('montaj-frames-'))) {
      try { if (readdirSync(join(dir, d)).filter(f => f.endsWith('.png')).length >= n) return } catch {}
    }
    await sleep(25)
  }
  throw new Error('the capture never started')
}

/** pids of `parent`'s children whose command line matches `pattern` (pgrep -f). */
function childPids(parent, pattern) {
  const r = spawnSync('pgrep', ['-P', String(parent), '-f', pattern], { encoding: 'utf8' })
  return r.stdout.split('\n').map(Number).filter(Boolean)
}

/** The worker Chrome this test process launched (renderAllSegments with workers: 1). */
function theChrome() {
  const pids = childPids(process.pid, '[Cc]hrom')
  assert.equal(pids.length, 1, `one Chrome child expected, found ${pids.join(',') || 'none'}`)
  return pids[0]
}

const settle = (p, ms) => Promise.race([p.then(() => 'resolved', e => e), sleep(ms).then(() => 'still running')])

async function saveChromeCapture(err, chromeVersion) {
  if (existsSync(CHROME_FIXTURE)) return
  writeFileSync(CHROME_FIXTURE, JSON.stringify({
    message: err.message, signal: err.signal, capturedAt: new Date().toISOString(), chromeVersion,
  }, null, 2) + '\n')
}

test('renderAllSegments: a worker Chrome SIGKILLed mid-capture fails the render as child_killed within 5 s', { timeout: 120_000 }, async () => {
  const b = await dotBundle(900)
  const dir = ownTmp('t-render-kill')
  try {
    const p = renderAllSegments([segment(b, 'dot', 900)], { workers: 1, chunkSize: 900 })
    p.catch(() => {})
    await capturing(dir)
    const pid = theChrome()
    process.kill(pid, 'SIGKILL')
    const t0 = Date.now()
    const err = await settle(p, 5000)
    const ms = Date.now() - t0
    assert.ok(err instanceof Error, `the render ${err === 'resolved' ? 'succeeded' : 'was still running 5 s after the kill'}`)
    assert.equal(err.code, 'child_killed', `got ${err.name}: ${err.message}`)
    assert.equal(err.child, 'chrome')
    assert.equal(err.signal, 'SIGKILL')
    assert.equal(err.phase, 'overlay-capture')
    assert.ok(ms < 5000, `rejected ${ms} ms after the kill`)
  } finally {
    restoreTmp()
  }
})

test('renderAllSegments: a page whose renderer is killed mid-capture fails as child_killed, chrome, no signal', { timeout: 120_000 }, async () => {
  const b = await dotBundle(900)
  const dir = ownTmp('t-render-crash')
  let chrome
  try {
    const p = renderAllSegments([segment(b, 'dot', 900)], { workers: 1, chunkSize: 900 })
    p.catch(() => {})
    await capturing(dir)
    chrome = theChrome()
    const renderers = childPids(chrome, 'type=renderer')
    assert.ok(renderers.length > 0, 'Chrome has renderer processes')
    for (const pid of renderers) process.kill(pid, 'SIGKILL')
    // A crashed page's screenshot hangs until protocolTimeout (300 s); the
    // render must not wait for it, nor for waitForFunction's 10 s.
    const err = await settle(p, 5000)
    assert.ok(err instanceof Error, `the render ${err === 'resolved' ? 'succeeded' : 'was still running 5 s after its page crashed'}`)
    assert.equal(err.code, 'child_killed', `got ${err.name}: ${err.message}`)
    assert.equal(err.child, 'chrome')
    assert.equal(err.signal, null)
    assert.equal(err.phase, 'overlay-capture')
  } finally {
    // Unhang a render that never noticed (the red run): its Chrome is still up.
    if (chrome) try { process.kill(chrome, 'SIGKILL') } catch {}
    restoreTmp()
  }
})

test('renderAllSegments: recycling a worker\'s browser every 5 jobs is not a death', { timeout: 120_000 }, async () => {
  const b = await dotBundle(2)
  const segs = Array.from({ length: 7 }, (_, i) => segment(b, `s${i}`, 2))
  const out = await renderAllSegments(segs, { workers: 1, chunkSize: 2 })
  assert.deepEqual(out.map(r => r.id), segs.map(s => s.id))
  for (const r of out) assert.ok(existsSync(r.webmPath), `${r.id} encoded`)
  // The plan the render used, and none once a later render has nothing to plan.
  assert.deepEqual(R.currentRenderPlan(), { workers: 1, chunkFrames: 2 })
  assert.deepEqual(await renderAllSegments([]), [])
  assert.equal(R.currentRenderPlan(), null, 'a render with no segments leaves no plan from the last one')
})

test('launchWorkerBrowser: browser.process().kill(SIGKILL) mid-capture rejects renderChunk as child_killed within 5 s', { timeout: 120_000 }, async () => {
  const b = await dotBundle(900)
  const dir = ownTmp('t-worker-kill')
  const worker = await R.launchWorkerBrowser({})
  try {
    const chromeVersion = await worker.browser.version()
    const deaths = []
    worker.onDeath(info => deaths.push(info))
    const p = R.renderChunk(worker, chunkJob(segment(b, 'wk', 900)))
    p.catch(() => {})
    await capturing(dir)
    worker.browser.process().kill('SIGKILL')
    const t0 = Date.now()
    const err = await settle(p, 5000)
    const ms = Date.now() - t0
    assert.ok(err instanceof Error, `renderChunk ${err === 'resolved' ? 'succeeded' : 'was still running 5 s after the kill'}`)
    assert.equal(err.code, 'child_killed', `got ${err.name}: ${err.message}`)
    assert.equal(err.child, 'chrome')
    assert.equal(err.signal, 'SIGKILL')
    assert.equal(err.phase, 'overlay-capture')
    assert.ok(ms < 5000, `rejected ${ms} ms after the kill`)
    assert.equal(deaths.length, 1)
    assert.equal(deaths[0].signal, 'SIGKILL')
    await saveChromeCapture(err, chromeVersion)
  } finally {
    await worker.close().catch(() => {})
    restoreTmp()
  }
})

test('launchWorkerBrowser: the engine\'s own close(), idle or mid-capture, is never a death', { timeout: 120_000 }, async () => {
  const b = await dotBundle(900)
  const dir = ownTmp('t-worker-close')
  // Idle: the recycle path closes a browser between jobs.
  const idle = await R.launchWorkerBrowser({})
  const idleDeaths = []
  idle.onDeath(info => idleDeaths.push(info))
  await idle.close()
  // Mid-capture: close-on-failure and the sibling closes stop a capture in flight.
  const busy = await R.launchWorkerBrowser({})
  const busyDeaths = []
  busy.onDeath(info => busyDeaths.push(info))
  try {
    const p = R.renderChunk(busy, chunkJob(segment(b, 'wc', 900)))
    p.catch(() => {})
    await capturing(dir)
    await busy.close()
    const err = await settle(p, 5000)
    assert.ok(err instanceof Error, `renderChunk ${err === 'resolved' ? 'succeeded' : 'was still running 5 s after close()'}`)
    assert.ok(!isChildKilled(err), `the engine's close is not a kill: ${err.code} ${err.message}`)
    await sleep(500)
    assert.deepEqual(idleDeaths, [], 'an idle close calls no onDeath')
    assert.deepEqual(busyDeaths, [], 'a close mid-capture calls no onDeath')
  } finally {
    await busy.close().catch(() => {})
    restoreTmp()
  }
})

// PL83 review: serve stops a render (cancel, a newer export) with SIGTERM to
// its process group, and Puppeteer's own SIGTERM/SIGHUP handler SIGKILLs every
// Chrome past close(). One listener per signal, for every live worker, marks
// them closing first; one per browser would pass Node's 10-listener warning.
test('launchWorkerBrowser: one SIGTERM and one SIGHUP listener for all live workers, gone with the last', { timeout: 120_000 }, async () => {
  const count = () => ({ term: process.listenerCount('SIGTERM'), hup: process.listenerCount('SIGHUP') })
  const before = count()
  const a = await R.launchWorkerBrowser({})
  const b = await R.launchWorkerBrowser({})
  try {
    // Puppeteer's own dispatcher (one for all its browsers) and the workers' one.
    assert.deepEqual(count(), { term: before.term + 2, hup: before.hup + 2 }, 'two live workers')
    await a.close()
    assert.deepEqual(count(), { term: before.term + 2, hup: before.hup + 2 }, 'one live worker left')
    const exited = new Promise(res => b.browser.process().once('exit', res))
    b.browser.process().kill('SIGKILL')
    await exited
    await sleep(50)
    assert.deepEqual(count(), before, 'the last worker died: no listener left')
  } finally {
    await a.close().catch(() => {})
    await b.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// PL83 review: the phases are a fixed list. Every call that can raise a
// child_killed error names a phase from CHILD_KILLED_PHASES (the app reads
// them), and the list holds nothing no call emits.
// ---------------------------------------------------------------------------

/** The text between the `(` at `open` and its matching `)`, string literals skipped. */
function argsAt(src, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error(`unbalanced call at offset ${open}`)
}

/** The name of the last `function name(` before `idx`. */
function enclosingFunction(src, idx) {
  let name = null
  for (const m of src.slice(0, idx).matchAll(/\bfunction\s+(\w+)\s*\(/g)) name = m[1]
  return name
}

// Functions that pass on a phase their caller chose (checked at those callers).
const FORWARDERS = { 'child-killed.js': ['syncResultError'], 'renderer.js': ['chromeKilledError', 'spawnAsync'] }

test('CHILD_KILLED_PHASES: a frozen list of every phase a child_killed error can carry, and only those', () => {
  const PHASES = CK.CHILD_KILLED_PHASES
  assert.ok(Array.isArray(PHASES) && Object.isFrozen(PHASES), 'child-killed.js exports a frozen CHILD_KILLED_PHASES')
  const srcDir = join(__dirname, '..')
  const emitted = new Set()
  const listed = (phase, where) => {
    assert.ok(PHASES.includes(phase), `${where}: phase '${phase}' is not in CHILD_KILLED_PHASES`)
    emitted.add(phase)
  }
  let sites = 0
  for (const file of readdirSync(srcDir).filter(f => f.endsWith('.js'))) {
    const src = readFileSync(join(srcDir, file), 'utf8')
    const calls = /\b(childKilledError|syncResultError|spawnAsync|chromeKilledError|unlessChromeDies)\s*\(/g
    for (const m of src.matchAll(calls)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue // its definition
      const fn = m[1]
      const args = argsAt(src, m.index + m[0].length - 1)
      const where = `${file}: ${fn}(${args.replace(/\s+/g, ' ').slice(0, 60)}…)`
      sites++
      if (fn === 'childKilledError' || fn === 'syncResultError') {
        const lit = args.match(/\bphase:\s*'([^']+)'/)
        if (lit) { listed(lit[1], where); continue }
        assert.ok(/[{,]\s*phase\s*[,}]/.test(args), `${where}: names no phase`)
        const outer = enclosingFunction(src, m.index)
        assert.ok(FORWARDERS[file]?.includes(outer), `${where}: passes on a phase inside ${outer}, which is not a checked forwarder`)
      } else if (fn === 'spawnAsync') {
        const lit = args.trim().match(/,\s*'([^']+)'\s*,?$/)
        assert.ok(lit, `${where}: the phase must be a string literal, last`)
        listed(lit[1], where)
      } else if (fn === 'chromeKilledError') {
        assert.match(args, /^\s*\w+\s*,\s*phaseOf\(\)\s*,/, `${where}: Chrome's phase comes from phaseOf()`)
      } else {
        assert.match(args, /\(\)\s*=>\s*at\.phase\b/, `${where}: phaseOf reads at.phase`)
      }
    }
    for (const a of src.matchAll(/\bat\s*=\s*\{\s*phase:\s*'([^']+)'\s*\}|\bat\.phase\s*=\s*'([^']+)'/g)) {
      listed(a[1] ?? a[2], `${file}: at.phase`)
    }
  }
  assert.ok(sites >= 15, `found only ${sites} call sites: the scan is not reading the sources`)
  assert.deepEqual([...emitted].sort(), [...PHASES].sort(), 'every listed phase is emitted somewhere, and nothing else')
})
