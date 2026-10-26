// A sampled frame skips decoding footage that a full-canvas overlay covers
// completely, whether or not the overlay is flagged `opaque`. The overlay's
// rendered PNG is measured (alpha 255 everywhere), so the frame is identical.
//
// Each sample runs in a child node with a fresh TMPDIR: the sample cache dir is
// fixed at import, and a cache hit would answer for the run it should compare.
// MONTAJ_SAMPLE_NO_COVER_SKIP=1 is the seam that turns the new skip off.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
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

/** Sample `project` at `at` in a child with a fresh TMPDIR; returns { status, stderr, png }. */
function sample(dir, project, at, { skipOff = false, tag }) {
  const pj = join(dir, `project-${tag}.json`)
  writeFileSync(pj, JSON.stringify(project))
  const out = join(dir, `out-${tag}.png`)
  const tmp = mkdtempSync(join(dir, `tmp-${tag}-`))
  const env = { ...process.env, TMPDIR: tmp }
  delete env.MONTAJ_SAMPLE_NO_COVER_SKIP
  if (skipOff) env.MONTAJ_SAMPLE_NO_COVER_SKIP = '1'
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', RUNNER, pj, out, String(at)],
    { encoding: 'utf8', env, timeout: 100_000 })
  return { status: r.status, stderr: `${r.stderr}`, png: out }
}

function rgba(png) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'format=rgba', '-f', 'rawvideo', '-'],
    { maxBuffer: 256 * 1024 * 1024 })
  assert.equal(r.status, 0, `${r.stderr}`)
  return r.stdout
}

function px(png, x, y) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])
  return [r.stdout[0], r.stdout[1], r.stdout[2]]
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cover-skip-'))
  const clip = join(dir, 'clip.mp4')
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x64:rate=30:duration=3',
    '-pix_fmt', 'yuv420p', clip])
  assert.equal(r.status, 0, `${r.stderr}`)
  // Opaque everywhere, with content; NOT flagged `opaque`.
  const full = join(dir, 'full.jsx')
  writeFileSync(full, `export default function Full() {
  return <div style={{ position: 'absolute', inset: 0, background: '#2244cc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ fontSize: 60, color: 'white' }}>COVER</div></div>
}\n`)
  // A transparent window in the middle (like a matte).
  const windowed = join(dir, 'window.jsx')
  writeFileSync(windowed, `export default function Win() {
  return <div style={{ position: 'absolute', inset: 0 }}>
    <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '30%', background: '#2244cc' }} />
    <div style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: '30%', background: '#2244cc' }} />
  </div>
}\n`)
  return { dir, clip, full, windowed }
}

const clipItem = (clip) => ({ id: 'c', type: 'video', src: clip, start: 0, end: 3, inPoint: 0, sourceWidth: 64, sourceHeight: 64 })
const ovItem = (src, extra = {}) => ({ id: 'o', type: 'overlay', src, start: 0, end: 3, offsetX: 0, offsetY: 0, scale: 1, ...extra })
const projectOf = (...tracks) => ({
  version: '0.2', status: 'final', name: 'cover-skip',
  settings: { resolution: [270, 480], fps: 30, colorSpace: 'sdr_bt709' },
  tracks, audio: { tracks: [] },
})

test('cover skip: the frame matches with the skip on and off (within yuv rounding)', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir, clip, full } = setup()
  try {
    const p = projectOf([clipItem(clip)], [ovItem(full)])
    const on = sample(dir, p, 1, { tag: 'on' })
    const off = sample(dir, p, 1, { tag: 'off', skipOff: true })
    assert.equal(on.status, 0, on.stderr)
    assert.equal(off.status, 0, off.stderr)
    // Not bit-identical: with footage under it the compositor round-trips the whole
    // canvas through yuv420 (flat #2244cc comes out 32,68,203); the skipped frame
    // never takes that step and is the exact 34,68,204. Same frame to the eye.
    const a = rgba(on.png), c = rgba(off.png)
    assert.equal(a.length, c.length)
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - c[i])
    assert.ok(sum / a.length < 2, `mean abs channel difference ${sum / a.length}`)
    const [r0, g0, b0] = px(off.png, 5, 240), [r1, g1, b1] = px(on.png, 5, 240)
    assert.ok(Math.max(Math.abs(r0 - r1), Math.abs(g0 - g1), Math.abs(b0 - b1)) <= 3, 'flat region')
    const [r, g, b] = px(on.png, 5, 240)
    assert.ok(Math.abs(r - 0x22) < 6 && Math.abs(g - 0x44) < 6 && Math.abs(b - 0xcc) < 6, `overlay colour, got ${r},${g},${b}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cover skip: footage under a covering overlay is not decoded', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir, clip, full } = setup()
  try {
    const p = projectOf([clipItem(clip)], [ovItem(full)])
    rmSync(clip)
    const on = sample(dir, p, 1, { tag: 'on' })
    assert.equal(on.status, 0, on.stderr)
    assert.ok(existsSync(on.png))
    assert.match(on.stderr, /measured/i)
    const off = sample(dir, p, 1, { tag: 'off', skipOff: true })
    assert.notEqual(off.status, 0, 'with the skip off the missing clip must still fail')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cover skip: an overlay with a transparent window does not skip', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir, clip, windowed } = setup()
  try {
    const p = projectOf([clipItem(clip)], [ovItem(windowed)])
    const on = sample(dir, p, 1, { tag: 'on' })
    const off = sample(dir, p, 1, { tag: 'off', skipOff: true })
    assert.equal(on.status, 0, on.stderr)
    const [r, , b] = px(on.png, 135, 240)
    assert.ok(r > 150 && b < 100, `clip shows through the window, got r=${r} b=${b}`)
    assert.ok(Buffer.compare(rgba(on.png), rgba(off.png)) === 0, 'nothing skipped, so the two are the same bytes')
    rmSync(clip)
    assert.notEqual(sample(dir, p, 1, { tag: 'gone' }).status, 0, 'a missing clip must fail: it is decoded')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const [name, extra] of [['scaled', { scale: 0.5 }], ['at opacity below 1', { opacity: 0.5 }]]) {
  test(`cover skip: an overlay ${name} does not skip`, { skip: !hasFfmpeg, timeout: 200_000 }, () => {
    const { dir, clip, full } = setup()
    try {
      const p = projectOf([clipItem(clip)], [ovItem(full, extra)])
      rmSync(clip)
      assert.notEqual(sample(dir, p, 1, { tag: 'a' }).status, 0, 'the clip is still decoded')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('cover skip: a covering overlay BELOW the clip does not skip the clip', { skip: !hasFfmpeg, timeout: 200_000 }, () => {
  const { dir, clip, full } = setup()
  try {
    // A track holding a video lays out below the rest; the overlay shares such a
    // track (with a clip that is not on screen), the sampled clip is on a track above.
    const later = { ...clipItem(clip), id: 'later', start: 5, end: 6 }
    const p = projectOf([ovItem(full), later], [clipItem(clip)])
    rmSync(clip)
    assert.notEqual(sample(dir, p, 1, { tag: 'a' }).status, 0, 'the clip is above the overlay, so it is decoded')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
