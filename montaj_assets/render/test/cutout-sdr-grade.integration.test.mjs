// render/test/cutout-sdr-grade.integration.test.mjs
//
// PV42 T8: a remove_bg cutout of HDR footage gets the Montaj Vivid grade in the
// SDR export, on its colour only, with its matte intact.
//
// remove_bg.py decodes the HDR source to rgb24 through PyAV (BT.2020 matrix,
// limited to full range: PyAV 17 follows the frame's own tag), and writes the
// model's RGB + alpha as ProRes 4444 through PyAV's default RGB to YUV
// conversion, which is BT.601 limited, with no colour tags. So the _nobg.mov
// holds HLG (or PQ) signal in BT.601 YUV. Composited ungraded, an iPhone cutout
// came out flat and grey in the SDR export.
//
// This test builds that file from a synthetic HDR frame exactly that way, with a
// matte covering the left half, over a solid SDR layer, and runs the REAL
// encodeSegment on an SDR segment. Inside the matte the output must be the
// source frame through the Vivid grade (the grade itself, no compositor in the
// way); outside it, the layer underneath must show through.
//
// GATING: skipped without zscale + lut3d + prores_ks + ffv1 (MONTAJ_FFMPEG
// picks the binary).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { encodeSegment, buildVividLutChain } from '../encode-segment.js'

const W = 512
const H = 256
const FPS = 30
const DUR = 0.5
const N = 7  // the frame compared

// The matte's edge is excluded: 4:2:0 chroma and the output's own x264 pass
// blend a few pixels either side of it.
const MARGIN = 16

const DECODE_709 = 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24'

function capabilitySkip() {
  const reason = capabilityReason()
  // Opt-in loud mode: a skipped PV42 proof must fail, not pass by omission.
  if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}. Point MONTAJ_FFMPEG/MONTAJ_FFPROBE at the managed build (~/.local/share/montaj/models/ffmpeg is a directory; the binaries are inside), or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
  return reason
}
function capabilityReason() {
  const filters = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/^[A-Z. ]+ zscale\b/m.test(filters) || !/^[A-Z. ]+ lut3d\b/m.test(filters)
      || !/\bprores_ks\b/.test(encoders) || !/\bffv1\b/.test(encoders)) {
    return `${FFMPEG} lacks zscale + lut3d + prores_ks + ffv1 (set MONTAJ_FFMPEG)`
  }
  return false
}
const SKIP = capabilitySkip()

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

function probe(file, entries) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', `stream=${entries}`, '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' })
  return r.stdout.trim()
}

/** Frame N of `file` through `chain`, as W x H rgb24. */
function frame(file, chain) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file,
    '-vf', `select=eq(n\\,${N}),${chain}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read of ${file} failed: ${r.stderr}`)
  assert.equal(r.stdout.length, W * H * 3, `${file}: expected one ${W}x${H} frame`)
  return r.stdout
}

/** Mean abs difference and per-channel means over columns [x0, x1). */
function region(a, b, x0, x1) {
  let sum = 0
  let n = 0
  const ma = [0, 0, 0]
  const mb = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    for (let x = x0; x < x1; x++) {
      for (let c = 0; c < 3; c++) {
        const o = (y * W + x) * 3 + c
        sum += Math.abs(a[o] - b[o]); ma[c] += a[o]; mb[c] += b[o]
      }
      n++
    }
  }
  const round = (m) => m.map((v) => (v / n).toFixed(1)).join('/')
  return { meanAbs: sum / (n * 3), got: round(ma), want: round(mb) }
}

let dir = null
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

// Eight saturated swatches (a skin tone among them) as horizontal bands, so the
// matte's half holds every one, blurred so no edge is hard.
const SWATCHES = ['e6194b', '3cb44b', '4363d8', 'f58231', '00b4d8', 'e0ac69', 'ffe119', 'f0f0f0']
const BANDS = SWATCHES.map((hex, i) => `color=c=0x${hex}:size=${W}x${H / SWATCHES.length}:rate=${FPS}:duration=${DUR}[s${i}]`).join(';')
  + `;${SWATCHES.map((_, i) => `[s${i}]`).join('')}vstack=inputs=${SWATCHES.length},format=rgb24,gblur=sigma=6`

/**
 * The HDR source (the swatches as BT.709, stretched into `key` at 203 nits the
 * way an SDR clip enters an HDR master, lossless) and its cutout, made the way
 * remove_bg makes one: decoded to rgb24 with the BT.2020 matrix, alpha 255 on
 * the left half and 0 on the right, then RGB to 10-bit YUV with BT.601
 * limited, ProRes 4444, colour tags left unknown.
 *
 * Soft edges on purpose. On testsrc2's hard saturated edges swscale (the
 * fixture's RGB step) and zscale (the ideal's) clip differently, which measured
 * 1.1 mean abs against the ideal before any encode, with the grade right.
 */
