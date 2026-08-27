// render/test/integration-compose.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose } from '../compose.js'
import { existsSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'

// Generate test clip if needed
function ensureTestClip(path, duration, w, h) {
  if (existsSync(path)) return
  spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=${w}x${h}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}:sample_rate=48000`,
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', path,
  ], { encoding: 'utf8', timeout: 30_000 })
}

test('compose: single video clip renders to playable MP4', async () => {
  const testClip = '/tmp/montaj-test-clip-v2.mp4'
  const outputPath = '/tmp/montaj-compose-test.mp4'
  ensureTestClip(testClip, 3, 1920, 1080)
  rmSync(outputPath, { force: true })

  await compose({
    projectJson: { settings: { resolution: [1920, 1080], fps: 30 }, audio: { tracks: [] } },
    puppeteerSegments: [],
    imageItems: [],
    videoItems: [{
      id: 'test', type: 'video', trackIdx: 0,
      src: testClip, start: 0, end: 3, inPoint: 0, outPoint: 3,
      offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false,
    }],
    outputPath,
  })

  assert.ok(existsSync(outputPath), 'output file should exist')

  // Verify it's playable
  const probe = spawnSync('ffprobe', ['-v', 'error', outputPath], { encoding: 'utf8' })
  assert.equal(probe.status, 0, 'ffprobe should report no errors')

  rmSync(outputPath, { force: true })
})

test('compose: multiple clips concat without corruption', async () => {
  const clip1 = '/tmp/montaj-test-clip-v2-a.mp4'
  const clip2 = '/tmp/montaj-test-clip-v2-b.mp4'
  const outputPath = '/tmp/montaj-compose-multi.mp4'
  ensureTestClip(clip1, 2, 1920, 1080)
  ensureTestClip(clip2, 2, 1920, 1080)
  rmSync(outputPath, { force: true })

  await compose({
    projectJson: { settings: { resolution: [1920, 1080], fps: 30 }, audio: { tracks: [] } },
    puppeteerSegments: [],
    imageItems: [],
    videoItems: [
      { id: 'a', type: 'video', trackIdx: 0, src: clip1, start: 0, end: 2, inPoint: 0, outPoint: 2, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false },
      { id: 'b', type: 'video', trackIdx: 0, src: clip2, start: 2, end: 4, inPoint: 0, outPoint: 2, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false },
    ],
    outputPath,
  })

  assert.ok(existsSync(outputPath))
  const probe = spawnSync('ffprobe', ['-v', 'error', outputPath], { encoding: 'utf8' })
  assert.equal(probe.status, 0, 'no ffprobe errors on multi-clip concat')

  rmSync(outputPath, { force: true })
})

test('compose encodes segments concurrently when MONTAJ_SEGMENT_WORKERS>1', async () => {
  // Three adjacent clips → >= 3 segments, so a 2-worker pool actually overlaps
  // encodes. compose reads MONTAJ_SEGMENT_WORKERS at module load (default 2),
  // so setting it here documents intent and pins the concurrent path; the
  // final-mp4 assertions match the single/multi-clip tests above.
  const clipA = '/tmp/montaj-test-clip-v2-c1.mp4'
  const clipB = '/tmp/montaj-test-clip-v2-c2.mp4'
  const clipC = '/tmp/montaj-test-clip-v2-c3.mp4'
  const outputPath = '/tmp/montaj-compose-concurrent.mp4'
  ensureTestClip(clipA, 2, 1920, 1080)
  ensureTestClip(clipB, 2, 1920, 1080)
  ensureTestClip(clipC, 2, 1920, 1080)
  rmSync(outputPath, { force: true })

  const prevWorkers = process.env.MONTAJ_SEGMENT_WORKERS
  process.env.MONTAJ_SEGMENT_WORKERS = '2'
  try {
    await compose({
      projectJson: { settings: { resolution: [1920, 1080], fps: 30 }, audio: { tracks: [] } },
      puppeteerSegments: [],
      imageItems: [],
      videoItems: [
        { id: 'a', type: 'video', trackIdx: 0, src: clipA, start: 0, end: 2, inPoint: 0, outPoint: 2, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false },
        { id: 'b', type: 'video', trackIdx: 0, src: clipB, start: 2, end: 4, inPoint: 0, outPoint: 2, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false },
        { id: 'c', type: 'video', trackIdx: 0, src: clipC, start: 4, end: 6, inPoint: 0, outPoint: 2, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false },
      ],
      outputPath,
    })
  } finally {
    if (prevWorkers === undefined) delete process.env.MONTAJ_SEGMENT_WORKERS
    else process.env.MONTAJ_SEGMENT_WORKERS = prevWorkers
  }

  assert.ok(existsSync(outputPath), 'output file should exist')
  const probe = spawnSync('ffprobe', ['-v', 'error', outputPath], { encoding: 'utf8' })
  assert.equal(probe.status, 0, 'no ffprobe errors on concurrent segment encode')

  rmSync(outputPath, { force: true })
})

// ── Leading gaps ────────────────────────────────────────────────────────────
//
// `planSegments` derives boundaries from item/overlay endpoints only, so t=0
// enters the boundary set only when something starts there. Before compose.js
// prepended a black head segment, a timeline whose first clip started at 2s
// simply BEGAN at that clip: the export came out 2s shorter than the timeline
// and every overlay, caption and independently-mixed audio track (all timed
// against absolute timeline time) drifted by exactly the gap.
//
// These assert on DURATION rather than on segment structure on purpose — the
// duration is the thing the user sees disagree with the editor, and it is what
// regresses if the prepend is removed.

function durationOf(path) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ], { encoding: 'utf8' })
  assert.equal(probe.status, 0, 'ffprobe should succeed')
  return parseFloat(probe.stdout.trim())
}

const clipItem = (id, src, start, end) => ({
  id, type: 'video', trackIdx: 0, src, start, end,
  inPoint: 0, outPoint: end - start,
  offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false,
})

test('compose: a leading gap is preserved as black, not dropped', async () => {
  const clip = '/tmp/montaj-test-leadgap.mp4'
  const outputPath = '/tmp/montaj-compose-leadgap.mp4'
  ensureTestClip(clip, 2, 640, 360)
  rmSync(outputPath, { force: true })

  // Timeline: 2s of nothing, then a 2s clip. Total 4s.
  const result = await compose({
    projectJson: { settings: { resolution: [640, 360], fps: 30 }, audio: { tracks: [] } },
    puppeteerSegments: [],
    imageItems: [],
    videoItems: [clipItem('a', clip, 2, 4)],
    outputPath,
  })

  assert.ok(existsSync(outputPath), 'output file should exist')
  // The load-bearing assertion. Pre-fix this was ~2.0 (the gap dropped).
  assert.ok(
    Math.abs(durationOf(outputPath) - 4.0) < 0.2,
    `expected ~4.0s (2s gap + 2s clip), got ${durationOf(outputPath)}s`,
  )
  assert.equal(result.leadingGap, 2, 'compose reports the gap it prepended')

  rmSync(outputPath, { force: true })
})

test('compose: no leading gap is unchanged (no phantom head segment)', async () => {
  const clip = '/tmp/montaj-test-nogap.mp4'
  const outputPath = '/tmp/montaj-compose-nogap.mp4'
  ensureTestClip(clip, 2, 640, 360)
  rmSync(outputPath, { force: true })

  const result = await compose({
    projectJson: { settings: { resolution: [640, 360], fps: 30 }, audio: { tracks: [] } },
    puppeteerSegments: [],
    imageItems: [],
    videoItems: [clipItem('a', clip, 0, 2)],
    outputPath,
  })

  assert.ok(
    Math.abs(durationOf(outputPath) - 2.0) < 0.2,
    `expected ~2.0s, got ${durationOf(outputPath)}s`,
  )
  assert.equal(result.leadingGap, 0, 'no gap reported when content starts at 0')

  rmSync(outputPath, { force: true })
})

test('compose: a gap BETWEEN clips still survives (unchanged behavior)', async () => {
  const clipA = '/tmp/montaj-test-midgap-a.mp4'
  const clipB = '/tmp/montaj-test-midgap-b.mp4'
  const outputPath = '/tmp/montaj-compose-midgap.mp4'
  ensureTestClip(clipA, 2, 640, 360)
  ensureTestClip(clipB, 2, 640, 360)
  rmSync(outputPath, { force: true })

  // 0-2 clip, 2-3 nothing, 3-5 clip. Total 5s. This already worked before the
  // fix (both neighbours contribute boundaries); it is here so a future change
  // to the prepend cannot quietly break the case it was modelled on.
  const result = await compose({
    projectJson: { settings: { resolution: [640, 360], fps: 30 }, audio: { tracks: [] } },
    puppeteerSegments: [],
    imageItems: [],
    videoItems: [clipItem('a', clipA, 0, 2), clipItem('b', clipB, 3, 5)],
    outputPath,
  })

  assert.ok(
    Math.abs(durationOf(outputPath) - 5.0) < 0.2,
    `expected ~5.0s (2s clip + 1s gap + 2s clip), got ${durationOf(outputPath)}s`,
  )
  assert.equal(result.leadingGap, 0, 'a middle gap is not a leading gap')

  rmSync(outputPath, { force: true })
})

// ── Independent audio tracks ────────────────────────────────────────────────
//
// Every fixture above uses `audio: { tracks: [] }`, so until 2026-08-26 the
// mixAudioIntoVideo path had ZERO end-to-end coverage — which is how a bug that
// left the last 24s of a 54s deliverable at -91 dB shipped without a single
// red test. `mix-audio.test.mjs` asserts the filter STRING; this asserts that
// audio actually comes out, because the defining feature of that bug was that
// nothing failed, the level just went to zero.

function ensureTestAudio(path, duration, freq) {
  if (existsSync(path)) return
  spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${duration}:sample_rate=48000`,
    '-c:a', 'aac', '-b:a', '192k', path,
  ], { encoding: 'utf8', timeout: 30_000 })
}

