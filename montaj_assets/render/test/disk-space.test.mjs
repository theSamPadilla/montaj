// render/test/disk-space.test.mjs
//
// §128: a render that will not fit on disk fails with `insufficient_disk` and a
// sentence that says how much to free, before it starts when that is certain,
// and the same way when it runs out mid-way. disk-space.js is pure: statfs and
// stat are injected here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateRenderDisk, checkDiskSpace, insufficientDiskMessage, isDiskFull, diskFailure, dirBytes, spaceToFreeGB,
  videoBytesPerSecond, TMP_BYTES_PER_WORKER, BUNDLE_BYTES, SEGMENT_PCM_BYTES_PER_SECOND, EXPORT_AAC_BYTES_PER_SECOND,
  OUTPUT_FLOOR_BYTES_PER_SECOND, FFV1_DENSE_BYTES_PER_PIXEL, FFV1_CAPTION_BYTES_PER_PIXEL, FFV1_SPARSE_BYTES_PER_PIXEL,
  PRORES_4444_BITS_PER_PIXEL, DISK_MARGIN,
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
  width: 1080, height: 1920, captureScale: 1, workerCount: 12, durationSeconds: 47.2,
}

test('the lower bound stays under what the measured render really used', () => {
  const { lower } = estimateRenderDisk(MEASURED)
  // Measured peaks: 468 MB in TMPDIR, 306 MB new in the project.
  assert.ok(lower.tmpBytes > 0 && lower.tmpBytes < 468e6, `tmp lower bound ${lower.tmpBytes}`)
  assert.ok(lower.projectBytes > 0 && lower.projectBytes < 306e6, `project lower bound ${lower.projectBytes}`)
})

test('the TMPDIR need is a small per-worker constant plus a bundle per segment: it no longer scales with frames or chunk size', () => {
  // Overlay frames stream into ffmpeg (§131), so TMPDIR holds only each worker's
  // Chrome profile. MEASURED in Task 6, a 60 s 1080x1920 captioned project, 12
  // workers: 132 MB peak, about 121 MB of it profiles, so about 10 MB a worker.
  assert.equal(TMP_BYTES_PER_WORKER, 10e6)
  const minute = estimateRenderDisk({ ...MEASURED, segments: [{ frames: 1800, sparse: true }], durationSeconds: 60 })
  const tenMinutes = estimateRenderDisk({ ...MEASURED, segments: [{ frames: 18000, sparse: true }], durationSeconds: 600 })
  assert.equal(tenMinutes.expected.tmpBytes, minute.expected.tmpBytes)
  assert.equal(tenMinutes.lower.tmpBytes, minute.lower.tmpBytes)
  assert.equal(tenMinutes.expected.tmpBytes, 12 * 10e6 + BUNDLE_BYTES)
  assert.ok(tenMinutes.lower.tmpBytes < tenMinutes.expected.tmpBytes)
  assert.ok(tenMinutes.expected.tmpBytes < 200e6, 'not the 1.5 GB the PNG frames needed')
  // The project's disk still grows with the video.
  assert.ok(tenMinutes.expected.projectBytes > 9 * minute.expected.projectBytes)
  assert.ok(tenMinutes.lower.projectBytes > 9 * minute.lower.projectBytes)
  // One worker needs a twelfth of the profiles (MEASURED has two segments).
  assert.equal(estimateRenderDisk({ ...MEASURED, workerCount: 1 }).expected.tmpBytes, 10e6 + 2 * BUNDLE_BYTES)
})

