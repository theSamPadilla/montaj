// render/test/video-transparent-pad.test.mjs
//
// The video pad fill (todo #6): where a video item's decrease-fit footage does
// not cover its box, the export must leave that area TRANSPARENT, as the editor
// preview and sample_frame do, instead of painting ffmpeg's default opaque
// black. These pin the generated filter strings; the pixel-level proof is
// video-pad.integration.test.mjs.
//
// The property the strings must keep: the transparent pad appears ONLY when it
// can change the picture (a gap of more than 1 px, or alpha footage), and an
// item that fills its box, or whose size is unknown, emits exactly the opaque
// pad string it always has.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVideoItemFilterParts,
  decreaseFitSize,
  parseVideoGeometry,
} from '../encode-segment.js'

const SDR = { segStart: 0, duration: 5, projectColorSpace: 'sdr_bt709', zscaleAvailable: false }
const LUT = { ...SDR, zscaleAvailable: true, lut3dAvailable: true }

const base = {
  type: 'video', src: '/clip.mp4', start: 0, end: 5, inPoint: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
}
const chain = (item, opts = SDR, vw = 1080, vh = 1920) =>
  buildVideoItemFilterParts(item, vw, vh, 0, '[base]', opts).filterParts[0]

const OPAQUE_1080x1920 =
  '[0:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,' +
  'pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid0]'

// ---------------------------------------------------------------------------
// decreaseFitSize: a mirror of ffmpeg's decrease fit. Checked against ffmpeg
// 9.0.1 and the managed 8.1.2 on 25 cases (random included) with 0 mismatches
// when this was written; these are the named ones.
// ---------------------------------------------------------------------------

test('decreaseFitSize matches ffmpeg on the named cases', () => {
  assert.deepEqual(decreaseFitSize(320, 180, 360, 640), { width: 360, height: 203 })
  assert.deepEqual(decreaseFitSize(320, 180, 360, 640, 2), { width: 360, height: 202 })
  assert.deepEqual(decreaseFitSize(1536, 972, 1080, 1920), { width: 1080, height: 683 })
  assert.deepEqual(decreaseFitSize(1920, 1080, 1080, 608), { width: 1080, height: 608 })
  assert.deepEqual(decreaseFitSize(1080, 1920, 1080, 1920), { width: 1080, height: 1920 })
})

// ---------------------------------------------------------------------------
// parseVideoGeometry: display size and alpha from ffprobe JSON.
// ---------------------------------------------------------------------------

const probe = (stream) => ({ streams: [stream] })

test('parseVideoGeometry: coded size, and a quarter-turn displaymatrix swaps it', () => {
  assert.deepEqual(parseVideoGeometry(probe({ width: 1920, height: 1080, pix_fmt: 'yuv420p' })),
    { width: 1920, height: 1080, alpha: false })
  for (const rotation of [90, -90, 270, -270]) {
    assert.deepEqual(
      parseVideoGeometry(probe({ width: 1920, height: 1080, pix_fmt: 'yuv420p', side_data_list: [{ rotation }] })),
      { width: 1080, height: 1920, alpha: false }, `rotation ${rotation}`)
  }
  assert.deepEqual(
    parseVideoGeometry(probe({ width: 1920, height: 1080, pix_fmt: 'yuv420p', side_data_list: [{ rotation: 180 }] })),
    { width: 1920, height: 1080, alpha: false })
})

test('parseVideoGeometry: alpha comes from the pixel format', () => {
  for (const pix_fmt of ['yuva444p12le', 'yuva420p', 'yuva444p10le', 'rgba', 'bgra', 'argb', 'gbrap10le', 'ya8', 'rgba64le']) {
    assert.equal(parseVideoGeometry(probe({ width: 64, height: 36, pix_fmt })).alpha, true, pix_fmt)
  }
  for (const pix_fmt of ['yuv420p', 'yuv420p10le', 'yuvj420p', 'rgb24', 'rgb0', 'bgr0', 'gbrp', 'p010le']) {
    assert.equal(parseVideoGeometry(probe({ width: 64, height: 36, pix_fmt })).alpha, false, pix_fmt)
  }
})

