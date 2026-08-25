import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { buildVideoItemFilterParts, buildImageItemFilterParts } from '../encode-segment.js'
import { geometryAt, toPixelBox, toRotatedPixelBox } from '@bycrux/timeline-core'

/**
 * SP9d — keyframed video/image clips compile their geometry into time-varying
 * ffmpeg expressions.
 *
 * The critical guard here is NOT any single assertion about expression text: it
 * is that a NON-keyframed item's filter string is byte-identical to what shipped
 * before. `encode-args-golden.test.mjs` freezes that for whole commands; this
 * file pins it at the per-item level, where a regression is easier to read.
 */

const VW = 1920
const VH = 1080
const OPTS = {
  segStart: 0,
  duration: 3,
  projectColorSpace: 'sdr_bt709',
  zscaleAvailable: true,
  lut3dAvailable: true,
  sdrCurve: null,
}

const videoItem = (over = {}) => ({
  type: 'video', src: '/tmp/clip.mp4', start: 0, duration: 3,
  scale: 0.75, offsetX: 0, offsetY: 0, ...over,
})
const track = (prop, points) => ({ prop, points })

const buildVideo = (item, opts = {}) =>
  buildVideoItemFilterParts(item, VW, VH, 1, '[canvas]', { ...OPTS, ...opts })

/** The one chain part that carries the item's geometry. */
const chainOf = (r) => r.filterParts.find((p) => p.includes('[vid1]') || p.includes('[img1]'))
const overlayOf = (r) => r.filterParts.find((p) => p.includes('overlay='))

describe('SP9d — the static path is untouched', () => {
  test('a non-keyframed video item emits exactly what it always has', () => {
    const r = buildVideo(videoItem())
    const chain = chainOf(r)
    assert.ok(!chain.includes('eval=frame'), 'no eval=frame on a static item')
    assert.ok(!/\bt\b/.test(overlayOf(r)), 'no time expression in the overlay position')
    // The literal box, computed the way it always was.
    const box = toRotatedPixelBox({ scale: 0.75, offsetX: 0, offsetY: 0 }, VW, VH)
    assert.match(overlayOf(r), new RegExp(`overlay=x=${box.x}:y=${box.y}\\b`))
    assert.equal(chain.includes(`scale=${box.scaledW}:${box.scaledH}:force_original_aspect_ratio=decrease`), true)
  })

  test('an EMPTY keyframes array is still the static path', () => {
    const r = buildVideo(videoItem({ keyframes: [] }))
    assert.ok(!chainOf(r).includes('eval=frame'))
  })

  test('keyframes on props that do not affect geometry stay on the static path', () => {
    // Defensive: hand-authored JSON can carry anything.
    const r = buildVideo(videoItem({ keyframes: [track('nonsense', [{ t: 0, value: 1 }])] }))
    assert.ok(!chainOf(r).includes('eval=frame'))
  })
})

