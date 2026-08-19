// render/encode-segment.js
/**
 * Encode a single timeline segment to MP4 in the project's working color space.
 *
 * Each call composites:
 *   - N visual items: layered by trackIdx (lower = background). Each item has
 *     scale, offsetX, offsetY, opacity. Images loop, videos seek+trim.
 *   - 0-N overlays: Puppeteer-rendered MKV/WebM with alpha, scaled from the
 *     1080-design canvas to the output resolution and positioned via offsetX,
 *     offsetY, scale. Captions are always last (topmost z-layer) — ensured by
 *     planSegments.
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
 * project's color space, a conversion filter is injected between the per-item
 * scale and pad steps (see the step-order note in buildVideoItemFilterParts —
 * geometry first so the conversion runs on canvas-sized frames, pad last so its
 * bars are synthesized in the destination color space). The source's
 * color_transfer is read from item.colorTransfer (stamped by render.js during
 * the videoItems collection pass) — no per-segment ffprobe.
 */
import { spawn, spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { FFMPEG, FFPROBE } from './ffmpeg-bin.js'
import { specFor, detectFromTransfer, DEFAULT_COLOR_SPACE } from './color-space.js'
import { lutPath } from './look.js'

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

/**
 * Async ffmpeg runner shaped like spawnSync's result so call sites keep their
 * checks. Resolves (never rejects) with { status, signal, stderr, error? }. Used
 * for the per-segment encode so a bounded pool (compose.js) can drive several
 * encodes at once without blocking the event loop the way spawnSync would.
 */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args)
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('error', (err) => { clearTimeout(timer); resolve({ status: null, signal: null, stderr, error: err }) })
    proc.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal: timedOut ? 'SIGKILL' : signal, stderr })
    })
  })
}

/** Returns true if the file has at least one audio stream. */
export function fileHasAudio(filePath) {
  const result = spawnSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', timeout: 5000 })
  return result.status === 0 && result.stdout.trim().length > 0
}

function isImageItem(item) {
  return item.type === 'image' || IMAGE_EXTENSIONS.test(item.src)
}

// Cache the `ffmpeg -filters` listing across calls — a build's filter set can't
// change mid-process, and both probes below read the same listing so this costs
// one spawn total, not one per filter. Mirrors the functools.lru_cache on
// lib/normalize.py's _has_zscale/_has_lut3d.
let _filtersCache = null
function filterList() {
  if (_filtersCache !== null) return _filtersCache
  const result = spawnSync(FFMPEG, ['-hide_banner', '-filters'], {
    encoding: 'utf8', timeout: 5000,
  })
  _filtersCache = result.status === 0 ? (result.stdout || '') : ''
  return _filtersCache
}

/** True when this ffmpeg build has zscale (requires libzimg). */
export function hasZscale() {
  return /^[A-Z. ]+ zscale\b/m.test(filterList())
}

/** True when this ffmpeg build has lut3d — the filter that applies the Montaj Vivid .cube. */
export function hasLut3d() {
  return /^[A-Z. ]+ lut3d\b/m.test(filterList())
}

