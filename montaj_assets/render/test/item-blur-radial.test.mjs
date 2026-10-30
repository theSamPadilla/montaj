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
// outside the picture) both fade to the source pixel (the reference's step 3,
// item-blur.js), so every pixel is compared, thin ones included.
//
// Measured (ffmpeg 8.1.2), over every pixel with any alpha: the RGB graph
// (images) worst 5 codes, mean under 0.4, in every case below; the
// letterboxed builder the same; the YUV graph a video takes worst 12 (in a
// thinly covered pixel; 8 elsewhere),
// mean under 1.2 (its own 8-bit YUV rounding in perspective).

// Cases:
//   - the image format (gbrap16le, alpha put back), the picture's size known;
//   - a contain-fitted picture in a taller box (letterboxed) through the real
//     image builder, which probes the image's size; and through the step with
//     the size unknown (planned on the box, placed by perspective's W and H);
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

/**
 * Worst and mean colour difference (codes) between `out` (bytes; its picture
 * at `oy` rows down, `ow` wide) and the reference (floats, the picture only),
 * over the picture's pixels with any alpha, thinly covered ones included (both
 * fade to the source there); the worst alpha difference against `alphaOf` (the
 * source through the same format round trip: rgba to gbrap16le and back turns
 * 128 into 129, blur or not); `thin` counts the pixels covered under 1/16 and
 * `thinWorst` is the worst among them.
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
    const isThin = ref.coverage[p >> 2] < 1 / 16
    if (isThin) thin++
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(out[o + c] - Math.round(ref.data[p + c] * 255))
      worst = Math.max(worst, d)
      if (isThin) thinWorst = Math.max(thinWorst, d)
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
    }
  }
})

test('spin and zoom: a letterboxed contain picture meets the reference, its size probed by the builder or unknown', (t) => {
  // A 96x64 picture contain-fitted into a 96x160 box at scale 1: no
  // resampling, 48 transparent rows above and below. Through the real image
  // builder, which probes the image's size, so the plan is the picture's own.
  // And through the step with the size unknown: planned on the box (the
  // reference takes that plan) and placed by perspective's W and H.
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
        const center = radialCenterInPicture({ x, y }, rect, PW, PH)
        for (const known of [true, false]) {
          let out
          let plan
          let oy
          if (known) {
            const item = { type: 'image', src: png, start: 0, end: 1, fit: 'contain', scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
              blur: amount, blurType: type, blurX: x, blurY: y }
            const chain = buildImageItemFilterParts(item, BW, BH, 0, '[canvas]', 1, 0).filterParts[0]
            assert.ok(chain.startsWith('[0:v]') && chain.endsWith('[img0]'), chain.slice(0, 80))
            assert.doesNotMatch(chain, /perspective=x0=[^:]*W/, 'the probed size: numbers, not W and H')
            out = run(src, PW, PH, `${chain.slice(0, -'[img0]'.length)},format=rgba[o]`)
            assert.equal(out.length, BW * BH * 4)
            plan = radialBlurPlan({ type, amount, center, rect: { w: PW, h: PH } })
            oy = top
          } else {
            const step = blurFilterStep({ blur: amount, blurType: type, blurX: x, blurY: y }, { vw: BW, vh: BH,
              format: IMAGE_BLUR_FORMAT, alpha: true, name: 'q', picture: { w: BW, h: BH }, box: { w: BW, h: BH } })
            assert.match(step, /perspective=x0=[^:]*W/)
            out = run(src, PW, PH, `[0:v]${step},format=rgba[o]`)
            plan = radialBlurPlan({ type, amount, center: [x * BW, y * BH], rect: { w: BW, h: BH } })
            oy = 0
          }
          const ref = radialBlurReference({ data: src, width: PW, height: PH }, { type, plan, center })
          const r = compare(out, BW === PW ? PW : BW, oy, ref, src, alphaOf)
          const label = `letterbox (${known ? 'size probed' : 'size unknown'}), ${type} ${amount} at (${x}, ${y})${holes ? ', holes' : ''}`
          t.diagnostic(`${label}: worst ${r.worst}, mean ${r.mean.toFixed(2)}; ${r.thin} thin px within ${r.thinWorst}`)
          assert.equal(r.alpha, 0, `${label}: the alpha is the clip's own`)
          assert.ok(r.worst <= 6, `${label}: worst ${r.worst} codes`)
          assert.ok(r.mean < 1, `${label}: mean ${r.mean.toFixed(2)} codes`)
          if (known) {
            // The letterbox stays transparent.
            for (const row of [0, top - 1, top + PH, BH - 1]) {
              for (let i = 0; i < BW; i++) assert.equal(out[(row * BW + i) * 4 + 3], 0, `${label}: row ${row} is transparent`)
            }
          }
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
    // Thinly covered pixels included: the copies' 8-bit YUV rounding over a
    // summed alpha just above 1/16 reaches 12 there (spin 30 at (0.5, 0.4)).
    assert.ok(r.worst <= 12, `${type} ${amount} at (${x}, ${y}): worst ${r.worst} codes`)
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

// ── The precise path (a 10-bit, HDR canvas) ─────────────────────────────────
//
// perspective rounds each copy to 8 bits, which bands a 10-bit picture (a
// 10-bit ramp came out in plateaus of 4 codes). On a 10-bit canvas each
// pass's input is split into its high and low bytes, both moved, and summed
// back in the mix (perspective is linear), so each copy keeps about 16 bits.

/** A 16-bit ramp in every colour plane (10-bit code 200 + x/2, a code every 2 px), opaque, as raw `fmt` planes. */
function ramp16(w, h) {
  const b = Buffer.alloc(w * h * 8)
  for (let p = 0; p < 4; p++) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    b.writeUInt16LE(p === 3 ? 65535 : Math.round((200 + i / 2) * 64), ((p * h + j) * w + i) * 2)
  }
  return b
}

