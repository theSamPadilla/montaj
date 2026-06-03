// render/encode-segment.js
/**
 * Encode a single timeline segment to MP4 in the project's working color space.
 *
 * Each call composites:
 *   - N visual items: layered by trackIdx (lower = background). Each item has
 *     scale, offsetX, offsetY, opacity. Images loop, videos seek+trim.
 *   - 0-N overlays: Puppeteer-rendered MKV/WebM with alpha, positioned via
 *     offsetX, offsetY, scale, pixelRatio (matching current compose.js:244-263).
 *     Captions are always last (topmost z-layer) — ensured by planSegments.
 *   - Audio: extracted from ALL unmuted video items with audio and mixed via amix.
 *     When only one item has audio, it's used directly (no amix overhead).
 *     When multiple items have audio, they're combined with
 *     amix=inputs=N:duration=longest:normalize=0 — matching the pattern in mix-audio.js.
 *
 * Output codec / pix_fmt / color metadata follow the project's color space:
 *   - sdr_bt709 → libx264 yuv420p bt709
 *   - hdr_hlg   → libx265 yuv420p10le bt2020nc / arib-std-b67 (HLG)
 *   - hdr_pq    → libx265 yuv420p10le bt2020nc / smpte2084 (PQ) + static HDR10 metadata
 *
 * All segments from a single render share the project's working codec, so concat
 * with -c:v copy is safe (uniform format invariant holds, just per-project now).
 *
 * Per-item color conversion: when an item's source color space differs from the
 * project's color space, a conversion filter is injected before the per-item scale
 * step. The source's color_transfer is read from item.colorTransfer (stamped by
 * render.js during the videoItems collection pass) — no per-segment ffprobe.
 */
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { specFor, detectFromTransfer, DEFAULT_COLOR_SPACE } from './color-space.js'

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

// Cache the ffmpeg-has-zscale check across calls — it doesn't change between segments.
let _zscaleCache = null
function hasZscale() {
  if (_zscaleCache !== null) return _zscaleCache
  const result = spawnSync('ffmpeg', ['-hide_banner', '-filters'], {
    encoding: 'utf8', timeout: 5000,
  })
  _zscaleCache = result.status === 0 && /^[A-Z. ]+ zscale\b/m.test(result.stdout || '')
  return _zscaleCache
}

/**
 * Build the ffmpeg filter chain to convert a source's color space to the project's.
 * Returns an empty string when src === dst (no conversion needed). Mirrors the
 * Python _build_color_conversion_vf() in lib/normalize.py.
 *
 * The hasZscale flag controls the HDR→SDR fallback path — without zscale, the
 * tonemap is degraded (washed out highlights). The Python loader emits a loud
 * warning when this fallback runs at intake; segment-encoder usage is more
 * limited (only kicks in when intake didn't already convert), and warnings here
 * would spam render logs once per segment, so we silently fall back.
 */
