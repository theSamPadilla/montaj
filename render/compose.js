/**
 * compose.js — Build and execute the final ffmpeg filter graph.
 *
 * Inputs:
 *   - baseTrackClips: array of clip objects from base_track[] (trimmed individually)
 *   - puppeteerSegments: rendered MKV/WebM overlay + caption segments from Puppeteer
 *   - imageItems: direct image overlay inputs
 *   - videoItems: direct video overlay inputs
 *   - optionally: music file (from projectJson.audio.music)
 *
 * Output:
 *   - final MP4 (H.264, CRF 18, AAC audio)
 */
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

const FFMPEG_TIMEOUT_MS = 600_000

/**
 * Compute total video duration from available inputs.
 * If base clips exist, sum their durations.
 * Otherwise, take the max end time across all items.
 */
function computeTotalDuration(baseTrackClips, imageItems, videoItems, puppeteerSegments) {
  if (baseTrackClips.length > 0) {
    return baseTrackClips.reduce((sum, c) => sum + ((c.outPoint ?? 0) - (c.inPoint ?? 0)), 0)
  }
  const allEnds = [
    ...imageItems.map(i => i.end ?? 0),
    ...videoItems.map(i => i.end ?? 0),
    ...puppeteerSegments.map(s => s.endSeconds ?? 0),
  ]
  return allEnds.length > 0 ? Math.max(...allEnds) : 0
}

/**
 * @param {Object} opts
 * @param {Object}   opts.projectJson
 * @param {Array}    opts.baseTrackClips       — clip objects from base_track[]
 * @param {Array}    opts.puppeteerSegments     — rendered WebM/MKV segments from Puppeteer
 * @param {Array}    opts.imageItems            — direct image overlay inputs
 * @param {Array}    opts.videoItems            — direct video overlay inputs
 * @param {string}   opts.outputPath
 * @param {number}   [opts.videoWidth]
 * @param {number}   [opts.videoHeight]
 */
