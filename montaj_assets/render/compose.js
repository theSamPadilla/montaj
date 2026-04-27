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
}) {
  // Default resolution is portrait (1080x1920) — montaj's default orientation.
  // render.js always passes explicit dimensions, but direct callers hitting
  // defaults should get the right orientation.
  const vw = videoWidth ?? projectJson.settings?.resolution?.[0] ?? 1080
  const vh = videoHeight ?? projectJson.settings?.resolution?.[1] ?? 1920
  const fps = projectJson.settings?.fps ?? 30
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
  mkdirSync(segDir, { recursive: true })

  const segPaths = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
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

  // Cleanup segment files
  if (!process.env.MONTAJ_KEEP_SEGMENTS) {
    rmSync(segDir, { recursive: true, force: true })
  }

  return outputPath
}

function concatSegments(paths, outputPath) {
  const listFile = outputPath + '.concat.txt'
  writeFileSync(listFile, paths.map(p => `file '${p}'`).join('\n'))

  clog(`concatenating ${paths.length} segment(s)...`)

  // Video: -c:v copy (all segments are H.264 yuv420p, same res/fps — safe).
  // Audio: -c:a aac re-encode. Even though segments target 48kHz AAC,
  // concat -c:a copy can produce garbled audio at segment boundaries if
  // AAC frame alignment differs. Re-encoding audio is cheap and guarantees
  // clean output. Video stream copy is the big win — no quality loss there.
  const tmpPath = outputPath.replace(/(\.\w+)$/, `.${randomBytes(4).toString('hex')}$1`)
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
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
