// render/test/long-gop-seek.integration.test.mjs
//
// A long-GOP source cuts frame-exactly through the real segment encoder.
//
// lib/normalize.py used to re-encode every import whose keyframes sat more than
// 2 s apart, on the belief that the encoder's input seek (`-ss t -i`) "lands on
// the prior keyframe". It does not when ffmpeg transcodes: -accurate_seek is on
// by default, so it decodes from that keyframe and drops every frame before
// `t`. That re-encode cost a 4K60 screen recording (4.17 s GOP) 83 s at import.
// The rule is now a bound on decode cost (MAX_KEYFRAME_INTERVAL_S), and this
// file pins the property it gave up: frame-exact cuts on 5 s GOPs, closed and
// open, H.264 and HEVC, at the instants a keyframe snap would show.
//
// Real ffmpeg, the real encodeSegment (no dry run). Same counter strip as
// open-gop-seek.integration.test.mjs: each frame's display index as 8
// black/white blocks, so a decoded frame names itself exactly.
//
// GATING: a missing libx264 / libx265 fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1 (PV52).

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
const GOP = 150 // frames: a keyframe every 5 s
const DUR = 13
const SR = 48000
const SEG = 0.5

function capabilitySkip() {
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  const reason = !/\blibx265\b/.test(encoders) || !/\blibx264\b/.test(encoders)
    ? `${FFMPEG} lacks libx265 + libx264 (set MONTAJ_FFMPEG)`
    : spawnSync(FFPROBE, ['-version'], { timeout: 10_000 }).status !== 0 ? `${FFPROBE} does not run (set MONTAJ_FFPROBE)` : false
  if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}. Point MONTAJ_FFMPEG/MONTAJ_FFPROBE at the managed build (~/.local/share/montaj/models/ffmpeg is a directory; the binaries are inside), or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
  return reason
}
const SKIP = capabilitySkip()

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Every decoded frame's display index, read from its counter strip. */
function frameIndices(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0',
    '-vf', 'format=gray', '-f', 'rawvideo', 'pipe:1'],
  { encoding: 'buffer', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read of ${file} failed: ${r.stderr}`)
  const px = W * H
  const out = []
  for (let f = 0; (f + 1) * px <= r.stdout.length; f++) {
    let n = 0
    for (let b = 0; b < 9; b++) {
      let sum = 0
      let count = 0
      for (let y = 2; y < 14; y++) {
        for (let x = b * 16 + 4; x < b * 16 + 12; x++) { sum += r.stdout[f * px + y * W + x]; count++ }
      }
      if (sum / count > 128) n |= 1 << b
    }
    out.push(n)
  }
  return out
}

function pcm(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0',
    '-f', 's16le', '-ac', '1', '-ar', String(SR), 'pipe:1'],
  { encoding: 'buffer', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `audio read of ${file} failed: ${r.stderr}`)
  return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 2)
}

function meanAbsAt(seg, ref, from) {
  let sum = 0
  for (let i = 0; i < seg.length; i++) sum += Math.abs(seg[i] - ref[from + i])
  return sum / seg.length
}

function keyframeTimes(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 0, `ffprobe failed: ${r.stderr}`)
  return r.stdout.trim().split('\n').map((l) => l.split(','))
    .filter(([, flags]) => flags.includes('K')).map(([pts]) => Number(pts))
}

// ---------------------------------------------------------------------------
// Fixtures: built on first use, so a skipped file costs nothing
// ---------------------------------------------------------------------------

const VARIANTS = {
  'H.264 closed GOP': ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3',
    '-x264-params', `keyint=${GOP}:min-keyint=${GOP}:scenecut=0`],
  'H.264 open GOP': ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3',
    '-x264-params', `keyint=${GOP}:min-keyint=${GOP}:scenecut=0:open-gop=1`],
  'HEVC open GOP': ['-c:v', 'libx265', '-preset', 'veryfast',
    '-x265-params', `log-level=error:keyint=${GOP}:min-keyint=${GOP}:scenecut=0:open-gop=1`],
}

let dir = null
const built = {}
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function fixture(name) {
  if (built[name]) return built[name]
  dir ??= mkdtempSync(path.join(tmpdir(), 'montaj-longgop-'))
  const src = path.join(dir, `${name.replace(/\W+/g, '-')}.mp4`)
  // Bit b of the frame number is the block at x = 16b..16b+15 over the top 16 rows.
  const counter = "geq=lum='if(lt(Y\\,16)\\,255*mod(floor(N/pow(2\\,floor(X/16)))\\,2)\\,lum(X\\,Y))'"
    + ":cb='cb(X,Y)':cr='cr(X,Y)'"
  ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${DUR},${counter}`,
    '-f', 'lavfi', '-i', `aevalsrc=0.4*sin(2*PI*(300*t+60*t*t)):s=${SR}:d=${DUR}`,
    ...VARIANTS[name], '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])

  const exact = frameIndices(src)
  assert.ok(exact.length >= (DUR - 1) * FPS, `fixture too short: ${exact.length} frames`)
  exact.forEach((n, i) => assert.equal(n, i, `the counter strip misreads source frame ${i} as ${n}`))
  // The fixture must actually be long-GOP, or this file proves nothing.
  const kfs = keyframeTimes(src)
  const gaps = kfs.slice(1).map((k, i) => k - kfs[i])
  assert.ok(gaps.length >= 2 && Math.min(...gaps) >= 4.9,
    `${name}: keyframes must sit 5 s apart, got ${kfs.join(', ')}`)

  built[name] = { src, ref: pcm(src) }
  return built[name]
}

