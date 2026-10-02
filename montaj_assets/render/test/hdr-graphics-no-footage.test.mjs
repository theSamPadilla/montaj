// render/test/hdr-graphics-no-footage.test.mjs
//
// Graphics with no footage under them in an HDR render (POSTLAUNCH §47): a
// compose segment with no visible video clip, or a full-screen card, maps
// graphics white to GRAPHICS_WHITE_NITS_NO_FOOTAGE, 300 nits: the product
// owner's pick (2026-10-02) from 4K renders at 203, 300 and 400. 203 (BT.2408
// reference white, which SDR clips in an HDR project use) read too dim; 300
// sits a little above it. Graphics over footage keep GRAPHICS_WHITE_NITS.
// The pixels are proven in hdr-overlay-color.integration.test.mjs.
//
// The expected numbers come from an independent Python implementation of the
// standards (sRGB EOTF, the BT.2087 matrix, BT.2100 HLG with a 1000-nit display
// and system gamma 1.2, ST 2084 PQ), the one that reproduced every 900-, 800-
// and 203-nit value these tests have pinned. At 300 nits it gives:
//   HLG: scene light (300/1000)^(1/1.2) = 0.36666, signal 0.81291,
//        Y10 round(64 + 876 * 0.81291) = 776
//   PQ:  signal pqOetf(300) = 0.62186, Y10 round(64 + 876 * 0.62186) = 609

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GRAPHICS_WHITE_NITS, GRAPHICS_WHITE_NITS_NO_FOOTAGE,
  graphicsToHdr, graphicsLutText, graphicsLutPath, graphicsToHdrChain, hlgOetf, pqOetf,
} from '../hdr-graphics.js'
import { encodeSegment, graphicsWhiteNitsFor, SDR_WHITE_NITS } from '../encode-segment.js'

