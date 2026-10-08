// render/disk-space.js
//
// Will this render fit on disk (§128)? A render writes in two places:
//
//   - TMPDIR: a small constant per worker. Overlay and caption frames are NOT
//     written there: each screenshot streams into its chunk's ffmpeg over
//     image2pipe (renderer.js renderChunk, §131), so TMPDIR holds only each
//     worker's Chrome profile and the bundles, whatever the video's length.
//     (Before §131 it held every worker's chunk of PNG frames, which grew with
//     the longest overlay; captions span the whole video.)
//   - the project's disk: the overlay FFV1 chunks and the video segments
//     (render/segments), normalized masters, and the export.
//
// MEASURED 2026-10-07 on a 47 s 1080x1920 project (21 caption segments, 11
// overlays, 12 workers), before streaming: 468 MB peak in TMPDIR, 306 MB new in
// the project. The FFV1 chunk of the captions is about 0.015 bytes per pixel,
// of a dense overlay about 0.2; the export about 5 Mbps.
//
// MEASURED with streaming (§131 Task 6), a 60 s 1080x1920 captioned project, 12
// workers: peak TMPDIR 132 MB (271 MB before, 138 MB of it PNGs); what remains
// is mostly Chrome profiles, about 121 MB for 12 workers, so about 10 MB each.
//
// The preflight refuses only a render that certainly will not fit: the LOWER
// bound counts every frame at the sparse rate and half the workers' chunks on
// disk at once. A render that passes and still runs out mid-way fails with the
// same code, asking for the EXPECTED need, so the user always gets the clear
// reason rather than a generic failure. Both lines carry the estimate and the
// free space, so reports show how good the estimate is.
//
// Pure: statfs and stat are injected, defaulting to node:fs.

import { statfsSync, statSync } from 'node:fs'

const GB = 1e9
const MEASURED_PIXELS = 1080 * 1920

// TMPDIR per worker (a Chrome profile; no frames), measured as above. The
// lower bound takes half, so it stays under what a real run uses.
export const TMP_BYTES_PER_WORKER = 10e6
// Lower bound (the preflight).
export const FFV1_SPARSE_BYTES_PER_PIXEL = 0.01
export const OUTPUT_FLOOR_BYTES_PER_SECOND = 1e6 / 8
// Expected (what a mid-render failure asks for).
export const CAPTION_BYTES_PER_PIXEL = 0.04
export const DENSE_BYTES_PER_PIXEL = 0.65
export const FFV1_CAPTION_BYTES_PER_PIXEL = 0.015
export const FFV1_DENSE_BYTES_PER_PIXEL = 0.2
export const OUTPUT_BYTES_PER_SECOND = 5e6 / 8

/**
 * The disk a render needs, as a lower bound and as an expected figure.
 *
 * @param {object} p
 * @param {Array<{ frames: number, sparse: boolean }>} p.segments  overlay and caption segments; `sparse` for captions
 * @param {number} p.width @param {number} p.height  the capture canvas (renderWidth x renderHeight)
 * @param {number} [p.captureScale]  device pixels per CSS pixel (render.js captureScaleFor)
 * @param {number} [p.subframes]     unused since overlay frames stream (kept for callers)
 * @param {number} [p.workerCount]   browser workers (renderer.js planChunks)
 * @param {number} [p.chunkSize]     unused since overlay frames stream (kept for callers)
 * @param {number} p.durationSeconds the timeline's length
 * @returns {{ lower: {tmpBytes: number, projectBytes: number}, expected: {tmpBytes: number, projectBytes: number} }}
 */
