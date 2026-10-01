// render/test/overlay-prop-images.integration.test.mjs
//
// Images an overlay is given as a LIST, a list of lists and an object, drawn by
// the sample (sampleOverlay) and by the export (render.js), pixel-checked.
//
// Each image is named the way the editor preview loads it: by absolute path,
// and by the served URL a host's fileUrl makes of one (serve's
// `/api/files?path=<absolute path>`, which the preview passes through as
// already served). The images live OUTSIDE the workspace, so the read boundary
// has to name each one from props too, or the page is refused it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { sampleOverlay } from '../sample-frame.js'

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 128
// One colour per slot: the 2x2 grid of the list, the list of lists, the object.
const SLOTS = {
  first:  { hex: 'e02020', at: [32, 32] },   // covers[0]
  second: { hex: '20c040', at: [96, 32] },   // covers[1]
  reel:   { hex: '2040e0', at: [32, 96] },   // reel[0][0].src
  card:   { hex: 'e0c020', at: [96, 96] },   // card.image
}

let base, ws, elsewhere, overlay
const images = {}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-prop-images-')))
  ws = join(base, 'ws')
  elsewhere = join(base, 'My Covers')          // outside the workspace, with a space
  mkdirSync(join(ws, 'proj', 'overlays'), { recursive: true })
  mkdirSync(elsewhere)
  process.env.MONTAJ_WORKSPACE_DIR = ws
  for (const [slot, { hex }] of Object.entries(SLOTS)) {
    const p = join(elsewhere, `${slot} #1.png`)
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=48x48`,
      '-frames:v', '1', '-pix_fmt', 'rgb24', p], { encoding: 'utf8' })
    assert.equal(r.status, 0, `ffmpeg (${FFMPEG}) could not make ${slot}: ${r.stderr}`)
    images[slot] = p
  }
  overlay = join(ws, 'proj', 'overlays', 'covers.jsx')
  writeFileSync(overlay, `const cell = (left, top) => ({ position: 'absolute', left, top, width: '50%', height: '50%' })
export default function Covers({ covers, reel, card }) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {covers.map((c, i) => <img key={i} src={c} style={cell(i * 50 + '%', 0)} />)}
      {reel.map((row, i) => row.map((f, j) => <img key={i + '-' + j} src={f.src} style={cell(0, '50%')} />))}
      <img src={card.image} style={cell('50%', '50%')} />
    </div>
  )
}
`)
})

after(() => { if (base) rmSync(base, { recursive: true, force: true }) })

const served = p => `/api/files?path=${encodeURIComponent(p)}`
function propsFor(spell) {
  return {
    title: 'Top picks',
    covers: [spell(images.first), spell(images.second)],
    reel: [[{ src: spell(images.reel), label: '0:02' }]],
    card: { image: spell(images.card) },
  }
}

/** [r, g, b] at (x, y) of an image or a video's first frame. */
function pixel(file, [x, y]) {
  const r = spawnSync(FFMPEG, ['-loglevel', 'error', '-i', file, '-frames:v', '1',
    '-vf', `crop=4:4:${x - 2}:${y - 2},scale=1:1:flags=area,format=rgb24`, '-f', 'rawvideo', 'pipe:1'],
    { encoding: 'buffer' })
  assert.equal(r.status, 0, `ffmpeg could not read ${file}: ${r.stderr}`)
  return [...r.stdout.subarray(0, 3)]
}

function assertEverySlotDrawn(file, tolerance, label) {
  for (const [slot, { hex, at }] of Object.entries(SLOTS)) {
    const want = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))
    const got = pixel(file, at)
    assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= tolerance),
      `${label}: ${slot} at ${at} is ${got}, not its image ${want} (blank card)`)
  }
}

for (const [label, spell] of [['absolute paths', p => p], ['served /api/files URLs', served]]) {
  test(`sampleOverlay draws every image given as ${label} in a list, a list of lists and an object`,
    { timeout: 120_000 }, async () => {
    const out = join(base, `sample-${label.replace(/\W+/g, '-')}.png`)
    await sampleOverlay({
      componentPath: overlay, props: propsFor(spell),
      frame: 0, fps: 30, width: SIZE, height: SIZE, outPath: out, projectDir: join(ws, 'proj'),
    })
    assertEverySlotDrawn(out, 2, label)
  })
}

test('render.js draws every image given as served /api/files URLs in a list, a list of lists and an object',
  { timeout: 300_000 }, () => {
  const proj = join(ws, 'video')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    version: '0.2', id: 'prop-images', status: 'final', projectType: 'editing',
    settings: { resolution: [SIZE, SIZE], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [{ id: 'trk-0', items: [] }, { id: 'trk-1', items: [{
      id: 'covers', type: 'overlay', src: overlay, props: propsFor(served), start: 0, end: 0.2,
    }] }],
    assets: [], audio: {},
  }))
  const out = join(proj, 'out.mp4')
  const r = spawnSync(process.execPath, [join(RENDER, 'render.js'), join(proj, 'project.json'), '--out', out],
    { cwd: base, env: process.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr.slice(-800))
  // Through yuv420p and back: a few levels either way.
  assertEverySlotDrawn(out, 10, 'render.js')
  assert.doesNotMatch(r.stderr, /blocked a read/)
})
