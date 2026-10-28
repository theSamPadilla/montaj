import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { maskAt, maskSvg } from '@bycrux/timeline-core'
import { planItemMask, writeItemMask, prepareMaskWrite, maskFilterParts } from '../item-mask.js'
import { encodeSegment } from '../encode-segment.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const still = { mask: { shape: 'ellipse', w: 0.5, h: 0.5, feather: 0.05 } }
const grow = { mask: { shape: 'ellipse', w: 0.2, h: 0.2 }, keyframes: [{ prop: 'maskW', points: [{ t: 0, value: 0.2 }, { t: 1, value: 1 }] }] }

test('no mask: no plan', () => { assert.equal(planItemMask({}, 100, 100, 0, 1, 30, '/x'), null) })
test('a still mask is one PNG frame, looped', () => {
  const p = planItemMask(still, 200, 100, 0, 2, 30, '/d/m3')
  assert.equal(p.kind, 'still')
  assert.equal(p.path, '/d/m3.png')
  assert.deepEqual(p.inputArgs, ['-loop', '1', '-framerate', '30', '-t', '2', '-i', '/d/m3.png'])
})
test('a keyframed mask is a per-frame ffv1 file', () => {
  const p = planItemMask(grow, 200, 100, 0, 1, 10, '/d/m3')
  assert.equal(p.kind, 'frames')
  assert.equal(p.path, '/d/m3.mkv')
  assert.deepEqual(p.inputArgs, ['-i', '/d/m3.mkv'])
  assert.equal(p.frames, 11)
})
test('write: a still mask PNG is box-sized gray, white centre, black corner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-'))
  const p = planItemMask(still, 64, 64, 0, 1, 30, join(dir, 'm'))
  return writeItemMask(p).then(() => {
    assert.ok(existsSync(p.path))
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', p.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    assert.equal(r.stdout.length, 64 * 64)
    assert.ok(r.stdout[32 * 64 + 32] > 245)
    assert.ok(r.stdout[0] < 10)
  })
})
test('write: a growing mask covers more each frame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-'))
  const p = planItemMask(grow, 64, 64, 0, 1, 10, join(dir, 'm'))
  const t0 = Date.now()
  return writeItemMask(p).then(() => {
    console.log(`growing mask write: ${Date.now() - t0} ms`)
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', p.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
    const sum = (f) => r.stdout.subarray(f * 4096, (f + 1) * 4096).reduce((a, b) => a + b, 0)
    assert.equal(r.stdout.length, 11 * 4096)
    assert.ok(sum(10) > sum(5) && sum(5) > sum(0))
  })
})
test('write: feather blurs the edge (no hard step)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-'))
  const p = planItemMask({ mask: { shape: 'wipe', x: 0.5, feather: 0.1 } }, 100, 10, 0, 1, 30, join(dir, 'm'))
  return writeItemMask(p).then(() => {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', p.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    // sigma = 0.1 x min(100, 10) = 1 px; the edge sits between pixels 49 and 50
    const row = [...r.stdout.subarray(500, 600)]
    assert.ok(row[49] > 140 && row[49] < 235)
    assert.ok(row[50] > 20 && row[50] < 115)
    assert.ok(Math.abs(row[49] + row[50] - 255) < 25)
    assert.ok(row[40] > row[49] && row[60] < row[50])
    assert.ok(row[2] > 245 && row[97] < 10)
  })
})
test('write: a keyframed feather softens the edge frame by frame (sendcmd on gblur)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-'))
  const soften = { mask: { shape: 'wipe', x: 0.5, feather: 0.02 },
    keyframes: [{ prop: 'maskFeather', points: [{ t: 0, value: 0.02 }, { t: 1, value: 0.2 }] }] }
  const p = planItemMask(soften, 100, 10, 0, 1, 10, join(dir, 'm'))
  assert.equal(p.kind, 'frames')
  return writeItemMask(p).then(() => {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', p.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
    // sigma 0.2 px at frame 0, 2 px at frame 10: 4 px inside the edge the mask is still full at first, then dips
    const px = (f, x) => r.stdout[f * 1000 + 500 + x]
    assert.ok(px(0, 46) > 250)
    assert.ok(px(10, 46) < 250)
    assert.ok(px(10, 46) < px(5, 46) || px(5, 46) < 250)
  })
})

