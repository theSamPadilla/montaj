// render/test/audio-timestamp-fill.integration.test.mjs
//
// A clip whose decoded audio samples are fewer than its timestamps claim stays
// in sync with its picture, and every segment's audio is exactly its duration.
//
// Such a clip looks clean: equal audio and video durations, and no packet gaps
// (an mp4 packet's duration is the distance to the next one). The segment's PCM
// track keeps no timestamps, though, so before the fix the holes were squeezed
// out at the mux: the sound ran ahead of the picture by the sum of the holes,
// each clip came back in sync at the next cut, the join left a hole at every
// cut, and the export's audio ended short of its video (encode-segment.js
// AUDIO_FILL_BY_TIMESTAMP has the measured numbers).
//
// Real ffmpeg, the real compose() (planSegments, encodeSegmentGroup, the
// concat join). One timeline of three clips, butt-joined, each with a white
// frame and a 1 kHz beep at every half second past a whole one (k + 0.5 s) of
// its own timeline. Not at k: an item read from inPoint 0 is input-seeked
// (`-ss 0`), which starts the AAC decoder without its priming packet and
// garbles the clip's first ~700 samples before and after this fix alike, so a
// beep at 0 s would measure that instead:
//   - clean: samples match timestamps. Its segment PCM must be the samples
//     its decoder gives for the same read, byte for byte (the fill never
//     engages).
//   - dropped: every 16th AAC packet removed, the rest keep their timestamps
//     (a 21.3 ms hole each). Filled with silence, so within 2 ms.
//   - stretched: packets stamped 1.5% further apart than the samples they
//     hold (clock drift). Stretched away; soft compensation settles at
//     drift x 1 s behind (15 ms here), so within 20 ms, and with no zero runs
//     inside a beep (a hard fill there would click).
//
// GATING: needs libx264, the aac encoder and the noise/setts bitstream filters
// (MONTAJ_FFMPEG picks the binary). A missing capability fails unless
// MONTAJ_TEST_ALLOW_MISSING_CAPS=1.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { compose } from '../compose.js'

const W = 160
const H = 96
const FPS = 30
const SR = 48000
const BEEP = 1440 // samples: 30 ms
const DROP_EVERY = 16 // packets; the dropped ones (n mod 16 == 13) miss every beep
const STRETCH = 1.015 // timestamp / sample ratio
const CLIPS = [
  { name: 'clean', dur: 4, tol: 0.002 },
  { name: 'dropped', dur: 6, tol: 0.002 },
  { name: 'stretched', dur: 6, tol: 0.020 },
]

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

function capabilityReason() {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/\blibx264\b/.test(enc) || !/^\s*A\S*\s+aac\b/m.test(enc)) return `${FFMPEG} lacks libx264 or aac (set MONTAJ_FFMPEG)`
  const bsfs = spawnSync(FFMPEG, ['-hide_banner', '-bsfs'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/^noise$/m.test(bsfs) || !/^setts$/m.test(bsfs)) return `${FFMPEG} lacks the noise or setts bitstream filter`
  if (spawnSync(FFPROBE, ['-version'], { timeout: 10_000 }).status !== 0) return `${FFPROBE} does not run (set MONTAJ_FFPROBE)`
  return false
}
function capabilitySkip() {
  const reason = capabilityReason()
  if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}, or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
  return reason
}
const SKIP = capabilitySkip()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), 'montaj-audio-fill-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
}

