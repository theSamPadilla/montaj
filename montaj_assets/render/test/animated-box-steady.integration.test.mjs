// render/test/animated-box-steady.integration.test.mjs (34, 5.43.0)
//
// A slowly pushed (keyframed scale) image no longer shakes. The resized box was an even size placed at a corner rounded
// on its own, and the 4:2:0 composite snaps the corner down to even pixels, so the box grew on one side one step and
// shifted the next: a point of the picture moved back and forth by up to 2 px a frame (lfx measured 1.6 px by sub-pixel
// cross-correlation). And a looped image came in at the image demuxer's 25 fps while the overlay places it per 30 fps
// output frame, so size and place came from different instants (2 px jumps back). Now the box steps in 4 px about a
// centre snapped to even, and an animated image's frames come at the segment's rate: every point of the picture moves
// only the way the keys move it, in whole-pixel steps (sub-pixel placement is a later step). A still item is untouched.
//
// Measured on the real binary: a textured image pushed from scale 0.5 to 0.55 over 3 s, a 24 px patch tracked frame to
// frame by cross-correlation (a parabola through the best offset's neighbours), at points 15% and 85% across and 15%
// and 85% down the box.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildImageItemFilterParts, buildVideoItemFilterParts } from '../encode-segment.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const VW = 1920, VH = 1080, FPS = 30, DUR = 3
const push = { prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: DUR, value: 0.55 }] }
const imageItem = (over = {}) => ({ type: 'image', src: '/tmp/tex.png', start: 0, duration: DUR, scale: 0.5, offsetX: 0, offsetY: 0, ...over })
const overlayOf = (r) => r.filterParts.find((p) => p.includes('overlay='))
/** An evaluator for the emitted expression dialect (round, between, if), as video-keyframes.test.mjs has it. */
const ev = (src, t) => Function('t', `
  const round = Math.round, between = (x, a, b) => (x >= a && x <= b ? 1 : 0), iff = (c, a, b) => (c ? a : b)
  return ${src.replace(/\bif\(/g, 'iff(')}
`)(t)

const haveFfmpeg = spawnSync(FFMPEG, ['-hide_banner', '-version']).status === 0

// The whole-pixel chain this file was written for is the one a 10-bit (HDR) canvas still takes; the `wholePixel` seam
// builds it on any canvas. An 8-bit canvas takes the sub-pixel chain (§801): subpixel-motion.integration.test.mjs.
const WHOLE = { wholePixel: true }

describe('a keyframed push: the box steps 4 px about an even centre', () => {
  test('every frame: the size a multiple of 4, the corner even, the centre still, the size never shrinking', () => {
    const r = buildImageItemFilterParts(imageItem({ keyframes: [push] }), VW, VH, 1, '[canvas]', DUR, 0, { fps: FPS, ...WHOLE })
    const chain = r.filterParts.find((p) => p.includes('eval=frame'))
    const w = /scale=w='([^']*)':h='([^']*)':eval=frame/.exec(chain), ov = overlayOf(r)
    const x = /overlay=x='([^']*)'/.exec(ov)[1], y = /:y='([^']*)'/.exec(ov)[1]
    let last = null
    for (let f = 0; f <= DUR * FPS; f++) {
      const t = f / FPS, W = ev(w[1], t), H = ev(w[2], t), X = ev(x, t), Y = ev(y, t)
      assert.equal(W % 4, 0, `t=${t}: width ${W}`); assert.equal(H % 4, 0, `t=${t}: height ${H}`)
      assert.equal(X % 2, 0, `t=${t}: x ${X}`); assert.equal(Y % 2, 0, `t=${t}: y ${Y}`)
      assert.equal(X + W / 2, VW / 2, `t=${t}: centre x`); assert.equal(Y + H / 2, VH / 2, `t=${t}: centre y`)
      if (last) assert.ok(W >= last.W && H >= last.H, `t=${t}: the box shrank`)
      last = { W, H }
    }
  })

  test('an animated image comes in at the segment\'s rate; a still or a position-only one exactly as before', () => {
    const animated = buildImageItemFilterParts(imageItem({ keyframes: [push] }), VW, VH, 1, '[canvas]', DUR, 0, { fps: 25, ...WHOLE })
    assert.deepEqual(animated.inputArgs.slice(0, 2), ['-framerate', '25'])
    const still = buildImageItemFilterParts(imageItem(), VW, VH, 1, '[canvas]', DUR, 0, { fps: FPS })
    assert.deepEqual(still.inputArgs, ['-loop', '1', '-t', '3', '-i', '/tmp/tex.png'])
    const pan = buildImageItemFilterParts(imageItem({ keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: -10 }, { t: DUR, value: 10 }] }] }), VW, VH, 1, '[canvas]', DUR, 0, { fps: FPS, ...WHOLE })
    assert.deepEqual(pan.inputArgs, still.inputArgs)
    assert.match(overlayOf(pan), /overlay=x='round\(1920\*\(0\.5\*\(1-\(0\.5\)\)\+\(/, 'a pan keeps its corner expression')
  })

  test('a video\'s resized box steps the same way', () => {
    const r = buildVideoItemFilterParts({ type: 'video', src: '/tmp/clip.mp4', start: 0, duration: DUR, scale: 0.5, offsetX: 0, offsetY: 0, keyframes: [push] }, VW, VH, 1, '[canvas]',
      { segStart: 0, duration: DUR, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true, sdrCurve: null, fps: FPS, ...WHOLE })
    const x = /overlay=x='([^']*)'/.exec(overlayOf(r))[1]
    for (let f = 0; f <= DUR * FPS; f += 7) assert.equal(ev(x, f / FPS) % 2, 0)
  })
})

