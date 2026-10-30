import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { blurFilterStep, BLUR_STEPS, VIDEO_BLUR_FORMAT, IMAGE_BLUR_FORMAT } from '../item-blur.js'
import { encodeSegment, buildVideoItemFilterParts, buildImageItemFilterParts } from '../encode-segment.js'
import { radialBlurPlan, radialTapInverse, pictureRectInBox } from '@bycrux/timeline-core'
import { FFMPEG } from '../ffmpeg-bin.js'

// ── The step ────────────────────────────────────────────────────────────────

const O = { vw: 1080, vh: 1920, format: 'yuva444p', name: 'bl3' }
// The margin is ceil(3 sigma) + 1: 121 at sigma 40.
const core = (sigma, m) => `pad=w=iw+${2 * m}:h=ih+${2 * m}:x=${m}:y=${m}:color=black@0,gblur=sigma=${sigma}:steps=3,`
  + `unpremultiply=inplace=1,crop=w=iw-${2 * m}:h=ih-${2 * m}:x=${m}:y=${m}`

test('no blur, 0, or not a number: no step', () => {
  assert.equal(blurFilterStep({}, O), '')
  assert.equal(blurFilterStep({ blur: 0 }, O), '')
  assert.equal(blurFilterStep({ blur: '40' }, O), '')
})

test('opaque: a transparent margin, gblur on every plane, unpremultiply, cropped, alpha dropped', () => {
  assert.equal(BLUR_STEPS, 3)
  assert.equal(blurFilterStep({ blur: 40 }, O), `format=yuva444p,${core('40.0000', 121)},format=yuv444p`)
  assert.equal(blurFilterStep({ blur: 40 }, { ...O, format: 'yuva444p10le' }),
    `format=yuva444p10le,${core('40.0000', 121)},format=yuv444p10le`)
})

test('the sigma is design pixels on the 1080 short edge, scaled to the canvas, held to 200', () => {
  assert.ok(blurFilterStep({ blur: 40 }, { ...O, vw: 2160, vh: 3840 }).includes(core('80.0000', 241)))
  assert.ok(blurFilterStep({ blur: 40 }, { ...O, vw: 1920, vh: 1080 }).includes(core('40.0000', 121)))
  assert.ok(blurFilterStep({ blur: 500 }, O).includes(core('200.0000', 601)))
})

test('a per-axis unit gives sigmaV, and the margin covers the larger', () => {
  assert.ok(blurFilterStep({ blur: 40 }, { ...O, unitX: 0.25, unitY: 0.5 })
    .includes('pad=w=iw+122:h=ih+122:x=61:y=61:color=black@0,gblur=sigma=10.0000:sigmaV=20.0000:steps=3,'))
})

test('alpha: the original alpha is put back with mergeplanes, the blurred frame first', () => {
  assert.equal(blurFilterStep({ blur: 40 }, { ...O, format: 'gbrap', alpha: true }),
    `format=gbrap,split=2[bl3a][bl3b];[bl3b]${core('40.0000', 121)}[bl3c];`
    + '[bl3c][bl3a]mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=3:format=gbrap')
})

test('the formats: 16-bit 4:4:4 with alpha', () => {
  assert.equal(VIDEO_BLUR_FORMAT, 'yuva444p16le')
  assert.equal(IMAGE_BLUR_FORMAT, 'gbrap16le')
})

test('an animated box: the sigma follows peak / box per frame, through sendcmd; the margin covers the largest', () => {
  // scale 0.5 -> 1 over 1 s: the peak box is the full canvas, so at t=0 the
  // blur on it is twice the design sigma (the box is shown at half size).
  const item = { blur: 10, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] }] }
  const step = blurFilterStep(item, { ...O,
    animated: { kind: 'image', peakW: 1080, peakH: 1920, offset: 0, duration: 1, fps: 10 } })
  assert.match(step, /pad=w=iw\+122:h=ih\+122:x=61:y=61:color=black@0,sendcmd=c='0\.100000 gblur@bl3 sigma [\d.]+,gblur@bl3 sigmaV [\d.]+;/)
  assert.match(step, /,gblur@bl3=sigma=20\.0000:sigmaV=20\.0000:steps=3,unpremultiply/)
  assert.match(step, /1\.000000 gblur@bl3 sigma 10\.0000,gblur@bl3 sigmaV 10\.0000'/)
})

test('a pop-in from a tiny box: the sigma is capped at a third of the longer side, so the margin stays under the picture', () => {
  // scale 0.01 -> 1 with blur 20 on 1080x1920: uncapped, peak / box would send
  // the sigma to gblur's 1024 and the margin to 3073 px on every side.
  const item = { blur: 20, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.01 }, { t: 0.5, value: 1 }] }] }
  const step = blurFilterStep(item, { ...O,
    animated: { kind: 'image', peakW: 1080, peakH: 1920, offset: 0, duration: 0.5, fps: 30 } })
  const m = Number(/pad=w=iw\+(\d+)/.exec(step)[1]) / 2
  assert.ok(m <= 1920, `margin ${m}`)
  assert.match(step, /gblur@bl3=sigma=639\.6667:sigmaV=639\.6667:steps=3/)
  for (const v of step.matchAll(/sigma(?:V)? ([\d.]+)/g)) assert.ok(Number(v[1]) <= 639.67, v[0])
})

// ── Linear ──────────────────────────────────────────────────────────────────

const lin = (angle, over = {}) => ({ blur: 40, blurType: 'linear', blurAngle: angle, ...over })

test('uniform, or a blurType that is not linear, is the even blur, byte for byte', () => {
  const even = blurFilterStep({ blur: 40 }, O)
  assert.equal(blurFilterStep({ blur: 40, blurType: 'uniform', blurAngle: 30 }, O), even)
  assert.equal(blurFilterStep({ blur: 40, blurType: 'Linear', blurAngle: 30 }, O), even)
  assert.equal(blurFilterStep({ blur: 0, blurType: 'linear', blurAngle: 30 }, O), '')
})

