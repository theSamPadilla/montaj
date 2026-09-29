// render/test/composite-matrix.integration.test.mjs
//
// Pixel proof that the SDR segment encoder puts every layer on the canvas in
// the colours it came in with. ffmpeg only, no Chromium, no Python: each case
// runs the REAL encodeSegment over a tiny segment whose only layer is a strip
// of solid swatches (five saturated colours and a neutral grey), then decodes
// the output the way its bt709 tag tells a player to and compares every
// swatch with what went in.
//
// What it pins, all one family (ffmpeg 8 negotiates colour space across the
// graph, and a neutral cannot show any of it, which is how it all hid):
//
//   1. The canvas. The black canvas every layer composites onto carried no
//      colour-space tag, so `overlay` converted each layer to "unknown", i.e.
//      the BT.601 matrix, while the final setparams labelled the file BT.709.
//      A bt709 video layer was re-matrixed, and an untagged overlay capture or
//      image, which is 601-encoded, was written through as-is under a 709
//      label. Saturated colours moved, red and green hardest.
//   2. Untagged video. With the canvas tagged, a video with no colour tags
//      (most web downloads, BT.709 underneath) would be read as BT.601 and
//      converted the other way; it is tagged bt709 at its input instead.
//   3. The overlay's own conversion. BT.601 → bt709 left to ffmpeg's inserted
//      scaler squeezes the levels on a 1080-wide canvas (white 255 → 253), so
//      the overlay chain converts the capture itself, exactly.
//   4. The pin after the Montaj Vivid chain, so its own zscale does the
//      RGB→YUV step, as derive-sdr.js and lib/normalize.py do. With the canvas
//      tagged it no longer changes a swatch centre; it keeps a letterboxed
//      grade's colour edges on the same path as those two.
//
// The comparisons are on decoded pixels, never on the filter string: a graph
// can read right and still produce the wrong pixels, which is the whole story
// of every one of these.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { encodeSegment, buildVividLutChain, hasZscale, hasLut3d } from '../encode-segment.js'

// Five saturated swatches and a neutral, 64 px wide each.
const SWATCHES = [
  { name: 'red',    hex: 'e6194b' },
  { name: 'green',  hex: '3cb44b' },
  { name: 'blue',   hex: '4363d8' },
  { name: 'orange', hex: 'f58231' },
  { name: 'cyan',   hex: '00b4d8' },
  { name: 'grey',   hex: '808080' },
]
const BAND = 64
const W = BAND * SWATCHES.length
const H = 64
const DUR = 0.2
const FPS = 30

// A 709 layer through a correct composite comes back within x264 rounding; the
// bugs moved saturated swatches by 5-25 levels.
const TOL = 3

// accurate_rnd+full_chroma_int: ffmpeg's default YUV→RGB path squeezes the
// levels on a width that is not a multiple of 16 (1080: white reads 253), which
// would make the reading, not the file, the thing under test.
const DECODE_709 = 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24'

const rgbOf = (hex) => ({
  r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16),
})
const fmt = (p) => `rgb(${p.r}, ${p.g}, ${p.b})`
const delta = (a, b) => `${a.r - b.r >= 0 ? '+' : ''}${a.r - b.r}/${a.g - b.g >= 0 ? '+' : ''}${a.g - b.g}/${a.b - b.b >= 0 ? '+' : ''}${a.b - b.b}`
const near = (a, b, tol = TOL) =>
  Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** An `hstack` of the swatches as one lavfi graph, `size` per band. */
function swatchGraph(extra = '') {
  const inputs = SWATCHES.map((s, i) =>
    `color=c=0x${s.hex}:size=${BAND}x${H}:rate=${FPS}:duration=${DUR}${extra}[s${i}]`).join(';')
  return `${inputs};${SWATCHES.map((_, i) => `[s${i}]`).join('')}hstack=inputs=${SWATCHES.length}`
}

/**
 * Frame 0 decoded as BT.709 limited range, the way the file's own tag tells a
 * player to, as packed rgb24. The matrix is spelled out rather than left to
 * the decoder's default so the reading does not depend on how a given ffmpeg
 * build treats an untagged or mistagged stream.
 */
