import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { blurFilterStep, BLUR_STEPS, VIDEO_BLUR_FORMAT, IMAGE_BLUR_FORMAT } from '../item-blur.js'
import { encodeSegment, buildVideoItemFilterParts, buildImageItemFilterParts } from '../encode-segment.js'
import { FFMPEG } from '../ffmpeg-bin.js'

// ── The step ────────────────────────────────────────────────────────────────

const O = { vw: 1080, vh: 1920, format: 'yuva444p', name: 'bl3' }
// The margin is ceil(3 sigma) + 1: 121 at sigma 40.
const core = (sigma, m) => `pad=w=iw+${2 * m}:h=ih+${2 * m}:x=${m}:y=${m}:color=black@0,gblur=sigma=${sigma}:steps=3,`
  + `unpremultiply=inplace=1,crop=w=iw-${2 * m}:h=ih-${2 * m}:x=${m}:y=${m}`

test('no blur, 0, or not a number: no step', () => {
  assert.equal(blurFilterStep({}, O), '')
  assert.equal(blurFilterStep({ blur: 0 }, O), '')
  assert.equal(blurFilterStep({ blur: '40' }, O), '')
})

test('opaque: a transparent margin, gblur on every plane, unpremultiply, cropped, alpha dropped', () => {
  assert.equal(BLUR_STEPS, 3)
  assert.equal(blurFilterStep({ blur: 40 }, O), `format=yuva444p,${core('40.0000', 121)},format=yuv444p`)
  assert.equal(blurFilterStep({ blur: 40 }, { ...O, format: 'yuva444p10le' }),
    `format=yuva444p10le,${core('40.0000', 121)},format=yuv444p10le`)
})

test('the sigma is design pixels on the 1080 short edge, scaled to the canvas, held to 200', () => {
  assert.ok(blurFilterStep({ blur: 40 }, { ...O, vw: 2160, vh: 3840 }).includes(core('80.0000', 241)))
  assert.ok(blurFilterStep({ blur: 40 }, { ...O, vw: 1920, vh: 1080 }).includes(core('40.0000', 121)))
  assert.ok(blurFilterStep({ blur: 500 }, O).includes(core('200.0000', 601)))
})

test('a per-axis unit gives sigmaV, and the margin covers the larger', () => {
  assert.ok(blurFilterStep({ blur: 40 }, { ...O, unitX: 0.25, unitY: 0.5 })
    .includes('pad=w=iw+122:h=ih+122:x=61:y=61:color=black@0,gblur=sigma=10.0000:sigmaV=20.0000:steps=3,'))
})

test('alpha: the original alpha is put back with mergeplanes, the blurred frame first', () => {
  assert.equal(blurFilterStep({ blur: 40 }, { ...O, format: 'gbrap', alpha: true }),
    `format=gbrap,split=2[bl3a][bl3b];[bl3b]${core('40.0000', 121)}[bl3c];`
    + '[bl3c][bl3a]mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=3:format=gbrap')
})

test('the formats: 16-bit 4:4:4 with alpha', () => {
  assert.equal(VIDEO_BLUR_FORMAT, 'yuva444p16le')
  assert.equal(IMAGE_BLUR_FORMAT, 'gbrap16le')
})

test('an animated box: the sigma follows peak / box per frame, through sendcmd; the margin covers the largest', () => {
  // scale 0.5 -> 1 over 1 s: the peak box is the full canvas, so at t=0 the
  // blur on it is twice the design sigma (the box is shown at half size).
  const item = { blur: 10, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] }] }
  const step = blurFilterStep(item, { ...O,
    animated: { kind: 'image', peakW: 1080, peakH: 1920, offset: 0, duration: 1, fps: 10 } })
  assert.match(step, /pad=w=iw\+122:h=ih\+122:x=61:y=61:color=black@0,sendcmd=c='0\.100000 gblur@bl3 sigma [\d.]+,gblur@bl3 sigmaV [\d.]+;/)
  assert.match(step, /,gblur@bl3=sigma=20\.0000:sigmaV=20\.0000:steps=3,unpremultiply/)
  assert.match(step, /1\.000000 gblur@bl3 sigma 10\.0000,gblur@bl3 sigmaV 10\.0000'/)
})

