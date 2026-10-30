// Overlay filmstrip mode of sample-frame.js: the time list and the CLI's argument checks (no Chromium).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scene3dStripSource, stripFrames } from '../sample-frame.js'

const SCRIPT = fileURLToPath(new URL('../sample-frame.js', import.meta.url))
const cli = (...args) => spawnSync('node', [SCRIPT, '--mode', 'overlay-strip', ...args], { encoding: 'utf8' })

test('stripFrames: seconds to frames, inside the overlay length', () => {
  assert.deepEqual(stripFrames([0, 1, 2.5], 30, 90), [0, 30, 75])
  assert.deepEqual(stripFrames([2.999, 5], 30, 90), [89, 89])
  assert.deepEqual(stripFrames([-1], 30, 90), [0])
  assert.deepEqual(stripFrames([1], 60, 120), [60])
})

test('overlay-strip refuses a call without its arguments', () => {
  const base = ['--component', '/x/o.jsx', '--out-dir', '/x/out', '--times', '[0,1]', '--duration', '60', '--tile-width', '160']
  const without = (flag) => { const i = base.indexOf(flag); return base.filter((_, k) => k !== i && k !== i + 1) }
  for (const [flag, code] of [['--component', 'missing_argument'], ['--out-dir', 'missing_argument'], ['--times', 'invalid_times'],
    ['--duration', 'missing_argument'], ['--tile-width', 'missing_argument']]) {
    const r = cli(...without(flag))
    assert.equal(r.status, 1, flag)
    assert.match(r.stderr, new RegExp(code), flag)
  }
  assert.match(cli(...base.map((a) => (a === '[0,1]' ? 'nope' : a))).stderr, /invalid_times/)
})

test('a 3D strip is the host stage with the scene in its props, as an export materializes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip3d-'))
  mkdirSync(join(dir, 'models', 'scenes', 'hands'), { recursive: true })
  const scene = JSON.stringify({ model: { id: 'bot' } })
  writeFileSync(join(dir, 'models', 'scenes', 'hands', 'active.json'), scene)
  writeFileSync(join(dir, 'stage.jsx'), 'export default () => null')
  const env = { MONTAJ_SCENE3D_STAGE: join(dir, 'stage.jsx') }
  const got = scene3dStripSource({ scene: 'hands', inPoint: 2 }, dir, { env, log: () => {} })
  assert.equal(got.componentPath, env.MONTAJ_SCENE3D_STAGE)
  assert.deepEqual(got.props, { scene: 'hands', inPoint: 2, sceneFile: join(dir, 'models', 'scenes', 'hands', 'active.json'), sceneJson: scene })
  assert.throws(() => scene3dStripSource({ scene: 'nope' }, dir, { env, log: () => {} }), (e) => e.code === 'scene3d_scene_missing')
  assert.throws(() => scene3dStripSource({ scene: 'hands' }, dir, { env: {}, log: () => {} }), (e) => e.code === 'scene3d_stage_unavailable')
})

test('overlay-strip answers a 3D refusal with its own code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip3d-'))
  const r = spawnSync('node', [SCRIPT, '--mode', 'overlay-strip', '--component', 'engine:scene3d', '--props', '{"scene":"hands"}',
    '--project-dir', dir, '--out-dir', join(dir, 'out'), '--times', '[0]', '--duration', '30', '--tile-width', '160'],
  { encoding: 'utf8', env: { ...process.env, MONTAJ_SCENE3D_STAGE: '' } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /scene3d_stage_unavailable/)
})
