// PV49 T4: the sample cache follows the overlay's import graph.
// Point TMPDIR at a scratch dir: the cache lives under tmpdir().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'

import {
  sampleOverlay, sampleFrame, buildOverlayCacheKey,
  statInputs, mergeInputs, writeInputsManifest, readValidInputsManifest, collectPropFilePaths,
} from '../sample-frame.js'

const md5 = p => createHash('md5').update(readFileSync(p)).digest('hex')

/** Run fn while capturing stderr; returns the text written. */
async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = (c, ...rest) => { text += String(c); return true }
  try { await fn() } finally { process.stderr.write = orig }
  return text
}

/** Rewrite a file and force a strictly later mtime (coarse clocks). */
function edit(path, text) {
  writeFileSync(path, text)
  const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000))
  utimesSync(path, t, t)
}

const helperSrc = c => `export const color = () => '${c}'\n`
const overlaySrc = `import { color } from './helper.js'
export default function O() {
  return <div style={{ position: 'absolute', inset: 0, background: color() }} />
}
`

// ---------------------------------------------------------------------------
// manifest helpers (no browser)
// ---------------------------------------------------------------------------
test('manifest: equal mtimes are valid; changed, missing file and missing manifest are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sci-m-'))
  try {
    const a = join(dir, 'a.js'), b = join(dir, 'b.js'), m = join(dir, 'k.inputs.json')
    writeFileSync(a, 'a'); writeFileSync(b, 'b')
    assert.equal(readValidInputsManifest(m), null, 'missing manifest')
    writeInputsManifest(m, statInputs([a, b]))
    assert.equal(readValidInputsManifest(m).length, 2, 'unchanged is valid')
    edit(b, 'bb')
    assert.equal(readValidInputsManifest(m), null, 'changed mtime')
    writeInputsManifest(m, statInputs([a, b]))
    assert.ok(readValidInputsManifest(m))
    rmSync(a)
    assert.equal(readValidInputsManifest(m), null, 'missing file')
    writeFileSync(m, 'not json')
    assert.equal(readValidInputsManifest(m), null, 'corrupt manifest')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mergeInputs: union; a path seen with two mtimes can never validate', () => {
  assert.deepEqual(mergeInputs([[['/a', 1], ['/b', 2]], [['/b', 2], ['/c', 3]]]),
    [['/a', 1], ['/b', 2], ['/c', 3]])
  assert.deepEqual(mergeInputs([[['/a', 1]], [['/a', 2]]]), [['/a', -1]])
  assert.deepEqual(mergeInputs([undefined, []]), [])
})

