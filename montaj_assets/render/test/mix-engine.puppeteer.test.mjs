// render/test/mix-engine.puppeteer.test.mjs
//
// §190: the editor preview's mixer (editor/src/engine/mix/) in a real
// browser. The vitest specs drive the worklet and Worker strings with fake
// ports; this runs them for real: a real AudioWorklet, a real blob Worker
// range-fetching conformed PCM over HTTP, a real MessageChannel between them.
//
// The page is mix-clock.ts bundled with esbuild, plus a small recorder
// AudioWorkletNode the mix is connected to (it captures channel 0 by the
// context's own frame counter). The conformed audio is raw s16le stereo sine
// tones synthesized here and served by a local http server that honours Range
// (the endpoint serve gives the app does the same).
//
// It proves three things, none of which a fake port can:
//   1. No gap at a boundary: two segments that meet exactly (A ends where B
//      starts) come out continuous. The longest run of near-zero samples
//      across the join stays under 1 ms.
//   2. The clock tracks the AudioContext: MixClock.now() against the
//      context's currentTime stays within 5 ms (the context advances in
//      device-buffer bursts, so the error is judged by its median, with a
//      looser bound on the worst sample).
//   3. Mute takes effect within 15 ms: after setParams({ mute }), the output
//      is below -60 dB (relative to the level just before) 15 ms of context
//      time later, and stays there.
//
// Not launched with overlayPageLaunchOptions: its host-resolver rules refuse
// every host, localhost included, and this page needs its own http server.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer'

const RENDER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIX_CLOCK = join(RENDER_DIR, '..', 'editor', 'src', 'engine', 'mix', 'mix-clock.ts')

const SR = 48000
const SECONDS = 4

// s16le stereo sine, both channels the same.
function sinePcm(hz, amp) {
  const buf = Buffer.alloc(SR * SECONDS * 4)
  for (let i = 0; i < SR * SECONDS; i++) {
    const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / SR))
    buf.writeInt16LE(v, i * 4)
    buf.writeInt16LE(v, i * 4 + 2)
  }
  return buf
}

const FILES = {
  '/pcm/a.pcm': sinePcm(440, 0.5),
  '/pcm/b.pcm': sinePcm(330, 0.5),
}

// The page: the recorder, and a handful of helpers the test drives.
const PAGE_ENTRY = `
import { createMixClock } from ${JSON.stringify(MIX_CLOCK)}

const RECORDER = \`
class MixTestRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage({ f: currentFrame, d: ch.slice() })
    return true
  }
}
registerProcessor('mix-test-recorder', MixTestRecorder)
\`

const t = { errors: [] }
window.__t = t

t.setup = async (plan) => {
  if (!t.ctx) {
    t.ctx = new AudioContext({ sampleRate: ${SR} })
    const url = URL.createObjectURL(new Blob([RECORDER], { type: 'text/javascript' }))
    await t.ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
  }
  await t.ctx.resume()
  t.base = Math.floor(t.ctx.currentTime * ${SR})
  t.buf = new Float32Array(${SR} * 20)
  t.rec = new AudioWorkletNode(t.ctx, 'mix-test-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
  t.rec.port.onmessage = (e) => {
    const i = e.data.f - t.base
    if (i >= 0 && i + e.data.d.length <= t.buf.length) t.buf.set(e.data.d, i)
  }
  t.rec.connect(t.ctx.destination)
  t.clock = await createMixClock({ context: t.ctx, destination: t.rec, onError: (m) => t.errors.push(m) })
  t.clock.setPlan(plan)
  return t.ctx.sampleRate
}

// The context frame now, on the recording's axis.
t.mark = () => t.ctx.currentTime * ${SR} - t.base

t.slice = (from, to) => Array.from(t.buf.subarray(Math.max(0, Math.floor(from)), Math.floor(to)))

t.teardown = () => {
  t.clock.dispose()
  t.rec.port.onmessage = null
  t.rec.disconnect()
}

// now() against currentTime, every 20 ms for ms milliseconds. The truth line
// is anchored on the worklet's own report (timelineTime at contextTime).
t.trackClock = (ms, t0) => new Promise((resolve) => {
  const out = []
  let c0 = null
  const iv = setInterval(() => {
    const st = t.clock.stats()
    if (c0 === null) c0 = st.contextTime - (st.timelineTime - t0)
    out.push({ now: t.clock.now(), ct: t.ctx.currentTime, c0 })
  }, 20)
  setTimeout(() => { clearInterval(iv); resolve(out) }, ms)
})
`