// ── Placement in the export graph ───────────────────────────────────────────

const video = (over = {}) => ({ type: 'video', src: '/clip.mp4', start: 0, end: 2, inPoint: 0, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, ...over })
const image = (over = {}) => ({ type: 'image', src: '/still.png', start: 0, end: 2, trackIdx: 1,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, ...over })
const vOpts = { segStart: 0, duration: 2, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true }
const graphOf = (r) => r.filterParts.join(';')
// The opaque video blur, whatever its sigma and margin.
const VIDEO_BLUR = /format=yuva444p16le,pad=w=[^;]*?unpremultiply=inplace=1,crop=[^,]*,format=yuv444p16le,/

test('video: without a blur the graph is unchanged; with one, only the blur step is added', () => {
  for (const over of [{}, { probedWidth: 960, probedHeight: 540, scale: 3.2 }, { scale: 0.5, rotation: 20 }]) {
    const plain = graphOf(buildVideoItemFilterParts(video(over), 1080, 1920, 1, '[canvas]', vOpts))
    const off = graphOf(buildVideoItemFilterParts(video({ ...over, blur: 0 }), 1080, 1920, 1, '[canvas]', vOpts))
    assert.equal(off, plain)
    const on = graphOf(buildVideoItemFilterParts(video({ ...over, blur: 40 }), 1080, 1920, 1, '[canvas]', vOpts))
    assert.equal(on.replace(VIDEO_BLUR, ''), plain, JSON.stringify(over))
  }
})

test('video: the blur runs after the scale and before the pad (unknown footage size)', () => {
  const g = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2 }), 1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(g.includes(`scale=3456:6144:force_original_aspect_ratio=decrease,format=yuva444p16le,${core('40.0000', 121)},format=yuv444p16le,pad=3456:6144:`), g)
})

test('video: an upscale of known footage blurs the footage before the scale, at the scaled-down sigma', () => {
  const g = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2, probedWidth: 960, probedHeight: 540 }),
    1080, 1920, 1, '[canvas]', vOpts))
  // 960 -> 3456: sigma 40 on the box is 40 * 960 / 3456 on the footage.
  assert.ok(g.includes(`setpts=PTS-STARTPTS,format=yuva444p16le,${core('11.1111', 35)},format=yuv444p16le,scale=3456:6144:`), g)
  assert.ok(g.includes('color=black@0.0[vid1]'), g)
})

