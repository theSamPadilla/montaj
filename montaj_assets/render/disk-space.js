// render/disk-space.js
//
// Will this render fit on disk (§128, §213)? A render writes in two places:
//
//   - TMPDIR: a small constant per worker. Overlay and caption frames are NOT
//     written there: each screenshot streams into its chunk's ffmpeg over
//     image2pipe (renderer.js renderChunk, §131), so TMPDIR holds only each
//     worker's Chrome profile and each segment's bundle, whatever the video's length.
//     (Before §131 it held every worker's chunk of PNG frames, which grew with
//     the longest overlay; captions span the whole video.) A remove_bg cutout
//     the render has to make itself also passes through TMPDIR (remove_bg.py
//     writes its video-only pass there before muxing it into render/).
//   - the project's disk, all of it still on disk at the render's peak:
//       - the overlay FFV1 chunks (render/segments). A segment cut into chunks
//         is joined into one file while its chunks still exist
//         (renderer.js concatChunks), so the largest such segment is on disk
//         twice for a moment.
//       - normalized masters (`<source>_normalized_<space>.mp4`, beside the
//         source), only those not already built (render.js
//         planVideoItemWrites), audio-strip copies of sources with several
//         audio streams, and remove_bg cutouts.
//       - per compose (one, or two for --export both): the video segments
//         (`<export>.segments/seg-NNNN.mp4`, video plus PCM audio), which stay
//         until the end of compose, and the export twice (the concat or mix
//         output beside the premix, then the poster remux beside the export:
//         compose.js). The first export of --export both stays while the SDR
//         one is composed.
//
// MEASURED 2026-10-07 on a 47 s 1080x1920 project (21 caption segments, 11
// overlays, 12 workers), before streaming: 468 MB peak in TMPDIR, 306 MB new in
// the project. The FFV1 chunk of the captions is about 0.015 bytes per pixel,
// of a dense overlay about 0.2.
//
// MEASURED with streaming (§131 Task 6), a 60 s 1080x1920 captioned project, 12
// workers: peak TMPDIR 132 MB (271 MB before, 138 MB of it PNGs); what remains
// is mostly Chrome profiles, about 121 MB for 12 workers, so about 10 MB each.
//
// MEASURED 2026-10-11 (§213) from files earlier renders left on this Mac's
// disk (sizes and durations read with ffprobe, nothing rendered): the FFV1
// chunks of 4K (2160x3840) captures, and 8 exports and 8 normalized masters.
// Each constant below says what it was set from.
//
// The preflight refuses only a render that certainly will not fit: the LOWER
// bound counts every frame at a rate below any measured one and only what is
// certain to be written. A render that passes and still runs out mid-way fails
// with the same code. Both lines ask for the EXPECTED need with a margin, so
// the space a user is told to free is never less than the render needs. Both
// lines carry the estimate and the free space, so reports show how good the
// estimate is.
//
// Pure: statfs, stat and readdir are injected, defaulting to node:fs.

