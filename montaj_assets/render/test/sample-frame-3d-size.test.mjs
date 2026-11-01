// render/test/sample-frame-3d-size.test.mjs (§651)
//
// A sampled frame inlines each 3D item's scene whole (props.sceneJson). Sampling used to materialize every 3D item of
// the project and then copy the project through JSON.stringify: a real project of 24 scenes of 25 to 33 MB carried
// 620 MB, past V8's string limit, and every sample of it failed with a bare "Invalid string length". Now only the 3D on
// screen at the sampled time is read, the copy is a structuredClone, and a sample that still passes the limit fails
// as sample_too_large, saying how much 3D it carried and which item was the largest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCENE3D_SRC, SCENE3D_STAGE_ENV, materializeScene3d } from '../scene3d.js'
import { sampleFrame, onScreenAt, tooLargeError, isStringLengthError, MAX_STRING_LENGTH } from '../sample-frame.js'

const ITEMS = 26
// One scene item a second, each on its own scene, as the real project lays out its shots.
const shots = (n = ITEMS, gap = 0) => Array.from({ length: n }, (_, i) => ({
  id: `shot-${i}`, type: 'overlay', src: SCENE3D_SRC, start: i * (1 + gap), end: i * (1 + gap) + 1, props: { scene: `s${i}` },
}))

/** A materialize environment that serves every scene as `bytes` of JSON and records which were read. */
function served(bytes) {
  const reads = []
  const text = `{"model":{"name":"m"},"pad":"${'x'.repeat(Math.max(0, bytes - 30))}"}`
  return {
    reads,
    text,
    opts: { env: { [SCENE3D_STAGE_ENV]: '/stage.jsx' }, exists: () => true, read: (f) => { reads.push(f.split('/').at(-2)); return text }, log: () => {} },
  }
}

test('a frame reads only the 3D on screen at its time, not every 3D item of the project', () => {
  const s = served(1000)
  const project = { tracks: [shots()] }
  assert.equal(materializeScene3d(project, '/p', { ...s.opts, only: onScreenAt(12.5) }), 1)
  assert.deepEqual(s.reads, ['s12'])
  const items = project.tracks[0]
  assert.equal(items[12].src, '/stage.jsx')
  assert.equal(items[12].props.sceneJson, s.text)
  assert.ok(items.every((it, i) => i === 12 || (it.src === SCENE3D_SRC && it.props.sceneJson === undefined)),
    'the 3D off screen stays unread')
})

test('a time on a cut reads both 3D items that meet there; the resolver picks the later', () => {
  const s = served(1000)
  materializeScene3d({ tracks: [shots()] }, '/p', { ...s.opts, only: onScreenAt(13) })
  assert.deepEqual(s.reads, ['s12', 's13'])
})

test('an item whose times are not numbers is read, never left as engine:scene3d', () => {
  const s = served(1000)
  materializeScene3d({ tracks: [[{ type: 'overlay', src: SCENE3D_SRC, start: 'x', end: undefined, props: {} }]] }, '/p', { ...s.opts, only: onScreenAt(5) })
  assert.equal(s.reads.length, 1)
})

test('the text a frame inlines is its on-screen 3D only; every item at real scene sizes is past V8\'s string limit', () => {
  // Measured: the real project's scenes are 25 to 33 MB each (24 items, 620 MB). One 1 MB scene stands in here.
  const per = 1_000_000
  const all = served(per)
  const allProject = { tracks: [shots()] }
  materializeScene3d(allProject, '/p', all.opts)
  const one = served(per)
  const oneProject = { tracks: [shots()] }
  materializeScene3d(oneProject, '/p', { ...one.opts, only: onScreenAt(3.5) })
  const inlined = (p) => p.tracks[0].reduce((n, it) => n + (it.props.sceneJson?.length ?? 0), 0)
  assert.equal(inlined(allProject), ITEMS * all.text.length)
  assert.equal(inlined(oneProject), one.text.length)
  // Extrapolated to a real 24 MB scene: every item is past the limit (the old failure), one or two are far below it.
  const real = 24_033_568
  assert.ok(ITEMS * real > MAX_STRING_LENGTH, `${ITEMS} x ${real} = ${ITEMS * real} must pass ${MAX_STRING_LENGTH}`)
  assert.ok(2 * real < MAX_STRING_LENGTH / 10)
})

