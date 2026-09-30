// PV55 phase 2: a video's keyframed source crop in the export, as filter TEXT.
// The pixels are judged in video-crop.integration.test.mjs; these pin the shape.
//
// The chain, per the plan: a static pre-crop to the union of every rect shown,
// an eval=frame `scale` that resizes it so the current rect lands at the fixed
// size, a FIXED-size `crop` moving in t, then the usual decrease-fit,
// conversion, pad and rotate on a CONSTANT frame. Nothing may ever sit between
// that scale and that crop (the stale-clamp trap, PV55 T1), and the conversion
// must come after the crop, because it breaks on a varying frame size.
// The fixed crop is cut at the size the picture is SHOWN (D1): the rect's fit
// into the peak, unrotated box, never more than the rect in source pixels.
import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildVideoItemFilterParts, decreaseFitSize } from '../encode-segment.js'

const VW = 1080
const VH = 1920
const OPTS = {
  segStart: 0,
  duration: 3,
  projectColorSpace: 'sdr_bt709',
  zscaleAvailable: true,
  lut3dAvailable: true,
  sdrCurve: null,
}
const vid = (over = {}) => ({
  type: 'video', src: '/tmp/pv55-clip.mp4', start: 0, duration: 3,
  scale: 1, offsetX: 0, offsetY: 0, sourceWidth: 1920, sourceHeight: 1080, ...over,
})
const build = (item, opts = {}) => buildVideoItemFilterParts(item, VW, VH, 1, '[canvas]', { ...OPTS, ...opts })
const chainOf = (r) => r.filterParts.find((p) => p.includes('[vid1]') || p.includes('split=2'))
const overlayOf = (r) => r.filterParts.find((p) => p.includes('overlay='))
const lin = (prop, a, b, t1 = 2) => ({ prop, points: [{ t: 0, value: a }, { t: t1, value: b }] })
/** Quiet console.warn for one call, and return what it said. */
function quietly(fn) {
  const warn = mock.method(console, 'warn', () => {})
  try {
    const result = fn()
    return { result, said: warn.mock.calls.map((c) => String(c.arguments[0])) }
  } finally { warn.mock.restore() }
}

// A 9:16 window of a 16:9 source (607.5 x 1080 px of 1920 x 1080).
const W916 = 0.31640625
const PAN = [lin('cropX', 0, 1 - W916), lin('cropY', 0, 0), lin('cropW', W916, W916), lin('cropH', 1, 1)]
// From the centred 9:16 window to one a quarter its size, the same pixel aspect.
const ZOOM = [lin('cropX', 0.341796875, 0.5), lin('cropY', 0, 0.3), lin('cropW', W916, W916 / 4), lin('cropH', 1, 0.25)]
const SHAPE = /^\[1:v\]setpts=PTS-STARTPTS,crop=\d+:\d+:\d+:\d+:exact=1,scale=w='[^']*\bt\b[^']*':h='[^']*\bt\b[^']*':eval=frame,crop=(\d+):(\d+):x='[^']*\bt\b[^']*':y='[^']*':exact=1,scale=1080:1920:force_original_aspect_ratio=decrease(:force_divisible_by=2)?,/

describe('PV55 phase 2: without crop keyframes a video is byte-identical', () => {
  // Literal strings captured from the code before phase 2 (pv55p2 f42cc5f).
  test('no crop', () => {
    assert.equal(chainOf(build(vid())),
      '[1:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[vid1]')
  })
  test('a still sourceCrop keeps its static crop', () => {
    assert.equal(chainOf(build(vid({ sourceCrop: { x: 0.341796875, y: 0, w: W916, h: 1 } }))),
      '[1:v]setpts=PTS-STARTPTS,crop=608:1080:656:0,scale=1080:1920:force_original_aspect_ratio=decrease,'
      + 'format=yuva420p,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0.0[vid1]')
  })
})