function fixture(key) {
  dir ??= mkdtempSync(path.join(tmpdir(), 'montaj-cutout-'))
  const trc = key === 'hdr_pq' ? 'smpte2084' : 'arib-std-b67'
  const src = path.join(dir, `${key}.mkv`)
  ff(['-filter_complex', `${BANDS},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,`
      + 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv,'
      + `zscale=t=${trc}:p=bt2020:m=bt2020nc:npl=203,format=yuv420p10le`,
    '-c:v', 'ffv1', '-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc',
    '-color_range', 'tv', src])
  assert.equal(probe(src, 'color_transfer'), trc, 'the HDR source carries the wrong transfer tag')

  const nobg = path.join(dir, `${key}_nobg.mov`)
  ff(['-i', src,
    '-f', 'lavfi', '-i', `color=c=black:size=${W}x${H}:rate=${FPS}:duration=${DUR}`,
    '-filter_complex',
    '[0:v]scale=in_color_matrix=bt2020:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,'
      + 'format=rgb24,format=rgba[c];'
      + `[1:v]format=gray,geq=lum='if(lt(X\\,${W / 2})\\,255\\,0)'[m];`
      + '[c][m]alphamerge,'
      + 'scale=out_color_matrix=bt601:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuva444p10le,'
      + 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=tv[out]',
    '-map', '[out]', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', nobg])
  assert.match(probe(nobg, 'pix_fmt'), /^yuva444p1[02]le$/, 'the cutout must carry alpha')
  assert.equal(probe(nobg, 'color_transfer'), 'unknown', 'the cutout must be untagged, as remove_bg writes it')

  // The fixture is what it claims: its YUV, read as BT.601, is the source's RGB.
  const readBack = region(frame(nobg, 'scale=in_color_matrix=bt601:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24'),
    frame(src, 'scale=in_color_matrix=bt2020:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24'), 0, W)
  assert.ok(readBack.meanAbs <= 0.6, `the cutout is not the BT.601 YUV of the source's RGB: mean abs ${readBack.meanAbs.toFixed(3)}`)

  // The layer underneath: one solid colour, tagged BT.709.
  const bg = path.join(dir, 'bg.mp4')
  if (!existsSync(bg)) {
    ff(['-f', 'lavfi', '-i', `color=c=0x3366cc:size=${W}x${H}:rate=${FPS}:duration=${DUR}`,
      '-vf', 'format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,'
        + 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv',
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', bg])
  }
  return { src, nobg, bg }
}

const layer = (src, extra) => ({
  type: 'video', src, start: 0, end: DUR, inPoint: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
  probedWidth: W, probedHeight: H, ...extra,
})

for (const key of ['hdr_hlg', 'hdr_pq']) {
  test(`remove_bg cutout of ${key} footage in an SDR segment: graded inside the matte, the layer beneath outside it`,
    { skip: SKIP, timeout: 180_000 }, async (t) => {
      const { src, nobg, bg } = fixture(key)
      const out = path.join(dir, `seg-${key}.mp4`)
      await encodeSegment({
        start: 0, end: DUR, vw: W, vh: H, fps: FPS, colorSpace: 'sdr_bt709', overlays: [],
        items: [
          layer(bg, { trackIdx: 0, colorTransfer: 'bt709', probedAlpha: false }),
          // What render.js's SDR pass stamps on a cutout of HDR footage.
          layer(nobg, { trackIdx: 1, remove_bg: true, nobg_src: nobg, colorTransfer: 'unknown',
            probedAlpha: true, gradeFrom: key, alphaGrade: true }),
        ],
      }, out)
      assert.ok(existsSync(out), 'the segment encode produced no file')
      assert.equal(probe(out, 'color_space'), 'bt709')

      const got = frame(out, DECODE_709)
      const ideal = frame(src, `${buildVividLutChain(key)},format=yuv420p,${DECODE_709}`)
      const inside = region(got, ideal, MARGIN, W / 2 - MARGIN)
      const outside = region(got, frame(bg, DECODE_709), W / 2 + MARGIN, W - MARGIN)
      // The same cutout graded as if its YUV were BT.2020 NCL (the Vivid chain
      // as is), with no encode at all: the fixture must fail it.
      const trc = key === 'hdr_pq' ? 'smpte2084' : 'arib-std-b67'
      const asBt2020 = region(frame(nobg, 'format=yuv444p12le,'
        + `setparams=colorspace=bt2020nc:color_trc=${trc}:color_primaries=bt2020:range=tv,`
        + `${buildVividLutChain(key)},format=yuv420p,${DECODE_709}`), ideal, MARGIN, W / 2 - MARGIN)
      t.diagnostic(`${key} inside the matte vs the ideal Vivid: mean abs ${inside.meanAbs.toFixed(3)}, RGB means ${inside.got} (ideal ${inside.want})`)
      t.diagnostic(`${key} outside the matte vs the layer beneath: mean abs ${outside.meanAbs.toFixed(3)}, RGB means ${outside.got} (layer ${outside.want})`)
      t.diagnostic(`${key} declared BT.2020 NCL instead, no encode: mean abs ${asBt2020.meanAbs.toFixed(3)}, RGB means ${asBt2020.got}`)
      assert.ok(inside.meanAbs <= 1.5,
        `inside the matte the cutout must be its source through the Vivid grade: mean abs ${inside.meanAbs.toFixed(3)} > 1.5 (RGB ${inside.got}, ideal ${inside.want})`)
      assert.ok(outside.meanAbs <= 1.5,
        `outside the matte the layer beneath must show through: mean abs ${outside.meanAbs.toFixed(3)} > 1.5 (RGB ${outside.got}, layer ${outside.want})`)
      assert.ok(asBt2020.meanAbs > 3,
        `a BT.2020 NCL declaration comes as close (${asBt2020.meanAbs.toFixed(3)}): this fixture cannot tell the matrices apart`)
    })
}
