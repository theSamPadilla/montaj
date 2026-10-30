import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { blurFilterStep, blurPixelFormat, BLUR_STEPS } from '../item-blur.js'
import { encodeSegment, buildVideoItemFilterParts, buildImageItemFilterParts } from '../encode-segment.js'
import { FFMPEG } from '../ffmpeg-bin.js'

// ── The step ────────────────────────────────────────────────────────────────

test('no blur, 0, or not a number: no step', () => {
  assert.equal(blurFilterStep({}, { vw: 1080, vh: 1920 }), '')
  assert.equal(blurFilterStep({ blur: 0 }, { vw: 1080, vh: 1920 }), '')
  assert.equal(blurFilterStep({ blur: '40' }, { vw: 1080, vh: 1920 }), '')
})

test('the sigma is design pixels on the 1080 short edge, scaled to the canvas', () => {
  assert.equal(BLUR_STEPS, 3)
  assert.equal(blurFilterStep({ blur: 40 }, { vw: 1080, vh: 1920 }), 'gblur=sigma=40.0000:steps=3')
  assert.equal(blurFilterStep({ blur: 40 }, { vw: 2160, vh: 3840 }), 'gblur=sigma=80.0000:steps=3')
  assert.equal(blurFilterStep({ blur: 40 }, { vw: 1920, vh: 1080 }), 'gblur=sigma=40.0000:steps=3')
  assert.equal(blurFilterStep({ blur: 500 }, { vw: 1080, vh: 1920 }), 'gblur=sigma=200.0000:steps=3')
})

test('a format pin goes first; a per-axis unit gives sigmaV', () => {
  assert.equal(blurFilterStep({ blur: 40 }, { vw: 1080, vh: 1920, format: 'yuv444p' }),
    'format=yuv444p,gblur=sigma=40.0000:steps=3')
  assert.equal(blurFilterStep({ blur: 40 }, { vw: 1080, vh: 1920, unitX: 0.25, unitY: 0.5 }),
    'gblur=sigma=10.0000:sigmaV=20.0000:steps=3')
})

test('blurPixelFormat: 4:4:4, 10-bit and alpha as asked', () => {
  assert.equal(blurPixelFormat({ tenBit: false, alpha: false }), 'yuv444p')
  assert.equal(blurPixelFormat({ tenBit: true, alpha: false }), 'yuv444p10le')
  assert.equal(blurPixelFormat({ tenBit: false, alpha: true }), 'yuva444p')
  assert.equal(blurPixelFormat({ tenBit: true, alpha: true }), 'yuva444p10le')
})

test('an animated box: the sigma follows peak / box per frame, through sendcmd', () => {
  // scale 0.5 -> 1 over 1 s: the peak box is the full canvas, so at t=0 the
  // blur on it is twice the design sigma (the box is shown at half size).
  const item = { blur: 10, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] }] }
  const step = blurFilterStep(item, { vw: 1080, vh: 1920,
    animated: { kind: 'image', peakW: 1080, peakH: 1920, offset: 0, duration: 1, fps: 10, name: 'bl3' } })
  assert.match(step, /^sendcmd=c='0\.100000 gblur@bl3 sigma [\d.]+,gblur@bl3 sigmaV [\d.]+;/)
  assert.match(step, /,gblur@bl3=sigma=20\.0000:sigmaV=20\.0000:steps=3$/)
  assert.match(step, /1\.000000 gblur@bl3 sigma 10\.0000,gblur@bl3 sigmaV 10\.0000'/)
})

// ── Placement in the export graph ───────────────────────────────────────────

const video = (over = {}) => ({ type: 'video', src: '/clip.mp4', start: 0, end: 2, inPoint: 0, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, ...over })
const image = (over = {}) => ({ type: 'image', src: '/still.png', start: 0, end: 2, trackIdx: 1,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, ...over })
const vOpts = { segStart: 0, duration: 2, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true }
const graphOf = (r) => r.filterParts.join(';')

