// render/test/hdr-overlay-color.integration.test.mjs
//
// Pixel proof that graphics in an HLG or PQ segment land where the graphics
// mapping (hdr-graphics.js) puts them: an overlay capture, a caption capture
// and a timeline image item, each showing the same swatches, over a clip or
// over nothing. ffmpeg only, no Chromium: each case runs the REAL encodeSegment
// over a small segment and reads the encoded output's own 10-bit code values
// back, with no conversion on the read. The expected values come from
// graphicsToHdr, whose numbers hdr-graphics.test.mjs pins against reference
// values; this file pins the ffmpeg side: the LUT, the matrices and ranges
// either side of it, the alpha, and the composite.
//
// The swatches (white, #00b4d8, #d1f2f8, grey, red, black) fill the top and
// bottom thirds of the frame; the middle third is transparent, so one frame
// shows the graphic twice and the layer beneath once:
//
//   1. The mapping. Before it, captures and image items went into the HDR
//      canvas unconverted: white at Y10 940 (the HLG peak) and sRGB colours
//      read as BT.2020 primaries. Now white is at GRAPHICS_WHITE_NITS over a
//      clip (800 nits: HLG Y10 910, PQ 701) and at
//      GRAPHICS_WHITE_NITS_NO_FOOTAGE with no clip under it (203 nits, BT.2408:
//      HLG Y10 721, PQ 573), decided per segment (POSTLAUNCH §47).
//   2. Alpha. The bottom third catches a conversion that drops the alpha of the
//      lower rows (zscale does, writing 4:2:0 under slice threading), the
//      middle third one that makes the graphic opaque.
//   3. The composite's matrix. With an untagged HDR canvas, `overlay`
//      re-matrixed a mapped layer whenever no clip sat under it. The
//      bare-canvas cases now map at 203 nits, so each case is held to its own
//      level's prediction, swatch by swatch, which still catches a re-matrix
//      (it moved saturated swatches by more than TOL; see encode-segment.js).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { encodeSegment, hasZscale } from '../encode-segment.js'
import { graphicsToHdr, GRAPHICS_WHITE_NITS, GRAPHICS_WHITE_NITS_NO_FOOTAGE } from '../hdr-graphics.js'

const SWATCHES = [
  { name: 'white', rgb: [255, 255, 255] },
  { name: 'cyan',  rgb: [0, 180, 216] },
  { name: 'tint',  rgb: [209, 242, 248] },
  { name: 'grey',  rgb: [128, 128, 128] },
  { name: 'red',   rgb: [230, 25, 75] },
  { name: 'black', rgb: [0, 0, 0] },
]
const BAND = 64
const W = BAND * SWATCHES.length
// 480 rows: zscale's alpha loss showed from about row 270 down at this size
// (measured, default threads), so the bottom third sits inside it.
const ROW = 160
const H = ROW * 3
const DUR = 0.2
const FPS = 30
const GREY_BG = [96, 96, 96]

// Mapped graphic against graphicsToHdr's prediction, per Y/Cb/Cr, in Y10
// codes: one step of the 8-bit composite (encode-segment's
// `overlay=format=yuv420`). Measured worst 3 (the swscale/lut3d float path
// rounds about 2 codes high at white: 912 for 910 on HLG).
const TOL = 4

// Graphics white in Y10 at each level, from the independent Python derivation
// in hdr-graphics.test.mjs and hdr-graphics-no-footage.test.mjs, not from
// graphicsToHdr: round(64 + 876 * signal).
const WHITE_Y10 = {
  hdr_hlg: { [GRAPHICS_WHITE_NITS]: 910, [GRAPHICS_WHITE_NITS_NO_FOOTAGE]: 721 },
  hdr_pq: { [GRAPHICS_WHITE_NITS]: 701, [GRAPHICS_WHITE_NITS_NO_FOOTAGE]: 573 },
}

