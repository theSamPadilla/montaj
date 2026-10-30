// §616: the still frame shows a clip's sampled opacity, its mask and its blend mode,
// as the export does. Each sample runs in a child node with a fresh TMPDIR (the sample
// cache dir is fixed at import, and a cache hit would answer for the run it should test).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'

const here = dirname(fileURLToPath(import.meta.url))
const SAMPLER = join(here, '..', 'sample-frame.js')
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0

const RUNNER = `
import { sampleFrame } from ${JSON.stringify(SAMPLER)}
const [projectJson, out, at] = process.argv.slice(1)
await sampleFrame({ projectJson, atSeconds: Number(at), outPath: out })
`

function sample(dir, project, at, tag) {
  const pj = join(dir, `project-${tag}.json`)
  writeFileSync(pj, JSON.stringify(project))
  const out = join(dir, `out-${tag}.png`)
  const tmp = mkdtempSync(join(dir, `tmp-${tag}-`))
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', RUNNER, pj, out, String(at)],
    { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp }, timeout: 100_000 })
  assert.equal(r.status, 0, `${r.stderr}`)
  // The work dir (extracted frames, mask files) is removed on the way out.
  assert.deepEqual(readdirSync(tmp).filter(n => n.startsWith('montaj-sample-frame-')), [])
  return out
}

function px(png, x, y) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])
  return [r.stdout[0], r.stdout[1], r.stdout[2]]
}