// Mean volume over a window, in dB. Digital silence reports -91.0.
function meanVolumeDb(path, from, to) {
  const probe = spawnSync('ffmpeg', [
    '-hide_banner', '-ss', String(from), '-to', String(to), '-i', path,
    '-vn', '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 60_000 })
  // spawnSync gives stderr: null if the binary can't be spawned at all — guard so
  // that surfaces as this assertion rather than a TypeError on .match.
  const err = probe.stderr ?? ''
  const m = err.match(/mean_volume:\s*(-?[\d.]+) dB/)
  assert.ok(m, `volumedetect produced no mean_volume for ${path}:\n${err.slice(-500)}`)
  return parseFloat(m[1])
}

test('compose: an audio track that starts partway through is audible in the export', async () => {
  const clip       = '/tmp/montaj-test-audiofade-clip.mp4'
  const bedA       = '/tmp/montaj-test-audiofade-a.m4a'
  const bedB       = '/tmp/montaj-test-audiofade-b.m4a'
  const outputPath = '/tmp/montaj-compose-audiofade.mp4'
  ensureTestClip(clip, 10, 640, 360)
  ensureTestAudio(bedA, 10, 440)
  ensureTestAudio(bedB, 10, 880)
  rmSync(outputPath, { force: true })

  // The clip is muted so the ONLY audio in the export comes from audio.tracks —
  // otherwise the video's own soundtrack masks exactly the failure under test.
  // Two beds handing off at 5s, the shape that surfaced the bug: bed B starts
  // offset, with both a fade-in and a fade-out.
  //
  // `outPoint: 5` on both is load-bearing, not tidiness. This file's source
  // window is inPoint/outPoint alone — mix-audio.js never trims on `end` — so
  // an untrimmed bed A would run its full 10s source straight through the 6-9s
  // window and mask bed B's silence, and the test would pass against the
  // unfixed code. Trimming makes that boundary explicit rather than leaving it
  // resting on bed A's fade-out happening to reach zero in time.
  await compose({
    projectJson: {
      settings: { resolution: [640, 360], fps: 30 },
      audio: {
        tracks: [
          { id: 'bedA', src: bedA, start: 0, end: 5,  inPoint: 0, outPoint: 5, volume: 1, fadeOut: 1 },
          { id: 'bedB', src: bedB, start: 5, end: 10, inPoint: 0, outPoint: 5, volume: 1, fadeIn: 0.5, fadeOut: 1 },
        ],
      },
    },
    puppeteerSegments: [],
    imageItems: [],
    videoItems: [{
      id: 'v', type: 'video', trackIdx: 0, src: clip, start: 0, end: 10,
      inPoint: 0, outPoint: 10, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: true,
    }],
    outputPath,
  })

  assert.ok(existsSync(outputPath), 'output file should exist')

  // THE load-bearing assertion. Pre-fix, bed B's fade-out was timed from its own
  // duration (5s) rather than its timeline end (10s) — st = (10-5)-1 = 4 — so it
  // ran 4..5s in stream time and reached zero exactly as B's audio began at 5s.
  // afade=t=out holds zero thereafter: -91 dB (digital silence) across this
  // whole window. Full account: KNOWN-DIVERGENCES D2.
  const offsetLevel = meanVolumeDb(outputPath, 6, 9)
  assert.ok(
    offsetLevel > -40,
    `offset audio track should be audible after its start; got ${offsetLevel} dB ` +
    `(-91 dB means the fade-out was timed against the wrong clock and silenced it)`,
  )

  // A track at the origin already worked — this guards it against the fix.
  const originLevel = meanVolumeDb(outputPath, 1, 4)
  assert.ok(originLevel > -40, `origin audio track should still be audible; got ${originLevel} dB`)

  rmSync(outputPath, { force: true })
})
