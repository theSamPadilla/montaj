// §669 in PIXELS, through the real ffmpeg: a video item's `fit: 'cover'`
// leaves no bars, alone, with a sourceCrop and with a keyframed crop, in
// render's chain and in sample_frame. Synthetic clips only, made here.
//
// A missing ffmpeg fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1 (PV52).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildVideoItemFilterParts } from '../encode-segment.js'
import { sampleFrame } from '../sample-frame.js'

const REASON = spawnSync(FFMPEG, ['-version']).status === 0 ? false : `${FFMPEG} is not runnable`
if (REASON && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${REASON}. Set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
const SKIP = REASON ? { skip: REASON } : {}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${r.stderr}`)
}

let dir
let red34      // a 3:4 solid red clip
let halves34   // a 3:4 clip, red left half, blue right half
before(() => {
  if (REASON) return
  dir = mkdtempSync(join(tmpdir(), 'c5-video-fit-'))
  red34 = join(dir, 'red34.mp4')
  ff(['-f', 'lavfi', '-i', 'color=red:size=300x400:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red34])
  halves34 = join(dir, 'halves34.mp4')
  ff(['-f', 'lavfi', '-i', 'color=red:size=150x400:rate=10:duration=1', '-f', 'lavfi', '-i', 'color=blue:size=150x400:rate=10:duration=1',
    '-filter_complex', '[0:v][1:v]hstack=inputs=2[out]', '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', halves34])
})
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const SDR = { segStart: 0, duration: 1, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true, sdrCurve: null }

/** RGB of canvas pixel (x, y) through the REAL chain buildVideoItemFilterParts emits. */
function chainPixel(item, cw, ch, x, y) {
  const { inputArgs, filterParts, newVideoLabel } = buildVideoItemFilterParts(item, cw, ch, 1, '[canvas]', SDR)
  const fc = ['[0:v]format=yuv420p[canvas]', ...filterParts, `${newVideoLabel}crop=1:1:${x}:${y}:exact=1,format=rgb24[px]`].join(';')
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=black:size=${cw}x${ch}:rate=10`,
    ...inputArgs, '-filter_complex', fc, '-map', '[px]', '-frames:v', '1', '-f', 'rawvideo', '-'], { timeout: 60_000 })
  if (r.status !== 0) throw new Error(`chain failed at (${x},${y}):\n${r.stderr}`)
  return [...r.stdout.subarray(0, 3)]
}

/** RGB of pixel (x, y) of a PNG. */
function pngPixel(png, x, y) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y}:exact=1,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { timeout: 30_000 })
  if (r.status !== 0) throw new Error(`read ${png} failed:\n${r.stderr}`)
  return [...r.stdout.subarray(0, 3)]
}

const isRed = ([r, g, b]) => r > 180 && g < 70 && b < 70
const isBlue = ([r, g, b]) => b > 180 && r < 70 && g < 70
const isBlack = ([r, g, b]) => r < 30 && g < 30 && b < 30

function project(item, resolution) {
  const pj = join(dir, `project-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(pj, JSON.stringify({
    settings: { resolution, fps: 10 },
    tracks: [{ type: 'video', items: [{ id: 'v', type: 'video', start: 0, end: 1, inPoint: 0, outPoint: 1, ...item }] }],
  }))
  return pj
}

test('§669 render: a 3:4 clip with fit cover leaves no bars in a 9:16 frame', { timeout: 60_000, ...SKIP }, () => {
  const item = { type: 'video', src: red34, start: 0, duration: 1, scale: 1, offsetX: 0, offsetY: 0,
    probedWidth: 300, probedHeight: 400, fit: 'cover' }
  for (const [x, y] of [[2, 2], [177, 2], [2, 317], [177, 317]]) assert.ok(isRed(chainPixel(item, 180, 320, x, y)), `(${x},${y})`)
  // The control: contain letterboxes it.
  assert.ok(isBlack(chainPixel({ ...item, fit: 'contain' }, 180, 320, 2, 2)))
})

test('§669 sample_frame: a 3:4 clip with fit cover leaves no bars in a 9:16 frame', { timeout: 60_000, ...SKIP }, async () => {
  const out = join(dir, 'cover.png')
  await sampleFrame({ projectJson: project({ src: red34, sourceWidth: 300, sourceHeight: 400, fit: 'cover' }, [180, 320]), atSeconds: 0.5, outPath: out })
  for (const [x, y] of [[2, 2], [177, 2], [2, 317], [177, 317]]) assert.ok(isRed(pngPixel(out, x, y)), `(${x},${y})`)
  const control = join(dir, 'contain.png')
  await sampleFrame({ projectJson: project({ src: red34, sourceWidth: 300, sourceHeight: 400 }, [180, 320]), atSeconds: 0.5, outPath: control })
  assert.ok(isBlack(pngPixel(control, 2, 2)))
})

test('§669 cover plus sourceCrop: the cropped half covers the frame, in render and sample_frame', { timeout: 60_000, ...SKIP }, async () => {
  const fields = { sourceWidth: 300, sourceHeight: 400, sourceCrop: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: 'cover' }
  const item = { type: 'video', src: halves34, start: 0, duration: 1, scale: 1, offsetX: 0, offsetY: 0, probedWidth: 300, probedHeight: 400, ...fields }
  const out = join(dir, 'cover-crop.png')
  await sampleFrame({ projectJson: project({ src: halves34, ...fields }, [180, 320]), atSeconds: 0.5, outPath: out })
  for (const [x, y] of [[2, 2], [177, 2], [2, 160], [177, 160], [2, 317], [177, 317]]) {
    assert.ok(isBlue(chainPixel(item, 180, 320, x, y)), `render (${x},${y})`)
    assert.ok(isBlue(pngPixel(out, x, y)), `sample (${x},${y})`)
  }
})

test('§669 cover with a keyframed crop: the moving window covers the frame, no bars', { timeout: 60_000, ...SKIP }, () => {
  const lin = (prop, a, b) => ({ prop, points: [{ t: 0, value: a }, { t: 0.5, value: b }] })
  const keyframes = [lin('cropX', 0.5, 0.5), lin('cropY', 0, 0), lin('cropW', 0.5, 0.5), lin('cropH', 1, 1)]
  const item = { type: 'video', src: halves34, start: 0, duration: 1, scale: 1, offsetX: 0, offsetY: 0, fit: 'cover',
    sourceWidth: 300, sourceHeight: 400, probedWidth: 300, probedHeight: 400, probedPixFmt: 'yuv420p', keyframes }
  for (const [x, y] of [[2, 2], [177, 2], [2, 160], [177, 160], [2, 317], [177, 317]]) {
    assert.ok(isBlue(chainPixel(item, 180, 320, x, y)), `(${x},${y})`)
  }
})
