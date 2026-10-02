// render/test/hdr-graphics-no-footage.test.mjs
//
// Graphics with no footage under them in an HDR render (POSTLAUNCH §47): a
// compose segment with no visible video clip maps graphics white to BT.2408
// reference white, 203 nits, so a title card or a full-screen overlay matches
// SDR and the editor preview; graphics over footage keep GRAPHICS_WHITE_NITS.
// The pixels are proven in hdr-overlay-color.integration.test.mjs.
//
// The expected numbers come from an independent Python implementation of the
// standards (sRGB EOTF, the BT.2087 matrix, BT.2100 HLG with a 1000-nit display
// and system gamma 1.2, ST 2084 PQ), the one that reproduced every 900- and
// 800-nit value hdr-graphics.test.mjs pins. At 203 nits it gives:
//   HLG: scene light (203/1000)^(1/1.2) = 0.26480, signal 0.74988 (BT.2408's
//        75%), Y10 round(64 + 876 * 0.74988) = 721
//   PQ:  signal pqOetf(203) = 0.58069, Y10 round(64 + 876 * 0.58069) = 573
//        (BT.2408 rounds the signal to 58%, Y10 572, the figure quoted for
//        SDR_WHITE_NITS; the exact ST 2084 value rounds to 573)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GRAPHICS_WHITE_NITS, GRAPHICS_WHITE_NITS_NO_FOOTAGE,
  graphicsToHdr, graphicsLutText, graphicsLutPath, graphicsToHdrChain, hlgOetf, pqOetf,
} from '../hdr-graphics.js'
import { encodeSegment, graphicsWhiteNitsFor, SDR_WHITE_NITS } from '../encode-segment.js'