describe('PV55 phase 2: a keyframed video crop animates in the export', () => {
  test('union pre-crop, scale(eval=frame), the FIXED crop directly after it, then the decrease-fit', () => {
    const c = chainOf(build(vid({ keyframes: ZOOM })))
    const m = SHAPE.exec(c)
    assert.ok(m, c)
    // The fixed size is what is shown, capped at the largest rect in source
    // pixels (607.5 x 1080 -> 608 x 1080, even). Its 1080 x 1918 fit is larger,
    // so here the cap holds; the D1 tests below take a source larger than its box.
    assert.deepEqual([Number(m[1]), Number(m[2])], [608, 1080])
  })

  test('the union: every rect shown, origin on even pixels', () => {
    // x spans 0.341796875 .. 0.658203125 of 1920 = 656.25 .. 1263.75 -> 656 + 608; full height.
    assert.match(chainOf(build(vid({ keyframes: ZOOM }))), /^\[1:v\]setpts=PTS-STARTPTS,crop=608:1080:656:0:exact=1,/)
    // A full-width pan visits the whole frame.
    assert.match(chainOf(build(vid({ keyframes: PAN }))), /^\[1:v\]setpts=PTS-STARTPTS,crop=1920:1080:0:0:exact=1,/)
  })

  test('the colour conversion follows the fixed crop and never sees the varying size', () => {
    const c = chainOf(build(vid({ colorTransfer: 'arib-std-b67', keyframes: ZOOM })))
    assert.match(c, SHAPE)
    const fixed = c.indexOf('crop=608:1080:x=')
    assert.ok(c.indexOf('lut3d=') > fixed && c.indexOf('zscale=') > fixed, c)
    assert.ok(c.indexOf('pad=') > c.indexOf('lut3d='), 'pad stays after the conversion')
  })

  test('the footage the pad judges is the fixed crop: a 9:16 crop in a 16:9 box pads transparently', () => {
    const wide = (item) => buildVideoItemFilterParts(item, 1920, 1080, 1, '[canvas]', OPTS).filterParts[0]
    assert.match(wide(vid({ keyframes: PAN })), /,format=yuva420p,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0\.0\[vid1\]$/)
    // Control: the same clip uncropped fills that box, and keeps the opaque pad.
    assert.match(wide(vid({ probedWidth: 1920, probedHeight: 1080 })), /,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2\[vid1\]$/)
  })

  test('crop keyframes alone never move the box', () => {
    assert.match(overlayOf(build(vid({ keyframes: ZOOM }))), /overlay=x=0:y=0:/)
  })

  test('crop and box keyframes compose: the fixed crop feeds the PEAK-box fit, the animated scale follows the pad', () => {
    const c = chainOf(build(vid({ keyframes: [...ZOOM, lin('scale', 0.5, 1)] })))
    assert.match(c, /:eval=frame,crop=608:1080:x='[^']*':y='[^']*':exact=1,scale=1080:1920:force_original_aspect_ratio=decrease,/)
    assert.ok(c.indexOf("scale=w='round(round(") > c.indexOf('pad='), c)
  })

  test('time is item-relative, in timeline seconds whatever the speed', () => {
    // The segment starts 1 s into the item: keys at 0 and 2 land at t = -1 and 1.
    const shifted = chainOf(build(vid({ start: 0.5, keyframes: PAN }), { segStart: 1.5, duration: 1 }))
    assert.ok(shifted.includes('between(t,-1,1)'), shifted)
    const cropOf = (c) => c.slice(c.indexOf(',crop='), c.indexOf(',scale=1080:1920:'))
    assert.equal(cropOf(chainOf(build(vid({ speed: 2, keyframes: PAN })))), cropOf(chainOf(build(vid({ keyframes: PAN })))))
  })

  test('a graded cutout crops before its alpha split', () => {
    const c = chainOf(build(vid({
      src: '/tmp/c_nobg.mov', remove_bg: true, nobg_src: '/tmp/c_nobg.mov', alphaGrade: true,
      gradeFrom: 'hdr_hlg', colorTransfer: 'unknown', probedAlpha: true, keyframes: ZOOM,
    })))
    assert.match(c, /:eval=frame,crop=608:1080:x='[^']*':y='[^']*':exact=1,scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuva444p12le,split=2/)
  })

  test('with no sourceWidth/sourceHeight: no crop, one warning', () => {
    const bare = { sourceWidth: undefined, sourceHeight: undefined }
    const { result, said } = quietly(() => chainOf(build(vid({ ...bare, keyframes: ZOOM }))))
    assert.equal(result, chainOf(build(vid(bare))))
    assert.equal(said.length, 1, said.join('\n'))
    assert.match(said[0], /sourceWidth/)
  })

  test('a non-numeric sourceCrop under crop keyframes never reaches the filter graph', () => {
    // A key that is not a finite number is skipped by the sampler and the
    // compiler alike; an unkeyed prop falls back to the static sourceCrop, which
    // is where text could get in.
    const item = vid({ sourceCrop: { x: "0':y='0", y: 0, w: 1, h: 1 }, keyframes: ZOOM.slice(2) })
    const { result, said } = quietly(() => chainOf(build(item)))
    assert.equal(result, chainOf(build(vid())))
    assert.ok(said.some((m) => m.includes('animated crop')), said.join('\n'))
  })

  test('a crop that collapses to nothing later holds the crop at the segment start, and warns', () => {
    const late = [...ZOOM.slice(0, 2), lin('cropW', W916, 0), lin('cropH', 1, 0)]
    const { result, said } = quietly(() => chainOf(build(vid({ keyframes: late }))))
    assert.match(result, /^\[1:v\]setpts=PTS-STARTPTS,crop=608:1080:656:0,scale=1080:1920:force_original_aspect_ratio=decrease,/)
    assert.ok(said.some((m) => m.includes('held at 0s')), said.join('\n'))
  })

  test('past the pixel budget a deep zoom still ANIMATES, at 1/S, and the decrease-fit upscales it', () => {
    // A 4K source, the 9:16 window zoomed to 2% of its width: the union at the
    // deepest zoom would be ~19k x 34k px. The framing must still follow the
    // preview; only sharpness may give.
    const H1 = (0.02 * 3840) / (0.5625 * 2160)
    const deep = [lin('cropX', 0.341796875, 0.49), lin('cropY', 0, 0.47), lin('cropW', W916, 0.02), lin('cropH', 1, H1)]
    // What the export derives: the fixed size (the largest rect, 1216 x 2160
    // even, shown at its 1080 x 1918 fit into the box: D1), the union
    // (x 1312.5 .. 2527.5 of 3840, full height), the deepest zoom's factor into
    // that fixed size, the peak frame, and S = sqrt(peak / budget).
    const BW = 1080
    const BH = 1918
    const uw = 2528 - 1312
    const uh = 2160
    const kMax = Math.max(BW / (0.02 * 3840), BH / (H1 * 2160))
    const S = Math.sqrt((Math.ceil(uw * kMax) * Math.ceil(uh * kMax)) / 64_000_000)
    assert.ok(S > 1, `fixture must exceed the budget: S=${S}`)
    const bw = Math.floor(BW / S)
    const bh = Math.floor(BH / S)
    const { result: c, said } = quietly(() => chainOf(build(vid({ sourceWidth: 3840, sourceHeight: 2160, keyframes: deep }))))
    assert.ok(c.startsWith(`[1:v]setpts=PTS-STARTPTS,crop=${uw}:${uh}:1312:0:exact=1,scale=w='`), c)
    assert.match(c, new RegExp(`':eval=frame,crop=${bw}:${bh}:x='[^']*\\bt\\b[^']*':y='[^']*':exact=1,scale=1080:1920:force_original_aspect_ratio=decrease,`))
    // S reaches the filter text as a plain decimal (never exponent notation).
    const s = /\)\/([^)']+)\)':h='/.exec(c)?.[1]
    assert.match(s ?? '', /^\d+\.\d+$/, c)
    assert.ok(Math.abs(Number(s) - S) < 1e-5, `S in the graph ${s} vs ${S}`)
    assert.ok(said.some((m) => m.includes('video item') && m.includes('resolution')), said.join('\n'))
    assert.ok(!said.some((m) => /held/.test(m)), said.join('\n'))
  })
})

