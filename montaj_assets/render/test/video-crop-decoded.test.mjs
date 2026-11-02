// §668: a video item's crop is cut in the pixels of the file actually decoded,
// as filter TEXT. The pixels are judged in video-crop-decoded.integration.test.mjs.
import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildVideoItemFilterParts, cropSourceSize } from '../encode-segment.js'

const OPTS = {
  segStart: 0,
  duration: 3,
  projectColorSpace: 'sdr_bt709',
  zscaleAvailable: true,
  lut3dAvailable: true,
  sdrCurve: null,
}
// The iPhone clip of §668: stored 1920x1440 with rotation -90, so 1440x1920 as
// shown; its converted copy, the file render decodes, is 1308x1744.
const iphone = (over = {}) => ({
  type: 'video', src: '/tmp/IMG_9140_normalized_hdr_hlg_w203.mp4', start: 0, duration: 3,
  scale: 1, offsetX: 0, offsetY: 0, sourceWidth: 1440, sourceHeight: 1920, ...over,
})
const CROP = { x: 0.08, y: 0, w: 0.75, h: 1 }
const build = (item, vw = 1080, vh = 1920) => buildVideoItemFilterParts(item, vw, vh, 1, '[canvas]', OPTS)
const chainOf = (r) => r.filterParts.find((p) => p.includes('[vid1]'))
function quietly(fn) {
  const warn = mock.method(console, 'warn', () => {})
  try { return fn() } finally { warn.mock.restore() }
}

describe('§668: a crop is cut in the decoded file\'s pixels', () => {
  test('the decoded size is the probed one, else the item\'s source size', () => {
    assert.deepEqual(cropSourceSize(iphone({ probedWidth: 1308, probedHeight: 1744 })), { width: 1308, height: 1744 })
    assert.deepEqual(cropSourceSize(iphone()), { width: 1440, height: 1920 })
    assert.deepEqual(cropSourceSize(iphone({ probedWidth: null, probedHeight: null })), { width: 1440, height: 1920 })
    assert.equal(cropSourceSize(iphone({ sourceWidth: undefined, sourceHeight: undefined })), null)
  })

  test('a still crop on the 1308x1744 copy is sized from it, not from 1440x1920', () => {
    const c = chainOf(build(iphone({ sourceCrop: CROP, probedWidth: 1308, probedHeight: 1744 })))
    // 1308 * 0.75 = 981 -> 982 (even), 1744 * 1, x = round(1308 * 0.08) = 105.
    assert.match(c, /,crop=982:1744:105:0,/, c)
  })

  test('without a probe the crop keeps the item\'s source size (byte-identical)', () => {
    const c = chainOf(build(iphone({ sourceCrop: CROP })))
    assert.match(c, /,crop=1080:1920:115:0,/, c)
  })

  test('a crop with no source size at all still renders uncropped (the gate is unchanged)', () => {
    const c = chainOf(build(iphone({ sourceCrop: CROP, sourceWidth: undefined, sourceHeight: undefined, probedWidth: 1308, probedHeight: 1744 })))
    assert.doesNotMatch(c, /crop=/, c)
  })

  test('a keyframed crop is cut in the decoded file\'s pixels too', () => {
    const lin = (prop, a, b) => ({ prop, points: [{ t: 0, value: a }, { t: 2, value: b }] })
    const keyframes = [lin('cropX', 0, 0.25), lin('cropY', 0, 0), lin('cropW', 0.75, 0.75), lin('cropH', 1, 1)]
    const c = quietly(() => chainOf(build(iphone({ keyframes, probedWidth: 1308, probedHeight: 1744 }))))
    // The union is the whole width (0..1) and height in the copy's pixels.
    const m = /setpts=PTS-STARTPTS,crop=(\d+):(\d+):(\d+):(\d+):exact=1,/.exec(c)
    assert.ok(m, c)
    assert.deepEqual(m.slice(1).map(Number), [1308, 1744, 0, 0], c)
  })
})
