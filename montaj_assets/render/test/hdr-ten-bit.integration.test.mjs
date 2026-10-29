// render/test/hdr-ten-bit.integration.test.mjs
//
// §619: on an HDR segment (yuv420p10le canvas) every layer composites at 10
// bits. `overlay=format=yuv420` used to narrow the canvas and everything on it
// to 8 bits (a 10-bit ramp kept 206 of 256 codes). Real ffmpeg, tiny frames,
// the REAL encodeSegment; the output is read back as 10-bit planes.
//
//   a. a full-frame HLG ramp clip alone
//   b. the same clip with an overlay capture over one corner
//   c. the same clip at rotation 90
//   d. a remove_bg-style untagged cutout, declared BT.601 on the HDR canvas

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { encodeSegment, hasZscale } from '../encode-segment.js'

const FPS = 30
const DUR = 0.1 // 3 frames
const MIN_CODES = 250

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Frame 0 of `file` as raw planar `pixFmt`, no other conversion. */
function rawFrame0(file, pixFmt) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', pixFmt, 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
  return r.stdout
}

/** The Y plane of frame 0 as a Uint16 view-free array, `w`x`h`. */
function yPlane(file, w, h, pixFmt = 'yuv420p10le') {
  const b = rawFrame0(file, pixFmt)
  const y = new Array(w * h)
  for (let i = 0; i < w * h; i++) y[i] = b.readUInt16LE(i * 2)
  return y
}

/** Y, Cb, Cr (10-bit) at one pixel, read from yuv444p10le. */
function yuvAt(file, w, h, x, yy) {
  const b = rawFrame0(file, 'yuv444p10le')
  const n = w * h
  const at = (plane) => b.readUInt16LE((plane * n + yy * w + x) * 2)
  return [at(0), at(1), at(2)]
}

const distinct = (vals) => new Set(vals).size

/** A full-frame 10-bit HLG luma ramp 64..940 across the width, ffv1 yuv420p10le, tagged. */
function rampClip(dir, w, h, name = 'ramp.mkv') {
  const out = path.join(dir, name)
  ff(['-f', 'lavfi', '-i', `color=c=gray:size=${w}x${h}:rate=${FPS}:duration=${DUR},format=yuv444p10le,`
      + `geq=lum='64+X*876/(W-1)':cb=512:cr=512`,
  '-vf', 'format=yuv420p10le',
  '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le',
  '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', out])
  return out
}

const videoItem = (src, w, h, extra = {}) => ({
  type: 'video', src, start: 0, end: DUR, inPoint: 0, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
  colorTransfer: 'arib-std-b67', probedWidth: w, probedHeight: h, probedAlpha: false, ...extra,
})

/**
 * encodeSegment's own graph and args, with only the video encoder swapped for
 * lossless ffv1: libx265 at the segment's crf adds noise that fills in the
 * codes an 8-bit composite dropped (measured: 206 codes in the graph, 256 once
 * x265 had coded them), so a count of distinct codes would pass either way.
 */
