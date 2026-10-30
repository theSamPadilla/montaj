// Overlay filmstrip mode of sample-frame.js: the time list and the CLI's argument checks (no Chromium).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stripFrames } from '../sample-frame.js'

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