test('video: without a blur the graph is unchanged; with one, only the blur step is added', () => {
  for (const over of [{}, { probedWidth: 960, probedHeight: 540, scale: 3.2 }, { scale: 0.5, rotation: 20 }]) {
    const plain = graphOf(buildVideoItemFilterParts(video(over), 1080, 1920, 1, '[canvas]', vOpts))
    const off = graphOf(buildVideoItemFilterParts(video({ ...over, blur: 0 }), 1080, 1920, 1, '[canvas]', vOpts))
    assert.equal(off, plain)
    const on = graphOf(buildVideoItemFilterParts(video({ ...over, blur: 40 }), 1080, 1920, 1, '[canvas]', vOpts))
    const stripped = on.replace(/format=yuv444p,gblur=[^,;]*,/, '')
    assert.equal(stripped, plain, JSON.stringify(over))
  }
})

test('video: the blur runs after the scale and before the pad (unknown footage size)', () => {
  const g = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2 }), 1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(g.includes('scale=3456:6144:force_original_aspect_ratio=decrease,format=yuv444p,gblur=sigma=40.0000:steps=3,pad=3456:6144:'), g)
})

test('video: an upscale of known footage blurs the footage before the scale, at the scaled-down sigma', () => {
  const g = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2, probedWidth: 960, probedHeight: 540 }),
    1080, 1920, 1, '[canvas]', vOpts))
  // 960 -> 3456: sigma 40 on the box is 40 * 960 / 3456 on the footage.
  assert.ok(g.includes('setpts=PTS-STARTPTS,format=yuv444p,gblur=sigma=11.1111:steps=3,scale=3456:6144:'), g)
  assert.ok(g.includes('color=black@0.0[vid1]'), g)
})

