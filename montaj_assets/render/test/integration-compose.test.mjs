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