test('sampleFrame never reads a 3D that is not on screen (a broken one off screen used to fail every sample)', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-651-'))
  const before = process.env[SCENE3D_STAGE_ENV]
  try {
    const stage = join(dir, 'stage.jsx')
    writeFileSync(stage, 'export default () => null')
    process.env[SCENE3D_STAGE_ENV] = stage
    const project = join(dir, 'project')
    for (let i = 0; i < ITEMS; i++) {
      mkdirSync(join(project, 'models', 'scenes', `s${i}`), { recursive: true })
      // Not JSON: reading any of these fails the sample (scene3d_invalid).
      writeFileSync(join(project, 'models', 'scenes', `s${i}`, 'active.json'), '{ not json')
    }
    const path = join(project, 'project.json')
    writeFileSync(path, JSON.stringify({
      version: '0.2', id: 'p651', status: 'final', projectType: 'editing',
      settings: { resolution: [180, 320], fps: 10, colorSpace: 'sdr_bt709' },
      tracks: [shots(ITEMS, 1)], audio: { tracks: [] },
    }))
    const outPath = join(dir, 'gap.png')
    // 1.5 s is the gap between the first two shots: nothing on screen, nothing read.
    const got = await sampleFrame({ projectJson: path, atSeconds: 1.5, outPath })
    assert.equal(got.pngPath, outPath)
    assert.ok(existsSync(outPath))
  } finally {
    if (before === undefined) delete process.env[SCENE3D_STAGE_ENV]
    else process.env[SCENE3D_STAGE_ENV] = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a sample past V8\'s string limit fails as sample_too_large, naming the 3D it carried', async () => {
  const big = 'x'.repeat(3_000_000)
  // `settings` throws V8's error where the sample first reads it (not enumerable, so a spread or a stringify skips it).
  const project = {
    tracks: [[
      { id: 'wf-s3', type: 'overlay', src: '/stage.jsx', start: 0, end: 2, props: { sceneJson: big } },
      { id: 'wf-s4', type: 'overlay', src: '/stage.jsx', start: 0, end: 2, props: { sceneJson: big.slice(1_000_000) } },
    ]],
  }
  Object.defineProperty(project, 'settings', { enumerable: false, get() { throw new RangeError('Invalid string length') } })
  await assert.rejects(
    sampleFrame({ projectJson: project, atSeconds: 1, outPath: join(tmpdir(), 'montaj-651-never.png') }),
    (err) => {
      assert.equal(err.sampleError, 'sample_too_large')
      assert.match(err.message, /^The frame at 1s could not be sampled: it carried 5\.0 MB of 3D in 2 3D items \(the largest, "wf-s3", 3\.0 MB\), past the 537 MB/)
      assert.ok(isStringLengthError(err.cause), 'V8\'s own error is kept as the cause')
      return true
    })
})

test('V8\'s own string-limit error is recognised; others are not', () => {
  let real
  try { 'x'.repeat(MAX_STRING_LENGTH + 1) } catch (e) { real = e }
  assert.ok(isStringLengthError(real), String(real))
  assert.equal(isStringLengthError(new RangeError('Maximum call stack size exceeded')), false)
  assert.equal(isStringLengthError(new Error('Invalid string length')), false)
  const none = tooLargeError(real, null, 2)
  assert.equal(none.sampleError, 'sample_too_large')
  assert.match(none.message, /^The frame at 2s could not be sampled: its project data was too large, past the 537 MB/)
})