test('linear at 0 and 90: gblur on its own axis, the margin along it only, no turn', () => {
  assert.equal(blurFilterStep(lin(0), O), 'format=yuva444p,pad=w=iw+242:h=ih:x=121:y=0:color=black@0,'
    + 'gblur=sigma=40.0000:sigmaV=0:steps=3,unpremultiply=inplace=1,crop=w=iw-242:h=ih:x=121:y=0,format=yuv444p')
  assert.equal(blurFilterStep(lin(180), O), blurFilterStep(lin(0), O))
  assert.equal(blurFilterStep(lin(90), O), 'format=yuva444p,pad=w=iw:h=ih+242:x=0:y=121:color=black@0,'
    + 'gblur=sigma=0:sigmaV=40.0000:steps=3,unpremultiply=inplace=1,crop=w=iw:h=ih-242:x=0:y=121,format=yuv444p')
  assert.equal(blurFilterStep(lin(-90), O), blurFilterStep(lin(90), O))
})

test('linear at an angle: turned by -angle into a larger transparent canvas, blurred along x, turned back onto its own size', () => {
  // A 1080x1920 picture at 30 degrees spans 1895 x 2203 turned: +2 slack, +121 margin across.
  const step = blurFilterStep(lin(30), { ...O, format: 'yuva444p16le', picture: { w: 1080, h: 1920, exact: true } })
  assert.equal(step, 'format=yuva444p16le,pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0,rotate=a=-0.523598776:ow=iw+1062:oh=ih+288:c=black@0,'
    + 'gblur=sigma=40.0000:sigmaV=0:steps=3,rotate=a=0.523598776:ow=iw-1062:oh=ih-288:c=black@0,'
    + 'unpremultiply=inplace=1,crop=w=iw-4:h=ih-4:x=2:y=2,format=yuv444p16le')
  // -30 is 150: turned the other way.
  assert.match(blurFilterStep(lin(-30), { ...O, format: 'yuva444p16le' }), /rotate=a=-2\.617993878:.*rotate=a=2\.617993878:/)
})

test('linear: a picture only known by its box gets the canvas any picture in it needs', () => {
  // Contain-fitted in 1080x1920: as thin as you like one way, so 1920 sin across and 1080 sin down.
  const step = blurFilterStep(lin(30), { ...O, format: 'yuva444p16le', picture: { w: 1080, h: 1920 } })
  assert.match(step, /rotate=a=-0\.523598776:ow=iw\+1206:oh=ih\+544:/)
  assert.match(step, /rotate=a=0\.523598776:ow=iw-1206:oh=ih-544:/)
})

test('linear: an image format rotate cannot take blurs in yuva444p16le, alpha put back the same way', () => {
  const step = blurFilterStep(lin(30), { ...O, format: IMAGE_BLUR_FORMAT, alpha: true, picture: { w: 1080, h: 1920, exact: true } })
  assert.ok(step.startsWith('format=yuva444p16le,split=2[bl3a][bl3b];[bl3b]pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0,rotate=a=-0.523598776:'), step)
  assert.ok(step.endsWith('[bl3c][bl3a]mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=3:format=yuva444p16le'), step)
  // At 0 there is no turn, so the image keeps its own format.
  assert.ok(blurFilterStep(lin(0), { ...O, format: IMAGE_BLUR_FORMAT, alpha: true }).startsWith('format=gbrap16le,split=2'))
})

test('linear before an upscale: the direction and sigma are the canvas\'s mapped onto the footage', () => {
  // Footage at a quarter across and half down: 45 degrees on the canvas is
  // atan(0.5 / 0.25) on the footage, the sigma 40 * |(0.25, 0.5)| / sqrt 2.
  const step = blurFilterStep(lin(45), { ...O, format: 'yuva444p16le', unitX: 0.25, unitY: 0.5, picture: { w: 270, h: 960, exact: true } })
  const a = Math.atan2(0.5, 0.25).toFixed(9)
  assert.ok(step.includes(`rotate=a=-${a}:`), step)
  assert.ok(step.includes(`gblur=sigma=${(40 * Math.hypot(0.25, 0.5) / Math.SQRT2).toFixed(4)}:sigmaV=0:steps=3`), step)
  // Even units keep the angle; 0 and 90 stay on their axis.
  assert.ok(blurFilterStep(lin(30), { ...O, unitX: 0.5, unitY: 0.5 }).includes('rotate=a=-0.523598776:'))
  assert.ok(blurFilterStep(lin(90), { ...O, unitX: 0.25, unitY: 0.5 }).includes('gblur=sigma=0:sigmaV=20.0000:steps=3'))
})

