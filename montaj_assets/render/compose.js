// render/compose.js
/**
 * compose.js — Segment-based video composition.
 *
 * Pipeline:
 *   1. planSegments() — split timeline at clip/overlay boundaries
 *   2. encodeSegment() — encode each segment independently
 *   3. concat — ffmpeg concat demuxer (video: copy, audio: re-encode to uniform AAC 48kHz)
 *   4. mixAudioIntoVideo() — independent audio tracks mixed in final pass
 *
 * No monolithic filter_complex. No chunking threshold. Each ffmpeg call is simple.
 */
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { planSegments } from './segment-plan.js'
import { encodeSegment } from './encode-segment.js'
import { mixAudioIntoVideo } from './mix-audio.js'

const FFMPEG_TIMEOUT_MS = 600_000

const TTY = process.stderr.isTTY
const C = {
  green: TTY ? '\x1b[92m' : '', dim: TTY ? '\x1b[2m' : '', reset: TTY ? '\x1b[0m' : '',
}
function clog(msg) { process.stderr.write(`${C.green}[montaj compose]${C.reset} ${msg}\n`) }

/**
 * Main entry point — replaces compose() from compose.js.
 * Same signature for drop-in compatibility with render.js.
 */
export async function compose({
  projectJson,
  puppeteerSegments = [],
  imageItems = [],
  videoItems = [],
  outputPath,
  videoWidth,
  videoHeight,
  colorSpace,
}) {
  // Default resolution is portrait (1080x1920) — montaj's default orientation.
  // render.js always passes explicit dimensions, but direct callers hitting
  // defaults should get the right orientation.
  const vw = videoWidth ?? projectJson.settings?.resolution?.[0] ?? 1080
  const vh = videoHeight ?? projectJson.settings?.resolution?.[1] ?? 1920
  const fps = projectJson.settings?.fps ?? 30
  // Project working color space — drives segment-encoder codec, pix_fmt, and
  // color metadata. Falls back to sdr_bt709 for projects predating this field.
  const projectColorSpace = colorSpace ?? projectJson.settings?.colorSpace ?? 'sdr_bt709'
  const audioTracks = projectJson.audio?.tracks ?? []
  const hasAudio = audioTracks.some(t => !t.muted)

  // 1. Plan segments — merge video + image items
  const allItems = [...imageItems, ...videoItems]
  const segments = planSegments(allItems, puppeteerSegments, vw, vh, fps)

  if (segments.length === 0) {
    clog('no segments to render')
    return outputPath
  }

  const lastEnd = segments[segments.length - 1].end
  clog(`planned ${segments.length} segment(s) across ${lastEnd.toFixed(1)}s`)

  // 2. Encode each segment
  mkdirSync(dirname(outputPath), { recursive: true })
  const segDir = outputPath + '.segments'
  // WIPE stale segments from a previous (possibly partial) render before
  // (re)creating the directory. Without this, leftover seg-NNNN.mp4 files from
  // a prior failed render persist and the segment count from this run won't
  // always overwrite them — but more importantly, if a previous render produced
  // segments with the same index from a different timeline configuration, we'd
  // end up concatenating a mix. Mirror render.js's wipe of `segments/` (overlay
  // chunks) at the corresponding stage.
  rmSync(segDir, { recursive: true, force: true })
  mkdirSync(segDir, { recursive: true })

  const segPaths = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    // Stamp project color space onto each segment so the encoder knows what
    // codec/pix_fmt/color metadata to emit. planSegments doesn't know about
    // color space; that's a project-level concern threaded through here.
    seg.colorSpace = projectColorSpace
    const segPath = join(segDir, `seg-${String(i).padStart(4, '0')}.mp4`)

    clog(`segment ${i + 1}/${segments.length} (${seg.start.toFixed(2)}-${seg.end.toFixed(2)}s): ` +
         `${seg.items.length} item(s), ${seg.overlays.length} overlay(s)`)

    encodeSegment(seg, segPath)
    segPaths.push(segPath)
  }

  // 3. Concat all segments
  const preMixPath = hasAudio ? outputPath.replace(/(\.\w+)$/, '_premix$1') : outputPath
  concatSegments(segPaths, preMixPath)

  // 4. Mix independent audio tracks (concat output guaranteed to have audio
  //    because every segment produces AAC 48kHz — either from source or anullsrc)
  if (hasAudio) {
    mixAudioIntoVideo(preMixPath, audioTracks, outputPath)
    rmSync(preMixPath, { force: true })
  }

  // 5. Embed a poster frame as an MP4 attached_pic stream so Finder, QuickTime,
  //    iMessage, Slack, and social platforms show a thumbnail instead of a
  //    black-or-blank placeholder.
  embedThumbnail(outputPath, projectColorSpace)

  // Cleanup segment files
  if (!process.env.MONTAJ_KEEP_SEGMENTS) {
    rmSync(segDir, { recursive: true, force: true })
  }

  return outputPath
}

