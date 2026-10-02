// render/test/short-segments.integration.test.mjs
//
// Sam's 2026-10-01 export died on a 2-frame segment. An agent built a zoom as
// 12 consecutive 2-frame b-roll clips, so the planner made a run of 2-frame and
// 1-frame segments. libx265 reads an uninitialised value for the DTS of any
// encode of 2 frames or fewer (MIN_SEGMENT_FRAMES), and on seg-0017 the mp4
// muxer rejected it ("pts/dts pair unsupported"): ffmpeg wrote the audio, no
// video, and the export failed. Whether it fails is down to heap contents, so
// the encode cannot be made to fail on demand. What is asserted instead is the
// invariant that removes the read: no segment the encoder writes is shorter
// than 3 frames, with every tiny clip's frames still on screen. Plus the two
// guards that make a bad segment fail loudly, by name, wherever it comes from.
//
// Real ffmpeg, no Chromium. The HDR case runs compose from a child process
// whose cwd is a temp dir, with an absolute output path as render.js resolves
// it, because production never runs from the render dir (serve spawns from
// MONTAJ_ROOT) and this suite always does.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { compose } from '../compose.js'
import { assertSegmentHasVideo, assertSegmentsJoinable } from '../segment-check.js'
import { samShape } from './fixtures/short-segment-run.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const W = 180
const H = 320
const FPS = 30
const DUR = 2.4

const tmp = mkdtempSync(path.join(tmpdir(), 'montaj-short-seg-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

function probe(file, entries, select = 'v:0') {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', select, '-count_packets',
    '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).streams ?? []
}

const videoFrames = file => Number(probe(file, 'stream=nb_read_packets')[0]?.nb_read_packets ?? 0)

/** A moving test picture (so a dropped or wrong frame shows), with a tone on the base clip. */
function sources(colorSpace) {
  const hdr = colorSpace === 'hdr_hlg'
  const enc = hdr
    ? ['-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le',
       '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc']
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']
  const base = path.join(tmp, `base-${colorSpace}.mp4`)
  ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}:duration=4`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    ...enc, '-c:a', 'aac', '-shortest', base])
  const broll = path.join(tmp, `broll-${colorSpace}.mp4`)
  ff(['-f', 'lavfi', '-i', `testsrc=size=320x180:rate=${FPS}:duration=4`, ...enc, broll])
  return { base, broll }
}

function project(colorSpace, { zooms = 12 } = {}) {
  const { base, broll } = sources(colorSpace)
  const transfer = colorSpace === 'hdr_hlg' ? 'arib-std-b67' : 'bt709'
  const videoItems = samShape({ base, broll, zooms }).map(it => ({
    offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false, ...it,
    hasAudio: it.src === base, colorTransfer: transfer,
    probedWidth: it.src === base ? W : 320, probedHeight: it.src === base ? H : 180, probedAlpha: false,
  }))
  return {
    projectJson: { settings: { resolution: [W, H], fps: FPS, colorSpace }, audio: { tracks: [] } },
    puppeteerSegments: [], imageItems: [], videoItems, videoWidth: W, videoHeight: H, colorSpace,
  }
}

/** Every segment file compose kept, with its video frame count. */
function keptSegments(outputPath) {
  const dir = outputPath + '.segments'
  return readdirSync(dir).filter(f => /^seg-\d{4}\.mp4$/.test(f)).sort()
    .map(f => ({ name: f, frames: videoFrames(path.join(dir, f)) }))
}

/** Per-frame PSNR (dB) of b against a; Infinity for an identical frame. */
function psnrPerFrame(a, b) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', a, '-i', b,
    '-lavfi', '[0:v][1:v]psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim().split('\n').map(l => {
    const v = /psnr_avg:(\S+)/.exec(l)?.[1]
    return v === 'inf' ? Infinity : Number(v)
  })
}

test("HDR (libx265): Sam's run of 2-frame clips exports, and no segment handed to x265 is under 3 frames", () => {
  const job = project('hdr_hlg')
  const cwd = path.join(tmp, 'hdr-cwd')
  mkdirSync(cwd, { recursive: true })
  const out = path.join(cwd, 'out', 'film.mp4')
  const script = `import { compose } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'compose.js')).href)}
    const job = JSON.parse(process.env.MONTAJ_TEST_JOB)
    await compose({ ...job, outputPath: ${JSON.stringify(out)} })`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, MONTAJ_KEEP_SEGMENTS: '1', MONTAJ_TEST_JOB: JSON.stringify(job) },
  })
  assert.equal(r.status, 0, `compose failed:\n${r.stderr.slice(-3000)}`)

  const segs = keptSegments(out)
  for (const s of segs) assert.ok(s.frames >= 3, `${s.name} reached the encoder with ${s.frames} frame(s)`)
  assert.equal(videoFrames(out), Math.round(DUR * FPS), 'the film keeps every frame')
  const [a] = probe(out, 'stream=duration', 'a:0')
  assert.ok(Math.abs(Number(a.duration) - DUR) < 0.03, `audio runs the whole film (${a.duration}s)`)
})

test("SDR: grouping Sam's run changes no picture, and dropping the tiny clips would have been caught", async () => {
  const job = project('sdr_bt709')
  const grouped = path.join(tmp, 'sdr', 'grouped.mp4')
  const ungrouped = path.join(tmp, 'sdr', 'ungrouped.mp4')
  const noZooms = path.join(tmp, 'sdr', 'no-zooms.mp4')
  process.env.MONTAJ_KEEP_SEGMENTS = '1'
  try {
    await compose({ ...job, outputPath: grouped })
    // The pre-fix path: every planned segment encoded on its own. x264 has no
    // uninitialised DTS, so this is a safe reference for the picture.
    await compose({ ...job, outputPath: ungrouped, _minSegmentFrames: 1 })
  } finally {
    delete process.env.MONTAJ_KEEP_SEGMENTS
  }
  for (const s of keptSegments(grouped)) assert.ok(s.frames >= 3, `${s.name} is ${s.frames} frame(s)`)
  assert.ok(keptSegments(ungrouped).some(s => s.frames < 3), 'the reference really did encode short segments')

  const same = psnrPerFrame(ungrouped, grouped)
  assert.equal(same.length, Math.round(DUR * FPS))
  const worst = Math.min(...same)
  assert.ok(worst >= 35, `grouped film differs from the per-segment film (worst frame ${worst} dB)`)

  // Control: the same check must fail on EVERY zoom frame when the tiny clips
  // are not on screen (measured 9.7 to 11.8 dB, against a worst of 39 dB for
  // the grouped film), so a grouped film missing any one of them fails above.
  await compose({ ...project('sdr_bt709', { zooms: 0 }), outputPath: noZooms })
  const zoomFrames = psnrPerFrame(ungrouped, noZooms).slice(19, 19 + 24)
  assert.equal(zoomFrames.length, 24)
  assert.ok(Math.max(...zoomFrames) < 30, `a zoom frame is indistinguishable without its clip (${Math.max(...zoomFrames)} dB)`)
})

test("assertSegmentHasVideo: seg-0017's shape (2 frames of PCM, no video) fails by name and time range", () => {
  const dir = path.join(tmp, 'check')
  mkdirSync(dir, { recursive: true })
  const audioOnly = path.join(dir, 'seg-0017.mp4')
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(2 / FPS), '-c:a', 'pcm_s16le', audioOnly])
  assert.throws(() => assertSegmentHasVideo(audioOnly, { start: 45.6333, end: 45.7 }),
    e => /seg-0017\.mp4/.test(e.message) && /45\.63-45\.70s/.test(e.message) && /no video stream/.test(e.message))

  const good = path.join(dir, 'seg-0018.mp4')
  ff(['-f', 'lavfi', '-i', `color=black:size=${W}x${H}:rate=${FPS}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', String(2 / FPS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', good])
  assertSegmentHasVideo(good, { start: 45.7, end: 45.7667 })
})