/** One real segment over [start, start + SEG) of a clip placed at 0 with `inPoint`. */
async function encode(f, start, inPoint, name) {
  const out = path.join(dir, `${name}.mp4`)
  await encodeSegment({
    start, end: start + SEG, vw: W, vh: H, fps: FPS, colorSpace: 'sdr_bt709', overlays: [],
    items: [{ type: 'video', src: f.src, trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
      muted: false, hasAudio: true, start: 0, end: DUR, inPoint }],
  }, out)
  return out
}

// Source instants (seconds) a keyframe snap would get wrong: mid-GOP, 1 and 3
// frames before the 5 s keyframe (an open GOP's leading pictures), 1 frame
// after it, and deep in the second GOP.
const CUTS = [2.5, 5 - 1 / FPS, 5 - 3 / FPS, 5 + 1 / FPS, 7.4]

for (const name of Object.keys(VARIANTS)) {
  test(`${name}, 5 s keyframe interval: every cut shows exactly the frames asked for, audio in sync`,
    { skip: SKIP, timeout: 180_000 }, async (t) => {
      const f = fixture(name)
      for (const [i, at] of CUTS.entries()) {
        // Half as a clip inPoint, half as a segment starting mid-clip: the two
        // ways actualIn reaches the seek.
        const asInPoint = i % 2 === 0
        const out = await encode(f, asInPoint ? 0 : at - 1, asInPoint ? at : 1, `${name}-${i}`)
        const first = Math.round(at * FPS)
        const want = Array.from({ length: SEG * FPS }, (_, n) => first + n)
        assert.deepEqual(frameIndices(out), want,
          `${name}, cut at ${at.toFixed(4)} s: the segment must show source frames ${want[0]}..${want.at(-1)}`)

        const seg = pcm(out)
        const from = Math.round(at * SR)
        let best = 0
        for (let lag = -200; lag <= 200; lag++) {
          if (meanAbsAt(seg, f.ref, from + lag) < meanAbsAt(seg, f.ref, from + best)) best = lag
        }
        t.diagnostic(`${name} cut ${at.toFixed(4)} s: frames ${want[0]}..${want.at(-1)} exact, audio lag ${best}`)
        assert.equal(best, 0, `${name}, cut at ${at.toFixed(4)} s: the audio must start at the cut`)
      }
    })
}