// The editor preview paints the mask as SVG (maskSvg, a true Gaussian); the
// export writes it with rasterizeMask + gblur. They must agree, including for a
// small shape with a big feather, where a thin filter region or too few gblur
// passes each cost tens of codes.
const hasRsvg = !spawnSync('rsvg-convert', ['--version']).error
test('preview SVG and export gblur agree along a row (small shape, feather 0.2)', { skip: !hasRsvg }, async () => {
  const B = 400
  const item = { mask: { shape: 'ellipse', w: 0.25, h: 0.25, feather: 0.2 } }
  const dir = mkdtempSync(join(tmpdir(), 'mask-parity-'))
  writeFileSync(join(dir, 'm.svg'), maskSvg(maskAt(item, 0), B, B))
  const svgRun = spawnSync('rsvg-convert', ['-w', String(B), '-h', String(B), '-o', join(dir, 'm.png'), join(dir, 'm.svg')])
  assert.equal(svgRun.status, 0, String(svgRun.stderr))
  const raw = (p) => spawnSync(FFMPEG, ['-v', 'error', '-i', p, '-vf', 'format=gray', '-f', 'rawvideo', '-']).stdout
  const svg = raw(join(dir, 'm.png'))
  const plan = planItemMask(item, B, B, 0, 1, 30, join(dir, 'e'))
  await writeItemMask(plan)
  const exp = raw(plan.path)
  assert.equal(svg.length, B * B)
  assert.equal(exp.length, B * B)
  let worst = 0
  for (let x = 0; x < B; x += 4) worst = Math.max(worst, Math.abs(svg[200 * B + x] - exp[200 * B + x]))
  assert.ok(worst <= 6, `worst row difference ${worst} codes`)
})

// ── Task 4: masks in the export graph ───────────────────────────────────────
// encodeSegment wires each masked clip's pre-pass file in as its own input,
// right after the clip's, and multiplies it into the clip's alpha before the
// clip is animated, rotated or composited.

const MASK = { shape: 'ellipse', w: 0.5, h: 0.5 }
const SEG_OUT = '/tmp/s616/seg-0003.mp4'
const maskPath = (idx, ext = 'png') => `/tmp/s616/seg-0003.mask-${idx}.${ext}`
const imageItem = (over = {}) => ({ type: 'image', src: '/bg.png', start: 0, end: 2, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, ...over })
const videoItem = (over = {}) => ({ type: 'video', src: '/pip.mp4', start: 0, end: 2, inPoint: 0, trackIdx: 1,
  scale: 0.5, offsetX: 0, offsetY: 0, opacity: 1, muted: false, ...over })
const laterItem = { type: 'video', src: '/top.mp4', start: 0, end: 2, inPoint: 0, trackIdx: 2,
  scale: 0.3, offsetX: 20, offsetY: 20, opacity: 1, muted: false }
const segOf = (items, over = {}) => ({ start: 0, end: 2, items, overlays: [], vw: 1920, vh: 1080, fps: 30, ...over })
const dry = (seg) => encodeSegment(seg, SEG_OUT, { _dryRun: true })
/** The args right after `-i <src>`, as many as `n`. */
const after = (args, src, n) => { const i = args.indexOf(src); return args.slice(i + 1, i + 1 + n) }

test('graph: a masked image and a masked video each read their mask right after their own input', async () => {
  const r = await dry(segOf([imageItem({ mask: MASK }), videoItem({ mask: MASK }), laterItem]))
  // canvas 0, image 1, its mask 2, video 3, its mask 4, the later clip 5
  assert.deepEqual(after(r.args, '/bg.png', 7), ['-loop', '1', '-framerate', '30', '-t', '2', '-i'])
  assert.equal(after(r.args, '/bg.png', 8)[7], maskPath(1))
  assert.deepEqual(after(r.args, '/pip.mp4', 8), ['-loop', '1', '-framerate', '30', '-t', '2', '-i', maskPath(3)])
  const graph = r.filterParts.join(';')
  assert.ok(graph.includes('alphamerge'))
  assert.ok(graph.includes('blend=all_mode=multiply'))
  assert.ok(graph.includes('[2:v]format=gray,setpts=PTS-STARTPTS[mk2]'))
  assert.ok(graph.includes('[4:v]format=gray,setpts=PTS-STARTPTS[mk4]'))
  // The later clip is shifted by the two mask inputs, video and audio alike.
  assert.ok(r.filterParts.some(p => p.startsWith('[5:v]')))
  assert.ok(r.filterParts.some(p => p.startsWith('[5:a:0]')))
  assert.ok(!r.filterParts.some(p => p.startsWith('[3:v]') && p.includes('scale=576:324')))
  assert.deepEqual(r.maskJobs.map(j => j.path), [maskPath(1), maskPath(3)])
  assert.deepEqual(r.maskJobs.map(j => [j.boxW, j.boxH]), [[1920, 1080], [960, 540]])
})

