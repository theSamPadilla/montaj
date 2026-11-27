// render/test/subpixel-motion.integration.test.mjs (§801)
//
// A keyframed push, pan or turn of an image or a video plays smooth: on an 8-bit canvas the box is drawn at its exact,
// unrounded place, size and angle every frame (one `perspective` resample onto its corners inside a fixed frame, the
// frame overlaid at a fixed even place). Before, the box moved in whole pixels: a slow pan stood still, then jumped
// 2 px (the 4:2:0 overlay snaps to even), and a push grew in 4 px steps. And a clip whose rate is not the segment's
// read its size per clip frame while the overlay read its place per output frame (the clock skew).
//
// Two halves. The graph: every frame, the corners perspective is given put the picture on the box the preview's own
// resolver (timeline-core geometryAt) computes. The real binary: the drawn edges and picture, read to a sub-pixel.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { geometryAt } from '@bycrux/timeline-core'
import { buildImageItemFilterParts, buildVideoItemFilterParts } from '../encode-segment.js'
import { collectAllItems } from '../render.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const VW = 1280, VH = 720, FPS = 30, DUR = 2
const track = (prop, a, b) => ({ prop, points: [{ t: 0, value: a }, { t: DUR, value: b }] })
const PUSH = [track('scale', 0.5, 0.55)]
const PAN = [track('offsetX', -0.7, 0.7)] // 1280 * 0.014 / 60 = 0.3 px a frame
const imageItem = (over = {}) => ({ type: 'image', src: '/tmp/tex.png', start: 0, duration: DUR, scale: 0.5, offsetX: 0, offsetY: 0, ...over })
const videoItem = (over = {}) => ({ type: 'video', src: '/tmp/clip.mp4', start: 0, duration: DUR, inPoint: 0, scale: 0.5, offsetX: 0, offsetY: 0, ...over })
const videoOpts = (over = {}) => ({ segStart: 0, duration: DUR, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true, sdrCurve: null, fps: FPS, ...over })
const image = (item, opts = {}, segStart = 0) => buildImageItemFilterParts(item, VW, VH, 1, '[canvas]', DUR, segStart, { fps: FPS, ...opts })
const video = (item, opts = {}) => buildVideoItemFilterParts(item, VW, VH, 1, '[canvas]', videoOpts(opts))

/** The box the preview draws at item time t (geometryAt): centre, size and angle (radians). */
function keysAt(item, t) {
  const g = geometryAt(item, item.type, t)
  return { cx: VW * (0.5 + g.offsetX / 100), cy: VH * (0.5 + g.offsetY / 100), w: VW * g.scaleX, h: VH * g.scaleY, a: ((g.rotation ?? 0) * Math.PI) / 180 }
}

/**
 * An evaluator for the emitted expression dialect (if, between, round, cos, sin, PI), with perspective's `in`. A
 * shifted key writes `t--1` (t minus minus one), which ffmpeg reads and JavaScript does not.
 */
const ev = (src, vars) => Function(...Object.keys(vars), `
  const round = Math.round, cos = Math.cos, sin = Math.sin, PI = Math.PI
  const between = (x, a, b) => (x >= a && x <= b ? 1 : 0), iff = (c, a, b) => (c ? a : b)
  return ${src.replace(/\bif\(/g, 'iff(').replace(/\bin\b/g, 'IN').replace(/--/g, '- -')}
`)(...Object.values(vars))