describe('a keyframed push measured on the real binary', () => {
  for (const [chain, opts] of [['whole-pixel', WHOLE], ['sub-pixel', {}]]) test(`${chain}: a point of the picture never moves back: right side only right, left only left, and the same down and up`, { skip: haveFfmpeg ? false : 'no ffmpeg' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'box-steady-'))
    try {
      const img = join(dir, 'tex.png'), out = join(dir, 'out.y')
      let r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=gray:s=1600x900,noise=alls=90:allf=u,gblur=sigma=2.5', '-frames:v', '1', img])
      assert.equal(r.status, 0, String(r.stderr))
      const parts = buildImageItemFilterParts(imageItem({ src: img, keyframes: [push] }), VW, VH, 1, '[canvas]', DUR, 0, { fps: FPS, ...opts })
      r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=black:s=${VW}x${VH}:r=${FPS}:d=${DUR}`, ...parts.inputArgs,
        '-filter_complex', ['[0:v]format=yuv420p[canvas]', ...parts.filterParts].join(';'), '-map', '[iv1]', '-r', String(FPS), '-pix_fmt', 'gray', '-f', 'rawvideo', out], { maxBuffer: 1 << 30 })
      assert.equal(r.status, 0, String(r.stderr).slice(0, 2000))
      const buf = readFileSync(out), N = buf.length / (VW * VH), px = (f, x, y) => buf[f * VW * VH + y * VW + x]
      const P = 12, S = 4
      /** The patch's motion from frame f to f + 1 along axis 0 (x) or 1 (y), to a sub-pixel. */
      const motion = (f, cx, cy, axis) => {
        const score = (ox, oy) => { let s = 0; for (let y = -P; y < P; y++) for (let x = -P; x < P; x++) { const d = px(f, cx + x, cy + y) - px(f + 1, cx + x + ox, cy + y + oy); s += d * d } return s }
        let best = { ox: 0, oy: 0, s: Infinity }
        for (let oy = -S; oy <= S; oy++) for (let ox = -S; ox <= S; ox++) { const s = score(ox, oy); if (s < best.s) best = { ox, oy, s } }
        const at = (o) => (axis === 0 ? score(best.ox + o, best.oy) : score(best.ox, best.oy + o)), a = at(-1), c = at(1), den = a - 2 * best.s + c
        return (axis === 0 ? best.ox : best.oy) + (den > 0 ? (a - c) / (2 * den) : 0)
      }
      const boxAt = (t) => { const s = 0.5 + 0.05 * (t / DUR); return { x0: (VW * (1 - s)) / 2, w: VW * s, y0: (VH * (1 - s)) / 2, h: VH * s } }
      for (const [u, v, axis, sign] of [[0.85, 0.5, 0, 1], [0.15, 0.5, 0, -1], [0.5, 0.85, 1, 1], [0.5, 0.15, 1, -1]]) {
        const d = []
        for (let f = 0; f + 1 < N; f++) { const b = boxAt(f / FPS); d.push(motion(f, Math.round(b.x0 + u * b.w), Math.round(b.y0 + v * b.h), axis)) }
        const back = d.filter((x) => x * sign < -0.05)
        assert.equal(back.length, 0, `at ${u}, ${v} (${axis ? 'y' : 'x'}): ${back.length} frames moved back (${back.slice(0, 5).map((x) => x.toFixed(2))})`)
        const mean = d.reduce((a, b) => a + b, 0) / d.length, truth = sign * Math.abs(axis ? (v - 0.5) * VH : (u - 0.5) * VW) * (0.05 / (DUR * FPS))
        assert.ok(Math.abs(mean - truth) < 0.05, `at ${u}, ${v}: mean ${mean.toFixed(3)} px a frame, the keys ${truth.toFixed(3)}`)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
