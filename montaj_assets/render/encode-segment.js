// render/encode-segment.js
/**
 * Encode a single timeline segment to MP4 in the project's working color space.
 *
 * Each call composites:
 *   - N visual items: layered by trackIdx (lower = background). Each item has
 *     scale, offsetX, offsetY, opacity, rotation. Images loop, videos seek+trim.
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
 * geometry first so the conversion runs on canvas-sized frames, pad after it so
 * its bars are synthesized in the destination color space). The source's
 * color_transfer is read from item.colorTransfer, which render.js stamps from
 * the file this encoder will decode (after normalize has swapped `src`) — no
 * per-segment ffprobe.
 */
import { spawn, spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { FFMPEG, FFPROBE } from './ffmpeg-bin.js'
import { specFor, detectFromTransfer, isHdr, DEFAULT_COLOR_SPACE } from './color-space.js'
import { lutPath } from './look.js'
import { ffmpegFilterPath } from './ffmpeg-filter-path.js'
import { externalizeFilterGraph } from './filter-script.js'
import {
  geometryFor, geometryAt, toRotatedPixelBox, toPixelBox, compileTrackExprInfo,
  transitionProgress, hasCropKeyframes, imageFitFor, isFullFrameCrop, CROP_KEYFRAME_PROPS,
} from '@bycrux/timeline-core'

const FFMPEG_TIMEOUT_MS = 600_000
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i

/**
 * How far ahead of the wanted instant a two-stage seek jumps with `-ss` before
 * `-i`; the rest is decoded and trimmed away, so the frame it lands on is
 * exact. Shared by this file's video items and sample-frame.js's frame extract.
 */
export const SEEK_PREROLL_S = 2

/**
 * Split a video item's source seek into an input seek and a decoded remainder
 * (PV48). Returns null for a seek of 0, which needs no split.
 *
 * An input seek alone (`-ss t -i`) lands on the keyframe at or before `t`. On
 * an open-GOP file (x265 at its defaults: every SDR clip converted to HLG) a
 * keyframe's leading pictures are displayed before it but decoded after it,
 * from the previous GOP. A seek into that window drops them, the keyframe
 * becomes the first frame, and `setpts=PTS-STARTPTS` moves it to t=0: the
 * item's picture ran 1 to 3 frames ahead of its own audio for the whole
 * segment (measured in a real render, PV48 T1). Seeking to `near` first gives
 * the decoder the previous GOP, and the `fine` seconds are trimmed off after.
 *
 * `near` is whole seconds and `fine` repeats actualIn's own decimals, so that
 * near + fine is exactly the microseconds ffmpeg read from `-ss actualIn`
 * (it truncates past 6 decimals) and whole seconds are a whole number of ticks
 * in any 1/N time base. The kept frames and samples then match the old single
 * seek wherever it did not drop anything. `actualIn - 2` computed as a float
 * does not: 5.1 - 2 prints as 3.0999999999999996. So the preroll runs from
 * SEEK_PREROLL_S up to one second more.
 *
 * @param {number} actualIn the item's source seek, in seconds
 * @returns {{near: number, fine: string} | null}
 */
export function twoStageSeek(actualIn) {
  if (!(actualIn > 0)) return null
  const s = String(actualIn)
  const dot = s.indexOf('.')
  const whole = dot < 0 ? actualIn : Number(s.slice(0, dot))
  const near = Math.max(0, whole - SEEK_PREROLL_S)
  const fine = near === 0 ? s : `${whole - near}${dot < 0 ? '' : s.slice(dot)}`
  return { near, fine }
}

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
 *
 * The filter graph goes to ffmpeg as a file (`-/filter_complex <path>` in
 * scriptDir), never inline: an animated graph is ~90k characters and Windows
 * caps a command line at 32,767 (WIN1b, filter-script.js). `args` itself keeps
 * the inline pair, so `_dryRun` still returns the graph the goldens pin. The
 * file is removed on 'error' and on 'close' ('close' also follows the timeout's
 * SIGKILL). A cancel kills the process without either, which is why the caller
 * passes the render's own segments dir: compose wipes it on every render.
 */
function runFfmpeg(args, timeoutMs, scriptDir) {
  return new Promise((resolve) => {
    let script
    let proc
    try {
      script = externalizeFilterGraph(args, scriptDir)
      proc = spawn(FFMPEG, script.args)
    } catch (error) {
      script?.cleanup()
      resolve({ status: null, signal: null, stderr: '', error })
      return
    }
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('error', (err) => {
      clearTimeout(timer)
      script.cleanup()
      resolve({ status: null, signal: null, stderr, error: err })
    })
    proc.on('close', (status, signal) => {
      clearTimeout(timer)
      script.cleanup()
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

// Pixel formats that carry an alpha plane: yuva*, gbrap*, rgba/bgra/argb/abgr
// (8- and 16-bit), ya8/ya16, ayuv64/vuya/uyva. `rgb0`/`bgr0` have a padding
// byte, not alpha, and are correctly excluded.
const ALPHA_PIX_FMT = /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d|ayuv|vuya|uyva)/

/**
 * The display geometry of a probed video stream, from ffprobe's JSON.
 *
 * Pure (no spawn) so the rotation and alpha rules can be tested without a
 * file. Display size is the coded size with a ±90/±270 displaymatrix applied,
 * because ffmpeg autorotates on decode — the frame the segment encoder's
 * `scale` step receives is the DISPLAY frame, the same convention
 * lib/normalize.py's probe_video uses for display_width/display_height.
 *
 * @param {object} probe  parsed `ffprobe -of json` output for stream v:0
 * @returns {{width: number, height: number, alpha: boolean} | null}
 *   null when the stream carries no usable size.
 */
export function parseVideoGeometry(probe) {
  const s = probe?.streams?.[0]
  const w = s?.width
  const h = s?.height
  if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) return null
  let rotation = 0
  for (const sd of s.side_data_list ?? []) {
    if (sd && sd.rotation != null) { rotation = Number(sd.rotation) || 0; break }
  }
  const quarterTurn = Math.abs(Math.round(rotation)) % 180 === 90
  return {
    width: quarterTurn ? h : w,
    height: quarterTurn ? w : h,
    alpha: typeof s.pix_fmt === 'string' && ALPHA_PIX_FMT.test(s.pix_fmt),
  }
}

/**
 * Probe a video file's display size and whether its pixel format has alpha.
 * One ffprobe; null on any failure. render.js calls this once per unique
 * final `src` and stamps the result on `probedWidth` / `probedHeight` /
 * `probedAlpha` — see buildVideoItemFilterParts for what they decide.
 *
 * @param {string} filePath
 * @returns {{width: number, height: number, alpha: boolean} | null}
 */
export function probeVideoGeometry(filePath) {
  const result = spawnSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt:stream_side_data=rotation',
    '-of', 'json', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) return null
  try {
    return parseVideoGeometry(JSON.parse(result.stdout))
  } catch {
    return null
  }
}

/**
 * An image's DISPLAY size: the size ffmpeg decodes it to, EXIF orientation
 * applied. MEASURED (PV55 T1, ffmpeg 8.1.2): ffprobe reports a JPEG's STORED
 * size at stream level and carries its orientation only as a FRAME-level
 * display matrix, which the decode applies (orientation 6 decodes 40x80 from an
 * 80x40 store, through -filter_complex too). So the first frame is read and a
 * quarter turn swaps the axes. Cached per path for the process; null on failure.
 *
 * @param {string} filePath
 * @returns {{width: number, height: number} | null}
 */
const imageSizeCache = new Map()
export function probeImageDisplaySize(filePath) {
  if (imageSizeCache.has(filePath)) return imageSizeCache.get(filePath)
  let size = null
  const r = spawnSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v:0', '-read_intervals', '%+#1',
    '-show_entries', 'frame=width,height:frame_side_data=rotation',
    '-of', 'json', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (r.status === 0) {
    try {
      const f = JSON.parse(r.stdout).frames?.[0]
      const w = Number(f?.width)
      const h = Number(f?.height)
      if (w > 0 && h > 0) {
        const rot = (f.side_data_list ?? []).find((s) => typeof s?.rotation === 'number')?.rotation ?? 0
        size = Math.abs(Math.round(rot / 90)) % 2 === 1 ? { width: h, height: w } : { width: w, height: h }
      }
    } catch { /* size stays null */ }
  }
  imageSizeCache.set(filePath, size)
  return size
}

/**
 * The size ffmpeg's `scale=boxW:boxH:force_original_aspect_ratio=decrease`
 * (plus `:force_divisible_by=d` when given) produces from an inW×inH input.
 *
 * A mirror of libavfilter's `ff_scale_adjust_dimensions` for the decrease
 * case, integer arithmetic included: `av_rescale` rounds half away from zero
 * (`(a*b + c/2) / c` in integers), the result is clamped to the box, and a
 * divisor > 1 then rounds each side DOWN to a multiple of it. Used only to
 * decide whether the pad after that scale has anything to fill.
 *
 * @returns {{width: number, height: number}}
 */
export function decreaseFitSize(inW, inH, boxW, boxH, divisibleBy = 1) {
  const d = divisibleBy > 1 ? divisibleBy : 1
  const rescale = (a, b, c) => Math.floor((a * b + Math.floor(c / 2)) / c)
  let width = Math.min(rescale(boxH, inW, inH * d) * d, boxW)
  let height = Math.min(rescale(boxW, inH, inW * d) * d, boxH)
  if (d > 1) {
    width = Math.floor(width / d) * d
    height = Math.floor(height / d) * d
  }
  return { width, height }
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
 * `matrixIn` is the YUV matrix the source was ENCODED with, which is BT.2020
 * NCL for every camera HDR file. The one exception is a remove_bg cutout,
 * whose YUV is BT.601 (buildCutoutGradeFilter). Omitted, the chain is
 * byte-identical to lib/normalize.py's, which has no such parameter.
 *
 * @param {string} srcKey     'hdr_hlg' or 'hdr_pq'
 * @param {string|null} [sdrCurve]  curve id from looks.json; null → MASTER_LOOK
 * @param {object} [opts]
 * @param {string} [opts.matrixIn='2020_ncl']  zscale matrix name of the source's YUV
 * @returns {string}
 */
export function buildVividLutChain(srcKey, sdrCurve = null, { matrixIn = '2020_ncl' } = {}) {
  const prestep = srcKey === 'hdr_pq'
    ? 'zscale=tin=smpte2084:t=arib-std-b67:npl=1000,'
    : ''
  return prestep
       + `zscale=matrixin=${matrixIn}:rangein=limited:range=full,`
       + 'format=rgb48le,'
       + `lut3d=file=${ffmpegFilterPath(lutPath(sdrCurve))}:interp=tetrahedral,`
       + 'zscale=tin=bt709:t=bt709:pin=bt709:p=bt709:m=bt709:rin=full:r=tv'
}

/**
 * Where SDR reference white lands in an HDR output, per ITU-R BT.2408 (203
 * nits; HLG Y10 721, PQ Y10 572). Twin: SDR_WHITE_NITS in lib/normalize.py.
 */
export const SDR_WHITE_NITS = 203

/** Twin of lib/normalize.py UNTAGGED_AS_BT709_VF. */
export const UNTAGGED_AS_BT709_VF = 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709'

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
 * @param {boolean} [opts.srcUntagged]  the SDR source carries no colour tags; the
 *   SDR→HDR arm reads it as BT.709 first (twin of lib/normalize.py).
 * @param {boolean} [opts.hasLut3d]  defaults to the real probe, so a caller that
 *   forgets it gets a chain this ffmpeg can actually run rather than one naming
 *   a missing filter. Deterministic callers (dry-run) pass it explicitly.
 * @param {string} [opts.matrixIn]  the Vivid LUT arm's input matrix; see
 *   buildVividLutChain. Only buildCutoutGradeFilter passes it.
 */
export function buildColorConversionFilter(srcKey, dstKey, hasZscaleFlag, opts = {}) {
  if (srcKey === dstKey) return ''
  const { sdrCurve = null, hasLut3d: hasLut3dFlag = hasLut3d(), srcUntagged = false, matrixIn } = opts
  // HDR → SDR
  if ((srcKey === 'hdr_hlg' || srcKey === 'hdr_pq') && dstKey === 'sdr_bt709') {
    if (hasZscaleFlag && hasLut3dFlag) {
      return buildVividLutChain(srcKey, sdrCurve, { matrixIn })
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
    const stretch = `zscale=t=${dstTransfer}:p=bt2020:m=bt2020nc:npl=${SDR_WHITE_NITS}`
    return srcUntagged ? `${UNTAGGED_AS_BT709_VF},${stretch}` : stretch
  }
  // HDR ↔ HDR
  if ((srcKey === 'hdr_hlg' || srcKey === 'hdr_pq')
      && (dstKey === 'hdr_hlg' || dstKey === 'hdr_pq')) {
    const dstTransfer = dstKey === 'hdr_hlg' ? 'arib-std-b67' : 'smpte2084'
    return `zscale=t=${dstTransfer}`
  }
  return ''
}

/**
 * The HDR to SDR grade for the COLOUR of a remove_bg cutout (PV42 T8), from
 * its input declaration to the chain's trailing zscale. The caller splits the
 * alpha off first and merges it back after (buildVideoItemFilterParts).
 *
 * What the _nobg.mov holds (steps/transform/remove_bg.py): PyAV decodes the
 * HDR source to rgb24 with the source's own matrix (BT.2020 NCL, limited to
 * full), the model returns that RGB plus alpha, and PyAV's default RGB to YUV
 * conversion writes it as BT.601 limited, with no colour tags. So the file is
 * HLG (or PQ) signal in BT.601 YUV: measured on PyAV 17, pure red encodes to
 * Y 327 of 1023 (BT.601 326, BT.709 250, BT.2020 294).
 *
 * The declaration below says exactly that, so zscale has a transfer and
 * primaries to work from (with none it fails: "no path between colorspaces"),
 * and the LUT chain decodes the YUV with the matrix it was encoded with.
 * Measured on a real iPhone cutout (IMG_0679_cut_nobg.mov against its HLG
 * source through the Vivid chain, no encode, alpha = max boxes, mean abs of
 * rgb24), declared BT.2020 NCL (the chain as is) vs BT.601 (this):
 *   frame 10: face 4.35 vs 1.72, torso 1.94 vs 0.95
 *   frame 40: face 3.68 vs 1.51, torso 2.03 vs 1.04
 *   frame 70: face 3.34 vs 1.40, torso 2.23 vs 1.10
 * BT.2020 NCL pulls skin green down 3 to 5 levels. Ungraded (5.5.6) was 24 to
 * 25 on the face and 48 to 53 on the torso.
 *
 * @param {string} srcKey  the cutout's provenance key, 'hdr_hlg' or 'hdr_pq'
 * @param {boolean} hasZscaleFlag
 * @param {object} [opts]  sdrCurve and hasLut3d, as buildColorConversionFilter
 * @returns {string}
 */
export function buildCutoutGradeFilter(srcKey, hasZscaleFlag, opts = {}) {
  const trc = srcKey === 'hdr_pq' ? 'smpte2084' : 'arib-std-b67'
  return `setparams=colorspace=smpte170m:color_trc=${trc}:color_primaries=bt2020:range=tv,`
       + buildColorConversionFilter(srcKey, 'sdr_bt709', hasZscaleFlag, { ...opts, matrixIn: '170m' })
}

// ---------------------------------------------------------------------------
// Shared filter helpers
// Extracted so sample-frame.js can import and call them without duplicating
// the filter-graph logic. Each helper returns { inputArgs, filterParts,
// newVideoLabel }. Callers append inputArgs to their inputs array and push
// filterParts into their filterParts array.
// ---------------------------------------------------------------------------

/**
 * The ONE place ffmpeg rotation filter SYNTAX lives. `@bycrux/timeline-core`'s
 * `toRotatedPixelBox` owns the NUMBERS (normalized degrees, the grown
 * axis-aligned bounding box, the centre-preserving top-left); this owns the
 * string that spends them. No `rotate=` appears in timeline-core, and no
 * geometry is re-derived here — the boundary runs exactly along that seam.
 *
 * Returns a chain fragment with a LEADING comma, or `''` when the box is not
 * rotated. The leading comma (rather than the trailing one `cropStep` /
 * `conversionStep` use below) is what lets all three call sites share one
 * helper: on the video path the rotate step lands AFTER `pad`, which is the
 * last filter before the output label, so there is nothing for a trailing
 * comma to precede.
 *
 * That shape is also what makes the no-rotation guarantee STRUCTURAL rather
 * than a promise. Every call site interpolates this into an otherwise
 * unmodified template literal, and concatenating `''` cannot alter a string,
 * so an item with rotation absent / 0 / 360 emits filters byte-identical to
 * the pre-rotation pipeline. Two frozen encode-args goldens depend on that.
 *
 * `format=yuva420p` is emitted INSIDE this helper — on the video path only,
 * and UNCONDITIONALLY when rotating — so it structurally cannot leak onto an
 * unrotated item. It is a defensive pin, not a load-bearing one: in the
 * production chain (`scale(decrease)` → `pad` → this step → `rotate`), `pad`
 * already leaves the stream alpha-capable, so the `c=black@0.0` corner fill
 * shows the canvas through either way (measured corner Y=150 against ffmpeg
 * 8.1.2, pinned or not). The pin still earns its place: explicitly stating
 * the format beats trusting filter-negotiation to keep doing the right
 * thing, and it is what saves a bare `yuv420p → rotate` chain with no
 * preceding `pad` from going opaque (measured Y=0 unpinned vs. Y=150 pinned
 * in that isolated shape). Same explicit-pin discipline as the
 * `format=rgb48le` before `lut3d` in buildVividLutChain, and for the same
 * class of reason: ffmpeg will pick a format that silently discards what the
 * next filter needs. The image and overlay paths need no pin — their chains
 * already carry alpha (every image fit chain runs through `format=rgba`;
 * the overlay input is pinned to `yuva420p`/`rgba` at its own `format=`
 * step).
 *
 * The angle is emitted as a DEGREE expression (`45*PI/180`), not a
 * pre-computed float radian. ffmpeg evaluates it to the identical double, and
 * the authored degrees stay legible in filter strings, render logs and
 * goldens.
 *
 * @param {{outW: number, outH: number, rotationDeg: number, isIdentity: boolean}} box
 *   — a `toRotatedPixelBox` result. Note that 180° is NOT identity: the box
 *   does not grow, but the pixels still have to turn.
 * @param {boolean} [alphaPin=false] — true on the video path only.
 * @returns {string} `''`, or `,[format=yuva420p,]rotate=…`
 */
/**
 * ANIMATED-ITEM GEOMETRY — the keyframed sibling of `toRotatedPixelBox`.
 *
 * Returns `null` for an item with no keyframes, which is what keeps the static
 * path byte-identical: every caller below branches on this being null and
 * otherwise emits exactly the strings it always has.
 *
 * ── Why the filter chain changes shape, and not just its numbers ────────────
 *
 * Three filters in the existing chain CANNOT accept a variable-size input, and
 * all three fail SILENTLY — no ffmpeg warning, roughly the right picture at
 * small deltas, visibly wrong at the extremes (measured; see the SP9d spike):
 *
 *   1. `rotate` configures against its first frame and mis-scales every
 *      resized frame after it. An animated ANGLE alone is fine; it is the
 *      changing frame SIZE that breaks it.
 *   2. The colour conversion (`zscale` + `lut3d`) does the same. That is the
 *      path every HDR source takes, i.e. the common one, not an edge case.
 *   3. `pad` exposes NO `t` and no `n` even at `eval=frame` — its whole
 *      vocabulary is geometric (`iw ih ow oh a sar dar x y`) — so it cannot be
 *      driven from a curve at all.
 *
 * So the animated chain keeps every size-sensitive filter on a CONSTANT frame
 * and does the varying resize afterwards. `scale` and `pad` still run at their
 * usual place in the order, just sized to the PEAK box the item ever reaches
 * rather than to its current one, and a second `scale` — the animated one —
 * follows the pad:
 *
 *     crop → scale(STATIC, peak box) → convert → pad(STATIC, peak box)
 *          → scale(ANIMATED)  [→ pad(peak, transparent) → rotate]  → overlay
 *
 * `pad` therefore still sits AFTER the conversion, which is the rule the
 * step-order comment in buildVideoItemFilterParts exists to protect: its bars
 * are synthesized black and must stay out of the LUT. And because that pad
 * brings the frame to the canvas's own aspect, the animated `scale` after it is
 * a plain uniform resize — no second fit, no second pad, and nothing for the
 * `t`-less `pad` to have to express.
 *
 * The cost is one extra resample on animated items only (peak box → current
 * box, always a downscale since the peak is by definition the largest). The
 * static path resamples once, and is untouched.
 *
 * @param {object} item     the timeline item
 * @param {'video'|'image'} kind
 * @param {number} vw       canvas width, pixels
 * @param {number} vh       canvas height, pixels
 * @param {number} timeOffset  ITEM-relative seconds at which ffmpeg's `t` is 0
 * @param {number} duration    segment duration, seconds
 * @param {(prop: string, info: object) => void} onCap  called per capped track
 * @returns {null | {
 *   peakW: number, peakH: number, hasRotation: boolean,
 *   rotOutW: number, rotOutH: number,
 *   boxWExpr: string, boxHExpr: string,
 *   xExpr: string, yExpr: string, angleExpr: string | null,
 * }}
 */
function animatedGeometry(item, kind, vw, vh, timeOffset, duration, onCap) {
  const tracks = item?.keyframes
  if (!Array.isArray(tracks) || tracks.length === 0) return null

  // Only the geometry props compile. `opacity` is deliberately absent: ffmpeg's
  // `colorchannelmixer aa` is a <double> and accepts no expression at all, so a
  // clip's opacity curve is IGNORED here and the static value is used instead.
  // That gap is a property of the tool, not an oversight — see docs/RENDER.md.
  // The crop props (cropX/cropY/cropW/cropH, PV55) are absent too, and must stay
  // so: they move the picture inside the box (animatedImageCrop), never the box.
  const GEOMETRY_PROPS = ['offsetX', 'offsetY', 'scale', 'scaleX', 'scaleY', 'rotation']
  const animatedProps = tracks.filter(
    (tr) => tr && GEOMETRY_PROPS.includes(tr.prop) && Array.isArray(tr.points) && tr.points.length > 0,
  )
  if (animatedProps.length === 0) return null

  const staticGeom = geometryFor(item, kind)

  // Sample the resolved geometry across the segment to find the largest box the
  // item ever occupies, and the widest angle it ever reaches. Keyframe instants
  // are included explicitly because a cubic-bezier easing is monotone between
  // keyframes, so the extremes land ON them; the uniform grid is belt-and-braces
  // for a hand-authored track with an easing that is not.
  const probes = new Set([0, duration])
  for (let i = 0; i <= 120; i++) probes.add((duration * i) / 120)
  for (const tr of animatedProps) {
    for (const p of tr.points) {
      const local = p.t - timeOffset
      if (local >= 0 && local <= duration) probes.add(local)
    }
  }

  let peakW = 0
  let peakH = 0
  let maxAbsDeg = 0
  for (const localT of probes) {
    const g = geometryAt(item, kind, timeOffset + localT)
    const b = toPixelBox(g, vw, vh)
    if (b.width > peakW) peakW = b.width
    if (b.height > peakH) peakH = b.height
    const deg = Number.isFinite(g.rotation) ? Math.abs(g.rotation) : 0
    if (deg > maxAbsDeg) maxAbsDeg = deg
  }
  // A degenerate track (every sample zero-sized) has nothing to animate.
  if (!(peakW > 0) || !(peakH > 0)) return null

  /**
   * One property as an ffmpeg expression, or its static value as a literal.
   * Times are shifted so the compiled `t` is ffmpeg's `t` (0 at the start of
   * this segment) rather than the item-relative `t` the curve is authored in —
   * shifting the BREAKPOINTS rather than rewriting the emitted string keeps
   * this exact and avoids surgery on an expression we just built.
   */
  const exprFor = (prop, staticValue, unitsPerPixel) => {
    const tr = animatedProps.find((x) => x.prop === prop)
    if (!tr) return null
    const shifted = { prop, points: tr.points.map((p) => ({ ...p, t: p.t - timeOffset })) }
    const info = compileTrackExprInfo(shifted, { pixelTolerance: 0.25, unitsPerPixel })
    if (info.capped) onCap(prop, info)
    return info.expr ?? String(staticValue)
  }

  const lit = (v) => String(v)
  // scaleX/scaleY fall back to the uniform `scale` track, then to the static
  // per-axis value — mirroring geometryAt's own resolution order.
  const sExpr = exprFor('scale', staticGeom.scale, 1 / vw)
  const sxExpr = exprFor('scaleX', staticGeom.scaleX, 1 / vw) ?? sExpr ?? lit(staticGeom.scaleX)
  const syExpr = exprFor('scaleY', staticGeom.scaleY, 1 / vh) ?? sExpr ?? lit(staticGeom.scaleY)
  const oxExpr = exprFor('offsetX', staticGeom.offsetX, 100 / vw) ?? lit(staticGeom.offsetX)
  const oyExpr = exprFor('offsetY', staticGeom.offsetY, 100 / vh) ?? lit(staticGeom.offsetY)
  // Rotation's tolerance is converted against the item's PEAK size, per the
  // plan: the pixel error an angle error produces scales with the box's current
  // size, so referencing a fixed or first-frame size under-subdivides exactly
  // when the item is largest and the wobble is most visible. Degrees per pixel
  // at the peak radius.
  const peakDim = Math.max(peakW, peakH)
  const rotExpr = exprFor('rotation', staticGeom.rotation ?? 0, (180 / Math.PI) / (peakDim / 2))

  // `round(...)`, always. ffmpeg TRUNCATES a pixel option's expression toward
  // zero while toPixelBox uses Math.round, so a bare expression that lands a
  // hair under an integer costs a whole pixel against the preview. Pinned by
  // timeline-core's expr.ffmpeg test.
  const evenBox = (dim, sc) => `round(round(${dim}*(${sc}))/2)*2`
  const boxWExpr = evenBox(vw, sxExpr)
  const boxHExpr = evenBox(vh, syExpr)

  // Animating POSITION alone is nearly free — the overlay's x/y are already
  // evaluated per frame, so nothing else in the chain has to change. Only a
  // size or rotation curve forces the restructured chain (and its extra
  // resample), so the two cases are kept apart rather than lumped together.
  const sizeAnimates = animatedProps.some((tr) => tr.prop === 'scale' || tr.prop === 'scaleX' || tr.prop === 'scaleY')
  const rotationAnimates = animatedProps.some((tr) => tr.prop === 'rotation')
  const needsAnimatedChain = sizeAnimates || rotationAnimates
  // A rotate step is emitted on the animated chain whenever the item is turned
  // at all, animated or not: a STATIC angle over a resized input breaks exactly
  // the same way an animated one does.
  const emitRotate = needsAnimatedChain && maxAbsDeg > 0
  let rotOutW = peakW
  let rotOutH = peakH
  if (emitRotate) {
    // `rotate`'s ow/oh are CONFIG-TIME ONLY — `t` in them evaluates to nan and
    // the graph dies — so the grown box is reserved once, at the worst angle the
    // item reaches, and held for every frame.
    const a = (maxAbsDeg * Math.PI) / 180
    rotOutW = Math.round((Math.abs(peakW * Math.cos(a)) + Math.abs(peakH * Math.sin(a))) / 2) * 2
    rotOutH = Math.round((Math.abs(peakW * Math.sin(a)) + Math.abs(peakH * Math.cos(a))) / 2) * 2
  }

  // Composite position. Without rotation the overlay input IS the current box,
  // so its top-left is the box's own. With rotation the input is the frozen
  // rotOutW×rotOutH box, which has to be re-centred on the box centre every
  // frame — the expression sibling of toRotatedPixelBox's centre-preserving
  // `x = xPx - (outW - scaledW)/2`.
  const xPxExpr = `round(${vw}*(0.5*(1-(${sxExpr}))+(${oxExpr})/100))`
  const yPxExpr = `round(${vh}*(0.5*(1-(${syExpr}))+(${oyExpr})/100))`
  const xExpr = emitRotate ? `round(${xPxExpr}+(${boxWExpr})/2-${rotOutW}/2)` : xPxExpr
  const yExpr = emitRotate ? `round(${yPxExpr}+(${boxHExpr})/2-${rotOutH}/2)` : yPxExpr

  return {
    peakW, peakH, needsAnimatedChain, emitRotate, rotOutW, rotOutH,
    boxWExpr, boxHExpr, xExpr, yExpr, xPxExpr, yPxExpr,
    angleExpr: emitRotate
      ? (rotExpr ? `(${rotExpr})*PI/180` : `${staticGeom.rotation ?? 0}*PI/180`)
      : null,
  }
}

/**
 * Composite position for an item whose SIZE and ROTATION are static but whose
 * POSITION animates. The grown-box correction `toRotatedPixelBox` folds into
 * `box.x` is a constant here, so it is simply added to the moving top-left
 * rather than recomputed per frame.
 */
function staticBoxPosition(anim, box) {
  const dx = box.x - box.xPx
  const dy = box.y - box.yPx
  return {
    x: dx === 0 ? anim.xPxExpr : `round(${anim.xPxExpr}+${dx})`,
    y: dy === 0 ? anim.yPxExpr : `round(${anim.yPxExpr}+${dy})`,
  }
}

/**
 * The `[→ pad(peak, transparent) → rotate]` tail of an animated chain.
 *
 * Empty when the item never rotates. Otherwise it re-establishes a CONSTANT
 * frame size before `rotate` — which is the whole reason this exists, since
 * `rotate` mis-renders a resized input — by padding out to the peak box with a
 * TRANSPARENT fill. Transparent, not black: the item's own letterbox bars were
 * already synthesized by the static pad upstream, and painting more black here
 * would draw bars beyond the item's actual box.
 */
function animatedRotateStep(anim, alphaPin = false) {
  if (!anim.emitRotate) return ''
  return `,${alphaPin ? 'format=yuva420p,' : ''}`
       + `pad=${anim.peakW}:${anim.peakH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0:eval=frame,`
       + `rotate='${anim.angleExpr}':ow=${anim.rotOutW}:oh=${anim.rotOutH}:c=black@0.0`
}

/**
 * Warn, once per property, when a track could not be approximated within
 * tolerance. Task 2's compiler reports the cap on a return value, which proves
 * it noticed; this is the only place the information reaches an operator whose
 * export came out slightly coarse and who has no idea why.
 */
function warnIfCapped(item, kind) {
  return (prop, info) => {
    console.warn(
      `[montaj] ${kind} item ${item.id ?? item.src ?? '(unnamed)'}: '${prop}' keyframe curve `
      + `hit the ${info.segments}-segment cap; achieved ${info.maxError.toPrecision(3)} `
      + `vs a ${info.tolerance.toPrecision(3)} target (in ${prop} units). `
      + `The animation renders slightly coarser than the preview.`,
    )
  }
}

/** A crop rect is interpolated into the filter graph as TEXT, so only finite
 *  numbers may reach it. validate.py checks project files; this also covers any
 *  caller that skipped validate (PV55 T13). */
function isFiniteCrop(c) {
  return !!c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.w) && Number.isFinite(c.h)
}

/**
 * The largest frame, in pixels, the eval=frame `scale` of a keyframed crop
 * (movingCropChain: images and video) may produce. That scale renders the WHOLE
 * union at the deepest zoom's output resolution, so its peak frame is
 * ceil(uw*kMax) x ceil(uh*kMax) however the rest of the chain is built.
 * MEASURED (PV55 T13, ffmpeg 8.1.2): 15062x26846 (404 Mpx) rendered, at 4.2 GB
 * RSS; 18992x33724 failed the whole export ("Picture size ... is invalid",
 * ENOMEM), a plain zoom from the 9:16 framing of a 4032x3024 photo to the crop
 * tool's 2% limit.
 *
 * Past it the crop still animates, so the framing always matches the preview:
 * the chain renders at 1/S, S = sqrt(peak / budget), and is upscaled to the box
 * (by its own `scale` for an image, by the decrease-fit for a video). Only
 * sharpness gives, mostly at the zoomed-out end (PV55 F9). MEASURED (PV55
 * F9, that same zoom held at its deepest for half of 1 s, 1080x1920 box): the
 * peak frame is 6004x10661 at 1/3.80, 0.55 s and ~370 MB RSS, against a still
 * cover fit's 0.32 s and ~166 MB; a 256 Mpx budget took ~760 MB, hence 64 Mpx.
 */
const MAX_ANIMATED_CROP_PX = 64_000_000

const NOT_A_RECT = 'its crop is not a finite, non-empty rect'

/**
 * Every source-crop rect a keyframed item shows in this segment (PV55), sampled
 * through the shared `geometryAt` on a uniform grid plus the keys. null when any
 * of them is not a finite, non-empty rect: text from a hand-written project
 * must never reach the filter graph (PV55 T13).
 *
 * @returns {null | { cropTracks: object[], rects: {x: number, y: number, w: number, h: number}[] }}
 */
function sampleCropRects(item, kind, timeOffset, duration) {
  const cropTracks = item.keyframes.filter(
    (tr) => tr && CROP_KEYFRAME_PROPS.includes(tr.prop) && Array.isArray(tr.points) && tr.points.length > 0,
  )
  // Every rect the item shows in this segment: a uniform grid plus the keys.
  const probes = new Set([0, duration])
  for (let i = 0; i <= 120; i++) probes.add((duration * i) / 120)
  for (const tr of cropTracks) {
    for (const p of tr.points) {
      const local = p.t - timeOffset
      if (local >= 0 && local <= duration) probes.add(local)
    }
  }
  const rects = []
  for (const local of probes) {
    const c = geometryAt(item, kind, timeOffset + local).sourceCrop
    if (!isFiniteCrop(c) || !(c.w > 0) || !(c.h > 0)) return null
    rects.push(c)
  }
  return { cropTracks, rects }
}

/**
 * The moving crop at the heart of every keyframed source crop (PV55), shared by
 * images (animatedImageCrop) and video (animatedVideoCrop): a chain whose output
 * is a CONSTANT `bw`x`bh` frame showing the crop rect at each instant,
 * cover-fitted into `boxW`x`boxH` (or into that box at 1/S, past `budgetPx`).
 * The caller appends only what comes AFTER the fixed crop.
 *
 * WHY THIS SHAPE. Each point was measured (PV55 T1, ffmpeg 8.1.2); do not re-derive.
 *   - `crop` evaluates w/h ONCE; only x/y follow `t`. So the size change is done
 *     by `scale` at eval=frame (the source resized so the current rect lands at
 *     the box size), and a FIXED-size `crop` cuts the box out at a moving x/y.
 *   - `crop`'s own iw/ih are frozen at configuration, so x/y use `t` and
 *     literals only, never iw. That is why the source size is needed.
 *   - `crop` clamps x/y against its INPUT LINK's size. Straight after the
 *     eval=frame `scale` that is the current frame. Put ANY filter between them
 *     (`format=rgba` was the one measured) and the link keeps the first frame's
 *     size: a zoom-in silently freezes. Everything else goes AFTER the crop: an
 *     image's `scale` then `format=rgba` (bare at full resolution, `scale=box`
 *     at 1/S; either way it does the rgba conversion at box size), a video's
 *     decrease-fit, colour conversion and pad (the conversion breaks on a
 *     varying size too; see animatedGeometry). The zoom pixel tests, per kind,
 *     at full resolution and at 1/S, exist to catch exactly this.
 *
 * Not `zoompan`: it rounds its window to whole INPUT pixels (visible stepping on
 * a slow pan unless the source is upscaled first), and it is a frame generator
 * (`d`, `fps`, `on`/`in`) where every other animated step here is a function of `t`.
 *
 * Cost: the static pre-crop to the UNION of the rects shown keeps the per-frame
 * resize to the region the animation visits. A pan at one zoom resizes about
 * what a still cover fit does; a zoom-in resizes the union at its deepest zoom.
 * When that peak frame exceeds `budgetPx`, every size in the chain is divided by
 * S = sqrt(peak / budgetPx): the eval=frame scale uses k/S, the fixed crop is
 * floor(box/S), and the caller scales it back up to the box. The framing is the
 * same rect at every instant; only sharpness is lost.
 *
 * @param {number} SW, SH        the source's display size, pixels
 * @param {number} boxW, boxH    the size the current rect is cover-fitted into
 * @param {{cropTracks: object[], rects: object[]}} sampled  sampleCropRects' result
 * @param {number} shownW, shownH  the size, in OUTPUT pixels, the box finally
 *   shows at: the curve tolerance is a quarter of one of those pixels
 * @returns {{ hold: string } | { chain: string, bw: number, bh: number,
 *   S: number, downscaled: boolean, peakW: number, peakH: number }}
 */
function movingCropChain(item, SW, SH, boxW, boxH, sampled, timeOffset, onCap, budgetPx, shownW, shownH) {
  const { cropTracks, rects } = sampled
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0, minW = 1, minH = 1, kMax = 0
  for (const c of rects) {
    kMax = Math.max(kMax, boxW / (c.w * SW), boxH / (c.h * SH))
    x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y)
    x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h)
    minW = Math.min(minW, c.w); minH = Math.min(minH, c.h)
  }
  // The union in whole source pixels, origin on even pixels (a JPEG, and most
  // video, decodes 4:2:0).
  const ux = Math.max(0, Math.floor((x0 * SW) / 2) * 2)
  const uy = Math.max(0, Math.floor((y0 * SH) / 2) * 2)
  const uw = Math.min(SW, Math.ceil(x1 * SW)) - ux
  const uh = Math.min(SH, Math.ceil(y1 * SH)) - uy
  // Past the budget the whole chain runs at 1/S (MAX_ANIMATED_CROP_PX). S is
  // rounded UP to 6 decimals, and every size below is computed from the number
  // the graph reads. toFixed prints a plain decimal only below 1e21; an S that
  // large needs a rect under ~1e-15 of the image, which is empty in all but name.
  const peakW = Math.ceil(uw * kMax)
  const peakH = Math.ceil(uh * kMax)
  const sText = peakW * peakH > budgetPx
    ? (Math.ceil(Math.sqrt((peakW * peakH) / budgetPx) * 1e6) / 1e6).toFixed(6)
    : null
  const S = sText ? Number(sText) : 1
  if (!(S < 1e21)) return { hold: NOT_A_RECT }

  const base = item.sourceCrop ?? { x: 0, y: 0, w: 1, h: 1 }
  const exprFor = (prop, fallback, unitsPerPixel) => {
    const tr = cropTracks.find((x) => x.prop === prop)
    if (!tr) return String(fallback)
    const shifted = { prop, points: tr.points.map((p) => ({ ...p, t: p.t - timeOffset })) }
    const info = compileTrackExprInfo(shifted, { pixelTolerance: 0.25, unitsPerPixel })
    if (info.capped) onCap(prop, info)
    return info.expr ?? String(fallback)
  }
  // A crop-fraction error d moves the picture about d*shown/w output pixels,
  // worst at the deepest zoom (the smallest w, h).
  const X = exprFor('cropX', base.x, minW / shownW)
  const Y = exprFor('cropY', base.y, minH / shownH)
  const W = exprFor('cropW', base.w, minW / shownW)
  const H = exprFor('cropH', base.h, minH / shownH)

  // k: source px -> box px, the cover factor of the current rect into the box.
  // At 1/S it is k/S, and the fixed crop is the box at 1/S: FLOOR, so it always
  // fits inside the resized union (and at least 1 px, or `crop` fails the graph).
  const k = `max(${boxW}/((${W})*${SW}),${boxH}/((${H})*${SH}))`
  const kS = sText ? `(${k})/${sText}` : k
  const bw = sText ? Math.max(1, Math.floor(boxW / S)) : boxW
  const bh = sText ? Math.max(1, Math.floor(boxH / S)) : boxH
  // ceil, never round: the box must always fit inside the resized union.
  const x = `round(((${X})*${SW}-${ux})*${kS}+((${W})*${SW}*${kS}-${bw})/2)`
  const y = `round(((${Y})*${SH}-${uy})*${kS}+((${H})*${SH}*${kS}-${bh})/2)`
  // NOTHING may ever sit between the eval=frame `scale` and the fixed `crop`
  // below, for either kind, in EITHER branch (full resolution, or 1/S): not
  // `format=`, not the upscale, not a colour conversion. The crop would clamp
  // x/y against the FIRST frame's size and a zoom-in would silently freeze (WHY
  // THIS SHAPE, above). Guarded by the zoom cases in
  // test/image-crop.integration.test.mjs and test/video-crop.integration.test.mjs,
  // one per branch.
  return {
    chain: `crop=${uw}:${uh}:${ux}:${uy}:exact=1,`
         + `scale=w='ceil(${uw}*${kS})':h='ceil(${uh}*${kS})':eval=frame,`
         + `crop=${bw}:${bh}:x='${x}':y='${y}':exact=1`,
    bw, bh, S, downscaled: sText !== null, peakW, peakH,
  }
}

/** One line for an operator reading the logs: why a keyframed crop looks soft. */
function warnCropDownscaled(kind, item, m, budgetPx) {
  console.warn(
    `[montaj] ${kind} item ${item.id ?? item.src ?? '(unnamed)'}: its animated crop's deepest zoom `
    + `needs a ${m.peakW}x${m.peakH} px frame, past the ${budgetPx} px budget, so the crop renders at `
    + `1/${m.S.toFixed(2)} resolution and is upscaled to the box. The framing is unchanged; it looks softer.`,
  )
}

/**
 * The keyframed source crop of an IMAGE (PV55), as a chain whose output is
 * exactly `boxW`x`boxH` rgba: the crop rect at each instant, cover-fitted into
 * the box (movingCropChain, then a `scale` and `format=rgba` after its fixed
 * crop). Returns null when the item has no crop keyframes, `{ chain }` when it
 * animates, and `{ hold: reason }` when it cannot (size unreadable, or a rect
 * that is not finite and positive): the caller then holds the crop at the
 * segment start and warns with the reason. A zoom past `budgetPx`
 * (MAX_ANIMATED_CROP_PX unless a test injects one) still animates, at 1/S.
 */
function animatedImageCrop(item, boxW, boxH, timeOffset, duration, onCap, budgetPx = MAX_ANIMATED_CROP_PX) {
  if (!hasCropKeyframes(item)) return null
  // probedWidth/probedHeight are a test seam here. render.js stamps them on VIDEO items only,
  // from probeVideoGeometry, which reads a JPEG's STORED size (EXIF ignored). Never stamp them
  // on an image that way: the animated crop would use the wrong axes on a rotated photo.
  const dims = item.probedWidth > 0 && item.probedHeight > 0
    ? { width: item.probedWidth, height: item.probedHeight }
    : probeImageDisplaySize(item.src)
  if (!dims) return { hold: 'could not read its size' }
  const sampled = sampleCropRects(item, 'image', timeOffset, duration)
  if (!sampled) return { hold: NOT_A_RECT }
  const m = movingCropChain(item, dims.width, dims.height, boxW, boxH, sampled, timeOffset, onCap, budgetPx, boxW, boxH)
  if (m.hold) return m
  if (m.downscaled) warnCropDownscaled('image', item, m, budgetPx)
  // AFTER the fixed crop, never between it and the eval=frame scale (movingCropChain).
  return { chain: `${m.chain},${m.downscaled ? `scale=${boxW}:${boxH},format=rgba` : 'scale,format=rgba'}` }
}

/**
 * The keyframed source crop of a VIDEO (PV55 phase 2), as a chain for the crop
 * slot of buildVideoItemFilterParts: its output is a CONSTANT `width`x`height`
 * frame holding the crop rect at each instant, so the decrease-fit, the colour
 * conversion, the pad and the rotate after it all see one frame size, exactly
 * as they do for a still crop.
 *
 * That frame is cut at the size the picture is SHOWN (D1): the largest rect's
 * fit into the box, even, never above that rect in source pixels (RW x RH,
 * even). A rect smaller than its box keeps its own pixels and the decrease-fit
 * upscales it, as it does a still crop. Cut at source size instead, a 4K zoom
 * resized every frame to 4K and more, then threw most of it away in the
 * decrease-fit (MEASURED, PV55 D1, ffmpeg 8.1.2: a 4K clip zooming 1x to 2x in
 * a 1080x1920 box, 1 s at 30 fps, 379 ms / 1.08 GB RSS source-sized against
 * 243 ms / 498 MB shown-sized; uncropped 128 ms / 439 MB). Past the budget the
 * frame is that at 1/S, and the decrease-fit upscales it.
 *
 * The rect is cover-fitted into that frame, so a key whose pixel aspect is off
 * by validate's 1% tolerance (or by the even rounding) trims a sliver instead
 * of reading past the rect. The caller has checked `hasCropKeyframes` and a
 * positive `sourceWidth`/`sourceHeight` (the size every video crop is in).
 * Returns `{ chain, width, height }`, or `{ hold: reason }` for a rect that is
 * not finite and positive (the caller then holds the crop at the segment start).
 *
 * @param {number} fitW, fitH  the box the decrease-fit fits it into (the PEAK
 *   unrotated box when the box itself animates): the shown size, and the curve
 *   tolerance
 */
function animatedVideoCrop(item, fitW, fitH, timeOffset, duration, onCap, budgetPx = MAX_ANIMATED_CROP_PX) {
  const SW = item.sourceWidth
  const SH = item.sourceHeight
  const sampled = sampleCropRects(item, 'video', timeOffset, duration)
  if (!sampled) return { hold: NOT_A_RECT }
  let maxW = 0
  let maxH = 0
  for (const c of sampled.rects) {
    maxW = Math.max(maxW, c.w * SW)
    maxH = Math.max(maxH, c.h * SH)
  }
  const RW = Math.max(2, Math.round(maxW / 2) * 2)
  const RH = Math.max(2, Math.round(maxH / 2) * 2)
  const shown = decreaseFitSize(RW, RH, fitW, fitH)
  // D1: the fixed crop is the SHOWN size, which nothing after it enlarges:
  //  - the head's decrease-fit fits into this same fitW x fitH, so on this size
  //    it is a no-op (the box is even, one side equals it, the other is inside
  //    it); it upscales only the RW x RH cap or the 1/S crop, as it always has;
  //  - fitW x fitH is the PEAK unrotated box (animatedGeometry), and the tail's
  //    eval=frame scale only shrinks the peak to the current box;
  //  - the conversion, the cutout grade and the pad never resize, `rotate` turns
  //    pixels 1:1 into a larger canvas, and overlay composites 1:1.
  const BW = Math.max(2, Math.min(RW, Math.round(shown.width / 2) * 2))
  const BH = Math.max(2, Math.min(RH, Math.round(shown.height / 2) * 2))
  const m = movingCropChain(item, SW, SH, BW, BH, sampled, timeOffset, onCap, budgetPx,
    Math.max(1, shown.width), Math.max(1, shown.height))
  if (m.hold) return m
  if (m.downscaled) warnCropDownscaled('video', item, m, budgetPx)
  return { chain: m.chain, width: m.bw, height: m.bh }
}

function rotateFilterStep(box, alphaPin = false) {
  if (box.isIdentity) return ''
  const pin = alphaPin ? 'format=yuva420p,' : ''
  return `,${pin}rotate=${box.rotationDeg}*PI/180:ow=${box.outW}:oh=${box.outH}:c=black@0.0`
}

// The geometry of an overlay whose transform is ALREADY baked into its capture:
// the identity. Built by `geometryFor` from an empty item rather than written
// out as an object literal, so it cannot drift from the defaults that function
// applies. Consumed only by buildOverlayFilterParts' keyframed branch.
const BAKED_OVERLAY_GEOMETRY = geometryFor({}, 'overlay')

/**
 * Build filter-graph parts for one image item.
 *
 * The chain is: source crop → fit → [box animation] → setpts. A still
 * `sourceCrop` (PV55) is cut first, in the image's own pixels, and then the fit
 * runs on it as always, so all three fits honour it. A KEYFRAMED crop replaces
 * both steps with animatedImageCrop's chain, which always COVERS the box
 * (`imageFitFor`): a per-frame contain or fill of a changing crop would need
 * per-frame bars.
 *
 * @param {object} item       — the image item from segment.items
 * @param {number} vw         — canvas width  (pixels)
 * @param {number} vh         — canvas height (pixels)
 * @param {number} idx        — ffmpeg input index for this item
 * @param {string} videoLabel — current composite label, e.g. '[canvas]'
 * @param {number} duration   — segment duration in seconds (used for -t)
 * @param {number} [segStart] — segment start on the timeline (seconds)
 * @param {{ cropBudgetPx?: number }} [opts] — test seam: the animated crop's
 *   pixel budget, MAX_ANIMATED_CROP_PX when absent. No production caller passes it.
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
// NOTE: item.speed is intentionally ignored here — a still image has no
// motion to time-scale, so speed is a no-op for image items (unlike video,
// where it re-times decoded frames).
export function buildImageItemFilterParts(item, vw, vh, idx, videoLabel, duration, segStart, opts) {
  // Geometry comes from the shared resolver — see @bycrux/timeline-core's
  // src/geometry.js. This file used to carry its own copy of the formula; three
  // copies lived here and a fourth in the editor, which is what KNOWN-DIVERGENCES
  // D9 tracked. Equivalence is pinned by timeline-core's switchover sweep.
  // toRotatedPixelBox DELEGATES to toPixelBox for scaledW/scaledH, so those are
  // the same integers this line has always produced; it adds the bounding box a
  // rotated frame grows into (outW/outH) and the centre-preserving top-left to
  // composite that box at (box.x/box.y). At rotation absent/0/360 the grown box
  // IS the unrotated box, so box.x/box.y are exactly toPixelBox's x/y and every
  // string below is unchanged.
  const box = toRotatedPixelBox(geometryFor(item, 'image'), vw, vh)
  const { scaledW, scaledH } = box

  // ITEM-relative timeline seconds at the instant ffmpeg's `t` reads 0. The
  // input is `-loop 1 -t duration`, so PTS start at 0 and `t` runs 0..duration
  // in SEGMENT time — hence the shift is (segStart - item.start), the same
  // quantity the video path calls seekOffset. `segStart` is optional so
  // sample-frame.js's six-argument call keeps working; its pseudo-item never
  // carries `keyframes`, so the animated branch cannot engage there anyway.
  const imgOffset = segStart == null ? 0 : Math.max(0, segStart - (item.start ?? 0))
  const anim = animatedGeometry(item, 'image', vw, vh, imgOffset, duration, warnIfCapped(item, 'image'))

  const inputArgs = ['-loop', '1', '-t', String(duration), '-i', item.src]
  const filterParts = []

  // Fit the source image into its scaledW×scaledH box. Default 'cover' preserves
  // aspect ratio and fills the box (cropping overflow); 'contain' preserves AR and
  // letterboxes with transparency; 'fill' is the legacy stretch-to-box behavior
  // (does NOT preserve AR — kept only for explicit opt-in). Mirrors the AR-safe
  // treatment the video branch already applies via force_original_aspect_ratio.
  const fit = imageFitFor(item)
  // When animated, the fit runs to the PEAK box and the varying resize is
  // appended after it. All three fits stay correct under that split because the
  // peak box and every animated box share the CANVAS's aspect ratio, so the
  // trailing resize is uniform and changes framing in none of them.
  const fitW = anim?.needsAnimatedChain ? anim.peakW : scaledW
  const fitH = anim?.needsAnimatedChain ? anim.peakH : scaledH
  // PV55: the source crop, BEFORE the fit. Keyframed: a chain that outputs the
  // fitted box itself (animatedImageCrop). Held still: `sourceCrop` in the
  // image's own pixels, then the fit as always. No stored size is needed there.
  const cropAnim = animatedImageCrop(item, fitW, fitH, imgOffset, duration, warnIfCapped(item, 'image'), opts?.cropBudgetPx)
  let stillCrop = item.sourceCrop
  if (cropAnim?.hold) {
    stillCrop = geometryAt(item, 'image', imgOffset).sourceCrop
    console.warn(`[montaj] image item ${item.id ?? item.src}: ${cropAnim.hold}, so its animated crop is held at ${imgOffset}s`)
  }
  const cropStep = !cropAnim?.chain && isFiniteCrop(stillCrop) && stillCrop.w > 0 && stillCrop.h > 0 && !isFullFrameCrop(stillCrop)
    ? `crop=w='round(iw*${stillCrop.w})':h='round(ih*${stillCrop.h})':x='round(iw*${stillCrop.x})':y='round(ih*${stillCrop.y})':exact=1,`
    : ''
  let fitChain
  if (fit === 'contain') {
    fitChain = `scale=${fitW}:${fitH}:force_original_aspect_ratio=decrease,format=rgba,`
             + `pad=${fitW}:${fitH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
  } else if (fit === 'fill') {
    fitChain = `scale=${fitW}:${fitH},format=rgba`
  } else { // 'cover' (default)
    fitChain = `scale=${fitW}:${fitH}:force_original_aspect_ratio=increase,`
             + `crop=${fitW}:${fitH},format=rgba`
  }
  fitChain = cropAnim?.chain ?? (cropStep + fitChain)
  // No alpha pin on the rotate: all three fit chains already run through
  // `format=rgba`, so the transparent pad and `c=black@0.0` corners are
  // representable exactly as the static path assumes.
  const animStep = anim?.needsAnimatedChain
    ? `,scale=w='${anim.boxWExpr}':h='${anim.boxHExpr}':eval=frame${animatedRotateStep(anim, false)}`
    : ''
  // Rotate AFTER the fit chain, BEFORE setpts: the fit chain is what establishes
  // the scaledW×scaledH box rotation is defined against, and setpts is timing,
  // not geometry, so it neither cares nor should pay for the grown frame. No
  // alpha pin — all three fit chains above run through `format=rgba`, so the
  // `c=black@0.0` corners are already representable.
  filterParts.push(
    `[${idx}:v]${fitChain}${anim?.needsAnimatedChain ? animStep : rotateFilterStep(box)},setpts=PTS-STARTPTS[img${idx}]`
  )
  let src = `[img${idx}]`
  if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[imgop${idx}]`)
    src = `[imgop${idx}]`
  }
  // box.x/box.y, not the unrotated x/y: a rotated frame arrives here at
  // outW×outH, so compositing it at the unrotated top-left would translate it
  // by half the growth instead of turning it in place.
  // Opacity is NOT animated even when a curve exists — see the video path.
  const iPos = anim
    ? (anim.needsAnimatedChain ? { x: anim.xExpr, y: anim.yExpr } : staticBoxPosition(anim, box))
    : null
  filterParts.push(
    `${videoLabel}${src}overlay=` +
    `x=${iPos ? `'${iPos.x}'` : box.x}:y=${iPos ? `'${iPos.y}'` : box.y}` +
    `:shortest=0[iv${idx}]`
  )
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
 * @param {number} [opts.cropBudgetPx]    — test seam: a keyframed crop's pixel
 *   budget, MAX_ANIMATED_CROP_PX when absent. No production caller passes it.
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string,
 *   audioTrim: string }} audioTrim is the head of this item's audio chain, which
 *   must cut the same source window as the video (the caller builds the audio)
 */
export function buildVideoItemFilterParts(item, vw, vh, idx, videoLabel, opts) {
  const { segStart, duration, projectColorSpace, zscaleAvailable,
          lut3dAvailable, sdrCurve, cropBudgetPx } = opts

  // Geometry comes from the shared resolver — see @bycrux/timeline-core's
  // src/geometry.js. This file used to carry its own copy of the formula; three
  // copies lived here and a fourth in the editor, which is what KNOWN-DIVERGENCES
  // D9 tracked. Equivalence is pinned by timeline-core's switchover sweep.
  // See the note on the image path: toRotatedPixelBox delegates for
  // scaledW/scaledH and adds the grown box plus its centre-preserving top-left.
  const box = toRotatedPixelBox(geometryFor(item, 'video'), vw, vh)
  const { scaledW, scaledH } = box

  const inPt = item.inPoint ?? 0
  const seekOffset = Math.max(0, segStart - item.start)
  // Per-clip playback speed (montaj/speed feature): at speed S the clip
  // consumes S× the source per timeline-second, so the seek advance and the
  // input trim window both scale by S. STRICT NO-OP at S undefined/1 — every
  // string below must stay byte-identical to the pre-speed pipeline (two
  // frozen encode-args goldens depend on it), so the `*speed` arithmetic only
  // runs when hasSpeed is true.
  const speed = item.speed
  const hasSpeed = speed != null && speed !== 1
  const actualIn = hasSpeed ? inPt + seekOffset * speed : inPt + seekOffset

  // `seekOffset` is ITEM-relative TIMELINE seconds at the instant ffmpeg's `t`
  // reads 0, which is exactly the base `Keyframe.t` is authored in — so it is
  // the shift the compiler needs, and it is speed-independent. Speed scales the
  // SOURCE seek (`actualIn`, above) because a 2x clip eats 2x the source per
  // timeline-second; it does not scale timeline time. `setpts` at the head of
  // the chain divides PTS by the speed, so every downstream filter's `t` is
  // already back in timeline seconds. Verified against real footage at 1x, 2x
  // and 0.5x: the animation lands identically at all three.
  const anim = animatedGeometry(item, 'video', vw, vh, seekOffset, duration, warnIfCapped(item, 'video'))

  // ProRes 4444 (.mov from remove-bg) has alpha — use format=auto
  const ovFmt = item.src.endsWith('.mov') ? ':format=auto' : ':format=yuv420'

  const itemColorSpace = detectFromTransfer(item.colorTransfer)
  // The key this item's conversion starts from. render.js's per-layer SDR pass
  // (PV42) stamps `gradeFrom` on every video item it prepares: the Vivid source
  // key for an HDR-origin layer, taken from the file it decodes, or null for a
  // layer the SDR output does not grade (converting from the project's own key
  // is no conversion at all). Whether a layer is graded is provenance, decided
  // once by sdr-layer.js, never re-derived here from the transfer. An item
  // without the field (every SDR project, the HDR pass) converts from its
  // decoded transfer, exactly as before.
  const convertFrom = item.gradeFrom !== undefined
    ? (item.gradeFrom ?? projectColorSpace)
    : itemColorSpace
  const skipConversionForAlpha = item.remove_bg && item.nobg_src
  const conversionFilter = skipConversionForAlpha
    ? ''
    : buildColorConversionFilter(convertFrom, projectColorSpace, zscaleAvailable,
        { sdrCurve, hasLut3d: lut3dAvailable, srcUntagged: item.colorTransfer === 'unknown' })
  // A remove_bg cutout of HDR footage in the SDR pass (PV42 T8): render.js
  // stamps `alphaGrade`, and `gradeFrom` with the provenance key, since the
  // alpha file it decodes is untagged. Its colour is graded on a split branch
  // (buildCutoutGradeFilter) and its alpha merged back, after crop and scale,
  // before pad; the pin to yuv420p is the same as gradePin's below, and
  // yuva420p gives alphamerge a plane to write. Every other cutout, and every
  // cutout in an HLG or PQ segment, keeps skipConversionForAlpha untouched.
  const cutoutGrade = skipConversionForAlpha && item.alphaGrade === true
    && projectColorSpace === 'sdr_bt709' && isHdr(convertFrom)
    ? `${buildCutoutGradeFilter(convertFrom, zscaleAvailable, { sdrCurve, hasLut3d: lut3dAvailable })},`
      + 'format=yuv420p,format=yuva420p'
    : ''
  // An HDR→SDR grade ends pinned to yuv420p, as derive-sdr.js and
  // lib/normalize.py already pin it, so the Vivid chain's own last zscale
  // (m=bt709:r=tv) does the RGB→YUV step and the 4:2:0 subsampling, exactly as
  // on those two paths. Unpinned, that step fell to whatever scaler ffmpeg
  // inserted downstream. Under the old untagged canvas it used the BT.601
  // matrix. With the canvas tagged (Step 1 of encodeSegment) the matrix comes
  // out right either way, and what the pin still decides is where chroma is
  // subsampled: on a letterboxed item (transparent pad) the unpinned grade
  // drifted from the pinned one at colour edges (measured: max 56 / mean abs
  // 0.57, pinned 21 / 0.29). Pinned by composite-matrix.integration.test.mjs.
  // Keyed on the same effective key as the conversion (convertFrom, above).
  const gradePin = conversionFilter && isHdr(convertFrom) && projectColorSpace === 'sdr_bt709'
    ? 'format=yuv420p,' : ''
  const conversionStep = conversionFilter ? `${conversionFilter},${gradePin}` : ''

  // Source seconds this segment consumes from the item (speed-scaled).
  const srcDur = hasSpeed ? duration * speed : duration
  // Two-stage seek (PV48, see twoStageSeek): the input seeks to `near`, and
  // `trim` / `atrim` (below, and audioTrim for encodeSegment) keep `srcDur`
  // seconds from `fine` on. `duration=`, not an end time, because that is what
  // the single seek's `-t` did: it counts from the first frame kept, which is
  // not always at the seek instant. The input's `-t` is only an upper bound
  // now, one second past the end so it can never cut a frame the trim keeps.
  // A seek of 0 keeps the single-seek strings byte for byte.
  const seek = twoStageSeek(actualIn)
  // -err_detect ignore_err + -max_error_rate 1.0: tolerate broken audio
  // packets from iPhone .MOV sources (see encodeSegment for full comment).
  const inputArgs = [
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    ...(seek
      ? ['-ss', String(seek.near), '-t', String(Number(seek.fine) + srcDur + 1), '-i', item.src]
      : ['-ss', String(actualIn), '-t', String(srcDur), '-i', item.src]),
  ]
  const trimStep = seek ? `trim=start=${seek.fine}:duration=${srcDur},` : ''
  const audioTrim = seek ? `atrim=start=${seek.fine}:duration=${srcDur}` : `atrim=0:${srcDur}`
  const filterParts = []

  // The box the footage is fitted and padded into: the PEAK box when the box
  // itself animates (animatedGeometry), else the item's own.
  const padW = anim?.needsAnimatedChain ? anim.peakW : scaledW
  const padH = anim?.needsAnimatedChain ? anim.peakH : scaledH

  // Optional source crop (clips workflow vertical reframe). Needs source pixel
  // dims; no-op without them. Even dims keep ffmpeg/x264 happy.
  let cropStep = ''
  // The size the `scale` step below receives, when it is known: the crop's own
  // output when a crop runs, otherwise the display size render.js probed.
  let footageW = null
  let footageH = null
  let sc = item.sourceCrop
  // PV55 phase 2: a KEYFRAMED crop takes the crop slot with a moving crop
  // (animatedVideoCrop). Its output is a constant frame, so everything after it
  // (the decrease-fit, the conversion, the pad, the rotate) is unchanged and
  // never sees the varying size, which lives only inside that chain. Without a
  // source size (validate requires one) it renders uncropped, as a still crop
  // does; a rect that is not finite and positive holds the segment start's.
  let movingCrop = null
  if (hasCropKeyframes(item)) {
    const who = `[montaj] video item ${item.id ?? item.src ?? '(unnamed)'}`
    if (!(item.sourceWidth > 0 && item.sourceHeight > 0)) {
      console.warn(`${who}: its crop is keyframed but it has no sourceWidth/sourceHeight, so it renders uncropped`)
    } else {
      movingCrop = animatedVideoCrop(item, padW, padH, seekOffset, duration, warnIfCapped(item, 'video'), cropBudgetPx)
      if (movingCrop.hold) {
        const held = geometryAt(item, 'video', seekOffset).sourceCrop
        sc = isFiniteCrop(held) && held.w > 0 && held.h > 0 ? held : null
        console.warn(`${who}: ${movingCrop.hold}, so its animated crop is ${sc ? `held at ${seekOffset}s` : 'dropped'}`)
      }
    }
  }
  if (movingCrop?.chain) {
    cropStep = `${movingCrop.chain},`
    footageW = movingCrop.width
    footageH = movingCrop.height
  } else if (sc && item.sourceWidth && item.sourceHeight) {
    const cw = Math.round(item.sourceWidth  * sc.w / 2) * 2  // even: x264 needs even dims
    const ch = Math.round(item.sourceHeight * sc.h / 2) * 2  // even: x264 needs even dims
    const cx = Math.round(item.sourceWidth  * sc.x)          // origin NOT even-rounded (offsets don't require it)
    const cy = Math.round(item.sourceHeight * sc.y)          // origin NOT even-rounded
    cropStep = `crop=${cw}:${ch}:${cx}:${cy},`
    footageW = cw
    footageH = ch
  } else if (item.probedWidth > 0 && item.probedHeight > 0) {
    footageW = item.probedWidth
    footageH = item.probedHeight
  }

  // STEP ORDER IS LOAD-BEARING: crop → scale → convert → pad → rotate
  // (SP6b T6; rotate added by SP9a-2).
  //
  // A keyframed crop (PV55 phase 2) fills the crop slot with
  // crop(union) → scale(eval=frame) → crop(fixed): the only varying frame size
  // in this chain, and it ends at that fixed crop, ahead of everything below.
  // Nothing may be inserted between its scale and its fixed crop
  // (movingCropChain).
  //
  // Geometry first. The conversion used to run at the head of this chain, which
  // meant tone-mapping every source pixel in float before throwing most of them
  // away — a 4K clip feeding a 1080 canvas paid ~9× the pixels it needed. crop
  // and scale are pure geometry (they resample, they don't reinterpret color),
  // so doing them first is color-neutral and the conversion then runs on canvas
  // -sized frames.
  //
  // pad stays AFTER the conversion, exactly as before. Its bars are synthesized
  // (opaque black, or transparent — see `padStep` below), and synthesizing them
  // post-conversion keeps them in the final domain — black in, black out. Move
  // pad ahead of the conversion and those bars get pushed through the LUT with
  // everything else, which maps them to whatever the grade does to 0,0,0 and
  // tints the letterbox.
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
  //
  // rotate goes LAST, after pad, for two independent reasons.
  //
  // Geometrically it has to. Rotation is defined against the scaledW×scaledH
  // box the item occupies on the canvas, and it is `pad` that produces that
  // box — `scale=…:force_original_aspect_ratio=decrease` fits INSIDE it and
  // generally lands smaller. Rotating before pad would turn the decrease-fit
  // frame and then letterbox the result, i.e. rotate the wrong rectangle and
  // put the bars on the wrong axis.
  //
  // And it is the cheap place. rotate is the one geometry step that GROWS the
  // frame — at scale 1, 45° the bounding box is ~2.2× the pixels — so rotating
  // ahead of the conversion would hand every one of those extra pixels to the
  // LUT chain (rgb48le + lut3d + two zscales), which is by far the most
  // expensive stretch in this graph. Same instinct as the crop → scale →
  // convert ordering above: never make the color chain pay for pixels the
  // geometry chain could have settled first.
  const divisibleBy = (conversionStep || cutoutGrade) ? ':force_divisible_by=2' : ''
  // setpts time-compresses the sped-up source back to timeline-real-time: at
  // speed S the S× extra source seconds consumed above play out over 1/S the
  // time. A no-op (bare setpts=PTS-STARTPTS) at speed undefined/1.
  const ptsStep = hasSpeed ? `setpts=(PTS-STARTPTS)/${speed}` : 'setpts=PTS-STARTPTS'
  // An untagged video is taken as BT.709, which is what it is underneath in
  // practice (web downloads such as X exports; remove_bg's ProRes, which keeps
  // its source's YUV). Against the tagged SDR canvas an untagged layer would be
  // read as "unknown" (BT.601) and converted: measured red -19/-25, green
  // +8/+19. Tagged here, it composites unchanged, as it did before the canvas
  // was tagged. Keyed on the probed transfer, which render.js stamps 'unknown'
  // for an untagged file. Overlay captures and images are NOT tagged: those are
  // encoded from RGB with ffmpeg's BT.601 default, and converting them is right.
  // A graded cutout is the exception: its alpha file holds HDR signal, and the
  // grade's own declaration says so (buildCutoutGradeFilter).
  const untaggedTag = !isHdr(projectColorSpace) && item.colorTransfer === 'unknown' && !cutoutGrade
    ? 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709,' : ''

  // ── The pad fill: transparent where the preview shows nothing ─────────────
  //
  // The pad fills the part of the box the decrease-fit footage does not cover.
  // The editor preview and sample_frame (which composites a video frame through
  // the image path's `contain` fit) show that area as EMPTY — whatever sits
  // underneath shows through. `pad`'s default fill is opaque black, so before
  // this fill existed the export drew black bars there instead, and on a
  // remove_bg cutout they blacked out everything behind the presenter.
  //
  // The transparent fill is emitted only when it can change the picture: the
  // fit leaves more than a 1 px gap (the tolerance absorbs rounding), or the
  // footage has alpha of its own, which the pad must carry through untouched.
  // Everything else — footage that fills its box, and every item whose size is
  // unknown (no crop, no probe: dry runs, a failed ffprobe) — keeps the exact
  // opaque-pad string it always had, so a render with nothing to fix is
  // byte-identical.
  //
  // The explicit `format=` is what GUARANTEES `color=black@0.0` means
  // transparent: pad draws in whatever format negotiation hands it, and an
  // alpha-less one would silently drop the @0.0. (In the measured SDR chain
  // negotiation happened to pick an alpha format anyway; the pin makes that a
  // property instead of luck, as rotateFilterStep's pin does.) Which format:
  //   • yuva420p — the SDR path. It is the format `overlay=format=yuv420`
  //     converts its input to anyway, so the pin adds no conversion.
  //   • yuva444p10le — whenever a colour conversion ran (the LUT chain works in
  //     rgb48le/zscale) or the project is HDR (10-bit canvas). 10-bit keeps the
  //     pad from becoming an 8-bit bottleneck ahead of the overlay; 4:4:4 keeps
  //     it from making a chroma-subsampling decision the encoder makes anyway;
  //     YUV rather than rgba64le because the conversion's output is already
  //     tagged limited-range BT.709/2020 YUV, and a round trip through RGB would
  //     re-apply a colour matrix swscale picks by default. The managed ffmpeg
  //     8.1.2's trailing zscale writes yuva444p10le itself (measured: no
  //     auto-inserted scaler); a build whose zscale lacks alpha formats gets a
  //     lossless yuv→yuva conversion inserted instead.
  // An HDR→SDR grade reaches this pad already pinned to yuv420p (gradePin,
  // above), so for it the 10-bit pin only adds the alpha plane.
  // A rotated item still passes through rotateFilterStep's `format=yuva420p`
  // pin after this, which narrows a converted item to 8 bits before `rotate`.
  // That predates this fill and is left alone here.
  let transparentPad = item.probedAlpha === true
  if (!transparentPad && footageW && footageH) {
    const fit = decreaseFitSize(footageW, footageH, padW, padH, (conversionStep || cutoutGrade) ? 2 : 1)
    transparentPad = padW - fit.width > 1 || padH - fit.height > 1
  }
  const padAlphaFmt = (conversionStep || isHdr(projectColorSpace)) ? 'yuva444p10le' : 'yuva420p'
  const padStep = transparentPad
    ? `format=${padAlphaFmt},pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
    : `pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2`

  // The animated branch sizes scale+pad to the PEAK box instead of the current
  // one and appends the varying resize AFTER the pad, so the conversion and
  // `rotate` only ever see a constant frame size — see animatedGeometry's header
  // for why all three of them silently mis-render otherwise. With an opaque pad
  // the static branch below is byte-for-byte what it has always been; the frozen
  // goldens say so.
  // trimStep first: it counts in source seconds, before the speed setpts.
  const head = `[${idx}:v]${trimStep}${untaggedTag}${ptsStep},${cropStep}` +
    (anim?.needsAnimatedChain
      ? `scale=${anim.peakW}:${anim.peakH}:force_original_aspect_ratio=decrease${divisibleBy},`
      : `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease${divisibleBy},`)
  const tail = anim?.needsAnimatedChain
    ? `${padStep},` +
      `scale=w='${anim.boxWExpr}':h='${anim.boxHExpr}':eval=frame` +
      `${animatedRotateStep(anim, true)}`
    : `${padStep}${rotateFilterStep(box, true)}`
  if (cutoutGrade) {
    // The graded cutout: colour and alpha split after scale, the colour graded,
    // the alpha merged back, then the same pad (yuva420p: the SDR path's pin,
    // a no-op on alphamerge's output) and rotate as any other item. `[a${idx}]`
    // is this item's audio label (encodeSegment's Step 5), hence `ca`.
    // The pin before split is load-bearing: split gives both outputs one
    // format, and without it the grade's branch negotiates an alpha-less one
    // that alphaextract cannot read ("could not choose their formats",
    // measured on ffmpeg 8.1.2). yuva444p12le is what ProRes 4444 decodes to,
    // so the pin adds no conversion.
    filterParts.push(
      `${head}format=yuva444p12le,split=2[c${idx}][ca${idx}]`,
      `[ca${idx}]alphaextract[al${idx}]`,
      `[c${idx}]${cutoutGrade}[cg${idx}]`,
      `[cg${idx}][al${idx}]alphamerge,${tail}[vid${idx}]`,
    )
  } else {
    filterParts.push(`${head}${conversionStep}${tail}[vid${idx}]`)
  }
  let src = `[vid${idx}]`
  if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[vidop${idx}]`)
    src = `[vidop${idx}]`
  }
  // box.x/box.y, not the unrotated x/y — see the image path.
  // Opacity is NOT animated even when a curve exists: `colorchannelmixer aa` is
  // a <double> and accepts no expression, so the static value above stands and
  // the curve is ignored. Documented in docs/RENDER.md; pinned by a test.
  const vPos = anim
    ? (anim.needsAnimatedChain ? { x: anim.xExpr, y: anim.yExpr } : staticBoxPosition(anim, box))
    : null
  filterParts.push(
    `${videoLabel}${src}overlay=` +
    `x=${vPos ? `'${vPos.x}'` : box.x}:y=${vPos ? `'${vPos.y}'` : box.y}` +
    `${ovFmt}:shortest=0[iv${idx}]`
  )
  const newVideoLabel = `[iv${idx}]`

  return { inputArgs, filterParts, newVideoLabel, audioTrim }
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
 * @param {number} opts.fps — REQUIRED for stream overlays (see the guard below). The
 *   segment's own fps, the same value that generates the base canvas, so the overlay
 *   is re-stamped onto exactly the grid it will be composited against.
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
 * @param {boolean} [opts.captureToBt709=false] — convert the capture from BT.601
 *   (what renderer.js's untagged PNG→FFV1 encode writes) to bt709 inside the scale
 *   step, with accurate rounding. encodeSegment sets it for an SDR segment, whose
 *   canvas is tagged bt709; see the note at the scale step. PNG callers leave it off.
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
export function buildOverlayFilterParts(ov, vw, vh, ovIdx, videoLabel, segStart, duration, opts = {}) {
  const inputFormatFlag     = opts.inputFormatFlag     ?? 'yuva420p'
  const compositeFormatFlag = opts.compositeFormatFlag ?? 'yuv420'
  const loopedInput         = opts.loopedInput         ?? false

  // Stream overlays MUST declare the segment's fps. The FFV1-in-Matroska chunk
  // carries millisecond-rounded PTS (0.033/0.067/0.100 against the base
  // canvas's exact 0.033333/0.066667/0.100000), so framesync holds every third
  // frame unless the input is re-stamped onto the exact grid below. Defaulting
  // this to 30 would silently reintroduce that defect on any 24 or 60 fps
  // project — hence a throw, not a fallback.
  if (!loopedInput && !(opts.fps > 0)) {
    throw new Error('buildOverlayFilterParts: opts.fps is required for stream overlays')
  }

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
  //
  // ── Keyframed overlays are already positioned (SP9b T2.3) ─────────────────
  //
  // This filter graph places an overlay ONCE for the whole segment; there is no
  // per-frame hook in it. So an ANIMATED overlay is positioned somewhere that
  // does have one — the Puppeteer page — where the shim wraps the component in a
  // full-canvas layer carrying `geometryAt(item,'overlay',frame/fps)` as a CSS
  // transform (bundle.js `generateShim`). By the time the capture reaches this
  // function, offset/scale/rotation/opacity are IN THE PIXELS, and the only
  // correct thing left to do is drop the (already design-canvas-sized) frame
  // onto the output canvas unchanged.
  //
  // "Unchanged" is spelled as the IDENTITY geometry rather than as hand-written
  // numbers, so it inherits the even-pixel rounding (`round(vw/2)*2`) every
  // other path here uses, and `rotateFilterStep` sees an identity box and emits
  // nothing — a keyframed overlay must NOT rotate twice.
  //
  // Applying `geometryFor` here as well would DOUBLE-apply the transform: a
  // half-scaled, animated overlay would come out quarter-sized.
  const keyframed = Array.isArray(ov.keyframes) && ov.keyframes.length > 0
  const ovBox = toRotatedPixelBox(keyframed ? BAKED_OVERLAY_GEOMETRY : geometryFor(ov, 'overlay'), vw, vh)
  const { scaledW: targetW, scaledH: targetH } = ovBox

  // Force yuva420p (or caller-specified format) — VP9 decoders may silently drop
  // the alpha plane on the production path; PNG-based callers pass 'rgba' to
  // avoid an unnecessary colorspace bounce.
  const ptsPin = loopedInput ? '' : `,setpts=N/(${opts.fps}*TB)`
  filterParts.push(`[${ovIdx}:v]format=${inputFormatFlag}${ptsPin}[ovfmt${ovIdx}]`)
  let ovSrc = `[ovfmt${ovIdx}]`

  // Scale design-canvas → output-canvas (× user scale). When the output already
  // matches the design canvas at scale 1 this is an identity scale (1080→1080),
  // which ffmpeg fast-paths.
  // Rotate AFTER that scale — the design→output scale is what establishes the
  // targetW×targetH box rotation turns within. No alpha pin needed here: the
  // `format=${inputFormatFlag}` step above already put this chain in yuva420p
  // (or rgba for the PNG callers), so `c=black@0.0` is representable.
  //
  // captureToBt709: the capture is BT.601 (renderer.js encodes its RGB PNGs
  // with ffmpeg's default for an untagged stream) and the SDR canvas is bt709.
  // Left to the scaler ffmpeg inserts before `overlay`, that conversion is
  // correct in colour but not in level on a width that is not a multiple of 16
  // (1080, the usual vertical canvas): measured white Y 235 → 233, grey
  // 126 → 124. Done here, with accurate_rnd+full_chroma_int, it is exact at
  // every width, and the output is tagged so the overlay has nothing to convert.
  const to709 = opts.captureToBt709
    ? ':flags=bicubic+accurate_rnd+full_chroma_int:in_color_matrix=bt601:out_color_matrix=bt709'
      + ':in_range=tv:out_range=tv,setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv'
    : ''
  filterParts.push(`${ovSrc}scale=${targetW}:${targetH}${to709}${rotateFilterStep(ovBox)}[ovsc${ovIdx}]`)
  ovSrc = `[ovsc${ovIdx}]`

  // Item-level opacity, in the same position and the same shape the image path
  // (buildImageItemFilterParts) and video path (buildVideoItemFilterParts) have
  // always used it: after the geometry chain, before the composite.
  //
  // This was MISSING here until SP9b, and missing in two places at once — this
  // function had no opacity term at all, and render.js never stamped `opacity`
  // onto the descriptor to begin with. A translucent overlay therefore looked
  // translucent in the editor preview and rendered fully opaque. Both ends are
  // fixed now. Unrelated to keyframes; it was simply a gap.
  //
  // The epsilon guard is the sibling paths' guard verbatim, and it is
  // load-bearing beyond tidiness: opacity 1 (and absent) must emit NOTHING, so
  // every overlay that does not set opacity keeps a byte-identical filter graph
  // and the frozen render goldens stay valid.
  //
  // NOT applied to a keyframed overlay: the shim already baked opacity into the
  // capture as CSS (bundle.js `generateShim`), so a second multiply here would
  // square it — 0.5 would render at 0.25. The two paths are mutually exclusive
  // by construction, and the alpha is definitely present either way because the
  // `format=${inputFormatFlag}` step above pinned this chain to yuva420p/rgba.
  if (!keyframed && Math.abs((ov.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${ovSrc}colorchannelmixer=aa=${ov.opacity}[ovop${ovIdx}]`)
    ovSrc = `[ovop${ovIdx}]`
  }

  // ovBox.x/ovBox.y is the top-left of the GROWN box; identical to the
  // unrotated top-left whenever the overlay is not rotated. `overlay` accepts
  // negative coordinates, and a rotated overlay near an edge legitimately
  // produces them — do not clamp.
  filterParts.push(
    `${videoLabel}${ovSrc}overlay=x=${ovBox.x}:y=${ovBox.y}:format=${compositeFormatFlag}:shortest=0[vov${ovIdx}]`
  )
  const newVideoLabel = `[vov${ovIdx}]`

  return { inputArgs, filterParts, newVideoLabel }
}

/**
 * Pitch-preserving time-compression chain for a sped-up clip's audio.
 * ffmpeg's `atempo` filter accepts a per-instance factor in [0.5, 2.0] only —
 * outside that range it must be chained, each instance's factor still within
 * bounds, so their product equals the requested speed. Preserves pitch, unlike
 * scaling PTS directly (which is how the video side re-times, but would
 * chipmunk/slow-motion-drone the audio).
 *
 * @param {number} speed — clip playback speed, e.g. 4 or 0.25
 * @returns {string} e.g. speed=4 -> 'atempo=2,atempo=2'; speed=0.25 -> 'atempo=0.5,atempo=0.5'
 */
function atempoChain(speed) {
  const factors = []
  let r = speed
  while (r > 2.0) { factors.push(2.0); r /= 2.0 }
  while (r < 0.5) { factors.push(0.5); r *= 2.0 }
  factors.push(r)
  return factors.map((f) => `atempo=${f}`).join(',')
}

/**
 * How far through its crossfade this item is at BOTH ends of one segment, or
 * null when it is not crossfading here.
 *
 * `item.crossfade` (stamped by render.js's collectAllItems) carries the PAIR'S
 * SPAN in timeline seconds — `{ role, start, end }` — never a progress value,
 * and the progress is derived here instead. That split is forced, not stylistic:
 * `segment-plan.js`'s `activeIn` hands every segment the SAME item objects (it
 * "preserves input order and object identity"), so one item is shared by every
 * segment it is active in and a per-segment number has nowhere to live on it.
 *
 * Deriving it here is also what gates the fade correctly. The outgoing clip
 * carries its `crossfade` through every earlier segment too, and `p0 === p1`
 * there — so a segment sitting outside the span reads as "not transitioning"
 * and emits exactly the graph it always did, rather than fading a clip to
 * silence long before the overlap begins.
 *
 * @param {object} [item]
 * @param {number} segStart
 * @param {number} segEnd
 * @returns {{ role: 'from' | 'to', p0: number, p1: number } | null}
 */
function crossfadeIn(item, segStart, segEnd) {
  const cf = item?.crossfade
  if (!cf) return null
  const p0 = transitionProgress(cf, segStart)
  const p1 = transitionProgress(cf, segEnd)
  if (!(p1 > p0)) return null
  return { role: cf.role, p0, p1 }
}

/**
 * Match every outgoing item with the incoming one it is actually paired with,
 * and return the items reordered so each matched partner sits IMMEDIATELY
 * AFTER its own outgoing item.
 *
 * ── WHY THIS EXISTS: THE TWO HALVES DO NOT ARRIVE ADJACENT ─────────────────
 *
 * They do not even arrive in document order. `compose.js` merges its two
 * collections as `[...imageItems, ...videoItems]` and `planSegments`
 * stable-sorts that by `trackIdx` ONLY, so two clips sharing a track keep the
 * images-before-videos order the merge imposed (KNOWN-DIVERGENCES D7). A
 * video → image transition therefore reaches the encoder with the INCOMING
 * item FIRST. Read the partner off `items[ii + 1]` and that pair finds no
 * incoming item at all: the export hard-cuts while the preview,
 * `sample-frame.js` and the audio ramp all crossfade. Worse, when some
 * unrelated item happens to sit at `ii + 1` — the incoming half of a DIFFERENT
 * pair, on a different track — position-matching adopts it and splits the
 * canvas around a pair that does not exist.
 *
 * ── WHAT IDENTIFIES A PAIR: THE SPAN, PLUS THE TRACK ───────────────────────
 *
 * `render.js` stamps the identical `{ start, end }` on both halves as it walks
 * `transitionPairs`, so the span is the pair's NAME — the one fact both sides
 * share and nobody else does. The track is the other half of the rule because
 * crossfades are derived PER TRACK: two items on different tracks are stacked,
 * not sequenced, so blending them is meaningless even when their spans
 * coincide (which, for two transitions running at the same instant, they do).
 * Array position identifies nothing at all.
 *
 * The search runs over the WHOLE array rather than forward from the outgoing
 * item, because in front of it is exactly where the partner is most often
 * found — see the merge order above.
 *
 * ── REORDERING IS SAFE FOR Z-ORDER ─────────────────────────────────────────
 *
 * `planSegments` hands this an array already sorted ascending by `trackIdx`,
 * and a pair shares a track, so every item BETWEEN the two halves shares that
 * track too. The permutation is contained inside a single track's group —
 * where the order was already the arbitrary images-then-videos artifact of the
 * merge and never a meaningful z-order. Nothing moves across tracks, so the
 * layering the segment renders is untouched. Reordering here (rather than
 * matching at the branch) is also what keeps the compositing correct when a
 * third item on the same track sits between the two halves: it would otherwise
 * composite onto ONE branch of the split and vanish from the other.
 *
 * @param {object[]} items — one segment's visual items, trackIdx-ascending
 * @param {number} segStart
 * @param {number} segEnd
 * @returns {{ items: object[], partnerOf: Map<object, object>, paired: Set<object> }}
 *   `partnerOf` is keyed by outgoing item; `paired` holds BOTH halves of every
 *   matched pair, and is what gates the audio ramp.
 */
function matchCrossfadePairs(items, segStart, segEnd) {
  const partnerOf = new Map()
  const paired = new Set()
  for (const from of items) {
    if (crossfadeIn(from, segStart, segEnd)?.role !== 'from') continue
    const span = from.crossfade
    // `!paired.has(c)` keeps two simultaneous transitions from claiming the
    // same incoming item; missing trackIdx reads as 0, matching timeline-core's
    // `byTrackIdx` (segment-plan.js's sort comparator).
    const to = items.find((c) =>
      !paired.has(c) &&
      (c.trackIdx ?? 0) === (from.trackIdx ?? 0) &&
      c.crossfade?.start === span.start &&
      c.crossfade?.end === span.end &&
      crossfadeIn(c, segStart, segEnd)?.role === 'to')
    if (!to) continue
    partnerOf.set(from, to)
    paired.add(from)
    paired.add(to)
  }
  // The overwhelmingly common case: nothing is transitioning here. Return the
  // caller's own array so a segment with no pair is byte-identical to one from
  // a project that has no transition anywhere.
  if (partnerOf.size === 0) return { items, partnerOf, paired }

  // Stable: every item keeps its place except a matched incoming one, which is
  // lifted out and re-inserted directly behind its own outgoing item.
  const lifted = new Set(partnerOf.values())
  const ordered = []
  for (const item of items) {
    if (lifted.has(item)) continue
    ordered.push(item)
    const to = partnerOf.get(item)
    if (to) ordered.push(to)
  }
  return { items: ordered, partnerOf, paired }
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
  const { start, end, overlays, vw, vh, fps } = segment
  // Pair up the crossfading items BEFORE anything is emitted. `items` is the
  // reordered array from here down, so every "the incoming item follows the
  // outgoing one" assumption below is true by construction rather than by
  // luck — see matchCrossfadePairs for why the raw order cannot be trusted.
  const { items, partnerOf, paired } = matchCrossfadePairs(segment.items, start, end)
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
  //
  // The SDR canvas is TAGGED bt709, limited range. ffmpeg 8 negotiates colour
  // space across the graph, and an untagged canvas made `overlay` convert every
  // layer to "unknown", i.e. the BT.601 matrix, while Step 4's setparams labels
  // the file bt709: a bt709 video layer was re-matrixed and an untagged overlay
  // capture or image (601-encoded) went through unconverted. Neutrals have no
  // chroma, so only saturated colours moved (measured: red swatch R +16 / G +22).
  // Tagged, the composite is bit-exact to a bt709 layer and images convert
  // correctly; overlay captures convert in their own scale step
  // (buildOverlayFilterParts' captureToBt709). The HDR canvas is left as it
  // was, so the HLG master stays byte-identical. Pinned by
  // composite-matrix.integration.test.mjs.
  inputs.push('-f', 'lavfi', '-i',
    `color=black:size=${vw}x${vh}:rate=${fps}:duration=${duration}`)
  const canvasTag = isHdr(projectColorSpace) ? '' : `,${spec.setparams}:range=tv`
  filterParts.push(`[0:v]format=${spec.outputPixFmt}${canvasTag}[canvas]`)
  videoLabel = '[canvas]'
  inputIdx++

  // --- Step 2: Visual items layered in trackIdx order (lower = background) ---
  // The half-built crossfade, live only between the outgoing item and its
  // matched partner — which the pre-pass has already placed immediately after
  // it. Carries that partner so the blend closes on the item it opened for and
  // not merely on the next `to` to come along. Null everywhere else.
  let pendingBlend = null
  for (let ii = 0; ii < items.length; ii++) {
    const item = items[ii]
    const idx  = inputIdx

    // ── Clip crossfade ──────────────────────────────────────────────────
    //
    // Split the running canvas, composite the OUTGOING item down one branch
    // and the INCOMING one down the other, then blend the two finished frames.
    //
    // Blending the composited FRAMES (rather than alpha-ramping the incoming
    // item's layer) is what makes this exact: both branches share the same
    // background, so the background cancels out of the mix and what is left is
    // a straight lerp between the two pictures — no dip toward black, and it
    // works whether the items are full-frame or small boxes.
    //
    // `blend` and not `xfade`: xfade can only run a full 0->1 ramp, and a
    // segment gets a PARTIAL slice of the span whenever an overlay or caption
    // boundary lands strictly inside the overlap. `blend`'s all_expr takes the
    // sub-range directly, so there is one code path and no boundary surgery.
    // Its per-pixel cost was measured before this was committed — see the
    // plan's Spike Results.
    //
    // Do NOT "optimize" this to xfade later on its headline 1.10-1.12x. That
    // number is not one cheap filter: xfade refuses 4:2:0 and forces
    // yuva420p -> yuva444p on BOTH branches plus one conversion back to
    // yuv420p10le — three extra full-frame conversions this path never incurs
    // — and it still cannot express a partial ramp, which is the whole reason
    // the design does not use it.
    //
    // Colour: each branch has already been through its own per-item conversion
    // inside buildVideoItemFilterParts, so both sides are in the project's
    // working colour space by the time they meet here. Blending BEFORE that
    // conversion would mix two different transfer curves.
    //
    // The partner is the one `matchCrossfadePairs` matched by SPAN + TRACK, not
    // whatever sits at `items[ii + 1]`. The two halves reach this loop in an
    // order that is neither document order nor adjacency (compose merges
    // `[...imageItems, ...videoItems]`, sorted by trackIdx only), so a
    // positional read blends the wrong pair or no pair at all — the full
    // argument is on that function.
    const xf = crossfadeIn(item, start, end)
    const opensCrossfade = !opaqueVideo && partnerOf.has(item)
    if (opensCrossfade) {
      filterParts.push(`${videoLabel}split=2[xfa${idx}][xfb${idx}]`)
      pendingBlend = { idx, p0: xf.p0, p1: xf.p1, fromOut: null, to: partnerOf.get(item) }
      videoLabel = `[xfa${idx}]`
    }

    if (isImageItem(item)) {
      // Under an opaque overlay the frame is fully covered and images carry no
      // audio, so an image item contributes nothing here — skip it entirely
      // (no input, no inputIdx bump).
      if (opaqueVideo) continue
      const { inputArgs, filterParts: fp, newVideoLabel } =
        buildImageItemFilterParts(item, vw, vh, idx, videoLabel, duration, start)
      inputs.push(...inputArgs)
      filterParts.push(...fp)
      videoLabel = newVideoLabel
    } else {
      // Video clip
      // Per-item color conversion: when the source's color space differs from
      // the project's, inject the conversion filter (tonemap / inverse-stretch /
      // HDR cross). item.colorTransfer is stamped by render.js from the final
      // src, the file decoded here — no per-segment ffprobe.
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
      // The one split that does exist: in an HDR project's SDR export, a cutout
      // of HDR footage (item.alphaGrade) is graded through an alpha split
      // (PV42 T8, buildVideoItemFilterParts / buildCutoutGradeFilter).
      const { inputArgs, filterParts: fp, newVideoLabel, audioTrim } =
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
        //
        // Per-clip speed (S !== 1): the input above was trimmed to S× the
        // segment duration of source seconds (see buildVideoItemFilterParts),
        // so atrim's window widens to match, and atempoChain time-compresses
        // that S× window back down to `duration` output seconds — pitch
        // preserved, unlike scaling PTS the way the video side does. atrim
        // stays BEFORE asetpts either way: it locks the sample range against
        // the input's own (seek-based) PTS, not the zero-based PTS asetpts
        // produces.
        //
        // audioTrim comes from buildVideoItemFilterParts, which owns the seek:
        // `atrim=0:<window>` after a seek of 0, and after a two-stage seek
        // (PV48) `atrim=start=<fine>:duration=<window>`, the same source
        // window as the video's trim.
        const speed = item.speed
        const hasSpeed = speed != null && speed !== 1
        // The picture crossfades; the sound must too, or the overlap plays both
        // clips at full level. Same shape as mix-audio.js's per-track fade, and
        // it runs even under an opaque overlay — opaque replaces the picture,
        // never the voiceover.
        //
        // NOT `afade`: a segment gets a PARTIAL slice of the transition span
        // whenever an overlay or caption boundary lands strictly inside the
        // overlap (same reason the video ramp above uses `blend` and not
        // `xfade`), and `afade` cannot express a partial ramp — it anchors the
        // fade at `st=0` and rejects a negative `st` outright (verified:
        // "Value -0.500000 for parameter 'st' out of range"), so there is no
        // way to tell it "this segment's slice of the fade already began
        // before t=0". Instead this mirrors the video's own `p0 + k*T` ramp
        // (see `prog` above) with a `volume` time expression: `afade`'s
        // default curve is `tri` (linear), so this produces the identical
        // ramp `afade` did for the old full-span case and the correct
        // sub-range ramp for a partial one.
        //
        // Placed after `volume` and before `aformat` so it shapes the item's own
        // level and the existing `amix` then sums two complementary ramps. After
        // `atempoChain` too, on the sped-up branch: by that point the audio has
        // already been time-compressed back to `duration` output seconds, which
        // is the clock this expression's `t` is measured in.
        //
        // Gated on the PAIR, not on this item's own `crossfade` field: an item
        // whose partner could not be matched is not transitioning, whatever its
        // field says, and its picture hard-cuts. Duck its sound anyway and the
        // two disagree about whether a transition is happening — the same fault
        // the partial-segment ramp above fixes, in a different direction (there
        // the ramp had the wrong SHAPE; here it should not exist at all). Note
        // this is the pair and NOT `opensCrossfade`: an opaque overlay replaces
        // the picture, so the blend is skipped while the voiceover underneath
        // still crossfades, and `paired` is deliberately blind to that flag.
        let fade = ''
        if (xf && paired.has(item)) {
          const k = (xf.p1 - xf.p0) / duration
          const aprog = xf.p0 === 0 ? `${k}*t` : `${xf.p0}+${k}*t`
          fade = xf.role === 'from'
            ? `,volume='1-(${aprog})':eval=frame`
            : `,volume='${aprog}':eval=frame`
        }
        const audioFilter = hasSpeed
          ? `[${idx}:a:0]${audioTrim},asetpts=PTS-STARTPTS,${atempoChain(speed)},volume=${vol}${fade},aformat=channel_layouts=stereo:sample_rates=48000[${aLabel}]`
          : `[${idx}:a:0]${audioTrim},asetpts=PTS-STARTPTS,volume=${vol}${fade},aformat=channel_layouts=stereo:sample_rates=48000[${aLabel}]`
        filterParts.push(audioFilter)
        audioLabels.push(`[${aLabel}]`)
      }
    }

    if (opensCrossfade) {
      // Park the outgoing branch's finished frame and send the incoming item
      // down the other half of the split.
      pendingBlend.fromOut = videoLabel
      videoLabel = `[xfb${pendingBlend.idx}]`
    } else if (pendingBlend?.to === item) {
      // Closes on the MATCHED partner by identity — not on the next item that
      // happens to be a `to`. The pre-pass has already made these the same item,
      // and keeping the identity check means a future change to the ordering
      // cannot silently resurrect the cross-track mismatch.
      //
      // ── The EXPRESSION FORM IS LOAD-BEARING (measured, Task 1) ───────────
      //
      // Emit `A+(B-A)*p`, NEVER the algebraically identical `A*(1-p)+B*p`.
      // On a real 4K HDR overlap segment the literal form costs 1.86-2.01x the
      // hard-cut baseline — straddling this feature's 2x gate — while the folded
      // form costs 1.35-1.49x and produces BYTE-IDENTICAL output (verified
      // per-pixel over the whole 8.3 MP frame: max|diff| = 0). `blend` evaluates
      // all_expr per pixel per plane, so one fewer multiply and one fewer
      // subtract per pixel is worth ~0.5x of baseline. Fold the coefficients in
      // JS at graph-build time; do not make ffmpeg do arithmetic it can't hoist.
      //
      // `A` is the FIRST input — verified against ffmpeg, not assumed — so the
      // outgoing branch goes first and the expression lands on it at p=0 and on
      // the incoming one at p=1.
      const { idx: xfIdx, p0, p1, fromOut } = pendingBlend
      // p(T) = p0 + k*T over this segment's own clock. The p0 === 0 case (the
      // common one — a segment covering the whole overlap) drops a term.
      const k = (p1 - p0) / duration
      const prog = p0 === 0 ? `${k}*T` : `${p0}+${k}*T`
      filterParts.push(`${fromOut}${videoLabel}blend=all_expr='A+(B-A)*(${prog})'[xf${xfIdx}]`)
      videoLabel = `[xf${xfIdx}]`
      pendingBlend = null
    }
    inputIdx++
  }

  // --- Step 3: Overlay + caption inputs (captions already sorted last by planSegments) ---
  for (const ov of overlays) {
    const ovIdx = inputIdx
    const { inputArgs, filterParts: fp, newVideoLabel } =
      buildOverlayFilterParts(ov, vw, vh, ovIdx, videoLabel, start, duration,
        { fps, captureToBt709: !isHdr(projectColorSpace) })
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
    // A Dolby Vision source (e.g. an iPhone HDR clip) carries a DV RPU, and
    // nothing upstream strips it: its side data propagates through the filter
    // graph into libx265, which re-emits the RPU in-band (HEVC NAL type 62), and
    // the MP4 muxer then dies with "Error submitting a packet to the muxer: Not
    // yet implemented in FFmpeg, patches welcome". Montaj outputs HDR10/HLG,
    // never Dolby Vision, so the RPU is unwanted — dropping NAL 62 before the
    // muxer leaves plain HEVC (the HDR10 mastering-display / content-light SEI,
    // NAL 39/40, are untouched). No-op on a non-DV or non-HEVC stream.
    ...(/265|hevc/i.test(spec.encoder) ? ['-bsf:v', 'filter_units=remove_types=62'] : []),
    '-g', String(fps), '-keyint_min', String(fps),
    '-t', String(duration),
    '-movflags', '+faststart',
    outputPath,
  ]

  if (opts._dryRun) return { inputs, filterParts, args }

  const result = await runFfmpeg(args, FFMPEG_TIMEOUT_MS, dirname(outputPath))

  if (result.stderr) logFfmpegStderr(result.stderr)

  if (result.status !== 0) {
    throw new Error(`ffmpeg segment encode failed (${start.toFixed(2)}-${end.toFixed(2)}s):\n${(result.stderr || '').slice(-500)}`)
  }

  return outputPath
}