/** The sub-pixel step of a built item: its fixed frame, margin, per-frame size step and perspective corners. */
function readChain(r) {
  const parts = r.filterParts.join(';')
  const pad = /pad=(\d+):(\d+):(\d+):\3:color=black@0\.0,split=2/.exec(parts)
  const frame = /alphamerge(?:,scale=w='([^']*)':h='([^']*)':eval=frame)?,pad=(\d+):(\d+):0:0/.exec(parts)
  const persp = /perspective=([^;]*):interpolation=cubic/.exec(parts)
  const corners = Object.fromEntries([...persp[1].matchAll(/([xy][0-3])='([^']*)'/g)].map((m) => [m[1], m[2]]))
  const ov = /overlay=x=(-?\d+):y=(-?\d+)/.exec(parts)
  return {
    sw: +pad[1], sh: +pad[2], m: +pad[3], bulkW: frame[1], bulkH: frame[2], fw: +frame[3], fh: +frame[4],
    corners, persp: persp[0], ox: ov && +ov[1], oy: ov && +ov[2],
  }
}

/** The content's four corners on the canvas at output frame k (segment time k / FPS), as the chain draws them. */
function drawnCorners(c, k) {
  const t = k / FPS, vars = { IN: k + 1, t, W: c.fw, H: c.fh }
  const P = (i) => [ev(c.corners[`x${i}`], vars), ev(c.corners[`y${i}`], vars)]
  const [p0, p1, p2] = [P(0), P(1), P(2)]
  // perspective maps input index (u, v) affinely: p0 + (p1 - p0) u / W + (p2 - p0) v / H (index coordinates).
  const map = (u, v) => [p0[0] + (p1[0] - p0[0]) * u / c.fw + (p2[0] - p0[0]) * v / c.fh, p0[1] + (p1[1] - p0[1]) * u / c.fw + (p2[1] - p0[1]) * v / c.fh]
  const kx = c.bulkW ? ev(c.bulkW, { t }) / c.sw : 1, ky = c.bulkH ? ev(c.bulkH, { t }) / c.sh : 1
  const pw = c.sw - 2 * c.m, ph = c.sh - 2 * c.m
  // Content edges in input edge coordinates, to index (- 0.5), mapped, back to edge (+ 0.5), onto the canvas.
  const at = (xe, ye) => { const [X, Y] = map(xe - 0.5, ye - 0.5); return [X + 0.5 + c.ox, Y + 0.5 + c.oy] }
  return [at(c.m * kx, c.m * ky), at((c.m + pw) * kx, c.m * ky), at(c.m * kx, (c.m + ph) * ky), at((c.m + pw) * kx, (c.m + ph) * ky)]
}

function keyCorners(item, t) {
  const g = keysAt(item, t), c = Math.cos(g.a), s = Math.sin(g.a)
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [g.cx + (a * g.w / 2) * c - (b * g.h / 2) * s, g.cy + (a * g.w / 2) * s + (b * g.h / 2) * c])
}

/** Every frame of the segment: the drawn corners within `tol` of the preview's, inside the fixed frame. */
function assertOnKeys(name, r, item, { tol = 1e-6, offset = 0 } = {}) {
  const c = readChain(r)
  assert.equal(Math.abs(c.ox % 2), 0, `${name}: the frame sits at an even x`); assert.equal(Math.abs(c.oy % 2), 0, `${name}: and an even y`)
  for (let k = 0; k <= DUR * FPS; k++) {
    const drawn = drawnCorners(c, k), keys = keyCorners(item, offset + k / FPS)
    for (let i = 0; i < 4; i++) for (let a = 0; a < 2; a++) {
      assert.ok(Math.abs(drawn[i][a] - keys[i][a]) < tol, `${name}, frame ${k}, corner ${i}: drawn ${drawn[i][a]}, the preview ${keys[i][a]}`)
    }
    // Inside the fixed frame with room for the cubic taps, wherever the canvas shows it.
    for (const [x, y] of drawn) {
      if (x >= 0 && x <= VW) assert.ok(x - c.ox >= 2 && c.ox + c.fw - x >= 2, `${name}, frame ${k}: x ${x} outside the frame`)
      if (y >= 0 && y <= VH) assert.ok(y - c.oy >= 2 && c.oy + c.fh - y >= 2, `${name}, frame ${k}: y ${y} outside the frame`)
    }
  }
}

