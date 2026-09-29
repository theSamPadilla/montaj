// PV55: the crop is decided in PIXELS, not strings. The zoom case exists because
// a chain with `format=rgba` between the eval=frame scale and the fixed crop
// passes every string test and silently freezes the window at the first frame's
// size (measured, PV55 T1): only a pixel read at a later frame catches it.
//
// A missing ffmpeg fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1 (PV52).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildImageItemFilterParts, probeImageDisplaySize } from '../encode-segment.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CW = 180
const CH = 320
// Source 640x360: four 160px stripes, red | lime | blue | white. Gray (BT.601): ~76 | ~150 | ~29 | ~255.
const isRed = (y) => y > 55 && y < 100
const isLime = (y) => y > 125 && y < 175
const isBlue = (y) => y < 50
const isWhite = (y) => y > 225
const isBg = (y) => y < 20

function haveFfmpeg(t) {
  if (spawnSync(FFMPEG, ['-version']).status === 0) return true
  if (process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') assert.fail(`${FFMPEG} is not runnable. Point MONTAJ_FFMPEG/MONTAJ_FFPROBE at the managed build (~/.local/share/montaj/models/ffmpeg is a directory; the binaries are inside), or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
  t.skip(`${FFMPEG} is not runnable`)
  return false
}

function stripes(dir, ext) {
  const out = join(dir, `stripes.${ext}`)
  const tail = ext === 'jpg' ? ',format=yuvj420p[out]' : ',format=rgba[out]'
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=red:size=160x360', '-f', 'lavfi', '-i', 'color=lime:size=160x360',
    '-f', 'lavfi', '-i', 'color=blue:size=160x360', '-f', 'lavfi', '-i', 'color=white:size=160x360',
    '-filter_complex', `[0:v][1:v][2:v][3:v]hstack=inputs=4${tail}`,
    '-map', '[out]', '-frames:v', '1', ...(ext === 'jpg' ? ['-q:v', '2'] : []), out], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return out
}

/** Luma of canvas pixel (x, y) at segment time `at`, through the REAL chain. */
function probeY(item, x, y, at = 0) {
  const { inputArgs, filterParts, newVideoLabel } = buildImageItemFilterParts(item, CW, CH, 1, '[canvas]', 1, 0)
  const fc = ['[0:v]format=rgba[canvas]', ...filterParts,
    `${newVideoLabel}trim=start=${at},format=gray,crop=1:1:${x}:${y}:exact=1,signalstats,metadata=mode=print:file=-`].join(';')
  const r = spawnSync(FFMPEG, ['-y', '-v', 'info', '-f', 'lavfi', '-i', `color=black:size=${CW}x${CH}`,
    ...inputArgs, '-filter_complex', fc, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`probe failed at (${x},${y}) t=${at}:\n${r.stderr}`)
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.stdout)
  if (!m) throw new Error(`no YAVG at (${x},${y}) t=${at}:\n${r.stdout}\n${r.stderr}`)
  return Number(m[1])
}

const W916 = 0.31640625 // a 9:16 window, full height, out of 16:9
const lin = (prop, a, b) => ({ prop, points: [{ t: 0, value: a }, { t: 0.5, value: b }] })

