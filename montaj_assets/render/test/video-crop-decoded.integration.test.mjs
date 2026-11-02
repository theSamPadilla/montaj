// §668 in PIXELS, through the real ffmpeg: a crop sized for the original
// applied to a rotated, downscaled converted copy, in render's chain and in
// sample_frame. Synthetic clips only, made here.
//
// A missing ffmpeg fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1 (PV52).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildVideoItemFilterParts, probeVideoGeometry } from '../encode-segment.js'
import { sampleFrame } from '../sample-frame.js'

const REASON = spawnSync(FFMPEG, ['-version']).status === 0 ? false : `${FFMPEG} is not runnable`
if (REASON && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${REASON}. Set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
const SKIP = REASON ? { skip: REASON } : {}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${r.stderr}`)
}

let dir
let original   // stored 1920x1440, rotation -90: 1440x1920 as shown
let copy       // its converted copy, upright 1308x1744
before(() => {
  if (REASON) return
  dir = mkdtempSync(join(tmpdir(), 'c5-video-crop-decoded-'))
  const base = join(dir, 'base.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1920x1440:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base])
  original = join(dir, 'IMG_9140.mov')
  ff(['-display_rotation:v:0', '-90', '-i', base, '-c', 'copy', original])
  copy = join(dir, 'IMG_9140_normalized.mp4')
  ff(['-i', original, '-vf', 'scale=1308:1744', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', copy])
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

function project(item, resolution) {
  const pj = join(dir, `project-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(pj, JSON.stringify({
    settings: { resolution, fps: 10 },
    tracks: [{ type: 'video', items: [{ id: 'v', type: 'video', start: 0, end: 1, inPoint: 0, outPoint: 1, ...item }] }],
  }))
  return pj
}

const CROP = { x: 0.08, y: 0, w: 0.75, h: 1 }

test('the synthetic clips are the §668 shapes', SKIP, () => {
  assert.deepEqual(probeVideoGeometry(original)?.width, 1440)
  assert.deepEqual(probeVideoGeometry(original)?.height, 1920)
  assert.deepEqual([probeVideoGeometry(copy)?.width, probeVideoGeometry(copy)?.height], [1308, 1744])
})

test('§668 render: a crop for 1440x1920 on the 1308x1744 copy encodes', { timeout: 60_000, ...SKIP }, () => {
  const g = probeVideoGeometry(copy)
  const item = { type: 'video', src: copy, start: 0, duration: 1, scale: 1, offsetX: 0, offsetY: 0,
    sourceWidth: 1440, sourceHeight: 1920, sourceCrop: CROP, probedWidth: g.width, probedHeight: g.height }
  chainPixel(item, 180, 320, 90, 160)
})

test('§668 sample_frame: a crop for the original samples from its converted copy', { timeout: 60_000, ...SKIP }, async () => {
  const pj = project({ src: original, normalizedSrc: copy, normalizedInPoint: 0, sourceWidth: 1440, sourceHeight: 1920, sourceCrop: CROP }, [180, 320])
  const out = join(dir, 'crop-copy.png')
  await sampleFrame({ projectJson: pj, atSeconds: 0.5, outPath: out })
  pngPixel(out, 90, 160)
})

test('§668 sample_frame: the same crop on the rotated original samples too', { timeout: 60_000, ...SKIP }, async () => {
  const pj = project({ src: original, sourceWidth: 1440, sourceHeight: 1920, sourceCrop: CROP }, [180, 320])
  const out = join(dir, 'crop-original.png')
  await sampleFrame({ projectJson: pj, atSeconds: 0.5, outPath: out })
  pngPixel(out, 90, 160)
})