async function encode(dir, vw, vh, items, overlays = []) {
  const { args } = await encodeSegment({ start: 0, end: DUR, vw, vh, fps: FPS, colorSpace: 'hdr_hlg', items, overlays },
    path.join(dir, 'unused.mp4'), { _dryRun: true })
  const from = args.indexOf('-c:v')
  const to = args.indexOf('-pix_fmt', from) + 2
  const out = path.join(dir, `seg-${Math.random().toString(36).slice(2)}.mkv`)
  const tail = args.slice(to, -1)
  for (const flag of ['-tag:v', '-bsf:v', '-movflags']) {
    const i = tail.indexOf(flag)
    if (i >= 0) tail.splice(i, 2)
  }
  ff([...args.slice(0, from), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', ...tail, out])
  assert.ok(existsSync(out), 'the segment encode produced no file')
  return out
}

function withDir(prefix, fn) {
  return async (t) => {
    assert.ok(hasZscale(), `${FFMPEG} lacks zscale: point MONTAJ_FFMPEG at the managed build`)
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    try { await fn(dir, t) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

const W = 256
const H = 64

test('hdr_hlg: a 10-bit ramp clip keeps its codes through the composite (a)', { timeout: 240_000 },
  withDir('montaj-ten-a-', async (dir, t) => {
    const clip = rampClip(dir, W, H)
    const out = await encode(dir, W, H, [videoItem(clip, W, H)])
    const row = yPlane(out, W, H).slice(32 * W, 33 * W)
    t.diagnostic(`(a) distinct Y codes on a middle row: ${distinct(row)} (source ${distinct(yPlane(clip, W, H).slice(32 * W, 33 * W))})`)
    assert.ok(distinct(row) >= MIN_CODES, `only ${distinct(row)} distinct Y codes, want >= ${MIN_CODES}`)
  }))

test('hdr_hlg: an overlay over one corner does not narrow the clip elsewhere (b)', { timeout: 240_000 },
  withDir('montaj-ten-b-', async (dir, t) => {
    const clip = rampClip(dir, W, H)
    // renderer.js's capture: RGBA frames -> ffv1 yuva420p in matroska. Opaque
    // 64x32 patch in the bottom-right corner, transparent elsewhere.
    const raw = Buffer.alloc(W * H * 4)
    for (let y = 32; y < H; y++) for (let x = W - 64; x < W; x++) Buffer.from([230, 25, 75, 255]).copy(raw, (y * W + x) * 4)
    writeFileSync(path.join(dir, 'ov.rgba'), raw)
    ff(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', path.join(dir, 'ov.rgba'), '-frames:v', '1', '-update', '1', path.join(dir, 'ov.png')])
    for (const n of [1, 2, 3]) copyFileSync(path.join(dir, 'ov.png'), path.join(dir, `frame-00000${n}.png`))
    const mkv = path.join(dir, 'ov.mkv')
    ff(['-framerate', String(FPS), '-i', path.join(dir, 'frame-%06d.png'),
      '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska', mkv])
    const overlay = { webmPath: mkv, startSeconds: 0, endSeconds: DUR, isCaption: false, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }
    const out = await encode(dir, W, H, [videoItem(clip, W, H)], [overlay])
    const row = yPlane(out, W, H).slice(8 * W, 9 * W) // above the patch
    t.diagnostic(`(b) distinct Y codes on a row away from the corner: ${distinct(row)}`)
    assert.ok(distinct(row) >= MIN_CODES, `only ${distinct(row)} distinct Y codes, want >= ${MIN_CODES}`)
    // and the overlay did land in the corner
    const patch = yPlane(out, W, H)[48 * W + W - 32]
    assert.notEqual(patch, 64 + Math.round(876 * (W - 32) / (W - 1)), 'the overlay patch is missing from the corner')
  }))

test('hdr_hlg: a clip at rotation 90 keeps its codes along the rotated ramp (c)', { timeout: 240_000 },
  withDir('montaj-ten-c-', async (dir, t) => {
    // A 256x16 ramp turned to a 16x256 strip on a 256x256 canvas.
    const clip = rampClip(dir, 256, 16, 'ramp-wide.mkv')
    const src = yPlane(clip, 256, 16).slice(8 * 256, 9 * 256)
    const CW = 256
    const out = await encode(dir, CW, CW, [videoItem(clip, 256, 16, { rotation: 90 })])
    const y = yPlane(out, CW, CW)
    const col = Array.from({ length: CW }, (_, r) => y[r * CW + CW / 2])
    // Only the strip's own run: the rows where the column is not the black canvas.
    t.diagnostic(`(c) distinct Y codes along the rotated ramp: ${distinct(col)} (source run ${distinct(src)})`)
    assert.ok(distinct(src) >= MIN_CODES, `the source has ${distinct(src)} codes`)
    assert.ok(distinct(col) >= MIN_CODES, `only ${distinct(col)} distinct Y codes along the rotated ramp, want >= ${MIN_CODES}`)
  }))

test('hdr_hlg: a remove_bg cutout is declared BT.601, not BT.2020 (d)', { timeout: 240_000 },
  withDir('montaj-ten-d-', async (dir, t) => {
    const S = 64
    const hlg = path.join(dir, 'hlg.mp4')
    ff(['-f', 'lavfi', '-i', `color=c=0xe0ac69:size=${S}x${S}:rate=${FPS}:duration=${DUR}`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', hlg])
    // The cutout the way steps/transform/remove_bg.py makes one: decoded to RGB
    // with the source's BT.2020 matrix, written as BT.601 limited YUV, ProRes
    // 4444, tags unknown. Alpha opaque everywhere.
    const cut = path.join(dir, 'cutout.mov')
    ff(['-i', hlg,
      '-vf', 'scale=in_color_matrix=bt2020:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24,format=rgba,'
        + 'scale=out_color_matrix=bt601:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuva444p10le,'
        + 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=tv',
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', cut])
    const item = videoItem(cut, S, S, { remove_bg: true, nobg_src: cut, colorTransfer: 'unknown', probedAlpha: true })
    const out = await encode(dir, S, S, [item])
    const want = yuvAt(hlg, S, S, 32, 32)
    const got = yuvAt(out, S, S, 32, 32)
    t.diagnostic(`(d) HLG clip YUV ${want.join('/')}, cutout over the canvas ${got.join('/')}`)
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - want[i]) <= 2, `plane ${i}: ${got[i]} vs ${want[i]} (YUV ${got} vs ${want})`)
  }))
