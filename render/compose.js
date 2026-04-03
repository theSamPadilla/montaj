/**
 * compose.js — Build and execute the final ffmpeg filter graph.
 *
 * Inputs:
 *   - base video (trimmed + concatenated source clips)
 *   - one transparent WebM per caption/overlay segment
 *   - optionally: music file
 *
 * Output:
 *   - final MP4 (H.264, CRF 18, AAC audio)
 *   - GPU-accelerated final encode when available (VideoToolbox → NVENC → libx264)
 */
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

const FFMPEG_TIMEOUT_MS = 600_000

/**
 * @param {Object} opts
 * @param {Object}   opts.projectJson
 * @param {string}   opts.baseVideoPath
 * @param {Array<{ webmPath: string, startSeconds: number, endSeconds: number }>} opts.segments
 * @param {string}   opts.outputPath
 */
export async function compose({ projectJson, baseVideoPath, segments, outputPath }) {
  mkdirSync(dirname(outputPath), { recursive: true })

  const music      = projectJson.audio?.music
  const hasOverlays = segments.length > 0
  const hasMusic    = !!(music?.src)

  // --- Build input list ---
  // [0] base video, [1..N] overlay/caption segments, [N+1] music (optional)
  // itsoffset shifts each overlay's timestamps so its frame 0 aligns with startSeconds.
  const inputs = ['-i', baseVideoPath]
  for (const seg of segments) {
    inputs.push('-itsoffset', String(seg.startSeconds))
    inputs.push('-i', seg.webmPath)
  }
  if (hasMusic) inputs.push('-i', music.src)

  const musicIdx = segments.length + 1 // input index of music file (if present)

  // --- Build filter_complex ---
  const filterParts = []
  let videoLabel = '0:v'
  let audioLabel = '0:a'

  if (hasOverlays) {
    const [videoWidth, videoHeight] = projectJson.settings?.resolution ?? [1080, 1920]
    // yuv420p10le preserves the source's 10-bit HDR signal (bt2020/HLG) through the
    // overlay chain. Downgrading to yuv420p here causes the color shift users see.
    filterParts.push('[0:v]format=yuv420p10le[base]')
    for (let i = 0; i < segments.length; i++) {
      const seg    = segments[i]
      const inVid  = i === 0 ? '[base]' : `[ov${i - 1}]`
      const inOver = `[${i + 1}:v]`
      const outVid = i === segments.length - 1 ? '[vout]' : `[ov${i}]`
      const s    = seg.scale ?? 1
      const xPx  = Math.round(videoWidth  * (0.5 * (1 - s) + (seg.offsetX ?? 0) / 100))
      const yPx  = Math.round(videoHeight * (0.5 * (1 - s) + (seg.offsetY ?? 0) / 100))
      // Force yuva420p before compositing — VP9 decoders may silently drop the alpha
      // plane and return yuv420p, causing the overlay to composite as fully opaque.
      const fmtLabel = `[fmt${i}]`
      filterParts.push(`${inOver}format=yuva420p${fmtLabel}`)

      let overlayInput = fmtLabel
      // Upscale from design resolution to video resolution (e.g. 2× for 4K output)
      // then apply any user-specified scale on top.
      const pr = seg.pixelRatio ?? 1
      const totalScale = s * pr
      if (Math.abs(totalScale - 1) > 0.001) {
        const scaledLabel = `[sc${i}]`
        filterParts.push(`${fmtLabel}scale=iw*${totalScale}:ih*${totalScale}${scaledLabel}`)
        overlayInput = scaledLabel
      }
      // enable='between()': when the overlay is outside its window, the filter passes
      // the base through without consuming the overlay input — no buffering stall.
      filterParts.push(
        `${inVid}${overlayInput}overlay=x=${xPx}:y=${yPx}:format=yuv420:enable='between(t,${seg.startSeconds},${seg.endSeconds})':shortest=0${outVid}`
      )
    }
    videoLabel = '[vout]'
  }

  if (hasMusic) {
    const vol = music.volume ?? 0.15

    if (music.ducking?.enabled) {
      const depth   = music.ducking.depth   ?? -12
      const attack  = music.ducking.attack  ?? 0.3   // seconds → ms below
      const release = music.ducking.release ?? 0.5
      filterParts.push(
        `[0:a]asplit=2[speech][sc];` +
        `[${musicIdx}:a]volume=${vol}[mscaled];` +
        `[mscaled][sc]sidechaincompress=threshold=0.02:ratio=4:attack=${attack * 1000}:release=${release * 1000}[ducked];` +
        `[speech][ducked]amix=inputs=2:duration=first[aout]`
      )
      audioLabel = '[aout]'
    } else {
      filterParts.push(
        `[0:a][${musicIdx}:a]amix=inputs=2:weights='1 ${vol}'[aout]`
      )
      audioLabel = '[aout]'
    }
  }

  // --- Assemble ffmpeg args ---
  // VideoToolbox produces corrupted output with filter_complex overlay pipelines — hardcode libx264.
  // Encode at 10-bit to preserve the source HDR signal (bt2020/HLG). libx264 on this
  // system supports yuv420p10le. Color space metadata flags tell the player how to
  // interpret the signal correctly.
  const videoCodecArgs = [
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p10le',
    '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67',
  ]

  const ffmpegArgs = ['-y', ...inputs]

  if (filterParts.length > 0) {
    ffmpegArgs.push('-filter_complex', filterParts.join(';'))
  }

  ffmpegArgs.push('-map', videoLabel)

  // Audio: mapped label if filter_complex produced one, otherwise direct stream map
  if (audioLabel.startsWith('[')) {
    ffmpegArgs.push('-map', audioLabel)
  } else {
    ffmpegArgs.push('-map', '0:a?')
  }

  ffmpegArgs.push(
    ...videoCodecArgs,
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  )

  process.stderr.write(`[montaj compose] running ffmpeg with ${segments.length} overlay(s)...\n`)

  const result = spawnSync('ffmpeg', ffmpegArgs, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  // Always log ffmpeg stderr — warnings here explain missing overlays, format issues, etc.
  if (result.stderr) {
    for (const line of result.stderr.split('\n').filter(l => l.trim())) {
      process.stderr.write(`[montaj ffmpeg] ${line}\n`)
    }
  }

  if (result.status !== 0) {
    throw new Error(`ffmpeg compose failed:\n${result.stderr}`)
  }

  return outputPath
}

// ---------------------------------------------------------------------------
// GPU encoder detection — try best available, fall back to libx264
// ---------------------------------------------------------------------------

function detectVideoCodec() {
  const candidates = [
    // macOS VideoToolbox
    ['h264_videotoolbox', ['-c:v', 'h264_videotoolbox', '-q:v', '65']],
    // NVIDIA NVENC
    ['h264_nvenc',        ['-c:v', 'h264_nvenc', '-cq', '18', '-preset', 'p4']],
    // Intel/AMD VAAPI (Linux)
    ['h264_vaapi',        ['-vaapi_device', '/dev/dri/renderD128', '-c:v', 'h264_vaapi', '-qp', '18']],
  ]

  for (const [codec, args] of candidates) {
    const probe = spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
      ...args, '-f', 'null', '-',
    ], { encoding: 'utf8', timeout: 5000 })

    if (probe.status === 0) return args
  }

  // Software fallback
  return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p']
}
