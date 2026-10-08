// §131 (PL83 Part 2): a chunk's overlay frames stream into its ffmpeg.
//
// Each screenshot used to be a PNG in TMPDIR until its chunk was encoded, so
// TMPDIR held workers x chunk frames at once and grew with the video's length.
// Now the chunk's ffmpeg starts first and reads the PNGs from its stdin
// (image2pipe), and each write awaits 'drain'.
//
//   - chunkEncodeArgs: only the input changed (pure).
//   - (a) a chunk renders with no frame PNG ever written, every frame encoded.
//   - (b) a capture failure mid-chunk kills the chunk's ffmpeg, no partial MKV.
//   - (c) ffmpeg SIGKILLed mid-chunk: child_killed, overlay-encode; the capture
//         stops; no partial MKV; nothing unhandled; (c2) the same while a frame
//         waits for drain, which forces the EPIPE.
//   - (d) backpressure: an ffmpeg that reads nothing (SIGSTOP) stops the
//         capture within a frame or two, measured against the capture's own rate.
//
// Real Chrome, a real bundle, the managed ffmpeg. Screenshots are counted by
// wrapping the worker's newPage, which captureChunkFrames calls.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FFPROBE } from '../ffmpeg-bin.js'
import { motionBlurFilter } from '../motion-blur.js'
import * as R from '../renderer.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// chunkEncodeArgs: everything after the input is as it was
// ---------------------------------------------------------------------------

/** The encode as it was before §131, with the PNG pattern swapped for the pipe input. */
function expectedArgs({ fps, subframes, alpha }, mkv) {
  const blurVf = motionBlurFilter(subframes, { alpha })
  return [
    '-y',
    ...(blurVf && alpha ? ['-reinit_filter', '0'] : []),
    '-f', 'image2pipe', '-c:v', 'png',
    '-framerate', String(blurVf ? fps * subframes : fps),
    '-i', 'pipe:0',
    ...(blurVf ? ['-vf', blurVf, '-r', String(fps)] : []),
    '-c:v', 'ffv1', '-g', '1', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-f', 'matroska',
    '-cluster_size_limit', '2000000', '-reserve_index_space', '1000000',
    mkv,
  ]
}

test('chunkEncodeArgs: the chunk reads PNGs from stdin; the rest of the encode is unchanged', () => {
  assert.equal(typeof R.chunkEncodeArgs, 'function', 'renderer.js exports chunkEncodeArgs')
  const mkv = '/x/seg-chunk-0.mkv'
  // Spelled out once, so a change to the shared tail cannot hide in expectedArgs.
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: false, subframes: 1 }, mkv), [
    '-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '30', '-i', 'pipe:0',
    '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska',
    '-cluster_size_limit', '2000000', '-reserve_index_space', '1000000', mkv,
  ])
  for (const fps of [30, 60]) {
    for (const subframes of [1, 3]) {
      for (const opaque of [false, true]) {
        const args = R.chunkEncodeArgs({ fps, opaque, subframes }, mkv)
        assert.deepEqual(args, expectedArgs({ fps, subframes, alpha: !opaque }, mkv), `fps ${fps}, subframes ${subframes}, opaque ${opaque}`)
        assert.ok(!args.some(a => /frame-%06d|\.png$/.test(a)), 'no PNG file pattern')
      }
    }
  }
  // An opaque overlay that is a crossfade's incoming side takes the alpha path.
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: true, transitionTo: true, subframes: 2 }, mkv),
    expectedArgs({ fps: 30, subframes: 2, alpha: true }, mkv))
})

// ---------------------------------------------------------------------------
// Integration: real Chrome, real ffmpeg
// ---------------------------------------------------------------------------

// Top half red: a transparent capture with transparent pixels (RGBA PNGs).
const HALF = `export default function Half() {
  return <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '50%', background: '#ff0000' }} />
}
`
// Noise in every channel, alpha included: PNGs near their raw size, far
// larger than a pipe's buffer, so frames held can be counted, not bytes.
const NOISE = `export default function Noise() {
  return <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
    <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed={Math.floor(frame)} /></filter>
    <rect width="100%" height="100%" filter="url(#n)" />
  </svg>
}
`

