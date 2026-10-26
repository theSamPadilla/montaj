// render/test/hdr-one-white.test.mjs
//
// One graphics white in an HDR export: every graphic maps sRGB white to 800
// nits, over footage or not (the product owner, 2026-10-26). A segment with no
// visible footage, a full-screen card, a full-screen 3D beat and a timeline
// image with no clip all use the 800 LUT and never the 300 one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSegment } from '../encode-segment.js'
import { graphicsLutPath } from '../hdr-graphics.js'

const full = { webmPath: '/x/ov.mkv', startSeconds: 0, endSeconds: 1, isCaption: false, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 1 }
const video = { type: 'video', src: '/x/clip.mp4', start: 0, end: 1, trackIdx: 0, colorTransfer: 'bt709', hasAudio: false, muted: true, probedWidth: 640, probedHeight: 360 }
const image = { type: 'image', src: '/x/card.png', start: 0, end: 1, trackIdx: 1 }

for (const colorSpace of ['hdr_hlg', 'hdr_pq']) {
  const lut = (nits) => graphicsLutPath(colorSpace, { write: false, whiteNits: nits }).split('/').pop()
  const graph = async (seg) => (await encodeSegment({ start: 0, end: 1, vw: 640, vh: 360, fps: 30, colorSpace, items: [], overlays: [], ...seg },
    '/tmp/x.mp4', { _dryRun: true })).filterParts.join(';')
  const only800 = (g, why) => assert.ok(g.includes(lut(800)) && !g.includes(lut(300)), why)

  test(`${colorSpace}: an overlay, an opaque card and a caption with no footage map at 800`, async () => {
    only800(await graph({ overlays: [{ ...full, scale: 0.4 }] }), 'a bare-canvas overlay')
    only800(await graph({ overlays: [{ ...full, opaque: true }, { ...full, isCaption: true }] }), 'a card and its caption')
  })

  test(`${colorSpace}: an opaque card over culled footage and a 3D beat map at 800`, async () => {
    only800(await graph({ items: [video], opaqueVideo: true, overlays: [{ ...full, opaque: true, coversFrame: true }, { ...full, isCaption: true }] }), 'a card over culled footage')
    only800(await graph({ items: [video], opaqueVideo: true, overlays: [{ ...full, opaque: true, coversFrame: true, scene3d: true }, { ...full, isCaption: true }] }), 'a 3D beat')
  })

  test(`${colorSpace}: a timeline image with no clip maps at 800`, async () => {
    only800(await graph({ items: [image], overlays: [full] }), 'an image and the overlay over it')
  })
}
