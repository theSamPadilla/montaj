// render/test/video-pad.integration.test.mjs
//
// Pixel proof for the transparent video pad (todo #6). ffmpeg only, no
// Chromium: each case runs the REAL encodeSegment over a tiny 180x320 segment
// with a solid #3366ff image on track 0 and a video item above it whose box
// is taller than its footage (scaleY 1.5, the todo's repro). The band the
// decrease-fit leaves must show the blue underneath, as the editor preview and
// sample_frame do, and never ffmpeg's opaque default black.
//
// The item's size and alpha come from the real probeVideoGeometry, as render.js
// stamps them; the unprobed case pins that an item of unknown size keeps the
// old opaque pad exactly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { encodeSegment, probeVideoGeometry, hasZscale, hasLut3d } from '../encode-segment.js'

const W = 180
const H = 320
const BLUE = { r: 0x33, g: 0x66, b: 0xff }
const ORANGE = { r: 0xff, g: 0x80, b: 0x00 }

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Frame 0 of `mp4` as packed rgb24, read whole (a 1x1 crop off h264 is unreliable). */
function firstFrame(mp4) {
  const r = spawnSync(FFMPEG, [
    '-v', 'error', '-i', mp4, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
  assert.equal(r.stdout.length, W * H * 3)
  return (x, y) => {
    const i = (y * W + x) * 3
    return { r: r.stdout[i], g: r.stdout[i + 1], b: r.stdout[i + 2] }
  }
}

const near = (p, c, tol = 16) =>
  Math.abs(p.r - c.r) <= tol && Math.abs(p.g - c.g) <= tol && Math.abs(p.b - c.b) <= tol
const fmt = (p) => `rgb(${p.r}, ${p.g}, ${p.b})`

/**
 * Encode one segment: the blue still on track 0, `video` on track 1 in a
 * 180x480 box (scaleX 1, scaleY 1.5) centred on the 180x320 canvas. A 16:9
 * source fits to 180x101 in that box, so the picture spans canvas y ≈ 110..211
 * and everything above and below it is pad.
 */
async function encodeOverBlue(dir, video, colorSpace = 'sdr_bt709') {
  const blue = path.join(dir, 'blue.png')
  if (!existsSync(blue)) ff(['-f', 'lavfi', '-i', `color=c=0x3366ff:size=${W}x${H}`, '-frames:v', '1', blue])
  const out = path.join(dir, `seg-${Math.random().toString(36).slice(2)}.mp4`)
  await encodeSegment({
    start: 0, end: 0.2, vw: W, vh: H, fps: 30, colorSpace, overlays: [],
    items: [
      { type: 'image', src: blue, start: 0, end: 0.2, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1 },
      { type: 'video', start: 0, end: 0.2, inPoint: 0, trackIdx: 1,
        scaleX: 1, scaleY: 1.5, offsetX: 0, offsetY: 0, opacity: 1,
        muted: true, hasAudio: false, ...video },
    ],
  }, out)
  assert.ok(existsSync(out), 'the segment encode produced no file')
  return firstFrame(out)
}

const withProbe = (src) => {
  const g = probeVideoGeometry(src)
  assert.ok(g, `probe failed for ${src}`)
  return { src, probedWidth: g.width, probedHeight: g.height, probedAlpha: g.alpha }
}

test('padded 16:9 video: the band shows the blue underneath, not black', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-vpad-'))
  try {
    const src = path.join(dir, 'orange-169.mp4')
    ff(['-f', 'lavfi', '-i', 'color=c=0xff8000:size=160x90:rate=30:duration=0.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src])
    const px = await encodeOverBlue(dir, withProbe(src))
    t.diagnostic(`band ${fmt(px(90, 30))} / ${fmt(px(90, 290))}, picture ${fmt(px(90, 160))}`)
    for (const [x, y, where] of [[90, 30, 'top band'], [90, 290, 'bottom band']]) {
      assert.ok(near(px(x, y), BLUE), `${where} should be the blue underneath, got ${fmt(px(x, y))}`)
    }
    assert.ok(near(px(90, 160), ORANGE), `the picture should be the footage, got ${fmt(px(90, 160))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown size (no probe): the band keeps the old opaque black', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-vpad-'))
  try {
    const src = path.join(dir, 'orange-169.mp4')
    ff(['-f', 'lavfi', '-i', 'color=c=0xff8000:size=160x90:rate=30:duration=0.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src])
    const px = await encodeOverBlue(dir, { src })
    const band = px(90, 30)
    t.diagnostic(`band ${fmt(band)}`)
    assert.ok(band.r <= 4 && band.g <= 4 && band.b <= 4, `unprobed band should stay black, got ${fmt(band)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('alpha footage keeps its alpha through scale → pad → overlay', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-vpad-'))
  try {
    // ProRes 4444 cutout: left half fully transparent, right half orange.
    const src = path.join(dir, 'cutout_nobg.mov')
    ff(['-f', 'lavfi', '-i', 'color=c=0xff8000:size=160x90:rate=30:duration=0.5',
      '-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,80),0,255)'",
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', src])
    const video = withProbe(src)
    assert.equal(video.probedAlpha, true, 'the probe must see the ProRes 4444 alpha')
    const px = await encodeOverBlue(dir, video)
    t.diagnostic(`band ${fmt(px(90, 30))}, clear half ${fmt(px(40, 160))}, opaque half ${fmt(px(140, 160))}`)
    assert.ok(near(px(90, 30), BLUE), `band should be blue, got ${fmt(px(90, 30))}`)
    assert.ok(near(px(40, 160), BLUE), `the cutout's transparent half should show blue, got ${fmt(px(40, 160))}`)
    assert.ok(near(px(140, 160), ORANGE), `the cutout's opaque half should be orange, got ${fmt(px(140, 160))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HDR→SDR LUT path: the 10-bit transparent pad shows the blue too', { timeout: 180_000 }, async (t) => {
  if (!hasZscale() || !hasLut3d()) {
    t.skip('ffmpeg lacks zscale and/or lut3d — run with MONTAJ_FFMPEG pointing at the managed build')
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-vpad-'))
  try {
    const src = path.join(dir, 'orange-169-hlg.mp4')
    ff(['-f', 'lavfi', '-i', 'color=c=0xff8000:size=160x90:rate=30:duration=0.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', src])
    const px = await encodeOverBlue(dir, { ...withProbe(src), colorTransfer: 'arib-std-b67' })
    for (const [x, y, where] of [[90, 30, 'top band'], [90, 290, 'bottom band']]) {
      assert.ok(near(px(x, y), BLUE), `${where} should be the blue underneath, got ${fmt(px(x, y))}`)
    }
    const mid = px(90, 160)
    t.diagnostic(`band ${fmt(px(90, 30))} / ${fmt(px(90, 290))}, picture ${fmt(mid)}`)
    assert.ok(!near(mid, BLUE, 40) && mid.r + mid.g + mid.b > 60,
      `the picture should carry the graded footage, got ${fmt(mid)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