/** graphicsToHdr's R'G'B' at `whiteNits` as limited-range BT.2020 NCL Y'CbCr, 10-bit. */
function predicted(rgb, colorSpace, whiteNits) {
  const [r, g, b] = graphicsToHdr(rgb.map(v => v / 255), colorSpace, whiteNits)
  const y = 0.2627 * r + 0.6780 * g + 0.0593 * b
  return { y: 64 + 876 * y, cb: 512 + 896 * (b - y) / 1.8814, cr: 512 + 896 * (r - y) / 1.4746 }
}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Exact rgb(a) bytes, `pick(x, y)` per pixel, written as one raw frame. */
function rawFrame(file, bytesPerPixel, pick) {
  const buf = Buffer.alloc(W * H * bytesPerPixel)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) Buffer.from(pick(x, y)).copy(buf, (y * W + x) * bytesPerPixel)
  writeFileSync(file, buf)
  return file
}
const swatchAt = (x) => SWATCHES[Math.floor(x / BAND)].rgb
const inMiddle = (y) => y >= ROW && y < 2 * ROW

/** The swatches as an RGBA PNG, transparent through the middle third. */
function swatchPng(dir) {
  const raw = rawFrame(path.join(dir, 'sw.rgba'), 4, (x, y) => (inMiddle(y) ? [0, 0, 0, 0] : [...swatchAt(x), 255]))
  const png = path.join(dir, 'swatches.png')
  ff(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', raw, '-frames:v', '1', '-update', '1', png])
  return png
}

/** renderer.js's capture of that PNG: RGBA PNG frames → ffv1 yuva420p in matroska, untagged. */
function captureOf(dir, png) {
  for (const n of [1, 2, 3]) copyFileSync(png, path.join(dir, `frame-00000${n}.png`))
  const mkv = path.join(dir, 'ov.mkv')
  ff(['-framerate', String(FPS), '-i', path.join(dir, 'frame-%06d.png'),
    '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska', mkv])
  return mkv
}

/** An SDR clip, bt709 tagged: the swatches in its middle third, grey elsewhere. */
function sdrClip(dir) {
  const raw = rawFrame(path.join(dir, 'clip.rgb'), 3, (x, y) => (inMiddle(y) ? swatchAt(x) : GREY_BG))
  const out = path.join(dir, 'sdr-709.mp4')
  ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-stream_loop', '-1', '-i', raw,
    '-t', String(DUR),
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,'
      + 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv',
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', out])
  return out
}

/** A flat mid-grey HLG clip, tagged HLG / BT.2020, 10-bit. */
function hlgClip(dir) {
  const out = path.join(dir, 'bg-hlg.mp4')
  ff(['-f', 'lavfi', '-i', `color=c=gray:size=${W}x${H}:rate=${FPS}:duration=${DUR}`,
    '-vf', 'format=yuv420p10le',
    '-c:v', 'libx265', '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-pix_fmt', 'yuv420p10le', out])
  return out
}

const videoItem = (src, colorTransfer) => ({
  type: 'video', src, start: 0, end: DUR, inPoint: 0, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
  colorTransfer, probedWidth: W, probedHeight: H, probedAlpha: false,
})
const imageItem = (src) => ({ type: 'image', src, start: 0, end: DUR, trackIdx: 1, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, fit: 'fill' })
const overlayOf = (webmPath, isCaption = false) => ({ webmPath, startSeconds: 0, endSeconds: DUR, isCaption,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1 })

/**
 * Mean Y/Cb/Cr (Y10 codes) of a 16x16 block at each swatch's centre in one
 * row band, frame 0 of `file`, read as the encoder wrote it (yuv420p10le, no
 * conversion on the read).
 */
function codes(file, row) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
  const b = r.stdout
  const n = W * H
  assert.equal(b.length, n * 3)
  const cw = W / 2
  const at = (off) => b.readUInt16LE(off * 2)
  return SWATCHES.map((_, i) => {
    const cx = i * BAND + BAND / 2
    const cy = row * ROW + ROW / 2
    let y = 0, cb = 0, cr = 0
    for (let yy = cy - 8; yy < cy + 8; yy++) for (let xx = cx - 8; xx < cx + 8; xx++) y += at(yy * W + xx)
    for (let yy = cy / 2 - 4; yy < cy / 2 + 4; yy++) {
      for (let xx = cx / 2 - 4; xx < cx / 2 + 4; xx++) {
        cb += at(n + yy * cw + xx)
        cr += at(n + n / 4 + yy * cw + xx)
      }
    }
    return { y: y / 256, cb: cb / 64, cr: cr / 64 }
  })
}