import { statfsSync, statSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'

const GB = 1e9

// TMPDIR per worker (a Chrome profile; no frames), measured as above. The
// lower bound takes half, so it stays under what a real run uses.
// PLATFORM: measured on macOS at 1080p only. On Linux, --disable-dev-shm-usage
// may put Chrome's shared memory in TMPDIR (inferred, not measured); Windows
// is unmeasured.
export const TMP_BYTES_PER_WORKER = 10e6
// TMPDIR per segment: each segment keeps its bundle dir there for the whole
// render (render.js). MEASURED 11.7 MB for a one-line overlay.
export const BUNDLE_BYTES = 12e6

// FFV1 overlay chunks, bytes per captured pixel per frame.
// Lower bound: below every rate measured. MEASURED 2026-10-11 at 2160x3840:
// captions 0.0032 to 0.0091, the sparsest transparent overlay 0.0082 (it was
// 0.01 here, which a 4K caption track undercuts).
export const FFV1_SPARSE_BYTES_PER_PIXEL = 0.002
// Expected, captions: MEASURED at 1080x1920 (above); 4K captions measure
// lower (0.003 to 0.009), so this errs high there.
export const FFV1_CAPTION_BYTES_PER_PIXEL = 0.015
// Expected, every other overlay: MEASURED 0.2 at 1080x1920 (above), and
// MEASURED 2026-10-11 at 2160x3840: full-screen opaque overlays (3D scenes)
// 0.15 to 0.19 across 15 segments of two projects, 0.07 to 0.43 across 14 of
// a third. Light transparent graphics measure 0.01 to 0.08, so this errs high
// for them: a 3D overlay must not be undercounted.
export const FFV1_DENSE_BYTES_PER_PIXEL = 0.2

// The segment encoder and normalize (libx264 crf 18 / libx265 crf 22, preset
// fast, 1 s GOP; color_space.json), in bits per output pixel per frame. An
// export is a stream copy of its segments, so one rate serves both.
// MEASURED 2026-10-11 from the sizes of existing files: libx264 exports 0.012
// to 0.083, libx264 masters 0.076 to 0.149; libx265 exports 0.033 to 0.056,
// libx265 masters 0.049 to 0.051. Each rate is set at or above the largest.
// The files were screen recordings, generated clips and graphics: camera
// footage is unmeasured and may run higher.
export const VIDEO_BITS_PER_PIXEL = Object.freeze({ sdr_bt709: 0.15, hdr_hlg: 0.06, hdr_pq: 0.06 })
// Lower bound for one video stream (an export or a master), any resolution.
// The lowest measured above is 1.7 Mbps (a 1280x720 master).
export const OUTPUT_FLOOR_BYTES_PER_SECOND = 1e6 / 8
// Segment audio: pcm_s16le, 48 kHz, stereo (encode-segment.js). Exact.
export const SEGMENT_PCM_BYTES_PER_SECOND = 48000 * 2 * 2
// Export audio: AAC at 192 kb/s (compose.js concat). INFERRED from the
// argument: the native encoder holds close to its target.
export const EXPORT_AAC_BYTES_PER_SECOND = 192e3 / 8
// remove_bg cutouts: ProRes 4444, yuva444p10le (steps/transform/remove_bg.py).
// INFERRED from Apple's published target, 330 Mb/s at 1920x1080 29.97 fps
// (5.3 bits per pixel per frame) without alpha, rounded up for the alpha plane.
export const PRORES_4444_BITS_PER_PIXEL = 6

// The space a failure asks the user to free: the expected need times this,
// less what is free now.
export const DISK_MARGIN = 1.5

/** Bytes a second of one video stream at `colorSpace`'s encoder. */
export function videoBytesPerSecond({ width, height, fps, colorSpace }) {
  const bpp = VIDEO_BITS_PER_PIXEL[colorSpace] ?? VIDEO_BITS_PER_PIXEL.sdr_bt709
  return (bpp * width * height * fps) / 8
}

const masterBytes = (m) => videoBytesPerSecond(m) * m.durationSeconds + EXPORT_AAC_BYTES_PER_SECOND * m.durationSeconds
const cutoutBytes = (c) => (PRORES_4444_BITS_PER_PIXEL * c.width * c.height * c.fps * c.durationSeconds) / 8
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0)

/**
 * The disk a render needs at its peak, as a lower bound and as an expected
 * figure.
 *
 * @param {object} p
 * @param {Array<{ frames: number, sparse: boolean }>} p.segments  overlay and caption segments; `sparse` for captions
 * @param {number} p.width @param {number} p.height  the capture canvas (renderWidth x renderHeight)
 * @param {number} [p.captureScale]  device pixels per CSS pixel (render.js captureScaleFor)
 * @param {number} [p.workerCount]   browser workers (renderer.js planChunks)
 * @param {number} [p.chunkFrames]   planChunks' chunk size: a longer segment is joined from chunks
 * @param {number} p.durationSeconds the timeline's length
 * @param {{ width: number, height: number, fps: number }} [p.output]  the export; default the capture canvas at 30 fps
 * @param {string[]} [p.passes]      the colour space of each compose, in order ('both': [hdr, 'sdr_bt709'])
 * @param {Array<{ durationSeconds: number, width: number, height: number, fps: number, colorSpace: string }>} [p.masters]
 *   normalized masters this render builds (whole sources)
 * @param {Array<{ bytes: number }>} [p.copies]  audio-strip copies (stream copies of a source)
 * @param {Array<{ durationSeconds: number, width: number, height: number, fps: number }>} [p.cutouts]  remove_bg cutouts it makes
 * @returns {{ lower: {tmpBytes: number, projectBytes: number}, expected: {tmpBytes: number, projectBytes: number} }}
 */