/**
 * Embed a poster image (MP4 attached_pic stream) into the final video so
 * file browsers and social platforms show a thumbnail before playback.
 *
 * Two-step: (1) extract one JPEG frame at 1.0s, (2) re-mux video+audio+jpg
 * with -disposition:v:1 attached_pic. Both passes stream-copy AV; the only
 * encode cost is the single JPEG. Total runtime ~1s on any sane host.
 *
 * Failure is non-fatal: a missing thumbnail is far better than failing an
 * otherwise-good render. On any error we log and leave outputPath untouched.
 */
export function embedThumbnail(outputPath, colorSpace) {
  const tmpJpg = outputPath + '.thumb.jpg'
  const tmpMp4 = outputPath.replace(/(\.\w+)$/, `.thumb.${randomBytes(4).toString('hex')}$1`)

  // HDR projects (HLG / PQ) must tonemap before the JPEG encode. JPEG is sRGB
  // by definition — handing it raw HLG/PQ Y'CbCr produces a washed-out,
  // colour-skewed poster on every viewer because the gamma assumption is wrong.
  // zscale (libzimg) is already required for the HDR encode path, so it's safe
  // to assume present here when colorSpace is HDR.
  const vf = (colorSpace === 'hdr_hlg' || colorSpace === 'hdr_pq')
    ? `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p`
    : null

  function extractAt(seekSeconds) {
    const args = ['-y', '-v', 'error', '-ss', String(seekSeconds), '-i', outputPath, '-frames:v', '1']
    if (vf) args.push('-vf', vf)
    args.push('-q:v', '2', tmpJpg)
    return spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
  }

  // Try 1.0s first (past most fade-ins). If that fails (e.g. video shorter
  // than 1.0s, decoder error), retry at 0 — every valid video has a frame 0.
  let extract = extractAt(1.0)
  if (extract.status !== 0) {
    rmSync(tmpJpg, { force: true })
    extract = extractAt(0)
  }
  if (extract.status !== 0) {
    clog(`thumbnail extract failed (skipping): ${(extract.stderr || '').trim().slice(-300)}`)
    rmSync(tmpJpg, { force: true })
    return
  }

  // -disposition:v:1 attached_pic flags the JPEG as the cover/poster rather
  // than a second video track. Without it, players treat the file as having
  // two video streams and either reject it or autoplay the JPEG as a 1-frame
  // stuck-frame on a separate track.
  const mux = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', outputPath,
    '-i', tmpJpg,
    '-map', '0', '-map', '1',
    '-c', 'copy',
    '-disposition:v:1', 'attached_pic',
    '-movflags', '+faststart',
    tmpMp4,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  rmSync(tmpJpg, { force: true })
  if (mux.status !== 0) {
    clog(`thumbnail mux failed (skipping): ${(mux.stderr || '').trim().slice(-300)}`)
    rmSync(tmpMp4, { force: true })
    return
  }
  renameSync(tmpMp4, outputPath)
  clog('attached poster thumbnail')
}

function concatSegments(paths, outputPath) {
  const listFile = outputPath + '.concat.txt'
  writeFileSync(listFile, paths.map(p => `file '${p}'`).join('\n'))

  clog(`concatenating ${paths.length} segment(s)...`)

  // Video: -c:v copy. All segments from a single render share the project's
  // working codec — h264 for SDR, hevc for HDR — so stream-copy concat is safe.
  // Uniform output is now per-project, not pipeline-wide.
  // Audio: -c:a aac re-encode. Segments output stereo 48kHz pcm_s16le (see
  // encode-segment.js Step 6 — switched from per-segment AAC to PCM to make
  // segment seams sample-aligned, since AAC framing/priming/edit-list
  // metadata do not survive the concat demuxer cleanly when audio is
  // transcoded). The concat pass here decodes the joined PCM stream and
  // re-encodes to AAC once at end-of-pipeline — this is the only AAC encode
  // in the render path.
  const tmpPath = outputPath.replace(/(\.\w+)$/, `.${randomBytes(4).toString('hex')}$1`)
  // No error-tolerance flags at concat — those would mask real corruption AND
  // tell the HEVC NAL parser to accept malformed units in stream-copy mode,
  // producing a final.mp4 with garbage video bitstream. Strict by default.
  const result = spawnSync('ffmpeg', [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    tmpPath,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  rmSync(listFile, { force: true })
  if (result.status !== 0) {
    rmSync(tmpPath, { force: true })
    throw new Error(`ffmpeg concat failed:\n${result.stderr}`)
  }
  renameSync(tmpPath, outputPath)
}