describe('the sub-pixel chain: every frame the picture lands on the preview\'s box', () => {
  const cases = [
    ['an image push', imageItem({ keyframes: PUSH }), image],
    ['an image pan', imageItem({ scale: 0.6, keyframes: PAN }), image],
    ['an image push and turn', imageItem({ keyframes: [...PUSH, track('rotation', 0, 3)] }), image],
    ['an image zoom out to half (the per-frame size step)', imageItem({ scale: 1, keyframes: [track('scale', 1, 0.5)] }), image],
    ['a video push', videoItem({ keyframes: PUSH }), video],
    ['a video pan, turned', videoItem({ scale: 0.6, rotation: 8, keyframes: PAN }), video],
  ]
  for (const [name, item, build] of cases) test(name, () => assertOnKeys(name, build(item), item))

  test('an item that starts before the segment, and one that starts inside it, keep their own clock', () => {
    // A segment from 1 s: the image started at 0, so the segment's frame 0 is its 1 s. The clip starts at 0.5 s in a
    // segment from 0.5 s.
    const early = imageItem({ duration: 3, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 3, value: 0.6 }] }] })
    assertOnKeys('image from before the segment', image(early, {}, 1), early, { offset: 1 })
    const late = videoItem({ start: 0.5, keyframes: PUSH })
    assertOnKeys('clip starting with the segment', video(late, { segStart: 0.5 }), late)
  })

  test('a clip at speed 2 moves on the timeline\'s clock: the same corners as at speed 1', () => {
    assert.equal(readChain(video(videoItem({ keyframes: PUSH, speed: 2 }))).persp, readChain(video(videoItem({ keyframes: PUSH }))).persp)
  })

  // The compiler's 63-chord cap bounds this one: 0.07 px on its 512 px change of width, 0.06 px on its offset.
  test('eased scale, turn and offset together stay within 0.2 px of the preview', () => {
    const eased = (prop, a, b, easing) => ({ prop, points: [{ t: 0, value: a, easing }, { t: DUR, value: b }] })
    const item = videoItem({ keyframes: [eased('scale', 0.5, 0.9, 'ease-in-out'), eased('rotation', 0, 20, 'ease-in-out'), eased('offsetX', -10, 10, 'ease')] })
    assertOnKeys('eased together', video(item), item, { tol: 0.2 })
  })

  test('the 9:16 closer: a per-axis band with a keyframed uniform scale keeps the preview\'s box (through the export\'s collector)', () => {
    const W = 1080, H = 1920, duration = 3
    const item = {
      id: 'closer', type: 'video', src: '/presenter.MOV', start: 0, end: duration, inPoint: 0,
      sourceWidth: 3840, sourceHeight: 2160, scale: 1, scaleX: 1, scaleY: 0.31640625, offsetX: 0, offsetY: 34.1796875,
      keyframes: [
        { prop: 'scale', points: [{ t: 0, value: 1 }, { t: 0.9, value: 0.93 }, { t: 2.3, value: 0.465 }] },
        { prop: 'offsetY', points: [{ t: 0, value: 34.1796875 }, { t: 0.9, value: 18.75 }, { t: 2.3, value: 0 }] },
      ],
    }
    const emitted = collectAllItems({ tracks: [{ id: 'base', items: [] }, { id: 'band', items: [item] }] }).videoItems[0]
    const c = readChain(buildVideoItemFilterParts(emitted, W, H, 1, '[base]', videoOpts({ duration })))
    for (let k = 0; k <= duration * FPS; k++) {
      const g = geometryAt(item, 'video', k / FPS), [tl, , , br] = drawnCorners(c, k)
      const want = [W * (0.5 * (1 - g.scaleX) + g.offsetX / 100), H * (0.5 * (1 - g.scaleY) + g.offsetY / 100)]
      assert.ok(Math.abs(tl[0] - want[0]) < 1e-6 && Math.abs(tl[1] - want[1]) < 1e-6, `frame ${k}: top left ${tl}, the preview ${want}`)
      assert.ok(Math.abs(br[0] - tl[0] - W * g.scaleX) < 1e-6 && Math.abs(br[1] - tl[1] - H * g.scaleY) < 1e-6, `frame ${k}: the band's size`)
    }
  })

  test('a keyframed crop and a keyframed box: the moving crop fills the peak box, the move follows the pad', () => {
    const lin = (prop, a, b) => track(prop, a, b)
    const item = videoItem({ sourceWidth: 1920, sourceHeight: 1080, keyframes: [lin('cropX', 0, 0.25), lin('cropW', 0.75, 0.75), ...PUSH] })
    const r = video(item), parts = r.filterParts.join(';')
    assert.match(parts, /eval=frame,crop=\d+:\d+:x='[^']*':y='[^']*':exact=1,[^;]*pad=\d+:\d+:[^;]*\[vidm1\];\[vidm1\]fps=30,/, parts)
    assertOnKeys('crop and box', r, item)
  })

  test('the colour conversion never sees a frame that changes size: everything per frame comes after it', () => {
    const r = video(videoItem({ colorTransfer: 'arib-std-b67', keyframes: [track('scale', 1, 0.5)] }))
    const head = r.filterParts.find((p) => p.startsWith('[1:v]'))
    assert.match(head, /lut3d|zscale/, head)
    assert.ok(!head.includes('eval=frame'), head)
    assert.ok(r.filterParts.find((p) => p.includes('perspective=')).includes(":eval=frame,pad="), 'the per-frame size step follows the head')
  })

  test('a zoom out to half resizes per frame first (downscale quality); a slow push goes straight to perspective', () => {
    assert.ok(readChain(image(imageItem({ scale: 1, keyframes: [track('scale', 1, 0.5)] }))).bulkW)
    assert.equal(readChain(image(imageItem({ keyframes: PUSH }))).bulkW, undefined)
  })

  test('a pan comes in at the segment\'s rate; a still image exactly as before', () => {
    assert.deepEqual(image(imageItem({ keyframes: PAN })).inputArgs.slice(0, 2), ['-framerate', String(FPS)])
    const still = image(imageItem())
    assert.deepEqual(still.inputArgs, ['-loop', '1', '-t', '2', '-i', '/tmp/tex.png'])
    assert.ok(!still.filterParts.join(';').includes('perspective'))
  })

  test('a moving clip is pinned to the segment\'s rate before it moves', () => {
    assert.match(video(videoItem({ keyframes: PUSH })).filterParts.join(';'), /\[vidm1\]fps=30,format=yuva420p,pad=/)
  })

  test('a 10-bit (HDR) canvas keeps the whole-pixel chain, its clip pinned to the segment\'s rate', () => {
    const hdr = video(videoItem({ keyframes: PUSH }), { projectColorSpace: 'hdr_hlg', canvasPixFmt: 'yuv420p10le' }).filterParts.join(';')
    assert.ok(!hdr.includes('perspective'))
    assert.match(hdr, /,fps=30,scale=w='/)
    assert.ok(!image(imageItem({ keyframes: PUSH }), { toHdr: 'hdr_hlg', canvasPixFmt: 'yuv420p10le', dryRun: true }).filterParts.join(';').includes('perspective'))
  })
})

