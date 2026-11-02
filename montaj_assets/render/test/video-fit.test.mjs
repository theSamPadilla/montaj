// §669: a video item's `fit` (cover, contain, fill), as filter TEXT. The pixels
// are judged in video-fit.integration.test.mjs.
import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildVideoItemFilterParts } from '../encode-segment.js'

const OPTS = {
  segStart: 0,
  duration: 3,
  projectColorSpace: 'sdr_bt709',
  zscaleAvailable: true,
  lut3dAvailable: true,
  sdrCurve: null,
}
const build = (item, vw = 1080, vh = 1920) => buildVideoItemFilterParts(item, vw, vh, 1, '[canvas]', OPTS)
const chainOf = (r) => r.filterParts.find((p) => p.includes('[vid1]'))
function quietly(fn) {
  const warn = mock.method(console, 'warn', () => {})
  try { return fn() } finally { warn.mock.restore() }
}

describe('§669: a video item\'s fit', () => {
  const clip = (over = {}) => ({
    type: 'video', src: '/tmp/three-four.mp4', start: 0, duration: 3,
    scale: 1, offsetX: 0, offsetY: 0, probedWidth: 1308, probedHeight: 1744, ...over,
  })

  test('no fit is contain, byte-identical to before', () => {
    assert.equal(chainOf(build(clip({ probedWidth: undefined, probedHeight: undefined }))),
      '[1:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid1]')
    assert.equal(chainOf(build(clip({ fit: 'contain' }))), chainOf(build(clip())))
  })

  test('cover scales to fill the box and crops the overflow, centred, with an opaque pad', () => {
    assert.equal(chainOf(build(clip({ fit: 'cover' }))),
      '[1:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,'
      + 'pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid1]')
  })

  test('fill stretches to the box', () => {
    assert.equal(chainOf(build(clip({ fit: 'fill' }))),
      '[1:v]setpts=PTS-STARTPTS,scale=1080:1920,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid1]')
  })

  test('cover with a sourceCrop crops first, then covers the cropped region', () => {
    const c = chainOf(build(clip({ fit: 'cover', sourceWidth: 1440, sourceHeight: 1920, sourceCrop: { x: 0.5, y: 0, w: 0.5, h: 1 } })))
    assert.equal(c, '[1:v]setpts=PTS-STARTPTS,crop=654:1744:654:0,'
      + 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid1]')
  })

  test('cover on a scaled box covers that box', () => {
    const c = chainOf(build(clip({ fit: 'cover', scale: 0.5 })))
    assert.match(c, /scale=540:960:force_original_aspect_ratio=increase,crop=540:960,pad=540:960:/, c)
  })

  test('cover under an animated box covers the peak box, then resizes it', () => {
    const keyframes = [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 2, value: 1 }] }]
    const c = quietly(() => chainOf(build(clip({ fit: 'cover', keyframes }))))
    assert.match(c, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,pad=1080:1920:[^,]*,scale=w='/, c)
  })

  test('cover with a keyframed crop cuts the moving window at the box\'s aspect, then covers', () => {
    const lin = (prop, a, b) => ({ prop, points: [{ t: 0, value: a }, { t: 2, value: b }] })
    const keyframes = [lin('cropX', 0, 0.25), lin('cropY', 0, 0), lin('cropW', 0.75, 0.75), lin('cropH', 1, 1)]
    const c = quietly(() => chainOf(build(clip({ fit: 'cover', sourceWidth: 1440, sourceHeight: 1920, keyframes }))))
    const m = /eval=frame,crop=(\d+):(\d+):x='[^']*':y='[^']*':exact=1,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,/.exec(c)
    assert.ok(m, c)
    const [bw, bh] = [Number(m[1]), Number(m[2])]
    // 981 x 1744 shown at 9:16: the full height, 981 wide.
    assert.ok(Math.abs(bw / bh - 1080 / 1920) < 0.01, `${bw}x${bh} is not 9:16: ${c}`)
    assert.ok(bw <= 982 && bh <= 1744, c)
  })

  test('fill with a keyframed crop covers, as an image\'s does', () => {
    const lin = (prop, a, b) => ({ prop, points: [{ t: 0, value: a }, { t: 2, value: b }] })
    const keyframes = [lin('cropX', 0, 0.25), lin('cropW', 0.75, 0.75)]
    const c = quietly(() => chainOf(build(clip({ fit: 'fill', sourceWidth: 1440, sourceHeight: 1920, keyframes }))))
    assert.match(c, /force_original_aspect_ratio=increase,crop=1080:1920,/, c)
  })
})