export function estimateRenderDisk({
  segments, width, height, captureScale = 1, workerCount = 1, chunkFrames = Infinity, durationSeconds,
  output = null, passes = ['sdr_bt709'], masters = [], copies = [], cutouts = [],
}) {
  const px = width * height * captureScale * captureScale
  const seconds = Math.max(0, Number(durationSeconds) || 0)
  const out = { width: output?.width ?? width, height: output?.height ?? height, fps: output?.fps ?? 30 }

  // TMPDIR: the profiles and bundles while overlays capture; before that, one
  // cutout at a time (remove_bg runs item by item, before any bundle).
  const overlayTmp = Math.max(1, workerCount) * TMP_BYTES_PER_WORKER + segments.length * BUNDLE_BYTES
  const tmpExpected = Math.max(overlayTmp, ...cutouts.map(cutoutBytes))

  // Overlay chunks, and the one segment joined from chunks while they remain.
  const ffv1 = (s) => s.frames * px * (s.sparse ? FFV1_CAPTION_BYTES_PER_PIXEL : FFV1_DENSE_BYTES_PER_PIXEL)
  const ffv1Expected = sum(segments, ffv1)
  const joinExpected = Math.max(0, ...segments.filter((s) => s.frames > chunkFrames).map(ffv1))
  const frames = sum(segments, (s) => s.frames)

  // Each compose: its segments and its export twice, over the exports before it.
  let composeExpected = 0, composeLower = 0, before = 0, beforeLower = 0
  for (const colorSpace of passes) {
    const video = videoBytesPerSecond({ ...out, colorSpace }) * seconds
    const exportBytes = video + EXPORT_AAC_BYTES_PER_SECOND * seconds
    const segmentBytes = video + SEGMENT_PCM_BYTES_PER_SECOND * seconds
    composeExpected = Math.max(composeExpected, before + segmentBytes + 2 * exportBytes)
    before += exportBytes
    // Lower: only the PCM is certain in the segments; each export at the floor.
    const exportLower = OUTPUT_FLOOR_BYTES_PER_SECOND * seconds
    composeLower = Math.max(composeLower, beforeLower + SEGMENT_PCM_BYTES_PER_SECOND * seconds + 2 * exportLower)
    beforeLower += exportLower
  }

  // Beside the sources: these stay for good.
  const sourcesExpected = sum(masters, masterBytes) + sum(copies, (c) => c.bytes) + sum(cutouts, cutoutBytes)
  const sourcesLower = sum(masters, (m) => m.durationSeconds * OUTPUT_FLOOR_BYTES_PER_SECOND) + 0.5 * sum(copies, (c) => c.bytes)

  return {
    lower: {
      tmpBytes: Math.round(0.5 * overlayTmp),
      projectBytes: Math.round(frames * px * FFV1_SPARSE_BYTES_PER_PIXEL + sourcesLower + composeLower),
    },
    expected: {
      tmpBytes: Math.round(tmpExpected),
      projectBytes: Math.round(sourcesExpected + ffv1Expected + Math.max(joinExpected, composeExpected)),
    },
  }
}

/**
 * Free space for one estimate (`{ tmpBytes, projectBytes }`): the two needs are
 * added when TMPDIR and the project are on one disk, else each disk is checked
 * for its own part. `reclaimBytes` (an earlier render's leftover segments, which
 * this render deletes before writing its own) counts as free on the project's
 * disk. A directory that does not exist yet is measured at its nearest existing
 * parent. `short` is the first disk without room, or null. Returns null when a
 * disk cannot be read: the check never blocks a render on its own failure.
 *
 * MONTAJ_TEST_DISK_FREE_BYTES (tests only) replaces every disk's free space.
 */
