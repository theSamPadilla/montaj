import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { blendCompositeParts } from '../item-blend.js'
import { encodeSegment } from '../encode-segment.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const base = { backdrop: '[iv3]', item: '[vidop4]', x: '10', y: '20', vw: 64, vh: 64, mode: 'screen', idx: 4,
  tenBit: false, matrix: 'bt709', canvasPixFmt: 'yuv420p', fps: 30, duration: 2, out: '[iv4]' }

// ── The parts ───────────────────────────────────────────────────────────────

test('parts: backdrop to gbrap, item placed on a transparent canvas, blended (backdrop first), back, merged by alpha, [iv4]', () => {
  const parts = blendCompositeParts(base)
  assert.deepEqual(parts, [
    // One copy of the backdrop stays in the canvas format for the merge; one
    // goes to RGB, its matrix and range named, with an opaque alpha.
    '[iv3]split=2[blk4][blb4]',
    '[blb4]scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv,format=gbrap[blg4]',
    // A transparent canvas, tagged like the real one.
    'color=c=black@0:s=64x64:r=30:d=2,format=yuva444p,setparams=colorspace=bt709:range=tv[blt4]',
    // The item placed at x/y, then to RGB.
    '[blt4][vidop4]overlay=x=10:y=20:format=yuv444:shortest=0,'
      + 'scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv,format=gbrap[blr4]',
    // The BACKDROP is blend's first input (A); the alpha plane keeps the item's.
    '[blg4][blr4]blend=c0_mode=screen:c1_mode=screen:c2_mode=screen:c3_mode=darken,'
      + 'scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuva420p[blx4]',
    // Merged by that alpha onto the untouched backdrop, in the canvas format.
    '[blk4][blx4]overlay=x=0:y=0:shortest=0[iv4]',
  ])
})

test('parts: add is ffmpeg\'s addition; every mode maps; normal is not a blend', () => {
  const ff = { screen: 'screen', multiply: 'multiply', add: 'addition', lighten: 'lighten', darken: 'darken', overlay: 'overlay' }
  for (const [mode, name] of Object.entries(ff)) {
    assert.ok(blendCompositeParts({ ...base, mode }).join(';')
      .includes(`blend=c0_mode=${name}:c1_mode=${name}:c2_mode=${name}:c3_mode=darken,`), mode)
  }
  assert.throws(() => blendCompositeParts({ ...base, mode: 'normal' }), /blend mode/)
})

test('parts: 10-bit blends in gbrap10le (placing at 8 bits), BT.2020, and keeps the overlay format it is given', () => {
  const g = blendCompositeParts({ ...base, tenBit: true, matrix: 'bt2020', canvasPixFmt: 'yuv420p10le',
    overlayFormat: ':format=yuv420' }).join(';')
  assert.ok(g.includes('format=yuva444p,setparams=colorspace=bt2020nc:range=tv[blt4]'), g)
  assert.ok(g.includes('overlay=x=10:y=20:format=yuv444:shortest=0,'))
  assert.ok(g.includes('in_range=tv,format=gbrap10le[blr4]'))
  assert.ok(g.includes('scale=in_color_matrix=bt2020:out_color_matrix=bt2020:in_range=tv,format=gbrap10le[blg4]'))
  assert.ok(g.includes('out_range=tv,format=yuva420p10le[blx4]'))
  assert.ok(g.endsWith('[blk4][blx4]overlay=x=0:y=0:format=yuv420:shortest=0[iv4]'))
})

test('parts: an animated position keeps the overlay expressions, quoted, on the placement', () => {
  const g = blendCompositeParts({ ...base, x: "'100+10*t'", y: "'20*t'" }).join(';')
  assert.ok(g.includes("[vidop4]overlay=x='100+10*t':y='20*t':format=yuv444:shortest=0,"), g)
  assert.ok(g.endsWith('[blk4][blx4]overlay=x=0:y=0:shortest=0[iv4]'))
})

// ── encodeSegment wiring ────────────────────────────────────────────────────

const SEG_OUT = '/tmp/s616/seg-0005.mp4'
const imageItem = (over = {}) => ({ type: 'image', src: '/bg.png', start: 0, end: 2, trackIdx: 0,
  scale: 0.5, offsetX: 0, offsetY: 0, opacity: 1, ...over })
const videoItem = (over = {}) => ({ type: 'video', src: '/pip.mp4', start: 0, end: 2, inPoint: 0, trackIdx: 1,
  scale: 0.5, offsetX: 0, offsetY: 0, opacity: 1, muted: false, ...over })
