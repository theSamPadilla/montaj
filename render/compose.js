/**
 * compose.js — Build and execute the final ffmpeg filter graph.
 *
 * Inputs:
 *   - baseTrackClips: array of clip objects from tracks[0] (primary footage clips with explicit start/end)
 *   - puppeteerSegments: rendered MKV/WebM overlay + caption segments from Puppeteer
 *   - imageItems: direct image overlay inputs
 *   - videoItems: direct video overlay inputs
 *   - optionally: music file (from projectJson.audio.music)
 *
 * Output:
 *   - final MP4 (H.264, CRF 18, AAC audio)
 */
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'

const FFMPEG_TIMEOUT_MS     = 600_000
const COMPOSE_CHUNK_SECS    = 30  // seconds per compositing pass when chunking
const CHUNK_VIDEO_THRESHOLD = 5   // auto-chunk when video item count exceeds this

const TTY = process.stderr.isTTY
const C = {
  green: TTY ? '\x1b[92m' : '', dim: TTY ? '\x1b[2m' : '', reset: TTY ? '\x1b[0m' : '',
}
function clog(msg)  { process.stderr.write(`${C.green}[montaj compose]${C.reset} ${msg}\n`) }
function fflog(msg) { process.stderr.write(`${C.dim}[montaj ffmpeg]${C.reset} ${msg}\n`) }