test('linear on an animated box: the sigma along the blur follows peak / box through sendcmd', () => {
  const item = lin(30, { blur: 10, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] }] })
  const step = blurFilterStep(item, { ...O, format: 'yuva444p16le', picture: { w: 1080, h: 1920, exact: true },
    animated: { kind: 'image', peakW: 1080, peakH: 1920, offset: 0, duration: 1, fps: 10 } })
  assert.match(step, /rotate=a=-0\.523598776:ow=iw\+\d+:oh=ih\+\d+:c=black@0,sendcmd=c='0\.100000 gblur@bl3 sigma [\d.]+;/)
  assert.match(step, /,gblur@bl3=sigma=20\.0000:sigmaV=0:steps=3,rotate=a=0\.523598776:/)
  assert.match(step, /1\.000000 gblur@bl3 sigma 10\.0000'/)
  assert.ok(!step.includes('sigmaV 1'), step)
  const v = blurFilterStep(lin(90, { blur: 10, keyframes: item.keyframes }), { ...O,
    animated: { kind: 'image', peakW: 1080, peakH: 1920, offset: 0, duration: 1, fps: 10 } })
  assert.match(v, /1\.000000 gblur@bl3 sigmaV 10\.0000'/)
})

// ── Placement in the export graph ───────────────────────────────────────────

const video = (over = {}) => ({ type: 'video', src: '/clip.mp4', start: 0, end: 2, inPoint: 0, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, ...over })
const image = (over = {}) => ({ type: 'image', src: '/still.png', start: 0, end: 2, trackIdx: 1,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, ...over })
const vOpts = { segStart: 0, duration: 2, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true }
const graphOf = (r) => r.filterParts.join(';')
// The opaque video blur, whatever its sigma and margin.
const VIDEO_BLUR = /format=yuva444p16le,pad=w=[^;]*?unpremultiply=inplace=1,crop=[^,]*,format=yuv444p16le,/

test('video: without a blur the graph is unchanged; with one, only the blur step is added', () => {
  for (const over of [{}, { probedWidth: 960, probedHeight: 540, scale: 3.2 }, { scale: 0.5, rotation: 20 }]) {
    const plain = graphOf(buildVideoItemFilterParts(video(over), 1080, 1920, 1, '[canvas]', vOpts))
    const off = graphOf(buildVideoItemFilterParts(video({ ...over, blur: 0 }), 1080, 1920, 1, '[canvas]', vOpts))
    assert.equal(off, plain)
    const on = graphOf(buildVideoItemFilterParts(video({ ...over, blur: 40 }), 1080, 1920, 1, '[canvas]', vOpts))
    assert.equal(on.replace(VIDEO_BLUR, ''), plain, JSON.stringify(over))
  }
})

test('video: the blur runs after the scale and before the pad (unknown footage size)', () => {
  const g = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2 }), 1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(g.includes(`scale=3456:6144:force_original_aspect_ratio=decrease,format=yuva444p16le,${core('40.0000', 121)},format=yuv444p16le,pad=3456:6144:`), g)
})

test('video: an upscale of known footage blurs the footage before the scale, at the scaled-down sigma', () => {
  const g = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2, probedWidth: 960, probedHeight: 540 }),
    1080, 1920, 1, '[canvas]', vOpts))
  // 960 -> 3456: sigma 40 on the box is 40 * 960 / 3456 on the footage.
  assert.ok(g.includes(`setpts=PTS-STARTPTS,format=yuva444p16le,${core('11.1111', 35)},format=yuv444p16le,scale=3456:6144:`), g)
  assert.ok(g.includes('color=black@0.0[vid1]'), g)
})