const segOf = (items, over = {}) => ({ start: 0, end: 2, items, overlays: [], vw: 1920, vh: 1080, fps: 30, ...over })
const dry = (seg) => encodeSegment(seg, SEG_OUT, { _dryRun: true })

test('graph: a screen image and a multiply video replace their overlay with the blend parts', async () => {
  const r = await dry(segOf([imageItem({ blendMode: 'screen' }), videoItem({ blendMode: 'multiply' })]))
  const g = r.filterParts.join(';')
  assert.ok(g.includes('[canvas]split=2[blk1][blb1]'), g)
  assert.ok(g.includes('[img1]overlay=x=480:y=270:format=yuv444:shortest=0,'))
  assert.ok(g.includes('blend=c0_mode=screen:'))
  assert.ok(g.includes('[blk1][blx1]overlay=x=0:y=0:shortest=0[iv1]'))
  assert.ok(g.includes('[iv1]split=2[blk2][blb2]'))
  assert.ok(g.includes('blend=c0_mode=multiply:'))
  // The video keeps its own overlay format on the merge.
  assert.ok(g.includes('[blk2][blx2]overlay=x=0:y=0:format=yuv420:shortest=0[iv2]'))
  assert.ok(g.includes('color=c=black@0:s=1920x1080:r=30:d=2,'))
  assert.ok(!g.includes('[canvas][img1]overlay='))
})

test('graph: an HDR segment blends in 10-bit BT.2020', async () => {
  const r = await dry(segOf([videoItem({ blendMode: 'screen' })], { colorSpace: 'hdr_hlg' }))
  const g = r.filterParts.join(';')
  assert.ok(g.includes('in_color_matrix=bt2020:out_color_matrix=bt2020:in_range=tv,format=gbrap10le'), g)
  assert.ok(g.includes('format=yuva420p10le[blx1]'))
})

test('graph: an animated position places the item with the same expressions the overlay had', async () => {
  const kf = [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 2, value: 20 }] }]
  const plain = (await dry(segOf([videoItem({ keyframes: kf })]))).filterParts.join(';')
  const blended = (await dry(segOf([videoItem({ keyframes: kf, blendMode: 'screen' })]))).filterParts.join(';')
  const pos = plain.match(/\[vid1\]overlay=(x='[^']*':y='[^']*')/)
  assert.ok(pos, plain)
  assert.ok(blended.includes(`[vid1]overlay=${pos[1]}:format=yuv444:shortest=0,`), blended)
})

test('graph: normal (absent or explicit) emits the overlay it always did', async () => {
  const a = await dry(segOf([imageItem(), videoItem()]))
  const b = await dry(segOf([imageItem({ blendMode: 'normal' }), videoItem({ blendMode: 'bogus' })]))
  assert.deepEqual(b.filterParts, a.filterParts)
  assert.ok(!a.filterParts.join(';').includes('blend='))
})

// ── Real ffmpeg ─────────────────────────────────────────────────────────────
//
// The CSS formulas (W3C Compositing and Blending Level 1, section 10), with Cb
// the backdrop and Cs the source, both in [0, 1]:
//   multiply  B = Cb·Cs
//   screen    B = Cb + Cs - Cb·Cs
//   overlay   B = HardLight(Cs, Cb): Cb <= 0.5 ? 2·Cb·Cs : screen(Cs, 2·Cb - 1)
//   darken    B = min(Cb, Cs)
//   lighten   B = max(Cb, Cs)
//   add       B = min(1, Cb + Cs)   (plus-lighter)
// and the composite over an opaque backdrop is Co = (1 - as)·Cb + as·B(Cb, Cs).

const CSS = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : CSS.screen(s, 2 * b - 1)),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  add: (b, s) => Math.min(1, b + s),
}
const BACKDROP = [0x80, 0x80, 0x80]
const ITEM = [0xc0, 0x40, 0x20]
const expected = (mode, as = 1) => BACKDROP.map((cb, i) => {
  const b = cb / 255, s = ITEM[i] / 255
  return 255 * ((1 - as) * b + as * CSS[mode](b, s))
})

const CANVAS = {
  8: { pix: 'yuv420p', matrix: 'bt709', tag: 'bt709', ovFmt: ':format=yuv420' },
  10: { pix: 'yuv420p10le', matrix: 'bt2020', tag: 'bt2020nc', ovFmt: ':format=yuv420' },
}

/**
 * Composite one item over a backdrop the way encodeSegment does (a tagged
 * canvas, then the item's overlay or blend), read back in the canvas format
 * or as rgb24 through the canvas's own matrix.
 */
