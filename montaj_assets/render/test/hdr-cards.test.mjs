// render/test/hdr-cards.test.mjs
//
// Full-screen cards in an HDR render (POSTLAUNCH §47, second half). A film
// often keeps footage running under a full-screen overlay (for the audio and
// continuity), so "a video clip is in the segment" alone kept such an overlay at
// 800 nits. An overlay that covers the frame opaquely at some point is a card:
// it renders at GRAPHICS_WHITE_NITS_NO_FOOTAGE (300) for its whole span, fades
// included, and overlays and captions stacked above it in a segment follow it.
// Everything else keeps the per-segment footage rule (graphicsWhiteNitsFor).
// The pixels are proven in hdr-overlay-color.integration.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { isFullCanvasPlacement, captureHasOpaqueFrame, markCards } from '../cover-probe.js'
import { encodeSegment, overlayWhiteNits } from '../encode-segment.js'
import { graphicsLutPath, GRAPHICS_WHITE_NITS, GRAPHICS_WHITE_NITS_NO_FOOTAGE } from '../hdr-graphics.js'

const full = { webmPath: '/x/ov.mkv', startSeconds: 0, endSeconds: 1, isCaption: false, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 1 }

test('only an overlay placed over the whole canvas can be a card', () => {
  assert.equal(isFullCanvasPlacement(full), true)
  assert.equal(isFullCanvasPlacement({ ...full, scale: undefined, rotation: undefined, opacity: undefined }), true, 'defaults are full canvas')
  for (const [why, ov] of [
    ['scaled down', { ...full, scale: 0.5 }],
    ['scaled on one axis', { ...full, scaleX: 0.8 }],
    ['moved', { ...full, offsetX: 10 }],
    ['moved vertically', { ...full, offsetY: -4 }],
    ['rotated', { ...full, rotation: 3 }],
    ['translucent', { ...full, opacity: 0.6 }],
    ['keyframed', { ...full, keyframes: [{ t: 0 }] }],
    ['a caption', { ...full, isCaption: true }],
  ]) assert.equal(isFullCanvasPlacement(ov), false, why)
})

const W = 64, H = 36, FPS = 30

/** An ffv1 yuva420p capture (renderer.js's format) from per-frame alpha functions. */
function capture(dir, name, alphaOf, frames) {
  const raw = path.join(dir, `${name}.rgba`)
  const buf = Buffer.alloc(W * H * 4 * frames)
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = ((f * H + y) * W + x) * 4
      buf[o] = 238; buf[o + 1] = 242; buf[o + 2] = 245; buf[o + 3] = alphaOf(f, x, y)
    }
  }
  writeFileSync(raw, buf)
  const out = path.join(dir, `${name}.mkv`)
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', raw,
    '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska', out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return out
}

