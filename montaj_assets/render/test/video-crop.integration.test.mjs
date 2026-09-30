// PV55 phase 2: a video's keyframed crop, decided in PIXELS, through the real
// chain buildVideoItemFilterParts emits, on a 1 s four-stripe VIDEO.
//
// The zoom cases exist for the stale-clamp trap (MEASURED, PV55 T1): `crop`
// clamps x/y against its INPUT LINK's size, which straight after an eval=frame
// `scale` is the current frame, and behind ANY other filter is the first
// frame's. A chain with a filter between them passes every string test and
// freezes a zoom-in near the union's origin; only a pixel read at a later
// frame, with the target FAR from that origin, catches it.
//
// A missing capability fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1 (PV52).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildVideoItemFilterParts } from '../encode-segment.js'

const CW = 180
const CH = 320
// Source 640x360: four 160px stripes, red | lime | blue | white. Luma: ~76 | ~150 | ~29 | ~255.
const isRed = (y) => y > 55 && y < 100
const isLime = (y) => y > 125 && y < 175
const isBlue = (y) => y < 50
const isWhite = (y) => y > 225

function capabilityReason() {
  if (spawnSync(FFMPEG, ['-version']).status !== 0) return `${FFMPEG} is not runnable`
  const filters = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/^[A-Z. ]+ zscale\b/m.test(filters) || !/^[A-Z. ]+ lut3d\b/m.test(filters)
      || !/^[A-Z. ]+ signalstats\b/m.test(filters) || !/\blibx264\b/.test(encoders)) {
    return `${FFMPEG} lacks zscale + lut3d + signalstats + libx264`
  }
  return false
}
const REASON = capabilityReason()
if (REASON && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${REASON}. Point MONTAJ_FFMPEG/MONTAJ_FFPROBE at the managed build (~/.local/share/montaj/models/ffmpeg is a directory; the binaries are inside), or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
const SKIP = REASON ? { skip: REASON } : {}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${r.stderr}`)
}

let dir
let clip
before(() => {
  if (REASON) return
  dir = mkdtempSync(join(tmpdir(), 'pv55-video-crop-'))
  const png = join(dir, 'stripes.png')
  ff(['-f', 'lavfi', '-i', 'color=red:size=160x360', '-f', 'lavfi', '-i', 'color=lime:size=160x360',
    '-f', 'lavfi', '-i', 'color=blue:size=160x360', '-f', 'lavfi', '-i', 'color=white:size=160x360',
    '-filter_complex', '[0:v][1:v][2:v][3:v]hstack=inputs=4,format=rgba[out]', '-map', '[out]', '-frames:v', '1', png])
  clip = join(dir, 'stripes.mp4')
  ff(['-loop', '1', '-t', '1', '-i', png, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip])
})
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const SDR = { segStart: 0, duration: 1, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true, sdrCurve: null }
const vid = (keyframes) => ({ type: 'video', src: clip, start: 0, duration: 1, scale: 1, offsetX: 0, offsetY: 0,
  sourceWidth: 640, sourceHeight: 360, keyframes })

/** The chain, with console.warn quiet (the 1/S branch warns by design). */
function chainParts(item, opts) {
  const warn = console.warn
  console.warn = () => {}
  try { return buildVideoItemFilterParts(item, CW, CH, 1, '[canvas]', { ...SDR, ...opts }) } finally { console.warn = warn }
}

/** Luma of canvas pixel (x, y) at segment time `at`, through the REAL chain. */
function probeY(item, x, y, at = 0, opts = {}) {
  const { inputArgs, filterParts, newVideoLabel } = chainParts(item, opts)
  const fc = ['[0:v]format=yuv420p[canvas]', ...filterParts,
    `${newVideoLabel}trim=start=${at},format=gray,crop=1:1:${x}:${y}:exact=1,signalstats,metadata=mode=print:file=-`].join(';')
  const r = spawnSync(FFMPEG, ['-y', '-v', 'info', '-f', 'lavfi', '-i', `color=black:size=${CW}x${CH}:rate=25`,
    ...inputArgs, '-filter_complex', fc, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`probe failed at (${x},${y}) t=${at}:\n${r.stderr}`)
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.stdout)
  if (!m) throw new Error(`no YAVG at (${x},${y}) t=${at}:\n${r.stdout}\n${r.stderr}`)
  return Number(m[1])
}

const W916 = 0.31640625 // a 9:16 window, full height, out of 16:9
const lin = (prop, a, b) => ({ prop, points: [{ t: 0, value: a }, { t: 0.5, value: b }] })
const PAN = [lin('cropX', 0, 1 - W916), lin('cropY', 0, 0), lin('cropW', W916, W916), lin('cropH', 1, 1)]
// DO NOT simplify this geometry: it is phase 1's zoom test's, for the same reason.
// t0: the centred 9:16 window (218.75..421.25 px, lime | blue). t1: a 64x113.8 px
// 9:16 window (the same pixel aspect) at 339.2..403.2 px, inside the BLUE stripe,
// far right of the union's left edge (218 px). The fixed crop's x then lands at
// ~341 px of the resized union, well past the first frame's clamp (2 px), so a
// stale clamp freezes the window near 218 px and reads lime. A window zoomed in
// at the union's left edge (x ~0) passes under the trap too (MEASURED, PV55 T5).
// If these numbers ever change, re-prove the test FAILS with a filter moved
// between the eval=frame scale and the fixed crop, in a scratch mirror, never
// the tree.
const ZOOM = [lin('cropX', 0.341796875, 0.53), lin('cropY', 0, 0.342), lin('cropW', W916, 0.1), lin('cropH', 1, 0.31605)]
// A thousandth of the real budget, so both cases exceed it on the 640x360
// stripes and render at 1/S, then the decrease-fit upscales them.
const TINY = { cropBudgetPx: 64_000 }

/** The chain must really be the branch the test names, or it proves nothing.
 *  Branch only: what sits between the scale and the crop is for the PIXELS to judge.
 *  At full resolution the fixed crop is what is SHOWN (D1): the 202 x 360 px
 *  window's fit into the 180 x 320 box. At 1/S it is smaller still. */
function assertBranch(item, opts, fixedW, fixedH) {
  const c = chainParts(item, opts).filterParts.find((p) => p.includes('[vid1]'))
  assert.match(c, /eval=frame/, c)
  const m = /crop=(\d+):(\d+):x='[^']*':y='[^']*':exact=1,scale=180:320:force_original_aspect_ratio=decrease,/.exec(c)
  assert.ok(m, c)
  if (fixedW != null) assert.deepEqual([Number(m[1]), Number(m[2])], [fixedW, fixedH], c)
  else assert.ok(Number(m[1]) < 180 && Number(m[2]) < 320, `expected a 1/S crop: ${c}`)
}

test('a keyframed video pan shows the left stripe at t0 and the right stripe after the last key', { timeout: 60_000, ...SKIP }, () => {
  const item = vid(PAN)
  assertBranch(item, {}, 180, 320)
  assert.ok(isRed(probeY(item, 90, 160, 0)), 'centre is red at t0')
  assert.ok(isWhite(probeY(item, 90, 160, 0.6)), 'centre is white after the last key')
})

test('a keyframed video zoom narrows the window inside one stripe (the stale-clamp guard)', { timeout: 60_000, ...SKIP }, () => {
  const item = vid(ZOOM)
  assertBranch(item, {}, 180, 320)
  assert.ok(isLime(probeY(item, 45, 160, 0)), 'left quarter is lime at t0')
  assert.ok(isBlue(probeY(item, 135, 160, 0)), 'right quarter is blue at t0')
  assert.ok(isBlue(probeY(item, 45, 160, 0.6)), 'left quarter is blue once zoomed')
  assert.ok(isBlue(probeY(item, 135, 160, 0.6)), 'right quarter is blue once zoomed')
})

test('past the pixel budget the video pan renders at 1/S and still shows the same stripes', { timeout: 60_000, ...SKIP }, () => {
  const item = vid(PAN)
  assertBranch(item, TINY)
  assert.ok(isRed(probeY(item, 90, 160, 0, TINY)), 'centre is red at t0')
  assert.ok(isWhite(probeY(item, 90, 160, 0.6, TINY)), 'centre is white after the last key')
})

test('past the pixel budget the video zoom renders at 1/S and still narrows into blue (the stale-clamp guard, 1/S branch)', { timeout: 60_000, ...SKIP }, () => {
  // The SAME geometry as the zoom test above, for the same reason (read ZOOM's comment).
  const item = vid(ZOOM)
  assertBranch(item, TINY)
  assert.ok(isLime(probeY(item, 45, 160, 0, TINY)), 'left quarter is lime at t0')
  assert.ok(isBlue(probeY(item, 135, 160, 0, TINY)), 'right quarter is blue at t0')
  assert.ok(isBlue(probeY(item, 45, 160, 0.6, TINY)), 'left quarter is blue once zoomed')
  assert.ok(isBlue(probeY(item, 135, 160, 0.6, TINY)), 'right quarter is blue once zoomed')
})

// The HDR paths: the colour conversion (zscale, and the Vivid LUT for HDR into
// SDR) follows the fixed crop, on a constant frame. Built and run for 1 s in
// the real binary, at full resolution and at 1/S (odd crop sizes, which the
// decrease-fit's force_divisible_by=2 must even out before zscale).
const HLG_SRC = 'testsrc2=size=640x360:rate=25:duration=1,format=yuv420p10le,'
  + 'setparams=color_trc=arib-std-b67:color_primaries=bt2020:colorspace=bt2020nc:range=tv'
const SDR_SRC = 'testsrc2=size=640x360:rate=25:duration=1,format=yuv420p,'
  + 'setparams=color_trc=bt709:color_primaries=bt709:colorspace=bt709:range=tv'
for (const [name, source, colorTransfer, projectColorSpace, canvasFmt] of [
  ['an HLG clip in an SDR project (the Vivid LUT)', HLG_SRC, 'arib-std-b67', 'sdr_bt709', 'yuv420p'],
  ['an SDR clip in an HLG project', SDR_SRC, 'bt709', 'hdr_hlg', 'yuv420p10le'],
]) {
  for (const [branch, opts] of [['full resolution', {}], ['1/S', TINY]]) {
    test(`HDR path, ${name}, ${branch}: the animated crop builds and runs in the real binary`, { timeout: 60_000, ...SKIP }, () => {
      const item = { ...vid(ZOOM), src: 'lavfi-placeholder', colorTransfer }
      const { filterParts } = chainParts(item, { ...opts, projectColorSpace })
      const c = filterParts.find((p) => p.includes('[vid1]'))
      const fixed = c.search(/crop=\d+:\d+:x='/)
      assert.ok(fixed > c.indexOf('eval=frame') && c.indexOf('zscale=') > fixed, `the conversion must follow the fixed crop: ${c}`)
      const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-nostdin',
        '-f', 'lavfi', '-i', `color=black:size=${CW}x${CH}:rate=25:duration=1,format=${canvasFmt}`,
        '-f', 'lavfi', '-i', source,
        '-filter_complex', filterParts.join(';'), '-map', '[iv1]', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(r.status, 0, r.stderr)
    })
  }
}