const near = (got, want, tol, msg) => {
  assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= tol), `${msg}: got ${got}, want ${want} +-${tol}`)
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sample-616-'))
  const solid = (name, color) => {
    const f = join(dir, `${name}.png`)
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=270x480`,
      '-frames:v', '1', '-pix_fmt', 'rgb24', f])
    assert.equal(r.status, 0, `${r.stderr}`)
    return f
  }
  return { dir, red: solid('red', '0xc80000'), blue: solid('blue', '0x0000ff'), grey: solid('grey', '0x646464') }
}

const img = (id, src, extra = {}) => ({ id, type: 'image', src, start: 0, end: 2, ...extra })
const projectOf = (...tracks) => ({
  version: '0.2', status: 'final', name: 'sample-616',
  settings: { resolution: [270, 480], fps: 30, colorSpace: 'sdr_bt709' },
  tracks, audio: { tracks: [] },
})

test('a clip with an opacity track is sampled at its opacity at that instant', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir, red } = setup()
  try {
    const fade = [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 2, value: 1 }] }]
    const out = sample(dir, projectOf([img('a', red, { keyframes: fade })]), 1, 'fade')
    near(px(out, 135, 240), [100, 0, 0], 4, 'half faded red over black')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a masked clip is cut by its mask, and the layer after it still reads its own input', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir, red, blue } = setup()
  try {
    const mask = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.9, h: 0.9 }
    const small = img('b', blue, { scale: 0.2 })
    const out = sample(dir, projectOf([img('a', red, { mask })], [small]), 1, 'mask')
    near(px(out, 135, 60), [200, 0, 0], 4, 'inside the ellipse')
    near(px(out, 5, 5), [0, 0, 0], 4, 'outside the ellipse')
    near(px(out, 135, 240), [0, 0, 255], 6, 'the layer after the mask')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a clip with a blend mode blends over what is below it', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir, red, grey } = setup()
  try {
    const out = sample(dir, projectOf([img('a', grey)], [img('b', red, { blendMode: 'screen' })]), 1, 'blend')
    // screen: 1 - (1-a)(1-b), grey 100 over red 200 -> R 100+200-100*200/255 = 222, G/B 100
    near(px(out, 135, 240), [222, 100, 100], 8, 'screen of red over grey')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// A clip's blur shows in the still, on the fitted picture, with opaque edges.
test('a blurred clip is blurred in the still, and its edges stay opaque', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir } = setup()
  try {
    // Left half red, right half blue, full frame, blur 40 (sigma 10 at 270 wide).
    const split = join(dir, 'split.png')
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc80000:size=270x480',
      '-f', 'lavfi', '-i', 'color=c=0x0000ff:size=135x480', '-filter_complex', '[0][1]overlay=x=135',
      '-frames:v', '1', '-pix_fmt', 'rgb24', split])
    assert.equal(r.status, 0, `${r.stderr}`)
    const sharp = sample(dir, projectOf([img('a', split)]), 1, 'sharp')
    near(px(sharp, 133, 240), [200, 0, 0], 4, 'unblurred, just left of the seam')
    const out = sample(dir, projectOf([img('a', split, { blur: 40 })]), 1, 'blur')
    // At the seam the two colours mix; two pixels left of it, mostly red but not pure.
    near(px(out, 135, 240), [100, 0, 128], 14, 'at the seam')
    const left = px(out, 133, 240)
    assert.ok(left[0] < 190 && left[2] > 20, `blurred just left of the seam: ${left}`)
    // The frame's edges read the edge pixel again: pure red, not darkened.
    near(px(out, 0, 0), [200, 0, 0], 4, 'top-left corner')
    near(px(out, 0, 479), [200, 0, 0], 4, 'bottom-left corner')
    near(px(out, 269, 0), [0, 0, 255], 4, 'top-right corner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a blurred video clip filling the frame keeps opaque edges in the still', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir } = setup()
  try {
    const clip = join(dir, 'red.mp4')
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc80000:size=160x90:r=30:d=2',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '0', clip])
    assert.equal(r.status, 0, `${r.stderr}`)
    const vid = { id: 'v', type: 'video', src: clip, start: 0, end: 2, inPoint: 0, scale: 3.4, blur: 60 }
    const out = sample(dir, projectOf([vid]), 1, 'video')
    for (const [x, y] of [[0, 0], [269, 0], [0, 479], [269, 479], [135, 0], [135, 240]]) {
      near(px(out, x, y), [200, 0, 0], 8, `(${x},${y})`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// A linear blur shows in the still too: a vertical seam blurred along y stays
// sharp, along x it mixes, at 30 degrees it mixes less than along x.
test('a linear blur is drawn along its angle in the still', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir } = setup()
  try {
    const split = join(dir, 'split.png')
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc80000:size=270x480',
      '-f', 'lavfi', '-i', 'color=c=0x0000ff:size=135x480', '-filter_complex', '[0][1]overlay=x=135',
      '-frames:v', '1', '-pix_fmt', 'rgb24', split])
    assert.equal(r.status, 0, `${r.stderr}`)
    const at = (blurAngle, name) => sample(dir, projectOf([img('a', split, { blur: 40, blurType: 'linear', blurAngle })]), 1, name)
    const down = at(90, 'down')
    near(px(down, 133, 240), [200, 0, 0], 4, 'along y: just left of the seam stays red')
    near(px(down, 137, 240), [0, 0, 255], 4, 'along y: just right of the seam stays blue')
    const across = at(0, 'across')
    const slant = at(30, 'slant')
    const a = px(across, 133, 240)
    const s = px(slant, 133, 240)
    assert.ok(a[0] < 190 && a[2] > 20, `along x: mixed at the seam: ${a}`)
    assert.ok(s[2] > 10 && s[2] < a[2], `at 30 degrees: mixed, less than along x: ${s} vs ${a}`)
    near(px(slant, 0, 0), [200, 0, 0], 6, 'top-left corner')
    near(px(slant, 269, 479), [0, 0, 255], 6, 'bottom-right corner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Spin and zoom show in the still: a vertical seam through the centre. A spin
// about the centre mixes it far from the centre (the turn crosses the seam)
// and leaves it sharp near the centre; a zoom about a point left of the seam
// streaks across it on the centre's row, and a zoom about a point on the seam
// streaks along it, leaving it sharp.
test('spin and zoom blurs are drawn about their centre in the still', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir } = setup()
  try {
    const split = join(dir, 'split.png')
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc80000:size=270x480',
      '-f', 'lavfi', '-i', 'color=c=0x0000ff:size=135x480', '-filter_complex', '[0][1]overlay=x=135',
      '-frames:v', '1', '-pix_fmt', 'rgb24', split])
    assert.equal(r.status, 0, `${r.stderr}`)
    const at = (extra, name) => sample(dir, projectOf([img('a', split, { blur: 40, ...extra })]), 1, name)
    const spin = at({ blurType: 'spin', blurX: 0.5, blurY: 0.5 }, 'spin')
    near(px(spin, 127, 240), [200, 0, 0], 6, 'spin: left of the seam at the centre stays red')
    const far = px(spin, 132, 20)
    assert.ok(far[0] < 190 && far[2] > 20, `spin: mixed at the seam far from the centre: ${far}`)
    near(px(spin, 0, 0), [200, 0, 0], 8, 'spin: top-left corner')
    const across = at({ blurType: 'zoom', blurX: 0.25, blurY: 0.5 }, 'zoom-across')
    const a = px(across, 132, 240)
    assert.ok(a[0] < 190 && a[2] > 20, `zoom about a point left of the seam: mixed across it: ${a}`)
    const along = at({ blurType: 'zoom', blurX: 0.5, blurY: 0.5 }, 'zoom-along')
    near(px(along, 131, 60), [200, 0, 0], 8, 'zoom about a point on the seam: streaks along it, left stays red')
    near(px(along, 139, 60), [0, 0, 255], 8, 'zoom about a point on the seam: right stays blue')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