function probe(args) {
  const r = spawnSync(FFPROBE, ['-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`)
  return r.stdout
}

/** A beep every `period` samples from period/2 on, stereo, `n` samples long. */
function beeps(period, n) {
  const h = Math.round(period / 2)
  const e = `if(gte(n\\,${h})*lt(mod(n-${h}\\,${period})\\,${BEEP})\\,0.5*sin(2*PI*1000*n/${SR})\\,0)`
  return `aevalsrc=exprs='${e}|${e}':s=${SR}:n=1024,atrim=end_sample=${n}`
}

/** Black, with one white frame at every k + 0.5 s. */
function flashes(dur) {
  return `color=black:s=${W}x${H}:r=${FPS}:d=${dur},` +
    `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n\\,${FPS})\\,${FPS / 2})',format=yuv420p`
}

function makeClip({ name, dur }) {
  const out = path.join(dir, `${name}.mp4`)
  const video = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
  const audio = ['-c:a', 'aac', '-b:a', '128k', '-ar', String(SR), '-ac', '2']
  if (name === 'stretched') {
    // The beeps are 1 s apart in TIMESTAMPS, so 1 s / STRETCH apart in samples.
    const period = Math.round(SR / STRETCH)
    const m4a = path.join(dir, 'stretched-audio.m4a')
    ff(['-f', 'lavfi', '-i', beeps(period, dur * period), ...audio, m4a])
    const silentVideo = path.join(dir, 'stretched-video.mp4')
    ff(['-f', 'lavfi', '-i', flashes(dur), ...video, silentVideo])
    ff(['-i', silentVideo, '-i', m4a, '-map', '0:v', '-map', '1:a', '-c', 'copy',
      '-bsf:a', `setts=pts=PTS*${STRETCH}:dts=DTS*${STRETCH}:duration=DURATION*${STRETCH}`, out])
    return out
  }
  const clean = name === 'clean' ? out : path.join(dir, `${name}-src.mp4`)
  ff(['-f', 'lavfi', '-i', flashes(dur), '-f', 'lavfi', '-i', beeps(SR, dur * SR), ...video, ...audio, clean])
  if (name === 'dropped') {
    ff(['-i', clean, '-c', 'copy', '-bsf:a', `noise=drop='eq(mod(n\\,${DROP_EVERY})\\,13)'`, out])
  }
  return out
}

/**
 * Stereo s16 PCM of a file's first audio stream. `byPts` lays samples at their
 * timestamps; `seek0` reads it the way the segment encoder reads a clip from
 * inPoint 0 (`-ss 0` on the input).
 */
function pcm(file, { byPts = false, seek0 = false } = {}) {
  const r = spawnSync(FFMPEG, ['-v', 'error', ...(seek0 ? ['-ss', '0'] : []), '-i', file, '-map', '0:a:0',
    ...(byPts ? ['-af', 'aresample=async=1:min_hard_comp=0:first_pts=0'] : []),
    '-f', 's16le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 28, timeout: 60_000 })
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`)
  return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 2)
}

/** [first, last] loud sample index of every beep (left channel). */
function beepSpans(samples) {
  const out = []
  for (let i = 0; i < samples.length; i += 2) {
    if (Math.abs(samples[i]) <= 3000) continue
    const at = i / 2
    if (out.length && at - out[out.length - 1][1] <= 0.2 * SR) out[out.length - 1][1] = at
    else out.push([at, at])
  }
  return out
}
const beepOnsets = (samples) => beepSpans(samples).map(([first]) => first)

/** Presentation time of every white frame of the first video stream. */
function flashTimes(file) {
  const pts = probe(['-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file])
    .split('\n').map((s) => s.replace(/,+$/, '')).filter(Boolean).map(Number)
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough',
    '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28, timeout: 60_000 })
  const frames = r.stdout.length / 144
  const times = []
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let k = 0; k < 144; k++) sum += r.stdout[f * 144 + k]
    if (sum / 144 > 128) times.push(pts[f])
  }
  return times
}

function streamDuration(file, stream) {
  return Number(probe(['-select_streams', stream, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file]).trim())
}

// ---------------------------------------------------------------------------
// One render, shared by every assertion
// ---------------------------------------------------------------------------

let rendered = null
async function render() {
  if (rendered) return rendered
  let t = 0
  const videoItems = CLIPS.map((c, i) => {
    const item = {
      id: c.name, type: 'video', trackIdx: 0, src: makeClip(c), start: t, end: t + c.dur,
      inPoint: 0, outPoint: c.dur, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false,
    }
    c.start = t
    c.segment = i
    t += c.dur
    return item
  })
  const outputPath = path.join(dir, 'out.mp4')
  const keep = process.env.MONTAJ_KEEP_SEGMENTS
  process.env.MONTAJ_KEEP_SEGMENTS = '1'
  try {
    await compose({
      projectJson: { settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709' }, audio: { tracks: [] } },
      puppeteerSegments: [], imageItems: [], videoItems, outputPath,
    })
  } finally {
    if (keep === undefined) delete process.env.MONTAJ_KEEP_SEGMENTS
    else process.env.MONTAJ_KEEP_SEGMENTS = keep
  }
  const segDir = `${outputPath}.segments`
  const segments = readdirSync(segDir).filter((f) => /^seg-\d+\.mp4$/.test(f)).sort().map((f) => path.join(segDir, f))
  rendered = { outputPath, segments, videoItems }
  return rendered
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the fixtures are what they claim: in sync by timestamp, short in samples, clean-looking', { skip: SKIP }, async () => {
  const { videoItems } = await render()
  for (const [i, c] of CLIPS.entries()) {
    const src = videoItems[i].src
    // Looks clean: the container's audio and video durations agree.
    assert.ok(Math.abs(streamDuration(src, 'a:0') - c.dur) < 0.01, `${c.name}: container audio duration`)
    const samples = pcm(src).length / 2
    if (c.name === 'clean') assert.ok(samples >= c.dur * SR, `${c.name}: decodes its full length`)
    else assert.ok(samples < c.dur * SR * 0.99, `${c.name}: should decode short (${samples} samples), or it proves nothing`)
    // ...and the source itself is in sync by timestamp.
    const onsets = beepOnsets(pcm(src, { byPts: true })).map((s) => s / SR)
    for (const f of flashTimes(src)) {
      const near = Math.min(...onsets.map((o) => Math.abs(o - f)))
      assert.ok(near < c.tol, `${c.name} source: beep ${near * 1000} ms from its flash at ${f}s`)
    }
  }
})

test('each segment\'s audio is exactly its duration in samples', { skip: SKIP }, async () => {
  const { segments } = await render()
  assert.equal(segments.length, CLIPS.length)
  for (const c of CLIPS) {
    const samples = pcm(segments[c.segment]).length / 2
    assert.equal(samples, c.dur * SR, `${c.name} segment: ${samples} samples for ${c.dur}s`)
  }
})

test('the export\'s audio is as long as its video, with no timestamp jumps at the cuts', { skip: SKIP }, async () => {
  const { outputPath } = await render()
  const v = streamDuration(outputPath, 'v:0')
  const a = streamDuration(outputPath, 'a:0')
  assert.ok(Math.abs(a - v) < 0.001, `audio ${a}s vs video ${v}s`)
  const pts = probe(['-select_streams', 'a:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', outputPath])
    .split('\n').map((s) => s.replace(/,+$/, '')).filter(Boolean).map(Number)
  const jumps = []
  for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] !== 1024) jumps.push(`${pts[i - 1] / SR}s +${pts[i] - pts[i - 1]}`)
  assert.deepEqual(jumps, [], 'audio packets must follow each other with no hole')
})

test('every beep lands on its flash, by timestamp', { skip: SKIP }, async () => {
  const { outputPath } = await render()
  const onsets = beepOnsets(pcm(outputPath, { byPts: true })).map((s) => s / SR)
  const flashes = flashTimes(outputPath)
  assert.equal(flashes.length, CLIPS.reduce((n, c) => n + c.dur, 0))
  const late = []
  for (const f of flashes) {
    const c = CLIPS.findLast((x) => f >= x.start - 1e-6)
    const off = onsets.reduce((best, o) => (Math.abs(o - f) < Math.abs(best) ? o - f : best), Infinity)
    if (Math.abs(off) > c.tol) late.push(`${c.name} @${f}s: ${(off * 1000).toFixed(1)} ms`)
  }
  assert.deepEqual(late, [], 'beeps off their flashes')
})

test('the stretched clip is stretched, not filled: no zero runs inside its beeps', { skip: SKIP }, async () => {
  const { segments } = await render()
  const c = CLIPS.find((x) => x.name === 'stretched')
  const s = pcm(segments[c.segment])
  const runs = []
  for (const [first, last] of beepSpans(s)) {
    let run = 0
    for (let i = first + 48; i < last - 48; i++) {
      run = s[2 * i] === 0 && s[2 * i + 1] === 0 ? run + 1 : 0
      if (run >= 4) { runs.push(first / SR); break }
    }
  }
  assert.deepEqual(runs, [], 'zero runs inside beeps (a hard fill where a stretch belongs clicks)')
})

test('a clean clip\'s audio is untouched: its segment PCM is its decoder\'s own samples', { skip: SKIP }, async () => {
  const { segments, videoItems } = await render()
  const c = CLIPS.find((x) => x.name === 'clean')
  const seg = pcm(segments[c.segment])
  const src = pcm(videoItems[CLIPS.indexOf(c)].src, { seek0: true }).subarray(0, c.dur * SR * 2)
  assert.equal(seg.length, src.length)
  assert.ok(Buffer.from(seg.buffer, seg.byteOffset, seg.byteLength)
    .equals(Buffer.from(src.buffer, src.byteOffset, src.byteLength)), 'clean segment PCM differs from its source')
})