function composite({ bits, backdrop, itemChain = 'format=rgba', mode = null, readRgb = true, size = 32, at = 8 }) {
  const c = CANVAS[bits]
  const canvas = `[0:v]format=${c.pix},setparams=colorspace=${c.tag}:range=tv[canvas]`
  const item = `[1:v]${itemChain}[it]`
  const parts = mode
    ? blendCompositeParts({ backdrop: '[canvas]', item: '[it]', x: String(at), y: String(at), vw: size, vh: size, mode,
      idx: 1, tenBit: bits === 10, matrix: c.matrix, canvasPixFmt: c.pix, fps: 10, duration: 0.1,
      overlayFormat: c.ovFmt, out: '[o]' })
    : [`[canvas][it]overlay=x=${at}:y=${at}${c.ovFmt}:shortest=0[o]`]
  const tail = readRgb ? `[o]scale=in_color_matrix=${c.matrix}:in_range=tv,format=rgb24[r]` : '[o]null[r]'
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `${backdrop}${backdrop.endsWith('=') ? '' : ':'}s=${size}x${size}:r=10:d=0.1`,
    '-f', 'lavfi', '-i', `color=c=0x${ITEM.map(v => v.toString(16).padStart(2, '0')).join('')}:s=16x16:r=10:d=0.1`,
    '-filter_complex', [canvas, item, ...parts, tail].join(';'),
    '-map', '[r]', '-frames:v', '1', '-pix_fmt', readRgb ? 'rgb24' : c.pix, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 })
  assert.equal(r.status, 0, String(r.stderr))
  return r.stdout
}
const grey = 'color=c=0x808080'
const centre = (buf) => [...buf.subarray((16 * 32 + 16) * 3, (16 * 32 + 16) * 3 + 3)]
const maxErr = (got, want) => Math.max(...got.map((v, i) => Math.abs(v - want[i])))

for (const bits of [8, 10]) {
  for (const mode of Object.keys(CSS)) {
    test(`real ffmpeg, ${bits}-bit: ${mode} matches the CSS formula at the item's centre (±3)`, () => {
      const got = centre(composite({ bits, backdrop: grey, mode }))
      const want = expected(mode)
      const err = maxErr(got, want)
      console.log(`${bits}-bit ${mode}: got ${got} want ${want.map(v => v.toFixed(1))} max err ${err.toFixed(2)}`)
      assert.ok(err <= 3, `${got} vs ${want}`)
    })
  }

  test(`real ffmpeg, ${bits}-bit: pixels outside the item equal a plain render's (±1, every plane)`, () => {
    // A textured, saturated backdrop: a wrong matrix or a chroma round trip
    // moves these colours, where a flat grey would hide it.
    const W = 64, H = 64, at = 24
    // The clip is tagged like the canvas, as every clip reaching the composite
    // is in an export. Untagged, the PLAIN render re-matrixes the whole 10-bit
    // canvas to BT.601 (ffmpeg negotiates the composite down to "unknown").
    const itemChain = `format=yuva420p,setparams=colorspace=${CANVAS[bits].tag}:range=tv`
    const opts = { bits, backdrop: 'testsrc2=', size: 64, at, readRgb: false, itemChain }
    const plain = composite(opts)
    const blended = composite({ ...opts, mode: 'screen' })
    const bps = bits === 10 ? 2 : 1
    const rd = (b, i) => (bps === 2 ? b.readUInt16LE(i * 2) : b[i])
    let maxOut = 0, maxIn = 0
    for (const [off, pw, ph, sub] of [[0, W, H, 1], [W * H, W / 2, H / 2, 2], [W * H * 5 / 4, W / 2, H / 2, 2]]) {
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
        const X = x * sub, Y = y * sub
        const d = Math.abs(rd(blended, off + y * pw + x) - rd(plain, off + y * pw + x))
        // The item covers [24, 40); a chroma sample whose 2x2 block touches it is inside.
        if (X >= at - sub && X < at + 16 + sub && Y >= at - sub && Y < at + 16 + sub) maxIn = Math.max(maxIn, d)
        else maxOut = Math.max(maxOut, d)
      }
    }
    console.log(`${bits}-bit neutrality: max diff outside ${maxOut}, inside ${maxIn}`)
    assert.ok(maxOut <= 1, `outside differs by ${maxOut}`)
    assert.ok(maxIn > 1, 'the blend changed nothing inside the item')
  })

  test(`real ffmpeg, ${bits}-bit: opacity 0.5 before the blend gives backdrop + 0.5·(blend - backdrop) (±3)`, () => {
    const got = centre(composite({ bits, backdrop: grey, mode: 'screen', itemChain: 'format=rgba,colorchannelmixer=aa=0.5' }))
    const want = expected('screen', 0.5)
    const err = maxErr(got, want)
    console.log(`${bits}-bit screen at 0.5: got ${got} want ${want.map(v => v.toFixed(1))} max err ${err.toFixed(2)}`)
    assert.ok(err <= 3, `${got} vs ${want}`)
  })
}