function run16(planes, w, h, fmt, chain) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', fmt, '-s', `${w}x${h}`, '-i', '-',
    '-filter_complex', `[0:v]${chain},format=${fmt}[o]`, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', fmt, '-'],
  { input: planes, maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, String(r.stderr).slice(-2000))
  return r.stdout
}

/** The longest run of pixels on one 10-bit code. */
function longestPlateau(row) {
  let best = 1
  let len = 1
  for (let i = 1; i < row.length; i++) {
    len = Math.round(row[i] / 64) === Math.round(row[i - 1] / 64) ? len + 1 : 1
    best = Math.max(best, len)
  }
  return best
}

test('spin and zoom, precise (a 10-bit canvas): no banding on a 10-bit ramp, within about a 10-bit code of the reference', (t) => {
  const W = 512
  const H = 48
  const src = ramp16(W, H)
  // The reference on plane 0 as grey (0..255 floats).
  const data = new Float32Array(W * H * 4)
  for (let k = 0; k < W * H; k++) { data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = src.readUInt16LE(k * 2) / 257; data[k * 4 + 3] = 255 }
  for (const fmt of [IMAGE_BLUR_FORMAT, VIDEO_BLUR_FORMAT]) {
    for (const [type, amount, x, y] of [['zoom', 40, 0.5, 0.5], ['spin', 30, 0.5, 0.3]]) {
      const item = { blur: amount, blurType: type, blurX: x, blurY: y }
      const o = { vw: W, vh: H, format: fmt, alpha: fmt === IMAGE_BLUR_FORMAT, name: 'q', picture: { w: W, h: H, exact: true }, box: { w: W, h: H } }
      const center = [x * W, y * H]
      const plan = radialBlurPlan({ type, amount, center, rect: { w: W, h: H } })
      const ref = radialBlurReference({ data, width: W, height: H }, { type, plan, center })
      const measure = (out) => {
        let plateau = 0
        let refPlateau = 0
        let worst = 0
        let sum = 0
        let n = 0
        for (let j = 6; j < H - 6; j++) {
          const row = []
          const rr = []
          for (let i = 16; i < W - 16; i++) {
            row.push(out.readUInt16LE((j * W + i) * 2))
            rr.push(ref.data[(j * W + i) * 4] * 65535)
          }
          plateau = Math.max(plateau, longestPlateau(row))
          refPlateau = Math.max(refPlateau, longestPlateau(rr))
          for (let i = 0; i < row.length; i++) { const d = Math.abs(row[i] - rr[i]) / 64; worst = Math.max(worst, d); sum += d; n++ }
        }
        return { plateau, refPlateau, worst, mean: sum / n }
      }
      const fast = measure(run16(src, W, H, fmt, blurFilterStep(item, o)))
      const precise = measure(run16(src, W, H, fmt, blurFilterStep(item, { ...o, precise: true })))
      const label = `${fmt}, ${type} ${amount}`
      t.diagnostic(`${label}: longest plateau precise ${precise.plateau} px, 8-bit ${fast.plateau}, reference ${precise.refPlateau} `
        + `(the ramp: 2); 10-bit codes from the reference: precise worst ${precise.worst.toFixed(2)}, mean ${precise.mean.toFixed(2)}; `
        + `8-bit worst ${fast.worst.toFixed(2)}, mean ${fast.mean.toFixed(2)}`)
      // The reference's own plateaus are the ramp's step stretched by the blur; precise adds at most 2 px.
      assert.ok(precise.plateau <= precise.refPlateau + 2, `${label}: plateau ${precise.plateau} px against the reference's ${precise.refPlateau}`)
      assert.ok(precise.worst <= 2 && precise.mean < 0.3, `${label}: worst ${precise.worst.toFixed(2)}, mean ${precise.mean.toFixed(2)} codes`)
      // The control: the 8-bit path bands.
      assert.ok(fast.plateau >= precise.refPlateau + 4, `${label}: the 8-bit path's plateau ${fast.plateau} px`)
    }
  }
})