export function buildColorConversionFilter(srcKey, dstKey, hasZscaleFlag) {
  if (srcKey === dstKey) return ''
  // HDR → SDR
  if ((srcKey === 'hdr_hlg' || srcKey === 'hdr_pq') && dstKey === 'sdr_bt709') {
    if (hasZscaleFlag) {
      return 'zscale=t=linear:npl=100,format=gbrpf32le,'
           + 'zscale=p=bt709,tonemap=hable:desat=0,'
           + 'zscale=t=bt709:m=bt709:r=tv'
    }
    return 'format=p010le,tonemap=hable:desat=0'
  }
  // SDR → HDR
  if (srcKey === 'sdr_bt709' && (dstKey === 'hdr_hlg' || dstKey === 'hdr_pq')) {
    const dstTransfer = dstKey === 'hdr_hlg' ? 'arib-std-b67' : 'smpte2084'
    return `zscale=t=${dstTransfer}:p=bt2020:m=bt2020nc`
  }
  // HDR ↔ HDR
  if ((srcKey === 'hdr_hlg' || srcKey === 'hdr_pq')
      && (dstKey === 'hdr_hlg' || dstKey === 'hdr_pq')) {
    const dstTransfer = dstKey === 'hdr_hlg' ? 'arib-std-b67' : 'smpte2084'
    return `zscale=t=${dstTransfer}`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Shared filter helpers
// Extracted so sample-frame.js can import and call them without duplicating
// the filter-graph logic. Each helper returns { inputArgs, filterParts,
// newVideoLabel }. Callers append inputArgs to their inputs array and push
// filterParts into their filterParts array.
// ---------------------------------------------------------------------------

/**
 * Build filter-graph parts for one image item.
 *
 * @param {object} item       — the image item from segment.items
 * @param {number} vw         — canvas width  (pixels)
 * @param {number} vh         — canvas height (pixels)
 * @param {number} idx        — ffmpeg input index for this item
 * @param {string} videoLabel — current composite label, e.g. '[canvas]'
 * @param {number} duration   — segment duration in seconds (used for -t)
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
export function buildImageItemFilterParts(item, vw, vh, idx, videoLabel, duration) {
  const s       = item.scale ?? 1
  const scaledW = Math.round(vw * s / 2) * 2
  const scaledH = Math.round(vh * s / 2) * 2
  const xPx     = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0) / 100))
  const yPx     = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0) / 100))

  const inputArgs = ['-loop', '1', '-t', String(duration), '-i', item.src]
  const filterParts = []

  filterParts.push(`[${idx}:v]scale=${scaledW}:${scaledH},format=rgba,setpts=PTS-STARTPTS[img${idx}]`)
  let src = `[img${idx}]`
  if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[imgop${idx}]`)
    src = `[imgop${idx}]`
  }
  filterParts.push(`${videoLabel}${src}overlay=x=${xPx}:y=${yPx}:shortest=0[iv${idx}]`)
  const newVideoLabel = `[iv${idx}]`

  return { inputArgs, filterParts, newVideoLabel }
}

/**
 * Build filter-graph parts for one video clip item.
 * Does NOT include the audio extraction step — that stays in the caller.
 *
 * @param {object} item             — the video item from segment.items
 * @param {number} vw               — canvas width  (pixels)
 * @param {number} vh               — canvas height (pixels)
 * @param {number} idx              — ffmpeg input index for this item
 * @param {string} videoLabel       — current composite label, e.g. '[canvas]'
 * @param {object} opts
 * @param {number}  opts.segStart         — segment.start (seconds)
 * @param {number}  opts.duration         — segment duration (seconds)
 * @param {string}  opts.projectColorSpace — e.g. 'sdr_bt709'
 * @param {boolean} opts.zscaleAvailable  — whether ffmpeg has zscale
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
export function buildVideoItemFilterParts(item, vw, vh, idx, videoLabel, opts) {
  const { segStart, duration, projectColorSpace, zscaleAvailable } = opts

  const s       = item.scale ?? 1
  const scaledW = Math.round(vw * s / 2) * 2
  const scaledH = Math.round(vh * s / 2) * 2
  const xPx     = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0) / 100))
  const yPx     = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0) / 100))

  const inPt = item.inPoint ?? 0
  const seekOffset = Math.max(0, segStart - item.start)
  const actualIn = inPt + seekOffset

  // ProRes 4444 (.mov from remove-bg) has alpha — use format=auto
  const ovFmt = item.src.endsWith('.mov') ? ':format=auto' : ':format=yuv420'

  const itemColorSpace = detectFromTransfer(item.colorTransfer)
  const skipConversionForAlpha = item.remove_bg && item.nobg_src
  const conversionFilter = skipConversionForAlpha
    ? ''
    : buildColorConversionFilter(itemColorSpace, projectColorSpace, zscaleAvailable)
  const conversionStep = conversionFilter ? `${conversionFilter},` : ''

  // -err_detect ignore_err + -max_error_rate 1.0: tolerate broken audio
  // packets from iPhone .MOV sources (see encodeSegment for full comment).
  const inputArgs = [
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-ss', String(actualIn), '-t', String(duration), '-i', item.src,
  ]
  const filterParts = []

  filterParts.push(
    `[${idx}:v]setpts=PTS-STARTPTS,${conversionStep}` +
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,` +
    `pad=${scaledW}:${scaledH}:(ow-iw)/2:(oh-ih)/2[vid${idx}]`
  )
  let src = `[vid${idx}]`
  if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[vidop${idx}]`)
    src = `[vidop${idx}]`
  }
  filterParts.push(`${videoLabel}${src}overlay=x=${xPx}:y=${yPx}${ovFmt}:shortest=0[iv${idx}]`)
  const newVideoLabel = `[iv${idx}]`

  return { inputArgs, filterParts, newVideoLabel }
}

/**
 * Build filter-graph parts for one JSX overlay (rendered as WebM/MKV with alpha).
 *
 * @param {object} ov         — overlay descriptor from segment.overlays
 * @param {number} vw         — canvas width  (pixels)
 * @param {number} vh         — canvas height (pixels)
 * @param {number} ovIdx      — ffmpeg input index for this overlay
 * @param {string} videoLabel — current composite label
 * @param {number} segStart   — segment.start (seconds), used to compute seek offset
 * @param {number} duration   — segment duration (seconds)
 * @param {object} [opts]
 * @param {string} [opts.inputFormatFlag='yuva420p'] — pixel-format conversion applied to
 *   the overlay input before scale/composite. Default `yuva420p` is the production
 *   render's setting — VP9 decoders may silently drop the alpha plane otherwise.
 *   Callers operating on already-alpha-bearing inputs (e.g. the `sample-frame.js`
 *   mini-composer, which feeds PNG screenshots not VP9) should pass `'rgba'`.
 * @param {string} [opts.compositeFormatFlag='yuv420'] — `format=` flag on the final
 *   overlay step. Default `yuv420` matches production (output is composited onto a
 *   yuv420 video chain). Callers building PNG output should pass `'auto'`.
 * @param {boolean} [opts.loopedInput=false] — when true, emit `-loop 1 -t <duration> -i`
 *   input args instead of the default `-ss <seek> -t <duration> -i` pair. Use for
 *   single-frame PNG overlay inputs (sample-frame.js's overlay path); leave false for
 *   VP9/MKV overlay segments coming from the production renderer chunk pipeline.
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
export function buildOverlayFilterParts(ov, vw, vh, ovIdx, videoLabel, segStart, duration, opts = {}) {
  const inputFormatFlag     = opts.inputFormatFlag     ?? 'yuva420p'
  const compositeFormatFlag = opts.compositeFormatFlag ?? 'yuv420'
  const loopedInput         = opts.loopedInput         ?? false

  const inputArgs = loopedInput
    ? ['-loop', '1', '-t', String(duration), '-i', ov.webmPath]
    : ['-ss', String(Math.max(0, segStart - ov.startSeconds)), '-t', String(duration), '-i', ov.webmPath]
  const filterParts = []

  // Overlay positioning: pixelRatio upscaling + user scale + offset
  // Matches current compose.js:244-263
  const ovScale    = ov.scale ?? 1
  const ovPr       = ov.pixelRatio ?? 1
  const totalScale = ovScale * ovPr
  const ovXPx      = Math.round(vw * (0.5 * (1 - ovScale) + (ov.offsetX ?? 0) / 100))
  const ovYPx      = Math.round(vh * (0.5 * (1 - ovScale) + (ov.offsetY ?? 0) / 100))

  // Force yuva420p (or caller-specified format) — VP9 decoders may silently drop
  // the alpha plane on the production path; PNG-based callers pass 'rgba' to
  // avoid an unnecessary colorspace bounce.
  filterParts.push(`[${ovIdx}:v]format=${inputFormatFlag}[ovfmt${ovIdx}]`)
  let ovSrc = `[ovfmt${ovIdx}]`

  // Apply pixelRatio + scale
  if (Math.abs(totalScale - 1) > 0.001) {
    filterParts.push(`${ovSrc}scale=iw*${totalScale}:ih*${totalScale}[ovsc${ovIdx}]`)
    ovSrc = `[ovsc${ovIdx}]`
  }

  filterParts.push(
    `${videoLabel}${ovSrc}overlay=x=${ovXPx}:y=${ovYPx}:format=${compositeFormatFlag}:shortest=0[vov${ovIdx}]`
  )
  const newVideoLabel = `[vov${ovIdx}]`

  return { inputArgs, filterParts, newVideoLabel }
}

/**
 * @param {object} segment — from planSegments(); may carry a colorSpace key
 *   (project working color space). Defaults to sdr_bt709 when missing.
 * @param {string} outputPath
 * @param {object} [opts]
 * @param {boolean} [opts._dryRun] — return { inputs, filterParts, args } without executing
 * @returns {string | object} outputPath, or dry-run result
 */
export function encodeSegment(segment, outputPath, opts = {}) {
  const { start, end, items, overlays, vw, vh, fps } = segment
  // When an opaque overlay covers this segment, the overlay replaces the frame
  // but the underlying items still contribute their AUDIO. opaqueVideo gates the
  // VIDEO compositing of items only — never their audio. Defaults to false so
  // pre-existing callers/tests (which don't set it) keep their behaviour.
  const opaqueVideo = segment.opaqueVideo ?? false
  const duration = end - start
  const projectColorSpace = segment.colorSpace ?? DEFAULT_COLOR_SPACE
  const spec = specFor(projectColorSpace)
  const zscaleAvailable = opts._dryRun ? true : hasZscale()

  if (!opts._dryRun) mkdirSync(dirname(outputPath), { recursive: true })

  const inputs = []
  const filterParts = []
  let videoLabel
  const audioLabels = []
  // Items eligible for `-c:a copy` instead of running through the encoder.
  // Populated in Step 2 (video items loop). Step 5 decides whether to use them.
  const streamCopyCandidates = []
  let inputIdx = 0

  // --- Step 1: Black canvas base (always present — items layer on top) ---
  // Canvas format follows the project's working pix_fmt so item layers can
  // composite without forced bit-depth conversion.
  inputs.push('-f', 'lavfi', '-i',
    `color=black:size=${vw}x${vh}:rate=${fps}:duration=${duration}`)
  filterParts.push(`[0:v]format=${spec.outputPixFmt}[canvas]`)
  videoLabel = '[canvas]'
  inputIdx++

  // --- Step 2: Visual items layered in trackIdx order (lower = background) ---
  for (let ii = 0; ii < items.length; ii++) {
    const item = items[ii]
    const idx  = inputIdx

    if (isImageItem(item)) {
      // Under an opaque overlay the frame is fully covered and images carry no
      // audio, so an image item contributes nothing here — skip it entirely
      // (no input, no inputIdx bump).
      if (opaqueVideo) continue
      const { inputArgs, filterParts: fp, newVideoLabel } =
        buildImageItemFilterParts(item, vw, vh, idx, videoLabel, duration)
      inputs.push(...inputArgs)
      filterParts.push(...fp)
      videoLabel = newVideoLabel
    } else {
      // Video clip
      // Per-item color conversion: when the source's color space differs from
      // the project's, inject the conversion filter (tonemap / inverse-stretch /
      // HDR cross). item.colorTransfer is stamped during render.js's videoItems
      // collection pass — no per-segment ffprobe.
      //
      // EXCEPTION: skip color conversion for remove_bg items. Their `src` is a
      // ProRes 4444 alpha file (yuva422p10le / yuva444p10le) and zscale (libzimg)
      // does not accept alpha pixel formats — the pipeline errors out with
      // "Generic error in an external library / Could not open encoder before
      // EOF". Splitting alpha from YUV, converting YUV through zscale, then
      // recombining is doable but complex; for v1 we accept that bg-removed
      // SDR content composites into HDR canvas as-is. The segment output is
      // still tagged HLG/PQ at the container level, so players treat the cutout
      // pixels as SDR-on-HDR-canvas (slightly lifted highlights but watchable).
      // Sources that aren't bg-removed go through the normal conversion path.
      const { inputArgs, filterParts: fp, newVideoLabel } =
        buildVideoItemFilterParts(item, vw, vh, idx, videoLabel, {
          segStart: start,
          duration,
          projectColorSpace,
          zscaleAvailable,
        })
      // The input (carrying its -ss/-t window) is ALWAYS added so the clip's
      // audio is available to Step 5. Its VIDEO is composited only when the
      // frame is NOT covered by an opaque overlay — opaque replaces the picture,
      // it must not silence the voiceover underneath.
      inputs.push(...inputArgs)
      if (!opaqueVideo) {
        filterParts.push(...fp)
        videoLabel = newVideoLabel
      }

      // Audio from ALL unmuted video items — collected here, mixed in Step 5.
      // Runs regardless of opaqueVideo so audio survives full-screen animations.
      // In dry-run mode, skip the ffprobe check (file may not exist) and assume audio present.
      if (!item.muted && (opts._dryRun || fileHasAudio(item.src))) {
        const vol = item.volume ?? 1.0
        const aLabel = `a${idx}`
        filterParts.push(`[${idx}:a:0]asetpts=PTS-STARTPTS,volume=${vol},aformat=channel_layouts=stereo:sample_rates=48000[${aLabel}]`)
        audioLabels.push(`[${aLabel}]`)
        // Track if this source could be stream-copied (single source, vol=1,
        // came from our audio-strip pre-pass which produces stereo 48k AAC).
        // If all sources in the segment qualify, Step 5 swaps to stream-copy
        // mode to avoid running audio through the encoder at all — the native
        // ffmpeg AAC encoder produces corrupt bitstream output under
        // concurrent load with libx265 at 4K (see Step 5 comment).
        if (Math.abs(vol - 1.0) < 0.001 && item.src.endsWith('_audioclean.mp4')) {
          streamCopyCandidates.push({ inputIdx: idx, audioStreamIdx: 0 })
        }
      }
    }
    inputIdx++
  }

  // --- Step 3: Overlay + caption inputs (captions already sorted last by planSegments) ---
  for (const ov of overlays) {
    const ovIdx = inputIdx
    const { inputArgs, filterParts: fp, newVideoLabel } =
      buildOverlayFilterParts(ov, vw, vh, ovIdx, videoLabel, start, duration)
    inputs.push(...inputArgs)
    filterParts.push(...fp)
    videoLabel = newVideoLabel
    inputIdx++
  }

  // --- Step 4: Per-frame color metadata stamping (per project color space) ---
  filterParts.push(`${videoLabel}${spec.setparams}[vout]`)
  videoLabel = '[vout]'

  // --- Step 5: Audio ---
  //
  // Stream-copy fast path. The ffmpeg native AAC encoder (and even Apple's
  // aac_at) produces corrupt AAC bitstream output for some users under
  // concurrent load with libx265 at 4K HEVC — segments encode "successfully"
  // (ffmpeg exit 0) but the AAC packets fail validation at decode time with
  // errors like "Reserved bit set", "channel element X.Y is not allocated",
  // "Number of bands exceeds limit". The concat step at the end of compose
  // then can't decode them and aborts with "Rematrix is needed between N
  // channels and stereo".
  //
  // When every audio source in this segment came from an `_audioclean.mp4`
  // file (produced by render.js's audio-strip pre-pass with `-c copy`, so
  // guaranteed stereo 48kHz AAC) AND volumes are all 1.0, we can bypass the
  // encoder entirely: map the source's audio stream directly and use
  // `-c:a copy`. ffmpeg never decodes or re-encodes the audio — it just
  // demuxes the AAC packets and writes them through. No encoder, no
  // corruption possible.
  //
  // For segments that don't qualify (no audio sources, multiple sources
  // needing mixing, non-default volumes), fall back to the filter + encoder
  // path. Concat re-encodes audio uniformly at the end anyway, so the
  // mixed-mode segments compose cleanly into the final mp4.
  let audioLabel
  let useAudioStreamCopy = false
  let audioCopyMap = null
  if (audioLabels.length === 0) {
    // No video items with audio — generate silent 48kHz stereo via anullsrc.
    // Must encode (no source to copy from).
    inputs.push('-f', 'lavfi', '-i', `anullsrc=cl=stereo:r=48000`)
    filterParts.push(`[${inputIdx}:a]atrim=0:${duration},asetpts=PTS-STARTPTS[sil]`)
    audioLabel = '[sil]'
    inputIdx++
  } else if (audioLabels.length === 1 && streamCopyCandidates.length === 1) {
    // Single audio source from an audioclean file — stream-copy fast path.
    const { inputIdx: srcIdx, audioStreamIdx } = streamCopyCandidates[0]
    audioCopyMap = `${srcIdx}:a:${audioStreamIdx}`
    useAudioStreamCopy = true
    // Drop the audio filter entry we'd added (won't be used)
    const i = filterParts.findIndex(p => p.endsWith(`[${audioLabels[0].slice(1, -1)}]`))
    if (i >= 0) filterParts.splice(i, 1)
  } else if (audioLabels.length === 1) {
    // Single audio source, but not stream-copyable (volume != 1, or non-audioclean source).
    audioLabel = audioLabels[0]
  } else {
    // Multiple audio sources — mix them together (encoder path).
    const mixInput = audioLabels.join('')
    filterParts.push(`${mixInput}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[amixed]`)
    audioLabel = '[amixed]'
  }

  // --- Step 6: Encode ---
  // Encoder, encoder params, output pix_fmt, and stream-level color metadata
  // are all driven by the project's color space spec.
  const audioArgs = useAudioStreamCopy
    ? ['-map', audioCopyMap, '-c:a', 'copy']
    : ['-map', audioLabel, '-c:a', 'aac_at', '-b:a', '192k', '-ar', '48000', '-ac', '2']
  const args = [
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', videoLabel,
    ...audioArgs,
    '-c:v', spec.encoder, ...spec.encoderArgs, '-pix_fmt', spec.outputPixFmt,
    ...spec.outputColorArgs,
    '-g', String(fps), '-keyint_min', String(fps),
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