describe('SP9d — keyframed items compile to expressions', () => {
  test('a keyframed position emits an overlay expression in t, not a literal', () => {
    const r = buildVideo(videoItem({
      keyframes: [track('offsetX', [{ t: 0, value: 0 }, { t: 3, value: 20 }])],
    }))
    const ov = overlayOf(r)
    assert.match(ov, /overlay=x='[^']*\bt\b[^']*'/, 'x must be a time expression')
    assert.ok(ov.includes('round('), 'must round — ffmpeg truncates a pixel option')
    // Position-only leaves the geometry chain completely alone: no resize work.
    assert.ok(!chainOf(r).includes('eval=frame'),
      'animating position alone must not put scale on the per-frame path')
  })

  test('a keyframed scale adds eval=frame and a second, animated scale', () => {
    const r = buildVideo(videoItem({
      keyframes: [track('scale', [{ t: 0, value: 0.6 }, { t: 3, value: 0.9 }])],
    }))
    const chain = chainOf(r)
    assert.match(chain, /scale=w='[^']*\bt\b[^']*':h='[^']*':eval=frame/)
    // ...sized to the PEAK box up front, so the conversion sees a fixed size.
    const peak = toPixelBox({ scale: 0.9, offsetX: 0, offsetY: 0 }, VW, VH)
    assert.ok(chain.includes(`scale=${peak.width}:${peak.height}:force_original_aspect_ratio=decrease`),
      'the static pre-fit must target the peak box')
    assert.ok(chain.includes(`pad=${peak.width}:${peak.height}`), 'and so must the pad')
  })

  test('a keyframed rotation emits rotate with an angle expression and a FIXED ow/oh', () => {
    const r = buildVideo(videoItem({
      keyframes: [track('rotation', [{ t: 0, value: 0 }, { t: 3, value: 12 }])],
    }))
    const chain = chainOf(r)
    assert.match(chain, /rotate='[^']*\bt\b[^']*'/, 'the angle must vary with t')
    assert.match(chain, /ow=\d+:oh=\d+/, "rotate's ow/oh are config-time only and must be literals")
    assert.ok(!/ow='[^']*t/.test(chain), 'a t in ow/oh evaluates to nan and kills the graph')
  })

  test('rotation reserves a box big enough for the widest angle it reaches', () => {
    const r = buildVideo(videoItem({
      keyframes: [track('rotation', [{ t: 0, value: 0 }, { t: 3, value: 30 }])],
    }))
    const m = /ow=(\d+):oh=(\d+)/.exec(chainOf(r))
    const worst = toRotatedPixelBox({ scale: 0.75, offsetX: 0, offsetY: 0, rotation: 30 }, VW, VH)
    assert.equal(Number(m[1]), worst.outW)
    assert.equal(Number(m[2]), worst.outH)
  })

  test('animating scale keeps rotate on a CONSTANT-size input', () => {
    // The landmine: `rotate` configures against its first frame and mis-scales
    // every resized frame after it. The animated scale must therefore be
    // followed by a pad back to a fixed size before rotate ever sees it.
    const r = buildVideo(videoItem({
      keyframes: [
        track('scale', [{ t: 0, value: 0.5 }, { t: 3, value: 0.9 }]),
        track('rotation', [{ t: 0, value: 0 }, { t: 3, value: 10 }]),
      ],
    }))
    const chain = chainOf(r)
    const animScale = chain.indexOf("scale=w='")
    const rotate = chain.indexOf('rotate=')
    const peak = toPixelBox({ scale: 0.9, offsetX: 0, offsetY: 0 }, VW, VH)
    const refix = chain.indexOf(`pad=${peak.width}:${peak.height}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`)
    assert.ok(animScale >= 0 && refix > animScale && rotate > refix,
      `expected animated scale → fixed-size pad → rotate, got: ${chain}`)
  })

  test('the colour conversion never sees a variable-size frame', () => {
    // Same class of landmine as rotate, on the path every HDR source takes.
    const r = buildVideo(videoItem({
      colorTransfer: 'arib-std-b67',
      keyframes: [track('scale', [{ t: 0, value: 0.5 }, { t: 3, value: 0.9 }])],
    }), { projectColorSpace: 'sdr_bt709' })
    const chain = chainOf(r)
    const conv = chain.indexOf('lut3d=')
    const animScale = chain.indexOf("scale=w='")
    assert.ok(conv >= 0, 'this fixture must actually exercise the conversion')
    assert.ok(animScale > conv, 'the animated resize must come AFTER the conversion')
  })

  test('pad still sits after the conversion, so its bars stay out of the LUT', () => {
    const r = buildVideo(videoItem({
      colorTransfer: 'arib-std-b67',
      keyframes: [track('scale', [{ t: 0, value: 0.5 }, { t: 3, value: 0.9 }])],
    }))
    const chain = chainOf(r)
    assert.ok(chain.indexOf('pad=') > chain.indexOf('lut3d='),
      'moving pad ahead of the LUT tints the letterbox')
  })
})

describe('SP9d — opacity is excluded, and stays excluded', () => {
  test('an opacity curve on a clip is IGNORED — static aa, never an expression', () => {
    // ffmpeg's colorchannelmixer `aa` is a <double> and accepts no expression.
    // Pinned so nobody "fixes" this into a filter graph that will not build.
    const r = buildVideo(videoItem({
      opacity: 0.5,
      keyframes: [track('opacity', [{ t: 0, value: 0 }, { t: 3, value: 1 }])],
    }))
    const mixer = r.filterParts.find((p) => p.includes('colorchannelmixer'))
    assert.ok(mixer, 'a non-1 opacity still emits the mixer')
    assert.match(mixer, /colorchannelmixer=aa=0\.5\b/)
    assert.ok(!/\bt\b/.test(mixer), 'no time expression may reach colorchannelmixer')
  })

  test('an opacity curve alone does not push the item onto the animated path', () => {
    const r = buildVideo(videoItem({ keyframes: [track('opacity', [{ t: 0, value: 0 }, { t: 3, value: 1 }])] }))
    assert.ok(!chainOf(r).includes('eval=frame'))
  })
})