export function estimateRenderDisk({ segments, width, height, captureScale = 1, workerCount = 1, durationSeconds }) {
  const px = width * height * captureScale * captureScale
  const frames = segments.reduce((n, s) => n + s.frames, 0)
  const tmpExpected = Math.max(1, workerCount) * TMP_BYTES_PER_WORKER
  const ffv1Expected = segments.reduce((n, s) => n + s.frames * px * (s.sparse ? FFV1_CAPTION_BYTES_PER_PIXEL : FFV1_DENSE_BYTES_PER_PIXEL), 0)
  const outputScale = (width * height) / MEASURED_PIXELS
  return {
    lower: {
      tmpBytes: Math.round(0.5 * tmpExpected),
      projectBytes: Math.round(frames * px * FFV1_SPARSE_BYTES_PER_PIXEL + 2 * durationSeconds * OUTPUT_FLOOR_BYTES_PER_SECOND),
    },
    expected: {
      tmpBytes: tmpExpected,
      projectBytes: Math.round(ffv1Expected + 2 * durationSeconds * OUTPUT_BYTES_PER_SECOND * outputScale),
    },
  }
}

/**
 * Free space for one estimate (`{ tmpBytes, projectBytes }`): the two needs are
 * added when TMPDIR and the project are on one disk, else each disk is checked
 * for its own part. `short` is the first disk without room, or null. Returns
 * null when a disk cannot be read: the check never blocks a render on its own
 * failure.
 *
 * MONTAJ_TEST_DISK_FREE_BYTES (tests only) replaces every disk's free space.
 */
export function checkDiskSpace({ tmpDir, projectDir, estimate, statfs = statfsSync, stat = statSync }) {
  let tmp, proj
  try {
    tmp = volumeOf(tmpDir, statfs, stat)
    proj = volumeOf(projectDir, statfs, stat)
  } catch {
    return null
  }
  const volumes = tmp.dev === proj.dev
    ? [{ path: projectDir, needBytes: estimate.tmpBytes + estimate.projectBytes, freeBytes: proj.freeBytes }]
    : [
        { path: tmpDir, needBytes: estimate.tmpBytes, freeBytes: tmp.freeBytes },
        { path: projectDir, needBytes: estimate.projectBytes, freeBytes: proj.freeBytes },
      ]
  const short = volumes.find(v => v.freeBytes < v.needBytes) ?? null
  return { short, volumes }
}

function volumeOf(dir, statfs, stat) {
  const fsStats = statfs(dir)
  const override = process.env.MONTAJ_TEST_DISK_FREE_BYTES
  const freeBytes = override ? Number(override) : Number(fsStats.bavail) * Number(fsStats.bsize)
  if (!Number.isFinite(freeBytes)) throw new Error(`unreadable free space for ${dir}`)
  return { dev: stat(dir).dev, freeBytes }
}

/** The user's sentence: the space to free in GB, one decimal, rounded up, at least 0.1. */
export function insufficientDiskMessage(needBytes, freeBytes) {
  const gb = Math.max(0.1, Math.ceil(((needBytes - freeBytes) / GB) * 10) / 10)
  return `Not enough free space to export. Free up ${gb.toFixed(1)} GB and try again.`
}

/** True for a Node ENOSPC error, or an error carrying ENOSPC or ffmpeg's "No space left on device". */
export function isDiskFull(err) {
  if (!err) return false
  if (err.code === 'ENOSPC') return true
  return /ENOSPC|No space left on device/i.test(String(err.message ?? err))
}

/**
 * The `insufficient_disk` failure: `{ code, message, extra }`, where `extra`
 * carries `needBytes`, `freeBytes` and `path` (the short disk) plus the phase,
 * the estimate and every disk checked, for reports.
 *
 * `phase` is 'preflight' (check.short is set) or 'mid-render' (the render ran
 * out: the short disk is the one with the least room left for its expected
 * need). With no reading at all the sentence still names the reason.
 */
export function diskFailure({ phase, estimate, check }) {
  const code = 'insufficient_disk'
  const volumes = check?.volumes ?? []
  const short = check?.short
    ?? volumes.reduce((worst, v) => (!worst || v.needBytes - v.freeBytes > worst.needBytes - worst.freeBytes ? v : worst), null)
  if (!short) {
    return { code, message: 'Not enough free space to export. Free up some space and try again.', extra: { phase, estimate } }
  }
  return {
    code,
    message: insufficientDiskMessage(short.needBytes, short.freeBytes),
    extra: { needBytes: short.needBytes, freeBytes: short.freeBytes, path: short.path, phase, estimate, volumes },
  }
}