test('spin and zoom, precise: the graph meets the reference on the detailed picture (alpha, holes, centres outside)', (t) => {
  for (const holes of [false, true]) {
    const src = picture(PW, PH, holes)
    const alphaOf = run(src, PW, PH, `[0:v]format=${IMAGE_BLUR_FORMAT},format=rgba[o]`)
    for (const [type, amount, x, y] of CASES) {
      const item = { blur: amount, blurType: type, blurX: x, blurY: y }
      for (const format of [IMAGE_BLUR_FORMAT, VIDEO_BLUR_FORMAT]) {
        const alpha = format === IMAGE_BLUR_FORMAT
        if (!alpha && holes) continue
        const step = blurFilterStep(item, { vw: PW, vh: PH, format, alpha, name: 'q', precise: true,
          picture: { w: PW, h: PH, exact: true }, box: { w: PW, h: PH } })
        assert.ok(step.includes(`lut=c0='bitand(val,65280)'`), 'the precise graph')
        const out = run(src, PW, PH, `[0:v]${step},format=rgba[o]`)
        const center = [x * PW, y * PH]
        const plan = radialBlurPlan({ type, amount, center, rect: { w: PW, h: PH } })
        const ref = radialBlurReference({ data: src, width: PW, height: PH }, { type, plan, center })
        const r = compare(out, PW, 0, ref, src, alpha ? alphaOf : src)
        const label = `precise ${alpha ? 'RGB' : 'YUV'}, ${type} ${amount} at (${x}, ${y})${holes ? ', holes' : ''}`
        t.diagnostic(`${label}: worst ${r.worst}, mean ${r.mean.toFixed(2)}; ${r.thin} thin px within ${r.thinWorst}`)
        assert.equal(r.alpha, 0, `${label}: the alpha is the clip's own`)
        assert.ok(r.worst <= (alpha ? 3 : 8), `${label}: worst ${r.worst} codes`)
        assert.ok(r.mean < (alpha ? 0.6 : 1.2), `${label}: mean ${r.mean.toFixed(2)} codes`)
      }
    }
  }
})