test('assertSegmentsJoinable: a segment with no video, or with other stream params, fails the join by name', () => {
  const dir = path.join(tmp, 'join')
  mkdirSync(dir, { recursive: true })
  const mk = (name, { video = true, w = W } = {}) => {
    const p = path.join(dir, name)
    ff([...(video ? ['-f', 'lavfi', '-i', `color=black:size=${w}x${H}:rate=${FPS}`] : []),
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.2',
      ...(video ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : []), '-c:a', 'pcm_s16le', p])
    return p
  }
  const a = { path: mk('seg-0000.mp4'), start: 0, end: 0.2 }
  const b = { path: mk('seg-0001.mp4', { video: false }), start: 0.2, end: 0.4 }
  const c = { path: mk('seg-0002.mp4'), start: 0.4, end: 0.6 }
  const d = { path: mk('seg-0003.mp4', { w: 240 }), start: 0.6, end: 0.8 }

  assertSegmentsJoinable([a, c])
  assert.throws(() => assertSegmentsJoinable([a, b, c]),
    e => /seg-0001\.mp4/.test(e.message) && /0\.20-0\.40s/.test(e.message) && /no video stream/.test(e.message))
  assert.throws(() => assertSegmentsJoinable([a, c, d]),
    e => /seg-0003\.mp4/.test(e.message) && /0\.60-0\.80s/.test(e.message) && /width/.test(e.message))
})