// Only surface ffmpeg lines that carry actionable signal — suppress banner/input listing.
const FFMPEG_SIGNAL = /warning|error|invalid|failed|matches no streams|^\[.*@/i
function logFfmpegStderr(stderr) {
  for (const line of stderr.split('\n')) {
    if (line.trim() && FFMPEG_SIGNAL.test(line)) fflog(line)
  }
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i

/** True if the item should be treated as a still image (looped, no audio).
 *  Checks both item.type and the file extension — project JSON sometimes stores
 *  still images (jpg/png backgrounds) with type:'video'. */
function isImageItem(item) {
  return item.type === 'image' || IMAGE_EXTENSIONS.test(item.src)
}

/**
 * Compute total video duration from all items.
 */
function computeTotalDuration(imageItems, videoItems, puppeteerSegments) {
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
 * @param {Array}    opts.puppeteerSegments     — rendered WebM/MKV segments from Puppeteer
 * @param {Array}    opts.imageItems            — image items from all tracks, with trackIdx
 * @param {Array}    opts.videoItems            — video items from all tracks, with trackIdx
 * @param {string}   opts.outputPath
 * @param {number}   [opts.videoWidth]
 * @param {number}   [opts.videoHeight]
 */
export async function compose({
  projectJson,
  puppeteerSegments,
  imageItems,
  videoItems,
  outputPath,
  videoWidth,
  videoHeight,
  _dryRun  = false,
  _lossless = false,  // When true: output FFV1 MKV (intra-only, concat-safe chunk intermediates)
}) {
  mkdirSync(dirname(outputPath), { recursive: true })

  const music    = projectJson.audio?.music
  const hasMusic = !!(music?.src)

  const vw  = videoWidth  ?? projectJson.settings?.resolution?.[0] ?? 1080
  const vh  = videoHeight ?? projectJson.settings?.resolution?.[1] ?? 1920
  const fps = projectJson.settings?.fps ?? 30

  // Auto-chunk when too many simultaneous video decodes would exhaust memory.
  // Each ProRes 4444 input at 4K is ~50 MB/frame decoded; CHUNK_VIDEO_THRESHOLD concurrent
  // inputs fit comfortably in ~8 GB; beyond that we split into time windows.
  if (!_dryRun && !_lossless && videoItems.length > CHUNK_VIDEO_THRESHOLD) {
    return composeChunked({ projectJson, puppeteerSegments, imageItems, videoItems, outputPath, videoWidth: vw, videoHeight: vh })
  }

  // Merge all items and sort by trackIdx (lower = further back), then by start time within track
  const sortedItems = [...imageItems, ...videoItems].sort((a, b) =>
    a.trackIdx !== b.trackIdx ? a.trackIdx - b.trackIdx : (a.start ?? 0) - (b.start ?? 0)
  )
  const N = sortedItems.length

  // Captions always composited last (on top of everything)
  const overlaySegs = puppeteerSegments.filter(s => !s.isCaption)
  const captionSegs = puppeteerSegments.filter(s => s.isCaption)
  const orderedSegs = [...overlaySegs, ...captionSegs]

  const Q = orderedSegs.length
  const musicInputIdx = N + Q

  const totalDuration = computeTotalDuration(imageItems, videoItems, puppeteerSegments)

  // --- Build input list ---
  const inputs = []

  // All items (images + videos) from all tracks, sorted by trackIdx.
  // Images are looped for the full duration; videos are trimmed and timestamp-shifted
  // so frame 0 lands at item.start on the output timeline.
  for (const item of sortedItems) {
    if (isImageItem(item)) {
      inputs.push('-loop', '1', '-t', String(totalDuration), '-i', item.src)
    } else {
      const inPt  = item.inPoint ?? 0
      const outPt = item.outPoint ?? (inPt + (item.end ?? 0) - (item.start ?? 0))
      // Use -to (absolute file timestamp) instead of -t (duration from seek point).
      // Fast seek lands on the keyframe before inPt; -t would count from there and
      // clip the end short by however far back the keyframe was. -to stops at the
      // exact file timestamp regardless of where the keyframe landed.
      // No -itsoffset: we handle video PTS via setpts in the filter graph and
      // audio PTS via asetpts+adelay. itsoffset shifts both streams but amix
      // drops inputs whose first frame arrives late in the filter timeline.
      inputs.push('-ss', String(inPt), '-to', String(outPt), '-i', item.src)
    }
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

  // Step 1: Black canvas for full duration
  filterParts.push(`color=black:size=${vw}x${vh}:rate=${fps}:duration=${totalDuration}[canvas_v]`)
  filterParts.push(`aevalsrc=0:c=stereo:s=44100:d=${totalDuration}[canvas_a]`)
  videoLabel = '[canvas_v]'
  audioLabel = '[canvas_a]'

  // Step 2: Format canvas for compositing (yuv420p10le preserves HDR signal)
  if (N > 0 || Q > 0) {
    filterParts.push(`[canvas_v]format=yuv420p10le[v0]`)
    videoLabel = '[v0]'
  }

  // Step 3: Composite all items in trackIdx order (lower trackIdx = further back).
  // Images and videos are handled uniformly — no special treatment for any track index.
  for (let i = 0; i < N; i++) {
    const item    = sortedItems[i]
    const s       = item.scale ?? 1
    const scaledW = Math.round(vw * s / 2) * 2
    const scaledH = Math.round(vh * s / 2) * 2
    const xPx     = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0) / 100))
    const yPx     = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0) / 100))
    const isLast  = i === N - 1 && Q === 0
    const outV    = isLast ? '[vout]' : `[iv${i}]`

    if (isImageItem(item)) {
      filterParts.push(`[${i}:v]format=rgba,scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,pad=${scaledW}:${scaledH}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[img${i}]`)
      let src = `[img${i}]`
      if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
        filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[imgop${i}]`)
        src = `[imgop${i}]`
      }
      filterParts.push(`${videoLabel}${src}overlay=x=${xPx}:y=${yPx}:enable='between(t,${item.start},${item.end})':shortest=0${outV}`)
    } else {
      // ProRes 4444 (.mov) from remove_bg has alpha — use format=auto
      const fmt = item.src.endsWith('.mov') ? ':format=auto' : ':format=yuv420'
      // setpts shifts video frames to the correct output timeline position.
      // (Without -itsoffset, frames arrive at PTS≈0; setpts moves them to item.start.)
      filterParts.push(`[${i}:v]setpts=PTS-STARTPTS+(${item.start}/TB)[vpts${i}]`)
      filterParts.push(`[vpts${i}]scale=${scaledW}:${scaledH}[vid${i}]`)
      let src = `[vid${i}]`
      if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
        filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[vidop${i}]`)
        src = `[vidop${i}]`
      }
      filterParts.push(`${videoLabel}${src}overlay=x=${xPx}:y=${yPx}${fmt}:enable='between(t,${item.start},${item.end})':shortest=0${outV}`)
      // Audio: asetpts normalises PTS to 0 (seek may leave non-zero PTS), then
      // adelay inserts silence so amix sees a continuous stream from t=0.
      if (!item.muted) {
        const delayMs = Math.round((item.start ?? 0) * 1000)
        const audioIn = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`
        filterParts.push(`[${i}:a]asetpts=PTS-STARTPTS[apts${i}]`)
        filterParts.push(`[apts${i}]adelay=${delayMs}:all=1[vida${i}]`)
        filterParts.push(`${audioIn}[vida${i}]amix=inputs=2:duration=longest:normalize=0[amix${i}]`)
        audioLabel = `[amix${i}]`
      }
    }
    videoLabel = outV
  }

  // Step 4: Puppeteer overlay + caption segments (captions always last)
  for (let i = 0; i < orderedSegs.length; i++) {
    const seg      = orderedSegs[i]
    const inputIdx = N + i
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

  // --- Stamp color metadata via setparams (output stream flags are overridden by the black
  //     canvas in filter_complex which has no color metadata). setparams inside the filter
  //     graph takes precedence over the canvas's unset color info.
  //     Only for the final H.264 encode — lossless FFV1 chunks pass through unmodified.
  if (!_lossless) {
    const preLabel = (N > 0 || Q > 0) ? '[vout]' : videoLabel
    filterParts.push(`${preLabel}setparams=colorspace=bt709:color_trc=arib-std-b67:color_primaries=bt2020[vout_sp]`)
    videoLabel = '[vout_sp]'
  }

  // --- Assemble ffmpeg args ---
  // _lossless: FFV1 MKV for intra-only chunk intermediates (concat-safe, no B-frame DTS issues).
  // Default: libx264 MP4 — color metadata is stamped via setparams in the filter graph above.
  const videoCodecArgs = _lossless
    ? ['-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', '-reserve_index_space', '1000000']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p']
  const audioCodecArgs = _lossless
    ? ['-c:a', 'pcm_s16le']
    : ['-c:a', 'aac', '-b:a', '192k']

  const ffmpegArgs = ['-y', ...inputs]

  if (filterParts.length > 0) {
    ffmpegArgs.push('-filter_complex', filterParts.join(';'))
  }

  // Map video — videoLabel is always current (updated by setparams step above for non-lossless)
  if (filterParts.length > 0) {
    ffmpegArgs.push('-map', videoLabel)
  }

  // Map audio
  if (audioLabel.startsWith('[')) {
    ffmpegArgs.push('-map', audioLabel)
  } else {
    // audioLabel is a raw stream selector like '0:a'
    ffmpegArgs.push('-map', `${audioLabel}?`)
  }

  ffmpegArgs.push(...videoCodecArgs, ...audioCodecArgs)
  // Cap output at exactly totalDuration — overlay=shortest=0 allows NUT files that span a chunk
  // boundary to extend the canvas beyond its intended duration (extra frames, audio drift).
  ffmpegArgs.push('-t', String(totalDuration))
  if (!_lossless) ffmpegArgs.push('-movflags', '+faststart')
  ffmpegArgs.push(outputPath)

  if (_dryRun) return { inputs, filterParts, ffmpegArgs }

  const nImages = sortedItems.filter(i => isImageItem(i)).length
  const nVideos = sortedItems.filter(i => !isImageItem(i)).length
  clog(`running ffmpeg: ${nImages} image(s), ${nVideos} video(s), ${Q} Puppeteer segment(s)...`)

  // Write to a unique temp path, then atomically rename — prevents concurrent renders
  // from partially overwriting each other's output.
  // Insert hash before extension so ffmpeg's format detection still works (e.g. .mkv, .mp4).
  const tmpPath = outputPath.replace(/(\.\w+)$/, `.${randomBytes(4).toString('hex')}$1`)
  ffmpegArgs[ffmpegArgs.length - 1] = tmpPath  // replace outputPath with tmpPath

  const result = spawnSync('ffmpeg', ffmpegArgs, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  if (result.stderr) logFfmpegStderr(result.stderr)

  if (result.status !== 0) {
    rmSync(tmpPath, { force: true })
    throw new Error(`ffmpeg compose failed:\n${result.stderr}`)
  }

  renameSync(tmpPath, outputPath)
  return outputPath
}

// ---------------------------------------------------------------------------
// Chunked compositing — splits the timeline to cap simultaneous video decodes
// ---------------------------------------------------------------------------

async function composeChunked({ projectJson, puppeteerSegments, imageItems, videoItems, outputPath, videoWidth, videoHeight }) {
  const music       = projectJson.audio?.music
  const hasMusic    = !!(music?.src)
  const totalDuration = computeTotalDuration(imageItems, videoItems, puppeteerSegments)
  const numChunks   = Math.ceil(totalDuration / COMPOSE_CHUNK_SECS)

  clog(
    `chunking ${totalDuration.toFixed(1)}s into ${numChunks} pass(es) ` +
    `(${videoItems.length} video inputs exceed threshold of ${CHUNK_VIDEO_THRESHOLD})`
  )

  const chunkPaths = []

  for (let ci = 0; ci < numChunks; ci++) {
    const t0 = ci * COMPOSE_CHUNK_SECS
    const t1 = Math.min(t0 + COMPOSE_CHUNK_SECS, totalDuration)
    // FFV1 MKV: intra-only → safe for stream-copy concat at chunk boundaries
    const chunkPath = outputPath.replace(/(\.\w+)$/, `_chunk${ci}.mkv`)
    chunkPaths.push(chunkPath)

    // Items overlapping with [t0, t1)
    const chunkImages = imageItems.filter(item => (item.start ?? 0) < t1 && (item.end ?? 0) > t0)
    const chunkVideos = videoItems.filter(item => (item.start ?? 0) < t1 && (item.end ?? 0) > t0)
    const chunkSegs   = puppeteerSegments.filter(seg => seg.startSeconds < t1 && seg.endSeconds > t0)

    clog(
      `pass ${ci + 1}/${numChunks} (t=${t0.toFixed(1)}–${t1.toFixed(1)}s): ` +
      `${chunkImages.length} image(s), ${chunkVideos.length} video(s), ${chunkSegs.length} seg(s)`
    )

    // Remap timestamps to chunk-relative [0, t1-t0]
    const adjImages = chunkImages.map(item => ({
      ...item,
      start: Math.max(item.start ?? 0, t0) - t0,
      end:   Math.min(item.end ?? totalDuration, t1) - t0,
    }))

    const adjVideos = chunkVideos.map(item => {
      const itemStart = item.start ?? 0
      const relStart  = Math.max(itemStart, t0) - t0
      const relEnd    = Math.min(item.end ?? totalDuration, t1) - t0
      const inPt      = item.inPoint ?? 0
      // Advance source seek position by however much of this clip preceded t0
      const newInPt   = inPt + Math.max(0, t0 - itemStart)
      return { ...item, start: relStart, end: relEnd, inPoint: newInPt, outPoint: newInPt + (relEnd - relStart) }
    })

    // startSeconds may be negative for segments whose start precedes t0 — itsoffset handles it
    const adjSegs = chunkSegs.map(seg => ({
      ...seg,
      startSeconds: seg.startSeconds - t0,
      endSeconds:   Math.min(seg.endSeconds, t1) - t0,
    }))

    // Each chunk is composed without music; music is mixed in the final pass
    const chunkProject = { ...projectJson, audio: undefined }

    await compose({
      projectJson:       chunkProject,
      puppeteerSegments: adjSegs,
      imageItems:        adjImages,
      videoItems:        adjVideos,
      outputPath:        chunkPath,
      videoWidth,
      videoHeight,
      _lossless:         true,
    })
  }

  // Concat chunks → preMusicPath
  const preMusicPath = hasMusic ? outputPath.replace(/(\.\w+)$/, '_nomusic$1') : outputPath
  concatVideoFiles(chunkPaths, preMusicPath)
  if (!process.env.MONTAJ_KEEP_CHUNKS) {
    for (const p of chunkPaths) rmSync(p, { force: true })
  }

  // Add music in a final re-mux pass (video stream copied, no re-encode)
  if (hasMusic) {
    mixMusicIntoVideo(preMusicPath, music, outputPath)
    rmSync(preMusicPath, { force: true })
  }

  return outputPath
}

function concatVideoFiles(paths, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true })
  const listFile = outputPath + '.concat.txt'
  writeFileSync(listFile, paths.map(p => `file '${p}'`).join('\n'))
  // Inputs are FFV1 MKV (intra-only) — concat demuxer is safe.
  // Re-encode to H.264 MP4 here; `-c copy` on B-frame streams breaks DTS at boundaries.
  clog(`concatenating ${paths.length} chunk(s) → final H.264 encode...`)
  const tmpPath = outputPath.replace(/(\.\w+)$/, `.${randomBytes(4).toString('hex')}$1`)
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'setparams=colorspace=bt709:color_trc=arib-std-b67:color_primaries=bt2020',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', tmpPath,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
  rmSync(listFile, { force: true })
  if (result.stderr) logFfmpegStderr(result.stderr)
  if (result.status !== 0) {
    rmSync(tmpPath, { force: true })
    throw new Error(`ffmpeg concat failed:\n${result.stderr}`)
  }
  renameSync(tmpPath, outputPath)
}

function mixMusicIntoVideo(videoPath, music, outputPath) {
  const vol = music.volume ?? 0.15
  let filterStr
  if (music.ducking?.enabled) {
    const depth   = music.ducking.depth   ?? -12
    const attack  = music.ducking.attack  ?? 0.3
    const release = music.ducking.release ?? 0.5
    filterStr = (
      `[0:a]asplit=2[speech][sc];` +
      `[1:a]volume=${vol}[mscaled];` +
      `[mscaled][sc]sidechaincompress=threshold=0.02:ratio=4:attack=${attack * 1000}:release=${release * 1000}[ducked];` +
      `[speech][ducked]amix=inputs=2:duration=first[aout]`
    )
  } else {
    filterStr = `[0:a][1:a]amix=inputs=2:weights='1 ${vol}':duration=first[aout]`
  }
  const result = spawnSync('ffmpeg', [
    '-y', '-i', videoPath, '-i', music.src,
    '-filter_complex', filterStr,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', outputPath,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
  if (result.stderr) logFfmpegStderr(result.stderr)
  if (result.status !== 0) throw new Error(`ffmpeg music mix failed:\n${result.stderr}`)
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

export { computeTotalDuration }

