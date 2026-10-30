// render/test/item-blur-radial.test.mjs
//
// Spin and zoom blurs: the export's graph (item-blur.js, run through real
// ffmpeg) against the CPU reference both renderers meet (timeline-core
// radialBlurReference), pixel for pixel, on small test pictures.
//
// The reference works in floats; the export moves each copy with ffmpeg's
// `perspective`, which takes 8-bit formats only (bilinear, positions on a
// 1/256 px grid), and mixes them in 16 bits. So a few codes apart is the
// expected distance. Where little of the average falls on the picture (the
// reference's `coverage` under 1/16: the far corners of a wide spin, a centre
// outside the picture) the 8-bit sums are mostly rounding, and the export
// fades to the source pixel instead (item-blur.js); those pixels are counted
// apart and must sit near the source or the reference.
//
// Measured (ffmpeg 8.1.2), over the pixels covered at least 1/16: the RGB
// graph (images) worst 5 codes, mean under 0.4, in every case below; the
// letterboxed builder worst 5, mean under 0.4; the YUV graph a video takes
// worst 8, mean under 1.2 (its own 8-bit YUV rounding in perspective).

// Cases:
//   - the image format (gbrap16le, alpha put back), the picture's size known;
//   - a contain-fitted picture in a taller box through the real image builder
//     (letterboxed: the size is not known to the graph, so it is planned on
//     the box and placed by perspective's W and H);
//   - the video format (yuva444p16le, opaque);
//   - holes in the alpha (transparent white under them, which must not leak).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { radialBlurPlan, radialBlurReference, radialCenterInPicture, pictureRectInBox } from '@bycrux/timeline-core'
import { blurFilterStep, VIDEO_BLUR_FORMAT, IMAGE_BLUR_FORMAT } from '../item-blur.js'
import { buildImageItemFilterParts } from '../encode-segment.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const PW = 96
const PH = 64

/** testsrc2 as straight RGBA bytes; with `holes`, a transparent disc (white under it) and a half-transparent ring. */
function picture(w, h, holes = false) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=1`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, String(r.stderr))
  const px = Buffer.from(r.stdout)
  if (holes) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const d = Math.hypot(i + 0.5 - w * 0.3, j + 0.5 - h * 0.6)
      const o = (j * w + i) * 4
      if (d < h * 0.2) { px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = 0 } else if (d < h * 0.3) px[o + 3] = 128
    }
  }
  return px
}

/** Runs `chain` (from [0:v] to [o]) over raw RGBA bytes; returns the output's RGBA bytes. */
function run(rgba, w, h, chain) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-',
    '-filter_complex', chain, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { input: rgba, maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, String(r.stderr).slice(-2000))
  return r.stdout
}

/** Below this summed alpha (the reference's `coverage`) the export shows the source instead (item-blur.js). */
const THIN = 1 / 16

/**
 * Worst and mean colour difference (codes) between `out` (bytes; its picture
 * at `oy` rows down, `ow` wide) and the reference (floats, the picture only),
 * over the picture's pixels with any alpha whose coverage is at least THIN;
 * the worst alpha difference against `alphaOf` (the source through the same
 * format round trip: rgba to gbrap16le and back turns 128 into 129, blur or
 * not); and the thinly covered pixels, which must sit near the source or the
 * reference (the export ramps from one to the other there), never black.
 */
function compare(out, ow, oy, ref, src, alphaOf = src) {
  let worst = 0
  let sum = 0
  let n = 0
  let alpha = 0
  let thin = 0
  let thinWorst = 0
  for (let j = 0; j < ref.height; j++) for (let i = 0; i < ref.width; i++) {
    const p = (j * ref.width + i) * 4
    const o = ((j + oy) * ow + i) * 4
    alpha = Math.max(alpha, Math.abs(out[o + 3] - alphaOf[p + 3]))
    if (src[p + 3] === 0) continue
    if (ref.coverage[p >> 2] < THIN) {
      thin++
      for (let c = 0; c < 3; c++) {
        const d = Math.min(Math.abs(out[o + c] - src[p + c]), Math.abs(out[o + c] - Math.round(ref.data[p + c] * 255)))
        thinWorst = Math.max(thinWorst, d)
      }
      continue
    }
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(out[o + c] - Math.round(ref.data[p + c] * 255))
      worst = Math.max(worst, d)
      sum += d
      n++
    }
  }
  return { worst, mean: sum / n, alpha, thin, thinWorst }
}

const CASES = [
  ['spin', 8, 0.5, 0.5],
  ['spin', 30, 0.5, 0.4],
  ['spin', 90, 0, 0],
  ['spin', 45, 0.95, 0.5],
  ['spin', 30, 1.4, -0.3],
  ['zoom', 10, 0.5, 0.5],
  ['zoom', 40, 0.5, 0.4],
  ['zoom', 150, 0.9, 0.1],
  ['zoom', 40, -0.5, 1.5],
]

test('spin and zoom: the export graph meets radialBlurReference (picture size known; RGB, alpha put back)', (t) => {
  for (const holes of [false, true]) {
    const src = picture(PW, PH, holes)
    const alphaOf = run(src, PW, PH, `[0:v]format=${IMAGE_BLUR_FORMAT},format=rgba[o]`)
    for (const [type, amount, x, y] of CASES) {
      const item = { blur: amount, blurType: type, blurX: x, blurY: y }
      const step = blurFilterStep(item, { vw: PW, vh: PH, format: IMAGE_BLUR_FORMAT, alpha: true, name: 'q',
        picture: { w: PW, h: PH, exact: true }, box: { w: PW, h: PH } })
      const out = run(src, PW, PH, `[0:v]${step},format=rgba[o]`)
      const center = [x * PW, y * PH]
      const plan = radialBlurPlan({ type, amount, center, rect: { w: PW, h: PH } })
      const ref = radialBlurReference({ data: src, width: PW, height: PH }, { type, plan, center })
      const r = compare(out, PW, 0, ref, src, alphaOf)
      const label = `${type} ${amount} at (${x}, ${y})${holes ? ', holes' : ''}: ${plan.passes.map((p) => p.taps.length).join('x')} taps`
      t.diagnostic(`${label}: worst ${r.worst}, mean ${r.mean.toFixed(2)}; ${r.thin} thin px within ${r.thinWorst}`)
      assert.equal(r.alpha, 0, `${label}: the alpha is the clip's own`)
      assert.ok(r.worst <= 6, `${label}: worst ${r.worst} codes`)
      assert.ok(r.mean < 1, `${label}: mean ${r.mean.toFixed(2)} codes`)
      assert.ok(r.thinWorst <= 40, `${label}: thinly covered pixels ${r.thinWorst} codes from both the source and the reference`)
    }
  }
})