describe('SP9d — item-relative time', () => {
  test('an item that does not start at 0 is offset correctly', () => {
    // The classic off-by-a-start bug: curve `t` is ITEM-relative, ffmpeg's `t`
    // is segment-relative. Segment starts at 5, item at 2, so ffmpeg t=0 is
    // item t=3 and the keyframe at item t=3 must land at ffmpeg t=0.
    const item = videoItem({
      start: 2, duration: 10,
      keyframes: [track('offsetX', [{ t: 3, value: 0 }, { t: 6, value: 30 }])],
    })
    const r = buildVideo(item, { segStart: 5, duration: 3 })
    const ov = overlayOf(r)
    // The compiled breakpoints are shifted by 3s, so the span reads 0..3.
    assert.ok(ov.includes('between(t,0,3)'),
      `expected a 0..3 span after the shift, got ${ov}`)
  })

  test('an item starting AFTER the segment start is not shifted negative', () => {
    const item = videoItem({
      start: 5, duration: 5,
      keyframes: [track('offsetX', [{ t: 0, value: 0 }, { t: 2, value: 30 }])],
    })
    const r = buildVideo(item, { segStart: 5, duration: 3 })
    assert.ok(overlayOf(r).includes('between(t,0,2)'))
  })
})

describe('SP9d — clip speed', () => {
  // setpts=(PTS-STARTPTS)/speed runs FIRST in the chain, so every downstream
  // filter's `t` is already back in TIMELINE seconds. The expression therefore
  // needs no speed factor — but a suite with no speed fixture would pass while
  // every sped-up keyframed clip rendered wrong, so both directions are pinned.
  for (const speed of [2, 0.5]) {
    test(`a keyframed clip at speed ${speed} animates over the same timeline span`, () => {
      const item = videoItem({
        speed,
        keyframes: [track('offsetX', [{ t: 0, value: 0 }, { t: 3, value: 20 }])],
      })
      const r = buildVideo(item)
      const chain = chainOf(r)
      assert.ok(chain.includes(`setpts=(PTS-STARTPTS)/${speed}`), 'the speed step must still be there')
      // The span is 0..3 in TIMELINE seconds regardless of speed — no factor.
      assert.ok(overlayOf(r).includes('between(t,0,3)'),
        `speed ${speed} must not rescale the expression's span`)
    })
  }

  test('the expression is byte-identical at 1x, 2x and 0.5x', () => {
    const kf = [track('offsetX', [{ t: 0, value: 0 }, { t: 3, value: 20 }])]
    const at = (speed) => overlayOf(buildVideo(videoItem({ speed, keyframes: kf })))
    assert.equal(at(2), at(undefined))
    assert.equal(at(0.5), at(undefined))
  })
})

describe('SP9d — image items animate too', () => {
  const imageItem = (over = {}) => ({
    type: 'image', src: '/tmp/pic.png', start: 0, duration: 3,
    scale: 0.75, offsetX: 0, offsetY: 0, ...over,
  })

  test('a non-keyframed image is byte-identical to before', () => {
    const r = buildImageItemFilterParts(imageItem(), VW, VH, 1, '[canvas]', 3, 0)
    assert.ok(!chainOf(r).includes('eval=frame'))
    const box = toRotatedPixelBox({ scale: 0.75, offsetX: 0, offsetY: 0 }, VW, VH)
    assert.match(overlayOf(r), new RegExp(`overlay=x=${box.x}:y=${box.y}\\b`))
  })

  test('a keyframed image compiles the same way a video does', () => {
    const r = buildImageItemFilterParts(
      imageItem({ keyframes: [track('scale', [{ t: 0, value: 0.5 }, { t: 3, value: 0.9 }])] }),
      VW, VH, 1, '[canvas]', 3, 0,
    )
    assert.match(chainOf(r), /scale=w='[^']*\bt\b[^']*':h='[^']*':eval=frame/)
    assert.match(overlayOf(r), /overlay=x='[^']*\bt\b/)
  })

  test('omitting segStart keeps the six-argument sample-frame call working', () => {
    const r = buildImageItemFilterParts(imageItem(), VW, VH, 1, '[canvas]', 3)
    assert.ok(!chainOf(r).includes('eval=frame'))
  })
})

