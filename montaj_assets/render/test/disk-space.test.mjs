// render/test/disk-space.test.mjs
//
// §128: a render that will not fit on disk fails with `insufficient_disk` and a
// sentence that says how much to free, before it starts when that is certain,
// and the same way when it runs out mid-way. disk-space.js is pure: statfs and
// stat are injected here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateRenderDisk, checkDiskSpace, insufficientDiskMessage, isDiskFull, diskFailure,
  SPARSE_BYTES_PER_PIXEL,
} from '../disk-space.js'

const GB = 1e9
const fakeDisk = (free, dev = { '/tmp': 1, '/proj/render': 1 }) => ({
  statfs: (dir) => ({ bavail: Math.floor(free[dir] / 4096), bsize: 4096 }),
  stat: (dir) => ({ dev: dev[dir] }),
})

// The 1080x1920 project measured for §128: 47 s, 21 caption segments over the
// whole video (1410 frames) and 11 short overlays (about 900 frames).
const MEASURED = {
  segments: [{ frames: 1410, sparse: true }, { frames: 900, sparse: false }],
  width: 1080, height: 1920, captureScale: 1, subframes: 1, workerCount: 12, chunkSize: 120, durationSeconds: 47.2,
}

test('the lower bound stays under what the measured render really used', () => {
  const { lower } = estimateRenderDisk(MEASURED)
  // Measured peaks: 468 MB in TMPDIR, 306 MB new in the project.
  assert.ok(lower.tmpBytes > 0 && lower.tmpBytes < 468e6, `tmp lower bound ${lower.tmpBytes}`)
  assert.ok(lower.projectBytes > 0 && lower.projectBytes < 306e6, `project lower bound ${lower.projectBytes}`)
})

test('the TMPDIR need grows with the longest overlay, since every worker captures a chunk at once', () => {
  const minute = estimateRenderDisk({ ...MEASURED, segments: [{ frames: 1800, sparse: true }], chunkSize: 150, durationSeconds: 60 })
  const tenMinutes = estimateRenderDisk({ ...MEASURED, segments: [{ frames: 18000, sparse: true }], chunkSize: 1500, durationSeconds: 600 })
  assert.ok(tenMinutes.lower.tmpBytes >= 9 * minute.lower.tmpBytes, 'ten times the captions, about ten times the frames on disk')
  // 18000 sparse 1080x1920 frames, half held at once: the floor of what a real run holds.
  assert.equal(tenMinutes.lower.tmpBytes, Math.round(0.5 * 18000 * 1080 * 1920 * SPARSE_BYTES_PER_PIXEL))
  assert.ok(tenMinutes.expected.tmpBytes > tenMinutes.lower.tmpBytes)
})

test('one disk: TMPDIR and the project share its free space', () => {
  const est = estimateRenderDisk(MEASURED)
  const need = est.lower.tmpBytes + est.lower.projectBytes
  const roomy = checkDiskSpace({ tmpDir: '/tmp', projectDir: '/proj/render', estimate: est.lower, ...fakeDisk({ '/tmp': need + 4096 * 10, '/proj/render': need + 4096 * 10 }) })
  assert.equal(roomy.short, null)
  // Enough for either part alone, not for both.
  const tight = Math.max(est.lower.tmpBytes, est.lower.projectBytes) + 4096
  const short = checkDiskSpace({ tmpDir: '/tmp', projectDir: '/proj/render', estimate: est.lower, ...fakeDisk({ '/tmp': tight, '/proj/render': tight }) })
  assert.ok(short.short, 'the two needs are added on one disk')
  assert.equal(short.short.needBytes, need)
  assert.equal(short.short.path, '/proj/render')
})

test('two disks (Windows paths too): each is checked for its own part, and the short one is named', () => {
  const tmpDir = 'C:\\Users\\me\\AppData\\Local\\Temp'
  const projectDir = 'D:\\Montaj\\clip\\render'
  const est = { tmpBytes: 2 * GB, projectBytes: 0.5 * GB }
  const disk = (free) => ({
    statfs: (dir) => ({ bavail: free[dir] / 4096, bsize: 4096 }),
    stat: (dir) => ({ dev: dir === tmpDir ? 11 : 22 }),
  })
  const tmpShort = checkDiskSpace({ tmpDir, projectDir, estimate: est, ...disk({ [tmpDir]: 1 * GB, [projectDir]: 100 * GB }) })
  assert.deepEqual(tmpShort.short, { path: tmpDir, needBytes: 2 * GB, freeBytes: 1 * GB })
  const projShort = checkDiskSpace({ tmpDir, projectDir, estimate: est, ...disk({ [tmpDir]: 100 * GB, [projectDir]: 0.25 * GB }) })
  assert.deepEqual(projShort.short, { path: projectDir, needBytes: 0.5 * GB, freeBytes: 0.25 * GB })
  assert.equal(projShort.volumes.length, 2)
})