// ── On the real binary ──────────────────────────────────────────────────────
//
// Positions are read ABSOLUTELY, never frame against frame. Two frames resampled at different sub-pixel phases differ
// a little in sharpness, and a shift estimator reading one against the other swings by about 0.1 px with the phase
// (measured: perspective's own shifts land within 0.011 px of a sharp reference, the same frames read pairwise
// 0.22 to 0.42 px for a 0.3 px move). So an edge is read from a flat card's coverage, and a textured picture against
// a sharp still of itself.

const haveFfmpeg = spawnSync(FFMPEG, ['-hide_banner', '-version']).status === 0
let dir = null
const ff = (args) => { const r = spawnSync(FFMPEG, ['-v', 'error', ...args], { maxBuffer: 1 << 30 }); assert.equal(r.status, 0, String(r.stderr).slice(0, 3000)); return r.stdout }
const FRAMES = DUR * FPS

/** The item composited on a plain canvas, as gray frames. */
function render(parts, canvas = 'black') {
  const out = ff(['-f', 'lavfi', '-i', `color=${canvas}:s=${VW}x${VH}:r=${FPS}:d=${DUR}`, ...parts.inputArgs,
    '-filter_complex', ['[0:v]format=yuv420p[canvas]', ...parts.filterParts].join(';'), '-map', parts.newVideoLabel,
    '-r', String(FPS), '-pix_fmt', 'gray', '-f', 'rawvideo', '-'])
  return { n: out.length / (VW * VH), px: (f, x, y) => out[f * VW * VH + y * VW + x] }
}