test('the probe finds a fully opaque frame in a capture that fades in and out, and none in a partial cover', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-cards-'))
  try {
    // Like mj_kit Ground: fades in over 4 frames, holds, fades out.
    const fade = (f) => (f < 4 ? Math.round(255 * f / 4) : f > 11 ? Math.round(255 * (15 - f) / 4) : 255)
    assert.equal(await captureHasOpaqueFrame(capture(dir, 'card', (f) => fade(f), 16)), true)
    // A lower third: opaque only in the bottom rows, on every frame.
    assert.equal(await captureHasOpaqueFrame(capture(dir, 'third', (f, x, y) => (y > 26 ? 255 : 0), 16)), false)
    // A translucent full-frame wash never reaches 255 anywhere.
    assert.equal(await captureHasOpaqueFrame(capture(dir, 'wash', () => 204, 8)), false)
    // A card that is never quite whole (one pixel stays clear) is not a card.
    assert.equal(await captureHasOpaqueFrame(capture(dir, 'holed', (f, x, y) => (x === 5 && y === 5 ? 0 : 255), 8)), false)
    // An unreadable capture is not a card: 800 is the safe answer.
    assert.equal(await captureHasOpaqueFrame(path.join(dir, 'missing.mkv')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markCards probes only full-canvas overlays, only in HDR, once per capture', async () => {
  const calls = []
  const probe = async (p) => { calls.push(p); return p === '/x/card.mkv' }
  const segs = () => [
    { ...full, webmPath: '/x/card.mkv' },
    { ...full, webmPath: '/x/third.mkv', scale: 0.4 },
    { ...full, webmPath: '/x/caption.mkv', isCaption: true },
    { ...full, webmPath: '/x/flagged.mkv', scale: 0.5, opaque: true },
    { ...full, webmPath: '/x/card.mkv', startSeconds: 1, endSeconds: 2 },
  ]
  const sdr = segs()
  await markCards(sdr, { colorSpace: 'sdr_bt709', probe })
  assert.equal(calls.length, 0, 'an SDR compose never probes')
  assert.ok(sdr.every((s) => !s.coversFrame))
  const hdr = segs()
  await markCards(hdr, { colorSpace: 'hdr_hlg', probe })
  assert.deepEqual(calls, ['/x/card.mkv'], 'only the full-canvas capture, once')
  assert.deepEqual(hdr.map((s) => !!s.coversFrame), [true, false, false, true, true], 'the explicit opaque flag is a card without a probe')
})

test('a card and whatever is stacked above it take the no-footage level; overlays below it keep the segment rule', () => {
  const card = { ...full, coversFrame: true }
  const lower = { ...full, scale: 0.4 }
  const caption = { ...full, isCaption: true }
  const overlays = [lower, card, caption]
  assert.equal(overlayWhiteNits(overlays, 0, GRAPHICS_WHITE_NITS), GRAPHICS_WHITE_NITS, 'below the card: footage rule')
  assert.equal(overlayWhiteNits(overlays, 1, GRAPHICS_WHITE_NITS), GRAPHICS_WHITE_NITS_NO_FOOTAGE, 'the card')
  assert.equal(overlayWhiteNits(overlays, 2, GRAPHICS_WHITE_NITS), GRAPHICS_WHITE_NITS_NO_FOOTAGE, 'a caption on the card')
  assert.equal(overlayWhiteNits([lower, caption], 1, GRAPHICS_WHITE_NITS), GRAPHICS_WHITE_NITS, 'no card: footage rule')
  assert.equal(overlayWhiteNits([lower], 0, GRAPHICS_WHITE_NITS_NO_FOOTAGE), GRAPHICS_WHITE_NITS_NO_FOOTAGE, 'no footage: the no-footage level anyway')
})

for (const colorSpace of ['hdr_hlg', 'hdr_pq']) {
  test(`${colorSpace}: a card over running footage maps at the no-footage level, a lower third over the same footage at 800`, async () => {
    const video = { type: 'video', src: '/x/clip.mp4', start: 0, end: 1, trackIdx: 0, colorTransfer: 'bt709', hasAudio: false, muted: true, probedWidth: 640, probedHeight: 360 }
    const lut = (nits) => graphicsLutPath(colorSpace, { write: false, whiteNits: nits }).split('/').pop()
    const graph = async (overlays) => (await encodeSegment({ start: 0, end: 1, vw: 640, vh: 360, fps: 30, colorSpace, items: [video], overlays },
      '/tmp/x.mp4', { _dryRun: true })).filterParts.join(';')
    const withCard = await graph([{ ...full, coversFrame: true }])
    assert.ok(withCard.includes(lut(GRAPHICS_WHITE_NITS_NO_FOOTAGE)) && !withCard.includes(lut(800)), 'the card uses the no-footage LUT')
    const withThird = await graph([{ ...full, scale: 0.4 }])
    assert.ok(withThird.includes(lut(800)) && !withThird.includes(lut(GRAPHICS_WHITE_NITS_NO_FOOTAGE)), 'a lower third over footage stays 800')
  })
}
