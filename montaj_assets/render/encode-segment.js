// render/encode-segment.js
/**
 * Encode a single timeline segment to H.264 MP4.
 *
 * Each call composites:
 *   - N visual items: layered by trackIdx (lower = background). Each item has
 *     scale, offsetX, offsetY, opacity. Images loop, videos seek+trim.
 *   - 0-N overlays: Puppeteer-rendered MKV/WebM with alpha, positioned via
 *     offsetX, offsetY, scale, pixelRatio (matching current compose.js:244-263).
 *     Captions are always last (topmost z-layer) — ensured by planSegments.
 *   - Audio: extracted from the FIRST unmuted video item with audio, otherwise silent.
 *     NOTE: Unlike the old compose.js which mixed ALL unmuted video audio via amix,
 *     this takes only the first. Acceptable simplification — picture-in-picture with
 *     independent audio from both tracks is an edge case that can be added later via
 *     amix if needed.
 *
 * All output has uniform format: H.264 yuv420p + AAC 48kHz stereo + bt709 color metadata.
 * This uniformity enables concat with -c:v copy (no re-encode at concat time).
 */
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

const FFMPEG_TIMEOUT_MS = 600_000
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i

// Only surface ffmpeg lines that carry actionable signal — suppress banner/input listing.
const FFMPEG_SIGNAL = /warning|error|invalid|failed|matches no streams|^\[.*@/i
function logFfmpegStderr(stderr) {
  const TTY = process.stderr.isTTY
  const dim = TTY ? '\x1b[2m' : ''
  const reset = TTY ? '\x1b[0m' : ''
  for (const line of stderr.split('\n')) {
    if (line.trim() && FFMPEG_SIGNAL.test(line)) {
      process.stderr.write(`${dim}[montaj ffmpeg]${reset} ${line}\n`)
    }
  }
}

/** Returns true if the file has at least one audio stream. */
function fileHasAudio(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', timeout: 5000 })
  return result.status === 0 && result.stdout.trim().length > 0
}

function isImageItem(item) {
  return item.type === 'image' || IMAGE_EXTENSIONS.test(item.src)
}

/**
 * @param {object} segment — from planSegments()
 * @param {string} outputPath
 * @param {object} [opts]
 * @param {boolean} [opts._dryRun] — return { inputs, filterParts, args } without executing
 * @returns {string | object} outputPath, or dry-run result
 */
export function encodeSegment(segment, outputPath, opts = {}) {
  const { start, end, items, overlays, vw, vh, fps } = segment
  const duration = end - start

  if (!opts._dryRun) mkdirSync(dirname(outputPath), { recursive: true })

  const inputs = []
  const filterParts = []
  let videoLabel
  let hasSourceAudio = false
  let inputIdx = 0

  // --- Step 1: Black canvas base (always present — items layer on top) ---
  inputs.push('-f', 'lavfi', '-i',
    `color=black:size=${vw}x${vh}:rate=${fps}:duration=${duration}`)
  filterParts.push(`[0:v]format=yuv420p[canvas]`)
  videoLabel = '[canvas]'
  inputIdx++

  // --- Step 2: Visual items layered in trackIdx order (lower = background) ---
  for (let ii = 0; ii < items.length; ii++) {
    const item = items[ii]
    const s       = item.scale ?? 1
    const scaledW = Math.round(vw * s / 2) * 2
    const scaledH = Math.round(vh * s / 2) * 2
    const xPx     = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0) / 100))
    const yPx     = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0) / 100))
    const idx     = inputIdx

    if (isImageItem(item)) {
      inputs.push('-loop', '1', '-t', String(duration), '-i', item.src)
      filterParts.push(`[${idx}:v]scale=${scaledW}:${scaledH},format=rgba,setpts=PTS-STARTPTS[img${idx}]`)
      let src = `[img${idx}]`
      if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
        filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[imgop${idx}]`)
        src = `[imgop${idx}]`
      }
      filterParts.push(`${videoLabel}${src}overlay=x=${xPx}:y=${yPx}:shortest=0[iv${idx}]`)
      videoLabel = `[iv${idx}]`
    } else {
      // Video clip — seek to correct position within source
      const inPt = item.inPoint ?? 0
      const seekOffset = Math.max(0, start - item.start)
      const actualIn = inPt + seekOffset
      // Use -t (duration) not -to (absolute timestamp). If the source file is shorter
      // than the timeline slot (e.g. 24fps clip normalized to 30fps loses ~0.8s),
      // -to would read past EOF and ffmpeg holds the last frame. -t stops after
      // reading `duration` seconds of content, or at EOF — whichever comes first.
      // ProRes 4444 (.mov from remove-bg) has alpha — use format=auto
      const ovFmt = item.src.endsWith('.mov') ? ':format=auto' : ':format=yuv420'

      inputs.push('-ss', String(actualIn), '-t', String(duration), '-i', item.src)
      filterParts.push(`[${idx}:v]setpts=PTS-STARTPTS,scale=${scaledW}:${scaledH}[vid${idx}]`)
      let src = `[vid${idx}]`
      if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
        filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[vidop${idx}]`)
        src = `[vidop${idx}]`
      }
      filterParts.push(`${videoLabel}${src}overlay=x=${xPx}:y=${yPx}${ovFmt}:shortest=0[iv${idx}]`)
      videoLabel = `[iv${idx}]`

      // Audio from first unmuted video item with audio.
      // In dry-run mode, skip the ffprobe check (file may not exist) and assume audio present.
      if (!hasSourceAudio && !item.muted && (opts._dryRun || fileHasAudio(item.src))) {
        const vol = item.volume ?? 1.0
        filterParts.push(`[${idx}:a]asetpts=PTS-STARTPTS,volume=${vol},aresample=48000[vida]`)
        hasSourceAudio = true
      }
    }
    inputIdx++
  }

  // --- Step 3: Overlay + caption inputs (captions already sorted last by planSegments) ---
  for (const ov of overlays) {
    const ovSeekOffset = Math.max(0, start - ov.startSeconds)
    inputs.push('-ss', String(ovSeekOffset), '-t', String(duration), '-i', ov.webmPath)
    const ovIdx = inputIdx

    // Overlay positioning: pixelRatio upscaling + user scale + offset
    // Matches current compose.js:244-263
    const ovScale     = ov.scale ?? 1
    const ovPr        = ov.pixelRatio ?? 1
    const totalScale  = ovScale * ovPr
    const ovXPx       = Math.round(vw * (0.5 * (1 - ovScale) + (ov.offsetX ?? 0) / 100))
    const ovYPx       = Math.round(vh * (0.5 * (1 - ovScale) + (ov.offsetY ?? 0) / 100))

    // Force yuva420p — VP9 decoders may silently drop the alpha plane
    filterParts.push(`[${ovIdx}:v]format=yuva420p[ovfmt${ovIdx}]`)
    let ovSrc = `[ovfmt${ovIdx}]`

    // Apply pixelRatio + scale
    if (Math.abs(totalScale - 1) > 0.001) {
      filterParts.push(`${ovSrc}scale=iw*${totalScale}:ih*${totalScale}[ovsc${ovIdx}]`)
      ovSrc = `[ovsc${ovIdx}]`
    }

    filterParts.push(
      `${videoLabel}${ovSrc}overlay=x=${ovXPx}:y=${ovYPx}:format=yuv420:shortest=0[vov${ovIdx}]`
    )
    videoLabel = `[vov${ovIdx}]`
    inputIdx++
  }

  // --- Step 4: Color metadata (bt709) ---
  filterParts.push(`${videoLabel}setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709[vout]`)
  videoLabel = '[vout]'

  // --- Step 5: Audio — uniform 48kHz stereo for all segments ---
  let audioLabel
  if (hasSourceAudio) {
    audioLabel = '[vida]'
  } else {
    // Silent 48kHz stereo — matches normalized clip audio
    inputs.push('-f', 'lavfi', '-i', `anullsrc=cl=stereo:r=48000`)
    filterParts.push(`[${inputIdx}:a]atrim=0:${duration},asetpts=PTS-STARTPTS[sil]`)
    audioLabel = '[sil]'
    inputIdx++
  }

  // --- Step 6: Encode ---
  const args = [
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', videoLabel,
    '-map', audioLabel,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-g', String(fps), '-keyint_min', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', String(duration),
    '-movflags', '+faststart',
    outputPath,
  ]

  if (opts._dryRun) return { inputs, filterParts, args }

  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS,
  })

  if (result.stderr) logFfmpegStderr(result.stderr)

  if (result.status !== 0) {
    throw new Error(`ffmpeg segment encode failed (${start.toFixed(2)}-${end.toFixed(2)}s):\n${(result.stderr || '').slice(-500)}`)
  }

  return outputPath
}
