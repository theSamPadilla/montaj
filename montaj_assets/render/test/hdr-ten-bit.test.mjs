// render/test/hdr-ten-bit.test.mjs (§619)
//
// HDR layers composite onto the 10-bit canvas at 10 bits. overlay's default
// `format=yuv420` converts the canvas and everything on it to 8-bit (measured:
// a 10-bit ramp keeps 206 of 256 codes); `yuv420p10` keeps all 256. SDR graphs
// stay byte-identical. Dry-run builders, no ffmpeg.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVideoItemFilterParts,
  buildImageItemFilterParts,
  buildOverlayFilterParts,
  encodeSegment,
} from '../encode-segment.js'
import { planSegments } from '../segment-plan.js'

const TEN = 'yuv420p10le'
const optsOf = (canvasPixFmt) => ({
  segStart: 0, duration: 5, projectColorSpace: 'sdr_bt709', zscaleAvailable: false,
  ...(canvasPixFmt ? { canvasPixFmt } : {}),
})
const vid = { type: 'video', src: '/clip.mp4', start: 0, end: 5, inPoint: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }
const mov = { ...vid, src: '/cut.mov' }
const img = { type: 'image', src: '/img.png', start: 0, end: 5, scale: 0.5, offsetX: 0, offsetY: 0, opacity: 1 }
const video = (item, canvasPixFmt) => buildVideoItemFilterParts(item, 1080, 1920, 0, '[base]', optsOf(canvasPixFmt)).filterParts
const image = (item, canvasPixFmt) => buildImageItemFilterParts(item, 1080, 1920, 0, '[base]', 5, 0, optsOf(canvasPixFmt)).filterParts
const last = (parts) => parts[parts.length - 1]

test('video on a 10-bit canvas composites at yuv420p10, .mov cutout too', () => {
  assert.ok(last(video(vid, TEN)).includes(':format=yuv420p10:shortest=0[iv0]'))
  assert.ok(last(video(mov, TEN)).includes(':format=yuv420p10:shortest=0[iv0]'))
})

test('video on an SDR or unknown canvas keeps today\'s format', () => {
  for (const c of [undefined, 'yuv420p']) {
    assert.ok(last(video(vid, c)).includes(':format=yuv420:shortest=0[iv0]'), String(c))
    assert.ok(last(video(mov, c)).includes(':format=auto:shortest=0[iv0]'), String(c))
  }
})

test('image on a 10-bit canvas composites at yuv420p10; SDR has no format=', () => {
  assert.ok(last(image(img, TEN)).includes(':format=yuv420p10:shortest=0[iv0]'))
  for (const c of [undefined, 'yuv420p']) assert.ok(!last(image(img, c)).includes('format='), String(c))
})

test('blended video and image on a 10-bit canvas end at yuv420p10', () => {
  const end = 'overlay=x=0:y=0:format=yuv420p10:shortest=0[iv0]'
  assert.ok(last(video({ ...vid, blendMode: 'screen' }, TEN)).endsWith(end))
  assert.ok(last(image({ ...img, blendMode: 'screen' }, TEN)).endsWith(end))
})

test('buildOverlayFilterParts emits the composite flag it is given', () => {
  const { filterParts } = buildOverlayFilterParts(
    { webmPath: '/tmp/ov.mkv', startSeconds: 0, scale: 1 }, 1080, 1920, 1, '[base]', 0, 2,
    { fps: 30, compositeFormatFlag: 'yuv420p10' })
  assert.ok(filterParts.some(p => p.includes(':format=yuv420p10:shortest=0[vov1]')))
})

const SEG_ITEMS = [
  { id: 'v', type: 'video', start: 0, end: 4, src: '/v.mp4', inPoint: 0, outPoint: 4, trackIdx: 0, layerTrack: 0 },
]
const OVS = [{ id: 'o', startSeconds: 0, endSeconds: 4, webmPath: '/o.mkv', isCaption: false, opaque: false, layerTrack: 1, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 1 }]
async function compositeOf(colorSpace) {
  const [seg] = planSegments(SEG_ITEMS, OVS, 1080, 1920, 30)
  const { filterParts } = await encodeSegment({ ...seg, colorSpace }, '/tmp/h.mp4', { _dryRun: true })
  return filterParts.find(p => p.includes('[vov'))
}

test('encodeSegment: an HDR overlay composites at yuv420p10, SDR at yuv420', async () => {
  assert.ok((await compositeOf('hdr_hlg')).includes(':format=yuv420p10:'))
  const sdr = await compositeOf('sdr_bt709')
  assert.ok(sdr.includes(':format=yuv420:'))
})

// ── The cutout's colour declaration, and rotate staying 10-bit ──────────────
const hdrOpts = { segStart: 0, duration: 5, projectColorSpace: 'hdr_hlg', zscaleAvailable: true, canvasPixFmt: TEN }
const hdrVideo = (item, extra = {}) =>
  buildVideoItemFilterParts(item, 1080, 1920, 0, '[base]', { ...hdrOpts, ...extra }).filterParts
const sdrVideo = (item) => video(item)
const head = (parts) => parts.find(p => p.startsWith('[0:v]'))
const BT601 = 'setparams=colorspace=smpte170m,'
const SDR_TAG = 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709,'

test('HDR untagged remove_bg cutout is declared BT.601 after the trim, before setpts', () => {
  const cut = { ...mov, inPoint: 1, colorTransfer: 'unknown', remove_bg: true, nobg_src: '/cut.mov' }
  const h = head(hdrVideo(cut))
  assert.ok(h.includes(BT601), h)
  assert.ok(h.indexOf('trim=') < h.indexOf(BT601) && h.indexOf(BT601) < h.indexOf('setpts='), h)
})

test('HDR untagged non-cutout is not declared BT.601 (zscale tags it)', () => {
  const h = head(hdrVideo({ ...vid, colorTransfer: 'unknown' }))
  assert.ok(!h.includes(BT601), h)
})

test('HDR tagged video gets no such tag', () => {
  const h = head(hdrVideo({ ...vid, colorTransfer: 'arib-std-b67' }))
  assert.ok(!h.includes(BT601), h)
})

test('SDR untaggedTag is unchanged', () => {
  assert.ok(head(sdrVideo({ ...vid, colorTransfer: 'unknown' })).includes(SDR_TAG))
  assert.ok(!head(sdrVideo({ ...vid, colorTransfer: 'bt709' })).includes('setparams='))
})

test('a rotated video pins yuva444p10le on the 10-bit canvas, yuva420p on SDR', () => {
  const rot = { ...vid, rotation: 30 }
  assert.ok(hdrVideo(rot).join(';').includes('format=yuva444p10le,rotate='))
  assert.ok(sdrVideo(rot).join(';').includes('format=yuva420p,rotate='))
  const anim = { ...vid, keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 5, value: 45 }] }] }
  assert.ok(hdrVideo(anim).join(';').includes('format=yuva444p10le,pad='))
  assert.ok(sdrVideo(anim).join(';').includes('format=yuva420p,pad='))
})