test('video: a downscale, a tiny footage-side sigma, or a colour conversion blurs after the scale', () => {
  const down = graphOf(buildVideoItemFilterParts(video({ blur: 40, probedWidth: 3840, probedHeight: 2160 }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(down.includes('decrease,format=yuv444p,gblur=sigma=40.0000:steps=3,'), down)
  const tiny = graphOf(buildVideoItemFilterParts(video({ blur: 4, scale: 3.2, probedWidth: 960, probedHeight: 540 }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(tiny.includes('decrease,format=yuv444p,gblur=sigma=4.0000:steps=3,'), tiny)
  const hdr = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2, probedWidth: 960, probedHeight: 540,
    colorTransfer: 'arib-std-b67' }), 1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(/zscale[^;]*,format=yuv444p10le,gblur=sigma=40\.0000:steps=3,/.test(hdr), hdr)
  assert.ok(!hdr.includes('setpts=PTS-STARTPTS,format=yuv444p'), hdr)
})

test('video: an HDR canvas pins 10-bit, an alpha clip keeps its alpha', () => {
  const hdr = graphOf(buildVideoItemFilterParts(video({ blur: 40 }), 1080, 1920, 1, '[canvas]',
    { ...vOpts, projectColorSpace: 'hdr_hlg' }))
  assert.ok(hdr.includes('format=yuv444p10le,gblur='), hdr)
  const alpha = graphOf(buildVideoItemFilterParts(video({ blur: 40, src: '/cut.mov', probedAlpha: true }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(alpha.includes('format=yuva444p,gblur='), alpha)
})

test('video: a mask comes after the blur', () => {
  const r = buildVideoItemFilterParts(video({ blur: 40, scale: 0.5, mask: { shape: 'ellipse' } }), 1080, 1920, 1, '[canvas]',
    { ...vOpts, maskBase: '/tmp/x/m' })
  const g = graphOf(r)
  assert.ok(g.indexOf('gblur=') < g.indexOf('alphaextract'), g)
})

test('image: without a blur unchanged; cover and fill blur the fitted box, contain blurs before its pad', () => {
  for (const fit of ['cover', 'contain', 'fill']) {
    const plain = graphOf(buildImageItemFilterParts(image({ fit }), 1080, 1920, 1, '[canvas]', 2, 0))
    assert.equal(graphOf(buildImageItemFilterParts(image({ fit, blur: 0 }), 1080, 1920, 1, '[canvas]', 2, 0)), plain)
    const on = graphOf(buildImageItemFilterParts(image({ fit, blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
    assert.equal(on.replace(/,gblur=sigma=20\.0000:steps=3/, ''), plain, fit)
  }
  const contain = graphOf(buildImageItemFilterParts(image({ fit: 'contain', blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
  assert.ok(contain.includes('decrease,format=rgba,gblur=sigma=20.0000:steps=3,pad=1080:1920:'), contain)
  const cover = graphOf(buildImageItemFilterParts(image({ blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
  assert.ok(cover.includes('crop=1080:1920,format=rgba,gblur=sigma=20.0000:steps=3,'), cover)
})

// ── Real ffmpeg ─────────────────────────────────────────────────────────────
// A blurred clip that fills the frame keeps opaque edges: a solid red clip,
// blurred, is the same red everywhere. Read past its edges as transparent (or
// black) and the frame's border would darken toward the black canvas. The
// 16:9 clip is scaled to overhang the 9:16 frame by a few rows: a 4:2:0 pad
// rounds its offset to even rows, so an overhang under ~2 rows leaves a black
// row with or without a blur.

const W = 108
const H = 192
const RED = [192, 64, 32]

function makeSolid(dir, name, size, ext) {
  const out = join(dir, `${name}.${ext}`)
  const c = '0x' + RED.map(v => v.toString(16).padStart(2, '0')).join('')
  const args = ext === 'png'
    ? ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=${size}`, '-frames:v', '1', out]
    : ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=${size}:r=30:d=1`, '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-crf', '0', out]
  const r = spawnSync(FFMPEG, args)
  assert.equal(r.status, 0, String(r.stderr))
  return out
}

function frameRgb(file, at = 0.1) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24', '-f', 'rawvideo', '-'])
  assert.equal(r.status, 0, String(r.stderr))
  return r.stdout
}

const px = (buf, x, y) => [buf[(y * W + x) * 3], buf[(y * W + x) * 3 + 1], buf[(y * W + x) * 3 + 2]]
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

async function render(dir, items, name) {
  const out = join(dir, `${name}.mp4`)
  await encodeSegment({ start: 0, end: 0.4, vw: W, vh: H, fps: 30, overlays: [], items }, out)
  return frameRgb(out)
}

test('real ffmpeg: a blurred full-frame clip stays opaque to every edge (pre- and post-scale, animated)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const clip = makeSolid(dir, 'red', '96x54', 'mp4')
    const base = { type: 'video', src: clip, start: 0, end: 0.4, inPoint: 0, trackIdx: 0, offsetX: 0, offsetY: 0,
      opacity: 1, muted: true, scale: 3.4, blur: 120 }
    const cases = {
      post: base,                                          // footage size unknown: blur after the scale
      pre: { ...base, probedWidth: 96, probedHeight: 54 }, // upscale of known footage: blur before it
      animated: { ...base, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 3.4 }, { t: 0.4, value: 3.8 }] }] },
    }
    for (const [name, item] of Object.entries(cases)) {
      const f = await render(dir, [item], name)
      for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, 0], [W / 2, H - 1], [0, H / 2], [W / 2, H / 2]]) {
        assert.ok(near(px(f, x, y), RED, 6), `${name} (${x},${y}): ${px(f, x, y)}`)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: a contain image keeps a hard, opaque picture edge; the pad stays transparent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const still = makeSolid(dir, 'red', '160x90', 'png')
    // 16:9 contain in the 9:16 frame: a band 108 x ~61 rows, centred (rows ~65..126).
    const f = await render(dir, [{ type: 'image', src: still, start: 0, end: 0.4, trackIdx: 1, fit: 'contain',
      scale: 1, offsetX: 0, offsetY: 0, opacity: 1, blur: 120 }], 'contain')
    assert.ok(near(px(f, W / 2, H / 2), RED, 6), `centre ${px(f, W / 2, H / 2)}`)
    assert.ok(near(px(f, 0, 68), RED, 8), `band edge ${px(f, 0, 68)}`)
    assert.ok(near(px(f, W / 2, 68), RED, 8), `band top ${px(f, W / 2, 68)}`)
    assert.ok(near(px(f, W / 2, 30), [0, 0, 0], 4), `pad ${px(f, W / 2, 30)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