test('graph: the image mask consumes the fitted image, before the overlay', async () => {
  const r = await dry(segOf([imageItem({ mask: MASK })]))
  const parts = r.filterParts
  const head = parts.findIndex(p => p.startsWith('[1:v]'))
  assert.ok(parts[head].endsWith('format=rgba[imgb1]'), parts[head])
  assert.equal(parts[head + 1], '[imgb1]split=2[mc2][ma2]')
  const tail = parts.findIndex(p => p.startsWith('[imgm1]'))
  assert.equal(parts[tail], '[imgm1]setpts=PTS-STARTPTS[img1]')
  const ov = parts.findIndex(p => p.includes('[img1]overlay='))
  assert.ok(head < tail && tail < ov)
})

test('graph: a masked video is padded transparent, then masked, then rotated', async () => {
  const r = await dry(segOf([videoItem({ mask: MASK, rotation: 30 })]))
  const parts = r.filterParts
  const head = parts.find(p => p.startsWith('[1:v]'))
  assert.ok(head.endsWith('format=yuva420p,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black@0.0[vidb1]'), head)
  assert.ok(parts.includes('[vidb1]split=2[mc2][ma2]'))
  assert.ok(parts.includes('[mc2][mam2]alphamerge[vidm1]'))
  assert.ok(parts.some(p => p.startsWith('[vidm1]format=yuva420p,rotate=') && p.endsWith('[vid1]')))
})

test('graph: a masked video with no rotation goes straight from the mask to [vid]', async () => {
  const r = await dry(segOf([videoItem({ mask: MASK })]))
  assert.ok(r.filterParts.includes('[mc2][mam2]alphamerge[vid1]'))
  assert.ok(!r.filterParts.some(p => p.includes('[vidm1]')))
})

test('graph: keyframed geometry puts the mask after the pad, before the animated scale, on the PEAK box', async () => {
  const kf = [{ prop: 'scale', points: [{ t: 0, value: 0.25 }, { t: 2, value: 0.5 }] }]
  const r = await dry(segOf([videoItem({ mask: MASK, keyframes: kf })]))
  const parts = r.filterParts
  const head = parts.findIndex(p => p.startsWith('[1:v]'))
  const pad = parts[head].match(/pad=(\d+):(\d+):/)
  assert.ok(pad && parts[head].endsWith('[vidb1]'), parts[head])
  const merge = parts.indexOf('[mc2][mam2]alphamerge[vidm1]')
  const anim = parts.findIndex(p => p.startsWith('[vidm1]scale=w=\'') && p.includes(':eval=frame'))
  assert.ok(head < merge && merge < anim, `${head} ${merge} ${anim}`)
  assert.ok(!parts[head].includes('eval=frame'))
  const [job] = r.maskJobs
  assert.deepEqual([job.boxW, job.boxH], [Number(pad[1]), Number(pad[2])])
  assert.deepEqual([job.boxW, job.boxH], [960, 540]) // the peak (scale 0.5), not t=0's 480x270
})

test('graph: a 10-bit pad masks in gray10le', async () => {
  const r = await dry(segOf([videoItem({ mask: MASK })], { colorSpace: 'hdr_hlg' }))
  assert.ok(r.filterParts.some(p => p.startsWith('[1:v]') && p.includes('format=yuva444p10le,pad=')))
  assert.ok(r.filterParts.includes('[2:v]format=gray10le,setpts=PTS-STARTPTS[mk2]'))
})