test('parseVideoGeometry: no usable size is null (the encoder then keeps its old string)', () => {
  assert.equal(parseVideoGeometry({ streams: [] }), null)
  assert.equal(parseVideoGeometry({}), null)
  assert.equal(parseVideoGeometry(probe({ pix_fmt: 'yuv420p' })), null)
  assert.equal(parseVideoGeometry(probe({ width: 0, height: 1080 })), null)
})

// ---------------------------------------------------------------------------
// The pad string
// ---------------------------------------------------------------------------

test('padded static video: transparent pad after an explicit yuva420p pin', () => {
  // 16:9 footage in a full-frame 9:16 box: 1080x608 inside 1080x1920.
  const item = { ...base, probedWidth: 1920, probedHeight: 1080, probedAlpha: false }
  assert.equal(chain(item),
    '[0:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,' +
    'format=yuva420p,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0.0[vid0]')
})

test('padded via scaleY (the todo repro): a box taller than the footage pads transparently', () => {
  const item = { ...base, scaleX: 1, scaleY: 1.5, probedWidth: 1920, probedHeight: 1080, probedAlpha: false }
  assert.match(chain(item), /,format=yuva420p,pad=1080:2880:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0\.0\[vid0\]$/)
})

test('padded animated video: the peak-box pad is transparent, before the varying scale', () => {
  const item = {
    ...base, probedWidth: 1920, probedHeight: 1080, probedAlpha: false,
    keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 5, value: 1 }] }],
  }
  const f = chain(item)
  const m = /scale=(\d+):(\d+):force_original_aspect_ratio=decrease,format=yuva420p,pad=(\d+):(\d+):\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0\.0,scale=w='/.exec(f)
  assert.ok(m, `animated chain lacks the transparent peak pad: ${f}`)
  assert.deepEqual([m[3], m[4]], [m[1], m[2]], 'the pad is sized to the same peak box as the static scale')
})

test('padded animated + rotated: the pad stays transparent into the animated rotate tail', () => {
  const item = {
    ...base, probedWidth: 1920, probedHeight: 1080, probedAlpha: false, rotation: 20,
    keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 5, value: 1 }] }],
  }
  const f = chain(item)
  assert.match(f, /format=yuva420p,pad=\d+:\d+:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0\.0,scale=w='/)
  assert.match(f, /rotate='[^']+':ow=\d+:oh=\d+:c=black@0\.0\[vid0\]$/)
})

test('padded static + rotated: transparent pad, then the existing alpha pin and transparent rotate', () => {
  const item = { ...base, scale: 0.5, rotation: 90, probedWidth: 1920, probedHeight: 1080, probedAlpha: false }
  assert.match(chain(item),
    /scale=540:960:force_original_aspect_ratio=decrease,format=yuva420p,pad=540:960:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0\.0,format=yuva420p,rotate=90\*PI\/180:ow=960:oh=540:c=black@0\.0\[vid0\]$/)
})

test('alpha footage that fills its box still gets the alpha-preserving pad', () => {
  const item = { ...base, probedWidth: 1080, probedHeight: 1920, probedAlpha: true }
  assert.equal(chain(item),
    '[0:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,' +
    'format=yuva420p,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0.0[vid0]')
})

test('unpadded footage: byte-identical to the pre-fix string, probed or not', () => {
  const probed = { ...base, probedWidth: 1080, probedHeight: 1920, probedAlpha: false }
  assert.equal(chain(probed), OPAQUE_1080x1920)
  assert.equal(chain(probed), chain(base))
  // Landscape footage at its own aspect in a landscape canvas, off-identity scale.
  const land = { ...base, scale: 0.5, probedWidth: 1920, probedHeight: 1080, probedAlpha: false }
  assert.equal(chain(land, SDR, 1920, 1080), chain({ ...base, scale: 0.5 }, SDR, 1920, 1080))
  assert.doesNotMatch(chain(land, SDR, 1920, 1080), /yuva|color=black@0\.0/)
})

test('unknown size (no probe, failed probe): exactly the pre-fix opaque pad', () => {
  // The same 16:9-in-9:16 shape as the padded test above. Without a size the
  // gap cannot be known, so nothing changes.
  assert.equal(chain(base), OPAQUE_1080x1920)
  assert.equal(chain({ ...base, probedWidth: null, probedHeight: null, probedAlpha: null }), OPAQUE_1080x1920)
})

