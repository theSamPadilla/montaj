// render/test/open-gop-seek.integration.test.mjs
//
// PV48: a video item that starts inside an open-GOP keyframe's leading
// pictures shows the right frames.
//
// libx265 at its defaults writes open GOPs with B-frames, and that is how every
// SDR clip converted to HLG is encoded. A keyframe's leading pictures are
// displayed before it but decoded after it, from the previous GOP. The segment
// encoder used to seek each item with the input alone (`-ss t -i`); a seek into
// that window dropped those pictures, the keyframe became the item's first
// frame, and the whole segment's picture ran 1 to 3 frames ahead of its own
// audio (measured in a real render, PV48 T1). encode-segment.js now seeks in
// two stages (twoStageSeek), and this file proves it on real pixels.
//
// Real ffmpeg, the real encodeSegment (no dry run). The fixture is a small
// open-GOP x265 clip generated here. Its top strip carries each frame's display
// index as 8 black/white blocks, so a decoded frame names itself exactly, with
// no similarity threshold to tune. The at-risk seek instants are found, not
// assumed: a single input seek must be seen to lose frames there first, or the
// test fails as proving nothing. Audio is a chirp, so its lag is unambiguous.
//
// GATING: skipped without libx265 + libx264 (MONTAJ_FFMPEG picks the binary);
// MONTAJ_REQUIRE_HDR_FFMPEG=1 turns the skip into a failure.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { encodeSegment } from '../encode-segment.js'

const W = 160
const H = 96
const FPS = 30
const SR = 48000
const SEG = 0.5 // seconds per encoded segment: 15 frames

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

function capabilitySkip() {
  const reason = capabilityReason()
  // Opt-in loud mode: a skipped PV48 proof must fail, not pass by omission.
  if (reason && process.env.MONTAJ_REQUIRE_HDR_FFMPEG === '1') throw new Error(`MONTAJ_REQUIRE_HDR_FFMPEG=1 but ${reason}`)
  return reason
}
function capabilityReason() {
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/\blibx265\b/.test(encoders) || !/\blibx264\b/.test(encoders)) {
    return `${FFMPEG} lacks libx265 + libx264 (set MONTAJ_FFMPEG)`
  }
  if (spawnSync(FFPROBE, ['-version'], { timeout: 10_000 }).status !== 0) return `${FFPROBE} does not run (set MONTAJ_FFPROBE)`
  return false
}
const SKIP = capabilitySkip()

// ---------------------------------------------------------------------------
// Media and measurement
// ---------------------------------------------------------------------------

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Every decoded frame's display index, read from its counter strip. */
function frameIndices(file, pre = [], post = []) {
  const r = spawnSync(FFMPEG, ['-v', 'error', ...pre, '-i', file, ...post, '-map', '0:v:0',
    '-vf', 'format=gray', '-f', 'rawvideo', 'pipe:1'],
  { encoding: 'buffer', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read of ${file} failed: ${r.stderr}`)
  const px = W * H
  const out = []
  for (let f = 0; f * px < r.stdout.length; f++) {
    let n = 0
    for (let b = 0; b < 8; b++) {
      let sum = 0
      let count = 0
      for (let y = 2; y < 14; y++) {
        for (let x = b * 20 + 4; x < b * 20 + 16; x++) { sum += r.stdout[f * px + y * W + x]; count++ }
      }
      if (sum / count > 128) n |= 1 << b
    }
    out.push(n)
  }
  return out
}

/** Stereo s16 PCM at SR of the first audio stream. */
function pcm(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0',
    '-f', 's16le', '-ac', '2', '-ar', String(SR), 'pipe:1'],
  { encoding: 'buffer', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `audio read of ${file} failed: ${r.stderr}`)
  return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 2)
}

function meanAbsAt(seg, ref, from) {
  let sum = 0
  for (let i = 0; i < seg.length; i++) sum += Math.abs(seg[i] - ref[from * 2 + i])
  return sum / seg.length
}

// ---------------------------------------------------------------------------
// Fixture: built once, on first use, so a skipped file costs nothing
// ---------------------------------------------------------------------------

let fx = null
let fxDir = null
after(() => { if (fxDir) rmSync(fxDir, { recursive: true, force: true }) })

function fixture() {
  if (fx) return fx
  fxDir = mkdtempSync(path.join(tmpdir(), 'montaj-opengop-'))
  const src = path.join(fxDir, 'open-gop.mp4')
  // testsrc2 for realistic motion, the counter strip over its top 16 rows: bit
  // b of the frame number is the block at x = 20b..20b+19. open-gop=1 is
  // x265's default already; it is spelled out so the fixture keeps meaning
  // what this file needs if that default ever moves.
  const counter = "geq=lum='if(lt(Y\\,16)\\,255*mod(floor(N/pow(2\\,floor(X/20)))\\,2)\\,lum(X\\,Y))'"
    + ":cb='cb(X,Y)':cr='cr(X,Y)'"
  ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}:duration=7,${counter}`,
    '-f', 'lavfi', '-i', `aevalsrc=0.4*sin(2*PI*(300*t+200*t*t)):s=${SR}:d=7`,
    '-c:v', 'libx265', '-x265-params', 'log-level=error:open-gop=1', '-g', String(FPS), '-keyint_min', String(FPS),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])

  // The exact source: decoded from 0, no seek. Its counters must read 0, 1, 2…
  // or the reader is wrong and nothing below means anything.
  const exact = frameIndices(src)
  assert.ok(exact.length >= 6 * FPS, `fixture too short: ${exact.length} frames`)
  exact.forEach((n, i) => assert.equal(n, i, `the counter strip misreads source frame ${i} as ${n}`))

  // Keyframes after the first, by display time.
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', src], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr}`)
  const keyframes = probe.stdout.trim().split('\n')
    .map((l) => l.split(','))
    .filter(([pts, flags]) => flags.includes('K') && Number(pts) > 0.5)
    .map(([pts]) => Math.round(Number(pts) * FPS))

  // An instant is at risk when the OLD form, a single input seek, starts on
  // the wrong frame there: the precondition that makes a pass mean something.
  const atRisk = []
  for (const k of keyframes) {
    for (const j of [1, 2, 3]) {
      const t = (k - j) / FPS
      const first = frameIndices(src, ['-ss', String(t)], ['-frames:v', '1'])[0]
      if (first !== k - j) atRisk.push({ t, lost: first - (k - j) })
    }
  }
  // The instant that loses the most frames on each side of the preroll.
  const worst = (rs) => rs.reduce((w, r) => (!w || r.lost > w.lost ? r : w), null)
  const early = worst(atRisk.filter((r) => r.t < 2))
  const deep = worst(atRisk.filter((r) => r.t > 3))
  assert.ok(early && deep,
    `the fixture has no leading-picture window both before 2 s and after 3 s (found ${JSON.stringify(atRisk)}): `
    + 'x265 did not write an open GOP, so this file would prove nothing')

  fx = { dir: fxDir, src, early, deep, ref: pcm(src) }
  return fx
}

