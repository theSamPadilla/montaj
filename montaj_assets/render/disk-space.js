// render/disk-space.js
//
// Will this render fit on disk (§128)? A render writes in two places:
//
//   - TMPDIR: each overlay and caption chunk's PNG frames (renderer.js
//     renderChunk), kept until that chunk is encoded. Every worker captures a
//     chunk at once, and a chunk grows with the longest overlay (chunk-plan.js
//     adaptiveChunkSize), so the peak grows with the video's length: captions
//     span all of it.
//   - the project's disk: the overlay FFV1 chunks and the video segments
//     (render/segments), normalized masters, and the export.
//
// MEASURED 2026-10-07 on a 47 s 1080x1920 project (21 caption segments, 11
// overlays, 12 workers): 468 MB peak in TMPDIR, 306 MB new in the project. A
// Chrome capture of a caption frame is about 0.04 bytes per pixel, a dense
// overlay frame about 0.65; the FFV1 chunk of the captions about 0.015, of a
// dense overlay about 0.2; the export about 5 Mbps.
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

// Lower bound (the preflight).
export const SPARSE_BYTES_PER_PIXEL = 0.03
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
 * @param {number} [p.subframes]     motion-blur screenshots per frame
 * @param {number} [p.workerCount]   browser workers (renderer.js planChunks)
 * @param {number} [p.chunkSize]     frames per chunk (renderer.js planChunks)
 * @param {number} p.durationSeconds the timeline's length
 * @returns {{ lower: {tmpBytes: number, projectBytes: number}, expected: {tmpBytes: number, projectBytes: number} }}
 */
export function estimateRenderDisk({ segments, width, height, captureScale = 1, subframes = 1, workerCount = 1, chunkSize, durationSeconds }) {
  const px = width * height * captureScale * captureScale
  const frames = segments.reduce((n, s) => n + s.frames, 0)
  const captured = frames * subframes
  const perChunk = Math.max(1, chunkSize ?? frames) * subframes
  const atOnce = Math.min(captured, Math.max(1, workerCount) * perChunk)
  // Frames on disk at once are a mix of the segments; weigh their density by frames.
  const capturedDensity = frames > 0
    ? segments.reduce((n, s) => n + s.frames * (s.sparse ? CAPTION_BYTES_PER_PIXEL : DENSE_BYTES_PER_PIXEL), 0) / frames
    : 0
  const ffv1Expected = segments.reduce((n, s) => n + s.frames * px * (s.sparse ? FFV1_CAPTION_BYTES_PER_PIXEL : FFV1_DENSE_BYTES_PER_PIXEL), 0)
  const outputScale = (width * height) / MEASURED_PIXELS
  return {
    lower: {
      tmpBytes: Math.round(0.5 * atOnce * px * SPARSE_BYTES_PER_PIXEL),
      projectBytes: Math.round(frames * px * FFV1_SPARSE_BYTES_PER_PIXEL + 2 * durationSeconds * OUTPUT_FLOOR_BYTES_PER_SECOND),
    },
    expected: {
      tmpBytes: Math.round(atOnce * px * capturedDensity),
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