/**
 * The Montaj Vivid HDR→SDR chain (SP6b decision 8a). VERBATIM — do not reorder.
 *
 * Byte-for-byte the same shape lib/normalize.py's `_build_tonemap_vf_to_sdr`
 * produces, and for the same reasons; both suites assert these literals so the
 * two runtimes can't drift. Like the Python one, this returns the chain with NO
 * terminal `format=` — the caller appends whatever its encoder needs
 * (`yuv420p` for video, `rgb24` for a PNG).
 *
 * The `format=rgb48le` pin BEFORE `lut3d` is load-bearing: without it ffmpeg
 * hands 8-bit to the LUT and quantizes the grade. After the LUT the pixels are
 * full-range RGB, and the trailing zscale converts them back to limited-range
 * Rec.709 YUV.
 *
 * That trailing zscale sets t=/m=/p= explicitly, not just r=/rin=: zscale only
 * retags an axis it is explicitly given, and an axis it passes through keeps
 * the HDR source's tag — which then beats the encoder's own
 * -color_trc/-color_primaries/-colorspace flags. Omitting t=/p= here produced
 * files still reporting arib-std-b67/bt2020 over bt709 pixels (verified against
 * the managed ffmpeg 8.1.2 during T2).
 *
 * `tin=`/`pin=` are equally load-bearing, for the opposite reason: zscale does
 * not relabel an axis, it CONVERTS to it from whatever the frame currently
 * claims. Arriving frames still carry the source's HDR tags (the LUT rewrites
 * pixels, not tags), so `t=bt709:p=bt709` alone ran a real HLG→709 transfer
 * conversion plus a BT.2020→709 gamut map on pixels the LUT had already
 * tone-mapped — highlights clipped per channel and shifted hue (warm wall →
 * yellow, window → cyan). Pinning the post-LUT truth makes both conversions
 * no-ops and leaves only the retag. See lib/normalize.py's twin for the
 * measured numbers.
 *
 * The LUT is graded for HLG input, so PQ sources get a PQ→HLG pre-step at the
 * LUT's 1000-nit design white — the same value SP6a's generator OOTF used.
 *
 * @param {string} srcKey     'hdr_hlg' or 'hdr_pq'
 * @param {string|null} [sdrCurve]  curve id from looks.json; null → MASTER_LOOK
 * @returns {string}
 */
export function buildVividLutChain(srcKey, sdrCurve = null) {
  const prestep = srcKey === 'hdr_pq'
    ? 'zscale=tin=smpte2084:t=arib-std-b67:npl=1000,'
    : ''
  return prestep
       + 'zscale=matrixin=2020_ncl:rangein=limited:range=full,'
       + 'format=rgb48le,'
       + `lut3d=file=${lutPath(sdrCurve)}:interp=tetrahedral,`
       + 'zscale=tin=bt709:t=bt709:pin=bt709:p=bt709:m=bt709:rin=full:r=tv'
}

/**
 * Build the ffmpeg filter chain to convert a source's color space to the project's.
 * Returns an empty string when src === dst (no conversion needed). Mirrors the
 * Python _build_color_conversion_vf() in lib/normalize.py.
 *
 * The two capability flags control the HDR→SDR arm, in descending fidelity:
 * zscale + lut3d gives the Montaj Vivid LUT; zscale alone falls back to the
 * pre-SP6b Hable chain; neither falls back to the bare tonemap. Both fallbacks
 * are degraded (washed-out highlights, shifted colors). The Python loader emits
 * a loud warning when it takes them at intake; segment-encoder usage is more
 * limited (only kicks in when intake didn't already convert), and warnings here
 * would spam render logs once per segment, so we silently fall back.
 *
 * @param {string} srcKey
 * @param {string} dstKey
 * @param {boolean} hasZscaleFlag
 * @param {object} [opts]
 * @param {string|null} [opts.sdrCurve]  curve id for the LUT; null → MASTER_LOOK.
 *   T7 threads `--sdr-curve` down to here for derived SDR renditions.
 * @param {boolean} [opts.hasLut3d]  defaults to the real probe, so a caller that
 *   forgets it gets a chain this ffmpeg can actually run rather than one naming
 *   a missing filter. Deterministic callers (dry-run) pass it explicitly.
 */