export function checkDiskSpace({ tmpDir, projectDir, estimate, reclaimBytes = 0, statfs = statfsSync, stat = statSync }) {
  let tmp, proj
  try {
    tmp = volumeOf(tmpDir, statfs, stat)
    proj = volumeOf(projectDir, statfs, stat)
  } catch {
    return null
  }
  const reclaim = Math.max(0, Number(reclaimBytes) || 0)
  const volumes = tmp.dev === proj.dev
    ? [{ path: projectDir, needBytes: estimate.tmpBytes + estimate.projectBytes, freeBytes: proj.freeBytes + reclaim }]
    : [
        { path: tmpDir, needBytes: estimate.tmpBytes, freeBytes: tmp.freeBytes },
        { path: projectDir, needBytes: estimate.projectBytes, freeBytes: proj.freeBytes + reclaim },
      ]
  const short = volumes.find(v => v.freeBytes < v.needBytes) ?? null
  return { short, volumes }
}

function volumeOf(dir, statfs, stat) {
  // A render's render/ or output/ dir may not exist yet (an estimate creates
  // nothing): measure the disk it will be made on.
  let at = dir
  let st
  for (;;) {
    try {
      st = stat(at)
      break
    } catch (err) {
      const parent = dirname(at)
      if ((err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') || parent === at) throw err
      at = parent
    }
  }
  const fsStats = statfs(at)
  const override = process.env.MONTAJ_TEST_DISK_FREE_BYTES
  const freeBytes = override ? Number(override) : Number(fsStats.bavail) * Number(fsStats.bsize)
  if (!Number.isFinite(freeBytes)) throw new Error(`unreadable free space for ${dir}`)
  return { dev: st.dev, freeBytes }
}

/** Bytes of the files under `dir` (0 when it does not exist). Symlinks are not followed. */
export function dirBytes(dir, { readdir = readdirSync, lstat = lstatSync } = {}) {
  let entries
  try {
    entries = readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(path, { readdir, lstat })
    else if (entry.isFile()) {
      try { total += lstat(path).size } catch { /* gone since the listing */ }
    }
  }
  return total
}

/**
 * The space to free, in whole GB: the need times DISK_MARGIN less what is free,
 * rounded up, at least 1.
 */
export function spaceToFreeGB(needBytes, freeBytes) {
  // The small slack keeps a float like 3.0000000000000004 from asking for 4.
  return Math.max(1, Math.ceil((DISK_MARGIN * needBytes - freeBytes) / GB - 1e-9))
}

/** The user's sentence, from the EXPECTED need of the short disk and its free space now. */
export function insufficientDiskMessage(needBytes, freeBytes) {
  return `Out of disk space. Free up ${spaceToFreeGB(needBytes, freeBytes)} GB and export again.`
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
 * `check` is checkDiskSpace against the EXPECTED estimate, in both phases
 * ('preflight', where the lower bound refused the render, and 'mid-render',
 * where it ran out). The short disk is the one furthest from its need with the
 * margin, so the sentence never asks for less than the render needs. With no
 * reading at all the sentence still names the reason.
 */
export function diskFailure({ phase, estimate, check }) {
  const code = 'insufficient_disk'
  const volumes = check?.volumes ?? []
  const lack = (v) => DISK_MARGIN * v.needBytes - v.freeBytes
  const short = volumes.reduce((worst, v) => (!worst || lack(v) > lack(worst) ? v : worst), null)
  if (!short) {
    return { code, message: 'Out of disk space. Free up some space and export again.', extra: { phase, estimate } }
  }
  return {
    code,
    message: insufficientDiskMessage(short.needBytes, short.freeBytes),
    extra: { needBytes: short.needBytes, freeBytes: short.freeBytes, path: short.path, phase, estimate, volumes },
  }
}