test('a disk check that cannot read the disk never blocks a render', () => {
  const r = checkDiskSpace({
    tmpDir: '/tmp', projectDir: '/proj', estimate: { tmpBytes: 1, projectBytes: 1 },
    statfs: () => { throw Object.assign(new Error('nope'), { code: 'ENOSYS' }) }, stat: () => ({ dev: 1 }),
  })
  assert.equal(r, null)
})

test('the sentence: the space to free in GB, one decimal, rounded up, never below 0.1, no em dash', () => {
  assert.equal(insufficientDiskMessage(5.2e9, 2e9), 'Not enough free space to export. Free up 3.2 GB and try again.')
  assert.equal(insufficientDiskMessage(5.21e9, 2e9), 'Not enough free space to export. Free up 3.3 GB and try again.')
  assert.equal(insufficientDiskMessage(1e9, 0.99e9), 'Not enough free space to export. Free up 0.1 GB and try again.')
  assert.equal(insufficientDiskMessage(1e9, 2e9), 'Not enough free space to export. Free up 0.1 GB and try again.')
  assert.ok(!insufficientDiskMessage(9e9, 1e9).includes('—'))
})

test('ENOSPC is recognised from a Node error and from ffmpeg\'s own sentence', () => {
  assert.equal(isDiskFull(Object.assign(new Error('write failed'), { code: 'ENOSPC' })), true)
  assert.equal(isDiskFull(new Error("ENOSPC: no space left on device, open '/tmp/montaj-frames-captions-c3/frame-000000.png'")), true)
  assert.equal(isDiskFull(new Error('ffmpeg PNG→ffv1 failed (segment captions chunk 2)\n... No space left on device')), true)
  assert.equal(isDiskFull(new Error('ffmpeg failed: Invalid data found when processing input')), false)
  assert.equal(isDiskFull(null), false)
})

test('the failure line: 4c\'s contract, with the estimate and the free space recorded', () => {
  const est = estimateRenderDisk(MEASURED)
  const f = diskFailure({
    phase: 'preflight', estimate: est,
    check: { short: { path: '/proj/render', needBytes: 5.2e9, freeBytes: 2e9 }, volumes: [{ path: '/proj/render', needBytes: 5.2e9, freeBytes: 2e9 }] },
  })
  assert.equal(f.code, 'insufficient_disk')
  assert.equal(f.message, 'Not enough free space to export. Free up 3.2 GB and try again.')
  assert.equal(f.extra.needBytes, 5.2e9)
  assert.equal(f.extra.freeBytes, 2e9)
  assert.equal(f.extra.path, '/proj/render')
  assert.equal(f.extra.phase, 'preflight')
  assert.deepEqual(f.extra.estimate, est)
  const line = JSON.parse(JSON.stringify({ error: f.code, message: f.message, ...f.extra }))
  assert.equal(line.error, 'insufficient_disk')
})

test('mid-render: the failure asks for the expected need on the short disk, measured now', () => {
  const est = estimateRenderDisk(MEASURED)
  const f = diskFailure({
    phase: 'mid-render', estimate: est,
    check: { short: null, volumes: [{ path: '/proj/render', needBytes: est.expected.tmpBytes + est.expected.projectBytes, freeBytes: 0.1e9 }] },
  })
  assert.equal(f.code, 'insufficient_disk')
  assert.equal(f.extra.phase, 'mid-render')
  assert.equal(f.extra.path, '/proj/render')
  assert.match(f.message, /^Not enough free space to export\. Free up \d+\.\d GB and try again\.$/)
})

test('mid-render with no disk reading at all still names the reason', () => {
  const f = diskFailure({ phase: 'mid-render', estimate: null, check: null })
  assert.equal(f.code, 'insufficient_disk')
  assert.equal(f.message, 'Not enough free space to export. Free up some space and try again.')
})