test('a gap of 1 px is within tolerance; 2 px is padding', () => {
  // 1080x1919 fits to 1080x1919 in a 1080x1920 box: 1 px gap → opaque, unchanged.
  assert.equal(chain({ ...base, probedWidth: 1080, probedHeight: 1919, probedAlpha: false }), OPAQUE_1080x1920)
  // 1080x1918 leaves 2 px → transparent.
  assert.match(chain({ ...base, probedWidth: 1080, probedHeight: 1918, probedAlpha: false }),
    /format=yuva420p,pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0\.0/)
})

test('a sourceCrop decides from the crop size, with no probe at all', () => {
  // The source-crop corpus fixture's numbers: a 1536x972 crop in a 1080x1920
  // box fits to 1080x683, so the pad has bars to fill.
  const cropped = {
    ...base, sourceCrop: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 }, sourceWidth: 1920, sourceHeight: 1080,
  }
  assert.equal(chain(cropped),
    '[0:v]setpts=PTS-STARTPTS,crop=1536:972:192:54,scale=1080:1920:force_original_aspect_ratio=decrease,' +
    'format=yuva420p,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0.0[vid0]')
  // An exactly 9:16 crop window (540x960) fills the box: unchanged opaque string.
  const fills = {
    ...base, sourceCrop: { x: 0.25, y: 0.05, w: 0.28125, h: 0.8888889 }, sourceWidth: 1920, sourceHeight: 1080,
  }
  assert.equal(chain(fills),
    '[0:v]setpts=PTS-STARTPTS,crop=540:960:480:54,scale=1080:1920:force_original_aspect_ratio=decrease,' +
    'pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid0]')
})

test('HDR→SDR LUT path: the transparent pad is 10-bit 4:4:4 and sits after the conversion', () => {
  const item = { ...base, colorTransfer: 'arib-std-b67', probedWidth: 1920, probedHeight: 1080, probedAlpha: false }
  const f = chain(item, LUT)
  const retag = 'zscale=tin=bt709:t=bt709:pin=bt709:p=bt709:m=bt709:rin=full:r=tv'
  assert.ok(f.includes(`scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,`))
  assert.ok(f.includes(`${retag},format=yuva444p10le,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0.0[vid0]`), f)
  assert.ok(f.indexOf('format=rgb48le') < f.indexOf('format=yuva444p10le'), 'the pin follows the whole LUT chain')
  assert.doesNotMatch(f, /yuva420p/, 'no 8-bit alpha pin on the unrotated LUT path')
})

test('HDR→SDR LUT path, unpadded: no pin at all, the pre-fix string', () => {
  const probed = { ...base, colorTransfer: 'arib-std-b67', probedWidth: 1080, probedHeight: 1920, probedAlpha: false }
  const plain = { ...base, colorTransfer: 'arib-std-b67' }
  assert.equal(chain(probed, LUT), chain(plain, LUT))
  assert.doesNotMatch(chain(probed, LUT), /yuva|color=black@0\.0/)
})

test('HDR project with no conversion (HLG in HLG) still pads at 10 bits', () => {
  const opts = { ...LUT, projectColorSpace: 'hdr_hlg' }
  const item = { ...base, colorTransfer: 'arib-std-b67', probedWidth: 1920, probedHeight: 1080, probedAlpha: false }
  const f = chain(item, opts)
  assert.doesNotMatch(f, /zscale|lut3d/, 'same colour space: no conversion step')
  assert.match(f, /decrease,format=yuva444p10le,pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0\.0\[vid0\]$/)
})

test('the overlay step is untouched: .mp4 keeps format=yuv420, .mov keeps format=auto', () => {
  const padded = { ...base, probedWidth: 1920, probedHeight: 1080, probedAlpha: false }
  const parts = (item) => buildVideoItemFilterParts(item, 1080, 1920, 0, '[base]', SDR).filterParts
  assert.equal(parts(padded)[1], parts(base)[1])
  assert.match(parts(padded)[1], /:format=yuv420:shortest=0/)
  const mov = { ...padded, src: '/cutout_nobg.mov', probedAlpha: true }
  assert.match(parts(mov)[1], /:format=auto:shortest=0/)
})