/**
 * Where a flat card's edge is, to a sub-pixel, from its coverage over a 16 px run across the edge: inside the card a
 * pixel reads `hi`, outside `lo`, and a pixel the edge cuts reads in between by the share it covers.
 */
function edgeAt(fr, f, near, axis, side, lo, hi) {
  const a = Math.round(near) - 8, line = axis ? Math.round(VW / 2) : Math.round(VH / 2)
  let cover = 0
  for (let i = a; i < a + 16; i++) cover += (fr.px(f, axis ? line : i, axis ? i : line) - lo) / (hi - lo)
  return side < 0 ? a + 16 - cover : a + cover // a leading edge (card after it), or a trailing one
}

/** Each frame's edges against the keys: every one within 0.1 px, and none ever moving the wrong way. */
function assertEdges(name, fr, item) {
  const lo = fr.px(0, 2, 2), hi = fr.px(0, VW / 2, VH / 2)
  const sides = [['left', 0, -1, (g) => g.cx - g.w / 2], ['right', 0, 1, (g) => g.cx + g.w / 2], ['top', 1, -1, (g) => g.cy - g.h / 2], ['bottom', 1, 1, (g) => g.cy + g.h / 2]]
  for (const [side, axis, sign, keyOf] of sides) {
    let last = null
    for (let f = 0; f < Math.min(fr.n, FRAMES); f++) {
      const key = keyOf(keysAt(item, f / FPS)), at = edgeAt(fr, f, key, axis, sign, lo, hi)
      assert.ok(Math.abs(at - key) < 0.1, `${name}, ${side} edge, frame ${f}: at ${at.toFixed(3)}, the keys ${key.toFixed(3)}`)
      if (last) {
        const want = key - last.key, got = at - last.at
        assert.ok(Math.abs(want) < 1e-9 || got * Math.sign(want) > -0.02, `${name}, ${side} edge, frame ${f}: moved ${got.toFixed(3)} against the keys' ${want.toFixed(3)}`)
      }
      last = { key, at }
    }
  }
}

/** How far q is p moved (q(i) ~ p(i - s)), by least squares under a cubic interpolation of p. */
function shiftOf(p, q) {
  const n = p.length, g = (i) => p[Math.min(n - 1, Math.max(0, i))]
  const at = (x) => { const i = Math.floor(x), f = x - i, a = g(i - 1), b = g(i), c = g(i + 1), d = g(i + 2); return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a))) }
  const cost = (s) => { let e = 0; for (let i = 6; i < n - 6; i++) { const d = q[i] - at(i - s); e += d * d } return e }
  let lo = -2, hi = 2
  for (let i = 0; i < 90; i++) { const a = lo + (hi - lo) * 0.382, b = lo + (hi - lo) * 0.618; if (cost(a) < cost(b)) hi = b; else lo = a }
  return (lo + hi) / 2
}