// An RGBA canvas (a carousel slide, a transparent export) blends in place:
// the item at 50% alpha over a flat backdrop must match CSS mix-blend-mode
// (the result is the blend, mixed with the backdrop by the item's alpha), and
// pixels outside the item stay exactly the backdrop.
const ffOk = spawnSync(FFMPEG, ['-version']).status === 0
const hex = (c) => '0x' + c.map(v => v.toString(16).padStart(2, '0')).join('')
const cssBlend = (mode, b, s) => b.map((bv, i) => {
  const B = bv / 255, S = s[i] / 255
  const full = mode === 'screen' ? 1 - (1 - B) * (1 - S) : B * S
  return Math.round((B + (full - B) * 0.5) * 255)
})
for (const mode of ['screen', 'multiply']) {
  test(`ffmpeg: ${mode} on an RGBA canvas matches CSS within 2 codes; outside pixels are exact`, { skip: !ffOk }, () => {
    const bd = [100, 150, 200], it = [200, 40, 90]
    const parts = blendCompositeParts({ backdrop: '[bd]', item: '[it]', x: '0', y: '0', vw: 16, vh: 16, mode, idx: 1,
      tenBit: false, matrix: 'bt709', canvasPixFmt: 'rgba', fps: 10, duration: 0.1, overlayFormat: '', out: '[o]' })
    const fc = `color=c=${hex(bd)}:s=16x16:r=10:d=0.1,format=rgba[bd];`
      + `color=c=${hex(it)}:s=8x8:r=10:d=0.1,format=rgba,colorchannelmixer=aa=0.5[it];` + parts.join(';')
    const r = spawnSync(FFMPEG, ['-v', 'error', '-filter_complex', fc, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    assert.equal(r.status, 0, String(r.stderr))
    const at = (x, y) => [...r.stdout.subarray((y * 16 + x) * 3, (y * 16 + x) * 3 + 3)]
    const want = cssBlend(mode, bd, it)
    at(2, 2).forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 2, `${mode} inside ${at(2, 2)} want ${want}`))
    assert.deepEqual(at(12, 12), bd)
  })
}

// sample-frame's canvas is RGBA, but a plain overlay before the blend hands it
// on as yuv420 carrying the source frame's tags (a PNG: gbr, full range). Read
// with the BT.709 matrix as YUV, saturated colours shifted (magenta's green
// 38 came out 68). The blend first makes the backdrop the canvas's own RGB.
test('ffmpeg: on an RGBA canvas, a backdrop an overlay handed on as tagged yuv420 keeps its colour', { skip: !ffOk }, () => {
  const parts = blendCompositeParts({ backdrop: '[bg]', item: '[it]', x: '0', y: '0', vw: 16, vh: 16, mode: 'screen', idx: 1,
    tenBit: false, matrix: 'bt709', canvasPixFmt: 'rgba', fps: 10, duration: 0.1, overlayFormat: '', out: '[o]' })
  const fc = 'color=c=black:s=16x16:r=10:d=0.1,format=rgba[c0];'
    + 'color=c=0xFF26FF:s=16x16:r=10:d=0.1,format=rgb24,setparams=colorspace=gbr:range=pc:color_primaries=bt709:color_trc=bt709,format=rgba[v0];'
    + '[c0][v0]overlay=x=0:y=0:shortest=0[bg];'
    // screen with black is the backdrop itself
    + 'color=c=black:s=16x16:r=10:d=0.1,format=rgba[it];' + parts.join(';')
  const r = spawnSync(FFMPEG, ['-v', 'error', '-filter_complex', fc, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  assert.equal(r.status, 0, String(r.stderr))
  const px = [...r.stdout.subarray((8 * 16 + 8) * 3, (8 * 16 + 8) * 3 + 3)]
  ;[255, 38, 255].forEach((v, i) => assert.ok(Math.abs(px[i] - v) <= 2, `got ${px}, want 255,38,255`))
})

test('parts: an RGB canvas turns the backdrop into that format before splitting it; a YUV canvas does not', () => {
  const rgb = blendCompositeParts({ ...base, canvasPixFmt: 'rgba' })
  assert.equal(rgb[0], '[iv3]format=rgba,split=2[blk4][blb4]')
  assert.equal(blendCompositeParts(base)[0], '[iv3]split=2[blk4][blb4]')
})