test('video: a downscale, a tiny footage-side sigma, or a colour conversion blurs after the scale', () => {
  const down = graphOf(buildVideoItemFilterParts(video({ blur: 40, probedWidth: 3840, probedHeight: 2160 }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(down.includes(`decrease,format=yuva444p16le,${core('40.0000', 121)},`), down)
  const tiny = graphOf(buildVideoItemFilterParts(video({ blur: 4, scale: 3.2, probedWidth: 960, probedHeight: 540 }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(tiny.includes(`decrease,format=yuva444p16le,${core('4.0000', 13)},`), tiny)
  const hdr = graphOf(buildVideoItemFilterParts(video({ blur: 40, scale: 3.2, probedWidth: 960, probedHeight: 540,
    colorTransfer: 'arib-std-b67' }), 1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(/zscale[^;]*,format=yuva444p16le,pad=w=iw\+242[^;]*gblur=sigma=40\.0000:steps=3,/.test(hdr), hdr)
  assert.ok(!hdr.includes('setpts=PTS-STARTPTS,format=yuva444p16le'), hdr)
})

test('video: an HDR canvas blurs in 16 bits too; a clip with alpha gets its alpha back', () => {
  const hdr = graphOf(buildVideoItemFilterParts(video({ blur: 40 }), 1080, 1920, 1, '[canvas]',
    { ...vOpts, projectColorSpace: 'hdr_hlg' }))
  assert.ok(hdr.includes('format=yuva444p16le,pad=w='), hdr)
  assert.ok(hdr.includes(',format=yuv444p16le,pad=1080:1920:'), hdr)
  const alpha = graphOf(buildVideoItemFilterParts(video({ blur: 40, src: '/cut.mov', probedAlpha: true }),
    1080, 1920, 1, '[canvas]', vOpts))
  assert.ok(alpha.includes('format=yuva444p16le,split=2[bl1a][bl1b];[bl1b]pad=w='), alpha)
  assert.ok(alpha.includes('[bl1c][bl1a]mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=3:format=yuva444p16le,'), alpha)
})

test('video: a mask comes after the blur', () => {
  const r = buildVideoItemFilterParts(video({ blur: 40, scale: 0.5, mask: { shape: 'ellipse' } }), 1080, 1920, 1, '[canvas]',
    { ...vOpts, maskBase: '/tmp/x/m' })
  const g = graphOf(r)
  assert.ok(g.indexOf('gblur=') < g.indexOf('alphaextract'), g)
})

// ── Spin and zoom ───────────────────────────────────────────────────────────
// Per pass of radialBlurPlan: split into N copies, each moved about the centre
// by perspective (in 8 bits: it takes nothing deeper), back to 16 bits, mixed
// with the plan's weights; then unpremultiplied, and where every tap fell
// outside the picture the source shows (maskedmerge on the colour planes, so
// the alpha is the clip's own). Real-ffmpeg parity against the reference
// sampler is test/item-blur-radial.test.mjs.

const radial = (blurType, over = {}) => ({ blur: blurType === 'spin' ? 30 : 40, blurType, blurX: 0.5, blurY: 0.4, ...over })
const PIC = { picture: { w: 1080, h: 1920, exact: true }, box: { w: 1080, h: 1920 } }
const perspectives = (step) => [...step.matchAll(/perspective=([^,\[]*)/g)].map((m) =>
  Object.fromEntries(m[1].split(':').map((kv) => kv.split('='))))

test('spin and zoom: no amount is no step; uniform and linear are untouched by blurX and blurY', () => {
  for (const t of ['spin', 'zoom']) assert.equal(blurFilterStep(radial(t, { blur: 0 }), { ...O, ...PIC }), '')
  assert.equal(blurFilterStep({ blur: 40, blurX: 0.1, blurY: 0.9 }, O), blurFilterStep({ blur: 40 }, O))
  assert.equal(blurFilterStep(lin(30, { blurX: 0.1 }), O), blurFilterStep(lin(30), O))
})

test('spin and zoom: per pass, split, perspective in 8 bits, back to 16, mix with the plan\'s weights; then unpremultiply and the fallback', () => {
  for (const t of ['spin', 'zoom']) {
    const step = blurFilterStep(radial(t), { ...O, format: 'yuva444p16le', ...PIC })
    const plan = radialBlurPlan({ type: t, amount: radial(t).blur, center: [540, 768], rect: { w: 1080, h: 1920 } })
    assert.ok(plan.passes.length >= 2, `${t}: ${plan.passes.length} passes`)
    assert.ok(step.startsWith('format=yuva444p16le,split=2[bl3s][bl3w];[bl3w]premultiply=inplace=1,setparams=alpha_mode=straight,'
      + 'pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0,format=yuva444p,split='), step.slice(0, 300))
    assert.equal(perspectives(step).length, plan.passes.reduce((n, p) => n + p.taps.length, 0))
    const mixes = [...step.matchAll(/mix=inputs=(\d+):weights='([^']*)'/g)]
    assert.equal(mixes.length, plan.passes.length)
    mixes.forEach((m, k) => {
      assert.equal(Number(m[1]), plan.passes[k].taps.length)
      m[2].split(' ').forEach((w, j) => assert.ok(Math.abs(Number(w) - plan.passes[k].taps[j].weight) < 1e-6, `${t} pass ${k} tap ${j}`))
    })
    // Every copy back to 16 bits before the mix; the margin cleared between passes.
    assert.equal((step.match(/,format=yuva444p16le\[bl3r/g) ?? []).length, perspectives(step).length)
    assert.equal((step.match(/crop=w=iw-4:h=ih-4:x=2:y=2,pad=w=iw\+4/g) ?? []).length, plan.passes.length - 1)
    assert.ok(step.endsWith('setparams=alpha_mode=premultiplied,unpremultiply=inplace=1,crop=w=iw-4:h=ih-4:x=2:y=2[bl3u];'
      + "[bl3u]split=2[bl3k][bl3m];[bl3m]lut=c3='min(val*16,maxval)',"
      + 'mergeplanes=map0s=0:map0p=3:map1s=0:map1p=3:map2s=0:map2p=3:map3s=0:map3p=3:format=yuva444p16le[bl3n];[bl3s][bl3k][bl3n]maskedmerge=planes=7,'
      + 'format=yuv444p16le'), step.slice(-600))
    // With alpha: the maskedmerge's alpha is the source's, so nothing follows it.
    const a = blurFilterStep(radial(t), { ...O, format: IMAGE_BLUR_FORMAT, alpha: true, ...PIC })
    assert.ok(a.endsWith('[bl3s][bl3k][bl3n]maskedmerge=planes=7') && a.includes(',format=gbrap,split='), a.slice(-200))
  }
})

test('spin and zoom: each tap\'s corners are its inverse map about the centre, in perspective\'s pixel-index coordinates', () => {
  // A 100x60 picture (104x64 with its margin), centre (0.25, 0.5) of the box:
  // (25, 30) in picture pixels, (26.5, 31.5) in the margin's index coordinates.
  const o = { ...O, picture: { w: 100, h: 60, exact: true }, box: { w: 100, h: 60 } }
  for (const t of ['spin', 'zoom']) {
    const item = radial(t, { blur: t === 'spin' ? 4 : 4, blurX: 0.25, blurY: 0.5 })
    const plan = radialBlurPlan({ type: t, amount: item.blur, center: [25, 30], rect: { w: 100, h: 60 } })
    const ps = perspectives(blurFilterStep(item, o))
    plan.passes.flatMap((p) => p.taps).forEach((tap, i) => {
      const [a, b] = radialTapInverse(t, tap.offset)
      const [cx, cy] = [26.5, 31.5]
      ;[[0, 0], [104, 0], [0, 64], [104, 64]].forEach(([qx, qy], k) => {
        const x = cx + a * (qx - cx) - b * (qy - cy)
        const y = cy + b * (qx - cx) + a * (qy - cy)
        assert.ok(Math.abs(Number(ps[i][`x${k}`]) - x) < 1e-5 && Math.abs(Number(ps[i][`y${k}`]) - y) < 1e-5,
          `${t} tap ${i} corner ${k}: ${ps[i][`x${k}`]},${ps[i][`y${k}`]} vs ${x},${y}`)
      })
    })
  }
})

test('spin and zoom: a picture only known by its box is planned on the box and placed by W and H', () => {
  const step = blurFilterStep(radial('zoom'), { ...O, picture: { w: 1080, h: 1920 }, box: { w: 1080, h: 1920 } })
  const p = perspectives(step)[0]
  for (const k of ['x0', 'y0', 'x3', 'y3']) assert.match(p[k], /W|H/, `${k}=${p[k]}`)
  // The centre's place from the box's middle: W/2 + (0.5 - 0.5) * 1080 - 0.5 across, H/2 + (0.4 - 0.5) * 1920 - 0.5 down.
  const at = (e, W, H) => Function('W', 'H', `return ${e}`)(W, H)
  const [s] = radialBlurPlan({ type: 'zoom', amount: 40, center: [540, 768], rect: { w: 1080, h: 1920 } }).passes[0].taps.map((t) => t.offset)
  for (const [W, H] of [[1084, 1924], [1084, 612]]) {
    const cx = W / 2 - 0.5
    const cy = H / 2 - 192 - 0.5
    assert.ok(Math.abs(at(p.x0, W, H) - (cx - cx / s)) < 1e-3 && Math.abs(at(p.y3, W, H) - (cy + (H - cy) / s)) < 1e-3, `${W}x${H}`)
  }
  // The same centre and plan as an exact picture of the box's own size.
  assert.equal(perspectives(blurFilterStep(radial('zoom'), { ...O, ...PIC })).length, perspectives(step).length)
})

test('spin and zoom: an animated box needs nothing per frame (degrees and percent do not change with its size)', () => {
  const item = radial('spin', { keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] }] })
  const step = blurFilterStep(item, { ...O, ...PIC, animated: { kind: 'image', peakW: 1080, peakH: 1920, offset: 0, duration: 1, fps: 10 } })
  assert.equal(step, blurFilterStep(radial('spin'), { ...O, ...PIC }))
  assert.ok(!step.includes('sendcmd'))
})

test('spin and zoom on video: before an upscale of known footage, in footage pixels with fewer taps; else after the scale', () => {
  const g = (over) => graphOf(buildVideoItemFilterParts(video({ scale: 3.2, ...over }), 1080, 1920, 1, '[canvas]', vOpts))
  for (const t of ['spin', 'zoom']) {
    const pre = g({ ...radial(t), probedWidth: 960, probedHeight: 540 })
    assert.ok(pre.includes('setpts=PTS-STARTPTS,format=yuva444p16le,split=2[bl1s][bl1w];'), t)
    assert.ok(pre.includes('maskedmerge=planes=7,format=yuv444p16le,scale=3456:6144:'), t)
    // Without the size: after the scale, planned on the box and placed by W and H.
    const post = g(radial(t))
    assert.ok(post.includes('decrease,format=yuva444p16le,split=2[bl1s][bl1w];') && /perspective=x0=[^:]*W/.test(post), t)
    assert.ok(perspectives(pre).length < perspectives(post).length, `${t}: ${perspectives(pre).length} vs ${perspectives(post).length}`)
    // The pre-scale plan: the footage, 960x540, in a 3456x6144 box, the centre at (0.5, 0.4) of the box.
    const rect = pictureRectInBox(3456, 6144, 960, 540)
    const plan = radialBlurPlan({ type: t, amount: radial(t).blur,
      center: [(0.5 - rect.x) / rect.w * 960, (0.4 - rect.y) / rect.h * 540], rect: { w: 960, h: 540 } })
    assert.equal(perspectives(pre).length, plan.passes.reduce((n, p) => n + p.taps.length, 0), t)
    // A tiny amount still runs before the scale (no sigma threshold for these).
    assert.ok(g({ ...radial(t, { blur: 1 }), probedWidth: 960, probedHeight: 540 }).includes('setpts=PTS-STARTPTS,format=yuva444p16le,split=2[bl1s]'), t)
  }
  // Without spin or zoom the graphs are what they were (the uniform blur's pre-scale threshold holds).
  assert.ok(g({ blur: 4, probedWidth: 960, probedHeight: 540, blurX: 0.1 }).includes('decrease,format=yuva444p16le,pad=w='))
})

test('spin and zoom on a still image: blurred once and looped; an image\'s alpha is its own', () => {
  for (const fit of ['cover', 'contain']) {
    const g = graphOf(buildImageItemFilterParts(image({ fit, ...radial('zoom') }), 1080, 1920, 1, '[canvas]', 2, 0))
    assert.ok(g.startsWith('[1:v]trim=end_frame=1,scale='), g.slice(0, 80))
    assert.ok(g.indexOf('maskedmerge=planes=7,format=rgba') < g.indexOf(ONCE), fit)
    assert.ok(g.includes(',format=gbrap16le,split=2[bl1s][bl1w];'), fit)
    // cover: the box is the picture (numbers); contain: placed by W and H.
    assert.equal(/perspective=x0=[^:]*W/.test(g), fit === 'contain', fit)
  }
})

// The image blur: planar RGB with the image's alpha put back, then RGBA again.
const IMAGE_BLUR = /,format=gbrap16le,split=2\[bl1a\]\[bl1b\];\[bl1b\]pad=w=[^;]*\[bl1c\];\[bl1c\]\[bl1a\]mergeplanes=[^,]*:format=gbrap16le,format=rgba/

// A still's blur runs once: one frame in, replayed by `loop` for the duration.
const ONCE = ',loop=loop=-1:size=1,setpts=N/FRAME_RATE/TB,trim=duration=2'

test('image: a blur on a still box runs on one frame and is looped; an animated box or crop keeps the per-frame blur', () => {
  const g = (item) => graphOf(buildImageItemFilterParts(item, 1080, 1920, 1, '[canvas]', 2, 0))
  const still = g(image({ blur: 20 }))
  assert.ok(still.startsWith('[1:v]trim=end_frame=1,scale='), still)
  assert.ok(still.includes(ONCE + ','), still)
  assert.ok(still.indexOf('gblur') < still.indexOf('loop=loop'), 'the loop comes after the blur')
  assert.ok(!g(image()).includes('loop='), 'no blur: no loop')
  const grow = g(image({ blur: 20, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] }] }))
  assert.ok(!grow.includes('loop=') && !grow.includes('trim=end_frame'), grow)
})

test('image: without a blur unchanged; cover and fill blur the fitted box, contain blurs before its pad', () => {
  for (const fit of ['cover', 'contain', 'fill']) {
    const plain = graphOf(buildImageItemFilterParts(image({ fit }), 1080, 1920, 1, '[canvas]', 2, 0))
    assert.equal(graphOf(buildImageItemFilterParts(image({ fit, blur: 0 }), 1080, 1920, 1, '[canvas]', 2, 0)), plain)
    const on = graphOf(buildImageItemFilterParts(image({ fit, blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
      .replace('[1:v]trim=end_frame=1,', '[1:v]').replace(ONCE, '')
    assert.ok(IMAGE_BLUR.test(on), on)
    assert.equal(on.replace(IMAGE_BLUR, (m) => (fit === 'contain' ? ',' : '')).replace('format=rgba,,pad', 'format=rgba,pad'), plain, fit)
  }
  const contain = graphOf(buildImageItemFilterParts(image({ fit: 'contain', blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
    .replace('[1:v]trim=end_frame=1,', '[1:v]').replace(ONCE, '')
  assert.ok(/decrease,format=rgba,format=gbrap16le,split=2[^;]*;[^;]*;[^;]*format=gbrap16le,format=rgba,pad=1080:1920:/.test(contain), contain)
  const cover = graphOf(buildImageItemFilterParts(image({ blur: 20 }), 1080, 1920, 1, '[canvas]', 2, 0))
    .replace('[1:v]trim=end_frame=1,', '[1:v]').replace(ONCE, '')
  assert.ok(cover.includes('crop=1080:1920,format=rgba,format=gbrap16le,split=2[bl1a][bl1b];'), cover)
})

// ── Real ffmpeg ─────────────────────────────────────────────────────────────
// A blurred clip that fills the frame keeps opaque edges: a solid red clip,
// blurred, is the same red everywhere. Read past its edges as transparent (or
// black) and the frame's border would darken toward the black canvas. The
// 16:9 clip is scaled to overhang the 9:16 frame by a few rows: a 4:2:0 pad
// rounds its offset to even rows, so an overhang under ~2 rows leaves a black
// row with or without a blur.

const W = 108
const H = 192
const RED = [192, 64, 32]

function makeSolid(dir, name, size, ext) {
  const out = join(dir, `${name}.${ext}`)
  const c = '0x' + RED.map(v => v.toString(16).padStart(2, '0')).join('')
  const args = ext === 'png'
    ? ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=${size}`, '-frames:v', '1', out]
    : ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=${size}:r=30:d=1`, '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-crf', '0', out]
  const r = spawnSync(FFMPEG, args)
  assert.equal(r.status, 0, String(r.stderr))
  return out
}

function frameRgb(file, at = 0.1) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24', '-f', 'rawvideo', '-'])
  assert.equal(r.status, 0, String(r.stderr))
  return r.stdout
}

const px = (buf, x, y) => [buf[(y * W + x) * 3], buf[(y * W + x) * 3 + 1], buf[(y * W + x) * 3 + 2]]
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

async function render(dir, items, name) {
  const out = join(dir, `${name}.mp4`)
  await encodeSegment({ start: 0, end: 0.4, vw: W, vh: H, fps: 30, overlays: [], items }, out)
  return frameRgb(out)
}

test('real ffmpeg: a blurred full-frame clip stays opaque to every edge (pre- and post-scale, animated)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const clip = makeSolid(dir, 'red', '96x54', 'mp4')
    const base = { type: 'video', src: clip, start: 0, end: 0.4, inPoint: 0, trackIdx: 0, offsetX: 0, offsetY: 0,
      opacity: 1, muted: true, scale: 3.4, blur: 120 }
    const cases = {
      post: base,                                          // footage size unknown: blur after the scale
      pre: { ...base, probedWidth: 96, probedHeight: 54 }, // upscale of known footage: blur before it
      animated: { ...base, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 3.4 }, { t: 0.4, value: 3.8 }] }] },
    }
    for (const [name, item] of Object.entries(cases)) {
      const f = await render(dir, [item], name)
      for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, 0], [W / 2, H - 1], [0, H / 2], [W / 2, H / 2]]) {
        assert.ok(near(px(f, x, y), RED, 6), `${name} (${x},${y}): ${px(f, x, y)}`)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: a contain image keeps a hard, opaque picture edge; the pad stays transparent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const still = makeSolid(dir, 'red', '160x90', 'png')
    // 16:9 contain in the 9:16 frame: a band 108 x ~61 rows, centred (rows ~65..126).
    const f = await render(dir, [{ type: 'image', src: still, start: 0, end: 0.4, trackIdx: 1, fit: 'contain',
      scale: 1, offsetX: 0, offsetY: 0, opacity: 1, blur: 120 }], 'contain')
    assert.ok(near(px(f, W / 2, H / 2), RED, 6), `centre ${px(f, W / 2, H / 2)}`)
    assert.ok(near(px(f, 0, 68), RED, 8), `band edge ${px(f, 0, 68)}`)
    assert.ok(near(px(f, W / 2, 68), RED, 8), `band top ${px(f, W / 2, 68)}`)
    assert.ok(near(px(f, W / 2, 30), [0, 0, 0], 4), `pad ${px(f, W / 2, 30)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: an image keeps its own transparency; the blur never fills a hole or softens its edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    // A red image whose right half is transparent, over the black canvas.
    const still = join(dir, 'hole.png')
    const g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xc04020:s=${W}x${H}`,
      '-vf', `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gte(X,${W / 2}),0,255)'`, '-frames:v', '1', still])
    assert.equal(g.status, 0, String(g.stderr))
    const f = await render(dir, [{ type: 'image', src: still, start: 0, end: 0.4, trackIdx: 1,
      scale: 1, offsetX: 0, offsetY: 0, opacity: 1, blur: 120 }], 'hole')
    assert.ok(near(px(f, W / 2 - 2, H / 2), RED, 8), `left of the hole's edge stays red: ${px(f, W / 2 - 2, H / 2)}`)
    assert.ok(near(px(f, 0, 0), RED, 8), `corner: ${px(f, 0, 0)}`)
    assert.ok(near(px(f, W / 2 + 2, H / 2), [0, 0, 0], 6), `the hole stays clear: ${px(f, W / 2 + 2, H / 2)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// A clip whose transparent pixels are WHITE (straight alpha: ProRes 4444 and
// PNG keep whatever colour sits under alpha 0). The blur must not bleed that
// white into the opaque side. item-blur.js relies on ffmpeg's implicit
// straight -> premultiplied conversion before `unpremultiply` (measured on
// 8.1); a build that skipped it would blur the white in and show a halo here.
test('real ffmpeg: transparent white under a clip\'s alpha does not halo the opaque side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const vf = `format=rgba,geq=r='if(gte(X,${W / 2}),255,192)':g='if(gte(X,${W / 2}),255,64)':b='if(gte(X,${W / 2}),255,32)':a='if(gte(X,${W / 2}),0,255)'`
    const png = join(dir, 'white.png')
    let g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xc04020:s=${W}x${H}`, '-vf', vf, '-frames:v', '1', png])
    assert.equal(g.status, 0, String(g.stderr))
    const mov = join(dir, 'white.mov')
    g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xc04020:s=${W}x${H}:r=30:d=1`,
      '-vf', vf + ',format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', mov])
    assert.equal(g.status, 0, String(g.stderr))
    const items = {
      png: { type: 'image', src: png, start: 0, end: 0.4, trackIdx: 1, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, blur: 120 },
      prores: { type: 'video', src: mov, start: 0, end: 0.4, inPoint: 0, trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0,
        opacity: 1, muted: true, blur: 120, probedWidth: W, probedHeight: H, probedAlpha: true },
    }
    for (const [name, item] of Object.entries(items)) {
      const f = await render(dir, [item], name)
      assert.ok(near(px(f, W / 2 - 3, H / 2), RED, 12), `${name}: opaque side at the edge stays red: ${px(f, W / 2 - 3, H / 2)}`)
      assert.ok(near(px(f, W / 2 + 3, H / 2), [0, 0, 0], 8), `${name}: the transparent side stays clear: ${px(f, W / 2 + 3, H / 2)}`)
      assert.ok(near(px(f, 0, H / 2), RED, 12), `${name}: far side: ${px(f, 0, H / 2)}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── Real ffmpeg: linear ─────────────────────────────────────────────────────

test('real ffmpeg: a linear blur at an angle keeps a full-frame clip opaque to every edge (pre- and post-scale, animated)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const clip = makeSolid(dir, 'red', '96x54', 'mp4')
    const base = { type: 'video', src: clip, start: 0, end: 0.4, inPoint: 0, trackIdx: 0, offsetX: 0, offsetY: 0,
      opacity: 1, muted: true, scale: 3.4, blur: 120, blurType: 'linear', blurAngle: 30 }
    const cases = {
      post: base,
      pre: { ...base, probedWidth: 96, probedHeight: 54, blurAngle: 135 },
      animated: { ...base, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 3.4 }, { t: 0.4, value: 3.8 }] }] },
      axis: { ...base, blurAngle: 90 },
    }
    for (const [name, item] of Object.entries(cases)) {
      const f = await render(dir, [item], name)
      for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, 0], [W / 2, H - 1], [0, H / 2], [W / 2, H / 2]]) {
        assert.ok(near(px(f, x, y), RED, 6), `${name} (${x},${y}): ${px(f, x, y)}`)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: transparent white under a clip\'s alpha does not halo through a linear blur either', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const png = join(dir, 'white.png')
    const vf = `format=rgba,geq=r='if(gte(X,${W / 2}),255,192)':g='if(gte(X,${W / 2}),255,64)':b='if(gte(X,${W / 2}),255,32)':a='if(gte(X,${W / 2}),0,255)'`
    const g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xc04020:s=${W}x${H}`, '-vf', vf, '-frames:v', '1', png])
    assert.equal(g.status, 0, String(g.stderr))
    for (const angle of [0, 30]) {
      const f = await render(dir, [{ type: 'image', src: png, start: 0, end: 0.4, trackIdx: 1, scale: 1, offsetX: 0, offsetY: 0,
        opacity: 1, blur: 120, blurType: 'linear', blurAngle: angle }], `white${angle}`)
      assert.ok(near(px(f, W / 2 - 3, H / 2), RED, 12), `${angle}: opaque side at the edge stays red: ${px(f, W / 2 - 3, H / 2)}`)
      assert.ok(near(px(f, W / 2 + 3, H / 2), [0, 0, 0], 8), `${angle}: the transparent side stays clear: ${px(f, W / 2 + 3, H / 2)}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The streak's direction: a small white square on grey, blurred, spreads along
// the angle (clockwise from x on screen, y down) and not across it. Read from
// the second moments of what the blur moved.
test('real ffmpeg: a linear blur streaks along its angle, clockwise from x, and not across it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const S = 160
    const pic = join(dir, 'dot.png')
    const g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x808080:s=${S}x${S}`, '-vf',
      `format=rgb24,geq=r='if(lt(abs(X-${S / 2}+0.5),3)*lt(abs(Y-${S / 2}+0.5),3),255,128)':g='if(lt(abs(X-${S / 2}+0.5),3)*lt(abs(Y-${S / 2}+0.5),3),255,128)':b='if(lt(abs(X-${S / 2}+0.5),3)*lt(abs(Y-${S / 2}+0.5),3),255,128)'`,
      '-frames:v', '1', pic])
    assert.equal(g.status, 0, String(g.stderr))
    for (const angle of [0, 30, 90, 135]) {
      // blur 54 on a 160x160 canvas: sigma 8 px.
      const item = { type: 'image', src: pic, start: 0, end: 1, scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
        blur: 54, blurType: 'linear', blurAngle: angle }
      const chain = buildImageItemFilterParts(item, S, S, 0, '[canvas]', 1, 0).filterParts[0]
      const out = spawnSync(FFMPEG, ['-v', 'error', '-i', pic, '-filter_complex', chain, '-map', '[img0]', '-frames:v', '1',
        '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 })
      assert.equal(out.status, 0, String(out.stderr))
      let m = 0, mx = 0, my = 0
      const w = []
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        // Past the grey's own code and its one code of 16-bit rounding.
        const v = Math.max(0, out.stdout[y * S + x] - 129)
        if (v) { w.push([x, y, v]); m += v; mx += v * x; my += v * y }
      }
      mx /= m; my /= m
      let xx = 0, yy = 0, xy = 0
      for (const [x, y, v] of w) { xx += v * (x - mx) ** 2; yy += v * (y - my) ** 2; xy += v * (x - mx) * (y - my) }
      const theta = ((0.5 * Math.atan2(2 * xy, xx - yy) * 180) / Math.PI + 180) % 180
      const along = (xx + yy) / 2 + Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy)
      const across = (xx + yy) / 2 - Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy)
      const off = Math.min(Math.abs(theta - angle), 180 - Math.abs(theta - angle))
      assert.ok(off < 2, `${angle}: streak at ${theta.toFixed(1)} degrees`)
      assert.ok(Math.sqrt(along / m) > 6 && Math.sqrt(across / m) < 2.5,
        `${angle}: spread ${Math.sqrt(along / m).toFixed(1)} along, ${Math.sqrt(across / m).toFixed(1)} across`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── Real ffmpeg: spin and zoom ──────────────────────────────────────────────

test('real ffmpeg: spin and zoom keep a full-frame clip opaque to every edge (pre- and post-scale, animated, centre outside)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const clip = makeSolid(dir, 'red', '96x54', 'mp4')
    const base = { type: 'video', src: clip, start: 0, end: 0.4, inPoint: 0, trackIdx: 0, offsetX: 0, offsetY: 0,
      opacity: 1, muted: true, scale: 3.4 }
    const cases = {
      spinPost: { ...base, blur: 90, blurType: 'spin', blurX: 0.3, blurY: 0.2 },
      spinPre: { ...base, blur: 60, blurType: 'spin', probedWidth: 96, probedHeight: 54 },
      zoomPost: { ...base, blur: 150, blurType: 'zoom', blurX: 0.8, blurY: 0.5 },
      zoomPre: { ...base, blur: 80, blurType: 'zoom', probedWidth: 96, probedHeight: 54, blurX: -0.4, blurY: 1.3 },
      animated: { ...base, blur: 45, blurType: 'spin', keyframes: [{ prop: 'scale', points: [{ t: 0, value: 3.4 }, { t: 0.4, value: 3.8 }] }] },
    }
    // 10 codes: a 90 degree spin about an off-centre point leaves the far
    // corners thinly covered, where the 8-bit copies' rounding shows (measured 8).
    for (const [name, item] of Object.entries(cases)) {
      const f = await render(dir, [item], name)
      for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, 0], [W / 2, H - 1], [0, H / 2], [W / 2, H / 2]]) {
        assert.ok(near(px(f, x, y), RED, 10), `${name} (${x},${y}): ${px(f, x, y)}`)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: transparent white under a clip\'s alpha does not halo through a spin or zoom blur', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-'))
  try {
    const png = join(dir, 'white.png')
    const vf = `format=rgba,geq=r='if(gte(X,${W / 2}),255,192)':g='if(gte(X,${W / 2}),255,64)':b='if(gte(X,${W / 2}),255,32)':a='if(gte(X,${W / 2}),0,255)'`
    const g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xc04020:s=${W}x${H}`, '-vf', vf, '-frames:v', '1', png])
    assert.equal(g.status, 0, String(g.stderr))
    for (const [blurType, blur] of [['spin', 60], ['zoom', 100]]) {
      const f = await render(dir, [{ type: 'image', src: png, start: 0, end: 0.4, trackIdx: 1, scale: 1, offsetX: 0, offsetY: 0,
        opacity: 1, blur, blurType, blurX: 0.5, blurY: 0.5 }], `white-${blurType}`)
      assert.ok(near(px(f, W / 2 - 3, H / 2 - 30), RED, 12), `${blurType}: opaque side at the edge stays red: ${px(f, W / 2 - 3, H / 2 - 30)}`)
      assert.ok(near(px(f, W / 2 + 3, H / 2 - 30), [0, 0, 0], 8), `${blurType}: the transparent side stays clear: ${px(f, W / 2 + 3, H / 2 - 30)}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('video: a spin, zoom or linear blur on footage of unknown size warns once (planned on the box, slow); uniform and known footage do not', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const build = (over) => buildVideoItemFilterParts(video({ scale: 3.2, ...over }), 1080, 1920, 1, '[canvas]', vOpts)
  build({ id: 'u1', blur: 40 })
  build({ id: 'k1', blur: 30, blurType: 'spin', probedWidth: 960, probedHeight: 540 })
  assert.equal(warn.mock.callCount(), 0)
  build({ id: 's1', blur: 30, blurType: 'spin' })
  build({ id: 's1', blur: 30, blurType: 'spin' })
  build({ id: 'l1', blur: 40, blurType: 'linear', blurAngle: 30 })
  assert.equal(warn.mock.callCount(), 2)
  const msg = warn.mock.calls[0].arguments[0]
  assert.match(msg, /video item s1: its picture's size is unknown .*spin blur runs on the whole 3456x6144 box/)
  assert.match(warn.mock.calls[1].arguments[0], /video item l1: .*linear blur/)
})

test('image: a contain spin or zoom whose image cannot be probed warns once; a cover fit does not', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const build = (over) => buildImageItemFilterParts(image({ src: '/no/such/still.png', ...over }), 1080, 1920, 1, '[canvas]', 2, 0)
  build({ id: 'ic', fit: 'cover', blur: 30, blurType: 'zoom' })
  assert.equal(warn.mock.callCount(), 0)
  build({ id: 'ik', fit: 'contain', blur: 30, blurType: 'zoom' })
  build({ id: 'ik', fit: 'contain', blur: 30, blurType: 'zoom' })
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /image item ik: its picture's size is unknown \(the image could not be probed\), so its zoom blur/)
})