test('spin and zoom: a letterboxed contain picture through the image builder meets the reference planned on its box', (t) => {
  // A 96x64 picture contain-fitted into a 96x160 box at scale 1: no
  // resampling, 48 transparent rows above and below. The graph does not know
  // the picture's size, so it plans on the box (the reference takes that plan)
  // and places the centre from perspective's own W and H.
  const BW = 96
  const BH = 160
  const dir = mkdtempSync(join(tmpdir(), 'radial-'))
  try {
    for (const holes of [false, true]) {
      const src = picture(PW, PH, holes)
      const png = join(dir, `pic-${holes}.png`)
      const w = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${PW}x${PH}`, '-i', '-',
        '-frames:v', '1', png], { input: src })
      assert.equal(w.status, 0, String(w.stderr))
      const rect = pictureRectInBox(BW, BH, PW, PH)
      const top = Math.round(rect.y * BH)
      assert.equal(top, 48)
      const alphaOf = run(src, PW, PH, `[0:v]format=${IMAGE_BLUR_FORMAT},format=rgba[o]`)
      for (const [type, amount, x, y] of [['spin', 30, 0.5, 0.5], ['spin', 60, 0.2, 0.25], ['zoom', 40, 0.5, 0.4], ['zoom', 100, 0.9, 0.1]]) {
        const item = { type: 'image', src: png, start: 0, end: 1, fit: 'contain', scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
          blur: amount, blurType: type, blurX: x, blurY: y }
        const chain = buildImageItemFilterParts(item, BW, BH, 0, '[canvas]', 1, 0).filterParts[0]
        assert.ok(chain.startsWith('[0:v]') && chain.endsWith('[img0]'), chain.slice(0, 80))
        assert.match(chain, /perspective=x0=[^:]*W/)
        const out = run(src, PW, PH, `${chain.slice(0, -'[img0]'.length)},format=rgba[o]`)
        assert.equal(out.length, BW * BH * 4)
        const plan = radialBlurPlan({ type, amount, center: [x * BW, y * BH], rect: { w: BW, h: BH } })
        const center = radialCenterInPicture({ x, y }, rect, PW, PH)
        const ref = radialBlurReference({ data: src, width: PW, height: PH }, { type, plan, center })
        const r = compare(out, BW, top, ref, src, alphaOf)
        const label = `letterbox, ${type} ${amount} at (${x}, ${y})${holes ? ', holes' : ''}`
        t.diagnostic(`${label}: worst ${r.worst}, mean ${r.mean.toFixed(2)}; ${r.thin} thin px within ${r.thinWorst}`)
        assert.ok(r.thinWorst <= 40, `${label}: thinly covered pixels ${r.thinWorst} codes off`)
        assert.equal(r.alpha, 0, `${label}: the alpha is the clip's own`)
        assert.ok(r.worst <= 6, `${label}: worst ${r.worst} codes`)
        assert.ok(r.mean < 1, `${label}: mean ${r.mean.toFixed(2)} codes`)
        // The letterbox stays transparent.
        for (const row of [0, top - 1, top + PH, BH - 1]) {
          for (let i = 0; i < BW; i++) assert.equal(out[(row * BW + i) * 4 + 3], 0, `${label}: row ${row} is transparent`)
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('spin and zoom: the video format (yuva444p16le, opaque) meets the reference within its YUV rounding', (t) => {
  const src = picture(PW, PH)
  // The same picture through the same YUV round trip with no blur: the floor
  // the blurred comparison cannot go under.
  const floor = compare(run(src, PW, PH, `[0:v]format=${VIDEO_BLUR_FORMAT},format=yuv444p16le,format=rgba[o]`), PW, 0,
    { data: Float32Array.from(src, (v) => v / 255), width: PW, height: PH, coverage: new Float32Array(PW * PH).fill(1) }, src)
  t.diagnostic(`YUV round trip alone: worst ${floor.worst}, mean ${floor.mean.toFixed(2)}`)
  for (const [type, amount, x, y] of CASES) {
    const item = { blur: amount, blurType: type, blurX: x, blurY: y }
    const step = blurFilterStep(item, { vw: PW, vh: PH, format: VIDEO_BLUR_FORMAT, name: 'q',
      picture: { w: PW, h: PH, exact: true }, box: { w: PW, h: PH } })
    assert.ok(step.endsWith('format=yuv444p16le'))
    const out = run(src, PW, PH, `[0:v]${step},format=rgba[o]`)
    const center = [x * PW, y * PH]
    const plan = radialBlurPlan({ type, amount, center, rect: { w: PW, h: PH } })
    const ref = radialBlurReference({ data: src, width: PW, height: PH }, { type, plan, center })
    const r = compare(out, PW, 0, ref, src)
    t.diagnostic(`video, ${type} ${amount} at (${x}, ${y}): worst ${r.worst}, mean ${r.mean.toFixed(2)}; ${r.thin} thin px within ${r.thinWorst}`)
    assert.equal(r.alpha, 0)
    assert.ok(r.thinWorst <= 40, `${type} ${amount} at (${x}, ${y}): thinly covered pixels ${r.thinWorst} codes off`)
    assert.ok(r.worst <= 10, `${type} ${amount} at (${x}, ${y}): worst ${r.worst} codes`)
    assert.ok(r.mean < 1.5, `${type} ${amount} at (${x}, ${y}): mean ${r.mean.toFixed(2)} codes`)
  }
})

test('spin and zoom: where little of the average falls on the picture the source shows, never black or noise', () => {
  // A 90 degree spin about the top-left corner sweeps the bottom-right corner
  // off the picture both ways: there the summed alpha is a few 8-bit codes,
  // and colour divided by it is mostly rounding.
  const S = 48
  const src = Buffer.alloc(S * S * 4)
  for (let o = 0; o < src.length; o += 4) { src[o] = 40; src[o + 1] = 200; src[o + 2] = 120; src[o + 3] = 255 }
  const step = blurFilterStep({ blur: 90, blurType: 'spin', blurX: 0, blurY: 0 }, { vw: S, vh: S, format: IMAGE_BLUR_FORMAT,
    alpha: true, name: 'q', picture: { w: S, h: S, exact: true }, box: { w: S, h: S } })
  const out = run(src, S, S, `[0:v]${step},format=rgba[o]`)
  for (let o = 0; o < out.length; o += 4) {
    const d = Math.max(Math.abs(out[o] - 40), Math.abs(out[o + 1] - 200), Math.abs(out[o + 2] - 120))
    assert.ok(d <= 4 && out[o + 3] === 255, `pixel ${(o / 4) % S},${Math.floor(o / 4 / S)}: ${[...out.slice(o, o + 4)]}`)
  }
  // The control: the graph cut at unpremultiply (no fallback). Its far corner
  // has a thin summed alpha, and its colour is off the flat source.
  const cut = step.slice(0, step.indexOf('[qu];')).replace('format=gbrap16le,split=2[qs][qw];[qw]', 'format=gbrap16le,')
  const bare = run(src, S, S, `[0:v]${cut},format=rgba[o]`)
  const corner = ((S - 1) * S + (S - 1)) * 4
  assert.ok(bare[corner + 3] < 255 / 16, `the bare graph's far corner: ${[...bare.slice(corner, corner + 4)]}`)
  assert.ok(Math.abs(bare[corner + 1] - 200) > 3, `the bare graph's far corner: ${[...bare.slice(corner, corner + 4)]}`)
})