for (const ext of ['png', 'jpg']) {
  test(`${ext}: a keyframed pan shows the left stripe at t0 and the right stripe after the last key`, { timeout: 60_000 }, (t) => {
    if (!haveFfmpeg(t)) return
    const dir = mkdtempSync(join(tmpdir(), 'pv55-pan-'))
    try {
      const item = { src: stripes(dir, ext), scale: 1, probedWidth: 640, probedHeight: 360,
        keyframes: [lin('cropX', 0, 1 - W916), lin('cropY', 0, 0), lin('cropW', W916, W916), lin('cropH', 1, 1)] }
      assert.ok(isRed(probeY(item, 90, 160, 0)), 'centre is red at t0')
      assert.ok(isWhite(probeY(item, 90, 160, 0.6)), 'centre is white after the last key')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test(`${ext}: a keyframed zoom narrows the window inside one stripe (the stale-clamp guard)`, { timeout: 60_000 }, (t) => {
    if (!haveFfmpeg(t)) return
    const dir = mkdtempSync(join(tmpdir(), 'pv55-zoom-'))
    try {
      // t0: the centred 9:16 window (218.75..421.25 px, lime | blue). t1: a 64x113.8 px
      // 9:16 window at 339.2..403.2 px, inside the BLUE stripe, i.e. far right of the
      // union's left edge (218 px). That distance is what makes this a guard: the fixed
      // crop's x then lands at ~315 px of the resized union, well past the first frame's
      // clamp (~2 px), so a stale clamp freezes the window near 218 px and reads lime.
      // A window zoomed in at the union's left edge (x ~0) passes under the trap too:
      // MEASURED (PV55 T5), zooming into lime at 208 px read identical pixels either way.
      // DO NOT simplify this geometry. A t1 window near the union's left edge (x ~0)
      // makes this test blind to the stale-clamp trap (MEASURED, PV55 T5). If these
      // numbers ever change, re-prove the test FAILS with `format=rgba` moved between
      // the eval=frame scale and the fixed crop, in a scratch mirror, never the tree.
      const item = { src: stripes(dir, ext), scale: 1, probedWidth: 640, probedHeight: 360,
        keyframes: [lin('cropX', 0.341796875, 0.53), lin('cropY', 0, 0.342), lin('cropW', W916, 0.1), lin('cropH', 1, 0.31605)] }
      assert.ok(isLime(probeY(item, 45, 160, 0)), 'left quarter is lime at t0')
      assert.ok(isBlue(probeY(item, 135, 160, 0)), 'right quarter is blue at t0')
      assert.ok(isBlue(probeY(item, 45, 160, 0.6)), 'left quarter is blue once zoomed')
      assert.ok(isBlue(probeY(item, 135, 160, 0.6)), 'right quarter is blue once zoomed')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test(`${ext}: a still crop takes effect (cover): the right half shows blue | white`, { timeout: 60_000 }, (t) => {
    if (!haveFfmpeg(t)) return
    const dir = mkdtempSync(join(tmpdir(), 'pv55-still-'))
    try {
      const src = stripes(dir, ext)
      assert.ok(isLime(probeY({ src, scale: 1 }, 45, 160)), 'control: uncropped cover shows lime at the left quarter')
      const item = { src, scale: 1, sourceCrop: { x: 0.5, y: 0, w: 0.5, h: 1 } }
      assert.ok(isBlue(probeY(item, 45, 160)), 'left quarter blue')
      assert.ok(isWhite(probeY(item, 135, 160)), 'right quarter white')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test(`${ext}: a still crop with fit contain letterboxes transparently`, { timeout: 60_000 }, (t) => {
    if (!haveFfmpeg(t)) return
    const dir = mkdtempSync(join(tmpdir(), 'pv55-contain-'))
    try {
      // 240x180 px crop (red|lime), contained: 180x135 centred vertically.
      const item = { src: stripes(dir, ext), scale: 1, fit: 'contain', sourceCrop: { x: 0, y: 0, w: 0.375, h: 0.5 } }
      assert.ok(isLime(probeY(item, 160, 160)), 'inside the crop, right side is lime')
      assert.ok(isBg(probeY(item, 90, 20)), 'above the crop the black canvas shows through')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test(`${ext}: a reframe-shaped centred crop renders what no crop renders`, { timeout: 60_000 }, (t) => {
    if (!haveFfmpeg(t)) return
    const dir = mkdtempSync(join(tmpdir(), 'pv55-reframe-'))
    try {
      const src = stripes(dir, ext)
      const cropped = { src, scale: 1, sourceCrop: { x: 0.341796875, y: 0, w: W916, h: 1 } }
      for (const x of [20, 60, 120, 160]) {
        const a = probeY({ src, scale: 1 }, x, 160)
        const b = probeY(cropped, x, 160)
        assert.ok(Math.abs(a - b) <= 3, `x=${x}: ${a} vs ${b}`)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('probeImageDisplaySize reads an EXIF-rotated JPEG at its DISPLAY size, as ffmpeg decodes it', (t) => {
  if (!haveFfmpeg(t)) return
  const fx = join(HERE, 'fixtures', 'exif-orientation-6.jpg')
  assert.deepEqual(probeImageDisplaySize(fx), { width: 40, height: 80 })
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=16x16', '-loop', '1', '-t', '0.04', '-i', fx,
    '-filter_complex', '[1:v]null[o]', '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  assert.equal(r.stdout.length, 40 * 80, 'ffmpeg itself decodes it 40x80')
})