export function buildColorConversionFilter(srcKey, dstKey, hasZscaleFlag, opts = {}) {
  if (srcKey === dstKey) return ''
  const { sdrCurve = null, hasLut3d: hasLut3dFlag = hasLut3d() } = opts
  // HDR → SDR
  if ((srcKey === 'hdr_hlg' || srcKey === 'hdr_pq') && dstKey === 'sdr_bt709') {
    if (hasZscaleFlag && hasLut3dFlag) {
      return buildVividLutChain(srcKey, sdrCurve)
    }
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

  // Fit the source image into its scaledW×scaledH box. Default 'cover' preserves
  // aspect ratio and fills the box (cropping overflow); 'contain' preserves AR and
  // letterboxes with transparency; 'fill' is the legacy stretch-to-box behavior
  // (does NOT preserve AR — kept only for explicit opt-in). Mirrors the AR-safe
  // treatment the video branch already applies via force_original_aspect_ratio.
  const fit = item.fit ?? 'cover'
  let fitChain
  if (fit === 'contain') {
    fitChain = `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,format=rgba,`
             + `pad=${scaledW}:${scaledH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
  } else if (fit === 'fill') {
    fitChain = `scale=${scaledW}:${scaledH},format=rgba`
  } else { // 'cover' (default)
    fitChain = `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,`
             + `crop=${scaledW}:${scaledH},format=rgba`
  }
  filterParts.push(`[${idx}:v]${fitChain},setpts=PTS-STARTPTS[img${idx}]`)
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
 * @param {boolean} [opts.lut3dAvailable] — whether ffmpeg has lut3d; omitted → probed
 * @param {string|null} [opts.sdrCurve]   — look curve id for the HDR→SDR LUT
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
export function buildVideoItemFilterParts(item, vw, vh, idx, videoLabel, opts) {
  const { segStart, duration, projectColorSpace, zscaleAvailable,
          lut3dAvailable, sdrCurve } = opts

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
    : buildColorConversionFilter(itemColorSpace, projectColorSpace, zscaleAvailable,
        { sdrCurve, hasLut3d: lut3dAvailable })
  const conversionStep = conversionFilter ? `${conversionFilter},` : ''

  // -err_detect ignore_err + -max_error_rate 1.0: tolerate broken audio
  // packets from iPhone .MOV sources (see encodeSegment for full comment).
  const inputArgs = [
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-ss', String(actualIn), '-t', String(duration), '-i', item.src,
  ]
  const filterParts = []

  // Optional source crop (clips workflow vertical reframe). Needs source pixel
  // dims; no-op without them. Even dims keep ffmpeg/x264 happy.
  let cropStep = ''
  const sc = item.sourceCrop
  if (sc && item.sourceWidth && item.sourceHeight) {
    const cw = Math.round(item.sourceWidth  * sc.w / 2) * 2  // even: x264 needs even dims
    const ch = Math.round(item.sourceHeight * sc.h / 2) * 2  // even: x264 needs even dims
    const cx = Math.round(item.sourceWidth  * sc.x)          // origin NOT even-rounded (offsets don't require it)
    const cy = Math.round(item.sourceHeight * sc.y)          // origin NOT even-rounded
    cropStep = `crop=${cw}:${ch}:${cx}:${cy},`
  }

  // STEP ORDER IS LOAD-BEARING: crop → scale → convert → pad (SP6b T6).
  //
  // Geometry first. The conversion used to run at the head of this chain, which
  // meant tone-mapping every source pixel in float before throwing most of them
  // away — a 4K clip feeding a 1080 canvas paid ~9× the pixels it needed. crop
  // and scale are pure geometry (they resample, they don't reinterpret color),
  // so doing them first is color-neutral and the conversion then runs on canvas
  // -sized frames.
  //
  // pad stays AFTER the conversion, exactly as before. Its bars are synthesized
  // black, and synthesizing them post-conversion keeps them in the final SDR
  // domain — black in, black out. Move pad ahead of the conversion and those
  // bars get pushed through the LUT with everything else, which maps them to
  // whatever the grade does to 0,0,0 and tints the letterbox.
  //
  // force_divisible_by=2, and ONLY when a conversion follows: decrease-fit
  // computes the un-pinned dimension from the aspect ratio and will happily
  // return an odd one (a 320x180 source into a 360x640 box fits to 360x203).
  // zscale rejects odd dimensions on subsampled formats outright — "code 1027:
  // image dimensions must be divisible by subsampling factor" — and the whole
  // encode dies. This never bit before because the conversion ran ahead of
  // scale, on the decoder's always-even frame. Rounding is at most one pixel
  // and only on items that are being converted, which keeps every SDR render
  // (and the frozen encode-args goldens) byte-identical.
  const divisibleBy = conversionStep ? ':force_divisible_by=2' : ''
  filterParts.push(
    `[${idx}:v]setpts=PTS-STARTPTS,${cropStep}` +
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease${divisibleBy},` +
    `${conversionStep}` +
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

  // Overlay sizing: scale the overlay from its design canvas (always rendered at
  // 1080 on the short edge — see render.js) to the actual output canvas (vw×vh),
  // times the user scale. The target is derived from the OUTPUT dimensions, not
  // by multiplying the design size by a design→output ratio. This is what lets an
  // overlay fit ANY output resolution — 4K upscale, sub-1080 downscale, or a
  // non-integer multiple (e.g. 1440p). The old design→output multiplier assumed
  // output ≥ 1080 and an integer multiple, so on a smaller canvas it left the
  // 1080-design overlay at full size and the compositor cropped it instead of
  // shrinking it. Even-rounded — yuv420/yuva420 encoders reject odd dimensions.
  // Mirrors the image/video item path (buildImage/VideoItemFilterParts), which
  // already sizes to round(vw * scale / 2) * 2.
  const ovScale = ov.scale ?? 1
  const targetW = Math.round(vw * ovScale / 2) * 2
  const targetH = Math.round(vh * ovScale / 2) * 2
  const ovXPx   = Math.round(vw * (0.5 * (1 - ovScale) + (ov.offsetX ?? 0) / 100))
  const ovYPx   = Math.round(vh * (0.5 * (1 - ovScale) + (ov.offsetY ?? 0) / 100))

  // Force yuva420p (or caller-specified format) — VP9 decoders may silently drop
  // the alpha plane on the production path; PNG-based callers pass 'rgba' to
  // avoid an unnecessary colorspace bounce.
  filterParts.push(`[${ovIdx}:v]format=${inputFormatFlag}[ovfmt${ovIdx}]`)
  let ovSrc = `[ovfmt${ovIdx}]`

  // Scale design-canvas → output-canvas (× user scale). When the output already
  // matches the design canvas at scale 1 this is an identity scale (1080→1080),
  // which ffmpeg fast-paths.
  filterParts.push(`${ovSrc}scale=${targetW}:${targetH}[ovsc${ovIdx}]`)
  ovSrc = `[ovsc${ovIdx}]`

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
 * @param {string|null} [opts.sdrCurve] — look curve id for any HDR→SDR item
 *   conversion in this segment; null/omitted uses the master look.
 * @returns {string | object} outputPath, or dry-run result
 */
export async function encodeSegment(segment, outputPath, opts = {}) {
  const { start, end, items, overlays, vw, vh, fps } = segment
  // When an opaque overlay covers this segment, the overlay replaces the frame
  // but the underlying items still contribute their AUDIO. opaqueVideo gates the
  // VIDEO compositing of items only — never their audio. Defaults to false so
  // pre-existing callers/tests (which don't set it) keep their behaviour.
  const opaqueVideo = segment.opaqueVideo ?? false
  const duration = end - start
  const projectColorSpace = segment.colorSpace ?? DEFAULT_COLOR_SPACE
  const spec = specFor(projectColorSpace)
  // Dry-run pins both probes to true so the golden capture never depends on the
  // host's ffmpeg build (see encode-args-golden.test.mjs's determinism note).
  const zscaleAvailable = opts._dryRun ? true : hasZscale()
  const lut3dAvailable  = opts._dryRun ? true : hasLut3d()
  const sdrCurve = opts.sdrCurve ?? null

  if (!opts._dryRun) mkdirSync(dirname(outputPath), { recursive: true })

  const inputs = []
  const filterParts = []
  let videoLabel
  const audioLabels = []
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
          lut3dAvailable,
          sdrCurve,
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
      // item.hasAudio, when stamped (render.js pre-probes once per unique
      // source — see the audioCache loop), wins over the per-segment check.
      // Otherwise: in dry-run mode, skip the ffprobe check (file may not
      // exist) and assume audio present.
      if (!item.muted && (item.hasAudio ?? (opts._dryRun || fileHasAudio(item.src)))) {
        const vol = item.volume ?? 1.0
        const aLabel = `a${idx}`
        // atrim=0:${duration} makes the per-segment sample count exact and
        // explicit in the filter chain, rather than implicit in ffmpeg's
        // -accurate_seek + -t behaviour. Matches the anullsrc path which
        // already does this, and pairs with the PCM codec (no AAC framing
        // means no rounding to absorb a stray trailing sample).
        filterParts.push(`[${idx}:a:0]atrim=0:${duration},asetpts=PTS-STARTPTS,volume=${vol},aformat=channel_layouts=stereo:sample_rates=48000[${aLabel}]`)
        audioLabels.push(`[${aLabel}]`)
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
  // Build the final audioLabel. Three cases:
  //   - No video items contributed audio → silent stereo 48kHz via anullsrc.
  //   - Exactly one source            → use it directly.
  //   - Multiple sources               → amix them, preserving per-item volumes
  //                                      (normalize=0).
  //
  // The encoder always runs (PCM s16le — see Step 6 for the rationale). There
  // is no stream-copy fast path: the previous fast path bypassed the encoder
  // for single-audioclean-vol=1 segments and was the source of an audible pop
  // at every intra-clip segment boundary, because input seek aligned to the
  // nearest AAC frame (up to ~21ms early) and the concat demuxer dropped the
  // per-segment edit list when re-encoding audio. Always encoding to PCM here
  // removes the per-segment AAC framing/priming/edit-list class of artifacts;
  // any residual seam discontinuity is bounded by the source AAC decoder's
  // per-process seek precision (empirically ~500-unit sample delta vs ~2400
  // pre-fix on the same boundaries), not by the encoder/container.
  let audioLabel
  if (audioLabels.length === 0) {
    inputs.push('-f', 'lavfi', '-i', `anullsrc=cl=stereo:r=48000`)
    filterParts.push(`[${inputIdx}:a]atrim=0:${duration},asetpts=PTS-STARTPTS[sil]`)
    audioLabel = '[sil]'
    inputIdx++
  } else if (audioLabels.length === 1) {
    audioLabel = audioLabels[0]
  } else {
    const mixInput = audioLabels.join('')
    filterParts.push(`${mixInput}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[amixed]`)
    audioLabel = '[amixed]'
  }

  // --- Step 6: Encode ---
  // Encoder, encoder params, output pix_fmt, and stream-level color metadata
  // are all driven by the project's color space spec.
  // Per-segment audio is PCM s16le, NOT AAC. AAC framing (~21ms per frame),
  // encoder priming (~2112 samples per encode), and MP4 edit-list metadata
  // do not survive ffmpeg's concat demuxer cleanly when audio is decoded for
  // re-encode at concat — see the audio-pop bug noted in the CHANGELOG. PCM
  // has none of those per-segment encoder/container properties, so the seam
  // artifacts collapse into the much smaller residual from the source AAC
  // decoder's seek precision across independent ffmpeg processes (~10× less
  // than the prior artifact in measurements). The concat step in compose.js
  // re-encodes the joined PCM stream to AAC once, end-to-end — that single
  // AAC encode is the only one in the pipeline now.
  //
  // The previous `aac_at`-under-libx265-4K-concurrent-encode corruption issue
  // (which the deleted stream-copy fast path worked around) is also resolved
  // by this change in principle: aac_at is no longer invoked at all, and the
  // end-of-pipeline native-`aac` encode at concat runs after every libx265
  // process has exited. That claim is asserted, not empirically reverified —
  // if the corruption pattern recurs at the concat re-encode, it's a separate
  // follow-up rather than a regression of this fix.
  const audioArgs = ['-map', audioLabel, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
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

  const result = await runFfmpeg(args, FFMPEG_TIMEOUT_MS)

  if (result.stderr) logFfmpegStderr(result.stderr)

  if (result.status !== 0) {
    throw new Error(`ffmpeg segment encode failed (${start.toFixed(2)}-${end.toFixed(2)}s):\n${(result.stderr || '').slice(-500)}`)
  }

  return outputPath
}