let base, projDir
const realTmp = process.env.TMPDIR
const bundles = []

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-stream-frames-')))
  const ws = join(base, 'ws')
  projDir = join(ws, 'proj')
  mkdirSync(join(projDir, 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = ws
})

after(() => {
  restoreTmp()
  for (const b of bundles) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

function restoreTmp() {
  if (realTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = realTmp
}

async function overlayBundle(name, jsx, size, frames) {
  const componentPath = join(projDir, 'overlays', `${name}.jsx`)
  writeFileSync(componentPath, jsx)
  const b = await bundleComponent({
    componentPath, props: {}, fps: 30, durationFrames: frames, width: size, height: size, projectDir: projDir,
  })
  bundles.push(b)
  return b
}

/** renderChunk's job for one whole segment of `b`. */
function chunkJob(b, id, { size, frames, opaque = false, subframes = 1, outDir = join(base, 'segs') }) {
  return {
    id, htmlPath: b.htmlPath, fps: 30, width: size, height: size, captureScale: 1,
    frameCount: frames, startSeconds: 0, endSeconds: frames / 30,
    outputPath: join(outDir, `${id}.mkv`), boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts,
    opaque, subframes, frameStart: 0, frameEnd: frames, chunkIndex: 0, totalChunks: 1,
  }
}

const chunkMkvOf = job => join(job.outputPath.replace(/\.mkv$/, '') + '-chunk-0.mkv')

/**
 * Counts the worker's screenshots (size, time, options), by wrapping the page
 * captureChunkFrames opens. `hook(n)` runs after the n-th; a throw from it
 * fails that screenshot.
 */
function countShots(worker, hook) {
  const shots = { n: 0, sizes: [], times: [], opts: [] }
  const newPage = worker.browser.newPage.bind(worker.browser)
  worker.browser.newPage = async (...a) => {
    const page = await newPage(...a)
    const shot = page.screenshot.bind(page)
    page.screenshot = async (opts) => {
      const buf = await shot(opts)
      shots.n++
      shots.sizes.push(buf.length)
      shots.times.push(Date.now())
      shots.opts.push(opts)
      hook?.(shots.n)
      return buf
    }
    return page
  }
  return shots
}

/** pids of this process's chunk encoders: ffmpeg reading image2pipe. */
function encoders() {
  const r = spawnSync('pgrep', ['-P', String(process.pid), '-f', 'image2pipe'], { encoding: 'utf8' })
  return r.stdout.split('\n').map(Number).filter(Boolean)
}

function theEncoder() {
  const pids = encoders()
  assert.equal(pids.length, 1, `one chunk ffmpeg expected, found ${pids.join(',') || 'none'}`)
  return pids[0]
}

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }

async function until(cond, what, ms = 60_000) {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

const settle = (p, ms) => Promise.race([p.then(() => 'resolved', e => e), sleep(ms).then(() => 'still running')])

function probe(path, entries) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', `stream=${entries}`, '-of', 'json', path], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).streams[0]
}

/** uncaughtException and unhandledRejection while the test runs (an EPIPE nobody listened for). */
function trapUnhandled() {
  const errors = []
  const onErr = e => errors.push(e)
  process.on('uncaughtException', onErr)
  process.on('unhandledRejection', onErr)
  return { errors, off() { process.off('uncaughtException', onErr); process.off('unhandledRejection', onErr) } }
}

/**
 * Frame dirs and frame PNGs under `dirs`, Chrome's profile skipped. Polled, not
 * fs.watch: MEASURED on macOS, of three recursive fs.watch made one after
 * another, two delivered no event at all.
 */
function frameFiles(dirs) {
  const found = []
  const walk = d => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (/^montaj-frames-/.test(e.name) || /^frame-\d+\.png$/.test(e.name)) found.push(join(d, e.name))
      if (e.isDirectory() && !e.name.startsWith('puppeteer_dev_chrome_profile')) walk(join(d, e.name))
    }
  }
  for (const d of dirs) walk(d)
  return found
}