describe('PV55 phase 2 D1: the fixed crop is cut at the size it is SHOWN', () => {
  // A 4K source: the 9:16 window (1215 x 2160 px, 1216 x 2160 even) is larger
  // than the 1080 x 1920 box it is shown in, so the fixed crop is its fit.
  const K4 = { sourceWidth: 3840, sourceHeight: 2160 }
  const fixedOf = (c) => {
    const m = /:eval=frame,crop=(\d+):(\d+):x='/.exec(c)
    assert.ok(m, c)
    return [Number(m[1]), Number(m[2])]
  }

  test('a rect larger than its box: the fixed crop is its fit into the box, and the decrease-fit after it is a no-op', () => {
    const c = chainOf(build(vid({ ...K4, keyframes: ZOOM })))
    assert.deepEqual(fixedOf(c), [1080, 1918])
    assert.match(c, /:eval=frame,crop=1080:1918:x='[^']*':y='[^']*':exact=1,scale=1080:1920:force_original_aspect_ratio=decrease,/)
    assert.deepEqual(decreaseFitSize(1080, 1918, 1080, 1920), { width: 1080, height: 1918 })
  })

  test('a rect smaller than its box is never upsampled in the chain: the fixed crop stays the rect in source pixels', () => {
    // 1920 x 1080: the window is 608 x 1080 px and its fit 1080 x 1918. The
    // crop stays 608 x 1080 and the decrease-fit upscales it, as for a still crop.
    assert.deepEqual(fixedOf(chainOf(build(vid({ keyframes: ZOOM })))), [608, 1080])
  })

  test('a small box: the fixed crop is the small box fit', () => {
    assert.deepEqual(fixedOf(chainOf(build(vid({ ...K4, scale: 0.25, keyframes: ZOOM })))), [270, 480])
  })

  test('rotation turns the picture 1:1, so a rotated item cuts the same fixed crop as an unrotated one', () => {
    for (const over of [{ rotation: 30 }, { rotation: 90 }, { keyframes: [...ZOOM, lin('rotation', 0, 90)] }]) {
      assert.deepEqual(fixedOf(chainOf(build(vid({ ...K4, keyframes: ZOOM, ...over })))), [1080, 1918], JSON.stringify(over))
    }
  })

  test('an animated box: the fixed crop fits the PEAK box, not the start box', () => {
    // Scale 0.5 -> 1 starts at a 540 x 960 box (its fit is 540 x 960); the peak is 1080 x 1920.
    assert.deepEqual(fixedOf(chainOf(build(vid({ ...K4, keyframes: [...ZOOM, lin('scale', 0.5, 1)] })))), [1080, 1918])
    assert.deepEqual(fixedOf(chainOf(build(vid({ ...K4, keyframes: [...ZOOM, lin('scale', 1, 0.5)] })))), [1080, 1918])
  })

  test('nothing after the fixed crop enlarges it: the decrease-fit is a no-op unless the crop is the source rect or 1/S', () => {
    const ev = (v) => Math.round(v / 2) * 2
    const boxes = [{}, { scale: 0.25 }, { scaleX: 0.5 }, { scaleY: 0.6 }, { rotation: 45 },
      { keyframes: [...ZOOM, lin('scale', 0.3, 1)] }, { keyframes: [...ZOOM, lin('scaleX', 1, 0.4)] },
      { keyframes: [...ZOOM, lin('rotation', 0, 90)] }]
    let checked = 0
    for (const [SW, SH] of [[3840, 2160], [1920, 1080], [640, 360]]) {
      const RW = ev(W916 * SW)
      const RH = ev(SH)
      for (const box of boxes) {
        for (const colour of [{}, { colorTransfer: 'arib-std-b67' }]) {
          for (const opts of [{}, { cropBudgetPx: 64_000 }]) {
            const item = vid({ sourceWidth: SW, sourceHeight: SH, keyframes: ZOOM, ...box, ...colour })
            const { result: c } = quietly(() => chainOf(build(item, opts)))
            const [bw, bh] = fixedOf(c)
            const fit = /:exact=1,scale=(\d+):(\d+):force_original_aspect_ratio=decrease(:force_divisible_by=2)?,/.exec(c)
            assert.ok(fit, c)
            const out = decreaseFitSize(bw, bh, Number(fit[1]), Number(fit[2]), fit[3] ? 2 : 1)
            const at = `${SW}x${SH} ${JSON.stringify({ ...box, keyframes: undefined })} ${JSON.stringify(opts)}: ${c}`
            if (/\)\/\d+\.\d+\)':h='/.test(c)) continue // 1/S: the decrease-fit upscales it by design
            assert.ok(bw <= RW && bh <= RH, `never above the source rect: ${at}`)
            if (bw === RW && bh === RH) continue // the source rect itself: no more pixels to cut
            assert.deepEqual([out.width, out.height], [bw, bh], at)
            checked++
          }
        }
      }
    }
    assert.ok(checked >= 20, `the sweep must reach the shown-size branch: ${checked}`)
  })
})