test('graph: a keyframed mask reads its per-frame file', async () => {
  const kf = [{ prop: 'maskX', points: [{ t: 0, value: 0.2 }, { t: 2, value: 0.8 }] }]
  const r = await dry(segOf([imageItem({ mask: MASK, keyframes: kf })]))
  assert.deepEqual(after(r.args, '/bg.png', 2), ['-i', maskPath(1, 'mkv')])
  assert.equal(r.maskJobs[0].kind, 'frames')
})

test('graph: a culled clip gets no mask input and no job; the next clip keeps idx + 1', async () => {
  const r = await dry(segOf([videoItem({ mask: MASK }), imageItem({ mask: MASK, trackIdx: 2 })], { opaqueVideo: true }))
  assert.ok(!r.args.some(a => String(a).includes('.mask-')))
  assert.equal(r.maskJobs ?? undefined, undefined)
  // The culled video keeps its input (index 1) for its audio.
  assert.ok(r.filterParts.some(p => p.startsWith('[1:a:0]')))
})

test('graph: without a mask nothing changes (no mask input, no job, no key)', async () => {
  const r = await dry(segOf([imageItem(), videoItem(), laterItem]))
  assert.ok(!r.args.some(a => String(a).includes('.mask-')))
  assert.ok(!('maskJobs' in r))
  assert.ok(!r.filterParts.join(';').includes('alphamerge'))
  // canvas 0, image 1, video 2, later 3: the indices it always had
  assert.ok(r.filterParts.some(p => p.startsWith('[3:v]')))
})