async function buildPage(workDir) {
  await esbuild.build({
    stdin: { contents: PAGE_ENTRY, resolveDir: dirname(MIX_CLOCK), sourcefile: 'mix-engine-page.js', loader: 'js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: join(workDir, 'page.js'),
    logLevel: 'silent',
  })
  return join(workDir, 'page.js')
}

// Static page + PCM files, with Range support.
function serve(pagePath) {
  return createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script src="/page.js"></script></body></html>')
      return
    }
    if (path === '/page.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(readFileSync(pagePath))
      return
    }
    const file = FILES[path]
    if (!file) {
      res.writeHead(404)
      res.end()
      return
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    if (!m) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.length })
      res.end(file)
      return
    }
    const from = Number(m[1])
    const to = Math.min(m[2] === '' ? file.length - 1 : Number(m[2]), file.length - 1)
    if (from >= file.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${file.length}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${from}-${to}/${file.length}`,
      'Content-Length': to - from + 1,
    })
    res.end(file.subarray(from, to + 1))
  })
}

let workDir, server, browser, page
const pageErrors = []

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'montaj-mix-engine-test-'))
  const pagePath = await buildPage(workDir)
  server = serve(pagePath)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    protocolTimeout: 120000,
  })
  page = await browser.newPage()
  page.on('pageerror', (err) => pageErrors.push(String((err && err.message) || err)))
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
})

after(async () => {
  if (browser) await browser.close()
  if (server) await new Promise((r) => server.close(r))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Build the plan, park at `at`, and wait until the Worker has fed the mixer.
async function prepare(plan, at) {
  const sr = await page.evaluate((p) => window.__t.setup(p), plan)
  assert.equal(sr, SR, 'the context must run at 48 kHz for this test')
  await page.evaluate((t) => window.__t.clock.seek(t), at)
  await page.waitForFunction((n) => window.__t.clock.stats().queuedFrames > n, { timeout: 8000 }, SR / 2).catch(() => {})
}

async function finish() {
  await page.evaluate(() => window.__t.teardown())
  const errors = await page.evaluate(() => window.__t.errors)
  assert.deepEqual(errors, [], `mixer errors: ${errors.join(' | ')}`)
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`)
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)