const fmt = (c) => `${c.y.toFixed(1)}/${c.cb.toFixed(1)}/${c.cr.toFixed(1)}`
const off = (a, b) => Math.max(Math.abs(a.y - b.y), Math.abs(a.cb - b.cb), Math.abs(a.cr - b.cr))

async function encode(dir, colorSpace, items, overlays) {
  const out = path.join(dir, `seg-${Math.random().toString(36).slice(2)}.mp4`)
  await encodeSegment({ start: 0, end: DUR, vw: W, vh: H, fps: FPS, colorSpace, items, overlays }, out)
  assert.ok(existsSync(out), 'the segment encode produced no file')
  return out
}

/** Every swatch of `got` within TOL of `want`, reported as one table. */
function assertMatches(t, label, got, want) {
  const rows = SWATCHES.map((s, i) => `${s.name.padEnd(5)} want ${fmt(want[i])} got ${fmt(got[i])} off ${off(got[i], want[i]).toFixed(1)}`)
  for (const row of rows) t.diagnostic(`${label}: ${row}`)
  const bad = SWATCHES.filter((_, i) => off(got[i], want[i]) > TOL)
  assert.equal(bad.length, 0, `${label}: ${bad.map((s) => s.name).join(', ')} off by more than ${TOL}\n  ${rows.join('\n  ')}`)
}

for (const colorSpace of ['hdr_hlg', 'hdr_pq']) {
  test(`${colorSpace}: overlays, captions and image items land at 800 nits over a clip and 203 over nothing`,
    { timeout: 240_000 }, async (t) => {
      // zscale is the HDR encode's own requirement (an SDR clip's stretch needs it).
      assert.ok(hasZscale(), `${FFMPEG} lacks zscale: point MONTAJ_FFMPEG at the managed build`)
      const dir = mkdtempSync(path.join(tmpdir(), 'montaj-hdr-ov-'))
      try {
        const wantAt = (nits) => SWATCHES.map((s) => predicted(s.rgb, colorSpace, nits))
        t.diagnostic(`predicted white over a clip ${fmt(wantAt(GRAPHICS_WHITE_NITS)[0])}, over nothing ${fmt(wantAt(GRAPHICS_WHITE_NITS_NO_FOOTAGE)[0])}`)
        const png = swatchPng(dir)
        const capture = captureOf(dir, png)
        const sdr = sdrClip(dir)
        const hlg = hlgClip(dir)

        const OVER = GRAPHICS_WHITE_NITS, NONE = GRAPHICS_WHITE_NITS_NO_FOOTAGE
        const cases = [
          ['overlay over an SDR clip', [videoItem(sdr, 'bt709')], [overlayOf(capture)], OVER],
          ['overlay over an HLG clip', [videoItem(hlg, 'arib-std-b67')], [overlayOf(capture)], OVER],
          ['overlay on bare canvas', [], [overlayOf(capture)], NONE],
          ['caption on bare canvas', [], [overlayOf(capture, true)], NONE],
          ['image item over an HLG clip', [videoItem(hlg, 'arib-std-b67'), imageItem(png)], [], OVER],
          ['image item on bare canvas', [{ ...imageItem(png), trackIdx: 0 }], [], NONE],
        ]
        for (const [label, items, overlays, nits] of cases) {
          const want = wantAt(nits)
          const out = await encode(dir, colorSpace, items, overlays)
          const top = codes(out, 0)
          assertMatches(t, `${label}, top`, top, want)
          assertMatches(t, `${label}, bottom`, codes(out, 2), want)
          // White at this level's independently derived code, so a segment can
          // never land at the other level's white unnoticed.
          const whiteWant = WHITE_Y10[colorSpace][nits]
          assert.ok(Math.abs(top[0].y - whiteWant) <= TOL,
            `${label}: white Y10 ${top[0].y.toFixed(1)}, want ${whiteWant} (${nits} nits)`)
          // The middle third is the layer beneath, untouched by the graphic.
          const under = items.filter((it) => it.type === 'video')
          const alone = await encode(dir, colorSpace, under, [])
          assertMatches(t, `${label}, transparent middle`, codes(out, 1), codes(alone, 1))
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
}