/** One real segment of `item` over [start, start + SEG); returns its output path. */
async function encode(f, start, item, name) {
  const out = path.join(f.dir, `${name}.mp4`)
  await encodeSegment({
    start, end: start + SEG, vw: W, vh: H, fps: FPS, colorSpace: 'sdr_bt709', overlays: [],
    items: [{ type: 'video', src: f.src, trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
      muted: false, hasAudio: true, ...item }],
  }, out)
  return out
}

function assertFrames(out, first, step, what) {
  const got = frameIndices(out)
  const want = Array.from({ length: SEG * FPS }, (_, n) => first + n * step)
  assert.deepEqual(got, want,
    `${what}: the segment must show source frames ${want[0]}..${want.at(-1)} step ${step}; `
    + `got ${got.join(',')} (a seek into leading pictures shows the keyframe first and runs early)`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('a segment that starts mid-clip inside a leading-picture window shows the right frames, audio in sync',
  { skip: SKIP, timeout: 120_000 }, async (t) => {
    const f = fixture()
    const { t: seek, lost } = f.deep
    t.diagnostic(`seek ${seek.toFixed(4)} s: a single input seek there starts ${lost} frame(s) late`)
    // Item from 0 on the timeline, the segment starting at the at-risk instant:
    // actualIn = seekOffset = seek, which splits into -ss 1 or more and a trim.
    const out = await encode(f, seek, { start: 0, end: 7, inPoint: 0 }, 'deep')
    const first = Math.round(seek * FPS)
    assertFrames(out, first, 1, 'speed 1, segment start')

    // The audio was right before the fix and must stay right: the same window
    // of the chirp, at lag 0, as the source decoded with no seek.
    const seg = pcm(out)
    assert.equal(seg.length, SEG * SR * 2, `segment audio must be ${SEG * SR} samples`)
    const from = Math.round(seek * SR)
    let best = 0
    for (let lag = -200; lag <= 200; lag++) {
      if (meanAbsAt(seg, f.ref, from + lag) < meanAbsAt(seg, f.ref, from + best)) best = lag
    }
    const err = meanAbsAt(seg, f.ref, from)
    t.diagnostic(`audio: best lag ${best} samples, mean abs ${err.toFixed(3)} at lag 0`)
    assert.equal(best, 0, 'the audio must start at the seek instant')
    assert.ok(err < 4, `the audio must match the source there, mean abs ${err}`)
  })

test('a clip whose inPoint sits in a leading-picture window, at 2x, shows the right frames',
  { skip: SKIP, timeout: 120_000 }, async () => {
    const f = fixture()
    const { t: seek } = f.deep
    // A speed item: the trim counts source seconds, ahead of the speed setpts.
    const out = await encode(f, 0, { start: 0, end: 3, inPoint: seek, speed: 2 }, 'deep-2x')
    assertFrames(out, Math.round(seek * FPS), 2, 'speed 2, clip inPoint')
  })

test('a seek inside the first 2 s (input seek to 0, then the trim) shows the right frames',
  { skip: SKIP, timeout: 120_000 }, async (t) => {
    const f = fixture()
    const { t: seek } = f.early
    t.diagnostic(`seek ${seek.toFixed(4)} s: a single input seek there starts ${f.early.lost} frame(s) late`)
    const out = await encode(f, 0, { start: 0, end: 3, inPoint: seek }, 'early')
    assertFrames(out, Math.round(seek * FPS), 1, 'speed 1, clip inPoint under the preroll')
  })