// ── Real ffmpeg: a red square masked to an ellipse over blue ────────────────
const ffOk = spawnSync(FFMPEG, ['-version']).status === 0
const solid = (dir, name, color) => {
  const p = join(dir, name)
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x64`, '-frames:v', '1', '-update', '1', p])
  assert.equal(r.status, 0, String(r.stderr))
  return p
}
async function maskedFrame(invert) {
  const dir = mkdtempSync(join(tmpdir(), 'mask-graph-'))
  const blue = solid(dir, 'blue.png', 'blue')
  const red = solid(dir, 'red.png', 'red')
  const seg = { start: 0, end: 0.5, vw: 64, vh: 64, fps: 30, overlays: [], items: [
    { type: 'image', src: blue, start: 0, end: 0.5, trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 },
    { type: 'image', src: red, start: 0, end: 0.5, trackIdx: 1, scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
      mask: { ...MASK, invert } },
  ] }
  const out = join(dir, 'seg-0000.mp4')
  await encodeSegment(seg, out)
  assert.deepEqual(readdirSync(dir).filter(f => f.includes('mask-')), [], 'the mask file is scratch and is gone')
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  assert.equal(r.stdout.length, 64 * 64 * 3, String(r.stderr))
  const px = (x, y) => [...r.stdout.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)]
  return { centre: px(32, 32), corner: px(1, 1) }
}
test('ffmpeg: an ellipse mask shows the red item in the middle and the blue under it at the corner', { skip: !ffOk }, async () => {
  const { centre, corner } = await maskedFrame(false)
  assert.ok(centre[0] > 200 && centre[2] < 60, `centre ${centre}`)
  assert.ok(corner[2] > 200 && corner[0] < 60, `corner ${corner}`)
})
test('ffmpeg: inverted, the hole is in the middle', { skip: !ffOk }, async () => {
  const { centre, corner } = await maskedFrame(true)
  assert.ok(centre[2] > 200 && centre[0] < 60, `centre ${centre}`)
  assert.ok(corner[0] > 200 && corner[2] < 60, `corner ${corner}`)
})

test('ffmpeg: mask files are removed after the encode, success or failure', { skip: !ffOk }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-clean-'))
  const blue = solid(dir, 'blue.png', 'blue')
  const red = solid(dir, 'red.png', 'red')
  const keep = new Set(['blue.png', 'red.png'])
  const item = (src, trackIdx, over = {}) => ({ type: 'image', src, start: 0, end: 0.5, trackIdx, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, ...over })
  const seg = (top) => ({ start: 0, end: 0.5, vw: 64, vh: 64, fps: 30, overlays: [], items: [item(blue, 0), top] })
  // a keyframed mask is a .mkv, a still one a .png: both must go
  const moving = item(red, 1, { mask: MASK, keyframes: [{ prop: 'maskW', points: [{ t: 0, value: 0.2 }, { t: 0.5, value: 0.8 }] }] })
  await encodeSegment(seg(moving), join(dir, 'seg-0000.mp4'))
  await encodeSegment(seg(item(red, 1, { mask: MASK })), join(dir, 'seg-0001.mp4'))
  assert.deepEqual(readdirSync(dir).filter(f => !keep.has(f)).sort(), ['seg-0000.mp4', 'seg-0001.mp4'])
  // a forced failure after the mask is written (the source vanished): still no mask left behind
  await assert.rejects(encodeSegment(seg(item(join(dir, 'gone.png'), 1, { mask: MASK })), join(dir, 'seg-0002.mp4')))
  assert.deepEqual(readdirSync(dir).filter(f => f.includes('mask-')), [])
})

// A 10-bit item keeps its 10 bits through the mask multiply: no auto-scaler may
// drop it to 8-bit before the alpha is put back. Y/U/V are not divisible by 4,
// so an 8-bit round trip shows.
test('ffmpeg: a masked 10-bit item keeps its colour planes and gets the mask as alpha, exactly', { skip: !ffOk }, async () => {
  const W = 64, H = 2
  const u16 = (vals) => { const b = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b }
  const plane = (v) => new Array(W * H).fill(v)
  const itemRaw = u16([...plane(601), ...plane(403), ...plane(702), ...plane(1023)])
  const ramp = Array.from({ length: W * H }, (_, i) => (i % W) * 16 + 3)
  const dir = mkdtempSync(join(tmpdir(), 'mask-10bit-'))
  writeFileSync(join(dir, 'item.raw'), itemRaw)
  writeFileSync(join(dir, 'mask.raw'), u16(ramp))
  const graph = [...maskFilterParts('[0:v]', 1, '[o]', { tenBit: true })].join(';')
  const r = spawnSync(FFMPEG, ['-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'yuva444p10le', '-s', `${W}x${H}`, '-i', join(dir, 'item.raw'),
    '-f', 'rawvideo', '-pix_fmt', 'gray10le', '-s', `${W}x${H}`, '-i', join(dir, 'mask.raw'),
    '-filter_complex', graph, '-map', '[o]', '-f', 'rawvideo', '-pix_fmt', 'yuva444p10le', '-frames:v', '1', '-'], { maxBuffer: 1 << 22 })
  assert.equal(r.status, 0, String(r.stderr))
  const out = new Uint16Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
  assert.equal(out.length, W * H * 4)
  const n = W * H
  assert.ok(out.subarray(0, n).every(v => v === 601), 'Y unchanged')
  assert.ok(out.subarray(n, 2 * n).every(v => v === 403), 'U unchanged')
  assert.ok(out.subarray(2 * n, 3 * n).every(v => v === 702), 'V unchanged')
  assert.deepEqual([...out.subarray(3 * n)], ramp, 'alpha equals the mask exactly')
})

test('write: a long keyframed feather keeps every ffmpeg argument under 32,767 characters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mask-long-'))
  const ramp = { mask: { shape: 'wipe', x: 0.5, feather: 0.02 },
    keyframes: [{ prop: 'maskFeather', points: [{ t: 0, value: 0.02 }, { t: 20, value: 0.3 }] }] }
  const p = planItemMask(ramp, 400, 300, 0, 20, 60, join(dir, 'm'))
  assert.equal(p.frames, 1201)
  const w = prepareMaskWrite(p)
  try {
    assert.ok(w.path && existsSync(w.path), 'the graph is written to a script file')
    assert.ok(readFileSync(w.path, 'utf8').length > 32767, 'the graph itself would not fit on a command line')
    assert.ok(w.args.every(a => a.length <= 32767), 'no argument is over the Windows limit')
    assert.ok(w.args.includes('-/filter_complex'))
    assert.ok(!w.args.includes('-vf'))
  } finally { w.cleanup() }
  assert.ok(!existsSync(w.path), 'cleanup removes the script')
})
