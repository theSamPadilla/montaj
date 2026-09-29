import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildImageItemFilterParts } from '../encode-segment.js'

const VW = 1080
const VH = 1920
const img = (over = {}) => ({ type: 'image', src: '/tmp/pv55-photo.jpg', start: 0, end: 3, scale: 1, offsetX: 0, offsetY: 0, ...over })
const build = (item, duration = 3, segStart = 0) => buildImageItemFilterParts(item, VW, VH, 1, '[canvas]', duration, segStart)
const chainOf = (r) => r.filterParts.find((p) => p.includes('[img1]'))
const overlayOf = (r) => r.filterParts.find((p) => p.includes('overlay='))
const lin = (prop, a, b, t1 = 2) => ({ prop, points: [{ t: 0, value: a }, { t: t1, value: b }] })
const PAN = [lin('cropX', 0, 0.68), lin('cropY', 0, 0), lin('cropW', 0.3164, 0.3164), lin('cropH', 1, 1)]
const DIMS = { probedWidth: 2696, probedHeight: 1524 }
const STATIC_COVER = '[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=rgba,setpts=PTS-STARTPTS[img1]'

describe('PV55: a still crop runs before the fit', () => {
  test('no sourceCrop: byte-identical to before', () => {
    assert.equal(chainOf(build(img())), STATIC_COVER)
  })
  test('a full-frame sourceCrop is no crop', () => {
    assert.equal(chainOf(build(img({ sourceCrop: { x: 0, y: 0, w: 1, h: 1 } }))), STATIC_COVER)
  })
  for (const fit of ['cover', 'contain', 'fill']) {
    test(`sourceCrop precedes the ${fit} fit, in the image's own pixels`, () => {
      const c = chainOf(build(img({ fit, sourceCrop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 } })))
      assert.ok(c.startsWith("[1:v]crop=w='round(iw*0.5)':h='round(ih*0.8)':x='round(iw*0.25)':y='round(ih*0.1)':exact=1,scale=1080:1920"), c)
    })
  }
})

describe('PV55: a keyframed crop animates', () => {
  test('scale(eval=frame), then a FIXED box-size crop moving in t, with nothing between them', () => {
    const c = chainOf(build(img({ ...DIMS, keyframes: PAN })))
    assert.match(c, /^\[1:v\]crop=\d+:\d+:\d+:\d+:exact=1,scale=w='[^']*\bt\b[^']*':h='[^']*':eval=frame,crop=1080:1920:x='[^']*\bt\b[^']*':y='[^']*':exact=1,scale,format=rgba,setpts=/)
  })
  test('the pre-crop is the union of every rect shown, origin on even pixels', () => {
    // x spans 0 .. 0.68+0.3164 = 0.9964 of 2696 -> ceil(2686.29) = 2687; full height.
    assert.match(chainOf(build(img({ ...DIMS, keyframes: PAN }))), /^\[1:v\]crop=2687:1524:0:0:exact=1,/)
  })
  test('crop keyframes alone never move the box', () => {
    assert.match(overlayOf(build(img({ ...DIMS, keyframes: PAN }))), /overlay=x=0:y=0:/)
  })
  test('an animated crop covers even when fit is contain', () => {
    assert.doesNotMatch(chainOf(build(img({ ...DIMS, fit: 'contain', keyframes: PAN }))), /force_original_aspect_ratio|pad=/)
  })
  test('crop and box keyframes compose: the crop fills the PEAK box, then the box animates', () => {
    const c = chainOf(build(img({ ...DIMS, keyframes: [...PAN, lin('scale', 0.5, 1)] })))
    assert.match(c, /crop=1080:1920:x='[^']*':y='[^']*':exact=1,scale,format=rgba,scale=w='[^']*':h='[^']*':eval=frame/)
  })
  test('with no readable size it holds the crop at the segment start, and warns', () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      const c = chainOf(build(img({ src: '/nonexistent/pv55.jpg', keyframes: PAN }), 3, 1))
      assert.ok(c.startsWith("[1:v]crop=w='round(iw*0.3164)':h='round(ih*1)':x='round(iw*0.34)':y='round(ih*0)':exact=1,"), c)
      assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('animated crop')))
    } finally { warn.mock.restore() }
  })
  test('a zoom too deep to render holds the crop instead of failing the export', () => {
    // 9:16 framing of a 4032x3024 photo zoomed to the crop tool's 2% limit: the
    // scaled union would be ~22.8k x 40.5k px (measured to fail, PV55 T13).
    const deep = [lin('cropX', 0.2890625, 0.49), lin('cropY', 0, 0.4763), lin('cropW', 0.421875, 0.02), lin('cropH', 1, 0.0474)]
    const warn = mock.method(console, 'warn', () => {})
    try {
      const c = chainOf(build(img({ probedWidth: 4032, probedHeight: 3024, keyframes: deep })))
      assert.doesNotMatch(c, /eval=frame/)
      assert.ok(c.startsWith("[1:v]crop=w='round(iw*0.421875)':h='round(ih*1)':x='round(iw*0.2890625)':y='round(ih*0)':exact=1,"), c)
      assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('too deep')))
    } finally { warn.mock.restore() }
  })
  test('a non-numeric sourceCrop never reaches the filter graph', () => {
    const c = chainOf(build(img({ sourceCrop: { x: "0':y='0", y: 0, w: 0.5, h: 0.5 } })))
    assert.equal(c, STATIC_COVER)
  })
})