test('two segments that meet exactly play with no gap at the boundary', { timeout: 60_000 }, async () => {
  const plan = {
    segments: [
      { id: 'A', url: '/pcm/a.pcm', tlStart: 0.2, tlEnd: 0.8, srcIn: 0, frames: SR * SECONDS },
      { id: 'B', url: '/pcm/b.pcm', tlStart: 0.8, tlEnd: 1.6, srcIn: 0.3, frames: SR * SECONDS },
    ],
  }
  await prepare(plan, 0.5)
  const m0 = await page.evaluate(() => { const m = window.__t.mark(); window.__t.clock.play(); return m })
  await sleep(1100)
  await page.evaluate(() => window.__t.clock.pause())
  await sleep(200)
  const x = await page.evaluate((from) => window.__t.slice(from, from + 48000 * 1.2), m0)
  await finish()

  // Sound starts when the signal first clears 0.01 (past the 5 ms play fade);
  // A plays 0.3 s, then B. Judge 5 ms in to 0.55 s in.
  const start = x.findIndex((v) => Math.abs(v) > 0.01)
  assert.ok(start >= 0, 'no sound at all')
  const from = start + 240
  const to = start + Math.round(0.55 * SR)
  let run = 0
  let longest = 0
  for (let i = from; i < to; i++) {
    run = Math.abs(x[i]) < 0.01 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  // A 440 Hz or 330 Hz sine at 0.5 spends well under 0.1 ms below 0.01 at each zero crossing.
  assert.ok(longest <= 48, `longest near-zero run ${longest} samples (${((longest / SR) * 1000).toFixed(2)} ms), want at most 1 ms`)
  // Both halves really sounded, so the check above is not passing on silence.
  assert.ok(rms(x.slice(start + 4800, start + 12000)) > 0.25, 'segment A is not sounding')
  assert.ok(rms(x.slice(start + 18000, start + 25000)) > 0.25, 'segment B is not sounding')
})

test('MixClock.now() tracks the AudioContext clock within 5 ms', { timeout: 60_000 }, async () => {
  const T0 = 0.5
  const plan = { segments: [{ id: 'A', url: '/pcm/a.pcm', tlStart: 0, tlEnd: 4, srcIn: 0, frames: SR * SECONDS }] }
  await prepare(plan, T0)
  await page.evaluate(() => window.__t.clock.play())
  await sleep(300) // reports flowing
  const samples = await page.evaluate((t0) => window.__t.trackClock(1500, t0), T0)
  await page.evaluate(() => window.__t.clock.pause())
  await finish()

  assert.ok(samples.length > 40, `only ${samples.length} samples`)
  // Timeline time the context says it is at: T0 plus the context time since the clock started.
  const errMs = samples.map((s) => (s.now - (T0 + (s.ct - s.c0))) * 1000)
  const abs = errMs.map(Math.abs).sort((a, b) => a - b)
  const median = abs[Math.floor(abs.length / 2)]
  const worst = abs[abs.length - 1]
  // eslint-disable-next-line no-console
  console.log(`[mix clock] ${samples.length} samples, |now - currentTime| median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`)
  assert.ok(median <= 5, `median error ${median.toFixed(2)} ms`)
  assert.ok(worst <= 25, `worst error ${worst.toFixed(2)} ms`)
  // And it is not drifting: the last quarter's mean error matches the first quarter's.
  const q = Math.floor(errMs.length / 4)
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
  const drift = mean(errMs.slice(-q)) - mean(errMs.slice(0, q))
  assert.ok(Math.abs(drift) <= 5, `the error drifted ${drift.toFixed(2)} ms over the run`)
})

test('mute silences the output within 15 ms', { timeout: 60_000 }, async () => {
  const plan = { segments: [{ id: 'A', url: '/pcm/a.pcm', tlStart: 0, tlEnd: 4, srcIn: 0, frames: SR * SECONDS }] }
  await prepare(plan, 0)
  await page.evaluate(() => window.__t.clock.play())
  await sleep(500)
  // The context frame at the call is at or before the one the mute lands on, so
  // measuring from it is the stricter reading.
  const applied = await page.evaluate(() => {
    const m = window.__t.mark()
    window.__t.clock.setParams({ A: { mute: true } })
    return m
  })
  await sleep(400)
  await page.evaluate(() => window.__t.clock.pause())
  const before = await page.evaluate((m) => window.__t.slice(m - 4800, m), applied)
  const after = await page.evaluate((m) => window.__t.slice(m, m + 9600), applied)
  await finish()

  const peak = Math.max(...before.map(Math.abs))
  assert.ok(peak > 0.4, `the tone was not sounding before the mute (peak ${peak})`)
  const floor = peak * 0.001 // -60 dB
  const deadline = Math.ceil(0.015 * SR)
  let last = -1
  for (let i = 0; i < after.length; i++) if (Math.abs(after[i]) >= floor) last = i
  // eslint-disable-next-line no-console
  console.log(`[mix mute] last sample above -60 dB at ${((last / SR) * 1000).toFixed(2)} ms after the call`)
  assert.ok(last < deadline, `sound above -60 dB ${((last / SR) * 1000).toFixed(2)} ms after the mute, want under 15 ms`)
})