test('collectPropFilePaths: only existing absolute files, nested', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sci-p-'))
  try {
    const f = join(dir, 'x.png'); writeFileSync(f, 'x')
    const got = [...collectPropFilePaths({ a: f, b: [{ c: f }, join(dir, 'nope.png')], d: dir, e: 'rel/x.png', n: 3 })]
    assert.deepEqual(got, [f])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('manifest hit-path cost, 10 inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sci-c-'))
  try {
    const files = Array.from({ length: 10 }, (_, i) => { const p = join(dir, `f${i}.js`); writeFileSync(p, 'x'); return p })
    const m = join(dir, 'k.inputs.json')
    writeInputsManifest(m, statInputs(files))
    readValidInputsManifest(m)
    const N = 200, t0 = process.hrtime.bigint()
    for (let i = 0; i < N; i++) readValidInputsManifest(m)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N
    console.log(`# manifest validate, 10 inputs: ${ms.toFixed(3)} ms per lookup`)
    assert.ok(ms < 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// integration: real Chromium
// ---------------------------------------------------------------------------
const base = { frame: 0, fps: 30, width: 200, height: 200 }

test('overlay: imported helper edit busts the cache; props asset edit busts it',
  { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sci-o-'))
  try {
    const helper = join(dir, 'helper.js'), comp = join(dir, 'overlay.jsx'), asset = join(dir, 'asset.txt')
    writeFileSync(helper, helperSrc('#ff0000')); writeFileSync(comp, overlaySrc); writeFileSync(asset, 'v1')
    const props = { file: asset }
    const run = async n => {
      const out = join(dir, `out${n}.png`)
      const log = await captureStderr(() => sampleOverlay({ componentPath: comp, props, ...base, outPath: out }))
      return { out, hit: /cache hit/.test(log) }
    }

    const r1 = await run(1)
    assert.equal(r1.hit, false, 'first is a miss')
    const r2 = await run(2)
    assert.equal(r2.hit, true, 'second is a hit')
    assert.equal(md5(r2.out), md5(r1.out))

    // e0's repro: helper red -> blue
    edit(helper, helperSrc('#0000ff'))
    const r3 = await run(3)
    assert.equal(r3.hit, false, 'helper edit is a miss')
    assert.notEqual(md5(r3.out), md5(r1.out), 'pixels changed')
    assert.equal((await run(4)).hit, true, 'and the new render is cached')

    // a file referenced by absolute path in props
    edit(asset, 'v2')
    assert.equal((await run(5)).hit, false, 'props asset edit is a miss')
    assert.equal((await run(6)).hit, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('overlay: a cached PNG with no manifest is a miss', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sci-n-'))
  try {
    const helper = join(dir, 'helper.js'), comp = join(dir, 'overlay.jsx')
    writeFileSync(helper, helperSrc('#00ff00')); writeFileSync(comp, overlaySrc)
    const opts = { componentPath: comp, ...base, durationFrames: 60 }
    const key = buildOverlayCacheKey(comp, {}, 0, 200, 200, [], false, 60, process.env.MONTAJ_FONTS_DIR ?? '')
    const cacheDir = join(tmpdir(), 'montaj-sample-cache')
    mkdirSync(cacheDir, { recursive: true })
    const bogus = Buffer.from('not a real png, a pre-PV49 entry')
    writeFileSync(join(cacheDir, `${key}.png`), bogus)
    const out = join(dir, 'o1.png')
    const log = await captureStderr(() => sampleOverlay({ ...opts, outPath: out }))
    assert.ok(!/cache hit/.test(log), 'PNG without manifest must re-render')
    assert.notDeepEqual(readFileSync(out), bogus, 'the bogus PNG was not served')
    assert.ok(existsSync(join(cacheDir, `${key}.inputs.json`)), 'the manifest is written')
    const log2 = await captureStderr(() => sampleOverlay({ ...opts, outPath: join(dir, 'o2.png') }))
    assert.ok(/cache hit/.test(log2), 'and the next sample hits')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('frame: an imported helper edit changes sampleFrame pixels', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sci-f-'))
  try {
    const clip = join(dir, 'clip.mp4')
    const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=30:duration=3', '-pix_fmt', 'yuv420p', clip],
      { encoding: 'utf8', timeout: 15_000 })
    assert.equal(r.status, 0, `ffmpeg (${FFMPEG}) could not make the synthetic source: ${r.error || r.stderr}`)
    const helper = join(dir, 'helper.js'), comp = join(dir, 'overlay.jsx')
    writeFileSync(helper, helperSrc('#ff0000')); writeFileSync(comp, overlaySrc)
    const project = {
      version: '0.2', status: 'final', name: 'sci',
      settings: { resolution: [200, 200], fps: 30, colorSpace: 'sdr_bt709' },
      tracks: [
        [{ id: 'c', type: 'video', src: clip, start: 0, end: 3, inPoint: 0 }],
        [{ id: 'o', type: 'overlay', src: comp, start: 0, end: 2, offsetX: 0, offsetY: 0, scale: 1 }],
      ],
      audio: { tracks: [] },
    }
    const run = async n => {
      const out = join(dir, `f${n}.png`)
      const log = await captureStderr(() => sampleFrame({ projectJson: project, atSeconds: 0.5, outPath: out }))
      return { out, hit: /cache hit for frame/.test(log) }
    }
    const f1 = await run(1)
    assert.equal(f1.hit, false)
    const f2 = await run(2)
    assert.equal(f2.hit, true, 'untouched re-sample hits')
    edit(helper, helperSrc('#0000ff'))
    const f3 = await run(3)
    assert.equal(f3.hit, false, 'helper edit misses at frame level')
    assert.notEqual(md5(f3.out), md5(f1.out), 'frame pixels changed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