test('each segment keeps a bundle in TMPDIR for the whole render: the TMPDIR need grows with the segment count', () => {
  const seg = { frames: 30, sparse: false }
  const tmp = n => estimateRenderDisk({ ...MEASURED, segments: Array.from({ length: n }, () => seg) })
  assert.equal(BUNDLE_BYTES, 12e6)
  assert.equal(tmp(11).expected.tmpBytes - tmp(1).expected.tmpBytes, 10 * BUNDLE_BYTES)
  assert.ok(tmp(11).lower.tmpBytes > tmp(1).lower.tmpBytes, 'the lower bound counts them too')
  assert.ok(tmp(11).lower.tmpBytes < tmp(11).expected.tmpBytes, 'and keeps half')
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

test('the sentence: the expected need times 1.5 less the free space, in whole GB rounded up, at least 1, no em dash', () => {
  assert.equal(DISK_MARGIN, 1.5)
  // 1.5 x 4 GB - 2 GB = 4 GB.
  assert.equal(insufficientDiskMessage(4e9, 2e9), 'Out of disk space. Free up 4 GB and export again.')
  // 1.5 x 5.2 GB - 2 GB = 5.8 GB, rounded up.
  assert.equal(insufficientDiskMessage(5.2e9, 2e9), 'Out of disk space. Free up 6 GB and export again.')
  // Never below 1, even with room to spare by the estimate.
  assert.equal(insufficientDiskMessage(1e9, 0.99e9), 'Out of disk space. Free up 1 GB and export again.')
  assert.equal(insufficientDiskMessage(1e9, 20e9), 'Out of disk space. Free up 1 GB and export again.')
  // A float a hair over a whole number is not rounded up to the next one.
  assert.equal(spaceToFreeGB(0.1e9 * 30, 0.5e9 * 3), 3)
  for (const [need, free] of [[9e9, 1e9], [12.34e9, 0.01e9], [3e9, 4.4e9]]) {
    const gb = spaceToFreeGB(need, free)
    assert.ok(gb * 1e9 >= 1.5 * need - free, `asks for ${gb} GB, never less than the need with its margin`)
    assert.ok(!insufficientDiskMessage(need, free).includes('\u2014'))
  }
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
  assert.equal(f.message, 'Out of disk space. Free up 6 GB and export again.')
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
  assert.match(f.message, /^Out of disk space\. Free up \d+ GB and export again\.$/)
  const need = est.expected.tmpBytes + est.expected.projectBytes
  assert.ok(Number(f.message.match(/\d+/)[0]) * GB >= 1.5 * need - 0.1e9, 'never less than the expected need with its margin')
})

test('the short disk is the one furthest from its need with the margin, so neither disk is undercounted', () => {
  const est = { lower: { tmpBytes: 1, projectBytes: 1 }, expected: { tmpBytes: 2 * GB, projectBytes: 10 * GB } }
  const f = diskFailure({
    phase: 'mid-render', estimate: est,
    check: { short: null, volumes: [
      { path: '/tmp', needBytes: 2 * GB, freeBytes: 0.5 * GB },        // 1.5 x 2 - 0.5 = 2.5 GB short
      { path: '/proj/render', needBytes: 10 * GB, freeBytes: 9 * GB }, // 1.5 x 10 - 9 = 6 GB short
    ] },
  })
  assert.equal(f.extra.path, '/proj/render')
  assert.equal(f.message, 'Out of disk space. Free up 6 GB and export again.')
  assert.equal(f.extra.volumes.length, 2)
})

test('mid-render with no disk reading at all still names the reason', () => {
  const f = diskFailure({ phase: 'mid-render', estimate: null, check: null })
  assert.equal(f.code, 'insufficient_disk')
  assert.equal(f.message, 'Out of disk space. Free up some space and export again.')
})

// ---------------------------------------------------------------------------
// §213: everything the render writes on the project's disk, at its peak
// ---------------------------------------------------------------------------

const PX_4K = 2160 * 3840

test('the export is counted at its own size and frame rate, not the 1080 capture canvas', () => {
  // The capture canvas is always 1080 on its short edge; a 4K export has four
  // times its pixels. The old estimate sized the export from the canvas.
  const base = { segments: [], width: 1080, height: 1920, captureScale: 2, durationSeconds: 60 }
  const hd = estimateRenderDisk({ ...base, output: { width: 1080, height: 1920, fps: 30 } })
  const uhd = estimateRenderDisk({ ...base, output: { width: 2160, height: 3840, fps: 30 } })
  const video = (w, h) => videoBytesPerSecond({ width: w, height: h, fps: 30, colorSpace: 'sdr_bt709' }) * 60
  assert.ok(Math.abs((uhd.expected.projectBytes - hd.expected.projectBytes) - 3 * (video(2160, 3840) - video(1080, 1920))) < 10)
  const fast = estimateRenderDisk({ ...base, output: { width: 2160, height: 3840, fps: 60 } })
  assert.ok(fast.expected.projectBytes > 1.9 * uhd.expected.projectBytes - 3 * 60 * (SEGMENT_PCM_BYTES_PER_SECOND + EXPORT_AAC_BYTES_PER_SECOND))
})

test('one compose: its video segments (video and PCM audio) and the export twice', () => {
  const out = { width: 2160, height: 3840, fps: 24 }
  const est = estimateRenderDisk({ segments: [], width: 1080, height: 1920, durationSeconds: 100, output: out, passes: ['hdr_hlg'] })
  const video = videoBytesPerSecond({ ...out, colorSpace: 'hdr_hlg' }) * 100
  const exportBytes = video + EXPORT_AAC_BYTES_PER_SECOND * 100
  const segments = video + SEGMENT_PCM_BYTES_PER_SECOND * 100
  assert.equal(est.expected.projectBytes, Math.round(segments + 2 * exportBytes))
  // PCM is exact (48 kHz, 16-bit, stereo), so the lower bound counts it too.
  assert.equal(SEGMENT_PCM_BYTES_PER_SECOND, 192000)
  assert.equal(est.lower.projectBytes, Math.round(SEGMENT_PCM_BYTES_PER_SECOND * 100 + 2 * OUTPUT_FLOOR_BYTES_PER_SECOND * 100))
})

test('--export both: the HDR export stays on disk while the SDR one is composed', () => {
  const out = { width: 2160, height: 3840, fps: 30 }
  const base = { segments: [], width: 1080, height: 1920, durationSeconds: 60, output: out }
  const one = estimateRenderDisk({ ...base, passes: ['hdr_hlg'] })
  const both = estimateRenderDisk({ ...base, passes: ['hdr_hlg', 'sdr_bt709'] })
  const hdrExport = videoBytesPerSecond({ ...out, colorSpace: 'hdr_hlg' }) * 60 + EXPORT_AAC_BYTES_PER_SECOND * 60
  const sdrVideo = videoBytesPerSecond({ ...out, colorSpace: 'sdr_bt709' }) * 60
  const sdrPeak = hdrExport + (sdrVideo + SEGMENT_PCM_BYTES_PER_SECOND * 60) + 2 * (sdrVideo + EXPORT_AAC_BYTES_PER_SECOND * 60)
  assert.equal(both.expected.projectBytes, Math.round(Math.max(one.expected.projectBytes, sdrPeak)))
  assert.ok(both.lower.projectBytes > one.lower.projectBytes)
})

test('a segment joined from chunks is on disk twice while it is joined (renderer.js concatChunks)', () => {
  const seg = { frames: 3000, sparse: false }
  const base = { segments: [seg], width: 1080, height: 1920, captureScale: 2, durationSeconds: 100, output: { width: 2160, height: 3840, fps: 30 } }
  const whole = estimateRenderDisk({ ...base, chunkFrames: 3000 })     // one chunk: nothing joined
  const chunked = estimateRenderDisk({ ...base, chunkFrames: 250 })
  const ffv1 = 3000 * PX_4K * FFV1_DENSE_BYTES_PER_PIXEL
  // The join comes before compose, so the peak is the larger of the two; here
  // the joined overlay (5 GB) outweighs the compose (1.5 GB).
  assert.ok(whole.expected.projectBytes < 1.4 * ffv1)
  assert.equal(chunked.expected.projectBytes, Math.round(2 * ffv1))
  // Only the largest joined segment counts twice: they are joined one after another.
  const two = estimateRenderDisk({ ...base, segments: [seg, { frames: 600, sparse: false }], chunkFrames: 250 })
  assert.equal(two.expected.projectBytes - chunked.expected.projectBytes, Math.round(600 * PX_4K * FFV1_DENSE_BYTES_PER_PIXEL))
})

test('the 4K export that ran out at 4.66 GB expected: the estimate now covers its measured peak', () => {
  // MEASURED from the files it left (2026-10-11): a 102.5 s 2160x3840 24 fps
  // HLG project, one full-length opaque overlay joined from chunks (3.79 GB)
  // and captions (0.16 GB). Its chunks and the joined file were on disk
  // together: 3.79 + 3.79 + 0.16 = 7.74 GB, before any compose. The old
  // estimate said 4.66 GB expected; the disk had 4.70 GB free.
  const frames = Math.round(102.5 * 24)
  const est = estimateRenderDisk({
    segments: [{ frames, sparse: false }, { frames, sparse: true }],
    width: 1080, height: 1920, captureScale: 2, workerCount: 12, chunkFrames: Math.ceil(frames / 12),
    durationSeconds: 102.5, output: { width: 2160, height: 3840, fps: 24 }, passes: ['hdr_hlg'],
  })
  const measuredPeak = 3.79e9 + 3.79e9 + 0.16e9
  assert.ok(est.expected.projectBytes + est.expected.tmpBytes > measuredPeak, `expected ${est.expected.projectBytes}`)
  assert.ok(est.expected.projectBytes < 1.25 * measuredPeak, 'and stays a realistic figure')
  assert.ok(est.lower.projectBytes < measuredPeak / 4, 'the lower bound still refuses only a certain failure')
  // On the disk it had, the sentence asks for at least what was missing.
  const gb = spaceToFreeGB(est.expected.projectBytes + est.expected.tmpBytes, 4.70e9)
  assert.ok(gb * 1e9 >= measuredPeak - 4.70e9)
})

test('the lower bound stays under every rate measured at 4K', () => {
  // MEASURED 2026-10-11 at 2160x3840: a caption track 0.0032 bytes per pixel,
  // the sparsest transparent overlay 0.0082.
  assert.ok(FFV1_SPARSE_BYTES_PER_PIXEL < 0.0032)
  const frames = Math.round(74.833 * 24)
  const { lower } = estimateRenderDisk({ segments: [{ frames, sparse: true }], width: 1080, height: 1920, captureScale: 2, durationSeconds: 74.833 })
  const measuredCaptions = 47.86e6   // that track's file
  assert.ok(lower.projectBytes - SEGMENT_PCM_BYTES_PER_SECOND * 74.833 - 2 * OUTPUT_FLOOR_BYTES_PER_SECOND * 74.833 < measuredCaptions)
  assert.ok(FFV1_CAPTION_BYTES_PER_PIXEL > 0.0091 && FFV1_DENSE_BYTES_PER_PIXEL >= 0.19, 'expected rates sit above the bulk of what was measured')
})

test('masters, audio-strip copies and cutouts count in full when expected; the lower bound counts only what is certain', () => {
  const base = { segments: [], width: 1080, height: 1920, durationSeconds: 0 }
  const master = { durationSeconds: 120, width: 3840, height: 2160, fps: 60, colorSpace: 'sdr_bt709' }
  const cutout = { durationSeconds: 10, width: 1920, height: 1080, fps: 30 }
  const none = estimateRenderDisk(base)
  const est = estimateRenderDisk({ ...base, masters: [master], copies: [{ bytes: 4e8 }], cutouts: [cutout] })
  const masterBytes = videoBytesPerSecond(master) * 120 + EXPORT_AAC_BYTES_PER_SECOND * 120
  const cutoutBytes = PRORES_4444_BITS_PER_PIXEL * 1920 * 1080 * 30 * 10 / 8
  assert.equal(est.expected.projectBytes - none.expected.projectBytes, Math.round(masterBytes + 4e8 + cutoutBytes))
  // remove_bg writes its video-only pass to TMPDIR first.
  assert.equal(est.expected.tmpBytes, Math.round(Math.max(none.expected.tmpBytes, cutoutBytes)))
  // Lower: a master at the floor rate, half of each copy (a stream copy minus the streams it drops).
  assert.equal(est.lower.projectBytes - none.lower.projectBytes, Math.round(120 * OUTPUT_FLOOR_BYTES_PER_SECOND + 2e8))
  assert.equal(est.lower.tmpBytes, none.lower.tmpBytes)
})

test('the space an earlier render left behind counts as free on the project\'s disk', () => {
  const est = { tmpBytes: 1 * GB, projectBytes: 5 * GB }
  const free = 4096 * 1e6   // whole blocks, as fakeDisk reports them
  const one = checkDiskSpace({ tmpDir: '/tmp', projectDir: '/proj/render', estimate: est, reclaimBytes: 3 * GB, ...fakeDisk({ '/tmp': free, '/proj/render': free }) })
  assert.equal(one.volumes[0].freeBytes, free + 3 * GB)
  assert.equal(one.short, null)
  const two = checkDiskSpace({
    tmpDir: '/tmp', projectDir: '/proj/render', estimate: est, reclaimBytes: 3 * GB,
    ...fakeDisk({ '/tmp': free, '/proj/render': free }, { '/tmp': 1, '/proj/render': 2 }),
  })
  assert.deepEqual(two.volumes.map((v) => v.freeBytes), [free, free + 3 * GB], 'reclaimed on the project\'s disk only')
})

test('a directory that does not exist yet is measured at its nearest existing parent', () => {
  // An estimate creates nothing, so a project's render/ may not exist.
  const seen = []
  const r = checkDiskSpace({
    tmpDir: '/tmp', projectDir: '/proj/new/render', estimate: { tmpBytes: 1, projectBytes: 1 },
    statfs: (dir) => { seen.push(dir); return { bavail: 1000, bsize: 4096 } },
    stat: (dir) => {
      if (dir === '/tmp' || dir === '/proj') return { dev: 1 }
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    },
  })
  assert.deepEqual(seen, ['/tmp', '/proj'])
  assert.equal(r.volumes[0].path, '/proj/new/render', 'reported under the path asked for')
  assert.equal(r.volumes[0].freeBytes, 4096000)
})

test('dirBytes sums the files under a directory, and a missing one is empty', () => {
  const tree = {
    '/r/segments': [{ name: 'a.mkv', file: 100 }, { name: 'sub', dir: true }, { name: 'link', link: true }],
    '/r/segments/sub': [{ name: 'b.mkv', file: 23 }],
  }
  const readdir = (dir) => {
    if (!tree[dir]) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return tree[dir].map((e) => ({ name: e.name, isDirectory: () => !!e.dir, isFile: () => e.file != null }))
  }
  const sizes = { '/r/segments/a.mkv': 100, '/r/segments/sub/b.mkv': 23 }
  const lstat = (p) => ({ size: sizes[p] })
  assert.equal(dirBytes('/r/segments', { readdir, lstat }), 123)
  assert.equal(dirBytes('/r/nothing', { readdir, lstat }), 0)
})
