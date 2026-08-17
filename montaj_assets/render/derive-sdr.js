// render/derive-sdr.js
/**
 * derive-sdr.js — HDR master → SDR rendition, in one ffmpeg pass.
 *
 * `--export both` / `--export sdr` do NOT render the project twice. The project
 * renders once at its own working color space (HLG or PQ), and this module
 * converts that finished master into a Rec.709 SDR sibling through the same
 * Montaj Vivid LUT chain the editor preview, the SDR proxies, and the segment
 * encoder use — so the two renditions are the same edit, graded the same way,
 * and the SDR one matches what the user saw while editing.
 *
 * Video is re-encoded (there is no way to change transfer function without
 * touching pixels); audio is stream-copied, so the SDR rendition carries the
 * master's exact AAC bytes rather than a generation-two re-encode.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { FFMPEG, FFPROBE } from './ffmpeg-bin.js'
import { buildColorConversionFilter, hasZscale, hasLut3d } from './encode-segment.js'
import { specFor, detectFromTransfer, isHdr } from './color-space.js'

// A full re-encode of the whole master, not a per-segment slice: the 600s
// budget the segment encoder and compose use is too tight for a long 4K master
// on a slow host. One hour is "something is wrong" territory, not "this is a
// big project" territory.
const DERIVE_TIMEOUT_MS = 3_600_000

const TTY = process.stderr.isTTY
const C = { magenta: TTY ? '\x1b[95m' : '', reset: TTY ? '\x1b[0m' : '' }
function dlog(msg) { process.stderr.write(`${C.magenta}[montaj derive-sdr]${C.reset} ${msg}\n`) }

/** Return the ffprobe color_transfer string (e.g. 'bt709', 'arib-std-b67',
 *  'smpte2084') for the first video stream, or null on error / missing tag.
 *
 *  Note: `-of csv=p=0` emits a trailing comma even on single-field stream
 *  queries (e.g. `arib-std-b67,\n`). Strip both whitespace and trailing
 *  commas before returning, otherwise downstream string equality against
 *  COLOR_SPACE_SPECS.transferValues silently misses every HDR clip and the
 *  whole project gets mis-classified as SDR.
 *
 *  Lives here rather than in render.js so the derive pass and render.js's
 *  per-item pre-probe share one implementation (render.js imports it from
 *  here); a second copy would be a second chance to forget the comma strip. */
export function probeColorTransfer(filePath) {
  const result = spawnSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer',
    '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) return null
  const value = (result.stdout || '').trim().replace(/,+$/, '')
  return value || null
}

/**
 * The color-space key a file's own tags say it is ('hdr_hlg', 'hdr_pq', or
 * 'sdr_bt709' for anything else, including untagged).
 */
export function probeColorSpace(filePath) {
  return detectFromTransfer(probeColorTransfer(filePath))
}

/**
 * ffmpeg argv for the derive pass. Pure — no probes, no disk, no spawn — so
 * the golden test can assert the exact arguments (the `_dryRun` idea from
 * encode-segment.js, except here the whole builder is separable).
 *
 * The filter is `buildColorConversionFilter(src → sdr_bt709)` plus a terminal
 * `format=yuv420p`. On any build with zscale + lut3d that IS the Montaj Vivid
 * chain (`buildVividLutChain`), PQ pre-step included; going through the shared
 * builder rather than calling `buildVividLutChain` directly means a build
 * missing lut3d degrades to exactly the same Hable fallback the segment
 * encoder and the poster-frame extractor take, instead of handing ffmpeg a
 * filter it cannot run and failing a render that had already succeeded. The
 * caller warns when that happens — see deriveSdr.
 *
 * The trailing zscale inside the chain already retags to bt709 and converts
 * back to limited-range YUV, so `format=yuv420p` only pins the bit depth /
 * chroma layout libx264 wants; `-pix_fmt` from the spec pins the same thing at
 * the encoder. Both are kept, mirroring the segment encoder.
 *
 * @param {string} masterPath   HDR master to read
 * @param {string} outputPath   SDR rendition to write
 * @param {object} opts
 * @param {string} opts.srcColorSpace       'hdr_hlg' or 'hdr_pq'
 * @param {string|null} [opts.sdrCurve]     look curve id; null → master look
 * @param {boolean} [opts.zscaleAvailable]  defaults to the real probe
 * @param {boolean} [opts.lut3dAvailable]   defaults to the real probe
 * @returns {string[]}
 */