test('video: a downscale, a tiny footage-side sigma, or a colour conversion blurs after the scale', () => {
  const down = graphOf(buildVideoItemFilterParts(video({ blur: 40, probedWidth: 3840, probedHeight: 2160 }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(down.includes(`decrease,format=yuva444p16le,${core('40.0000', 121)},`), down)
  const tiny = graphOf(buildVideoItemFilterParts(video({ blur: 4, scale: 3.2, probedWidth: 960, probedHeight: 540 }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(tiny.includes(`decrease,format=yuva444p16le,${core('4.0000', 13)},`), tiny)
  const hdr = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2, probedWidth: 960, probedHeight: 540,
    colorTransfer: 'arib-std-b67' }), 1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(/zscale[^;]*,format=yuva444p16le,pad=w=iw\+242[^;]*gblur=sigma=40\.0000:steps=3,/.test(hdr), hdr)
  assert.ok(!hdr.includes('setpts=PTS-STARTPTS,format=yuva444p16le'), hdr)
})

test('video: an HDR canvas blurs in 16 bits too; a clip with alpha gets its alpha back', () => {
  const hdr = graphOf(buildVideoItemFilterParts(video({ blur: 40 }), 1080, 1920, 1, '[canvas]',
    { ...vOpts, projectColorSpace: 'hdr_hlg' }))
  assert.ok(hdr.includes('format=yuva444p16le,pad=w='), hdr)
  assert.ok(hdr.includes(',format=yuv444p16le,pad=1080:1920:'), hdr)
  const alpha = graphOf(buildVideoItemFilterParts(video({ blur: 40, src: '/cut.mov', probedAlpha: true }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(alpha.includes('format=yuva444p16le,split=2[bl1a][bl1b];[bl1b]pad=w='), alpha)
  assert.ok(alpha.includes('[bl1c][bl1a]mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=3:format=yuva444p16le,'), alpha)
})

test('video: a mask comes after the blur', () => {
  const r = buildVideoItemFilterParts(video({ blur: 40, scale: 0.5, mask: { shape: 'ellipse' } }), 1080, 1920, 1, '[canvas]',
    { ...vOpts, maskBase: '/tmp/x/m' })
  const g = graphOf(r)
  assert.ok(g.indexOf('gblur=') < g.indexOf('alphaextract'), g)
})

// The image blur: planar RGB with the image's alpha put back, then RGBA again.
const IMAGE_BLUR = /,format=gbrap16le,split=2\[bl1a\]\[bl1b\];\[bl1b\]pad=w=[^;]*\[bl1c\];\[bl1c\]\[bl1a\]mergeplanes=[^,]*:format=gbrap16le,format=rgba/

test('image: without a blur unchanged; cover and fill blur the fitted box, contain blurs before its pad', () => {
  for (const fit of ['cover', 'contain', 'fill']) {
    const plain = graphOf(buildImageItemFilterParts(image({ fit }), 1080, 1920, 1, '[canvas]', 2, 0))
    assert.equal(graphOf(buildImageItemFilterParts(image({ fit, blur: 0 }), 1080, 1920, 1, '[canvas]', 2, 0)), plain)
    const on = graphOf(buildImageItemFilterParts(image({ fit, blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
    assert.ok(IMAGE_BLUR.test(on), on)
    assert.equal(on.replace(IMAGE_BLUR, (m) => (fit === 'contain' ? ',' : '')).replace('format=rgba,,pad', 'format=rgba,pad'), plain, fit)
  }
  const contain = graphOf(buildImageItemFilterParts(image({ fit: 'contain', blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
  assert.ok(/decrease,format=rgba,format=gbrap16le,split=2[^;]*;[^;]*;[^;]*format=gbrap16le,format=rgba,pad=1080:1920:/.test(contain), contain)
  const cover = graphOf(buildImageItemFilterParts(image({ blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
  assert.ok(cover.includes('crop=1080:1920,format=rgba,format=gbrap16le,split=2[bl1a][bl1b];'), cover)
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

test('real ffmpeg: an image keeps its own transparency; the blur never fills a hole or softens its edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    // A red image whose right half is transparent, over the black canvas.
    const still = join(dir, 'hole.png')
    const g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xc04020:s=${W}x${H}`,
      '-vf', `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gte(X,${W / 2}),0,255)'`, '-frames:v', '1', still])
    assert.equal(g.status, 0, String(g.stderr))
    const f = await render(dir, [{ type: 'image', src: still, start: 0, end: 0.4, trackIdx: 1,
      scale: 1, offsetX: 0, offsetY: 0, opacity: 1, blur: 120 }], 'hole')
    assert.ok(near(px(f, W / 2 - 2, H / 2), RED, 8), `left of the hole's edge stays red: ${px(f, W / 2 - 2, H / 2)}`)
    assert.ok(near(px(f, 0, 0), RED, 8), `corner: ${px(f, 0, 0)}`)
    assert.ok(near(px(f, W / 2 + 2, H / 2), [0, 0, 0], 6), `the hole stays clear: ${px(f, W / 2 + 2, H / 2)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