function decode709(file) {
  const r = spawnSync(FFMPEG, [
    '-v', 'error', '-i', file, '-frames:v', '1',
    '-vf', DECODE_709,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
  assert.equal(r.stdout.length, W * H * 3)
  return r.stdout
}

/** The mean of a 16x16 block at each swatch's centre, clear of the 4:2:0 chroma at the band edges. */
function swatchMeans(file) {
  const px = decode709(file)
  return SWATCHES.map((_, i) => {
    const sum = [0, 0, 0]
    let n = 0
    for (let y = H / 2 - 8; y < H / 2 + 8; y++) {
      for (let x = i * BAND + BAND / 2 - 8; x < i * BAND + BAND / 2 + 8; x++) {
        const o = (y * W + x) * 3
        sum[0] += px[o]; sum[1] += px[o + 1]; sum[2] += px[o + 2]; n++
      }
    }
    return { r: Math.round(sum[0] / n), g: Math.round(sum[1] / n), b: Math.round(sum[2] / n) }
  })
}

/** Whole-picture difference, every pixel including the swatch edges. */
function pictureDiff(a, b) {
  const pa = decode709(a)
  const pb = decode709(b)
  let max = 0
  let sum = 0
  for (let i = 0; i < pa.length; i++) {
    const d = Math.abs(pa[i] - pb[i])
    if (d > max) max = d
    sum += d
  }
  return { max, meanAbs: sum / pa.length }
}

function colorSpaceTag(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_space', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  return r.stdout.trim()
}

async function encode(dir, { items = [], overlays = [] }) {
  const out = path.join(dir, `seg-${Math.random().toString(36).slice(2)}.mp4`)
  await encodeSegment({
    start: 0, end: DUR, vw: W, vh: H, fps: FPS, colorSpace: 'sdr_bt709', items, overlays,
  }, out)
  assert.ok(existsSync(out), 'the segment encode produced no file')
  assert.equal(colorSpaceTag(out), 'bt709', 'the segment must be tagged bt709, or decoding it as 709 is wrong')
  return out
}

/**
 * Compare every swatch in `got` with `want`. All mismatches are reported
 * together, each with its per-channel shift, so a failure reads as a table of
 * what moved rather than the first swatch that happened to.
 */
function assertSwatches(t, label, got, want) {
  const rows = SWATCHES.map((s, i) => `${s.name.padEnd(6)} want ${fmt(want[i])} got ${fmt(got[i])} shift ${delta(got[i], want[i])}`)
  for (const row of rows) t.diagnostic(`${label}: ${row}`)
  const bad = SWATCHES.filter((_, i) => !near(got[i], want[i]))
  assert.equal(bad.length, 0,
    `${label}: ${bad.map((s) => s.name).join(', ')} moved by more than ${TOL}\n  ${rows.join('\n  ')}`)
}

/**
 * The swatches as a 709-encoded H.264 file: RGB → YUV with the BT.709 matrix
 * explicitly, limited range. `tagged` writes the bt709 tags; untagged leaves
 * every colour field unknown, the shape of most web downloads (an X/Twitter
 * export, say), which are 709 underneath with nothing saying so.
 * `format=rgb24` first, or lavfi's `color` hands out YUV of its own and the
 * matrix step converts from that (measured: grey came back 125/127/127).
 */
function swatches709(dir, { tagged }) {
  const src = path.join(dir, `swatches-709-${tagged ? 'tagged' : 'untagged'}.mp4`)
  const tags = tagged
    ? 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv'
    : 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=unknown'
  ff(['-filter_complex',
    `${swatchGraph()},format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,${tags}`,
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
    ...(tagged ? ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'] : []),
    src])
  assert.equal(colorSpaceTag(src), tagged ? 'bt709' : 'unknown', 'the fixture carries the wrong colour tag')
  return src
}

const videoItem = (src, colorTransfer) => ({
  type: 'video', src, start: 0, end: DUR, inPoint: 0, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
  colorTransfer, probedWidth: W, probedHeight: H, probedAlpha: false,
})

for (const tagged of [true, false]) {
  const kind = tagged ? 'bt709-tagged' : 'untagged (709 underneath)'
  test(`${kind} video layer: every swatch composites unchanged`, { timeout: 120_000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'montaj-matrix-'))
    try {
      const src = swatches709(dir, { tagged })
      const layer = swatchMeans(src)
      // The fixture is what it claims: decoded as 709 it gives back the authored colours.
      assertSwatches(t, 'fixture', layer, SWATCHES.map((s) => rgbOf(s.hex)))
      // render.js stamps a failed or empty transfer probe as 'unknown'.
      const out = await encode(dir, { items: [videoItem(src, tagged ? 'bt709' : 'unknown')] })
      assertSwatches(t, 'composite', swatchMeans(out), layer)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('overlay capture (untagged ffv1, as renderer.js writes it): every swatch lands as authored', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-matrix-'))
  try {
    // renderer.js's own capture encode: RGBA PNG frames → ffv1 yuva420p in
    // matroska, with no colour tags.
    ff(['-filter_complex', `${swatchGraph()},format=rgba`, '-frames:v', '3',
      path.join(dir, 'frame-%06d.png')])
    const mkv = path.join(dir, 'ov.mkv')
    ff(['-framerate', String(FPS), '-i', path.join(dir, 'frame-%06d.png'),
      '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska', mkv])

    const out = await encode(dir, {
      overlays: [{ webmPath: mkv, startSeconds: 0, endSeconds: DUR, isCaption: false,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }],
    })
    assertSwatches(t, 'overlay', swatchMeans(out), SWATCHES.map((s) => rgbOf(s.hex)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overlay capture on a 1080-wide canvas: white, grey and red land at their authored levels', { timeout: 120_000 }, async (t) => {
  // 1080 is the usual vertical canvas, and not a multiple of 16. There, the
  // BT.601→bt709 conversion ffmpeg inserts before `overlay` gets the colour
  // right but squeezes the levels (white Y 235 → 233, grey 126 → 124), so the
  // overlay chain does the conversion itself (captureToBt709). The swatch
  // tests above run at 384 wide, where the inserted conversion is exact.
  const WW = 1080
  const HH = 64
  const bands = [['white', 'ffffff'], ['grey', '808080'], ['red', 'e6194b']]
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-matrix-'))
  try {
    const graph = bands.map(([, hex], i) => `color=c=0x${hex}:size=360x${HH}:rate=${FPS}:duration=${DUR}[b${i}]`).join(';')
      + `;${bands.map((_, i) => `[b${i}]`).join('')}hstack=inputs=${bands.length},format=rgba`
    ff(['-filter_complex', graph, '-frames:v', '3', path.join(dir, 'frame-%06d.png')])
    const mkv = path.join(dir, 'ov.mkv')
    ff(['-framerate', String(FPS), '-i', path.join(dir, 'frame-%06d.png'),
      '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska', mkv])
    const out = path.join(dir, 'seg.mp4')
    await encodeSegment({ start: 0, end: DUR, vw: WW, vh: HH, fps: FPS, colorSpace: 'sdr_bt709', items: [],
      overlays: [{ webmPath: mkv, startSeconds: 0, endSeconds: DUR, isCaption: false, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }] }, out)
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', out, '-frames:v', '1',
      '-vf', DECODE_709,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
    assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
    const at = (x) => { const o = ((HH / 2) * WW + x) * 3; return { r: r.stdout[o], g: r.stdout[o + 1], b: r.stdout[o + 2] } }
    const rows = bands.map(([name, hex], i) => ({ name, want: rgbOf(hex), got: at(i * 360 + 180) }))
    for (const { name, want, got } of rows) t.diagnostic(`${name}: want ${fmt(want)} got ${fmt(got)}`)
    const bad = rows.filter(({ want, got }) => !near(got, want, 1))
    assert.equal(bad.length, 0, rows.map(({ name, want, got }) => `${name} want ${fmt(want)} got ${fmt(got)}`).join('; '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('image item (PNG): every swatch lands as authored', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-matrix-'))
  try {
    const png = path.join(dir, 'swatches.png')
    ff(['-filter_complex', `${swatchGraph()},format=rgb24`, '-frames:v', '1', png])
    const out = await encode(dir, {
      items: [{ type: 'image', src: png, start: 0, end: DUR, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }],
    })
    assertSwatches(t, 'image', swatchMeans(out), SWATCHES.map((s) => rgbOf(s.hex)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HLG clip in an SDR project: the Vivid grade reaches the output unchanged (matrix after the LUT)', { timeout: 180_000 }, async (t) => {
  if (!hasZscale() || !hasLut3d()) {
    t.skip('ffmpeg lacks zscale and/or lut3d — run with MONTAJ_FFMPEG pointing at the managed build')
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-matrix-'))
  try {
    // Saturated swatches in an HLG-tagged file. The values are whatever the
    // lavfi conversion writes; what matters is that the grade is fixed and
    // both sides below grade the same file.
    const src = path.join(dir, 'swatches-hlg.mp4')
    ff(['-filter_complex', `${swatchGraph()},format=yuv420p`,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', src])

    // The reference: the Vivid chain with its output pinned to YUV right
    // after it, which is what lib/normalize.py and derive-sdr.js do. This is
    // the grade itself, with no compositor in the way.
    const graded = path.join(dir, 'graded-ref.mp4')
    ff(['-i', src, '-vf', `${buildVividLutChain('hdr_hlg')},format=yuv420p`,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', graded])
    const want = swatchMeans(graded)

    const out = await encode(dir, {
      items: [{ type: 'video', src, start: 0, end: DUR, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
        colorTransfer: 'arib-std-b67', probedWidth: W, probedHeight: H, probedAlpha: false }],
    })
    assertSwatches(t, 'vivid', swatchMeans(out), want)
    const whole = pictureDiff(out, graded)
    t.diagnostic(`vivid whole picture vs reference: max ${whole.max}, mean abs ${whole.meanAbs.toFixed(3)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HLG clip letterboxed in its box: the graded picture matches the Vivid grade pinned to YUV', { timeout: 180_000 }, async (t) => {
  // The case the pin after the Vivid chain changes. Here the decrease-fit
  // leaves bars, so the pad is transparent (`format=yuva444p10le,pad=...`), and
  // without the pin the grade reaches the canvas in 4:4:4 and is subsampled by
  // the compositor's scaler instead of by the chain's own zscale, as
  // lib/normalize.py and derive-sdr.js subsample it. The swatch centres agree
  // either way; the colour edges do not.
  if (!hasZscale() || !hasLut3d()) {
    t.skip('ffmpeg lacks zscale and/or lut3d — run with MONTAJ_FFMPEG pointing at the managed build')
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-matrix-'))
  try {
    const src = path.join(dir, 'swatches-hlg-short.mp4')
    ff(['-filter_complex', `${swatchGraph()},scale=${W}:${H / 2},format=yuv420p`,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', src])
    // The pinned grade, letterboxed onto black the way the canvas shows it.
    const graded = path.join(dir, 'graded-ref.mp4')
    ff(['-i', src, '-vf', `${buildVividLutChain('hdr_hlg')},format=yuv420p,pad=${W}:${H}:0:${H / 4}:black`,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', graded])
    const out = await encode(dir, {
      items: [{ type: 'video', src, start: 0, end: DUR, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
        colorTransfer: 'arib-std-b67', probedWidth: W, probedHeight: H / 2, probedAlpha: false }],
    })
    const whole = pictureDiff(out, graded)
    t.diagnostic(`letterboxed vivid, whole picture vs reference: max ${whole.max}, mean abs ${whole.meanAbs.toFixed(3)}`)
    // Measured with the managed ffmpeg 8.1.2: pinned max 21 / mean abs 0.29;
    // unpinned 56 / 0.57; 5.5.4 (untagged canvas too) 82 / 3.13.
    assert.ok(whole.max <= 35 && whole.meanAbs <= 0.5,
      `the graded picture drifted from the pinned grade: max ${whole.max}, mean abs ${whole.meanAbs.toFixed(3)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