// (a)
test('a chunk streams its frames: no frame PNG is ever written, and the MKV holds every frame', { timeout: 180_000 }, async () => {
  const b = await overlayBundle('half', HALF, 64, 30)
  const cases = [
    { name: 'alpha', opaque: false, subframes: 1, shots: 30, pix: 'yuva420p' },
    { name: 'opaque', opaque: true, subframes: 1, shots: 30, pix: 'yuv420p' },
    { name: 'blur', opaque: false, subframes: 2, shots: 60, pix: 'yuva420p' },
  ]
  for (const c of cases) {
    // A TMPDIR of the case's own, where frames went before §131 (read at call time).
    const tmp = join(base, `tmp-a-${c.name}`)
    const outDir = join(base, `segs-a-${c.name}`)
    mkdirSync(tmp, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    process.env.TMPDIR = tmp
    const worker = await R.launchWorkerBrowser({})
    const shots = countShots(worker)
    // Before §131 a chunk's frame dir and its PNGs stayed from its first
    // screenshot to its encode, so a poll during the capture finds them.
    const found = new Set()
    let pollsDuringCapture = 0
    const poll = setInterval(() => {
      for (const f of frameFiles([tmp, outDir])) found.add(f)
      if (shots.n > 0 && shots.n < c.shots) pollsDuringCapture++
    }, 5)
    try {
      const job = chunkJob(b, `half-${c.name}`, { size: 64, frames: 30, opaque: c.opaque, subframes: c.subframes, outDir })
      const { webmPath } = await R.renderChunk(worker, job)
      assert.equal(webmPath, chunkMkvOf(job))
      // The poll can say no only if it ran while the capture did.
      assert.ok(pollsDuringCapture >= 5, `${c.name}: only ${pollsDuringCapture} polls during the capture`)
      assert.deepEqual([...found], [], `${c.name}: a frame PNG or frame dir appeared`)
      assert.equal(shots.n, c.shots, `${c.name}: screenshots`)
      assert.ok(shots.opts.every(o => o.path === undefined), `${c.name}: a screenshot was written to a path`)
      const s = probe(webmPath, 'nb_read_packets,pix_fmt,codec_name')
      assert.equal(Number(s.nb_read_packets), 30, `${c.name}: frames in the MKV`)
      assert.equal(s.pix_fmt, c.pix, `${c.name}: pixel format`)
      assert.equal(s.codec_name, 'ffv1')
      assert.deepEqual(encoders(), [], `${c.name}: the chunk's ffmpeg exited`)
    } finally {
      clearInterval(poll)
      await worker.close().catch(() => {})
      restoreTmp()
    }
  }
})

// (b)
test('a capture failure mid-chunk kills the chunk\'s ffmpeg and leaves no partial MKV', { timeout: 120_000 }, async () => {
  const b = await overlayBundle('dot-b', HALF, 64, 900)
  const worker = await R.launchWorkerBrowser({})
  const job = chunkJob(b, 'capture-fail', { size: 64, frames: 900 })
  const boom = new Error('screenshot failed (stream-frames test)')
  let encoder = null
  let mkvMidCapture = false
  let failedAt = 0
  // Fails once the partial MKV is on disk. MEASURED: ffmpeg creates it only
  // after probing its piped input (~5 s of frames, 150 here), not at frame 1.
  countShots(worker, n => {
    if (n < 10 || (!existsSync(chunkMkvOf(job)) && n < 600)) return
    encoder = theEncoder()
    mkvMidCapture = existsSync(chunkMkvOf(job))
    failedAt = n
    throw boom
  })
  try {
    const err = await R.renderChunk(worker, job).then(() => assert.fail('expected a rejection'), e => e)
    assert.equal(err, boom, `the capture's own error, got ${err?.code} ${err?.message}`)
    assert.ok(encoder, 'the chunk\'s ffmpeg was running during the capture')
    assert.equal(alive(encoder), false, 'the chunk\'s ffmpeg is gone when renderChunk rejects')
    assert.deepEqual(encoders(), [])
    // Can say no: the partial MKV was on disk when the capture failed.
    assert.equal(mkvMidCapture, true, `the MKV existed mid-capture (failed at frame ${failedAt})`)
    assert.equal(existsSync(chunkMkvOf(job)), false, 'the partial MKV was removed')
    assert.equal(worker.dead, null, 'Chrome was not involved')
  } finally {
    await worker.close().catch(() => {})
  }
})

// (c)
test('ffmpeg SIGKILLed mid-chunk: child_killed, overlay-encode; the capture stops; no partial MKV; nothing unhandled', { timeout: 120_000 }, async () => {
  const b = await overlayBundle('dot-c', HALF, 64, 900)
  const worker = await R.launchWorkerBrowser({})
  const shots = countShots(worker)
  const job = chunkJob(b, 'ffmpeg-kill', { size: 64, frames: 900 })
  const stray = trapUnhandled()
  try {
    const p = R.renderChunk(worker, job)
    p.catch(() => {})
    await until(() => shots.n >= 10, '10 screenshots')
    const pid = theEncoder()
    process.kill(pid, 'SIGKILL')
    const t0 = Date.now()
    const err = await settle(p, 5000)
    const ms = Date.now() - t0
    assert.ok(err instanceof Error, `renderChunk ${err === 'resolved' ? 'succeeded' : 'was still running 5 s after its ffmpeg was killed'}`)
    assert.equal(err.code, 'child_killed', `got ${err.name}: ${err.message}`)
    assert.equal(err.child, 'ffmpeg')
    assert.equal(err.signal, 'SIGKILL')
    assert.equal(err.phase, 'overlay-encode')
    assert.match(err.message, /^ffmpeg PNG→ffv1 failed \(segment ffmpeg-kill chunk 0\):/)
    assert.ok(ms < 5000, `rejected ${ms} ms after the kill`)
    const atFailure = shots.n
    assert.ok(atFailure < 900, 'failed mid-chunk')
    await sleep(500) // a late EPIPE or a capture still running would show here
    assert.equal(shots.n, atFailure, 'the capture stopped')
    assert.equal(existsSync(chunkMkvOf(job)), false, 'the partial MKV was removed')
    assert.deepEqual(stray.errors.map(e => `${e?.code ?? ''} ${e?.message ?? e}`), [], 'nothing unhandled')
    assert.equal(worker.dead, null, 'Chrome was not involved')
  } finally {
    stray.off()
    await worker.close().catch(() => {})
  }
})

// (c2) The kill above is usually seen through ffmpeg's exit before the next
// write, so it never writes to a dead pipe. Here a frame is waiting for
// 'drain' (ffmpeg stopped, the frame far larger than the pipe) when ffmpeg is
// killed, so the pending write fails with EPIPE: recorded, and the exit decides.
test('ffmpeg SIGKILLed while a frame waits for drain: the EPIPE is not unhandled, the error is child_killed', { timeout: 120_000 }, async () => {
  const SIZE = 480
  const b = await overlayBundle('noise-c2', NOISE, SIZE, 120)
  const worker = await R.launchWorkerBrowser({})
  const shots = countShots(worker)
  const job = chunkJob(b, 'epipe', { size: SIZE, frames: 120 })
  const stray = trapUnhandled()
  let pid = null
  try {
    const p = R.renderChunk(worker, job)
    p.catch(() => {})
    await until(() => shots.n >= 6, '6 screenshots')
    pid = theEncoder()
    process.kill(pid, 'SIGSTOP')
    await sleep(500) // the capture is now waiting for drain
    assert.ok(Math.min(...shots.sizes) > 256 * 1024, 'frames far larger than the pipe')
    process.kill(pid, 'SIGKILL')
    const err = await settle(p, 5000)
    assert.ok(err instanceof Error, `renderChunk ${err === 'resolved' ? 'succeeded' : 'was still running 5 s after its ffmpeg was killed'}`)
    assert.equal(err.code, 'child_killed', `got ${err.name}: ${err.message}`)
    assert.equal(err.child, 'ffmpeg')
    assert.equal(err.signal, 'SIGKILL')
    assert.equal(err.phase, 'overlay-encode')
    await sleep(500)
    assert.deepEqual(stray.errors.map(e => `${e?.code ?? ''} ${e?.message ?? e}`), [], 'nothing unhandled')
    assert.equal(existsSync(chunkMkvOf(job)), false, 'the partial MKV was removed')
  } finally {
    stray.off()
    if (pid) try { process.kill(pid, 'SIGKILL') } catch {}
    await worker.close().catch(() => {})
  }
})

// (d)
test('backpressure: an ffmpeg that reads nothing stops the capture within a frame or two', { timeout: 180_000 }, async (t) => {
  const SIZE = 480
  const FRAMES = 120
  const b = await overlayBundle('noise', NOISE, SIZE, FRAMES)
  const worker = await R.launchWorkerBrowser({})
  const shots = countShots(worker)
  const job = chunkJob(b, 'backpressure', { size: SIZE, frames: FRAMES })
  let stopped = null
  try {
    const p = R.renderChunk(worker, job)
    p.catch(() => {})
    await until(() => shots.n >= 6, '6 screenshots')
    const pid = theEncoder()
    process.kill(pid, 'SIGSTOP')
    stopped = pid
    const atStop = shots.n

    // The test can say no only with frames far over a pipe's buffer (64 KB)
    // plus Node's high-water mark (16 KB), and a capture fast enough that,
    // unbounded, it would take many frames while ffmpeg reads none.
    const smallest = Math.min(...shots.sizes)
    assert.ok(smallest > 256 * 1024, `frames of ${smallest} bytes are too small to count frames held`)
    const perShot = (shots.times[5] - shots.times[1]) / 4
    const stopMs = Math.min(15_000, Math.max(1500, perShot * 15))
    const unbounded = Math.floor(stopMs / perShot)
    assert.ok(unbounded >= 10, `a capture at ${perShot} ms a frame cannot show the bound in ${stopMs} ms`)

    await sleep(stopMs)
    const during = shots.n - atStop
    t.diagnostic(`frames ${smallest}+ bytes, ${perShot.toFixed(1)} ms each; ffmpeg stopped ${stopMs} ms: ${during} screenshots (unbounded about ${unbounded})`)
    assert.ok(during <= 2,
      `${during} screenshots while ffmpeg read nothing for ${stopMs} ms (bounded: at most 2; unbounded about ${unbounded})`)

    process.kill(pid, 'SIGCONT')
    stopped = null
    const { webmPath } = await p
    assert.equal(shots.n, FRAMES)
    assert.equal(Number(probe(webmPath, 'nb_read_packets').nb_read_packets), FRAMES, 'every frame reached the MKV')
  } finally {
    if (stopped) try { process.kill(stopped, 'SIGCONT') } catch {}
    await worker.close().catch(() => {})
  }
})

// A spawn that fails (EMFILE/ENFILE) rejects the encode and leaves child.stdin
// null. That must fail the chunk with the spawn's error, not throw a TypeError
// before the rejection is handled (an unhandled rejection kills the render
// with no failure line).
test('a failed ffmpeg spawn (no stdin): write and end reject with the spawn error; nothing unhandled', async () => {
  const stray = trapUnhandled()
  try {
    const spawnErr = Object.assign(new Error('spawn ffmpeg EMFILE'), { code: 'EMFILE' })
    const encode = Object.assign(Promise.reject(spawnErr), { child: { stdin: null, kill() {} } })
    const sink = R.frameSink(encode, 'ffmpeg PNG→ffv1 failed (segment x chunk 0)')
    await assert.rejects(sink.write(Buffer.from('x')), e => e === spawnErr)
    await assert.rejects(sink.end(), e => e === spawnErr)
    await sink.abort()
    await sleep(50)
    assert.deepEqual(stray.errors.map(e => e?.message ?? String(e)), [], 'nothing unhandled')
  } finally {
    stray.off()
  }
})
