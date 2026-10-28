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