describe('on the real binary: every frame where the keys put it, to 0.1 px', { skip: haveFfmpeg ? false : 'no ffmpeg' }, () => {
  let tex, card, cardClip
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'subpixel-'))
    tex = join(dir, 'tex.png'); card = join(dir, 'card.png'); cardClip = join(dir, 'card24.mp4')
    ff(['-f', 'lavfi', '-i', 'color=gray:s=1600x900,noise=alls=90:allf=u,gblur=sigma=1.5', '-frames:v', '1', tex])
    ff(['-f', 'lavfi', '-i', 'color=0xC8C8C8:s=640x360', '-frames:v', '1', card])
    ff(['-f', 'lavfi', '-i', `color=0xC8C8C8:s=640x360:r=24:d=${DUR + 1}`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', cardClip])
  })
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('a slow image push (0.5 to 0.55 over 2 s): all four edges', () => {
    const item = imageItem({ src: card, keyframes: PUSH })
    assertEdges('push', render(image(item)), item)
  })

  test('a slow image pan (0.3 px a frame): its edges, and its picture against a sharp still of itself', () => {
    const item = imageItem({ src: card, scale: 0.6, keyframes: PAN })
    assertEdges('pan', render(image(item)), item)
    // The textured picture: at offsetX 0 the still is placed on whole pixels (a sharp reference); every frame of the
    // pan is that picture moved by the keys' offset.
    const still = render(image(imageItem({ src: tex, scale: 0.6 })))
    const panned = imageItem({ src: tex, scale: 0.6, keyframes: PAN }), fr = render(image(panned))
    const row = (r, f, x0, x1) => { const p = new Float64Array(x1 - x0); for (let y = 330; y < 390; y++) for (let x = x0; x < x1; x++) p[x - x0] += r.px(f, x, y); return p }
    const ref = row(still, 0, 440, 840)
    let last = null
    for (let f = 0; f < Math.min(fr.n, FRAMES); f++) {
      const key = keysAt(panned, f / FPS).cx - VW / 2, k0 = Math.round(key), at = k0 + shiftOf(ref, row(fr, f, 440 + k0, 840 + k0))
      assert.ok(Math.abs(at - key) < 0.05, `pan picture, frame ${f}: moved ${at.toFixed(3)}, the keys ${key.toFixed(3)}`)
      if (last !== null) assert.ok(at - last > 0, `pan picture, frame ${f}: moved back (${(at - last).toFixed(3)})`)
      last = at
    }
  })

  test('a slow push and turn: the picture turns the way the keys do, about its centre', () => {
    const item = imageItem({ src: card, keyframes: [...PUSH, track('rotation', 0, 2)] }), fr = render(image(item))
    // The top edge, read in a column right of centre: it comes down as the card turns clockwise.
    const lo = fr.px(0, 2, 2), hi = fr.px(0, VW / 2, VH / 2), x = Math.round(VW / 2 + 200)
    for (let f = 0; f < Math.min(fr.n, FRAMES); f += 5) {
      const g = keysAt(item, f / FPS), key = g.cy - g.h / 2 / Math.cos(g.a) + (x + 0.5 - g.cx) * Math.tan(g.a)
      let cover = 0; const a = Math.round(key) - 8
      for (let y = a; y < a + 16; y++) cover += (fr.px(f, x, y) - lo) / (hi - lo)
      assert.ok(Math.abs(a + 16 - cover - key) < 0.15, `turn, frame ${f}: top edge at ${(a + 16 - cover).toFixed(3)}, the keys ${key.toFixed(3)}`)
    }
  })

  test('a 24 fps clip pushed in a 30 fps segment (the clock skew): all four edges', () => {
    const item = videoItem({ src: cardClip, keyframes: PUSH })
    assertEdges('24 fps clip push', render(video(item)), item)
  })

  test('a card panned over a canvas of its own colour shows no rim at its edges', () => {
    const fr = render(image(imageItem({ src: card, keyframes: PAN })), '0xC8C8C8')
    const c = fr.px(0, 10, 10)
    for (let f = 0; f < fr.n; f += 3) for (let x = 0; x < VW; x++) {
      assert.ok(Math.abs(fr.px(f, x, VH / 2) - c) <= 2, `frame ${f}, x ${x}: ${fr.px(f, x, VH / 2)} against the canvas's ${c}`)
    }
  })
})