export function buildDeriveSdrArgs(masterPath, outputPath, opts = {}) {
  const {
    srcColorSpace,
    sdrCurve = null,
    zscaleAvailable = hasZscale(),
    lut3dAvailable = hasLut3d(),
  } = opts
  const spec = specFor('sdr_bt709')
  const chain = buildColorConversionFilter(srcColorSpace, 'sdr_bt709', zscaleAvailable, {
    sdrCurve, hasLut3d: lut3dAvailable,
  })
  return [
    '-y', '-v', 'error',
    '-i', masterPath,
    // Explicit maps, not ffmpeg's default stream selection: the master carries
    // an attached_pic poster (compose.js embeds one), and default selection can
    // pick that JPEG up as a second video stream. v:0 is the real picture; the
    // `?` on the audio map keeps a silent master (no audio stream at all) from
    // failing the whole derive.
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', `${chain},format=yuv420p`,
    '-c:v', spec.encoder, ...spec.encoderArgs, '-pix_fmt', spec.outputPixFmt,
    ...spec.outputColorArgs,
    // Audio is copied, never re-encoded — the master's AAC came out of the
    // single end-of-pipeline encode in compose.js, and a second pass through
    // the encoder would cost quality for nothing.
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ]
}

/**
 * Run the derive pass. Resolves with `outputPath`; throws on ffmpeg failure.
 *
 * @param {string} masterPath
 * @param {string} outputPath
 * @param {object} [opts]
 * @param {string} [opts.srcColorSpace] skip the probe and treat the master as
 *   this color space. Omitted (the render.js path) → probe the file itself.
 * @param {string|null} [opts.sdrCurve] look curve id; null → master look.
 */
export async function deriveSdr(masterPath, outputPath, opts = {}) {
  // Checked before the probe: ffprobe on a missing file returns no transfer,
  // which detects as SDR, which would report "this master isn't HDR" for a
  // file that simply is not there.
  if (!existsSync(masterPath)) {
    throw new Error(`derive-sdr: no master to derive from at ${masterPath}`)
  }

  const srcColorSpace = opts.srcColorSpace ?? probeColorSpace(masterPath)
  if (!isHdr(srcColorSpace)) {
    throw new Error(
      `derive-sdr: ${masterPath} is not an HDR master (color space ${srcColorSpace}) — `
      + `nothing to derive. An SDR project's render is already the SDR rendition.`
    )
  }

  const zscaleAvailable = hasZscale()
  const lut3dAvailable = hasLut3d()
  if (!zscaleAvailable || !lut3dAvailable) {
    // Loud, once, on the same terms as lib/normalize.py's intake warning: the
    // user asked for an SDR export and is getting a visibly different grade
    // from the one the editor previewed.
    dlog(`WARNING: this ffmpeg build is missing ${!zscaleAvailable ? 'zscale' : 'lut3d'} — `
       + `the SDR rendition falls back to a generic tonemap and will NOT match the `
       + `Montaj Vivid grade you previewed. Run \`montaj doctor\` for the fix.`)
  }

  const args = buildDeriveSdrArgs(masterPath, outputPath, {
    srcColorSpace, sdrCurve: opts.sdrCurve ?? null, zscaleAvailable, lut3dAvailable,
  })

  const result = await new Promise((resolve) => {
    const proc = spawn(FFMPEG, args)
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, DERIVE_TIMEOUT_MS)
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('error', (err) => { clearTimeout(timer); resolve({ status: null, stderr, error: err }) })
    proc.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr, timedOut }) })
  })

  if (result.status !== 0) {
    const detail = result.error ? result.error.message
                 : result.timedOut ? `timed out after ${DERIVE_TIMEOUT_MS / 1000}s`
                 : (result.stderr || '').trim().slice(-500)
    throw new Error(`ffmpeg SDR derive failed (${masterPath} → ${outputPath}):\n${detail}`)
  }

  return outputPath
}