describe('SP9d — scale and rotation compounding, against the ground truth', () => {
  test('both animated together land within a stated total pixel budget', () => {
    // Every other test validates ONE track against sampleTrack in isolation.
    // This is the only one that catches the two approximations compounding
    // through the composite formula, which is where the rotation tolerance
    // being referenced to the PEAK box actually matters.
    const item = videoItem({
      keyframes: [
        track('scale', [{ t: 0, value: 0.5, easing: 'ease-in-out' }, { t: 3, value: 0.9 }]),
        track('rotation', [{ t: 0, value: 0, easing: 'ease-in-out' }, { t: 3, value: 20 }]),
        track('offsetX', [{ t: 0, value: -10, easing: 'ease' }, { t: 3, value: 10 }]),
      ],
    })
    const r = buildVideo(item)
    const ov = overlayOf(r)
    const xExpr = /overlay=x='([^']*)'/.exec(ov)[1]
    const yExpr = /:y='([^']*)'/.exec(ov)[1]
    const m = /ow=(\d+):oh=(\d+)/.exec(chainOf(r))
    const outW = Number(m[1])
    const outH = Number(m[2])

    // Independent evaluator for the emitted dialect, plus round().
    const ev = (src, t) => Function('t', `
      const round = Math.round
      const between = (x, a, b) => (x >= a && x <= b ? 1 : 0)
      const iff = (c, a, b) => (c ? a : b)
      return ${src.replace(/\bif\(/g, 'iff(')}
    `)(t)

    const TOTAL_PIXEL_BUDGET = 3
    for (let t = 0; t <= 3; t += 1 / 30) {
      const g = geometryAt(item, 'video', t)
      const truth = toRotatedPixelBox(g, VW, VH)
      // The renderer reserves ONE grown box for the whole span, so the ground
      // truth for the composite corner is the box centre minus half of that
      // frozen box — not truth.x, which assumes a per-frame grown box.
      const wantX = Math.round(truth.xPx + truth.scaledW / 2 - outW / 2)
      const wantY = Math.round(truth.yPx + truth.scaledH / 2 - outH / 2)
      assert.ok(Math.abs(ev(xExpr, t) - wantX) <= TOTAL_PIXEL_BUDGET,
        `t=${t.toFixed(3)}: x ${ev(xExpr, t)} vs ${wantX}`)
      assert.ok(Math.abs(ev(yExpr, t) - wantY) <= TOTAL_PIXEL_BUDGET,
        `t=${t.toFixed(3)}: y ${ev(yExpr, t)} vs ${wantY}`)
    }
  })
})

describe('SP9d — the emitted graph actually builds in ffmpeg', () => {
  const haveFfmpeg = (() => {
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' })
      return true
    } catch { return false }
  })()

  test('a fully-animated chain is accepted by the real binary', { skip: haveFfmpeg ? false : 'ffmpeg not on PATH' }, () => {
    const r = buildVideo(videoItem({
      src: 'lavfi-placeholder',
      keyframes: [
        track('scale', [{ t: 0, value: 0.5 }, { t: 3, value: 0.9 }]),
        track('rotation', [{ t: 0, value: 0 }, { t: 3, value: 15 }]),
        track('offsetX', [{ t: 0, value: -10 }, { t: 3, value: 10 }]),
        track('offsetY', [{ t: 0, value: 0 }, { t: 3, value: 5 }]),
      ],
    }))
    // Swap the item input for a synthetic source and run one frame through.
    const graph = r.filterParts.join(';').replace(/\[1:v\]/g, '[1:v]')
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', `color=black:s=${VW}x${VH}:r=30:d=1`,
      '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=1`,
      '-filter_complex', graph,
      '-map', '[iv1]', '-frames:v', '3', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  })
})