const close = (got, want, tol, label) =>
  assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want} (tolerance ${tol})`)

test('with no footage under them, graphics white is 300 nits, its own level, above SDR clip white', () => {
  assert.equal(GRAPHICS_WHITE_NITS_NO_FOOTAGE, 300)
  // Decoupled from SDR clips: an SDR clip in an HDR project stays at BT.2408's 203.
  assert.equal(SDR_WHITE_NITS, 203)
  assert.ok(GRAPHICS_WHITE_NITS_NO_FOOTAGE > SDR_WHITE_NITS)
  assert.equal(GRAPHICS_WHITE_NITS, 800, 'over footage it stays 800')
})

test('HLG white with no footage: scene light (300/1000)^(1/1.2), signal 0.81291, Y10 776', () => {
  const [r, g, b] = graphicsToHdr([1, 1, 1], 'hdr_hlg', GRAPHICS_WHITE_NITS_NO_FOOTAGE)
  close(r, hlgOetf(0.3 ** (1 / 1.2)), 1e-12, 'white')
  close(g, r, 1e-5, 'white is neutral (green)')
  close(b, r, 1e-5, 'white is neutral (blue)')
  close(r, 0.81291, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 776)
})

test('PQ white with no footage: 300 nits absolute, signal 0.62186, Y10 609', () => {
  const [r] = graphicsToHdr([1, 1, 1], 'hdr_pq', GRAPHICS_WHITE_NITS_NO_FOOTAGE)
  close(r, pqOetf(300), 1e-12, 'white')
  close(r, 0.62186, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 609)
})

test('the white level defaults to GRAPHICS_WHITE_NITS', () => {
  for (const key of ['hdr_hlg', 'hdr_pq']) {
    assert.deepEqual(graphicsToHdr([0.3, 0.6, 0.9], key), graphicsToHdr([0.3, 0.6, 0.9], key, 800))
  }
  assert.equal(graphicsLutText('hdr_pq'), graphicsLutText('hdr_pq', 800))
})

test('the 300-nit HLG LUT reproduces the independent reference', () => {
  // The Python implementation above at 300 nits, printed to 6 decimals.
  const reference = [
    [[64, 64, 64], [0.812907, 0.812907, 0.812907]],
    [[1, 0, 0], [0.028890, 0.009587, 0.004670]],
    [[32, 32, 32], [0.485225, 0.485225, 0.485225]],
    [[64, 0, 0], [0.722040, 0.275692, 0.134276]],
    [[0, 64, 0], [0.587094, 0.796821, 0.311149]],
    [[0, 0, 64], [0.218275, 0.111795, 0.791740]],
    [[10, 20, 30], [0.228563, 0.290559, 0.437683]],
    [[0, 45, 54], [0.443070, 0.641708, 0.728902]],
  ]
  const lines = graphicsLutText('hdr_hlg', 300).trim().split('\n')
  assert.equal(lines[0], 'TITLE "montaj graphics hdr_hlg 300 nits"')
  const data = lines.slice(2)
  for (const [[r, g, b], want] of reference) {
    assert.deepEqual(data[r + 65 * g + 65 * 65 * b].split(' ').map(Number), want, `entry (${r}, ${g}, ${b})`)
  }
})

test('each white level has its own LUT file, and the chain names the one it was given', () => {
  const at800 = graphicsLutPath('hdr_hlg', { write: false })
  const atNone = graphicsLutPath('hdr_hlg', { write: false, whiteNits: GRAPHICS_WHITE_NITS_NO_FOOTAGE })
  assert.notEqual(at800, atNone)
  assert.equal(graphicsLutPath('hdr_hlg', { write: false, whiteNits: 800 }), at800)
  const chain = graphicsToHdrChain('hdr_hlg', { input: 'capture', write: false, whiteNits: GRAPHICS_WHITE_NITS_NO_FOOTAGE })
  assert.ok(chain.includes(atNone.split('/').pop()), `${chain} names the no-footage LUT`)
  assert.ok(!chain.includes(at800.split('/').pop()))
  assert.ok(graphicsToHdrChain('hdr_hlg', { input: 'capture', write: false }).includes(at800.split('/').pop()))
})

const video = { type: 'video', src: '/x/clip.mp4', start: 0, end: 1, trackIdx: 0 }
const image = { type: 'image', src: '/x/card.png', start: 0, end: 1, trackIdx: 1 }

test('a segment is footage when a video clip is visible in it: 800 over footage, 300 without', () => {
  assert.equal(graphicsWhiteNitsFor({ items: [video] }), 800)
  assert.equal(graphicsWhiteNitsFor({ items: [video, image] }), 800, 'an image over footage is graphics over footage')
  assert.equal(graphicsWhiteNitsFor({ items: [] }), 300, 'bare canvas: an end card or a full-screen overlay')
  assert.equal(graphicsWhiteNitsFor({ items: [image] }), 300, 'a timeline image or screenshot with no clip')
  assert.equal(graphicsWhiteNitsFor({ items: [video], opaqueVideo: true }), 300,
    'an opaque overlay hides the clip, so nothing under the graphics is footage')
  assert.equal(graphicsWhiteNitsFor({}), 300)
})

for (const colorSpace of ['hdr_hlg', 'hdr_pq']) {
  test(`${colorSpace}: the encode maps each segment's graphics with that segment's white`, async () => {
    const overlay = { webmPath: '/x/ov.mkv', startSeconds: 0, endSeconds: 1, isCaption: false, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }
    const seg = (items) => ({ start: 0, end: 1, vw: 640, vh: 360, fps: 30, colorSpace, items, overlays: [overlay] })
    const graph = async (items) => (await encodeSegment(seg(items), '/tmp/x.mp4', { _dryRun: true })).filterParts.join(';')
    const lut = (nits) => graphicsLutPath(colorSpace, { write: false, whiteNits: nits }).split('/').pop()
    const bare = await graph([])
    assert.ok(bare.includes(lut(GRAPHICS_WHITE_NITS_NO_FOOTAGE)) && !bare.includes(lut(800)), 'a bare-canvas segment uses the no-footage LUT only')
    const overClip = await graph([{ ...video, colorTransfer: 'bt709', hasAudio: false, muted: true, probedWidth: 640, probedHeight: 360 }])
    assert.ok(overClip.includes(lut(800)) && !overClip.includes(lut(GRAPHICS_WHITE_NITS_NO_FOOTAGE)), 'a segment over a clip uses the 800-nit LUT only')
    const imageOnly = await graph([image])
    assert.ok(imageOnly.includes(lut(GRAPHICS_WHITE_NITS_NO_FOOTAGE)) && !imageOnly.includes(lut(800)), 'an image with no clip, and the overlay over it, use the no-footage level')
  })
}