const close = (got, want, tol, label) =>
  assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want} (tolerance ${tol})`)

test('with no footage under them, graphics white is BT.2408 reference white, 203 nits, the same as SDR clips', () => {
  assert.equal(GRAPHICS_WHITE_NITS_NO_FOOTAGE, 203)
  assert.equal(GRAPHICS_WHITE_NITS_NO_FOOTAGE, SDR_WHITE_NITS)
  assert.equal(GRAPHICS_WHITE_NITS, 800, 'over footage it stays 800')
})

test('HLG white with no footage: scene light (203/1000)^(1/1.2), signal 0.74988, Y10 721', () => {
  const [r, g, b] = graphicsToHdr([1, 1, 1], 'hdr_hlg', 203)
  close(r, hlgOetf(0.203 ** (1 / 1.2)), 1e-12, 'white')
  close(g, r, 1e-5, 'white is neutral (green)')
  close(b, r, 1e-5, 'white is neutral (blue)')
  close(r, 0.74988, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 721)
})

test('PQ white with no footage: 203 nits absolute, signal 0.58069, Y10 573', () => {
  const [r] = graphicsToHdr([1, 1, 1], 'hdr_pq', 203)
  close(r, pqOetf(203), 1e-12, 'white')
  close(r, 0.58069, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 573)
})

test('the white level defaults to GRAPHICS_WHITE_NITS', () => {
  for (const key of ['hdr_hlg', 'hdr_pq']) {
    assert.deepEqual(graphicsToHdr([0.3, 0.6, 0.9], key), graphicsToHdr([0.3, 0.6, 0.9], key, 800))
  }
  assert.equal(graphicsLutText('hdr_pq'), graphicsLutText('hdr_pq', 800))
})

test('the 203-nit HLG LUT reproduces the independent reference', () => {
  // The Python implementation above at 203 nits, printed to 6 decimals.
  const reference = [
    [[64, 64, 64], [0.749877, 0.749877, 0.749877]],
    [[1, 0, 0], [0.024551, 0.008148, 0.003968]],
    [[32, 32, 32], [0.412350, 0.412350, 0.412350]],
    [[64, 0, 0], [0.655743, 0.234286, 0.114109]],
    [[0, 64, 0], [0.511220, 0.733330, 0.264418]],
    [[0, 0, 64], [0.185493, 0.095005, 0.728095]],
    [[10, 20, 30], [0.194236, 0.246921, 0.371948]],
    [[0, 45, 54], [0.376526, 0.570655, 0.662916]],
  ]
  const lines = graphicsLutText('hdr_hlg', 203).trim().split('\n')
  assert.equal(lines[0], 'TITLE "montaj graphics hdr_hlg 203 nits"')
  const data = lines.slice(2)
  for (const [[r, g, b], want] of reference) {
    assert.deepEqual(data[r + 65 * g + 65 * 65 * b].split(' ').map(Number), want, `entry (${r}, ${g}, ${b})`)
  }
})

test('each white level has its own LUT file, and the chain names the one it was given', () => {
  const at800 = graphicsLutPath('hdr_hlg', { write: false })
  const at203 = graphicsLutPath('hdr_hlg', { write: false, whiteNits: 203 })
  assert.notEqual(at800, at203)
  assert.equal(graphicsLutPath('hdr_hlg', { write: false, whiteNits: 800 }), at800)
  const chain = graphicsToHdrChain('hdr_hlg', { input: 'capture', write: false, whiteNits: 203 })
  assert.ok(chain.includes(at203.split('/').pop()), `${chain} names the 203-nit LUT`)
  assert.ok(!chain.includes(at800.split('/').pop()))
  assert.ok(graphicsToHdrChain('hdr_hlg', { input: 'capture', write: false }).includes(at800.split('/').pop()))
})

const video = { type: 'video', src: '/x/clip.mp4', start: 0, end: 1, trackIdx: 0 }
const image = { type: 'image', src: '/x/card.png', start: 0, end: 1, trackIdx: 1 }

test('a segment is footage when a video clip is visible in it: 800 over footage, 203 without', () => {
  assert.equal(graphicsWhiteNitsFor({ items: [video] }), 800)
  assert.equal(graphicsWhiteNitsFor({ items: [video, image] }), 800, 'an image over footage is graphics over footage')
  assert.equal(graphicsWhiteNitsFor({ items: [] }), 203, 'bare canvas: an end card or a full-screen overlay')
  assert.equal(graphicsWhiteNitsFor({ items: [image] }), 203, 'a timeline image or screenshot with no clip')
  assert.equal(graphicsWhiteNitsFor({ items: [video], opaqueVideo: true }), 203,
    'an opaque overlay hides the clip, so nothing under the graphics is footage')
  assert.equal(graphicsWhiteNitsFor({}), 203)
})

for (const colorSpace of ['hdr_hlg', 'hdr_pq']) {
  test(`${colorSpace}: the encode maps each segment's graphics with that segment's white`, async () => {
    const overlay = { webmPath: '/x/ov.mkv', startSeconds: 0, endSeconds: 1, isCaption: false, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }
    const seg = (items) => ({ start: 0, end: 1, vw: 640, vh: 360, fps: 30, colorSpace, items, overlays: [overlay] })
    const graph = async (items) => (await encodeSegment(seg(items), '/tmp/x.mp4', { _dryRun: true })).filterParts.join(';')
    const lut = (nits) => graphicsLutPath(colorSpace, { write: false, whiteNits: nits }).split('/').pop()
    const bare = await graph([])
    assert.ok(bare.includes(lut(203)) && !bare.includes(lut(800)), 'a bare-canvas segment uses the 203-nit LUT only')
    const overClip = await graph([{ ...video, colorTransfer: 'bt709', hasAudio: false, muted: true, probedWidth: 640, probedHeight: 360 }])
    assert.ok(overClip.includes(lut(800)) && !overClip.includes(lut(203)), 'a segment over a clip uses the 800-nit LUT only')
    const imageOnly = await graph([image])
    assert.ok(imageOnly.includes(lut(203)) && !imageOnly.includes(lut(800)), 'an image with no clip, and the overlay over it, use 203')
  })
}
