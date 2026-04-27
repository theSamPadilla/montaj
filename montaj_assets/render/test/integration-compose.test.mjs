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