export async function compose({
  projectJson,
  baseTrackClips,
  puppeteerSegments,
  imageItems,
  videoItems,
  outputPath,
  videoWidth,
  videoHeight,
}) {
  mkdirSync(dirname(outputPath), { recursive: true })

  const music    = projectJson.audio?.music
  const hasMusic = !!(music?.src)

  const vw  = videoWidth  ?? projectJson.settings?.resolution?.[0] ?? 1080
  const vh  = videoHeight ?? projectJson.settings?.resolution?.[1] ?? 1920
  const fps = projectJson.settings?.fps ?? 30

  const N = baseTrackClips.length
  const M = imageItems.length
  const P = videoItems.length

  // Sort items by trackIdx for correct z-ordering (lower trackIdx = further back)
  const sortedImages = [...imageItems].sort((a, b) => (a.trackIdx ?? 0) - (b.trackIdx ?? 0))
  const sortedVideos = [...videoItems].sort((a, b) => (a.trackIdx ?? 0) - (b.trackIdx ?? 0))

  // Captions always composited last (on top of everything)
  const overlaySegs = puppeteerSegments.filter(s => !s.isCaption)
  const captionSegs = puppeteerSegments.filter(s => s.isCaption)
  const orderedSegs = [...overlaySegs, ...captionSegs]

  const Q = orderedSegs.length
  const musicInputIdx = N + M + P + Q

  const totalDuration = computeTotalDuration(baseTrackClips, imageItems, videoItems, puppeteerSegments)

  // --- Build input list ---
  const inputs = []

  // Base track clips (one -i per clip, with -ss and -t for trim)
  for (const clip of baseTrackClips) {
    const inPt = clip.inPoint ?? 0
    const dur  = (clip.outPoint != null && clip.inPoint != null)
      ? clip.outPoint - clip.inPoint
      : null
    inputs.push('-ss', String(inPt))
    if (dur != null) inputs.push('-t', String(dur))
    inputs.push('-i', clip.src)
  }

  // Image inputs (looped for full duration)
  for (const item of sortedImages) {
    inputs.push('-loop', '1', '-t', String(totalDuration), '-i', item.src)
  }

  // Video inputs (trimmed to their in/out points)
  for (const item of sortedVideos) {
    const inPt = item.inPoint ?? 0
    const dur  = (item.outPoint != null)
      ? item.outPoint - inPt
      : (item.end ?? 0) - (item.start ?? 0)
    inputs.push('-ss', String(inPt), '-t', String(dur), '-i', item.src)
  }

  // Puppeteer segment inputs (itsoffset aligns frame 0 with startSeconds on the timeline)
  for (const seg of orderedSegs) {
    inputs.push('-itsoffset', String(seg.startSeconds))
    inputs.push('-i', seg.webmPath)
  }

  // Music
  if (hasMusic) inputs.push('-i', music.src)

  // --- Build filter_complex ---
  const filterParts = []
  let videoLabel
  let audioLabel

  // Step 1: Build base from clips (concat, passthrough, or canvas)
  if (N > 1) {
    const concatIn = Array.from({ length: N }, (_, i) => `[${i}:v][${i}:a]`).join('')
    filterParts.push(`${concatIn}concat=n=${N}:v=1:a=1[base_v][base_a]`)
    videoLabel = '[base_v]'
    audioLabel = '[base_a]'
  } else if (N === 1) {
    videoLabel = '0:v'
    audioLabel = '0:a'
  } else {
    // Canvas project — no base clips; synthesise black video + silent audio
    filterParts.push(`color=black:size=${vw}x${vh}:rate=${fps}:duration=${totalDuration}[base_v]`)
    filterParts.push(`aevalsrc=0:c=stereo:s=44100:d=${totalDuration}[base_a]`)
    videoLabel = '[base_v]'
    audioLabel = '[base_a]'
  }

  // Step 2: Format base for compositing (only when overlays exist)
  const hasAnyOverlays = M > 0 || P > 0 || Q > 0
  if (hasAnyOverlays) {
    // yuv420p10le preserves 10-bit HDR signal (bt2020/HLG) through the overlay chain
    filterParts.push(`[${videoLabel.replace(/[\[\]]/g, '')}]format=yuv420p10le[v0]`)
    videoLabel = '[v0]'
  }

  // Step 3: Image overlays (sorted by trackIdx, lower = further back)
  for (let i = 0; i < sortedImages.length; i++) {
    const item     = sortedImages[i]
    const s        = item.scale ?? 1
    const scaledW  = Math.round(vw * s)
    const scaledH  = Math.round(vh * s)
    const xPx      = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0)))
    const yPx      = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0)))
    const inputIdx = N + i
    const isLast   = (i === M - 1) && P === 0 && Q === 0
    const outLabel = isLast ? '[vout]' : `[vi${i}]`

    filterParts.push(`[${inputIdx}:v]scale=${scaledW}:${scaledH}[img${i}]`)

    let imgLabel = `[img${i}]`
    if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
      filterParts.push(`${imgLabel}colorchannelmixer=aa=${item.opacity}[imgop${i}]`)
      imgLabel = `[imgop${i}]`
    }

    filterParts.push(
      `${videoLabel}${imgLabel}overlay=x=${xPx}:y=${yPx}:enable='between(t,${item.start},${item.end})':shortest=0${outLabel}`
    )
    videoLabel = outLabel
  }

  // Step 4: Video overlays (sorted by trackIdx, lower = further back)
  for (let i = 0; i < sortedVideos.length; i++) {
    const item     = sortedVideos[i]
    const s        = item.scale ?? 1
    const scaledW  = Math.round(vw * s)
    const scaledH  = Math.round(vh * s)
    const xPx      = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0)))
    const yPx      = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0)))
    const inputIdx = N + M + i
    // ProRes 4444 from remove_bg has alpha — use format=auto for correct compositing
    const hasAlpha   = item.src.endsWith('.mov')
    const formatSpec = hasAlpha ? ':format=auto' : ':format=yuv420'
    const isLast     = (i === P - 1) && Q === 0
    const outLabel   = isLast ? '[vout]' : `[vv${i}]`

    filterParts.push(`[${inputIdx}:v]scale=${scaledW}:${scaledH}[vid${i}]`)

    let vidLabel = `[vid${i}]`
    if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
      filterParts.push(`${vidLabel}colorchannelmixer=aa=${item.opacity}[vidop${i}]`)
      vidLabel = `[vidop${i}]`
    }

    filterParts.push(
      `${videoLabel}${vidLabel}overlay=x=${xPx}:y=${yPx}${formatSpec}:enable='between(t,${item.start},${item.end})':shortest=0${outLabel}`
    )
    videoLabel = outLabel
  }

  // Step 4b: Mix audio from non-muted video overlays
  // Each video input is already trimmed to [inPoint, inPoint+dur]; delay it by item.start to place on timeline.
  for (let i = 0; i < sortedVideos.length; i++) {
    const item = sortedVideos[i]
    if (item.muted) continue
    const inputIdx = N + M + i
    const delayMs  = Math.round((item.start ?? 0) * 1000)
    const audioIn  = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`
    filterParts.push(`[${inputIdx}:a]adelay=${delayMs}:all=1[vida${i}]`)
    filterParts.push(`${audioIn}[vida${i}]amix=inputs=2:duration=longest:normalize=0[amix${i}]`)
    audioLabel = `[amix${i}]`
  }

  // Step 5: Puppeteer overlay + caption segments (captions always last)
  for (let i = 0; i < orderedSegs.length; i++) {
    const seg      = orderedSegs[i]
    const inputIdx = N + M + P + i
    const inOver   = `[${inputIdx}:v]`
    const isLast   = i === Q - 1
    const outLabel = isLast ? '[vout]' : `[ov${i}]`
    const s        = seg.scale ?? 1
    const pr       = seg.pixelRatio ?? 1
    const xPx      = Math.round(vw * (0.5 * (1 - s) + (seg.offsetX ?? 0) / 100))
    const yPx      = Math.round(vh * (0.5 * (1 - s) + (seg.offsetY ?? 0) / 100))

    // Force yuva420p — VP9 decoders may silently drop the alpha plane
    const fmtLabel = `[fmt${i}]`
    filterParts.push(`${inOver}format=yuva420p${fmtLabel}`)

    let overlayInput = fmtLabel
    // Apply pixelRatio upscaling + user scale
    const totalScale = s * pr
    if (Math.abs(totalScale - 1) > 0.001) {
      const scaledLabel = `[sc${i}]`
      filterParts.push(`${fmtLabel}scale=iw*${totalScale}:ih*${totalScale}${scaledLabel}`)
      overlayInput = scaledLabel
    }

    // enable='between()': passes base through without consuming overlay input when outside window
    filterParts.push(
      `${videoLabel}${overlayInput}overlay=x=${xPx}:y=${yPx}:format=yuv420:enable='between(t,${seg.startSeconds},${seg.endSeconds})':shortest=0${outLabel}`
    )
    videoLabel = outLabel
  }

  // Step 6: Audio — music ducking/mixing
  if (hasMusic) {
    const vol = music.volume ?? 0.15

    if (music.ducking?.enabled) {
      const depth   = music.ducking.depth   ?? -12
      const attack  = music.ducking.attack  ?? 0.3
      const release = music.ducking.release ?? 0.5
      const audioIn = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`
      filterParts.push(
        `${audioIn}asplit=2[speech][sc];` +
        `[${musicInputIdx}:a]volume=${vol}[mscaled];` +
        `[mscaled][sc]sidechaincompress=threshold=0.02:ratio=4:attack=${attack * 1000}:release=${release * 1000}[ducked];` +
        `[speech][ducked]amix=inputs=2:duration=first[aout]`
      )
      audioLabel = '[aout]'
    } else {
      const audioIn = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`
      filterParts.push(
        `${audioIn}[${musicInputIdx}:a]amix=inputs=2:weights='1 ${vol}'[aout]`
      )
      audioLabel = '[aout]'
    }
  }

  // --- Assemble ffmpeg args ---
  // VideoToolbox produces corrupted output with filter_complex overlay pipelines — hardcode libx264.
  // Encode at 10-bit to preserve source HDR signal (bt2020/HLG).
  const videoCodecArgs = [
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p10le',
    '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67',
  ]

  const ffmpegArgs = ['-y', ...inputs]

  if (filterParts.length > 0) {
    ffmpegArgs.push('-filter_complex', filterParts.join(';'))
  }

  // Map video: if overlays produced a named label use it, else map directly
  if (hasAnyOverlays) {
    ffmpegArgs.push('-map', '[vout]')
  } else {
    // videoLabel is still the raw base label (e.g. '0:v' or '[base_v]')
    ffmpegArgs.push('-map', videoLabel)
  }

  // Map audio
  if (audioLabel.startsWith('[')) {
    ffmpegArgs.push('-map', audioLabel)
  } else {
    // audioLabel is a raw stream selector like '0:a'
    ffmpegArgs.push('-map', `${audioLabel}?`)
  }

  ffmpegArgs.push(
    ...videoCodecArgs,
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  )

  process.stderr.write(
    `[montaj compose] running ffmpeg: ${N} base clip(s), ${M} image(s), ${P} video(s), ${Q} Puppeteer segment(s)...\n`
  )

  const result = spawnSync('ffmpeg', ffmpegArgs, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  // Always log ffmpeg stderr — warnings explain missing overlays, format issues, etc.
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
